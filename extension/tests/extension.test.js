import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(testDir, "..");

async function source(relativePath) {
  return fs.readFile(path.join(extensionDir, relativePath), "utf8");
}

function storageArea(initial, areaName, listeners) {
  const values = { ...initial };
  return {
    async get(keys) {
      if (typeof keys === "string") return { [keys]: values[keys] };
      const names = Array.isArray(keys) ? keys : Object.keys(keys || {});
      return Object.fromEntries(names.map((key) => [key, values[key]]));
    },
    async set(updates) {
      const changes = {};
      for (const [key, value] of Object.entries(updates)) {
        changes[key] = { oldValue: values[key], newValue: value };
        values[key] = value;
      }
      listeners.forEach((listener) => listener(changes, areaName));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
}

async function createWindow({
  html,
  cache = [],
  pending = [],
  runtimeHandler,
  fetchHandler,
  url = "https://mail.google.com/mail/u/0/#sent",
}) {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url,
  });
  const { window } = dom;
  const listeners = [];
  const nativeSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (callback, delay = 0, ...args) =>
    nativeSetTimeout(callback, Math.min(delay, 10), ...args);
  window.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: "2.0.24" }),
      sendMessage(message, callback) {
        callback(runtimeHandler ? runtimeHandler(message) : { ok: false, error: "not connected" });
      },
    },
    storage: {
      sync: storageArea(
        {
          baseUrl: "https://backend.example.test",
          secret: "test-secret",
          trackDefault: true,
        },
        "sync",
        listeners
      ),
      local: storageArea(
        { mtStatusCacheV2: cache, mtPendingTracksV2: pending },
        "local",
        listeners
      ),
      onChanged: { addListener(listener) { listeners.push(listener); } },
    },
  };
  window.fetch = fetchHandler;
  window.console.warn = () => {};
  window.eval(await source("src/mt-core.js"));
  await window.MT.ready;
  return { dom, window };
}

function tick(window, milliseconds = 30) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

test("Send is blocked until one pixel is inserted and Gmail is synchronized", async () => {
  const requests = [];
  const { dom, window } = await createWindow({
    html: `<!doctype html><body>
      <div role="dialog" id="compose">
        <input name="to" value="recipient@example.com">
        <input name="subjectbox" value="Core tracking">
        <div aria-label="Message Body" role="textbox" contenteditable="true">
          Hello <a href="https://example.com">unchanged link</a>
        </div>
        <div><div role="button" data-tooltip="Send">Send</div></div>
      </div>
    </body>`,
    async fetchHandler(url, options = {}) {
      requests.push({ url: String(url), options });
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  window.eval(await source("src/send-gate.js"));
  const compose = window.document.querySelector("#compose");
  const body = compose.querySelector('[aria-label="Message Body"]');
  let gmailSyncEvents = 0;
  let gmailInputEvents = 0;
  body.addEventListener("input", () => {
    gmailInputEvents += 1;
  });
  body.addEventListener("keydown", (event) => {
    if (event.key === "Control") gmailSyncEvents += 1;
  });
  let gmailCaptureSends = 0;
  let serializedBody = "";
  window.document.addEventListener(
    "click",
    (event) => {
      if (!event.target.closest?.('[data-tooltip="Send"]')) return;
      gmailCaptureSends += 1;
      serializedBody = body.innerHTML;
    },
    true
  );
  window.eval(await source("src/content.js"));
  body.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  await tick(window);

  assert.equal(body.querySelector("img[data-mailtrack-pixel]"), null);
  assert.equal(gmailInputEvents, 0);
  assert.equal(gmailSyncEvents, 0);
  assert.equal(body.querySelector("a").href, "https://example.com/");
  assert.equal(
    requests.filter(
      (request) => request.url.endsWith("/api/emails") && request.options.method === "POST"
    ).length,
    1
  );

  const subject = compose.querySelector('[name="subjectbox"]');
  subject.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  body.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(window);
  assert.equal(gmailCaptureSends, 0);
  assert.equal(body.querySelector("img[data-mailtrack-pixel]"), null);

  let repeatMutations = 0;
  const observer = new window.MutationObserver((records) => {
    repeatMutations += records.length;
  });
  observer.observe(compose, { attributes: true, childList: true, subtree: true });
  for (let index = 0; index < 25; index += 1) {
    body.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  }
  await Promise.resolve();
  observer.disconnect();
  assert.equal(repeatMutations, 0);
  assert.equal(body.querySelectorAll("img[data-mailtrack-pixel]").length, 0);
  const send = compose.querySelector('[data-tooltip="Send"]');
  let gmailClicks = 0;
  send.addEventListener("click", () => {
    gmailClicks += 1;
  });
  send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(window);
  assert.equal(gmailClicks, 1);
  assert.equal(gmailCaptureSends, 1);
  assert.match(serializedBody, /\/o\/[A-Za-z0-9_-]+\.gif/);
  assert.equal(body.querySelectorAll("img[data-mailtrack-pixel]").length, 1);
  assert.equal(gmailInputEvents, 1);
  assert.equal(gmailSyncEvents, 1);
  const pixel = body.querySelector("img[data-mailtrack-pixel]");
  assert.match(pixel.src, /\/o\/[A-Za-z0-9_-]+\.gif$/);
  assert.equal(pixel.width, 0);
  assert.equal(pixel.height, 0);
  assert.equal(pixel.style.display, "flex");

  window.dispatchEvent(
    new window.CustomEvent("mailtrack:gmail-send", {
      detail: JSON.stringify({
        trackingId: pixel.dataset.mailtrackPixel,
        threadId: "19fc000000000123",
        messageId: "19fc100000000123",
      }),
    })
  );
  await tick(window);
  assert.equal(
    requests.filter(
      (request) => request.url.includes("/api/emails/") && request.options.method === "PATCH"
    )
      .length,
    1
  );
  const immediateMappingRequest = requests.find(
    (request) => request.url.includes("/api/emails/") && request.options.method === "PATCH"
  );
  assert.equal(
    Number.isNaN(new Date(JSON.parse(immediateMappingRequest.options.body).sentAt).getTime()),
    false
  );
  assert.equal(JSON.parse(immediateMappingRequest.options.body).scheduled, false);

  dom.window.close();
});

test("an inline Gmail reply is tracked before Gmail sends it", async () => {
  const requests = [];
  const { dom, window } = await createWindow({
    url: "https://mail.google.com/mail/u/0/#inbox/thread-a:r-1234567890123456789",
    html: `<!doctype html><body>
      <div class="adn" data-legacy-thread-id="19fc000000000123">
        <div class="ip" id="inline-reply">
          <div class="Am" aria-label="Message Body" role="textbox" contenteditable="true">Reply text</div>
          <div role="button" data-tooltip="Send">Send</div>
        </div>
      </div>
    </body>`,
    async fetchHandler(url, options = {}) {
      requests.push({ url: String(url), options });
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  window.eval(await source("src/send-gate.js"));
  const body = window.document.querySelector(".Am");
  let serializedBody = "";
  let gmailSends = 0;
  window.document.addEventListener(
    "click",
    (event) => {
      if (!event.target.closest?.('[data-tooltip="Send"]')) return;
      gmailSends += 1;
      serializedBody = body.innerHTML;
    },
    true
  );
  let preparedSend = null;
  window.addEventListener("mailtrack:prepare-send", (event) => {
    preparedSend = JSON.parse(event.detail);
  });
  window.eval(await source("src/content.js"));
  body.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  await tick(window);

  window.document
    .querySelector('[data-tooltip="Send"]')
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(window);

  assert.equal(gmailSends, 1);
  assert.match(serializedBody, /\/o\/[A-Za-z0-9_-]+\.gif/);
  assert.match(preparedSend?.pixelUrl || "", /\/o\/[A-Za-z0-9_-]+\.gif$/);
  assert.equal(
    requests.filter(
      (request) => request.url.endsWith("/api/emails") && request.options.method === "POST"
    ).length,
    2
  );

  dom.window.close();
});

test("Schedule send is blocked until the compose is prepared exactly like Send", async () => {
  const requests = [];
  const { dom, window } = await createWindow({
    html: `<!doctype html><body>
      <div role="dialog" id="compose">
        <div aria-label="Message Body" role="textbox" contenteditable="true">Scheduled body</div>
        <div role="button" data-tooltip="Send">Send</div>
        <div role="button" data-tooltip="More send options">More send options</div>
      </div>
      <div role="menuitem" id="schedule-send">Schedule send</div>
    </body>`,
    async fetchHandler(url, options = {}) {
      requests.push({ url: String(url), options });
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  window.eval(await source("src/send-gate.js"));
  const body = window.document.querySelector('[aria-label="Message Body"]');
  let gmailScheduleClicks = 0;
  let gmailSendClicks = 0;
  let serializedBody = "";
  let inputEvents = 0;
  let syncEvents = 0;
  let preparedSend = null;
  body.addEventListener("input", () => {
    inputEvents += 1;
  });
  body.addEventListener("keydown", (event) => {
    if (event.key === "Control") syncEvents += 1;
  });
  window.document.addEventListener(
    "click",
    (event) => {
      if (event.target.closest?.("#schedule-send")) {
        gmailScheduleClicks += 1;
        serializedBody = body.innerHTML;
      }
      if (event.target.closest?.('[data-tooltip="Send"]')) gmailSendClicks += 1;
    },
    true
  );
  window.addEventListener("mailtrack:prepare-send", (event) => {
    preparedSend = JSON.parse(event.detail);
  });
  window.eval(await source("src/content.js"));
  body.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  await tick(window);

  window.document
    .querySelector('[data-tooltip="More send options"]')
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  window.document
    .querySelector("#schedule-send")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(window);

  assert.equal(gmailScheduleClicks, 1);
  assert.equal(gmailSendClicks, 0);
  assert.equal(inputEvents, 1);
  assert.equal(syncEvents, 1);
  assert.match(serializedBody, /\/o\/[A-Za-z0-9_-]+\.gif/);
  assert.equal(body.querySelectorAll("img[data-mailtrack-pixel]").length, 1);
  assert.match(preparedSend?.pixelUrl || "", /\/o\/[A-Za-z0-9_-]+\.gif$/);
  assert.equal(
    requests.filter(
      (request) => request.url.endsWith("/api/emails") && request.options.method === "POST"
    ).length,
    2
  );

  const trackingId = body.querySelector("img[data-mailtrack-pixel]").dataset.mailtrackPixel;
  window.dispatchEvent(
    new window.CustomEvent("mailtrack:gmail-send", {
      detail: JSON.stringify({
        trackingId,
        threadId: "19fc000000000789",
        messageId: "19fc100000000789",
        scheduled: true,
      }),
    })
  );
  await tick(window);
  assert.equal(
    requests.filter(
      (request) =>
        request.url.includes(`/api/emails/${trackingId}`) && request.options.method === "PATCH"
    ).length,
    1
  );
  const scheduledMappingRequest = requests.find(
    (request) =>
      request.url.includes(`/api/emails/${trackingId}`) && request.options.method === "PATCH"
  );
  const scheduledMappingBody = JSON.parse(scheduledMappingRequest.options.body);
  assert.equal(Number.isNaN(new Date(scheduledMappingBody.sentAt).getTime()), false);
  assert.equal(scheduledMappingBody.scheduled, true);
  dom.window.close();
});

test("Sent rows receive passive status indicators", async () => {
  const tracks = [
    {
      id: "track-123",
      gmailThreadId: "19fc000000000123",
      gmailMessageId: "19fc100000000123",
      opened: true,
      openCount: 2,
      openHistory: [],
    },
    {
      id: "track-456",
      gmailThreadId: "19fc000000000456",
      gmailMessageId: "19fc100000000456",
      opened: false,
      openCount: 0,
      openHistory: [],
    },
  ];
  const { dom, window } = await createWindow({
    cache: tracks,
    html: `<!doctype html><body>
      <table><tbody id="sent-list">
        <tr class="zA" data-legacy-thread-id="19fc000000000123">
          <td class="yX"><span class="yW">recipient</span></td>
        </tr>
        <tr class="zA" data-legacy-thread-id="19fc000000000456">
          <td class="yX"><span class="yW">recipient</span></td>
        </tr>
      </tbody></table>
    </body>`,
    async fetchHandler(url) {
      if (String(url).endsWith("/api/emails")) {
        return { ok: true, json: async () => ({ emails: tracks }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  window.eval(await source("src/mt-ui.js"));
  await tick(window);

  const badges = window.document.querySelectorAll(".mt-status-badge");
  assert.equal(badges.length, 2);
  assert.equal(badges[0].textContent, "Opened 2x");
  assert.equal(badges[1].textContent, "Not opened");
  assert.equal(badges[0].getAttribute("aria-hidden"), "true");
  assert.equal(badges[0].onclick, null);

  const newRow = window.document.createElement("tr");
  newRow.className = "zA";
  newRow.setAttribute("data-legacy-thread-id", "19fc000000000456");
  newRow.innerHTML = '<td class="yX"><span class="yW">recipient</span></td>';
  window.document.querySelector("#sent-list").appendChild(newRow);
  await Promise.resolve();
  assert.equal(newRow.querySelector(".mt-status-badge")?.textContent, "Not opened");

  dom.window.close();
});

test("Scheduled rows identify messages whose tracking pixel is registered", async () => {
  const tracks = [
    {
      id: "track-scheduled",
      gmailThreadId: "19fc000000000789",
      gmailMessageId: "19fc100000000789",
      opened: false,
      openCount: 0,
      openHistory: [],
    },
  ];
  const { dom, window } = await createWindow({
    url: "https://mail.google.com/mail/u/0/#scheduled",
    cache: tracks,
    html: `<!doctype html><body>
      <table><tbody>
        <tr class="zA" data-legacy-thread-id="19fc000000000789">
          <td class="yX"><span class="yW">recipient</span></td>
        </tr>
        <tr class="zA" data-legacy-thread-id="19fc000000000999">
          <td class="yX"><span class="yW">untracked recipient</span></td>
        </tr>
      </tbody></table>
    </body>`,
    async fetchHandler(url) {
      if (String(url).endsWith("/api/emails")) {
        return { ok: true, json: async () => ({ emails: tracks }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  window.eval(await source("src/mt-ui.js"));
  await tick(window);

  const rows = window.document.querySelectorAll("tr.zA");
  const badge = rows[0].querySelector(".mt-status-badge");
  assert.equal(badge?.textContent, "Email tracked");
  assert.equal(badge?.classList.contains("mt-scheduled"), true);
  assert.equal(badge?.getAttribute("aria-hidden"), "true");
  assert.equal(rows[1].querySelector(".mt-status-badge"), null);
  dom.window.close();
});

test("an opened Scheduled message shows Email tracked and records a self-view interval", async () => {
  const track = {
    id: "track-scheduled-open",
    gmailThreadId: "19fc000000000790",
    gmailMessageId: "19fc100000000790",
    opened: true,
    openCount: 1,
    openHistory: ["2026-08-02T20:30:00.000Z"],
  };
  const requests = [];
  const { dom, window } = await createWindow({
    url: "https://mail.google.com/mail/u/0/#scheduled/19fc000000000790",
    cache: [track],
    html: `<!doctype html><body>
      <div class="adn" data-legacy-thread-id="19fc000000000790" data-legacy-message-id="19fc100000009999">
        <div><span class="g3">Scheduled for tomorrow</span></div>
        <img class="mailtrack-img" src="https://ci3.googleusercontent.com/opaque-proxy-url">
      </div>
    </body>`,
    async fetchHandler(url, options = {}) {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/api/emails")) {
        return { ok: true, json: async () => ({ emails: [track] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  window.eval(await source("src/mt-ui.js"));
  for (
    let attempt = 0;
    attempt < 10 &&
    requests.filter((request) => request.url.endsWith("/selfview")).length < 2;
    attempt += 1
  ) {
    await tick(window);
  }

  const badge = window.document.querySelector(".mt-thread-status");
  assert.equal(badge?.textContent, "Email tracked");
  assert.equal(badge?.classList.contains("mt-scheduled"), true);
  assert.equal(badge?.disabled, true);
  assert.equal(badge?.getAttribute("aria-label"), "Email tracking enabled");
  const phases = requests
    .filter((request) => request.url.endsWith("/selfview"))
    .map((request) => JSON.parse(request.options.body).phase);
  assert.deepEqual(phases, ["start", "end"]);
  dom.window.close();
});

test("each sent message gets its own history while received messages and Inbox rows stay unlabeled", async () => {
  const firstOpen = "2026-08-02T19:35:11.489Z";
  const latestOpen = "2026-08-02T20:01:42.000Z";
  const replyOpen = "2026-08-02T20:15:00.000Z";
  const tracks = [
    {
      id: "track-original",
      gmailThreadId: "19fc000000000123",
      gmailMessageId: "19fc100000000111",
      opened: true,
      openCount: 2,
      openHistory: [firstOpen, latestOpen],
    },
    {
      id: "track-reply",
      gmailThreadId: "19fc000000000123",
      gmailMessageId: null,
      opened: true,
      openCount: 1,
      openHistory: [replyOpen],
    },
  ];
  const requests = [];
  const { dom, window } = await createWindow({
    url: "https://mail.google.com/mail/u/0/#inbox/19fc000000000123",
    cache: tracks,
    html: `<!doctype html><body>
      <table><tbody>
        <tr class="zA" data-legacy-thread-id="19fc000000000123">
          <td class="yX"><span class="yW">sender</span></td>
        </tr>
      </tbody></table>
      <div class="adn" id="sent-original" data-legacy-thread-id="19fc000000000123" data-legacy-message-id="19fc100000000111">
        <div class="actions"><span class="g3">7:30 PM</span><span role="button" aria-label="Not starred">star</span></div>
      </div>
      <div class="adn" id="received" data-legacy-thread-id="19fc000000000123" data-legacy-message-id="19fc100000000999">
        <div class="actions"><span class="g3">8:05 PM</span></div>
        <blockquote><img src="https://backend.example.test/o/track-original.gif"></blockquote>
      </div>
      <div class="adn" id="sent-reply" data-legacy-thread-id="19fc000000000123" data-legacy-message-id="19fc100000000222">
        <div class="actions"><span class="g3">8:14 PM</span></div>
        <img data-mailtrack-pixel="track-reply" src="https://backend.example.test/o/track-reply.gif">
      </div>
    </body>`,
    async fetchHandler(url, options = {}) {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/api/emails")) {
        return { ok: true, json: async () => ({ emails: tracks }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  const originalActions = window.document.querySelector("#sent-original .actions");
  const originalHeaderChildren = originalActions.childNodes.length;
  window.eval(await source("src/mt-ui.js"));
  await tick(window);
  await tick(window);

  assert.equal(window.document.querySelectorAll(".mt-status-badge").length, 0);
  assert.equal(window.document.querySelectorAll(".mt-thread-status").length, 2);
  assert.equal(window.document.querySelector("#received .mt-thread-status"), null);

  const originalBadge = window.document.querySelector("#sent-original .mt-thread-status");
  const replyBadge = window.document.querySelector("#sent-reply .mt-thread-status");
  assert.equal(originalBadge?.textContent, "Opened 2x");
  assert.equal(replyBadge?.textContent, "Opened 1x");
  assert.equal(originalBadge?.parentElement, originalActions.querySelector(".g3"));
  assert.equal(originalActions.childNodes.length, originalHeaderChildren);

  const originalCard = window.document.querySelector("#sent-original .mt-history-card");
  const replyCard = window.document.querySelector("#sent-reply .mt-history-card");
  originalBadge.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(originalCard.hidden, false);
  assert.deepEqual(
    [...originalCard.querySelectorAll("time")].map((time) => time.dateTime),
    [latestOpen, firstOpen]
  );
  assert.equal(originalCard.querySelectorAll(".mt-history-row").length, 2);
  assert.equal(originalCard.querySelector("ol, li, .mt-history-number"), null);

  replyBadge.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(originalCard.hidden, true);
  assert.equal(replyCard.hidden, false);
  assert.deepEqual(
    [...replyCard.querySelectorAll("time")].map((time) => time.dateTime),
    [replyOpen]
  );

  assert.equal(
    requests.filter((request) => request.url.endsWith("/selfview")).length,
    0
  );
  assert.equal(
    requests.filter((request) => request.options.method === "PATCH").length,
    0
  );

  let repeatMutations = 0;
  const observer = new window.MutationObserver((records) => {
    repeatMutations += records.length;
  });
  observer.observe(window.document.body, { attributes: true, childList: true, subtree: true });
  for (let index = 0; index < 25; index += 1) window.MT.ui.render();
  await Promise.resolve();
  observer.disconnect();
  assert.equal(repeatMutations, 0);

  const star = originalActions.querySelector('[aria-label="Not starred"]');
  let starClicks = 0;
  star.addEventListener("click", () => {
    starClicks += 1;
  });
  star.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(starClicks, 1);

  dom.window.close();
});

test("a Sent message keeps one mounted badge while sender-view status settles", async () => {
  const staleTrack = {
    id: "track-self-view",
    gmailThreadId: "19fc000000000333",
    gmailMessageId: "19fc100000000333",
    opened: true,
    openCount: 1,
    openHistory: ["2026-08-02T20:30:00.000Z"],
  };
  let selfViewRecorded = false;
  let releaseSelfView;
  const selfViewGate = new Promise((resolve) => {
    releaseSelfView = resolve;
  });
  const requests = [];
  const { dom, window } = await createWindow({
    url: "https://mail.google.com/mail/u/0/#sent/19fc000000000333",
    cache: [staleTrack],
    html: `<!doctype html><body>
      <div class="adn" data-legacy-thread-id="19fc000000000333" data-legacy-message-id="19fc100000000333">
        <div><span class="g3">8:30 PM</span></div>
      </div>
    </body>`,
    async fetchHandler(url, options = {}) {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/selfview")) {
        await selfViewGate;
        selfViewRecorded = true;
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (String(url).endsWith("/api/emails")) {
        const currentTrack = selfViewRecorded
          ? { ...staleTrack, opened: false, openCount: 0, openHistory: [] }
          : staleTrack;
        return { ok: true, json: async () => ({ emails: [currentTrack] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  const pageStartedAt = new Date(window.performance.timeOrigin).toISOString();
  window.eval(await source("src/mt-ui.js"));
  await tick(window);
  const mountedBadge = window.document.querySelector(".mt-thread-status");
  assert.equal(mountedBadge?.textContent, "Opened 1x");
  releaseSelfView();
  for (let attempt = 0; attempt < 10 && mountedBadge.textContent !== "Not opened"; attempt += 1) {
    await tick(window);
  }

  assert.equal(window.document.querySelector(".mt-thread-status"), mountedBadge);
  assert.equal(mountedBadge.textContent, "Not opened");
  window.dispatchEvent(new window.HashChangeEvent("hashchange"));
  assert.equal(window.document.querySelector(".mt-thread-status"), mountedBadge);
  assert.equal(
    requests.filter((request) => request.url.endsWith("/selfview")).length,
    2
  );
  const selfViewBodies = requests
    .filter((request) => request.url.endsWith("/selfview"))
    .map((request) => JSON.parse(request.options.body));
  assert.deepEqual(
    selfViewBodies.map((body) => body.phase),
    ["start", "end"]
  );
  assert.equal(selfViewBodies[0].viewedAt, pageStartedAt);
  assert.equal(
    selfViewBodies.every((body) => !Number.isNaN(new Date(body.viewedAt).getTime())),
    true
  );
  dom.window.close();
});

test("returning focus to Gmail refreshes an updated recipient-open status", async () => {
  let serverTrack = {
    id: "track-123",
    gmailThreadId: "19fc000000000123",
    opened: false,
    openCount: 0,
  };
  let listRequests = 0;
  let openedAfterRequest = Number.POSITIVE_INFINITY;
  const { dom, window } = await createWindow({
    cache: [serverTrack],
    html: `<!doctype html><body>
      <table><tbody>
        <tr class="zA" data-legacy-thread-id="19fc000000000123">
          <td class="WA">important</td>
          <td class="yX"><span class="yW">recipient</span></td>
          <td><span class="bog">Tracked email</span></td>
        </tr>
      </tbody></table>
    </body>`,
    async fetchHandler(url) {
      if (String(url).endsWith("/api/emails")) {
        listRequests += 1;
        const responseTrack =
          listRequests >= openedAfterRequest
            ? { ...serverTrack, opened: true, openCount: 1 }
            : serverTrack;
        return { ok: true, json: async () => ({ emails: [responseTrack] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  window.eval(await source("src/mt-ui.js"));
  await tick(window);
  assert.equal(
    window.document.querySelector(".mt-status-badge")?.textContent,
    "Not opened"
  );

  openedAfterRequest = listRequests + 2;
  window.dispatchEvent(new window.Event("focus"));
  await tick(window);
  await tick(window);

  assert.equal(window.document.querySelector(".mt-status-badge")?.textContent, "Opened 1x");
  assert.equal(listRequests >= openedAfterRequest, true);
  dom.window.close();
});

test("Gmail page observer finds the tracking ID and exact sent IDs", async () => {
  const { dom, window } = await createWindow({
    html: "<!doctype html><body></body>",
    async fetchHandler() {
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  const request = JSON.stringify({
    body: '<div>test</div><img src="https://backend.example.test/o/track_ABC-123.gif">',
  });
  const outgoingMessage = [];
  outgoingMessage[8] = [null, [[null, '<div dir="ltr">test</div>']]];
  const messageData = [outgoingMessage];
  const operation = [];
  operation[1] = [null, []];
  operation[1][1][13] = messageData;
  const outgoingRequest = [null, [[operation]]];
  const message = [];
  message[0] = "msg-a:r-1234567890123456789";
  message[55] = "19fc100000000123";
  const thread = [];
  thread[4] = [message];
  thread[19] = "19fc000000000123";

  class FakeXMLHttpRequest extends window.EventTarget {
    open() {}
    send(body) {
      this.requestBody = body;
      this.status = 200;
      this.responseText = JSON.stringify([0, [thread]]);
      this.dispatchEvent(new window.Event("load"));
    }
  }
  window.XMLHttpRequest = FakeXMLHttpRequest;
  window.eval(await source("src/gmail-page.js"));

  assert.deepEqual(
    [...window.MailTrackGmailPage.trackingIdsFrom(request)],
    ["track_ABC-123"]
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(window.MailTrackGmailPage.findMapping([0, [thread]]))),
    {
      threadId: "19fc000000000123",
      messageId: "19fc100000000123",
    }
  );

  let sentDetail = null;
  window.addEventListener("mailtrack:gmail-send", (event) => {
    sentDetail = JSON.parse(event.detail);
  });
  window.dispatchEvent(
    new window.CustomEvent("mailtrack:prepare-send", {
      detail: JSON.stringify({
        trackingId: "track_ABC-123",
        pixelUrl: "https://backend.example.test/o/track_ABC-123.gif",
      }),
    })
  );
  const xhr = new window.XMLHttpRequest();
  xhr.open("POST", "/sync/u/0/i/s?rt=r");
  xhr.send(JSON.stringify(outgoingRequest));
  assert.match(xhr.requestBody, /<img width=\\"0\\" height=\\"0\\"/);
  assert.match(xhr.requestBody, /\/o\/track_ABC-123\.gif/);
  assert.deepEqual(sentDetail, {
    trackingId: "track_ABC-123",
    threadId: "19fc000000000123",
    messageId: "19fc100000000123",
  });

  window.dispatchEvent(
    new window.CustomEvent("mailtrack:prepare-send", {
      detail: JSON.stringify({
        trackingId: "track_ABC-123",
        pixelUrl: "https://backend.example.test/o/track_ABC-123.gif",
        scheduled: true,
      }),
    })
  );
  const scheduledXhr = new window.XMLHttpRequest();
  scheduledXhr.open("POST", "/sync/u/0/i/s?rt=r");
  scheduledXhr.send(JSON.stringify(outgoingRequest));
  assert.equal(sentDetail.scheduled, true);
  dom.window.close();
});

test("unmapped same-subject rows are never guessed", async () => {
  const requests = [];
  const { dom, window } = await createWindow({
    cache: [{ id: "track-new", gmailThreadId: null, opened: false, openCount: 0 }],
    pending: [{ id: "track-new", subject: "test", sentAt: new Date().toISOString() }],
    html: `<!doctype html><body><table><tbody>
      <tr class="zA" data-legacy-thread-id="19fc00000000000a">
        <td class="yX"><span class="yW">recipient</span></td>
        <td><span class="bog">test</span></td>
      </tr>
    </tbody></table></body>`,
    async fetchHandler(url, options = {}) {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/api/emails") && !options.method) {
        return { ok: true, json: async () => ({ emails: [] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  window.eval(await source("src/mt-ui.js"));
  await tick(window);
  assert.equal(window.document.querySelector(".mt-status-badge"), null);
  assert.equal(requests.filter((request) => request.options.method === "PATCH").length, 0);
  dom.window.close();
});

test("a recycled Gmail row is rendered after its thread id changes", async () => {
  const tracks = [
    { id: "track-new", gmailThreadId: "19fc00000000000a", opened: true, openCount: 1 },
  ];
  const { dom, window } = await createWindow({
    cache: tracks,
    html: `<!doctype html><body>
      <table><tbody>
        <tr class="zA" data-legacy-thread-id="19fc00000000000b">
          <td class="yX"><span class="yW">recipient</span></td>
          <td><span class="bog">old subject</span></td>
        </tr>
      </tbody></table>
    </body>`,
    async fetchHandler(url) {
      if (String(url).endsWith("/api/emails")) {
        return { ok: true, json: async () => ({ emails: tracks }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  window.eval(await source("src/mt-ui.js"));
  await tick(window);
  const row = window.document.querySelector("tr.zA");
  assert.equal(row.querySelector(".mt-status-badge"), null);

  row.setAttribute("data-legacy-thread-id", "19fc00000000000a");
  row.querySelector(".bog").textContent = "new subject";
  await tick(window);

  assert.equal(row.querySelector(".mt-status-badge")?.textContent, "Opened 1x");
  dom.window.close();
});

test("Gmail decimal thread ids match API hexadecimal ids and temporary row ids are ignored", async () => {
  const apiThreadId = "19fc3c85c713abcd";
  const domThreadId = BigInt(`0x${apiThreadId}`).toString(10);
  const tracks = [
    { id: "track-new", gmailThreadId: apiThreadId, opened: false, openCount: 0 },
    { id: "track-corrupt", gmailThreadId: "r-789509", opened: true, openCount: 1 },
  ];
  const { dom, window } = await createWindow({
    cache: tracks,
    html: `<!doctype html><body>
      <table><tbody>
        <tr class="zA" data-legacy-thread-id="r-123456">
          <td class="yX"><span class="yW">recipient</span></td>
          <td><span class="bog" data-thread-id="#thread-f:${domThreadId}">test</span></td>
        </tr>
        <tr class="zA" data-legacy-thread-id="r-789509">
          <td class="yX"><span class="yW">recipient</span></td>
          <td><span class="bog">temporary id only</span></td>
        </tr>
      </tbody></table>
    </body>`,
    async fetchHandler(url) {
      if (String(url).endsWith("/api/emails")) {
        return { ok: true, json: async () => ({ emails: tracks }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  window.eval(await source("src/mt-ui.js"));
  await tick(window);

  const rows = window.document.querySelectorAll("tr.zA");
  assert.equal(rows[0].querySelector(".mt-status-badge")?.textContent, "Not opened");
  assert.equal(rows[1].querySelector(".mt-status-badge"), null);
  dom.window.close();
});

test("a Sent-row badge removed by Gmail remounts in the stable cell", async () => {
  const tracks = [
    { id: "track-old", gmailThreadId: "19fc00000000000b", opened: false, openCount: 0 },
    { id: "track-new", gmailThreadId: "19fc00000000000a", opened: true, openCount: 1 },
  ];
  const { dom, window } = await createWindow({
    cache: tracks,
    html: `<!doctype html><body>
      <table><tbody>
        <tr class="zA" data-legacy-thread-id="19fc00000000000b">
          <td class="yX"><span class="yW">recipient</span></td>
          <td><span class="bog">old subject</span></td>
        </tr>
      </tbody></table>
    </body>`,
    async fetchHandler(url) {
      if (String(url).endsWith("/api/emails")) {
        return { ok: true, json: async () => ({ emails: tracks }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  window.eval(await source("src/mt-ui.js"));
  await tick(window);
  const row = window.document.querySelector("tr.zA");
  const cell = row.querySelector("td.yX");
  assert.equal(row.querySelector(".mt-status-badge")?.parentElement, cell);
  row.querySelector(".mt-status-badge").remove();
  await tick(window);

  row.querySelector(".bog").textContent = "same message, rerendered";
  await tick(window);
  assert.equal(row.querySelector(".mt-status-badge")?.textContent, "Not opened");
  assert.equal(row.querySelector(".mt-status-badge")?.parentElement, cell);

  row.setAttribute("data-legacy-thread-id", "19fc00000000000a");
  await tick(window);
  assert.equal(row.querySelector(".mt-status-badge")?.textContent, "Opened 1x");
  dom.window.close();
});

test("Gmail content scripts have no recurring polling or document-wide observer", async () => {
  const gate = await source("src/send-gate.js");
  const content = await source("src/content.js");
  const ui = await source("src/mt-ui.js");
  const css = await source("src/content.css");

  assert.doesNotMatch(content, /setInterval/);
  assert.doesNotMatch(gate, /setInterval/);
  assert.doesNotMatch(ui, /setInterval/);
  assert.doesNotMatch(content, /new MutationObserver/);
  assert.doesNotMatch(ui, /observe\(\s*(document\.body|document\.documentElement)/);
  assert.doesNotMatch(content, /rewriteLinks|data-mailtrack-original-href|\/c\//);
  assert.match(ui, /img\.mailtrack-img/);
  assert.doesNotMatch(css, /position:\s*fixed|inset:\s*0/);
  assert.doesNotMatch(css, /z-index:\s*[1-9]\d{4,}/);
  assert.match(css, /pointer-events:\s*none\s*!important/);
});

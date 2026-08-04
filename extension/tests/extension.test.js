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
      getManifest: () => ({ version: "2.0.39" }),
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
  window.eval(await source("src/schedule-time.js"));
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

test("Send later schedules a pixel-tracked new message without Gmail Schedule send", async () => {
  const requests = [];
  const { dom, window } = await createWindow({
    html: `<!doctype html><body>
      <div role="dialog" id="outer-dialog">
        <div class="M9" id="inner-compose">
          <div
            role="region"
            data-compose-id="4"
            aria-label="New Message"
            id="compose"
            style="position: fixed; bottom: 0; height: 500px"
          >
            <div name="to" aria-label="To">
              <span data-hovercard-id="chip@example.com"></span>
              <input type="text" role="combobox" aria-label="To recipients" value="recipient@example.com">
            </div>
            <input name="subjectbox" value="Scheduled subject">
            <textarea class="Ak aiL" aria-label="Message Body"></textarea>
            <div aria-label="Message Body" role="textbox" contenteditable="true">Scheduled body</div>
            <div class="aDg" id="send-spacer" style="height: 116px">
              <div class="aDj" id="send-panel" style="height: 116px; bottom: 0px">
                <div class="aDh" id="send-controls">
                  <table class="IZ" id="gmail-toolbar"><tbody>
                    <tr class="btC">
                      <td class="gU Up"><div role="button" data-tooltip="Send">Send</div></td>
                      <td class="gU a0z"><div role="button" data-tooltip="Discard draft">Discard draft</div></td>
                    </tr>
                  </tbody></table>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </body>`,
    async fetchHandler(url, options = {}) {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/api/oauth/google/status")) {
        return { ok: true, json: async () => ({ connected: true, email: "sender@example.com" }) };
      }
      if (String(url).endsWith("/api/scheduled-emails")) {
        return {
          ok: true,
          json: async () => ({ ok: true, email: { id: "scheduled-1", status: "pending" } }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  window.eval(await source("src/send-gate.js"));
  const body = window.document.querySelector(
    '[aria-label="Message Body"][contenteditable="true"]'
  );
  const composeRoot = window.document.querySelector("#compose");
  const nativeBounds = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.classList?.contains("mt-send-later-row")) {
      return { width: 700, height: 60, top: 0, right: 700, bottom: 60, left: 0 };
    }
    if (this.getAttribute?.("data-tooltip") === "Send") {
      return { width: 70, height: 36, top: 0, right: 118, bottom: 36, left: 48 };
    }
    if (this.classList?.contains("mt-send-later-button")) {
      return { width: 110, height: 36, top: 0, right: 200, bottom: 36, left: 90 };
    }
    return nativeBounds.call(this);
  };
  let discardClicks = 0;
  window.document.addEventListener(
    "click",
    (event) => {
      if (event.target.closest?.('[data-tooltip="Discard draft"]')) discardClicks += 1;
    },
    true
  );
  const recipientInput = window.document.querySelector('[name="to"] input[type="text"]');
  recipientInput.focus();
  window.eval(await source("src/content.js"));
  recipientInput.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  await tick(window);
  await new Promise((resolve) => window.requestAnimationFrame(resolve));

  const input = window.document.querySelector(".mt-send-later-input");
  const button = window.document.querySelector(".mt-send-later-button");
  const schedulerRow = window.document.querySelector(".mt-send-later-row");
  assert.ok(input);
  assert.ok(button);
  assert.equal(window.document.querySelector("#outer-dialog").style.height, "");
  assert.equal(window.document.querySelector("#inner-compose").style.height, "");
  // Boomerang-style mount: appended as the last child of the .aDh send-controls wrapper,
  // right after Gmail's native toolbar table - the toolbar itself is never touched.
  assert.equal(schedulerRow.parentElement.id, "send-controls");
  assert.equal(schedulerRow.previousElementSibling.id, "gmail-toolbar");
  assert.equal(schedulerRow.nextElementSibling, null);
  assert.equal(window.document.querySelector("#gmail-toolbar [data-tooltip='Send']")?.textContent, "Send");
  assert.equal(window.document.querySelector("tr.btC").children.length, 2);
  assert.equal(window.document.querySelector("#send-controls").getAttribute("style"), null);
  assert.equal(window.document.querySelector("#gmail-toolbar").getAttribute("style"), null);
  // The docked panel (.aDj), its spacer (.aDg) and the compose region (.aoI) each get min-height
  // room for the row so the bottom-anchored window extends upward instead of clipping the Send
  // button. The room is enforced through an injected stylesheet (not inline styles) so Gmail's
  // wholesale rewrites of these elements' inline style attribute can't wipe it. Gmail's own
  // inline height on the compose is left untouched.
  assert.equal(composeRoot.style.getPropertyValue("height"), "500px");
  assert.equal(composeRoot.style.getPropertyValue("min-height"), "");
  assert.equal(composeRoot.style.getPropertyValue("bottom"), "0px");
  assert.equal(window.document.querySelector("#send-spacer").style.getPropertyValue("min-height"), "");
  const fitCss = window.document.getElementById("mt-scheduler-fit").textContent;
  assert.match(fitCss, /\[data-compose-id="4"\]\{min-height:560px !important\}/);
  assert.match(fitCss, /\[data-compose-id="4"\] \.aDg\{min-height:176px !important\}/);
  assert.match(fitCss, /\[data-compose-id="4"\] \.aDj\{min-height:176px !important\}/);
  // The button is shifted so its left edge (90) lines up with the native Send button (48), and
  // it takes the native Send button's width (70) so the two read as a matched pair.
  assert.equal(button.style.getPropertyValue("margin-left"), "-42px");
  assert.equal(button.style.getPropertyValue("min-width"), "70px");
  input.value = "tomorrow 11am";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  await tick(window);
  assert.equal(button.disabled, false);
  button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(window);

  const scheduledRequest = requests.find(
    (request) => request.url.endsWith("/api/scheduled-emails") && request.options.method === "POST"
  );
  assert.ok(scheduledRequest);
  const scheduledBody = JSON.parse(scheduledRequest.options.body);
  assert.deepEqual(scheduledBody.recipients, ["chip@example.com", "recipient@example.com"]);
  assert.equal(scheduledBody.subject, "Scheduled subject");
  assert.equal(scheduledBody.bodyHtml, "Scheduled body");
  assert.equal(window.document.querySelector("textarea").hasAttribute("data-mailtrack-id"), false);
  assert.equal(scheduledBody.localMinute, 0);
  assert.match(scheduledBody.trackingId, /^[A-Za-z0-9_-]{8,128}$/);
  assert.equal(body.querySelector("img[data-mailtrack-pixel]"), null);
  assert.equal(discardClicks, 1);
  composeRoot.remove();
  assert.equal(schedulerRow.isConnected, false);
  window.Element.prototype.getBoundingClientRect = nativeBounds;
  dom.window.close();
});

test("scheduler grows a compose region that has no inline height", async () => {
  const { dom, window } = await createWindow({
    html: `<!doctype html><body>
      <div role="region" data-compose-id="7" aria-label="New Message" id="compose">
        <div name="to" aria-label="To"><input type="text" role="combobox" value="a@example.com"></div>
        <input name="subjectbox" value="s">
        <div aria-label="Message Body" role="textbox" contenteditable="true">b</div>
        <div class="aDg" id="send-spacer" style="height: 116px">
          <div class="aDj" id="send-panel" style="height: 116px">
            <div class="aDh" id="send-controls">
              <table class="IZ" id="gmail-toolbar"><tbody>
                <tr class="btC"><td><div role="button" data-tooltip="Send">Send</div></td></tr>
              </tbody></table>
            </div>
          </div>
        </div>
      </div>
    </body>`,
    async fetchHandler(url) {
      if (String(url).endsWith("/api/oauth/google/status")) {
        return { ok: true, json: async () => ({ connected: true }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  window.eval(await source("src/send-gate.js"));
  const composeRoot = window.document.querySelector("#compose");
  const nativeBounds = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this === composeRoot) {
      return { width: 500, height: 480, top: 0, right: 500, bottom: 480, left: 0 };
    }
    if (this.classList?.contains("mt-send-later-row")) {
      return { width: 500, height: 60, top: 0, right: 500, bottom: 60, left: 0 };
    }
    return nativeBounds.call(this);
  };
  const recipientInput = window.document.querySelector('[name="to"] input[type="text"]');
  recipientInput.focus();
  window.eval(await source("src/content.js"));
  recipientInput.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  await tick(window);
  await new Promise((resolve) => window.requestAnimationFrame(resolve));

  assert.ok(window.document.querySelector(".mt-send-later-row"));
  assert.equal(composeRoot.getAttribute("style"), null);
  const fitCss = window.document.getElementById("mt-scheduler-fit").textContent;
  // No inline region height, so the region base is its rendered height (480 + 60 = 540).
  assert.match(fitCss, /\[data-compose-id="7"\]\{min-height:540px !important\}/);
  assert.match(fitCss, /\[data-compose-id="7"\] \.aDg\{min-height:176px !important\}/);
  assert.match(fitCss, /\[data-compose-id="7"\] \.aDj\{min-height:176px !important\}/);
  window.Element.prototype.getBoundingClientRect = nativeBounds;
  dom.window.close();
});

test("whole-hour parser resolves natural language and rejects minutes", async () => {
  const { dom, window } = await createWindow({
    html: "<!doctype html><body></body>",
    async fetchHandler() {
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  const now = new Date(2026, 7, 3, 10, 0, 0, 0);
  const nextTuesday = window.MTScheduleTime.parse("tue 11am", now);
  assert.equal(nextTuesday.valid, true);
  assert.equal(nextTuesday.date.getFullYear(), 2026);
  assert.equal(nextTuesday.date.getMonth(), 7);
  assert.equal(nextTuesday.date.getDate(), 4);
  assert.equal(nextTuesday.date.getHours(), 11);
  assert.equal(window.MTScheduleTime.parse("tomorrow 11:30am", now).valid, false);
  assert.equal(window.MTScheduleTime.parse("today 9am", now).valid, false);
  assert.equal(window.MTScheduleTime.parse("2026-08-04 23", now).valid, true);

  // "tod" and "tom" abbreviate today and tomorrow.
  const abbrevTomorrow = window.MTScheduleTime.parse("tom 11am", now);
  assert.equal(abbrevTomorrow.valid, true);
  assert.equal(abbrevTomorrow.date.getDate(), 4);
  assert.equal(abbrevTomorrow.date.getHours(), 11);
  const abbrevToday = window.MTScheduleTime.parse("tod 3pm", now);
  assert.equal(abbrevToday.valid, true);
  assert.equal(abbrevToday.date.getDate(), 3);
  assert.equal(abbrevToday.date.getHours(), 15);
  assert.equal(window.MTScheduleTime.parse("tod 9am", now).valid, false);
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
          <td class="WA">important</td>
          <td class="yX"><span class="yW">recipient</span></td>
        </tr>
        <tr class="zA" data-legacy-thread-id="19fc000000000456">
          <td class="WA">important</td>
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

  const nativeBounds = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function () {
    if (this.matches?.(".mt-status-badge")) {
      return { ...nativeBounds.call(this), right: this.classList.contains("mt-opened") ? 252 : 236 };
    }
    if (this.matches?.("td.yX")) {
      return { ...nativeBounds.call(this), left: 200 };
    }
    return nativeBounds.call(this);
  };

  window.eval(await source("src/mt-ui.js"));
  await tick(window);

  const badges = window.document.querySelectorAll(".mt-status-badge");
  assert.equal(badges.length, 2);
  assert.equal(badges[0].dataset.mtStatusLabel, "Opened 2 times");
  assert.equal(badges[0].textContent, "2x");
  assert.equal(badges[1].dataset.mtStatusLabel, "Not opened");
  assert.equal(badges[1].textContent, "");
  assert.equal(badges[0].querySelector(".mt-status-icon") != null, true);
  assert.equal(badges[1].querySelector(".mt-status-icon") != null, true);
  assert.equal(badges[0].parentElement, badges[0].closest("tr").querySelector("td.WA"));
  assert.equal(badges[0].classList.contains("mt-after-importance"), true);
  assert.equal(
    Number.parseFloat(
      badges[0].closest("tr").querySelector(".mt-status-spacer")?.style.width
    ) >= 50,
    true
  );
  assert.equal(
    Number.parseFloat(
      badges[1].closest("tr").querySelector(".mt-status-spacer")?.style.width
    ) >= 35,
    true
  );
  assert.equal(badges[0].getAttribute("aria-hidden"), "true");
  assert.equal(badges[0].onclick, null);

  const newRow = window.document.createElement("tr");
  newRow.className = "zA";
  newRow.setAttribute("data-legacy-thread-id", "19fc000000000456");
  newRow.innerHTML =
    '<td class="WA">important</td><td class="yX"><span class="yW">recipient</span></td>';
  window.document.querySelector("#sent-list").appendChild(newRow);
  await tick(window);
  assert.equal(newRow.querySelector(".mt-status-badge")?.dataset.mtStatusLabel, "Not opened");
  assert.equal(newRow.querySelector(".mt-status-badge")?.parentElement, newRow.querySelector("td.WA"));

  dom.window.close();
});

test("Draft rows show the scheduled-send time for a pending scheduled email", async () => {
  const sendAt = "2026-08-04T15:00:00.000Z";
  const scheduled = [
    {
      id: "scheduled-1",
      status: "pending",
      subject: "Later",
      sendAt,
      gmailThreadId: "19fc000000000123",
    },
  ];
  const { dom, window } = await createWindow({
    url: "https://mail.google.com/mail/u/0/#drafts",
    html: `<!doctype html><body>
      <table><tbody id="drafts-list">
        <tr class="zA" data-legacy-thread-id="19fc000000000123">
          <td class="WA">important</td>
          <td class="yX"><span class="yW">recipient</span></td>
        </tr>
        <tr class="zA" data-legacy-thread-id="19fc000000000999">
          <td class="WA">important</td>
          <td class="yX"><span class="yW">recipient</span></td>
        </tr>
      </tbody></table>
    </body>`,
    async fetchHandler(url) {
      if (String(url).endsWith("/api/scheduled-emails")) {
        return { ok: true, json: async () => ({ emails: scheduled }) };
      }
      if (String(url).endsWith("/api/emails")) {
        return { ok: true, json: async () => ({ emails: [] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  window.eval(await source("src/mt-ui.js"));
  await tick(window);

  const expectedLabel = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
  }).format(new Date(sendAt));

  const badges = window.document.querySelectorAll(".mt-status-badge");
  assert.equal(badges.length, 1);
  const badge = badges[0];
  assert.equal(badge.closest("tr").getAttribute("data-legacy-thread-id"), "19fc000000000123");
  assert.equal(badge.classList.contains("mt-scheduled"), true);
  assert.equal(badge.querySelector('.mt-status-icon')?.dataset.mtIcon, "tracked");
  assert.equal(badge.querySelector(".mt-status-count")?.textContent, expectedLabel);
  assert.equal(badge.dataset.mtStatusLabel, `Scheduled for ${expectedLabel}`);
  assert.equal(badge.parentElement, badge.closest("tr").querySelector("td.WA"));

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
          <td class="WA">important</td>
          <td class="yX"><span class="yW">recipient</span></td>
        </tr>
        <tr class="zA" data-legacy-thread-id="19fc000000000999">
          <td class="WA">important</td>
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
  assert.equal(badge?.textContent, "");
  assert.equal(badge?.dataset.mtStatusLabel, "Email tracked");
  assert.equal(badge?.querySelector(".mt-status-icon")?.dataset.mtIcon, "tracked");
  assert.equal(badge?.querySelectorAll("path, circle").length, 2);
  assert.equal(badge?.classList.contains("mt-scheduled"), true);
  assert.equal(badge?.parentElement, rows[0].querySelector("td.WA"));
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
  assert.equal(originalBadge?.dataset.mtStatusLabel, "Opened 2 times");
  assert.equal(originalBadge?.textContent, "2x");
  assert.equal(replyBadge?.dataset.mtStatusLabel, "Opened");
  assert.equal(replyBadge?.textContent, "");
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

  // Viewing your own reply's pixel inside the inbox thread is a sender self-view, so it is
  // reported (and excluded) - but only for the reply, never the received email or the earlier
  // sent message whose pixel isn't loaded here.
  const selfViewRequests = requests.filter((request) => request.url.endsWith("/selfview"));
  assert.equal(selfViewRequests.length >= 1, true);
  assert.equal(
    selfViewRequests.every((request) => request.url.includes("track-reply")),
    true
  );
  assert.equal(
    requests.filter((request) => request.options.method === "PATCH").length,
    1
  );
  const replyMapping = requests.find((request) => request.options.method === "PATCH");
  assert.equal(replyMapping.url.includes("track-reply"), true);
  assert.deepEqual(JSON.parse(replyMapping.options.body), {
    gmailThreadId: "19fc000000000123",
    gmailMessageId: "19fc100000000222",
  });

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

test("a received email in a single-tracked-reply thread is not badged or self-viewed", async () => {
  const track = {
    id: "track-only-reply",
    gmailThreadId: "19fc000000000abc",
    gmailMessageId: null,
    opened: false,
    openCount: 0,
    openHistory: [],
  };
  const requests = [];
  const { dom, window } = await createWindow({
    url: "https://mail.google.com/mail/u/0/#inbox/19fc000000000abc",
    cache: [track],
    html: `<!doctype html><body>
      <div class="adn" id="received" data-legacy-thread-id="19fc000000000abc" data-legacy-message-id="19fc100000000777">
        <div class="actions"><span class="g3">9:00 AM</span></div>
      </div>
      <div class="adn" id="reply" data-legacy-thread-id="19fc000000000abc" data-legacy-message-id="19fc100000000888">
        <div class="actions"><span class="g3">9:05 AM</span></div>
        <img data-mailtrack-pixel="track-only-reply" src="https://backend.example.test/o/track-only-reply.gif">
      </div>
    </body>`,
    async fetchHandler(url) {
      requests.push({ url: String(url) });
      if (String(url).endsWith("/api/emails")) {
        return { ok: true, json: async () => ({ emails: [track] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  window.eval(await source("src/mt-ui.js"));
  await tick(window);
  await tick(window);

  // Only the reply (which carries the pixel) is badged; the received email must not inherit it.
  assert.equal(window.document.querySelectorAll(".mt-thread-status").length, 1);
  assert.equal(window.document.querySelector("#received .mt-thread-status"), null);
  assert.ok(window.document.querySelector("#reply .mt-thread-status"));
  // And self-view is reported only for the reply, never for the received email.
  const selfViews = requests.filter((request) => request.url.endsWith("/selfview"));
  assert.equal(
    selfViews.every((request) => request.url.includes("track-only-reply")),
    true
  );

  dom.window.close();
});

test("a Sent row mirrors the exact track shown by the email-page icon", async () => {
  const threadTrack = {
    id: "track-thread-default",
    gmailThreadId: "19fc000000000127",
    gmailMessageId: "19fc100000000111",
    opened: true,
    openCount: 2,
  };
  const pageTrack = {
    id: "track-page-exact",
    gmailThreadId: "19fc000000000127",
    gmailMessageId: "19fc100000000222",
    opened: false,
    openCount: 0,
  };
  const tracks = [threadTrack, pageTrack];
  const { dom, window } = await createWindow({
    url: "https://mail.google.com/mail/u/0/#inbox/19fc000000000127",
    cache: tracks,
    html: `<!doctype html><body>
      <table><tbody>
        <tr class="zA" data-legacy-thread-id="19fc000000000127">
          <td class="WA">important</td>
          <td class="yX"><span class="yW">recipient</span></td>
        </tr>
      </tbody></table>
      <div class="adn" id="exact-message" data-legacy-thread-id="19fc000000000127" data-legacy-message-id="19fc100000000222">
        <div><span class="g3">5:20 AM</span></div>
        <img data-mailtrack-pixel="track-page-exact" src="https://backend.example.test/o/track-page-exact.gif">
      </div>
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
  assert.equal(
    window.document.querySelector(".mt-thread-status")?.dataset.mtStatusLabel,
    "Not opened"
  );

  window.document.querySelector("#exact-message").remove();
  window.location.hash = "#sent";
  window.dispatchEvent(new window.HashChangeEvent("hashchange"));
  await tick(window);

  const rowBadge = window.document.querySelector(".mt-status-badge");
  assert.equal(rowBadge?.dataset.mtStatusLabel, "Not opened");
  assert.equal(rowBadge?.textContent, "");
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
  assert.equal(mountedBadge?.dataset.mtStatusLabel, "Opened");
  releaseSelfView();
  for (
    let attempt = 0;
    attempt < 10 && mountedBadge.dataset.mtStatusLabel !== "Not opened";
    attempt += 1
  ) {
    await tick(window);
  }

  assert.equal(window.document.querySelector(".mt-thread-status"), mountedBadge);
  assert.equal(mountedBadge.dataset.mtStatusLabel, "Not opened");
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
    window.document.querySelector(".mt-status-badge")?.dataset.mtStatusLabel,
    "Not opened"
  );

  openedAfterRequest = listRequests + 2;
  window.dispatchEvent(new window.Event("focus"));
  await tick(window);
  await tick(window);

  assert.equal(window.document.querySelector(".mt-status-badge")?.dataset.mtStatusLabel, "Opened");
  assert.equal(listRequests >= openedAfterRequest, true);
  dom.window.close();
});

test("post-send monitoring updates the existing Sent badge in place", async () => {
  const unopenedTrack = {
    id: "track-live-update",
    gmailThreadId: "19fc000000000124",
    opened: false,
    openCount: 0,
  };
  let listRequests = 0;
  const { dom, window } = await createWindow({
    cache: [unopenedTrack],
    html: `<!doctype html><body>
      <table><tbody>
        <tr class="zA" data-legacy-thread-id="19fc000000000124">
          <td class="WA">important</td>
          <td class="yX"><span class="yW">recipient</span></td>
          <td><span class="bog">Tracked email</span></td>
        </tr>
      </tbody></table>
    </body>`,
    async fetchHandler(url) {
      if (String(url).endsWith("/api/emails")) {
        listRequests += 1;
        const track =
          listRequests >= 3
            ? { ...unopenedTrack, opened: true, openCount: 1 }
            : unopenedTrack;
        return { ok: true, json: async () => ({ emails: [track] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  window.eval(await source("src/mt-ui.js"));
  await tick(window);
  const mountedBadge = window.document.querySelector(".mt-status-badge");
  assert.equal(mountedBadge?.dataset.mtStatusLabel, "Not opened");

  window.dispatchEvent(new window.CustomEvent("mailtrack:mapped"));
  for (
    let attempt = 0;
    attempt < 10 && mountedBadge.dataset.mtStatusLabel !== "Opened";
    attempt += 1
  ) {
    await tick(window);
  }

  assert.equal(window.document.querySelector(".mt-status-badge"), mountedBadge);
  assert.equal(mountedBadge.dataset.mtStatusLabel, "Opened");
  assert.equal(listRequests >= 3, true);
  dom.window.close();
});

test("a Sent thread row follows the newest reply without changing the original status", async () => {
  const originalTrack = {
    id: "track-original",
    gmailThreadId: "19fc000000000125",
    gmailMessageId: "19fc100000000111",
    opened: true,
    openCount: 2,
  };
  const replyTrack = {
    id: "track-reply",
    gmailThreadId: "19fc000000000125",
    gmailMessageId: "19fc100000000222",
    opened: false,
    openCount: 0,
  };
  let listRequests = 0;
  const { dom, window } = await createWindow({
    cache: [replyTrack, originalTrack],
    html: `<!doctype html><body>
      <table><tbody>
        <tr class="zA" data-legacy-thread-id="19fc000000000125">
          <td class="WA">important</td>
          <td class="yX"><span class="yW">recipient</span></td>
          <td><span class="bog">Reply thread</span></td>
        </tr>
      </tbody></table>
    </body>`,
    async fetchHandler(url) {
      if (String(url).endsWith("/api/emails")) {
        listRequests += 1;
        const currentReply =
          listRequests >= 3 ? { ...replyTrack, opened: true, openCount: 1 } : replyTrack;
        return {
          ok: true,
          json: async () => ({ emails: [currentReply, originalTrack] }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  window.eval(await source("src/mt-ui.js"));
  await tick(window);
  const mountedBadge = window.document.querySelector(".mt-status-badge");
  assert.equal(mountedBadge?.dataset.mtStatusLabel, "Not opened");

  window.dispatchEvent(new window.CustomEvent("mailtrack:mapped"));
  for (
    let attempt = 0;
    attempt < 10 && mountedBadge.dataset.mtStatusLabel !== "Opened";
    attempt += 1
  ) {
    await tick(window);
  }

  assert.equal(window.document.querySelector(".mt-status-badge"), mountedBadge);
  assert.equal(mountedBadge.dataset.mtStatusLabel, "Opened");
  assert.equal(originalTrack.opened, true);
  assert.equal(originalTrack.openCount, 2);
  dom.window.close();
});

test("Gmail page observer finds exact sent IDs for XHR and fetch sends", async () => {
  let fetchRequest = null;
  let gmailResponse = "";
  const { dom, window } = await createWindow({
    html: "<!doctype html><body></body>",
    async fetchHandler(url, options = {}) {
      if (String(url).includes("/sync/")) {
        fetchRequest = { url: String(url), options };
        return {
          ok: true,
          clone: () => ({ text: async () => gmailResponse }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  const request = JSON.stringify({
    body: '<div>test</div><img src="https://backend.example.test/o/track_ABC-123.gif">',
  });
  const outgoingMessage = [];
  outgoingMessage[8] = [
    null,
    [[
      null,
      '<div dir="ltr">reply</div><blockquote class="gmail_quote"><img src="https://backend.example.test/o/track-original.gif"></blockquote>',
    ]],
  ];
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

  gmailResponse = JSON.stringify([0, [thread]]);
  class FakeXMLHttpRequest extends window.EventTarget {
    open() {}
    send(body) {
      this.requestBody = body;
      this.status = 200;
      this.responseText = gmailResponse;
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

  const sentDetails = [];
  window.addEventListener("mailtrack:gmail-send", (event) => {
    sentDetails.push(JSON.parse(event.detail));
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
  assert.deepEqual(sentDetails, [
    {
      trackingId: "track_ABC-123",
      threadId: "19fc000000000123",
      messageId: "19fc100000000123",
    },
  ]);

  window.dispatchEvent(
    new window.CustomEvent("mailtrack:prepare-send", {
      detail: JSON.stringify({
        trackingId: "track_FETCH-456",
        pixelUrl: "https://backend.example.test/o/track_FETCH-456.gif",
      }),
    })
  );
  await window.fetch("/sync/u/0/i/s?rt=r", {
    method: "POST",
    body: JSON.stringify(outgoingRequest),
  });
  await tick(window);
  assert.match(fetchRequest.options.body, /\/o\/track_FETCH-456\.gif/);
  assert.deepEqual(sentDetails[1], {
    trackingId: "track_FETCH-456",
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
  gmailResponse = JSON.stringify([0, []]);
  scheduledXhr.send(JSON.stringify(outgoingRequest));
  assert.equal(sentDetails.length, 2);

  const finalScheduledXhr = new window.XMLHttpRequest();
  finalScheduledXhr.open("POST", "/sync/u/0/i/s?rt=r");
  gmailResponse = JSON.stringify([0, [thread]]);
  finalScheduledXhr.send(JSON.stringify(outgoingRequest));
  assert.equal(sentDetails.length, 3);
  assert.equal(sentDetails[2].trackingId, "track_ABC-123");
  assert.equal(sentDetails[2].scheduled, true);
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

  assert.equal(row.querySelector(".mt-status-badge")?.dataset.mtStatusLabel, "Opened");
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
  assert.equal(rows[0].querySelector(".mt-status-badge")?.dataset.mtStatusLabel, "Not opened");
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
  assert.equal(row.querySelector(".mt-status-badge")?.dataset.mtStatusLabel, "Not opened");
  assert.equal(row.querySelector(".mt-status-badge")?.parentElement, cell);

  row.setAttribute("data-legacy-thread-id", "19fc00000000000a");
  await tick(window);
  assert.equal(row.querySelector(".mt-status-badge")?.dataset.mtStatusLabel, "Opened");
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

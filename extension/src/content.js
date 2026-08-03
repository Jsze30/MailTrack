// One-time compose preparation and race-free Gmail sending.

(() => {
  "use strict";

  const BODY_SELECTOR =
    '.Am, [aria-label="Message Body"], [g_editable="true"][role="textbox"], [contenteditable="true"][role="textbox"]';
  const GMAIL_COMPOSE_REGION = '[role="region"][data-compose-id]';
  const COMPOSE_SELECTOR = `${GMAIL_COMPOSE_REGION}, .M9, [role="dialog"], .nH.Hd, .ip`;
  const PIXEL_MARKER = "data-mailtrack-pixel";
  const BODY_MARKER = "data-mailtrack-id";
  const preparedComposes = new WeakSet();
  const deliveringComposes = new WeakSet();
  const mountedSchedulers = new WeakMap();
  const SCHEDULER_FIT_STYLE_ID = "mt-scheduler-fit";
  const schedulerFitRules = new Map();
  let googleStatusPromise = null;
  let googleStatusReadAt = 0;

  function synchronizeGmailDraft(body) {
    body.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
      })
    );
    body.dispatchEvent(new KeyboardEvent("keydown", { key: "Control" }));
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function composeFromTarget(target, sendButton = null) {
    if (!(target instanceof Element)) return null;
    let body = target.closest(BODY_SELECTOR);
    let commonRoot = null;

    if (!body) {
      for (let container = target; container && container !== document.body; container = container.parentElement) {
        body = container.querySelector(BODY_SELECTOR);
        if (body) {
          commonRoot = container;
          break;
        }
      }
    }
    if (!body) return null;

    const composeRoot =
      body.closest(GMAIL_COMPOSE_REGION) ||
      body.closest(".M9") ||
      body.closest('[role="dialog"]') ||
      body.closest(COMPOSE_SELECTOR);
    if (composeRoot && (!sendButton || composeRoot.contains(sendButton))) {
      return { root: composeRoot, body };
    }
    if (!commonRoot && sendButton) {
      commonRoot = body;
      while (commonRoot && !commonRoot.contains(sendButton)) {
        commonRoot = commonRoot.parentElement;
      }
    }
    return { root: commonRoot || body.parentElement || body, body };
  }

  function ensurePixel(body, id, baseUrl) {
    let pixel = body.querySelector(`img[${PIXEL_MARKER}="${id}"]`);
    if (pixel) return pixel;

    pixel = document.createElement("img");
    pixel.setAttribute(PIXEL_MARKER, id);
    pixel.setAttribute("src", `${baseUrl}/o/${id}.gif`);
    pixel.setAttribute("alt", "");
    pixel.setAttribute("width", "0");
    pixel.setAttribute("height", "0");
    pixel.className = "mailtrack-img";
    pixel.style.display = "flex";
    const quotedReply = body.querySelector(".gmail_quote");
    body.insertBefore(pixel, quotedReply || null);
    return pixel;
  }

  function emailAddresses(value) {
    return [...String(value || "").matchAll(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)]
      .map((match) => match[0].toLocaleLowerCase());
  }

  function recipientsFrom(composeRoot, name) {
    const addresses = [];
    // Gmail's recipient field is a peoplekit widget: a div[name="to"] holding committed chips
    // ([email]/[data-hovercard-id]) plus a nested combobox input carrying any address the user
    // typed but hasn't turned into a chip yet. Simpler layouts use a plain input[name="to"].
    for (const field of composeRoot.querySelectorAll(`[name="${name}"]`)) {
      if (typeof field.value === "string") addresses.push(...emailAddresses(field.value));
      if (typeof field.querySelectorAll !== "function") continue;
      for (const chip of field.querySelectorAll("[email], [data-hovercard-id]")) {
        addresses.push(
          ...emailAddresses(chip.getAttribute("email") || chip.getAttribute("data-hovercard-id"))
        );
      }
      for (const typed of field.querySelectorAll('input[type="text"]')) {
        addresses.push(...emailAddresses(typed.value));
      }
    }
    for (const chip of composeRoot.querySelectorAll(`[data-recipient-type="${name}"] [email]`)) {
      addresses.push(...emailAddresses(chip.getAttribute("email")));
    }
    return [...new Set(addresses)];
  }

  function hasAttachments(composeRoot) {
    if ([...composeRoot.querySelectorAll('input[type="file"]')].some((input) => input.files?.length)) {
      return true;
    }
    return Boolean(composeRoot.querySelector("[data-attachment-id], .dL[download_url], .vI[download_url]"));
  }

  function googleStatus() {
    if (!googleStatusPromise || Date.now() - googleStatusReadAt > 30_000) {
      googleStatusReadAt = Date.now();
      googleStatusPromise = window.MT.api.googleStatus().catch(() => ({ connected: false }));
    }
    return googleStatusPromise;
  }

  function schedulerAnchor(compose) {
    const sendButton = [...compose.root.querySelectorAll('[role="button"][data-tooltip]')].find(
      (button) => /^send\b/i.test(button.getAttribute("data-tooltip") || "") &&
        !/schedule/i.test(button.getAttribute("data-tooltip") || "")
    );
    if (!sendButton) return null;

    // Gmail's native send controls (Send button, formatting, attach, discard) live in a
    // table.IZ (row tr.btC) inside the .aDh send-controls wrapper. Mirror Boomerang: append
    // our bar as the last child of .aDh, immediately after that table - never inside the
    // toolbar itself.
    const toolbarRow = sendButton.closest(".btC");
    const toolbarTable = toolbarRow ? toolbarRow.closest("table") : null;
    const controls = sendButton.closest(".aDh") || (toolbarTable && toolbarTable.parentElement);
    if (!controls || !compose.root.contains(controls)) return null;
    return {
      controls,
      toolbarTable: toolbarTable && controls.contains(toolbarTable) ? toolbarTable : null,
      sendButton,
    };
  }

  // Make our button match Gmail's native Send button: same left edge, same width, same colour.
  // Gmail's toolbar insets and theme colour vary by version, so measure the live element rather
  // than hard-coding anything. The width comes from the whole Send split-button (.dC, i.e. Send
  // plus its dropdown) so "Send later" always fits; the colour is copied so both stay in sync.
  function matchSchedulerButtonToSend(button, sendButton) {
    if (!sendButton) return;
    window.requestAnimationFrame(() => {
      if (!button.isConnected || !sendButton.isConnected) return;
      const pill = sendButton.closest(".dC") || sendButton;
      const sendRect = sendButton.getBoundingClientRect();
      const pillRect = pill.getBoundingClientRect();

      const delta = sendRect.left - button.getBoundingClientRect().left;
      if (Number.isFinite(delta) && Math.abs(delta) >= 1) {
        const current = parseFloat(button.style.marginLeft) || 0;
        button.style.setProperty("margin-left", `${current + delta}px`, "important");
      }
      if (pillRect.width >= 1) {
        button.style.setProperty("min-width", `${Math.round(pillRect.width)}px`, "important");
      }
      const background = window.getComputedStyle(sendButton).backgroundColor;
      if (background && background !== "transparent" && !/rgba\(0, 0, 0, 0\)/.test(background)) {
        button.style.setProperty("--mt-send-bg", background);
      }
    });
  }

  function schedulerFitSheet() {
    let style = document.getElementById(SCHEDULER_FIT_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = SCHEDULER_FIT_STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    return style;
  }

  // Gmail clamps the docked send panel (.aDj) and its in-flow spacer (.aDg) to the height of
  // its own controls, so an injected row overflows below the fold. Give those two plus the
  // compose region (.aoI) room for the row's height - the end state Boomerang produces
  // (panel 116->170, region 576->630). The panel is bottom-anchored, so the window extends
  // upward and every native control keeps its position. The growth goes in an injected
  // stylesheet, not inline styles: Gmail rewrites these elements' inline style attribute on
  // re-layout (wiping any min-height we set there), but it can't touch our stylesheet, and a
  // min-height rule floors the height whatever Gmail writes inline - no observer or polling.
  function fitComposeForScheduler(compose, row) {
    const composeId = compose.root.getAttribute("data-compose-id");
    if (!composeId) return;
    window.requestAnimationFrame(() => {
      if (!row.isConnected) return;
      const delta = Math.ceil(row.getBoundingClientRect().height);
      if (delta <= 0) return;
      const scope = `[data-compose-id="${composeId}"]`;
      const rules = [];
      const addRule = (selector, element) => {
        if (!element) return;
        // Prefer Gmail's declared inline height as the base, but fall back to the live rendered
        // height: Gmail doesn't always set an inline height on the region, and without a base the
        // region wouldn't grow and the row would clip below the fold.
        let base = parseInt(element.style.height, 10);
        if (!Number.isFinite(base)) base = Math.round(element.getBoundingClientRect().height);
        if (base > 0) rules.push(`${selector}{min-height:${base + delta}px !important}`);
      };
      addRule(scope, compose.root);
      addRule(`${scope} .aDg`, row.closest(".aDg"));
      addRule(`${scope} .aDj`, row.closest(".aDj"));
      if (!rules.length) return;
      schedulerFitRules.set(composeId, rules.join(""));
      schedulerFitSheet().textContent = [...schedulerFitRules.values()].join("");
    });
  }

  function mountSendLater(compose) {
    const mountedScheduler = mountedSchedulers.get(compose.root);
    if (mountedScheduler?.isConnected) return;
    if (mountedScheduler) mountedSchedulers.delete(compose.root);
    if (!compose.root.querySelector('input[name="subjectbox"]')) return;
    const anchor = schedulerAnchor(compose);
    if (!anchor) return;
    const { controls, toolbarTable } = anchor;

    const row = document.createElement("div");
    row.className = "mt-send-later-row";
    row.innerHTML =
      '<div class="mt-send-later-controls">' +
      '<button type="button" class="mt-send-later-button" disabled>Send later</button>' +
      '<input type="text" class="mt-send-later-input" placeholder="Tue 11am" aria-label="Send later time">' +
      "</div>" +
      '<div class="mt-send-later-preview" aria-live="polite"></div>';
    if (toolbarTable) toolbarTable.insertAdjacentElement("afterend", row);
    else controls.appendChild(row);
    mountedSchedulers.set(compose.root, row);
    fitComposeForScheduler(compose, row);

    const input = row.querySelector(".mt-send-later-input");
    const button = row.querySelector(".mt-send-later-button");
    const preview = row.querySelector(".mt-send-later-preview");
    matchSchedulerButtonToSend(button, anchor.sendButton);
    let connected = false;
    let busy = false;
    let parsed = window.MTScheduleTime.parse("");

    const render = () => {
      parsed = window.MTScheduleTime.parse(input.value);
      button.disabled = busy || !connected || !parsed.valid;
      if (!connected) {
        preview.textContent = "Connect Gmail in MailTrack settings";
        preview.className = "mt-send-later-preview mt-send-later-error";
      } else if (parsed.valid) {
        preview.textContent = parsed.label;
        preview.className = "mt-send-later-preview mt-send-later-valid";
      } else {
        preview.textContent = input.value.trim() ? parsed.error : "";
        preview.className = "mt-send-later-preview mt-send-later-error";
      }
    };

    input.addEventListener("input", render);
    googleStatus().then((status) => {
      connected = status.connected === true;
      render();
    });

    button.addEventListener("click", async () => {
      render();
      if (button.disabled || !parsed.valid) return;
      if (hasAttachments(compose.root)) {
        preview.textContent = "Attachments are not supported yet";
        preview.className = "mt-send-later-preview mt-send-later-error";
        return;
      }
      const recipients = recipientsFrom(compose.root, "to");
      if (!recipients.length) {
        preview.textContent = "Add at least one recipient";
        preview.className = "mt-send-later-preview mt-send-later-error";
        return;
      }

      busy = true;
      button.disabled = true;
      input.disabled = true;
      preview.textContent = "Scheduling…";
      preview.className = "mt-send-later-preview";
      try {
        const trackingId = compose.body.getAttribute(BODY_MARKER);
        const subject = compose.root.querySelector('input[name="subjectbox"]')?.value || "";
        await window.MT.api.scheduleEmail({
          trackingId,
          recipients,
          cc: recipientsFrom(compose.root, "cc"),
          bcc: recipientsFrom(compose.root, "bcc"),
          subject,
          bodyText: compose.body.innerText || compose.body.textContent || "",
          bodyHtml: compose.body.innerHTML,
          sendAt: parsed.date.toISOString(),
          localMinute: parsed.date.getMinutes(),
        });
        preview.textContent = `Scheduled for ${parsed.label}`;
        preview.className = "mt-send-later-preview mt-send-later-valid";
        const discard = [...compose.root.querySelectorAll('[data-tooltip], [aria-label]')].find(
          (element) => /discard draft/i.test(
            element.getAttribute("data-tooltip") || element.getAttribute("aria-label") || ""
          )
        );
        discard?.click();
      } catch (error) {
        busy = false;
        input.disabled = false;
        button.disabled = !connected || !parsed.valid;
        preview.textContent = error.message || "Could not schedule email";
        preview.className = "mt-send-later-preview mt-send-later-error";
      }
    });
  }

  function prepareCompose(compose) {
    if (!compose) return;
    if (!window.MT.isConfigured() || !window.MT.isTrackingEnabled()) return;

    const id =
      compose.body.getAttribute(BODY_MARKER) ||
      compose.root.getAttribute(BODY_MARKER) ||
      window.MT.generateId();
    compose.root.setAttribute(BODY_MARKER, id);
    compose.body.setAttribute(BODY_MARKER, id);
    mountSendLater(compose);
    if (preparedComposes.has(compose.root)) return;

    preparedComposes.add(compose.root);
    window.MT.api.registerTrack(id).catch((error) => {
      console.warn("[MailTrack] track registration failed", error);
    });
  }

  function prepareFromTarget(target) {
    const compose = composeFromTarget(target);
    if (compose) prepareCompose(compose);
  }

  function prepareAllComposes() {
    for (const body of document.querySelectorAll(BODY_SELECTOR)) {
      const compose = composeFromTarget(body);
      if (compose) prepareCompose(compose);
    }
  }

  async function handleDelivery(target, actionButton, { originButton = null, scheduled = false } = {}) {
    const composeTarget = originButton?.isConnected ? originButton : target;
    const composeButton = originButton?.isConnected ? originButton : actionButton;
    const compose = composeFromTarget(composeTarget, composeButton);
    if (!compose) {
      window.MTGate.resume(actionButton);
      return;
    }
    if (deliveringComposes.has(compose.root)) return;
    deliveringComposes.add(compose.root);
    try {
      await window.MT.ready;
      prepareCompose(compose);
      const id = compose.body.getAttribute(BODY_MARKER);
      if (!id) return;
      const sentAt = new Date().toISOString();
      const pendingSave = window.MT.pendingTracks
        .add({ id, sentAt, scheduled })
        .catch(() => {});
      const registration = window.MT.api.registerTrack(id).catch(() => {});
      ensurePixel(compose.body, id, window.MT.getConfig().baseUrl);
      await Promise.all([pendingSave, registration, synchronizeGmailDraft(compose.body)]);
      window.dispatchEvent(
        new CustomEvent("mailtrack:prepare-send", {
          detail: JSON.stringify({
            trackingId: id,
            pixelUrl: `${window.MT.getConfig().baseUrl}/o/${id}.gif`,
            scheduled,
          }),
        })
      );
    } finally {
      deliveringComposes.delete(compose.root);
      window.MTGate.resume(actionButton);
    }
  }

  document.addEventListener(
    "focusin",
    (event) => {
      window.MT.ready.then(() => {
        const compose = composeFromTarget(event.target);
        if (compose) prepareCompose(compose);
        else prepareAllComposes();
      });
    },
    true
  );

  window.MTGate.onSend((target, sendButton) => {
    handleDelivery(target, sendButton).catch((error) => {
      console.warn("[MailTrack] send preparation failed", error);
    });
  });

  async function mapExactTrack(trackingId, threadId, messageId, scheduled = false) {
    const sentAt = new Date().toISOString();
    const pending = {
      id: trackingId,
      sentAt,
      scheduled,
      mapping: { threadId, messageId },
    };
    await window.MT.pendingTracks.add(pending);
    await window.MT.api.mapGmailThread(trackingId, {
      ...pending.mapping,
      sentAt,
      scheduled,
    });
    await window.MT.pendingTracks.remove(trackingId);
    window.dispatchEvent(new CustomEvent("mailtrack:mapped"));
  }

  window.addEventListener("mailtrack:gmail-send", (event) => {
    let mapping;
    try {
      mapping = JSON.parse(event.detail);
    } catch {
      return;
    }
    const { trackingId, threadId, messageId, scheduled = false } = mapping || {};
    if (!trackingId || !threadId) return;
    mapExactTrack(trackingId, threadId, messageId, scheduled)
      .catch((error) => console.warn("[MailTrack] exact Gmail mapping failed", error));
  });

  window.MT.ready.then(async () => {
    prepareAllComposes();
    const pending = await window.MT.pendingTracks.read();
    for (const track of pending) {
      if (!track.mapping?.threadId) continue;
      mapExactTrack(
        track.id,
        track.mapping.threadId,
        track.mapping.messageId,
        track.scheduled === true
      ).catch(() => {});
    }
  });
  window.MT.compose = { prepare: prepareFromTarget };
  console.log(`[MailTrack ${window.MT.version}] pixel integration loaded`);
})();

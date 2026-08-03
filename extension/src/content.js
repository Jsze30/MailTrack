// One-time compose preparation and race-free Gmail sending.

(() => {
  "use strict";

  const BODY_SELECTOR =
    '.Am, [aria-label="Message Body"], [g_editable="true"][role="textbox"], [contenteditable="true"][role="textbox"]';
  const COMPOSE_SELECTOR = '[role="dialog"], .M9, .nH.Hd, .ip';
  const PIXEL_MARKER = "data-mailtrack-pixel";
  const BODY_MARKER = "data-mailtrack-id";
  const preparedComposes = new WeakSet();
  const sendingComposes = new WeakSet();
  const schedulingComposes = new WeakSet();

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

    const composeRoot = body.closest(COMPOSE_SELECTOR);
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

  function prepareCompose(compose) {
    if (!compose) return;
    if (!window.MT.isConfigured() || !window.MT.isTrackingEnabled()) return;

    const id =
      compose.body.getAttribute(BODY_MARKER) ||
      compose.root.getAttribute(BODY_MARKER) ||
      window.MT.generateId();
    compose.root.setAttribute(BODY_MARKER, id);
    compose.body.setAttribute(BODY_MARKER, id);
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

  async function handleSend(target, sendButton) {
    const compose = composeFromTarget(target, sendButton);
    if (!compose) {
      window.MTGate.resume(sendButton);
      return;
    }
    if (sendingComposes.has(compose.root)) return;
    sendingComposes.add(compose.root);
    try {
      await window.MT.ready;
      prepareCompose(compose);
      const id = compose.body.getAttribute(BODY_MARKER);
      if (!id) return;
      const sentAt = new Date().toISOString();
      const pendingSave = window.MT.pendingTracks.add({ id, sentAt }).catch(() => {});
      const registration = window.MT.api.registerTrack(id).catch(() => {});
      ensurePixel(compose.body, id, window.MT.getConfig().baseUrl);
      await Promise.all([pendingSave, registration, synchronizeGmailDraft(compose.body)]);
      window.dispatchEvent(
        new CustomEvent("mailtrack:prepare-send", {
          detail: JSON.stringify({
            trackingId: id,
            pixelUrl: `${window.MT.getConfig().baseUrl}/o/${id}.gif`,
            scheduled: false,
          }),
        })
      );
    } finally {
      sendingComposes.delete(compose.root);
      window.MTGate.resume(sendButton);
    }
  }

  document.addEventListener(
    "focusin",
    (event) => {
      window.MT.ready.then(() => prepareFromTarget(event.target));
    },
    true
  );

  window.MTGate.onSend((target, sendButton) => {
    handleSend(target, sendButton).catch((error) => {
      console.warn("[MailTrack] send preparation failed", error);
    });
  });

  async function handleSchedule(target, scheduleButton, originButton) {
    const composeTarget = originButton?.isConnected ? originButton : target;
    const composeButton = originButton?.isConnected ? originButton : scheduleButton;
    const compose = composeFromTarget(composeTarget, composeButton);
    if (!compose) {
      window.MTGate.resume(scheduleButton);
      return;
    }
    if (schedulingComposes.has(compose.root)) return;
    schedulingComposes.add(compose.root);
    try {
      await window.MT.ready;
      prepareCompose(compose);
      const id = compose.body.getAttribute(BODY_MARKER);
      if (!id) return;
      const sentAt = new Date().toISOString();
      const pendingSave = window.MT.pendingTracks.add({ id, sentAt, scheduled: true }).catch(() => {});
      const registration = window.MT.api.registerTrack(id).catch(() => {});
      ensurePixel(compose.body, id, window.MT.getConfig().baseUrl);
      await Promise.all([pendingSave, registration, synchronizeGmailDraft(compose.body)]);
      window.dispatchEvent(
        new CustomEvent("mailtrack:prepare-send", {
          detail: JSON.stringify({
            trackingId: id,
            pixelUrl: `${window.MT.getConfig().baseUrl}/o/${id}.gif`,
            scheduled: true,
          }),
        })
      );
    } finally {
      schedulingComposes.delete(compose.root);
      window.MTGate.resume(scheduleButton);
    }
  }

  window.MTGate.onSchedule((target, scheduleButton, originButton) => {
    handleSchedule(target, scheduleButton, originButton).catch((error) => {
      console.warn("[MailTrack] schedule preparation failed", error);
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
    prepareFromTarget(document.activeElement);
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

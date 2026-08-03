// Page-context Gmail send observer.
//
// Gmail's send response contains the exact stable message and thread IDs. This
// script must run in the MAIN world so it can observe Gmail's XMLHttpRequests.

(() => {
  "use strict";

  const SEND_URL = /\/sync\/(?:u\/\d+\/)?i\/s(?:[/?#]|$)/i;
  const TRACKING_URL = /\/o\/([A-Za-z0-9_-]+)\.gif(?:[?"'\\]|$)/g;
  const LEGACY_ID = /^[0-9a-f]{16}$/i;
  const MESSAGE_ID = /^msg-a:/;
  const requestMetadata = new WeakMap();
  let pendingPixel = null;

  function injectPixel(body, pixel) {
    if (typeof body !== "string" || !pixel?.trackingId || !pixel?.pixelUrl) return body;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return body;
    }

    let inserted = false;
    const operations = parsed?.[1]?.[0];
    if (!Array.isArray(operations)) return body;
    for (const operation of operations) {
      const messageData = operation?.[1]?.[1]?.[13] || operation?.[1]?.[1]?.[1];
      const htmlContainer = messageData?.[0]?.[8]?.[1]?.[0];
      if (!Array.isArray(htmlContainer) || typeof htmlContainer[1] !== "string") continue;
      if (!htmlContainer[1].includes(pixel.pixelUrl)) {
        htmlContainer[1] += `<img width="0" height="0" class="mailtrack-img" alt="" style="display:flex" src="${pixel.pixelUrl}">`;
      }
      inserted = true;
    }
    return inserted ? JSON.stringify(parsed) : body;
  }

  function trackingIdsFrom(body) {
    if (typeof body !== "string") return [];
    const normalized = body.replace(/\\\//g, "/").replace(/\\u002f/gi, "/");
    return [...normalized.matchAll(TRACKING_URL)].map((match) => match[1]);
  }

  function legacyMessageId(message) {
    if (!Array.isArray(message)) return null;
    if (LEGACY_ID.test(message[55])) return message[55].toLocaleLowerCase();
    if (Array.isArray(message[1]) && LEGACY_ID.test(message[1][34])) {
      return message[1][34].toLocaleLowerCase();
    }
    return null;
  }

  function findMessage(node) {
    if (!Array.isArray(node)) return null;
    if (MESSAGE_ID.test(node[0]) && legacyMessageId(node)) return node;
    for (const child of node) {
      const match = findMessage(child);
      if (match) return match;
    }
    return null;
  }

  function findMapping(node) {
    if (!Array.isArray(node)) return null;
    if (LEGACY_ID.test(node[19])) {
      const message = findMessage(node);
      const messageId = legacyMessageId(message);
      if (messageId) {
        return {
          threadId: node[19].toLocaleLowerCase(),
          messageId,
        };
      }
    }
    for (const child of node) {
      const mapping = findMapping(child);
      if (mapping) return mapping;
    }
    return null;
  }

  function publish(trackingIds, response, scheduled) {
    let parsed;
    try {
      parsed = JSON.parse(response);
    } catch {
      return;
    }
    const mapping = findMapping(parsed);
    if (!mapping) return;
    for (const trackingId of trackingIds) {
      window.dispatchEvent(
        new CustomEvent("mailtrack:gmail-send", {
          detail: JSON.stringify({
            trackingId,
            ...mapping,
            ...(typeof scheduled === "boolean" ? { scheduled } : {}),
          }),
        })
      );
    }
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    requestMetadata.set(this, { isSend: SEND_URL.test(String(url)), trackingIds: [] });
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const metadata = requestMetadata.get(this);
    if (metadata?.isSend) {
      const scheduled = pendingPixel?.scheduled;
      const outgoingBody = injectPixel(body, pendingPixel);
      metadata.trackingIds = trackingIdsFrom(outgoingBody);
      if (metadata.trackingIds.length) {
        pendingPixel = null;
        this.addEventListener(
          "load",
          () => {
            if (this.status >= 200 && this.status < 300) {
              publish(metadata.trackingIds, this.responseText || this.response, scheduled);
            }
          },
          { once: true }
        );
      }
      return originalSend.call(this, outgoingBody);
    }
    return originalSend.apply(this, arguments);
  };

  window.addEventListener("mailtrack:prepare-send", (event) => {
    try {
      pendingPixel = JSON.parse(event.detail);
    } catch {
      pendingPixel = null;
    }
  });

  window.MailTrackGmailPage = { trackingIdsFrom, injectPixel, findMapping };
})();

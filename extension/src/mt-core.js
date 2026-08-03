// Shared configuration and backend calls.

window.MT = (() => {
  "use strict";

  const MT = {};
  const STATUS_CACHE_KEY = "mtStatusCacheV2";
  const PENDING_KEY = "mtPendingTracksV2";
  let config = null;
  let trackingEnabled = true;

  function normalize(baseUrl, secret) {
    if (!baseUrl || !secret) return null;
    return { baseUrl: String(baseUrl).replace(/\/+$/, ""), secret: String(secret) };
  }

  async function loadConfig() {
    const stored = await chrome.storage.sync.get(["baseUrl", "secret", "trackDefault"]);
    config = normalize(stored.baseUrl, stored.secret);
    trackingEnabled = stored.trackDefault !== false;
    return config;
  }

  MT.ready = loadConfig().catch((error) => {
    console.warn("[MailTrack] configuration unavailable", error);
    return null;
  });
  MT.getConfig = () => config;
  MT.isConfigured = () => Boolean(config);
  MT.isTrackingEnabled = () => trackingEnabled;

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.baseUrl || changes.secret || changes.trackDefault) loadConfig().catch(() => {});
  });

  async function apiFetch(path, options = {}) {
    if (!config) throw new Error("MailTrack is not configured");
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...options,
      cache: "no-store",
      headers: {
        "x-track-secret": config.secret,
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `MailTrack backend returned ${response.status}`);
    }
    return payload;
  }

  MT.api = {
    registerTrack(id) {
      return apiFetch("/api/emails", {
        method: "POST",
        body: JSON.stringify({ id }),
        keepalive: true,
      });
    },
    listTracks() {
      return apiFetch("/api/emails").then((result) => result.emails || []);
    },
    mapGmailThread(id, { threadId, messageId, sentAt = null, scheduled = null }) {
      return apiFetch(`/api/emails/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          gmailThreadId: threadId,
          gmailMessageId: messageId || null,
          ...(sentAt ? { sentAt } : {}),
          ...(typeof scheduled === "boolean" ? { scheduled } : {}),
        }),
      });
    },
    selfView(id, { phase = null, viewedAt = null } = {}) {
      return apiFetch(`/api/emails/${encodeURIComponent(id)}/selfview`, {
        method: "POST",
        body: JSON.stringify({ phase, viewedAt }),
      });
    },
    googleStatus() {
      return apiFetch("/api/oauth/google/status");
    },
    scheduleEmail(email) {
      return apiFetch("/api/scheduled-emails", {
        method: "POST",
        body: JSON.stringify(email),
      });
    },
    listScheduledEmails() {
      return apiFetch("/api/scheduled-emails").then((result) => result.emails || []);
    },
    cancelScheduledEmail(id) {
      return apiFetch(`/api/scheduled-emails/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    },
  };

  MT.statusCache = {
    async read() {
      const stored = await chrome.storage.local.get(STATUS_CACHE_KEY);
      return Array.isArray(stored[STATUS_CACHE_KEY]) ? stored[STATUS_CACHE_KEY] : [];
    },
    async write(tracks) {
      await chrome.storage.local.set({ [STATUS_CACHE_KEY]: tracks });
    },
  };

  MT.pendingTracks = {
    async read() {
      const stored = await chrome.storage.local.get(PENDING_KEY);
      const cutoff = Date.now() - 60 * 60 * 1000;
      return (Array.isArray(stored[PENDING_KEY]) ? stored[PENDING_KEY] : []).filter(
        (track) => new Date(track.sentAt).getTime() >= cutoff
      );
    },
    async add(track) {
      const rows = (await this.read()).filter((item) => item.id !== track.id);
      rows.push(track);
      await chrome.storage.local.set({ [PENDING_KEY]: rows });
    },
    async remove(id) {
      const rows = (await this.read()).filter((item) => item.id !== id);
      await chrome.storage.local.set({ [PENDING_KEY]: rows });
    },
  };

  MT.generateId = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  };

  MT.version = chrome.runtime.getManifest().version;
  return MT;
})();

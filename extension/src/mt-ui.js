// Passive status indicators for Sent rows and each tracked outbound message.

(() => {
  "use strict";

  const ROW_SELECTOR = "tr.zA";
  const THREAD_ID_SELECTOR =
    "[data-legacy-thread-id], [data-thread-id], [data-thread-perm-id]";
  const MESSAGE_SELECTOR = ".adn, .gs";
  const RETRY_DELAYS = [0, 100, 300, 800, 1500, 3000];
  const STATUS_REFRESH_DELAYS = [750, 2000];
  const POST_SEND_REFRESH_MS = 3000;
  const POST_SEND_REFRESH_LIMIT = 40;
  const OPENED_CONFIRMATION_POLLS = 4;
  const SELF_VIEW_SETTLE_MS = 500;
  const SELF_VIEW_MIN_WINDOW_MS = 5000;
  const SELF_VIEW_PIXEL_TIMEOUT_MS = 5000;
  const PAGE_STARTED_AT = new Date(performance.timeOrigin || Date.now()).toISOString();
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const CLOSED_ENVELOPE =
    '<rect width="256" height="256" fill="none"/>' +
    '<polyline points="224 56 128 144 32 56" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/>' +
    '<path d="M32,56H224a0,0,0,0,1,0,0V192a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V56A0,0,0,0,1,32,56Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/>' +
    '<line x1="110.55" y1="128" x2="34.47" y2="197.74" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/>' +
    '<line x1="221.53" y1="197.74" x2="145.45" y2="128" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/>';
  const OPEN_ENVELOPE =
    '<rect width="256" height="256" fill="none"/>' +
    '<path d="M32,96V200a8,8,0,0,0,8,8H216a8,8,0,0,0,8-8V96L128,32Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/>' +
    '<line x1="110.55" y1="152" x2="34.47" y2="205.74" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/>' +
    '<line x1="221.53" y1="205.74" x2="145.45" y2="152" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/>' +
    '<polyline points="224 96 145.46 152 110.55 152 32 96" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/>';
  const TRACKED_EYE =
    '<rect width="256" height="256" fill="none"/>' +
    '<path d="M128,56C48,56,16,128,16,128s32,72,112,72,112-72,112-72S208,56,128,56Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/>' +
    '<circle cx="128" cy="128" r="40" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/>';

  let tracks = [];
  let byId = new Map();
  let byThread = new Map();
  let tracksByThread = new Map();
  let byMessage = new Map();
  let listObserver = null;
  let listRoot = null;
  let messageIndicators = new Map();
  let routeGeneration = 0;
  let retryTimers = [];
  let statusRefreshTimers = [];
  let postSendRefreshTimer = null;
  let postSendRefreshGeneration = 0;
  let selfViewStates = new Map();
  let selfViewRouteKey = null;
  let selfViewRouteStartedAt = PAGE_STARTED_AT;
  let initialRouteHandled = false;
  let mappedThreadIds = new Set();
  let refreshPromise = null;

  function isSentRoute() {
    return /^#sent(?:\/|$)/i.test(location.hash);
  }

  function isScheduledRoute() {
    return /^#scheduled(?:\/|$)/i.test(location.hash);
  }

  function isTrackedListRoute() {
    return isSentRoute() || isScheduledRoute();
  }

  function sentThreadIdFromRoute() {
    const match = location.hash.match(/^#sent\/([^/?]+)/i);
    if (!match) return null;
    try {
      return normalizeThreadId(decodeURIComponent(match[1]));
    } catch {
      return normalizeThreadId(match[1]);
    }
  }

  function normalizeThreadId(value) {
    if (!value) return null;
    const raw = String(value).trim();
    const prefixed = raw.match(/^#?thread-[a-z]:([0-9a-f]+)$/i);
    if (prefixed) {
      const payload = prefixed[1];
      if (/^[0-9]+$/.test(payload)) {
        try {
          return BigInt(payload).toString(16);
        } catch {
          return null;
        }
      }
      return payload.toLocaleLowerCase();
    }
    return /^[0-9a-f]{8,32}$/i.test(raw) ? raw.toLocaleLowerCase() : null;
  }

  function indexTracks(rows) {
    tracks = Array.isArray(rows) ? rows : [];
    byId = new Map(tracks.map((track) => [track.id, track]));
    byThread = new Map();
    tracksByThread = new Map();
    byMessage = new Map();
    for (const track of tracks) {
      const threadId = normalizeThreadId(track.gmailThreadId);
      const messageId = normalizeThreadId(track.gmailMessageId);
      if (threadId && !byThread.has(threadId)) byThread.set(threadId, track);
      if (threadId) {
        const threadTracks = tracksByThread.get(threadId) || [];
        threadTracks.push(track);
        tracksByThread.set(threadId, threadTracks);
      }
      if (messageId && !byMessage.has(messageId)) byMessage.set(messageId, track);
    }
  }

  async function refreshTracks() {
    if (!window.MT.isConfigured()) return tracks;
    if (refreshPromise) return refreshPromise;
    refreshPromise = window.MT.api
      .listTracks()
      .then((rows) => {
        indexTracks(rows);
        window.MT.statusCache.write(rows).catch(() => {});
        renderVisibleState();
        return rows;
      })
      .catch((error) => {
        console.warn("[MailTrack] status refresh failed", error);
        return tracks;
      })
      .finally(() => {
        refreshPromise = null;
      });
    return refreshPromise;
  }

  function threadIdFrom(element) {
    if (!(element instanceof Element)) return null;
    const sources = [];
    if (element.matches(THREAD_ID_SELECTOR)) sources.push(element);
    sources.push(...element.querySelectorAll(THREAD_ID_SELECTOR));
    const ancestor = element.closest(THREAD_ID_SELECTOR);
    if (ancestor && !sources.includes(ancestor)) sources.push(ancestor);

    for (const source of sources) {
      for (const attribute of [
        "data-legacy-thread-id",
        "data-thread-perm-id",
        "data-thread-id",
      ]) {
        const threadId = normalizeThreadId(source.getAttribute(attribute));
        if (threadId) return threadId;
      }
    }
    return null;
  }

  function statusLabelFor(track) {
    if (!track.opened) return "Not opened";
    return track.openCount > 1 ? `Opened ${track.openCount} times` : "Opened";
  }

  function renderStatusContent(indicator, track, scheduled = false) {
    const scheduledRow = scheduled && indicator.classList.contains("mt-status-badge");
    if (scheduled && !scheduledRow) {
      indicator.textContent = "Email tracked";
      return;
    }
    const icon = document.createElementNS(SVG_NAMESPACE, "svg");
    icon.setAttribute("class", "mt-status-icon");
    icon.setAttribute("viewBox", "0 0 256 256");
    icon.setAttribute("aria-hidden", "true");
    icon.dataset.mtIcon = scheduledRow ? "tracked" : track.opened ? "opened" : "unopened";
    icon.innerHTML = scheduledRow
      ? TRACKED_EYE
      : track.opened
        ? OPEN_ENVELOPE
        : CLOSED_ENVELOPE;
    indicator.replaceChildren(icon);
    if (!scheduled && track.opened && track.openCount > 1) {
      const count = document.createElement("span");
      count.className = "mt-status-count";
      count.textContent = `${track.openCount}x`;
      indicator.appendChild(count);
    }
  }

  function removeRowSpacer(row) {
    row.querySelector(":scope .mt-status-spacer")?.remove();
  }

  function syncRowSpacer(row, badge, importanceCell, recipientCell) {
    if (!importanceCell || !recipientCell) {
      removeRowSpacer(row);
      return;
    }
    const recipientBounds = recipientCell.getBoundingClientRect();
    const badgeBounds = badge.getBoundingClientRect();
    const recipientPadding = Number.parseFloat(getComputedStyle(recipientCell).paddingLeft) || 0;
    const overlap = Math.ceil(badgeBounds.right - (recipientBounds.left + recipientPadding));
    const width = overlap > 0 ? overlap + 6 : 0;
    let spacer = recipientCell.querySelector(":scope > .mt-status-spacer");
    if (width <= 0) {
      spacer?.remove();
      return;
    }
    if (!spacer) {
      spacer = document.createElement("span");
      spacer.className = "mt-status-spacer";
      spacer.setAttribute("aria-hidden", "true");
      recipientCell.insertBefore(spacer, recipientCell.firstChild);
    }
    const nextWidth = `${width}px`;
    if (spacer.style.width !== nextWidth) spacer.style.width = nextWidth;
  }

  function renderRow(row) {
    const threadId = threadIdFrom(row);
    const track = byThread.get(threadId);
    const existing = row.querySelector(":scope .mt-status-badge");
    if (!track) {
      existing?.remove();
      removeRowSpacer(row);
      row.querySelector("td.mt-status-cell")?.classList.remove("mt-status-cell");
      return;
    }

    const importanceCell = row.querySelector("td.WA");
    const recipientCell = row.querySelector("td.yX");
    const cell = importanceCell || recipientCell;
    if (!cell) return;
    const scheduled = isScheduledRoute();
    const signature = scheduled
      ? `${track.id}|scheduled`
      : `${track.id}|${track.opened}|${track.openCount}`;
    const mountedCorrectly =
      existing?.parentElement === cell &&
      (!importanceCell ||
        (importanceCell.classList.contains("mt-status-cell") &&
          existing.classList.contains("mt-after-importance")));
    if (existing?.dataset.mtSignature === signature && mountedCorrectly) {
      syncRowSpacer(row, existing, importanceCell, recipientCell);
      return;
    }
    const badge = existing || document.createElement("span");
    badge.className = scheduled
      ? "mt-status-badge mt-scheduled"
      : `mt-status-badge ${track.opened ? "mt-opened" : "mt-unopened"}`;
    if (importanceCell) {
      importanceCell.classList.add("mt-status-cell");
      badge.classList.add("mt-after-importance");
    }
    badge.dataset.mtSignature = signature;
    badge.setAttribute("aria-hidden", "true");
    badge.dataset.mtStatusLabel = scheduled ? "Email tracked" : statusLabelFor(track);
    renderStatusContent(badge, track, scheduled);
    if (badge.parentElement !== cell) {
      if (importanceCell) cell.appendChild(badge);
      else cell.insertBefore(badge, cell.firstChild);
    }
    syncRowSpacer(row, badge, importanceCell, recipientCell);
  }

  function observeTrackedRows() {
    if (!isTrackedListRoute()) return false;
    const rows = [...document.querySelectorAll(ROW_SELECTOR)];
    rows.forEach(renderRow);
    const root = rows[0]?.closest("tbody") || rows[0]?.parentElement;
    if (!root) return false;
    if (listRoot === root && listObserver) return true;

    listObserver?.disconnect();
    listRoot = root;
    listObserver = new MutationObserver((records) => {
      let rowsChanged = false;
      for (const record of records) {
        const changedNodes = [...record.addedNodes, ...record.removedNodes];
        if (
          record.type === "childList" &&
          changedNodes.length > 0 &&
          changedNodes.every(
            (node) => node instanceof Element && node.classList.contains("mt-status-badge")
          )
        ) {
          const target =
            record.target instanceof Element ? record.target : record.target.parentElement;
          const row = target?.closest(ROW_SELECTOR);
          if (row && record.removedNodes.length > 0) renderRow(row);
          continue;
        }
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (target?.closest(".mt-status-badge")) continue;
        const targetRow = target?.closest(ROW_SELECTOR);
        if (targetRow) rowsChanged = true;
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches(ROW_SELECTOR) || node.querySelector(ROW_SELECTOR)) rowsChanged = true;
        }
        rowsChanged = true;
      }
      if (rowsChanged) {
        observeTrackedRows();
      }
    });
    listObserver.observe(root, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    return true;
  }

  function trackingPixelFrom(message) {
    return [
      ...message.querySelectorAll(
        'img.mailtrack-img, img[data-mailtrack-pixel], img[src*="/o/"], img[data-src*="/o/"]'
      ),
    ].find((candidate) => !candidate.closest(".gmail_quote, blockquote"));
  }

  function pixelIdFrom(message) {
    const image = trackingPixelFrom(message);
    if (!image) return null;
    const marked = image.getAttribute("data-mailtrack-pixel");
    if (marked) return marked;
    let src = image.getAttribute("src") || image.getAttribute("data-src") || "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const match = src.match(/\/o\/([A-Za-z0-9_-]+)/);
      if (match) return match[1];
      try {
        const decoded = decodeURIComponent(src);
        if (decoded === src) break;
        src = decoded;
      } catch {
        break;
      }
    }
    return null;
  }

  function waitForTrackingPixel(message) {
    const image = trackingPixelFrom(message);
    if (!image || image.complete) return Promise.resolve();
    return new Promise((resolve) => {
      let timer = null;
      const finish = () => {
        clearTimeout(timer);
        image.removeEventListener("load", finish);
        image.removeEventListener("error", finish);
        resolve();
      };
      image.addEventListener("load", finish, { once: true });
      image.addEventListener("error", finish, { once: true });
      timer = setTimeout(finish, SELF_VIEW_PIXEL_TIMEOUT_MS);
    });
  }

  function removeMessageIndicator(timestamp, indicator) {
    indicator.card.remove();
    indicator.badge.remove();
    timestamp.classList.remove("mt-thread-status-anchor");
    messageIndicators.delete(timestamp);
  }

  function messageIdFrom(message) {
    if (!(message instanceof Element)) return null;
    for (const source of [
      message,
      ...message.querySelectorAll("[data-legacy-message-id], [data-message-id]"),
    ]) {
      for (const attribute of ["data-legacy-message-id", "data-message-id"]) {
        const messageId = normalizeThreadId(source.getAttribute(attribute));
        if (messageId) return messageId;
      }
    }
    return null;
  }

  function formatOpenedAt(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(date);
  }

  function updateHistoryCard(card, track) {
    const history = Array.isArray(track.openHistory) ? track.openHistory : [];
    const signature = `${track.id}|${history.join("|")}`;
    if (card.dataset.mtSignature === signature) return;
    card.dataset.mtSignature = signature;
    card.replaceChildren();

    const title = document.createElement("div");
    title.className = "mt-history-title";
    title.textContent = "Open history";
    card.appendChild(title);

    if (!history.length) {
      const empty = document.createElement("div");
      empty.className = "mt-history-empty";
      empty.textContent = "No recipient opens yet";
      card.appendChild(empty);
      return;
    }

    const list = document.createElement("div");
    list.className = "mt-history-list";
    history
      .slice()
      .reverse()
      .forEach((openedAt) => {
        const item = document.createElement("div");
        item.className = "mt-history-row";
        const time = document.createElement("time");
        time.dateTime = openedAt;
        time.textContent = formatOpenedAt(openedAt);
        item.appendChild(time);
        list.appendChild(item);
      });
    card.appendChild(list);
  }

  function setHistoryOpen(indicator, open) {
    indicator.card.hidden = !open;
    indicator.badge.setAttribute("aria-expanded", String(open));
  }

  function createMessageIndicator(timestamp) {
    timestamp.classList.add("mt-thread-status-anchor");
    const badge = document.createElement("button");
    badge.type = "button";
    badge.setAttribute("aria-expanded", "false");
    badge.setAttribute("aria-label", "Show open history for this sent message");
    const card = document.createElement("div");
    card.className = "mt-history-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Email open history");
    card.hidden = true;
    const indicator = { badge, card, trackId: null };
    badge.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      for (const other of messageIndicators.values()) {
        if (other !== indicator) setHistoryOpen(other, false);
      }
      setHistoryOpen(indicator, card.hidden);
    });
    timestamp.append(badge, card);
    messageIndicators.set(timestamp, indicator);
    return indicator;
  }

  function settleSelfView(track, message) {
    if (selfViewStates.has(track.id)) return;
    const routeSelfViewStates = selfViewStates;
    routeSelfViewStates.set(track.id, "pending");
    const viewedAt = selfViewRouteStartedAt;
    (async () => {
      try {
        await window.MT.api.selfView(track.id, { phase: "start", viewedAt });
        await Promise.all([
          waitForTrackingPixel(message),
          new Promise((resolve) => setTimeout(resolve, SELF_VIEW_MIN_WINDOW_MS)),
        ]);
        await new Promise((resolve) => setTimeout(resolve, SELF_VIEW_SETTLE_MS));
        await window.MT.api.selfView(track.id, {
          phase: "end",
          viewedAt: new Date().toISOString(),
        });
        const rows = await window.MT.api.listTracks();
        if (routeSelfViewStates !== selfViewStates) return;
        indexTracks(rows);
        window.MT.statusCache.write(rows).catch(() => {});
      } catch (error) {
        console.warn("[MailTrack] sender-view settlement failed", error);
      } finally {
        if (routeSelfViewStates === selfViewStates) {
          routeSelfViewStates.set(track.id, "settled");
          renderVisibleState();
        }
      }
    })();
  }

  function renderMessageIndicators() {
    const messages = [...document.querySelectorAll(MESSAGE_SELECTOR)];
    const pageThreadId =
      threadIdFrom(document.querySelector("h2[data-thread-perm-id]")) ||
      messages.map(threadIdFrom).find(Boolean);
    const activeTimestamps = new Set();

    for (const message of messages) {
      const pixelId = pixelIdFrom(message);
      const messageId = messageIdFrom(message);
      const threadId = threadIdFrom(message) || pageThreadId;
      const threadTracks = tracksByThread.get(threadId) || [];
      const uniqueThreadTrack = threadTracks.length === 1 ? threadTracks[0] : null;
      const track = byId.get(pixelId) || byMessage.get(messageId) || uniqueThreadTrack;
      if (!track) continue;
      if (isTrackedListRoute() && selfViewStates.get(track.id) !== "settled") {
        settleSelfView(track, message);
      }
      const timestamp = message.querySelector(".g3");
      if (!timestamp || !message.contains(timestamp)) continue;
      activeTimestamps.add(timestamp);

      const indicator = messageIndicators.get(timestamp) || createMessageIndicator(timestamp);
      indicator.trackId = track.id;
      const scheduled = isScheduledRoute();
      const badgeClass = scheduled
        ? "mt-thread-status mt-scheduled"
        : `mt-thread-status ${track.opened ? "mt-opened" : "mt-unopened"}`;
      if (indicator.badge.className !== badgeClass) indicator.badge.className = badgeClass;
      const statusSignature = scheduled
        ? `${track.id}|scheduled`
        : `${track.id}|${track.opened}|${track.openCount}`;
      if (indicator.badge.dataset.mtSignature !== statusSignature) {
        indicator.badge.dataset.mtSignature = statusSignature;
        indicator.badge.dataset.mtStatusLabel = scheduled
          ? "Email tracked"
          : statusLabelFor(track);
        renderStatusContent(indicator.badge, track, scheduled);
      }
      if (indicator.badge.disabled !== scheduled) indicator.badge.disabled = scheduled;
      const ariaLabel = scheduled
        ? "Email tracking enabled"
        : `Show open history for this sent message. ${statusLabelFor(track)}.`;
      if (indicator.badge.getAttribute("aria-label") !== ariaLabel) {
        indicator.badge.setAttribute("aria-label", ariaLabel);
      }
      if (scheduled && !indicator.card.hidden) setHistoryOpen(indicator, false);
      updateHistoryCard(indicator.card, track);

      const mappingKey = `${track.id}|${threadId}|${messageId || ""}`;
      if (
        threadId &&
        (normalizeThreadId(track.gmailThreadId) !== threadId ||
          (messageId && normalizeThreadId(track.gmailMessageId) !== messageId)) &&
        !mappedThreadIds.has(mappingKey)
      ) {
        mappedThreadIds.add(mappingKey);
        track.gmailThreadId = threadId;
        if (messageId) track.gmailMessageId = messageId;
        window.MT.api.mapGmailThread(track.id, { threadId, messageId }).catch(() => {});
      }
    }

    for (const [timestamp, indicator] of messageIndicators) {
      if (!activeTimestamps.has(timestamp) && !timestamp.isConnected) {
        removeMessageIndicator(timestamp, indicator);
      }
    }
    return activeTimestamps.size > 0;
  }

  function renderVisibleState() {
    if (isTrackedListRoute()) observeTrackedRows();
    renderMessageIndicators();
  }

  function stopRouteWork() {
    retryTimers.forEach(clearTimeout);
    retryTimers = [];
    listObserver?.disconnect();
    listObserver = null;
    listRoot = null;
  }

  function scheduleStatusRefreshes() {
    statusRefreshTimers.forEach(clearTimeout);
    statusRefreshTimers = [];
    refreshTracks();
    for (const delay of STATUS_REFRESH_DELAYS) {
      statusRefreshTimers.push(setTimeout(() => refreshTracks(), delay));
    }
  }

  async function monitorRecentSend() {
    postSendRefreshGeneration += 1;
    const generation = postSendRefreshGeneration;
    clearTimeout(postSendRefreshTimer);
    postSendRefreshTimer = null;

    const rows = await refreshTracks();
    const watchedTrackId = rows[0]?.id;
    if (!watchedTrackId) return;

    let remainingPolls = POST_SEND_REFRESH_LIMIT;
    let openedConfirmationPolls = 0;
    const poll = async () => {
      if (generation !== postSendRefreshGeneration || remainingPolls <= 0) return;
      remainingPolls -= 1;

      if (!document.hidden) {
        await refreshTracks();
        const watchedTrack = byId.get(watchedTrackId);
        openedConfirmationPolls = watchedTrack?.opened
          ? openedConfirmationPolls + 1
          : 0;
        if (openedConfirmationPolls >= OPENED_CONFIRMATION_POLLS) return;
      }

      if (generation !== postSendRefreshGeneration || remainingPolls <= 0) return;
      postSendRefreshTimer = setTimeout(poll, POST_SEND_REFRESH_MS);
    };

    postSendRefreshTimer = setTimeout(poll, POST_SEND_REFRESH_MS);
  }

  function handleRoute() {
    stopRouteWork();
    selfViewRouteStartedAt = initialRouteHandled ? new Date().toISOString() : PAGE_STARTED_AT;
    initialRouteHandled = true;
    routeGeneration += 1;
    const generation = routeGeneration;
    mappedThreadIds = new Set();
    const sentThreadId = sentThreadIdFromRoute();
    const nextSelfViewRouteKey = sentThreadId ? `sent:${sentThreadId}` : location.hash;
    if (nextSelfViewRouteKey !== selfViewRouteKey) {
      selfViewStates = new Map();
      selfViewRouteKey = nextSelfViewRouteKey;
    }
    if (!isTrackedListRoute()) {
      document.querySelectorAll(".mt-status-badge").forEach((badge) => badge.remove());
    }
    refreshTracks();
    for (const delay of RETRY_DELAYS) {
      const timer = setTimeout(() => {
        if (generation !== routeGeneration) return;
        if (isTrackedListRoute()) observeTrackedRows();
        renderMessageIndicators();
      }, delay);
      retryTimers.push(timer);
    }
  }

  window.addEventListener("hashchange", handleRoute);
  window.addEventListener("mailtrack:mapped", () => {
    monitorRecentSend().catch((error) => {
      console.warn("[MailTrack] post-send status monitoring failed", error);
    });
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleStatusRefreshes();
  });
  window.addEventListener("focus", () => {
    scheduleStatusRefreshes();
  });
  document.addEventListener("click", (event) => {
    for (const indicator of messageIndicators.values()) {
      if (indicator.card.hidden) continue;
      if (indicator.badge.contains(event.target) || indicator.card.contains(event.target)) {
        continue;
      }
      setHistoryOpen(indicator, false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    for (const indicator of messageIndicators.values()) setHistoryOpen(indicator, false);
  });

  window.MT.ready.then(async () => {
    const cachedTracks = await window.MT.statusCache.read();
    indexTracks(cachedTracks);
    handleRoute();
  });

  window.MT.ui = { refresh: refreshTracks, render: renderVisibleState };
  console.log(`[MailTrack ${window.MT.version}] status indicators loaded`);
})();

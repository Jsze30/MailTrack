// Convert raw pixel hits into a compact opened/not-opened status.

const INITIAL_BROWSER_LOAD_WINDOW_MS = 15_000;
const INITIAL_GMAIL_PROXY_LOAD_WINDOW_MS = 30_000;
const SELF_VIEW_LOOKBACK_MS = 10_000;
const SELF_VIEW_LEGACY_FORWARD_MS = 30_000;
const SELF_VIEW_END_GRACE_MS = 5_000;
const SESSION_WINDOW_MS = 30_000;
const GMAIL_PREFETCH_USER_AGENT =
  /Chrome\/42\.0\.2311\.135.*Edge\/12\.246/i;
const GMAIL_IMAGE_PROXY_USER_AGENT = /GoogleImageProxy/i;

function isAutomatedPrefetch(event) {
  return GMAIL_PREFETCH_USER_AGENT.test(event.user_agent || event.userAgent || "");
}

function isGmailImageProxy(event) {
  return GMAIL_IMAGE_PROXY_USER_AGENT.test(event.user_agent || event.userAgent || "");
}

export function recipientOpenSessions(track) {
  const createdAt = new Date(track.sent_at).getTime();
  const events = track.events || [];
  const selfViewStarts = events
    .filter((event) => event.type === "selfview_start")
    .map((event) => new Date(event.ts).getTime())
    .sort((left, right) => left - right);
  const selfViewEnds = events
    .filter((event) => event.type === "selfview_end")
    .map((event) => new Date(event.ts).getTime())
    .sort((left, right) => left - right);
  const selfViews = selfViewStarts.length
    ? []
    : events
        .filter((event) => event.type === "selfview")
        .map((event) => new Date(event.ts).getTime())
        .sort((left, right) => left - right);
  const opens = events
    .filter((event) => event.type === "open" && !isAutomatedPrefetch(event))
    .map((event) => new Date(event.ts).getTime())
    .sort((left, right) => left - right);
  const gmailProxyOpens = new Set(
    events
      .filter(
        (event) =>
          event.type === "open" && !isAutomatedPrefetch(event) && isGmailImageProxy(event)
      )
      .map((event) => new Date(event.ts).getTime())
  );

  const selfViewOpenIndexes = new Set();
  let selfViewEndIndex = 0;
  for (const [startIndex, startedAt] of selfViewStarts.entries()) {
    while (selfViewEndIndex < selfViewEnds.length && selfViewEnds[selfViewEndIndex] < startedAt) {
      selfViewEndIndex += 1;
    }
    const nextStartedAt = selfViewStarts[startIndex + 1] ?? Number.POSITIVE_INFINITY;
    const endedAt = selfViewEnds[selfViewEndIndex];
    const hasEnd = Number.isFinite(endedAt) && endedAt < nextStartedAt;
    const windowEnd = hasEnd
      ? Math.min(endedAt + SELF_VIEW_END_GRACE_MS, nextStartedAt)
      : Math.min(startedAt + SELF_VIEW_LEGACY_FORWARD_MS, nextStartedAt);
    let matched = false;
    for (const [openIndex, openedAt] of opens.entries()) {
      if (openedAt < startedAt) continue;
      if (openedAt > windowEnd) break;
      selfViewOpenIndexes.add(openIndex);
      matched = true;
    }
    let precedingProxy = opens.length - 1;
    while (precedingProxy >= 0 && opens[precedingProxy] > startedAt) precedingProxy -= 1;
    if (
      precedingProxy >= 0 &&
      !selfViewOpenIndexes.has(precedingProxy) &&
      gmailProxyOpens.has(opens[precedingProxy]) &&
      startedAt - opens[precedingProxy] <= SELF_VIEW_LOOKBACK_MS
    ) {
      selfViewOpenIndexes.add(precedingProxy);
    }
    if (!matched) {
      let candidate = opens.length - 1;
      while (candidate >= 0 && opens[candidate] > startedAt) candidate -= 1;
      if (
        candidate >= 0 &&
        !selfViewOpenIndexes.has(candidate) &&
        startedAt - opens[candidate] <= SELF_VIEW_LOOKBACK_MS
      ) {
        selfViewOpenIndexes.add(candidate);
      }
    }
    if (hasEnd) selfViewEndIndex += 1;
  }
  let openIndex = 0;
  for (const viewedAt of selfViews) {
    while (openIndex < opens.length && opens[openIndex] <= viewedAt) openIndex += 1;
    for (let candidate = openIndex - 1; candidate >= 0; candidate -= 1) {
      if (selfViewOpenIndexes.has(candidate)) continue;
      if (viewedAt - opens[candidate] > SELF_VIEW_LOOKBACK_MS) break;
      selfViewOpenIndexes.add(candidate);
      break;
    }
  }

  const recipientOpens = [];
  for (const [index, openedAt] of opens.entries()) {
    const initialLoadWindow = gmailProxyOpens.has(openedAt)
      ? INITIAL_GMAIL_PROXY_LOAD_WINDOW_MS
      : INITIAL_BROWSER_LOAD_WINDOW_MS;
    if (openedAt - createdAt <= initialLoadWindow) continue;
    if (selfViewOpenIndexes.has(index)) continue;
    const previous = recipientOpens[recipientOpens.length - 1];
    if (!previous || openedAt - previous > SESSION_WINDOW_MS) recipientOpens.push(openedAt);
  }

  return recipientOpens;
}

export function statusFor(track) {
  const recipientOpens = recipientOpenSessions(track);
  return {
    id: track.id,
    gmailThreadId: track.gmail_thread_id || null,
    gmailMessageId: track.gmail_message_id || null,
    opened: recipientOpens.length > 0,
    openCount: recipientOpens.length,
    openHistory: recipientOpens.map((openedAt) => new Date(openedAt).toISOString()),
  };
}

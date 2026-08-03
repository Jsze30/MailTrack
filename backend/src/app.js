// Minimal tracking backend: register, record pixel opens, and return status.

import express from "express";
import crypto from "node:crypto";
import * as store from "./store.js";
import { statusFor } from "./aggregate.js";
import {
  authorizationUrl,
  exchangeAuthorizationCode,
  revokeGoogleToken,
} from "./google.js";
import { decryptToken, encryptToken } from "./token-crypto.js";
import { sendDueScheduledEmails } from "./scheduler.js";

const pixel = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);
const secret = process.env.TRACK_SECRET || "dev-secret-change-me";
const validId = /^[A-Za-z0-9_-]{8,128}$/;
const validGmailId = /^[0-9a-f]{8,32}$/i;
let ready = null;

function ensureReady() {
  if (!ready) ready = store.init();
  return ready;
}

function clientIp(request) {
  return (
    (request.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    request.socket?.remoteAddress ||
    ""
  );
}

function requireSecret(request, response, next) {
  if (request.get("x-track-secret") !== secret) {
    response.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireCronSecret(request, response, next) {
  const configured = process.env.CRON_SECRET;
  const provided = (request.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!configured || !safeEqual(configured, provided)) {
    response.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

function addressList(value) {
  if (!Array.isArray(value) || value.length > 100) return null;
  const addresses = value.map((address) => String(address || "").trim().toLocaleLowerCase());
  return addresses.every(
    (address) =>
      address.length <= 254 &&
      /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(address)
  )
    ? [...new Set(addresses)]
    : null;
}

function scheduledStatus(email) {
  return {
    id: email.id,
    trackingId: email.email_id,
    recipients: email.recipients,
    cc: email.cc,
    bcc: email.bcc,
    subject: email.subject,
    sendAt: email.send_at,
    status: email.status,
    attemptCount: email.attempt_count,
    gmailMessageId: email.gmail_message_id,
    lastError: email.last_error,
  };
}

function htmlPage(title, message) {
  const escape = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{max-width:560px;margin:80px auto;padding:24px;color:#202124;font:16px/1.5 system-ui,sans-serif}h1{font-size:24px}p{color:#5f6368}</style><h1>${escape(title)}</h1><p>${escape(message)}</p>`;
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(async (_request, _response, next) => {
  try {
    await ensureReady();
    next();
  } catch (error) {
    next(error);
  }
});
app.use("/api", (request, response, next) => {
  response.set("Access-Control-Allow-Origin", "*");
  response.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  response.set("Access-Control-Allow-Headers", "content-type, x-track-secret");
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  next();
});

app.get("/o/:id", async (request, response) => {
  const id = request.params.id.replace(/\.gif$/i, "");
  try {
    if (validId.test(id) && (await store.getTrack(id))) {
      await store.addEvent({
        trackId: id,
        type: "open",
        userAgent: request.get("user-agent"),
        ip: clientIp(request),
      });
    }
  } catch (error) {
    console.error("open logging failed", error);
  }
  response.set({
    "Content-Type": "image/gif",
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
    "Content-Length": String(pixel.length),
  });
  response.status(200).end(pixel);
});

app.post("/api/emails", requireSecret, async (request, response) => {
  const { id } = request.body || {};
  if (typeof id !== "string" || !validId.test(id)) {
    response.status(400).json({ error: "valid id required" });
    return;
  }
  const track = await store.createTrack(id);
  response.json({ ok: true, track: statusFor({ ...track, events: [] }) });
});

app.get("/api/emails", requireSecret, async (_request, response) => {
  const tracks = await store.listTracks();
  response.json({ emails: tracks.map(statusFor) });
});

app.patch("/api/emails/:id", requireSecret, async (request, response) => {
  const track = await store.getTrack(request.params.id);
  if (!track) {
    response.status(404).json({ error: "not found" });
    return;
  }
  const { gmailThreadId: threadId, gmailMessageId: messageId, sentAt, scheduled } =
    request.body || {};
  if (typeof threadId !== "string" || !validGmailId.test(threadId)) {
    response.status(400).json({ error: "valid Gmail threadId required" });
    return;
  }
  if (messageId != null && (typeof messageId !== "string" || !validGmailId.test(messageId))) {
    response.status(400).json({ error: "valid Gmail messageId required" });
    return;
  }
  const parsedSentAt = sentAt == null ? null : new Date(sentAt).getTime();
  if (
    sentAt != null &&
    (!Number.isFinite(parsedSentAt) || Math.abs(Date.now() - parsedSentAt) > 2 * 60 * 1000)
  ) {
    response.status(400).json({ error: "valid recent sentAt required" });
    return;
  }
  if (scheduled != null && typeof scheduled !== "boolean") {
    response.status(400).json({ error: "scheduled must be boolean" });
    return;
  }
  const updated = await store.mapGmailThread(request.params.id, {
    threadId: threadId.toLocaleLowerCase(),
    messageId: messageId?.toLocaleLowerCase() || null,
    sentAt: parsedSentAt == null ? null : new Date(parsedSentAt).toISOString(),
    scheduled: typeof scheduled === "boolean" ? scheduled : null,
  });
  response.json({ ok: true, track: statusFor({ ...updated, events: [] }) });
});

app.post("/api/emails/:id/selfview", requireSecret, async (request, response) => {
  const track = await store.getTrack(request.params.id);
  if (!track) {
    response.status(404).json({ error: "not found" });
    return;
  }
  const { phase, viewedAt } = request.body || {};
  const parsedViewedAt = new Date(viewedAt).getTime();
  const validViewedAt =
    ["start", "end"].includes(phase) &&
    Number.isFinite(parsedViewedAt) &&
    Math.abs(Date.now() - parsedViewedAt) <= 2 * 60 * 1000;
  const eventType =
    phase === "start" ? "selfview_start" : phase === "end" ? "selfview_end" : "selfview";
  await store.addEvent({
    trackId: request.params.id,
    type: eventType,
    userAgent: request.get("user-agent"),
    ip: clientIp(request),
    ts: validViewedAt ? new Date(parsedViewedAt).toISOString() : null,
  });
  response.json({ ok: true });
});

app.post("/api/oauth/google/start", requireSecret, async (_request, response) => {
  const state = crypto.randomBytes(32).toString("base64url");
  const stateHash = crypto.createHash("sha256").update(state).digest("hex");
  await store.createOauthState(
    stateHash,
    new Date(Date.now() + 10 * 60 * 1000).toISOString()
  );
  response.json({ url: authorizationUrl(state) });
});

app.get("/api/oauth/google/callback", async (request, response) => {
  const { code, state, error } = request.query;
  if (error) {
    response.status(400).send(htmlPage("Gmail was not connected", String(error)));
    return;
  }
  if (typeof code !== "string" || typeof state !== "string") {
    response.status(400).send(htmlPage("Gmail was not connected", "Missing OAuth response."));
    return;
  }

  const stateHash = crypto.createHash("sha256").update(state).digest("hex");
  if (!(await store.consumeOauthState(stateHash))) {
    response.status(400).send(htmlPage("Gmail was not connected", "The sign-in request expired."));
    return;
  }

  try {
    const connection = await exchangeAuthorizationCode(code);
    if (!connection.refreshToken) {
      throw new Error("Google did not return offline access. Reconnect and approve access again.");
    }
    await store.saveGoogleConnection({
      email: connection.email,
      encryptedRefreshToken: encryptToken(connection.refreshToken),
    });
    response.send(
      htmlPage("Gmail connected", `${connection.email} can now send scheduled MailTrack email.`)
    );
  } catch (oauthError) {
    console.error("Google OAuth callback failed", oauthError);
    response.status(500).send(htmlPage("Gmail was not connected", oauthError.message));
  }
});

app.get("/api/oauth/google/status", requireSecret, async (_request, response) => {
  const connection = await store.getGoogleConnection();
  response.json({ connected: Boolean(connection), email: connection?.email || null });
});

app.post("/api/oauth/google/disconnect", requireSecret, async (_request, response) => {
  const connection = await store.getGoogleConnection();
  if (connection) {
    try {
      await revokeGoogleToken(decryptToken(connection.encrypted_refresh_token));
    } catch (error) {
      console.warn("Google token revocation failed", error.message);
    }
    await store.deleteGoogleConnection();
  }
  response.json({ ok: true });
});

app.post("/api/scheduled-emails", requireSecret, async (request, response) => {
  const {
    trackingId,
    recipients: recipientsInput,
    cc: ccInput = [],
    bcc: bccInput = [],
    subject,
    bodyText,
    bodyHtml,
    sendAt,
    localMinute,
  } = request.body || {};
  const recipients = addressList(recipientsInput);
  const cc = addressList(ccInput);
  const bcc = addressList(bccInput);
  const parsedSendAt = new Date(sendAt).getTime();
  const now = Date.now();

  if (!validId.test(trackingId || "")) {
    response.status(400).json({ error: "valid trackingId required" });
    return;
  }
  if (!recipients?.length || !cc || !bcc) {
    response.status(400).json({ error: "valid recipient addresses required" });
    return;
  }
  if (typeof subject !== "string" || subject.length > 998) {
    response.status(400).json({ error: "valid subject required" });
    return;
  }
  if (
    typeof bodyText !== "string" ||
    typeof bodyHtml !== "string" ||
    bodyText.length > 500_000 ||
    bodyHtml.length > 500_000
  ) {
    response.status(400).json({ error: "valid message body required" });
    return;
  }
  if (
    !Number.isFinite(parsedSendAt) ||
    parsedSendAt < now + 2 * 60 * 1000 ||
    parsedSendAt > now + 366 * 24 * 60 * 60 * 1000 ||
    localMinute !== 0 ||
    new Date(parsedSendAt).getUTCSeconds() !== 0 ||
    new Date(parsedSendAt).getUTCMilliseconds() !== 0
  ) {
    response.status(400).json({ error: "sendAt must be a future whole-hour time" });
    return;
  }
  if (!(await store.getGoogleConnection())) {
    response.status(409).json({ error: "Gmail is not connected" });
    return;
  }

  await store.createTrack(trackingId);
  const scheduled = await store.createScheduledEmail({
    id: crypto.randomUUID(),
    emailId: trackingId,
    recipients,
    cc,
    bcc,
    subject: subject.trim(),
    bodyText,
    bodyHtml,
    sendAt: new Date(parsedSendAt).toISOString(),
  });
  response.status(201).json({ ok: true, email: scheduledStatus(scheduled) });
});

app.get("/api/scheduled-emails", requireSecret, async (_request, response) => {
  const emails = await store.listScheduledEmails();
  response.json({ emails: emails.map(scheduledStatus) });
});

app.delete("/api/scheduled-emails/:id", requireSecret, async (request, response) => {
  const email = await store.cancelScheduledEmail(request.params.id);
  if (!email) {
    response.status(409).json({ error: "only pending email can be cancelled" });
    return;
  }
  response.json({ ok: true, email: scheduledStatus(email) });
});

app.post(
  "/api/cron/send-scheduled",
  requireCronSecret,
  async (_request, response) => {
    const result = await sendDueScheduledEmails();
    response.json(result);
  }
);

app.get("/", (_request, response) => response.send("MailTrack backend is running."));
app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: "server error" });
});

export default app;

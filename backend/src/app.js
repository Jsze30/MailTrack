// Minimal tracking backend: register, record pixel opens, and return status.

import express from "express";
import * as store from "./store.js";
import { statusFor } from "./aggregate.js";

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

const app = express();
app.use(express.json());
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
  response.set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
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

app.get("/", (_request, response) => response.send("MailTrack backend is running."));
app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: "server error" });
});

export default app;

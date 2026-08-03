import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { statusFor } from "../src/aggregate.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(testDir, "..");

test("status collapses an open burst into one recipient session", () => {
  const createdAt = Date.now() - 120_000;
  const track = {
    id: "track-123",
    sent_at: new Date(createdAt).toISOString(),
    gmail_thread_id: "thread-123",
    events: [
      { type: "open", ts: new Date(createdAt + 60_000).toISOString() },
      { type: "open", ts: new Date(createdAt + 65_000).toISOString() },
    ],
  };

  assert.deepEqual(statusFor(track), {
    id: "track-123",
    gmailThreadId: "thread-123",
    gmailMessageId: null,
    opened: true,
    openCount: 1,
    openHistory: [new Date(createdAt + 60_000).toISOString()],
  });
});

test("status excludes Gmail's delivery-time pixel load around an immediate send", () => {
  const sentAt = Date.now() - 60_000;
  const recipientOpenedAt = sentAt + 16_000;
  const status = statusFor({
    id: "track-immediate-send",
    sent_at: new Date(sentAt).toISOString(),
    gmail_thread_id: null,
    events: [
      { type: "open", ts: new Date(sentAt + 6_000).toISOString() },
      { type: "open", ts: new Date(recipientOpenedAt).toISOString() },
    ],
  });

  assert.equal(status.opened, true);
  assert.equal(status.openCount, 1);
  assert.deepEqual(status.openHistory, [new Date(recipientOpenedAt).toISOString()]);
});

test("status excludes Gmail's delayed delivery proxy load", () => {
  const sentAt = Date.now() - 60_000;
  const proxyUserAgent =
    "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 " +
    "(via ggpht.com GoogleImageProxy)";
  const recipientOpenedAt = sentAt + 40_000;
  const status = statusFor({
    id: "track-delayed-delivery-proxy",
    sent_at: new Date(sentAt).toISOString(),
    gmail_thread_id: null,
    events: [
      {
        type: "open",
        ts: new Date(sentAt + 19_000).toISOString(),
        user_agent: proxyUserAgent,
      },
      {
        type: "open",
        ts: new Date(recipientOpenedAt).toISOString(),
        user_agent: proxyUserAgent,
      },
    ],
  });

  assert.equal(status.opened, true);
  assert.equal(status.openCount, 1);
  assert.deepEqual(status.openHistory, [new Date(recipientOpenedAt).toISOString()]);
});

test("status excludes a pixel load associated with a Sent self-view", () => {
  const createdAt = Date.now() - 120_000;
  const viewedAt = createdAt + 60_000;
  const status = statusFor({
    id: "track-123",
    sent_at: new Date(createdAt).toISOString(),
    gmail_thread_id: null,
    events: [
      { type: "open", ts: new Date(viewedAt - 500).toISOString() },
      { type: "selfview", ts: new Date(viewedAt).toISOString() },
    ],
  });

  assert.equal(status.opened, false);
  assert.equal(status.openCount, 0);
});

test("status excludes a pixel load that races just before the Sent self-view marker", () => {
  const createdAt = Date.now() - 120_000;
  const viewedAt = createdAt + 60_000;
  const status = statusFor({
    id: "track-refresh",
    sent_at: new Date(createdAt).toISOString(),
    gmail_thread_id: null,
    events: [
      { type: "open", ts: new Date(viewedAt - 100).toISOString() },
      { type: "selfview_start", ts: new Date(viewedAt).toISOString() },
    ],
  });

  assert.equal(status.opened, false);
  assert.equal(status.openCount, 0);
});

test("repeated Sent refreshes do not increase the recipient open count", () => {
  const createdAt = Date.now() - 180_000;
  const firstViewAt = createdAt + 60_000;
  const secondViewAt = createdAt + 120_000;
  const status = statusFor({
    id: "track-refresh",
    sent_at: new Date(createdAt).toISOString(),
    gmail_thread_id: null,
    events: [
      { type: "open", ts: new Date(firstViewAt - 100).toISOString() },
      { type: "selfview_start", ts: new Date(firstViewAt).toISOString() },
      { type: "open", ts: new Date(secondViewAt - 50).toISOString() },
      { type: "selfview_start", ts: new Date(secondViewAt).toISOString() },
    ],
  });

  assert.equal(status.opened, false);
  assert.equal(status.openCount, 0);
  assert.deepEqual(status.openHistory, []);
});

test("a delayed Gmail image load inside the Sent-view interval is excluded", () => {
  const createdAt = Date.now() - 120_000;
  const viewedAt = createdAt + 60_000;
  const status = statusFor({
    id: "track-delayed-refresh",
    sent_at: new Date(createdAt).toISOString(),
    gmail_thread_id: null,
    events: [
      { type: "selfview_start", ts: new Date(viewedAt).toISOString() },
      { type: "open", ts: new Date(viewedAt + 4_000).toISOString() },
      { type: "open", ts: new Date(viewedAt + 4_500).toISOString() },
      { type: "selfview_end", ts: new Date(viewedAt + 5_000).toISOString() },
    ],
  });

  assert.equal(status.opened, false);
  assert.equal(status.openCount, 0);
  assert.deepEqual(status.openHistory, []);
});

test("a Gmail proxy load racing before a Sent view is excluded with later sender loads", () => {
  const createdAt = Date.now() - 120_000;
  const viewedAt = createdAt + 60_000;
  const proxyUserAgent =
    "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 " +
    "(via ggpht.com GoogleImageProxy)";
  const status = statusFor({
    id: "track-proxy-race",
    sent_at: new Date(createdAt).toISOString(),
    gmail_thread_id: null,
    events: [
      {
        type: "open",
        ts: new Date(viewedAt - 1_500).toISOString(),
        user_agent: proxyUserAgent,
      },
      { type: "selfview_start", ts: new Date(viewedAt).toISOString() },
      {
        type: "open",
        ts: new Date(viewedAt + 500).toISOString(),
        user_agent: proxyUserAgent,
      },
      { type: "selfview_end", ts: new Date(viewedAt + 5_000).toISOString() },
    ],
  });

  assert.equal(status.opened, false);
  assert.equal(status.openCount, 0);
  assert.deepEqual(status.openHistory, []);
});

test("a recipient open after a completed self-view interval still counts", () => {
  const createdAt = Date.now() - 120_000;
  const viewedAt = createdAt + 60_000;
  const recipientOpenedAt = viewedAt + 15_000;
  const status = statusFor({
    id: "track-after-self-view",
    sent_at: new Date(createdAt).toISOString(),
    gmail_thread_id: null,
    events: [
      { type: "selfview_start", ts: new Date(viewedAt).toISOString() },
      { type: "selfview_end", ts: new Date(viewedAt + 5_000).toISOString() },
      { type: "open", ts: new Date(recipientOpenedAt).toISOString() },
    ],
  });

  assert.equal(status.opened, true);
  assert.equal(status.openCount, 1);
  assert.deepEqual(status.openHistory, [new Date(recipientOpenedAt).toISOString()]);
});

test("status excludes Gmail's automated image-prefetch request", () => {
  const createdAt = Date.now() - 120_000;
  const prefetchUserAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 " +
    "Safari/537.36 Edge/12.246 Mozilla/5.0";
  const status = statusFor({
    id: "track-prefetch",
    sent_at: new Date(createdAt).toISOString(),
    gmail_thread_id: null,
    events: [
      {
        type: "open",
        ts: new Date(createdAt + 60_000).toISOString(),
        user_agent: prefetchUserAgent,
      },
    ],
  });

  assert.equal(status.opened, false);
  assert.equal(status.openCount, 0);
});

test("status keeps a normal Gmail image-proxy recipient open", () => {
  const createdAt = Date.now() - 120_000;
  const status = statusFor({
    id: "track-recipient",
    sent_at: new Date(createdAt).toISOString(),
    gmail_thread_id: null,
    events: [
      {
        type: "open",
        ts: new Date(createdAt + 60_000).toISOString(),
        user_agent:
          "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 " +
          "(via ggpht.com GoogleImageProxy)",
      },
    ],
  });

  assert.equal(status.opened, true);
  assert.equal(status.openCount, 1);
});

test("a Sent self-view does not suppress a recipient open that follows it", () => {
  const createdAt = Date.now() - 120_000;
  const viewedAt = createdAt + 60_000;
  const status = statusFor({
    id: "track-123",
    sent_at: new Date(createdAt).toISOString(),
    gmail_thread_id: null,
    events: [
      { type: "open", ts: new Date(viewedAt - 500).toISOString() },
      { type: "selfview", ts: new Date(viewedAt).toISOString() },
      { type: "open", ts: new Date(viewedAt + 2_000).toISOString() },
    ],
  });

  assert.equal(status.opened, true);
  assert.equal(status.openCount, 1);
});

test("a sender-view start preserves an earlier recipient open and suppresses later sender loads", () => {
  const createdAt = Date.now() - 120_000;
  const viewedAt = createdAt + 60_000;
  const status = statusFor({
    id: "track-reply",
    sent_at: new Date(createdAt).toISOString(),
    gmail_thread_id: null,
    events: [
      { type: "open", ts: new Date(viewedAt - 100).toISOString() },
      { type: "selfview_start", ts: new Date(viewedAt).toISOString() },
      { type: "open", ts: new Date(viewedAt + 500).toISOString() },
      { type: "open", ts: new Date(viewedAt + 2_000).toISOString() },
    ],
  });

  assert.equal(status.opened, true);
  assert.equal(status.openCount, 1);
  assert.deepEqual(status.openHistory, [new Date(viewedAt - 100).toISOString()]);
});

test("a legacy self-view cannot erase a later recipient open after a sender-view start", () => {
  const createdAt = Date.now() - 120_000;
  const viewedAt = createdAt + 60_000;
  const recipientOpenedAt = viewedAt + 45_000;
  const status = statusFor({
    id: "track-reply",
    sent_at: new Date(createdAt).toISOString(),
    gmail_thread_id: null,
    events: [
      { type: "selfview_start", ts: new Date(viewedAt).toISOString() },
      { type: "open", ts: new Date(viewedAt + 500).toISOString() },
      { type: "open", ts: new Date(recipientOpenedAt).toISOString() },
      { type: "selfview", ts: new Date(recipientOpenedAt + 100).toISOString() },
    ],
  });

  assert.equal(status.opened, true);
  assert.equal(status.openCount, 1);
  assert.deepEqual(status.openHistory, [new Date(recipientOpenedAt).toISOString()]);
});

test("each Sent self-view suppresses at most one earlier pixel hit", () => {
  const createdAt = Date.now() - 120_000;
  const viewedAt = createdAt + 60_000;
  const status = statusFor({
    id: "track-123",
    sent_at: new Date(createdAt).toISOString(),
    gmail_thread_id: null,
    events: [
      { type: "open", ts: new Date(viewedAt - 2_000).toISOString() },
      { type: "open", ts: new Date(viewedAt - 500).toISOString() },
      { type: "selfview", ts: new Date(viewedAt).toISOString() },
    ],
  });

  assert.equal(status.opened, true);
  assert.equal(status.openCount, 1);
});

test("backend exposes only the core tracking routes", async () => {
  const appSource = await fs.readFile(path.join(backendDir, "src/app.js"), "utf8");
  assert.match(appSource, /app\.get\("\/o\/:id"/);
  assert.match(appSource, /app\.post\("\/api\/emails"/);
  assert.match(appSource, /app\.get\("\/api\/emails"/);
  assert.match(appSource, /selfview/);
  assert.doesNotMatch(appSource, /\/c\/:id|\/api\/stats|\/events"/);
});

test("core routes register, map, serve, and list a track", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mailtrack-test-"));
  process.env.MAILTRACK_DATA_FILE = path.join(temporaryDirectory, "db.json");
  process.env.TRACK_SECRET = "test-secret";
  const { default: app } = await import(`../src/app.js?test=${Date.now()}`);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = {
    "content-type": "application/json",
    "x-track-secret": "test-secret",
  };

  try {
    const registration = await fetch(`${baseUrl}/api/emails`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "track_123456" }),
    });
    assert.equal(registration.status, 200);

    const invalidMapping = await fetch(`${baseUrl}/api/emails/track_123456`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ gmailThreadId: "r-123456" }),
    });
    assert.equal(invalidMapping.status, 400);

    const sentAt = new Date().toISOString();
    const mapping = await fetch(`${baseUrl}/api/emails/track_123456`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        gmailThreadId: "19fc000000000123",
        gmailMessageId: "19fc100000000123",
        sentAt,
        scheduled: true,
      }),
    });
    assert.equal(mapping.status, 200);
    const storedDatabase = JSON.parse(await fs.readFile(process.env.MAILTRACK_DATA_FILE, "utf8"));
    assert.equal(storedDatabase.emails[0].sent_at, sentAt);
    assert.equal(storedDatabase.emails[0].sent_at_confirmed, true);
    assert.equal(storedDatabase.emails[0].scheduled, true);

    const laterSentAt = new Date(Date.now() + 1_000).toISOString();
    const quotedReplyRemap = await fetch(`${baseUrl}/api/emails/track_123456`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        gmailThreadId: "19fc000000000123",
        gmailMessageId: "19fc100000000999",
        sentAt: laterSentAt,
      }),
    });
    assert.equal(quotedReplyRemap.status, 200);
    const remappedDatabase = JSON.parse(
      await fs.readFile(process.env.MAILTRACK_DATA_FILE, "utf8")
    );
    assert.equal(remappedDatabase.emails[0].sent_at, sentAt);
    assert.equal(remappedDatabase.emails[0].sent_at_confirmed, true);

    const pixel = await fetch(`${baseUrl}/o/track_123456.gif`);
    assert.equal(pixel.status, 200);
    assert.equal(pixel.headers.get("content-type"), "image/gif");

    const listing = await fetch(`${baseUrl}/api/emails`, { headers });
    assert.equal(listing.status, 200);
    const payload = await listing.json();
    assert.deepEqual(payload.emails, [
      {
        id: "track_123456",
        gmailThreadId: "19fc000000000123",
        gmailMessageId: "19fc100000000999",
        opened: false,
        openCount: 0,
        openHistory: [],
      },
    ]);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    delete process.env.MAILTRACK_DATA_FILE;
    delete process.env.TRACK_SECRET;
  }
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mailtrack-scheduler-test-"));
process.env.MAILTRACK_DATA_FILE = path.join(temporaryDirectory, "db.json");
process.env.TRACK_SECRET = "test-track-secret";
process.env.CRON_SECRET = "test-cron-secret";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.GOOGLE_OAUTH_ID = "test-client-id";
process.env.GOOGLE_OAUTH_SECRET = "test-client-secret";
process.env.GOOGLE_REDIRECT_URI = "https://backend.example/api/oauth/google/callback";

const [{ default: app }, store, tokenCrypto] = await Promise.all([
  import(`../src/app.js?scheduler=${Date.now()}`),
  import("../src/store.js"),
  import("../src/token-crypto.js"),
]);

function decodeHtmlPart(rawMessage) {
  const mime = Buffer.from(rawMessage, "base64url").toString("utf8");
  const htmlSection = mime.split('Content-Type: text/html; charset="UTF-8"')[1];
  assert.ok(htmlSection, "message contains an HTML MIME part");
  const encoded = htmlSection
    .split("\r\n\r\n")[1]
    .split("\r\n--")[0]
    .replaceAll("\r\n", "");
  return Buffer.from(encoded, "base64").toString("utf8");
}

test("the hourly cron sends every due message once", async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const nativeFetch = globalThis.fetch;

  try {
    await nativeFetch(baseUrl);
    await store.saveGoogleConnection({
      email: "sender@example.com",
      encryptedRefreshToken: tokenCrypto.encryptToken("refresh-token"),
    });

    const dueAt = new Date(Date.now() - 60_000).toISOString();
    for (const sequence of [1, 2]) {
      const trackingId = `scheduled_track_${sequence}`;
      await store.createTrack(trackingId);
      await store.createScheduledEmail({
        id: `scheduled-email-${sequence}`,
        emailId: trackingId,
        recipients: [`recipient${sequence}@example.com`],
        cc: [],
        bcc: [],
        subject: `Scheduled subject ${sequence}`,
        bodyText: `Scheduled body ${sequence}`,
        bodyHtml: `<div>Scheduled body ${sequence}</div>`,
        sendAt: dueAt,
        draftId: `draft-${sequence}`,
      });
    }

    const sentRequests = [];
    globalThis.fetch = async (url, options = {}) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "access-token" });
      }
      if (String(url).endsWith("/gmail/v1/users/me/drafts/send")) {
        sentRequests.push(JSON.parse(options.body));
        const sequence = sentRequests.length;
        return Response.json({
          id: `19fc10000000000${sequence}`,
          threadId: `19fc20000000000${sequence}`,
        });
      }
      throw new Error(`Unexpected Google request: ${url}`);
    };

    const cronHeaders = {
      authorization: `Bearer ${process.env.CRON_SECRET}`,
      "content-type": "application/json",
    };
    const firstRun = await nativeFetch(`${baseUrl}/api/cron/send-scheduled`, {
      method: "POST",
      headers: cronHeaders,
      body: "{}",
    });
    assert.equal(firstRun.status, 200);
    assert.deepEqual(await firstRun.json(), {
      claimed: 2,
      sent: 2,
      failed: 0,
      results: [
        { id: "scheduled-email-1", status: "sent" },
        { id: "scheduled-email-2", status: "sent" },
      ],
    });
    assert.equal(sentRequests.length, 2);
    // The cron sends each stored draft by id - no message is re-composed at send time.
    assert.deepEqual(
      sentRequests.map((request) => request.id),
      ["draft-1", "draft-2"]
    );

    const secondRun = await nativeFetch(`${baseUrl}/api/cron/send-scheduled`, {
      method: "POST",
      headers: cronHeaders,
      body: "{}",
    });
    assert.equal(secondRun.status, 200);
    assert.deepEqual(await secondRun.json(), {
      claimed: 0,
      sent: 0,
      failed: 0,
      results: [],
    });
    assert.equal(sentRequests.length, 2);

    const unauthorized = await nativeFetch(`${baseUrl}/api/cron/send-scheduled`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(unauthorized.status, 401);

    const stored = JSON.parse(await fs.readFile(process.env.MAILTRACK_DATA_FILE, "utf8"));
    assert.deepEqual(
      stored.scheduledEmails.map((email) => email.status),
      ["sent", "sent"]
    );
    assert.deepEqual(
      stored.emails.map((email) => email.gmail_message_id),
      ["19fc100000000001", "19fc100000000002"]
    );
  } finally {
    globalThis.fetch = nativeFetch;
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("refresh tokens are encrypted and authenticated", () => {
  const encrypted = tokenCrypto.encryptToken("secret-refresh-token");
  assert.notEqual(encrypted, "secret-refresh-token");
  assert.equal(tokenCrypto.decryptToken(encrypted), "secret-refresh-token");

  const pieces = encrypted.split(".");
  const tamperedCiphertext = Buffer.from(pieces[2], "base64url");
  tamperedCiphertext[0] ^= 1;
  pieces[2] = tamperedCiphertext.toString("base64url");
  assert.throws(() => tokenCrypto.decryptToken(pieces.join(".")));
});

test("the scheduling API accepts a future whole hour and can cancel it", async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = {
    "content-type": "application/json",
    "x-track-secret": process.env.TRACK_SECRET,
  };
  const nextHour = new Date(Math.ceil((Date.now() + 2 * 60 * 1000) / 3_600_000) * 3_600_000);
  const nativeFetch = globalThis.fetch;
  let createdRaw = null;
  const draftDeletes = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "access-token" });
    }
    if (target.endsWith("/gmail/v1/users/me/drafts") && options.method === "POST") {
      createdRaw = JSON.parse(options.body).message.raw;
      return Response.json({
        id: "draft-api-1",
        message: { id: "msg-api-1", threadId: "thread-api-1" },
      });
    }
    if (target.includes("/gmail/v1/users/me/drafts/") && options.method === "DELETE") {
      draftDeletes.push(target);
      return new Response(null, { status: 204 });
    }
    return nativeFetch(url, options);
  };

  try {
    const scheduled = await nativeFetch(`${baseUrl}/api/scheduled-emails`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        trackingId: "scheduled_api_track",
        recipients: ["recipient@example.com"],
        cc: [],
        bcc: [],
        subject: "API scheduled subject",
        bodyText: "API scheduled body",
        bodyHtml: "<div>API scheduled body</div>",
        sendAt: nextHour.toISOString(),
        localMinute: 0,
      }),
    });
    assert.equal(scheduled.status, 201);
    const scheduledPayload = await scheduled.json();
    assert.equal(scheduledPayload.email.status, "pending");
    assert.equal(scheduledPayload.email.sendAt, nextHour.toISOString());
    // Scheduling creates a real Gmail draft (with the tracking pixel) and records its id.
    assert.equal(scheduledPayload.email.gmailDraftId, "draft-api-1");
    assert.equal(scheduledPayload.email.gmailThreadId, "thread-api-1");
    const draftHtml = decodeHtmlPart(createdRaw);
    assert.match(draftHtml, /API scheduled body/);
    assert.match(draftHtml, /https:\/\/backend\.example\/o\/scheduled_api_track\.gif/);

    const listing = await nativeFetch(`${baseUrl}/api/scheduled-emails`, { headers });
    assert.equal(listing.status, 200);
    const listedPayload = await listing.json();
    assert.equal(
      listedPayload.emails.some((email) => email.id === scheduledPayload.email.id),
      true
    );

    const cancelled = await nativeFetch(
      `${baseUrl}/api/scheduled-emails/${scheduledPayload.email.id}`,
      { method: "DELETE", headers }
    );
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).email.status, "cancelled");
    // Cancelling also removes the draft from the user's Drafts folder.
    assert.deepEqual(draftDeletes, [
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft-api-1",
    ]);

    const invalidMinutes = new Date(nextHour.getTime() + 30 * 60 * 1000);
    const invalid = await nativeFetch(`${baseUrl}/api/scheduled-emails`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        trackingId: "invalid_minute_track",
        recipients: ["recipient@example.com"],
        cc: [],
        bcc: [],
        subject: "Invalid",
        bodyText: "Invalid",
        bodyHtml: "<div>Invalid</div>",
        sendAt: invalidMinutes.toISOString(),
        localMinute: 30,
      }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    globalThis.fetch = nativeFetch;
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test.after(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

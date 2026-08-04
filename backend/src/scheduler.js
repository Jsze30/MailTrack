import crypto from "node:crypto";
import * as store from "./store.js";
import { decryptToken } from "./token-crypto.js";
import { refreshAccessToken, sendGmailDraftWithAccessToken } from "./google.js";

export function publicBaseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  if (process.env.GOOGLE_REDIRECT_URI) {
    return new URL(process.env.GOOGLE_REDIRECT_URI).origin;
  }
  throw new Error("PUBLIC_BASE_URL or GOOGLE_REDIRECT_URI is required");
}

export function pixelUrlFor(trackingId) {
  return `${publicBaseUrl()}/o/${encodeURIComponent(trackingId)}.gif`;
}

export async function sendDueScheduledEmails({ fetchImpl = fetch, limit = 25 } = {}) {
  const connection = await store.getGoogleConnection();
  if (!connection) return { claimed: 0, sent: 0, failed: 0, results: [] };

  const leaseToken = crypto.randomBytes(24).toString("base64url");
  const emails = await store.claimDueScheduledEmails({ leaseToken, limit });
  if (!emails.length) return { claimed: 0, sent: 0, failed: 0, results: [] };

  let accessToken;
  try {
    accessToken = await refreshAccessToken(
      decryptToken(connection.encrypted_refresh_token),
      fetchImpl
    );
  } catch (error) {
    for (const email of emails) {
      await store.markScheduledEmailFailed(email.id, leaseToken, error.message, true);
    }
    return {
      claimed: emails.length,
      sent: 0,
      failed: emails.length,
      results: emails.map((email) => ({ id: email.id, status: "failed" })),
    };
  }

  const results = [];
  for (const email of emails) {
    try {
      if (!email.gmail_draft_id) throw new Error("scheduled email has no Gmail draft");
      // The draft (with its tracking pixel) was created when the user scheduled it; sending it
      // moves it out of Drafts into Sent in one call, so there is nothing to re-compose here.
      const sent = await sendGmailDraftWithAccessToken(
        { accessToken, draftId: email.gmail_draft_id },
        fetchImpl
      );
      const updated = await store.markScheduledEmailSent(email.id, leaseToken, sent);
      if (!updated) throw new Error("scheduled email lease was lost");
      await store.mapGmailThread(email.email_id, {
        threadId: sent.threadId,
        messageId: sent.messageId,
        sentAt: updated.sent_at,
        scheduled: false,
      });
      console.log(`[MailTrack] draft sent draftId=${email.gmail_draft_id} messageId=${sent.messageId}`);
      results.push({ id: email.id, status: "sent" });
    } catch (error) {
      console.error(`[MailTrack] draft send FAILED id=${email.id} draftId=${email.gmail_draft_id}: ${error.message}`);
      await store.markScheduledEmailFailed(
        email.id,
        leaseToken,
        error.message,
        // A deleted/missing draft can never succeed on retry.
        error.retryable !== false && error.missingDraft !== true
      );
      results.push({ id: email.id, status: "failed" });
    }
  }

  return {
    claimed: emails.length,
    sent: results.filter((result) => result.status === "sent").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  };
}

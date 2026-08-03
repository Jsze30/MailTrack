import crypto from "node:crypto";
import * as store from "./store.js";
import { decryptToken } from "./token-crypto.js";
import { appendTrackingPixel } from "./mime.js";
import { refreshAccessToken, sendGmailMessageWithAccessToken } from "./google.js";

function publicBaseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  if (process.env.GOOGLE_REDIRECT_URI) {
    return new URL(process.env.GOOGLE_REDIRECT_URI).origin;
  }
  throw new Error("PUBLIC_BASE_URL or GOOGLE_REDIRECT_URI is required");
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
      const pixelUrl = `${publicBaseUrl()}/o/${encodeURIComponent(email.email_id)}.gif`;
      const sent = await sendGmailMessageWithAccessToken(
        {
          accessToken,
          message: {
            to: email.recipients,
            cc: email.cc,
            bcc: email.bcc,
            subject: email.subject,
            text: email.body_text,
            html: appendTrackingPixel(email.body_html, pixelUrl),
          },
        },
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
      results.push({ id: email.id, status: "sent" });
    } catch (error) {
      await store.markScheduledEmailFailed(
        email.id,
        leaseToken,
        error.message,
        error.retryable !== false
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

// Minimal storage for tracks and open/self-view events.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const usePostgres = Boolean(process.env.DATABASE_URL);
const defaultDataDir = path.join(currentDir, "..", ".data");
const dataFile = process.env.MAILTRACK_DATA_FILE || path.join(defaultDataDir, "db.json");
const dataDir = path.dirname(dataFile);
let pg = null;

function readJson() {
  try {
    return {
      emails: [],
      events: [],
      nextEventId: 1,
      googleConnections: [],
      oauthStates: [],
      scheduledEmails: [],
      ...JSON.parse(fs.readFileSync(dataFile, "utf8")),
    };
  } catch {
    return {
      emails: [],
      events: [],
      nextEventId: 1,
      googleConnections: [],
      oauthStates: [],
      scheduledEmails: [],
    };
  }
}

function writeJson(database) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(database, null, 2));
}

export async function init() {
  if (!usePostgres) {
    writeJson(readJson());
    return;
  }

  const { default: postgresPackage } = await import("pg");
  const { Pool } = postgresPackage;
  pg = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await pg.query(`
    CREATE TABLE IF NOT EXISTS emails (
      id                TEXT PRIMARY KEY,
      subject           TEXT,
      recipients        TEXT,
      sent_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at_confirmed BOOLEAN NOT NULL DEFAULT false,
      scheduled         BOOLEAN NOT NULL DEFAULT false,
      gmail_thread_id   TEXT,
      gmail_message_id  TEXT
    );
    ALTER TABLE emails ADD COLUMN IF NOT EXISTS gmail_thread_id TEXT;
    ALTER TABLE emails ADD COLUMN IF NOT EXISTS gmail_message_id TEXT;
    ALTER TABLE emails ADD COLUMN IF NOT EXISTS sent_at_confirmed BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE emails ALTER COLUMN sent_at_confirmed SET DEFAULT false;
    CREATE TABLE IF NOT EXISTS events (
      id          BIGSERIAL PRIMARY KEY,
      email_id    TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,
      ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
      user_agent  TEXT,
      ip          TEXT,
      url         TEXT
    );
    CREATE INDEX IF NOT EXISTS events_email_id_idx ON events(email_id);
    CREATE TABLE IF NOT EXISTS google_connections (
      id                      TEXT PRIMARY KEY,
      email                   TEXT NOT NULL,
      encrypted_refresh_token TEXT NOT NULL,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      state_hash TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS scheduled_emails (
      id                  TEXT PRIMARY KEY,
      connection_id       TEXT NOT NULL REFERENCES google_connections(id) ON DELETE CASCADE,
      email_id            TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
      recipients          JSONB NOT NULL,
      cc                  JSONB NOT NULL DEFAULT '[]'::jsonb,
      bcc                 JSONB NOT NULL DEFAULT '[]'::jsonb,
      subject             TEXT NOT NULL,
      body_text           TEXT NOT NULL,
      body_html           TEXT NOT NULL,
      send_at             TIMESTAMPTZ NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending',
      attempt_count       INTEGER NOT NULL DEFAULT 0,
      lease_token         TEXT,
      lease_until         TIMESTAMPTZ,
      gmail_message_id    TEXT,
      gmail_thread_id     TEXT,
      last_error          TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at             TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS scheduled_emails_due_idx
      ON scheduled_emails(status, send_at);
  `);
}

export async function createTrack(id) {
  if (usePostgres) {
    await pg.query(
      `INSERT INTO emails (id, subject, recipients, scheduled, sent_at_confirmed)
       VALUES ($1, '', '', false, false)
       ON CONFLICT (id) DO NOTHING`,
      [id]
    );
    return getTrack(id);
  }

  const database = readJson();
  if (!database.emails.some((track) => track.id === id)) {
    database.emails.push({
      id,
      subject: "",
      recipients: "",
      sent_at: new Date().toISOString(),
      sent_at_confirmed: false,
      scheduled: false,
      gmail_thread_id: null,
      gmail_message_id: null,
    });
    writeJson(database);
  }
  return getTrack(id);
}

export async function getTrack(id) {
  if (usePostgres) {
    const { rows } = await pg.query(`SELECT * FROM emails WHERE id = $1`, [id]);
    return rows[0] || null;
  }
  return readJson().emails.find((track) => track.id === id) || null;
}

export async function mapGmailThread(
  id,
  { threadId, messageId, sentAt = null, scheduled = null }
) {
  if (usePostgres) {
    await pg.query(
      `UPDATE emails
       SET gmail_thread_id = $2,
           gmail_message_id = $3,
           sent_at = CASE
             WHEN NOT sent_at_confirmed AND $4::timestamptz IS NOT NULL THEN $4::timestamptz
             ELSE sent_at
           END,
           sent_at_confirmed = sent_at_confirmed OR $4::timestamptz IS NOT NULL,
           scheduled = COALESCE($5::boolean, scheduled)
       WHERE id = $1`,
      [id, threadId, messageId || null, sentAt, scheduled]
    );
    return getTrack(id);
  }

  const database = readJson();
  const track = database.emails.find((item) => item.id === id);
  if (!track) return null;
  const sentAtConfirmed =
    typeof track.sent_at_confirmed === "boolean"
      ? track.sent_at_confirmed
      : Boolean(track.gmail_thread_id);
  track.gmail_thread_id = threadId;
  track.gmail_message_id = messageId || null;
  if (sentAt && !sentAtConfirmed) track.sent_at = sentAt;
  track.sent_at_confirmed = sentAtConfirmed || Boolean(sentAt);
  if (typeof scheduled === "boolean") track.scheduled = scheduled;
  writeJson(database);
  return track;
}

export async function addEvent({ trackId, type, userAgent, ip, ts = null }) {
  if (usePostgres) {
    await pg.query(
      `INSERT INTO events (email_id, type, user_agent, ip, ts)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()))`,
      [trackId, type, userAgent || "", ip || "", ts]
    );
    return;
  }

  const database = readJson();
  database.events.push({
    id: database.nextEventId++,
    email_id: trackId,
    type,
    ts: ts || new Date().toISOString(),
    user_agent: userAgent || "",
    ip: ip || "",
    url: null,
  });
  writeJson(database);
}

export async function listTracks() {
  if (usePostgres) {
    const [{ rows: tracks }, { rows: events }] = await Promise.all([
      pg.query(`SELECT * FROM emails ORDER BY sent_at DESC`),
      pg.query(
        `SELECT email_id, type, ts, user_agent FROM events
         WHERE type IN ('open', 'selfview', 'selfview_start', 'selfview_end') ORDER BY ts ASC`
      ),
    ]);
    const eventsByTrack = new Map();
    for (const event of events) {
      const group = eventsByTrack.get(event.email_id) || [];
      group.push(event);
      eventsByTrack.set(event.email_id, group);
    }
    return tracks.map((track) => ({
      ...track,
      events: eventsByTrack.get(track.id) || [],
    }));
  }

  const database = readJson();
  return database.emails
    .slice()
    .sort((left, right) => new Date(right.sent_at) - new Date(left.sent_at))
    .map((track) => ({
      ...track,
      events: database.events
        .filter(
          (event) =>
            event.email_id === track.id &&
            ["open", "selfview", "selfview_start", "selfview_end"].includes(event.type)
        )
        .sort((left, right) => new Date(left.ts) - new Date(right.ts)),
    }));
}

export async function createOauthState(stateHash, expiresAt) {
  if (usePostgres) {
    await pg.query(`DELETE FROM oauth_states WHERE expires_at <= now()`);
    await pg.query(
      `INSERT INTO oauth_states (state_hash, expires_at)
       VALUES ($1, $2::timestamptz)
       ON CONFLICT (state_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [stateHash, expiresAt]
    );
    return;
  }

  const database = readJson();
  const now = Date.now();
  database.oauthStates = database.oauthStates.filter(
    (state) => new Date(state.expires_at).getTime() > now && state.state_hash !== stateHash
  );
  database.oauthStates.push({ state_hash: stateHash, expires_at: expiresAt });
  writeJson(database);
}

export async function consumeOauthState(stateHash) {
  if (usePostgres) {
    const { rows } = await pg.query(
      `DELETE FROM oauth_states
       WHERE state_hash = $1 AND expires_at > now()
       RETURNING state_hash`,
      [stateHash]
    );
    return rows.length === 1;
  }

  const database = readJson();
  const state = database.oauthStates.find((item) => item.state_hash === stateHash);
  database.oauthStates = database.oauthStates.filter((item) => item.state_hash !== stateHash);
  writeJson(database);
  return Boolean(state && new Date(state.expires_at).getTime() > Date.now());
}

export async function saveGoogleConnection({ email, encryptedRefreshToken }) {
  const id = "primary";
  if (usePostgres) {
    const { rows } = await pg.query(
      `INSERT INTO google_connections (id, email, encrypted_refresh_token)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE
       SET email = EXCLUDED.email,
           encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
           updated_at = now()
       RETURNING *`,
      [id, email, encryptedRefreshToken]
    );
    return rows[0];
  }

  const database = readJson();
  const now = new Date().toISOString();
  const existing = database.googleConnections.find((connection) => connection.id === id);
  const connection = {
    id,
    email,
    encrypted_refresh_token: encryptedRefreshToken,
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  database.googleConnections = database.googleConnections.filter((item) => item.id !== id);
  database.googleConnections.push(connection);
  writeJson(database);
  return connection;
}

export async function getGoogleConnection() {
  if (usePostgres) {
    const { rows } = await pg.query(`SELECT * FROM google_connections WHERE id = 'primary'`);
    return rows[0] || null;
  }
  return readJson().googleConnections.find((connection) => connection.id === "primary") || null;
}

export async function deleteGoogleConnection() {
  if (usePostgres) {
    await pg.query(`DELETE FROM google_connections WHERE id = 'primary'`);
    return;
  }
  const database = readJson();
  database.googleConnections = database.googleConnections.filter(
    (connection) => connection.id !== "primary"
  );
  database.scheduledEmails = database.scheduledEmails.filter(
    (email) => email.connection_id !== "primary"
  );
  writeJson(database);
}

export async function createScheduledEmail(email) {
  if (usePostgres) {
    const { rows } = await pg.query(
      `INSERT INTO scheduled_emails (
         id, connection_id, email_id, recipients, cc, bcc, subject,
         body_text, body_html, send_at
       ) VALUES ($1, 'primary', $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
       RETURNING *`,
      [
        email.id,
        email.emailId,
        JSON.stringify(email.recipients),
        JSON.stringify(email.cc),
        JSON.stringify(email.bcc),
        email.subject,
        email.bodyText,
        email.bodyHtml,
        email.sendAt,
      ]
    );
    return rows[0];
  }

  const database = readJson();
  const now = new Date().toISOString();
  const scheduled = {
    id: email.id,
    connection_id: "primary",
    email_id: email.emailId,
    recipients: email.recipients,
    cc: email.cc,
    bcc: email.bcc,
    subject: email.subject,
    body_text: email.bodyText,
    body_html: email.bodyHtml,
    send_at: email.sendAt,
    status: "pending",
    attempt_count: 0,
    lease_token: null,
    lease_until: null,
    gmail_message_id: null,
    gmail_thread_id: null,
    last_error: null,
    created_at: now,
    updated_at: now,
    sent_at: null,
  };
  database.scheduledEmails.push(scheduled);
  writeJson(database);
  return scheduled;
}

export async function listScheduledEmails() {
  if (usePostgres) {
    const { rows } = await pg.query(
      `SELECT * FROM scheduled_emails ORDER BY send_at ASC, created_at ASC`
    );
    return rows;
  }
  return readJson().scheduledEmails
    .slice()
    .sort((left, right) => new Date(left.send_at) - new Date(right.send_at));
}

export async function cancelScheduledEmail(id) {
  if (usePostgres) {
    const { rows } = await pg.query(
      `UPDATE scheduled_emails
       SET status = 'cancelled', updated_at = now()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [id]
    );
    return rows[0] || null;
  }

  const database = readJson();
  const email = database.scheduledEmails.find((item) => item.id === id);
  if (!email || email.status !== "pending") return null;
  email.status = "cancelled";
  email.updated_at = new Date().toISOString();
  writeJson(database);
  return email;
}

export async function claimDueScheduledEmails({ leaseToken, limit = 25 }) {
  if (usePostgres) {
    const { rows } = await pg.query(
      `WITH due AS (
         SELECT id
         FROM scheduled_emails
         WHERE send_at <= now()
           AND (
             status = 'pending'
             OR (status = 'sending' AND lease_until <= now())
           )
         ORDER BY send_at ASC, created_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE scheduled_emails AS scheduled
       SET status = 'sending',
           attempt_count = attempt_count + 1,
           lease_token = $1,
           lease_until = now() + interval '5 minutes',
           updated_at = now()
       FROM due
       WHERE scheduled.id = due.id
       RETURNING scheduled.*`,
      [leaseToken, limit]
    );
    return rows;
  }

  const database = readJson();
  const now = Date.now();
  const due = database.scheduledEmails
    .filter(
      (email) =>
        new Date(email.send_at).getTime() <= now &&
        (email.status === "pending" ||
          (email.status === "sending" && new Date(email.lease_until).getTime() <= now))
    )
    .sort((left, right) => new Date(left.send_at) - new Date(right.send_at))
    .slice(0, limit);
  for (const email of due) {
    email.status = "sending";
    email.attempt_count += 1;
    email.lease_token = leaseToken;
    email.lease_until = new Date(now + 5 * 60 * 1000).toISOString();
    email.updated_at = new Date().toISOString();
  }
  writeJson(database);
  return due;
}

export async function markScheduledEmailSent(id, leaseToken, { messageId, threadId }) {
  if (usePostgres) {
    const { rows } = await pg.query(
      `UPDATE scheduled_emails
       SET status = 'sent', gmail_message_id = $3, gmail_thread_id = $4,
           sent_at = now(), lease_token = NULL, lease_until = NULL,
           last_error = NULL, updated_at = now()
       WHERE id = $1 AND lease_token = $2 AND status = 'sending'
       RETURNING *`,
      [id, leaseToken, messageId, threadId]
    );
    return rows[0] || null;
  }

  const database = readJson();
  const email = database.scheduledEmails.find(
    (item) => item.id === id && item.lease_token === leaseToken && item.status === "sending"
  );
  if (!email) return null;
  email.status = "sent";
  email.gmail_message_id = messageId;
  email.gmail_thread_id = threadId;
  email.sent_at = new Date().toISOString();
  email.lease_token = null;
  email.lease_until = null;
  email.last_error = null;
  email.updated_at = email.sent_at;
  writeJson(database);
  return email;
}

export async function markScheduledEmailFailed(id, leaseToken, error, retryable = true) {
  if (usePostgres) {
    const { rows } = await pg.query(
      `UPDATE scheduled_emails
       SET status = CASE WHEN $4 AND attempt_count < 5 THEN 'pending' ELSE 'failed' END,
           last_error = $3, lease_token = NULL, lease_until = NULL, updated_at = now()
       WHERE id = $1 AND lease_token = $2 AND status = 'sending'
       RETURNING *`,
      [id, leaseToken, String(error).slice(0, 1000), retryable]
    );
    return rows[0] || null;
  }

  const database = readJson();
  const email = database.scheduledEmails.find(
    (item) => item.id === id && item.lease_token === leaseToken && item.status === "sending"
  );
  if (!email) return null;
  email.status = retryable && email.attempt_count < 5 ? "pending" : "failed";
  email.last_error = String(error).slice(0, 1000);
  email.lease_token = null;
  email.lease_until = null;
  email.updated_at = new Date().toISOString();
  writeJson(database);
  return email;
}

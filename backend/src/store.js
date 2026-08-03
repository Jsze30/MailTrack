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
    return JSON.parse(fs.readFileSync(dataFile, "utf8"));
  } catch {
    return { emails: [], events: [], nextEventId: 1 };
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

# MailTrack

MailTrack is a small personal Gmail extension that embeds one tracking pixel and displays opened status in Gmail Sent.

## Behavior

When a Gmail compose becomes active, the extension creates and registers one tracking ID without changing the draft body.
On Send, the extension pauses Gmail, inserts one zero-size tracking image, triggers Gmail's draft synchronization, and then resumes the original Send action.
It reads the exact message and thread IDs from Gmail's send response instead of guessing from the subject.
When an email client loads the pixel, the backend records an open.
Gmail displays a closed or open envelope in the Sent row and beside the timestamp in a Sent thread.
Opened messages show a compact `2x` count only after more than one recipient open.

New-message composers also display a Send later row beneath the normal send controls.
The time field accepts natural-language values such as `tomorrow 11am`, `tom 11am`, or `tue 11am`, resolves them in the browser's local time zone, and only enables Send later for a future exact hour.
Scheduling creates a real Gmail draft (with its tracking pixel already embedded) that appears in the user's Drafts folder; the Drafts list badges that row with the tracking eye and the scheduled time.
The hourly cron sends each due draft with Gmail's `drafts.send`, moving it from Drafts to Sent in one call, and cancelling a scheduled message also deletes its draft.
The extension popup connects Gmail through OAuth and lists pending scheduled messages with a Cancel action.
Gmail's native Schedule send is not used by this flow; sending drafts requires the `gmail.compose` OAuth scope, so existing users must reconnect Gmail once after upgrading.

The project intentionally does not include link tracking, timelines, analytics dashboards, recipient metadata, or recurring Gmail polling.

## Layout

```text
backend/     Express tracking pixel and compact status API
extension/   Manifest V3 Gmail integration and settings popup
```

## Run the backend locally

```bash
cd backend
npm install
TRACK_SECRET=testsecret \
TOKEN_ENCRYPTION_KEY=replace-with-32-byte-base64-key \
GOOGLE_OAUTH_ID=your-client-id \
GOOGLE_OAUTH_SECRET=your-client-secret \
GOOGLE_REDIRECT_URI=http://localhost:3000/api/oauth/google/callback \
npm run dev
```

The server runs at `http://localhost:3000` and uses `backend/.data/db.json` when `DATABASE_URL` is absent.

## Deploy the backend

Deploy the `backend/` directory to Vercel with `DATABASE_URL`, `TRACK_SECRET`, `CRON_SECRET`, `TOKEN_ENCRYPTION_KEY`, `GOOGLE_OAUTH_ID`, `GOOGLE_OAUTH_SECRET`, and `GOOGLE_REDIRECT_URI` configured.
`TOKEN_ENCRYPTION_KEY` must be a random 32-byte base64 value or a 64-character hexadecimal value and is used to encrypt the Google refresh token at rest.
Configure the Google OAuth web client with the deployed callback URL as an authorized redirect URI.
Configure an external hourly cron to send `POST /api/cron/send-scheduled` with `Authorization: Bearer <CRON_SECRET>`, `Content-Type: application/json`, and body `{}`.
Version 2 keeps the existing `/api/emails` route names so the extension can be rolled out before the stripped backend.

## Load the extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Select Load unpacked and choose the `extension/` directory.
4. Open the MailTrack popup and save the backend URL and shared secret.
5. Select Connect Gmail and finish the Google authorization in the new tab.
6. Confirm the popup displays extension version `2.0.38`.
7. Reload Gmail in a new tab.

## Test

```bash
cd extension && npm test
cd ../backend && npm test
```

## Tracking limits

An open means the recipient's email client loaded images, not that a person necessarily read the message.
Gmail proxies images and may cache them.
MailTrack records a bounded self-view interval when you open your own Sent copy so that its pixel load is excluded from the recipient count.

# MailTrack

MailTrack is a small personal Gmail extension that embeds one tracking pixel and displays opened status in Gmail Sent.

## Behavior

When a Gmail compose becomes active, the extension creates and registers one tracking ID without changing the draft body.
On Send, the extension pauses Gmail, inserts one zero-size tracking image, triggers Gmail's draft synchronization, and then resumes the original Send action.
On Schedule send, it performs the same preparation before Gmail opens the scheduling dialog.
It reads the exact message and thread IDs from Gmail's send response instead of guessing from the subject.
When an email client loads the pixel, the backend records an open.
Gmail displays a closed or open envelope in the Sent row and beside the timestamp in a Sent thread.
Opened messages show a compact `2x` count only after more than one recipient open.
Tracked messages in Gmail's Scheduled tab display a passive eye icon.

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
TRACK_SECRET=testsecret npm run dev
```

The server runs at `http://localhost:3000` and uses `backend/.data/db.json` when `DATABASE_URL` is absent.

## Deploy the backend

Deploy the `backend/` directory to Vercel with `DATABASE_URL` and `TRACK_SECRET` configured.
Version 2 keeps the existing `/api/emails` route names so the extension can be rolled out before the stripped backend.

## Load the extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Select Load unpacked and choose the `extension/` directory.
4. Open the MailTrack popup and save the backend URL and shared secret.
5. Confirm the popup displays extension version `2.0.27`.
6. Reload Gmail in a new tab.

## Test

```bash
cd extension && npm test
cd ../backend && npm test
```

## Tracking limits

An open means the recipient's email client loaded images, not that a person necessarily read the message.
Gmail proxies images and may cache them.
MailTrack records a bounded self-view interval when you open your own Sent copy so that its pixel load is excluded from the recipient count.

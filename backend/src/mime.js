import crypto from "node:crypto";

function encodeHeader(value) {
  const text = String(value || "").replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function wrapBase64(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") || "";
}

function addressHeader(name, values) {
  return values?.length ? [`${name}: ${values.join(", ")}`] : [];
}

export function buildRawMessage({ to, cc = [], bcc = [], subject, text, html }) {
  const boundary = `mailtrack_${crypto.randomBytes(18).toString("hex")}`;
  const lines = [
    ...addressHeader("To", to),
    ...addressHeader("Cc", cc),
    ...addressHeader("Bcc", bcc),
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(html),
    `--${boundary}--`,
    "",
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

export function appendTrackingPixel(html, pixelUrl) {
  const pixel = `<img width="0" height="0" class="mailtrack-img" alt="" style="display:flex" src="${pixelUrl}">`;
  const source = String(html || "");
  if (source.includes(pixelUrl)) return source;
  const quotedReply = source.search(/<(?:blockquote|div)[^>]+class=["'][^"']*gmail_quote/i);
  return quotedReply >= 0
    ? `${source.slice(0, quotedReply)}${pixel}${source.slice(quotedReply)}`
    : `${source}${pixel}`;
}

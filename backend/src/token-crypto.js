import crypto from "node:crypto";

function encryptionKey() {
  const configured = process.env.TOKEN_ENCRYPTION_KEY;
  if (!configured) throw new Error("TOKEN_ENCRYPTION_KEY is not configured");

  const decoded = Buffer.from(configured, "base64");
  if (decoded.length === 32) return decoded;
  if (/^[0-9a-f]{64}$/i.test(configured)) return Buffer.from(configured, "hex");
  throw new Error("TOKEN_ENCRYPTION_KEY must encode exactly 32 bytes");
}

export function encryptToken(token) {
  if (!token) throw new Error("token is required");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptToken(value) {
  const [ivValue, tagValue, encryptedValue, extra] = String(value || "").split(".");
  if (!ivValue || !tagValue || !encryptedValue || extra) {
    throw new Error("encrypted token is invalid");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivValue, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

import { buildRawMessage } from "./mime.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.send",
];

export function googleConfig() {
  const clientId = process.env.GOOGLE_OAUTH_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google OAuth is not configured");
  }
  return { clientId, clientSecret, redirectUri };
}

export function authorizationUrl(state) {
  const { clientId, redirectUri } = googleConfig();
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

async function googleForm(url, values, fetchImpl) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || `Google returned ${response.status}`);
  }
  return payload;
}

export async function exchangeAuthorizationCode(code, fetchImpl = fetch) {
  const { clientId, clientSecret, redirectUri } = googleConfig();
  const tokens = await googleForm(
    TOKEN_URL,
    {
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    },
    fetchImpl
  );
  if (!tokens.access_token) throw new Error("Google did not return an access token");

  const profileResponse = await fetchImpl(USERINFO_URL, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = await profileResponse.json().catch(() => ({}));
  if (!profileResponse.ok || !profile.email || profile.email_verified === false) {
    throw new Error("Google did not return a verified email address");
  }
  return {
    email: String(profile.email).toLocaleLowerCase(),
    refreshToken: tokens.refresh_token || null,
  };
}

export async function refreshAccessToken(refreshToken, fetchImpl = fetch) {
  const { clientId, clientSecret } = googleConfig();
  const tokens = await googleForm(
    TOKEN_URL,
    {
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    },
    fetchImpl
  );
  if (!tokens.access_token) throw new Error("Google did not refresh the access token");
  return tokens.access_token;
}

export async function sendGmailMessage({ refreshToken, message }, fetchImpl = fetch) {
  const accessToken = await refreshAccessToken(refreshToken, fetchImpl);
  return sendGmailMessageWithAccessToken({ accessToken, message }, fetchImpl);
}

export async function sendGmailMessageWithAccessToken(
  { accessToken, message },
  fetchImpl = fetch
) {
  const raw = buildRawMessage(message);
  const response = await fetchImpl(GMAIL_SEND_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.id) {
    const error = new Error(payload.error?.message || `Gmail returned ${response.status}`);
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  return { messageId: payload.id, threadId: payload.threadId || payload.id };
}

export async function revokeGoogleToken(refreshToken, fetchImpl = fetch) {
  const response = await fetchImpl(
    `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }
  );
  if (!response.ok && response.status !== 400) {
    throw new Error(`Google token revocation returned ${response.status}`);
  }
}

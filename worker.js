const COOKIE_NAME = "trei_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 horas

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/informe_ventas/auth/callback") {
      return handleCallback(request, env, url);
    }

    if (url.pathname === "/informe_ventas/auth/logout") {
      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/informe_ventas/",
          "Set-Cookie": `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
        },
      });
    }

    const session = await getSession(request, env);
    if (!session) return redirectToLogin(url, env);

    if (env.ALLOWED_DOMAIN && !String(session.email || "").toLowerCase().endsWith("@" + env.ALLOWED_DOMAIN.toLowerCase())) {
      return new Response("No autorizado: tu cuenta no pertenece al dominio permitido.", { status: 403 });
    }

    return proxyToOrigin(request, env, url);
  },
};

function redirectToLogin(url, env) {
  const redirectUri = `${url.origin}/informe_ventas/auth/callback`;
  const state = encodeURIComponent(url.pathname + url.search);
  const authUrl = new URL(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/oauth2/v2.0/authorize`);
  authUrl.searchParams.set("client_id", env.ENTRA_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_mode", "query");
  authUrl.searchParams.set("scope", "openid profile email");
  authUrl.searchParams.set("state", state);
  return Response.redirect(authUrl.toString(), 302);
}

async function handleCallback(request, env, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "/informe_ventas/";
  if (!code) return new Response("Falta el parámetro 'code' en el callback.", { status: 400 });

  const redirectUri = `${url.origin}/informe_ventas/auth/callback`;
  const tokenRes = await fetch(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.ENTRA_CLIENT_ID,
      client_secret: env.ENTRA_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) return new Response("Error al obtener el token: " + await tokenRes.text(), { status: 502 });

  const tokenData = await tokenRes.json();
  const claims = await verifyIdToken(tokenData.id_token, env);
  if (!claims) return new Response("Token de Entra ID inválido.", { status: 401 });

  const email = claims.preferred_username || claims.email || claims.upn;
  const sessionCookie = await createSessionCookie({ email, name: claims.name }, env);

  return new Response(null, {
    status: 302,
    headers: { "Location": decodeURIComponent(state), "Set-Cookie": sessionCookie },
  });
}

async function verifyIdToken(idToken, env) {
  const [headerB64, payloadB64, sigB64] = idToken.split(".");
  const header = JSON.parse(base64UrlDecode(headerB64));
  const payload = JSON.parse(base64UrlDecode(payloadB64));

  if (payload.aud !== env.ENTRA_CLIENT_ID) return null;
  if (payload.tid !== env.ENTRA_TENANT_ID) return null;
  if (payload.exp * 1000 < Date.now()) return null;

  const jwks = await fetch(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/discovery/v2.0/keys`).then(r => r.json());
  const jwk = jwks.keys.find(k => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlToBytes(sigB64), data);
  return valid ? payload : null;
}

async function createSessionCookie(data, env) {
  const payload = { ...data, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
  const payloadStr = base64UrlEncode(JSON.stringify(payload));
  const sig = await hmacSign(payloadStr, env.SESSION_SECRET);
  const secureFlag = env.ENVIRONMENT === "development" ? "" : "; Secure";
  return `${COOKIE_NAME}=${payloadStr}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secureFlag}`;
}

async function getSession(request, env) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  const [payloadStr, sig] = match[1].split(".");
  if (!payloadStr || !sig) return null;
  if (sig !== await hmacSign(payloadStr, env.SESSION_SECRET)) return null;
  const payload = JSON.parse(base64UrlDecode(payloadStr));
  if (payload.exp * 1000 < Date.now()) return null;
  return payload;
}

async function hmacSign(message, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64UrlEncode(String.fromCharCode(...new Uint8Array(sig)));
}

async function proxyToOrigin(request, env, url) {
  const originUrl = new URL(url.pathname + url.search, env.ORIGIN_BASE_URL);
  const originResp = await fetch(originUrl.toString(), { method: request.method, headers: request.headers });
  const resp = new Response(originResp.body, originResp);
  resp.headers.set("X-Robots-Tag", "noindex, nofollow");
  return resp;
}

function base64UrlEncode(str) { return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function base64UrlDecode(str) { str = str.replace(/-/g, "+").replace(/_/g, "/"); while (str.length % 4) str += "="; return atob(str); }
function base64UrlToBytes(str) { const bin = base64UrlDecode(str); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }

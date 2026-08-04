// ════════════════════════════════════════════════════════════════════════════
// trei-informe-auth — puerta del Informe Comercial
//
// Cambios respecto de la versión actual:
//   1. correoReal()  — lee bien el correo de los invitados externos (#EXT#).
//   2. puedeEntrar() — además del dominio @trei.cl, deja pasar a quien esté en
//                      el padrón del informe, activo y vigente. Así los
//                      externos entran sin necesidad de una lista paralela.
//   3. destinoSeguro() — cierra la redirección abierta del parámetro `state`.
//   4. Validación de `iss` en el id_token.
//   5. SIEMPRE_ACCESO sale del código y pasa a ser una variable de entorno.
//   6. La mantención se lee del KV `trei_mantenimiento` (el que escribe el
//      Panel de Salud) en vez de maintenance.json, que estaba quedando viejo.
//      Requiere el binding MAINTENANCE_KV; sin él, simplemente nunca hay
//      mantención y el portal funciona igual.
//
// Variables a agregar en Cloudflare (ambas son PÚBLICAS, van como Plaintext,
// no como Secret):
//   SUPABASE_URL       = https://owhlpaypipgkihgubvfl.supabase.co
//   SUPABASE_ANON_KEY  = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93aGxwYXlwaXBna2loZ3VidmZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxOTIzNjEsImV4cCI6MjA5NDc2ODM2MX0.64wndm7q6l3kaParSh1gXw-8QX_9bhbbYUIJyCM-cz0
//   BYPASS_MANTENCION  = smendez@trei.cl        (opcional, separado por comas)
//
// Nada de esto le quita acceso a nadie de @trei.cl: la regla es "dominio
// permitido O padrón". El padrón solo suma.
// ════════════════════════════════════════════════════════════════════════════

// El estado de mantención ya no vive en maintenance.json: el Panel de Salud lo
// escribe en el KV `trei_mantenimiento`. Si el binding MAINTENANCE_KV no está
// configurado, se asume que no hay mantención — el portal nunca queda trabado.
async function estadoMantencion(env) {
  if (!env.MAINTENANCE_KV) return { comercial: false, escrituracion: false };
  try {
    const [c, e] = await Promise.all([
      env.MAINTENANCE_KV.get("comercial"),
      env.MAINTENANCE_KV.get("escrituracion"),
    ]);
    return { comercial: c === "on", escrituracion: e === "on" };
  } catch (_) {
    return { comercial: false, escrituracion: false };
  }
}

const COOKIE_NAME = "trei_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 horas
const ESCRITURACION_URL = "https://funnel-escrituracion.smendez.workers.dev/";

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

    const permitido = await puedeEntrar(session.email, env);
    if (!permitido) return respuestaSinAcceso(session.email);

    // El informe ya no lleva la anon key: sus consultas pasan por acá y el
    // worker les pone las credenciales, firmadas con el correo de la sesión.
    if (url.pathname.startsWith("/informe_ventas/db/")) {
      return proxySupabase(request, env, url, session.email);
    }

    // Portal de informes: se muestra al entrar a la raíz. El botón "Entrar"
    // agrega ?ir=1 para saltárselo y pasar directo al informe.
    const isEntryPoint = url.pathname === "/informe_ventas/" || url.pathname === "/informe_ventas";
    if (isEntryPoint && !url.searchParams.has("ir")) {
      return await renderHub(session, env);
    }
    if (url.searchParams.has("ir")) {
      url.searchParams.delete("ir");
    }

    return proxyToOrigin(request, env, url);
  },
};

// ════════════════════════════════════════════════════════════════════════════
// QUIÉN PUEDE ENTRAR
// ════════════════════════════════════════════════════════════════════════════

// Dominio permitido O padrón del informe. Se consulta el padrón solo cuando el
// correo no es del dominio, así la gente de casa no paga la latencia extra.
// Si Supabase no responde, se cae al comportamiento anterior (solo dominio):
// preferimos dejar fuera a un externo antes que dejar el portal abierto.
async function puedeEntrar(email, env) {
  const correo = String(email || "").toLowerCase();
  if (!correo) return false;

  const dominio = (env.ALLOWED_DOMAIN || "").toLowerCase();
  if (dominio && correo.endsWith("@" + dominio)) return true;

  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return false;

  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/informe_puede_entrar`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ p_email: correo }),
    });
    if (!res.ok) return false;
    return (await res.json()) === true;
  } catch (_) {
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PUENTE A SUPABASE
// El navegador nunca ve una llave. Pide a /informe_ventas/db/rest/v1/... y el
// worker reenvía a Supabase firmando un token de 5 minutos con el correo que
// Entra ya validó. La base decide qué filas devuelve según ese correo.
// ════════════════════════════════════════════════════════════════════════════

async function proxySupabase(request, env, url, email) {
  if (!env.SUPABASE_URL || !env.SUPABASE_JWT_SECRET || !env.SUPABASE_ANON_KEY) {
    return new Response("Falta configurar SUPABASE_URL, SUPABASE_ANON_KEY o SUPABASE_JWT_SECRET.", { status: 500 });
  }

  const ruta = url.pathname.replace("/informe_ventas/db", "");
  if (!ruta.startsWith("/rest/v1/")) return new Response("Ruta no permitida.", { status: 403 });

  const now = Math.floor(Date.now() / 1000);
  const token = await firmarJwtHS256({
    aud: "authenticated",
    role: "authenticated",
    sub: await uuidDesdeEmail(email),
    email: String(email).toLowerCase(),
    iat: now,
    exp: now + 300,
  }, env.SUPABASE_JWT_SECRET);

  // Se copian solo las cabeceras que PostgREST necesita; nunca las que venga
  // intentando poner el navegador (apikey o Authorization propias).
  const headers = new Headers();
  for (const h of ["content-type", "prefer", "range", "accept", "accept-profile", "content-profile"]) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("apikey", env.SUPABASE_ANON_KEY);
  headers.set("Authorization", "Bearer " + token);

  const destino = env.SUPABASE_URL + ruta + url.search;
  const res = await fetch(destino, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text(),
  });

  const salida = new Response(res.body, res);
  salida.headers.set("Cache-Control", "no-store");
  salida.headers.delete("set-cookie");
  return salida;
}

async function firmarJwtHS256(payload, secret) {
  const b64 = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
  const cuerpo = b64({ alg: "HS256", typ: "JWT" }) + "." + b64(payload);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const firma = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(cuerpo));
  return cuerpo + "." + b64url(new Uint8Array(firma));
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function uuidDesdeEmail(email) {
  const h = new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode("trei-informe:" + String(email).toLowerCase())));
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function respuestaSinAcceso(email) {
  return new Response(
    `Sin acceso al Informe Comercial.\n\n` +
    `La cuenta ${email} no pertenece al dominio autorizado y no está registrada ` +
    `en el padrón del informe (o su acceso venció).\n\n` +
    `Para solicitarlo, escribe a Control de Gestión indicando este correo.`,
    { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

// ════════════════════════════════════════════════════════════════════════════
// AUTENTICACIÓN
// ════════════════════════════════════════════════════════════════════════════

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

// El UPN de un invitado B2B llega como
//   contralor_estudio.cl#EXT#@treicl.onmicrosoft.com
// y el correo real viene en el claim `email`. Por eso ese va primero.
function correoReal(claims) {
  const directo = claims.email || claims.preferred_username || claims.upn || "";
  if (!directo.includes("#EXT#")) return String(directo).toLowerCase();
  const local = directo.split("#EXT#")[0];
  const corte = local.lastIndexOf("_");
  return (corte === -1 ? local : local.slice(0, corte) + "@" + local.slice(corte + 1)).toLowerCase();
}

// `state` vuelve del callback y se usaba tal cual como Location: un link
// preparado mandaba al usuario fuera del sitio tras un login legítimo.
function destinoSeguro(state, prefijo) {
  let d;
  try { d = decodeURIComponent(state || ""); } catch (_) { return prefijo; }
  return d.startsWith(prefijo) && !d.startsWith("//") ? d : prefijo;
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

  const email = correoReal(claims);
  const sessionCookie = await createSessionCookie({ email, name: claims.name }, env);

  return new Response(null, {
    status: 302,
    headers: {
      "Location": destinoSeguro(state, "/informe_ventas/"),
      "Set-Cookie": sessionCookie,
    },
  });
}

async function verifyIdToken(idToken, env) {
  const [headerB64, payloadB64, sigB64] = idToken.split(".");
  const header = JSON.parse(base64UrlDecode(headerB64));
  const payload = JSON.parse(base64UrlDecode(payloadB64));

  if (payload.aud !== env.ENTRA_CLIENT_ID) return null;
  if (payload.tid !== env.ENTRA_TENANT_ID) return null;
  if (payload.exp * 1000 < Date.now()) return null;
  if (payload.iss && !payload.iss.includes(env.ENTRA_TENANT_ID)) return null;

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
  // En el directorio del informe quedó un index antiguo (la pantalla de clave
  // anterior a Entra) que el servidor entrega antes que index.html. Pidiendo
  // el archivo explícitamente se evita esa precedencia, sin tocar el servidor.
  const ruta = url.pathname.endsWith("/") ? url.pathname + "index.html" : url.pathname;
  const originUrl = new URL(ruta + url.search, env.ORIGIN_BASE_URL);

  // Sin cacheTtl:0, Cloudflare guarda el HTML del informe en el borde y sigue
  // sirviendo una versión vieja después de cada publicación. Pasó: la URL con
  // ?ir=1 quedó devolviendo la pantalla de acceso anterior durante horas.
  const originResp = await fetch(originUrl.toString(), {
    method: request.method,
    headers: request.headers,
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  const resp = new Response(originResp.body, originResp);
  resp.headers.set("X-Robots-Tag", "noindex, nofollow");
  resp.headers.set("Cache-Control", "no-store, must-revalidate");
  return resp;
}

function base64UrlEncode(str) { return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function base64UrlDecode(str) { str = str.replace(/-/g, "+").replace(/_/g, "/"); while (str.length % 4) str += "="; return atob(str); }
function base64UrlToBytes(str) { const bin = base64UrlDecode(str); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }

// ════════════════════════════════════════════════════════════════════════════
// PORTAL DE INFORMES
// ════════════════════════════════════════════════════════════════════════════

async function renderHub(session, env) {
  const name = session.name || session.email || "";
  const email = String(session.email || "").toLowerCase();
  const bypass = (env.BYPASS_MANTENCION || "")
    .split(",").map(e => e.trim().toLowerCase()).filter(Boolean)
    .includes(email);

  const maintenance = await estadoMantencion(env);

  return new Response(hubHtml({
    name,
    email,
    allowedDomain: env.ALLOWED_DOMAIN || "",
    comercialMaint: bypass ? false : !!maintenance.comercial,
    escrituracionMaint: bypass ? false : !!maintenance.escrituracion,
  }), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function cardHtml({ accent, title, desc, href, maint }) {
  if (maint) {
    return `
<div class="kpi-card ${accent} maint">
  <div class="top-row">
    <h3>${escapeHtml(title)}</h3>
    <span class="badge b-maint">En mantención</span>
  </div>
  <p class="desc">${escapeHtml(desc)}</p>
  <div class="go">No disponible</div>
  <div class="maint-note">Estamos actualizando este informe. Vuelve a intentarlo en unos minutos.</div>
</div>`;
  }
  return `
<a class="kpi-card ${accent}" href="${href}">
  <div class="top-row">
    <h3>${escapeHtml(title)}</h3>
    <span class="badge b-ok">Disponible</span>
  </div>
  <p class="desc">${escapeHtml(desc)}</p>
  <div class="go">Entrar <span class="arrow">→</span></div>
</a>`;
}

function hubHtml({ name, email, allowedDomain, comercialMaint, escrituracionMaint }) {
  const cardComercial = cardHtml({
    accent: "c-red",
    title: "Informe Comercial",
    desc: "Ventas, leads y estado comercial en tiempo real.",
    href: "/informe_ventas/?ir=1",
    maint: comercialMaint,
  });
  const cardEscrituracion = cardHtml({
    accent: "c-navy",
    title: "Informe de Etapas de Escrituración",
    desc: "Seguimiento del proceso de escrituración por cliente.",
    href: ESCRITURACION_URL,
    maint: escrituracionMaint,
  });

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Portal de Informes — Trei</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Ubuntu:wght@400;500;700&display=swap" rel="stylesheet">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Ubuntu', Calibri, sans-serif; background: #f7f7f8; color: #111111; font-size: 13px; }
.top-header { background: #fff; color: #111111; padding: 6px 28px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; border-bottom: 2px solid #E1093F; }
.top-header .brand { display: flex; align-items: center; gap: 10px; }
.logo-mark { display:flex; align-items:center; gap:8px; }
.logo-mark .bracket { width:22px; height:22px; border:2.5px solid #E1093F; border-right:none; border-top:none; border-radius:0 0 0 3px; }
.logo-mark .word { line-height:1; }
.logo-mark .word b { font-size:15px; font-weight:700; color:#333; }
.logo-mark .word .sub { display:block; font-size:6px; letter-spacing:1.2px; color:#999; font-weight:700; }
.top-header h1 { font-size: 12px; font-weight: 700; letter-spacing: 0.5px; color: #111111; text-transform: uppercase; padding-left:14px; margin-left:14px; border-left:1px solid #e4e4e8; }
.top-header h1 span { color: #E1093F; }
.top-header .meta { font-size: 10px; color: #888; text-align: right; line-height: 1.4; display:flex; align-items:center; gap:10px; }
.top-header .meta strong { color: #111111; }
.top-header .msft { width:14px; height:14px; flex-shrink:0; }
.top-header .logout { color:#aaa; text-decoration:underline; }
.tabs-bar { background:#111111; padding:7px 28px; font-size:10px; color:#999; letter-spacing:.5px; }
.tabs-bar b { color:#fff; }
.content { padding: 28px 24px 60px; max-width: 1120px; margin: 0 auto; }
.section-title { font-size: 10px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; color: #E1093F; margin-bottom: 4px; }
.section-sub { font-size: 12px; color: #888; margin-bottom: 20px; }
.cards { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
@media (max-width:640px){.cards{grid-template-columns:1fr}}
.kpi-card { background:#fff; border:1.5px solid #e4e4e8; border-radius:8px; padding:22px 20px; position:relative; overflow:hidden; display:flex; flex-direction:column; gap:10px; text-decoration:none; color:inherit; transition: box-shadow .15s, border-color .15s; }
.kpi-card::before { content:''; position:absolute; left:0; top:0; bottom:0; width:4px; }
.kpi-card.c-red::before { background:#E1093F; }
.kpi-card.c-navy::before { background:#111111; }
.kpi-card:not(.maint):hover { box-shadow:0 4px 14px rgba(0,0,0,.08); border-color:#d8d8de; cursor:pointer; }
.kpi-card .top-row { display:flex; justify-content:space-between; align-items:flex-start; }
.kpi-card h3 { font-size:14.5px; font-weight:700; color:#111; }
.kpi-card p.desc { font-size:11.5px; color:#888; margin-top:2px; }
.kpi-card .go { font-size:11px; font-weight:700; color:#E1093F; text-transform:uppercase; letter-spacing:.4px; margin-top:auto; padding-top:6px; }
.badge { display:inline-block; font-size:10px; font-weight:700; border-radius:4px; padding:2px 8px; }
.b-ok { background:#e6f2eb; color:#006400; }
.b-maint { background:#fff0dc; color:#b07800; }
.kpi-card.maint::before { background:#e0a734; }
.kpi-card.maint h3, .kpi-card.maint p.desc { color:#a8a8ae; }
.kpi-card.maint .go { color:#c9c9d1; }
.maint-note { font-size:11px; color:#b07800; background:#fff0dc; border-radius:5px; padding:5px 8px; }
</style>
</head>
<body>

<div class="top-header">
  <div class="brand">
    <div class="logo-mark">
      <div class="bracket"></div>
      <div class="word"><b>trei</b><span class="sub">INMOBILIARIA</span></div>
    </div>
    <h1>Portal de <span>Informes</span></h1>
  </div>
  <div class="meta">
    <svg class="msft" width="14" height="14" viewBox="0 0 15 15"><rect width="7" height="7" fill="#F25022"/><rect x="8" width="7" height="7" fill="#7FBA00"/><rect y="8" width="7" height="7" fill="#00A4EF"/><rect x="8" y="8" width="7" height="7" fill="#FFB900"/></svg>
    <div><strong>${escapeHtml(name)}</strong><br>${escapeHtml(email)}</div>
    <a class="logout" href="/informe_ventas/auth/logout">Salir</a>
  </div>
</div>

<div class="tabs-bar"><b>Sesión validada</b> · Microsoft Entra ID${allowedDomain ? " — dominio " + escapeHtml(allowedDomain) : ""}</div>

<div class="content">
  <div class="section-title">Acceso a informes</div>
  <div class="section-sub">Elige el informe al que quieres entrar.</div>
  <div class="cards">
    ${cardComercial}
    ${cardEscrituracion}
  </div>
</div>

</body>
</html>`;
}

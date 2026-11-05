import { createHash } from "node:crypto";

/** @type {import('next').NextConfig} */

// --- Origin helpers -------------------------------------------------------
// next.config.mjs is plain ESM and cannot import the TS `@/lib/env` module,
// so we read the same env vars straight off process.env here. All values are
// optional; every helper degrades to a safe default so dev never breaks.
const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";

function urlHost(u) {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
}
function urlOrigin(u) {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
}

// VERCEL_ENV lo expone Vercel también en build ("production" | "preview" |
// "development"); local/CI queda sin setear. Es la misma llave que usa el
// fail-fast de lib/env.ts (NODE_ENV=production también vale en Preview y CI).
const isVercelProduction = process.env.VERCEL_ENV === "production";

// Server Actions origin allow-list: the configured public app host, plus
// localhost:3000 everywhere EXCEPT Production (A3b-S-obs): in prod a
// `localhost` origin is never legit, and dejarlo abría la puerta a un POST de
// server action desde un tab local con la cookie de sesión del dominio.
const allowedOrigins = Array.from(
  new Set([isVercelProduction ? "" : "localhost:3000", urlHost(appUrl)].filter(Boolean)),
);

// --- Id del build (CF-RT, §28 E) ------------------------------------------
// El indicador realtime decía «Hay una versión nueva · Recargá» ante CUALQUIER respuesta rara de la action del token,
// y en prod la causa era una action no registrada en el MISMO build: recargar no arreglaba nada. Ahora «versión nueva»
// exige la prueba: el cliente compara el id horneado en su bundle (`NEXT_PUBLIC_BUILD_ID`, vía `env`) con el header
// `x-build-id` de una respuesta fresca (`createBuildChangedProbe` en lib/realtime-client-state.ts).
// - Del commit de Vercel (`VERCEL_GIT_COMMIT_SHA`, expuesto también en build) y NO de `Date.now()` ni del buildId de
//   Next: el build de Next carga esta config en más de un proceso (workers de webpack) y un valor por proceso haría
//   que el header y el bundle no coincidan nunca → «versión nueva» falsa en cada falla. Mismo commit = mismos ids de
//   action (son hash de archivo + export), así que un redeploy del mismo commit no es «versión nueva» y está bien.
// - Hasheado: no publicar el sha del repo en cada respuesta.
// - Sin sha (local, CI) queda vacío: sin header ni id, el cliente nunca dice «versión nueva» por la action (el chunk
//   que no carga sigue siendo `StaleBuildError`, otra señal).
export function buildIdFrom(env) {
  const sha = (env && env.VERCEL_GIT_COMMIT_SHA) || "";
  if (!sha) return "";
  return createHash("sha256").update(`kinesoft-build:${sha}`).digest("hex").slice(0, 16);
}
export const BUILD_ID = buildIdFrom(process.env);

// --- Content-Security-Policy (Report-Only) --------------------------------
// Conservative, non-blocking policy. Report-Only means violations are only
// reported (browser console), never enforced — safe to ship without breaking
// the app while we observe real traffic before flipping to enforcing mode.
const supabaseOrigin = urlOrigin(supabaseUrl); // e.g. https://xxxx.supabase.co
// TV-1c (AUDIT `t5-csp-com-ar`): `*.mercadopago.com` NO matchea `auth.mercadopago.com.ar` ni
// `www.mercadopago.com.ar` (el comodín de CSP cubre subdominios, no un TLD distinto). El OAuth de MP Connect y el
// checkout argentino viven en `.com.ar`: hoy van por navegación de nivel superior (no los rige la CSP), pero el día
// que la global pase a enforcing un redirect de submit o un frame quedaría bloqueado. Se suma junto a cada `.com`.
const MP_FRAME = "https://*.mercadopago.com https://*.mercadopago.com.ar https://*.mercadolibre.com";
const MP = `${MP_FRAME} https://sdk.mercadopago.com`;
const SUPA = [supabaseOrigin, "https://*.supabase.co"].filter(Boolean).join(" ");

/**
 * Origen WebSocket del Realtime de Supabase (SV07b): `https://x.supabase.co` →
 * `wss://x.supabase.co` (`http://127.0.0.1:54321` → `ws://…` en un Supabase
 * local). Antes `connect-src` tenía `wss:` pelado, que habilita un socket a
 * CUALQUIER host: el día que la CSP pase a enforcing, un script inyectado podría
 * sacar datos por ahí. El único socket legítimo de la app es el canal de la
 * agenda (`lib/realtime-client-supabase.ts`); el driver `local` es SSE same-origin
 * ('self'). Sin URL configurada no hay socket posible → sin entrada ws.
 */
export function realtimeWsOrigin(u) {
  try {
    const url = new URL(u);
    if (url.protocol === "https:") return `wss://${url.host}`;
    if (url.protocol === "http:") return `ws://${url.host}`;
    return "";
  } catch {
    return "";
  }
}
const SUPA_WS = realtimeWsOrigin(supabaseUrl);

/**
 * Endpoint de reportes CSP de Sentry derivado del DSN (A3b-S-obs):
 *   https://<key>@o1.ingest.us.sentry.io/<id>
 *   → https://o1.ingest.us.sentry.io/api/<id>/security/?sentry_key=<key>&sentry_environment=<env>
 * Sin DSN (o DSN inválido) no hay report-uri: los reportes quedan solo en la
 * consola del navegador, como hasta A3.
 */
export function sentryCspReportUri(dsn, environment) {
  if (!dsn) return "";
  try {
    const u = new URL(dsn);
    const segs = u.pathname.split("/").filter(Boolean);
    const projectId = segs.pop();
    if (!u.username || !projectId) return "";
    const prefix = segs.length ? "/" + segs.join("/") : "";
    const qs = new URLSearchParams({ sentry_key: u.username });
    if (environment) qs.set("sentry_environment", environment);
    return `${u.protocol}//${u.host}${prefix}/api/${projectId}/security/?${qs.toString()}`;
  } catch {
    return "";
  }
}
const sentryDsn = process.env.SENTRY_DSN || "";
const cspReportUri = sentryCspReportUri(sentryDsn, process.env.VERCEL_ENV || process.env.NODE_ENV);

const cspReportOnly = [
  "default-src 'self'",
  // 'unsafe-inline' + 'unsafe-eval' are required by Next.js (dev overlay, RSC
  // inline bootstrap). Kept permissive intentionally for this first pass.
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${MP}`,
  // VX F-e: sin fonts.googleapis.com. Onest y JetBrains Mono pasan a next/font (F-a), que descarga los woff2 en
  // build y los sirve same-origin desde /_next/static/media con su @font-face inline: el browser ya no pide nada a
  // Google (privacidad del paciente, un handshake menos en la primera carga). Dejar el host habilitado solo abriría
  // una salida de estilos a un tercero que ya no usamos.
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: https: ${SUPA}`,
  // Supabase Storage: signed URLs de archivos del paciente y media de la biblioteca.
  `media-src 'self' data: blob: https: ${SUPA}`,
  // Sigue Report-Only; `wss:` acotado al host de Supabase (ver `realtimeWsOrigin`).
  `connect-src 'self' https: ${SUPA_WS} data: blob: ${SUPA} ${MP}`,
  // Videos de ejercicios embebidos (lib/exercise-media.ts → youtube-nocookie) + checkout de MP.
  `frame-src 'self' https://www.youtube-nocookie.com ${MP_FRAME}`,
  // VX F-e: sin fonts.gstatic.com, mismo motivo que style-src (next/font sirve los woff2 desde 'self').
  "font-src 'self' data:",
  // MB-0b (C-MB5): el service worker (/sw.js) y el manifest son same-origin. `default-src 'self'` ya los cubre por
  // fallback, pero se declaran explícitos para que un cambio futuro de `script-src`/`default-src` no rompa el SW.
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'self'",
  // form-action también rige los REDIRECTS de un submit: el portal postea a
  // /api/auth/google, que redirige a Supabase /auth/v1/authorize y de ahí a
  // accounts.google.com. Sin estos hosts, el login con Google del paciente
  // quedaría bloqueado el día que la CSP pase a enforcing. PL-2e: lo mismo con Facebook
  // (/api/auth/oauth/facebook → Supabase → www/m.facebook.com).
  `form-action 'self' ${SUPA} https://accounts.google.com https://www.facebook.com https://m.facebook.com ${MP_FRAME}`,
  "object-src 'none'",
  "frame-ancestors 'none'",
  // report-uri (legacy, Firefox/Safari) + report-to (Chromium, vía Reporting-Endpoints).
  cspReportUri ? `report-uri ${cspReportUri}` : "",
  cspReportUri ? "report-to csp-endpoint" : "",
]
  .filter(Boolean)
  .map((d) => d.replace(/\s+/g, " ").trim())
  .join("; ");

// --- Content-Security-Policy ENFORCED solo en Plataforma (BO4) ------------
// Plan §19.5 fila BO4: «CSP en enforce solo en /plataforma». Plataforma es la superficie de más poder (escribe en
// todos los consultorios, abre sesiones de soporte, da superadmin) y la más chica: pocas pantallas, sin Mercado Pago,
// sin portal del paciente, sin embeds de terceros salvo el reproductor de YouTube nocookie del catálogo. Ahí se
// puede bloquear de verdad sin romper nada; el resto de la app sigue Report-Only hasta medir su tráfico.
//
// Qué se cerró respecto de la Report-Only global (y por qué):
//   - script-src sin Mercado Pago y, en producción, sin 'unsafe-eval' (Next 14 solo lo usa el overlay de dev; el
//     build de prod de estas rutas no tiene eval/new Function: se verificó en los chunks al cerrar BO4).
//     'unsafe-inline' se queda: el bootstrap de RSC es inline y no hay nonces (middleware de nonce = otra ola).
//   - img-src / media-src sin `https:` comodín: solo same-origin, data:/blob: (QR del TOTP, previews) y Supabase
//     (Storage). Avatares de Google (lh3) y de Facebook (platform-lookaside, PL-2e) por la foto del perfil.
//   - connect-src sin `https:` comodín: same-origin (server actions, RSC), Supabase (REST/Auth/Storage) y su socket.
//     Un script inyectado no puede sacar datos a un host cualquiera.
//   - form-action 'self': en Plataforma no hay login con Google ni checkout; el único form nativo es el sign-out.
//   - frame-src solo youtube-nocookie (lo que embebe lib/exercise-media-internal.ts).
//   - style-src / font-src sin Google Fonts (VX F-e): las fuentes van por next/font, same-origin.
const isDevServer = process.env.NODE_ENV !== "production";
export const platformCspPaths = ["/plataforma/:path*", "/plataforma-mfa/:path*"];
const cspPlatformEnforced = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDevServer ? " 'unsafe-eval'" : ""}`,
  // VX F-e: sin Google Fonts (next/font las sirve same-origin; ver la Report-Only).
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${SUPA} https://lh3.googleusercontent.com https://platform-lookaside.fbsbx.com`,
  `media-src 'self' data: blob: ${SUPA}`,
  // En dev el HMR de Next abre un websocket al mismo host (ws://localhost:3000): 'self' lo cubre en CSP3, el
  // ws://localhost:* queda por los browsers que todavía no mapean 'self' a ws.
  `connect-src 'self' ${SUPA} ${SUPA_WS}${isDevServer ? " ws://localhost:*" : ""}`,
  "frame-src https://www.youtube-nocookie.com",
  "font-src 'self' data:",
  // MB-0b (C-MB5): mismo motivo que en la Report-Only (el SW también se registra desde PlatformShell, MB-D5).
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  cspReportUri ? `report-uri ${cspReportUri}` : "",
  cspReportUri ? "report-to csp-endpoint" : "",
]
  .filter(Boolean)
  .map((d) => d.replace(/\s+/g, " ").trim())
  .join("; ");

// --- Content-Security-Policy ENFORCED en las pantallas de sala (TV-1c, plan §26.4, D9) ------------------------
// `/tv` corre SIN Actor en una tele del consultorio, con una cookie de dispositivo de 180 días, y muestra nombres de
// pacientes: un script inyectado ahí lee el feed sin que nadie esté mirando la pantalla. Y es la superficie más
// angosta de todas: no hay Mercado Pago, ni OAuth, ni formularios a terceros, ni archivos del paciente. Lo único que
// sale del origen es el socket de Supabase (llamados en vivo) y el reproductor de YouTube nocookie (el video de la
// sala). Por eso se cierra más que Plataforma:
//   - img-src / media-src sin Supabase ni avatares OAuth: la pantalla no muestra fotos ni Storage; el video es un
//     iframe de YouTube (lo rige frame-src), no un <video>.
//   - connect-src: same-origin (server actions del feed y del vínculo) + Supabase REST (token de Realtime) y su wss.
//   - script-src: 'unsafe-inline' por el bootstrap de RSC (sin nonces, igual que Plataforma); 'unsafe-eval' solo en
//     dev por el overlay de Next.
// El Referrer-Policy global (strict-origin-when-cross-origin) NO se pisa: con `same-origin` el embed de YouTube
// no recibe Referer y responde «Error 153» (plan §26.4). `:path*` también matchea `/tv` pelado.
export const tvCspPaths = ["/tv/:path*"];
const cspTvEnforced = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDevServer ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self'",
  // Mismo motivo que en Plataforma para el ws://localhost:* de dev (HMR).
  `connect-src 'self' ${SUPA} ${SUPA_WS}${isDevServer ? " ws://localhost:*" : ""}`,
  "frame-src https://www.youtube-nocookie.com",
  "font-src 'self' data:",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  cspReportUri ? `report-uri ${cspReportUri}` : "",
  cspReportUri ? "report-to csp-endpoint" : "",
]
  .filter(Boolean)
  .map((d) => d.replace(/\s+/g, " ").trim())
  .join("; ");

// --- Report-Only de /configuracion: alta embebida de WhatsApp (WA-U1, plan §26.3 fila INT) ------------------
// En `sandbox`/`live` la pestaña WhatsApp carga el SDK de Facebook (`connect.facebook.net/…/sdk.js`) y `FB.login`
// abre el Embedded Signup: el SDK monta iframes de `www`/`web`/`staticxx.facebook.com` (xd_arbiter) y le pega a
// `graph.facebook.com`. Se habilita SOLO en esta ruta (el plan lo pide así): sumarlo a la global abría un script de
// Meta en el portal, el turnero y la agenda, que no lo usan. Es la MISMA clave que la global en una entrada
// posterior de `headers()`, así que la reemplaza (ver el comentario de Permissions-Policy). connect-src e img-src ya
// tienen `https:` pelado en la Report-Only; los hosts van explícitos igual para que el día que pase a enforcing (sin
// el comodín) la pestaña no se rompa en silencio. NO se manda `Cross-Origin-Opener-Policy: same-origin`: cortaría el
// `window.opener` del popup de Meta y el `postMessage` con el resultado del alta nunca volvería.
export const configuracionCspPaths = ["/configuracion", "/configuracion/:path*"];
const FB_SCRIPT = "https://connect.facebook.net";
const FB_FRAME = "https://www.facebook.com https://web.facebook.com https://staticxx.facebook.com";
const FB_API = "https://graph.facebook.com https://www.facebook.com";
const cspReportOnlyConfiguracion = cspReportOnly
  .split("; ")
  .map((d) => {
    const name = d.split(" ")[0];
    if (name === "script-src") return `${d} ${FB_SCRIPT}`;
    if (name === "frame-src") return `${d} ${FB_FRAME}`;
    if (name === "connect-src" || name === "img-src") return `${d} ${FB_API}`;
    return d;
  })
  .join("; ");

// Permissions-Policy: la global apaga cámara, micrófono y geolocalización en toda la app. `/tv` necesita además
// autoplay (el video de la sala arranca solo, también dentro del iframe de YouTube), fullscreen (la tele en modo
// kiosco) y screen-wake-lock (que la pantalla no se apague). En Next, cuando dos entradas de `headers()` matchean y
// ponen la MISMA clave, gana la última: por eso la de `/tv` repite las tres globales en vez de sumar solo las nuevas.
const PERMISSIONS_POLICY_GLOBAL = "camera=(), microphone=(), geolocation=()";
const PERMISSIONS_POLICY_TV = `${PERMISSIONS_POLICY_GLOBAL}, autoplay=(self "https://www.youtube-nocookie.com"), fullscreen=(self), screen-wake-lock=(self)`;

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: PERMISSIONS_POLICY_GLOBAL },
  { key: "Content-Security-Policy-Report-Only", value: cspReportOnly },
  ...(cspReportUri ? [{ key: "Reporting-Endpoints", value: `csp-endpoint="${cspReportUri}"` }] : []),
  // HSTS solo en Production: en Preview (*.vercel.app) Vercel ya manda el suyo
  // y `preload` sobre un dominio que no es nuestro no aplica; en local rompería
  // http://localhost si algún día se sirve bajo un host real.
  ...(isVercelProduction
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

// --- Renderers de la historia clínica (FC-1c) ------------------------------
// Exportados para `tests/unit/hc-heavy-deps.test.ts` (fija que sigan acá).
export const HC_SERVER_EXTERNAL_PACKAGES = ["@react-pdf/renderer", "docx"];
export const HC_PDF_FONTS_GLOB = "./lib/hc-pdf/fonts/**/*";
// FC-1c (hallazgo del spike): pdfkit 0.20 carga las métricas de Helvetica con `require("#standard-fonts/Helvetica")`
// (un `imports` de su package.json) y el trazado de Next 14 no sigue esos specifiers: el `.nft.json` de la ruta salía
// sin `pdfkit/js/standard-fonts/` y cualquier PDF tiraba MODULE_NOT_FOUND en la función. react-pdf SIEMPRE suma
// Helvetica al final de la pila de fuentes (`@react-pdf/layout`), así que se carga aunque no se use. ~184 kB.
export const HC_PDFKIT_STANDARD_FONTS_GLOB = "./node_modules/pdfkit/js/standard-fonts/**/*";
// FC-2g: el spike (`/api/hc-spike`) se borró; `/api/pacientes/**` cubre las dos rutas de descarga de C-FC7.
// FC-2h: la descarga del portal re-renderiza el snapshot si falta el PDF guardado (acotado a «documentos»).
export const HC_PDF_ROUTES = ["/api/pacientes/**", "/pacientes/**", "/portal/c/*/documentos/**"];

const nextConfig = {
  reactStrictMode: true,
  // CF-RT: el id que compara el cliente (ver `buildIdFrom`). Sin id no se define: `process.env.NEXT_PUBLIC_BUILD_ID`
  // queda `undefined` en el bundle y el probe responde «no se sabe».
  // [CF2-ZF4] `NEXT_PUBLIC_PWA` (interruptor MB-D6, `components/pwa/sw-register.tsx`) SIEMPRE definido: sin la variable,
  // Next no reemplaza `process.env.NEXT_PUBLIC_PWA` y webpack mete el polyfill de `process` (~0,8 kB gz) en el layout
  // `(app)` y `(platform)`, es decir en el first load de todas las rutas con sesión. "" se comporta igual que ausente
  // (solo "off" desregistra).
  env: { NEXT_PUBLIC_PWA: process.env.NEXT_PUBLIC_PWA ?? "", ...(BUILD_ID ? { NEXT_PUBLIC_BUILD_ID: BUILD_ID } : {}) },
  experimental: {
    // PL-2b (PL-D22): el comprobante de pago viaja en el cuerpo de la server action (≤ 4 MB + campos del form). El
    // default de Next (1 MB) lo cortaba antes de llegar a la validación; 4.5 MB deja el margen del multipart y sigue
    // acotando el cuerpo de TODAS las actions (el tope fino de 4 MB lo aplica `readReceiptFile`).
    serverActions: { allowedOrigins, bodySizeLimit: "4.5mb" },
    // Next 14 solo corre instrumentation.ts con este flag. Sin SENTRY_DSN,
    // register() retorna sin importar nada.
    instrumentationHook: true,
    // FC-1c (§24.6, C-FC5): los renderers de la HC corren SOLO en el server y se cargan de node_modules tal cual, sin
    // pasar por webpack. react-pdf 4 es ESM puro (yoga en wasm embebido en base64, pdfkit, fontkit) y docx trae su
    // propio jszip: bundlearlos en la capa RSC los resolvería con la condición `react-server` de React y sumaría
    // varios MB a cada ruta que los importe. Externos, Node los resuelve con su `react` normal y el trazado
    // (`.nft.json`) copia los paquetes a la función. Verificado en el spike local (`app/api/hc-spike`, 18-oct):
    // `next build` + `next start` renderiza el PDF y el .docx, y el .nft.json de la ruta lleva react-pdf, yoga,
    // pdfkit, fontkit y docx.
    serverComponentsExternalPackages: HC_SERVER_EXTERNAL_PACKAGES,
    // FC-1c: el renderer abre las fuentes con `path.join(process.cwd(), "lib/hc-pdf/fonts/…")`, que el trazado
    // estático de Next no sigue: sin esto la función de Vercel sale sin los .ttf y el render tira ENOENT. Lo mismo
    // con las métricas de Helvetica de pdfkit (ver `HC_PDFKIT_STANDARD_FONTS_GLOB`). Las claves son rutas (picomatch
    // con `contains`) de todo lo que puede renderizar un PDF: las rutas de descarga de C-FC7 y el perfil
    // del paciente (la action de compartir de C-FC6 arma el PDF ahí).
    outputFileTracingIncludes: {
      ...Object.fromEntries(HC_PDF_ROUTES.map((r) => [r, [HC_PDF_FONTS_GLOB, HC_PDFKIT_STANDARD_FONTS_GLOB]])),
      // CF3 (BR-H): la imagen OG de la sede lee la foto con `readFile(process.cwd() + "/public/sede/…")`, que el trazado
      // estático no sigue: sin esto la función de Vercel sale sin el jpg y la OG cae al color sólido.
      // Clave = glob de picomatch sobre la ruta (`[slug]` sería una clase de caracteres; la OG lleva sufijo de hash).
      "/*/opengraph-image*": ["./public/sede/hero-consultorio-og.jpg"],
    },
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.supabase.co" },
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
      // PL-2e: avatar de Facebook (= OAUTH_AVATAR_HOSTS de lib/identity/oauth-profile.ts).
      { protocol: "https", hostname: "platform-lookaside.fbsbx.com" },
    ],
  },
  async headers() {
    return [
      // Índice 0 = la global (los tests de observability/realtime leen `[0]`).
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
      // CF3 (BR-H): fotos del hero de la sede. Sin hash en el nombre (son de `public/`), así que no van `immutable`:
      // una semana de cache + revalidación en segundo plano, en vez del `max-age=0` por defecto que revalidaba la foto
      // en cada visita. Si se reemplaza una foto, se publica con otro nombre.
      {
        source: "/sede/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=604800, stale-while-revalidate=86400" }],
      },
      // BO4: se SUMA a la global (la Report-Only sigue llegando y reportando); el browser aplica las dos y la
      // enforced es la que bloquea. `:path*` también matchea `/plataforma` pelado.
      ...platformCspPaths.map((source) => ({
        source,
        headers: [{ key: "Content-Security-Policy", value: cspPlatformEnforced }],
      })),
      // TV-1c: igual que Plataforma, se SUMA a la global (la Report-Only sigue reportando). La Permissions-Policy sí
      // reemplaza a la global (misma clave, entrada posterior): por eso repite sus directivas.
      ...tvCspPaths.map((source) => ({
        source,
        headers: [
          { key: "Content-Security-Policy", value: cspTvEnforced },
          { key: "Permissions-Policy", value: PERMISSIONS_POLICY_TV },
        ],
      })),
      // WA-U1: la Report-Only de /configuracion (global + Facebook) reemplaza a la global en esa ruta (misma clave).
      ...configuracionCspPaths.map((source) => ({
        source,
        headers: [{ key: "Content-Security-Policy-Report-Only", value: cspReportOnlyConfiguracion }],
      })),
      // MB-0b (C-MB5): el navegador revisa /sw.js en cada navegación; sin caché HTTP un deploy nuevo del SW llega en
      // la próxima carga (riesgo «SW viejo pegado», junto con `updateViaCache: "none"` y `skipWaiting`). Va después
      // de las CSP: el índice 0 sigue siendo la global (lo leen los tests de observability/realtime/CSP).
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
      // CF-RT: el build que sirve cada respuesta (ver `buildIdFrom`). Entrada propia al final y no dentro de la global:
      // el índice 0 lo leen los tests y la clave no pisa nada. Lo consulta el cliente con un HEAD a /offline.html.
      ...(BUILD_ID ? [{ source: "/(.*)", headers: [{ key: "x-build-id", value: BUILD_ID }] }] : []),
    ];
  },
};

/**
 * Sentry build-time (A3b-S-obs): solo se envuelve la config si hay SENTRY_DSN.
 * Sin DSN el build es exactamente el de antes (sin loaders de Sentry, sin
 * plugin de webpack, sin warnings): no-op total.
 *
 * Con DSN:
 *   - source maps se generan y suben SOLO si hay SENTRY_AUTH_TOKEN (+ org/
 *     project); sin token, `sourcemaps.disable` evita que el plugin intente
 *     subir y falle o ensucie el log.
 *   - sin SDK de cliente (no hay sentry.client.config / instrumentation-client):
 *     las rutas públicas tienen presupuesto de 120 kB gz (VX F-e,
 *     scripts/bundle-groups.mjs) y el SDK de browser suma decenas de kB a
 *     TODAS las rutas. Los errores de
 *     cliente quedan fuera hasta C1 (perf); los reportes de CSP sí llegan.
 *   - buildTimeInstrumentation off: no instrumentamos dependencias (Prisma,
 *     http) en build; solo queremos captura de errores + sampling bajo.
 */
// Import dinámico y solo con DSN: sin DSN ni se carga el módulo. Se usa el
// subpath `@sentry/nextjs/config` porque la raíz del paquete resuelve al SDK de
// server CJS entero y Node no detecta `withSentryConfig` como named export
// desde un .mjs ("Named export not found").
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
const withSentryConfig = sentryDsn ? (await import("@sentry/nextjs/config")).withSentryConfig : null;
const withSentry = withSentryConfig
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: sentryAuthToken,
      silent: !process.env.CI,
      telemetry: false,
      sourcemaps: { disable: !sentryAuthToken },
      release: { create: !!sentryAuthToken },
      buildTimeInstrumentation: false,
      widenClientFileUpload: false,
    })
  : nextConfig;

export default withSentry;

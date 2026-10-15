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

// --- Content-Security-Policy (Report-Only) --------------------------------
// Conservative, non-blocking policy. Report-Only means violations are only
// reported (browser console), never enforced — safe to ship without breaking
// the app while we observe real traffic before flipping to enforcing mode.
const supabaseOrigin = urlOrigin(supabaseUrl); // e.g. https://xxxx.supabase.co
const MP = "https://*.mercadopago.com https://*.mercadolibre.com https://sdk.mercadopago.com";
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
  // Google Fonts: app/layout.tsx carga Onest + JetBrains Mono con <link>
  // (CSS de fonts.googleapis.com, woff2 de fonts.gstatic.com).
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  `img-src 'self' data: blob: https: ${SUPA}`,
  // Supabase Storage: signed URLs de archivos del paciente y media de la biblioteca.
  `media-src 'self' data: blob: https: ${SUPA}`,
  // Sigue Report-Only; `wss:` acotado al host de Supabase (ver `realtimeWsOrigin`).
  `connect-src 'self' https: ${SUPA_WS} data: blob: ${SUPA} ${MP}`,
  // Videos de ejercicios embebidos (lib/exercise-media.ts → youtube-nocookie) + checkout de MP.
  "frame-src 'self' https://www.youtube-nocookie.com https://*.mercadopago.com https://*.mercadolibre.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "base-uri 'self'",
  // form-action también rige los REDIRECTS de un submit: el portal postea a
  // /api/auth/google, que redirige a Supabase /auth/v1/authorize y de ahí a
  // accounts.google.com. Sin estos hosts, el login con Google del paciente
  // quedaría bloqueado el día que la CSP pase a enforcing. PL-2e: lo mismo con Facebook
  // (/api/auth/oauth/facebook → Supabase → www/m.facebook.com).
  `form-action 'self' ${SUPA} https://accounts.google.com https://www.facebook.com https://m.facebook.com https://*.mercadopago.com https://*.mercadolibre.com`,
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
const isDevServer = process.env.NODE_ENV !== "production";
export const platformCspPaths = ["/plataforma/:path*", "/plataforma-mfa/:path*"];
const cspPlatformEnforced = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDevServer ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  `img-src 'self' data: blob: ${SUPA} https://lh3.googleusercontent.com https://platform-lookaside.fbsbx.com`,
  `media-src 'self' data: blob: ${SUPA}`,
  // En dev el HMR de Next abre un websocket al mismo host (ws://localhost:3000): 'self' lo cubre en CSP3, el
  // ws://localhost:* queda por los browsers que todavía no mapean 'self' a ws.
  `connect-src 'self' ${SUPA} ${SUPA_WS}${isDevServer ? " ws://localhost:*" : ""}`,
  "frame-src https://www.youtube-nocookie.com",
  "font-src 'self' data: https://fonts.gstatic.com",
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

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy-Report-Only", value: cspReportOnly },
  ...(cspReportUri ? [{ key: "Reporting-Endpoints", value: `csp-endpoint="${cspReportUri}"` }] : []),
  // HSTS solo en Production: en Preview (*.vercel.app) Vercel ya manda el suyo
  // y `preload` sobre un dominio que no es nuestro no aplica; en local rompería
  // http://localhost si algún día se sirve bajo un host real.
  ...(isVercelProduction
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // PL-2b (PL-D22): el comprobante de pago viaja en el cuerpo de la server action (≤ 4 MB + campos del form). El
    // default de Next (1 MB) lo cortaba antes de llegar a la validación; 4.5 MB deja el margen del multipart y sigue
    // acotando el cuerpo de TODAS las actions (el tope fino de 4 MB lo aplica `readReceiptFile`).
    serverActions: { allowedOrigins, bodySizeLimit: "4.5mb" },
    // Next 14 solo corre instrumentation.ts con este flag. Sin SENTRY_DSN,
    // register() retorna sin importar nada.
    instrumentationHook: true,
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
      // BO4: se SUMA a la global (la Report-Only sigue llegando y reportando); el browser aplica las dos y la
      // enforced es la que bloquea. `:path*` también matchea `/plataforma` pelado.
      ...platformCspPaths.map((source) => ({
        source,
        headers: [{ key: "Content-Security-Policy", value: cspPlatformEnforced }],
      })),
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
 *     las rutas públicas ya están en ~140-148 kB gz con presupuesto de 150 kB y
 *     el SDK de browser suma decenas de kB a TODAS las rutas. Los errores de
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

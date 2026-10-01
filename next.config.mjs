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
  `connect-src 'self' https: wss: data: blob: ${SUPA} ${MP}`,
  // Videos de ejercicios embebidos (lib/exercise-media.ts → youtube-nocookie) + checkout de MP.
  "frame-src 'self' https://www.youtube-nocookie.com https://*.mercadopago.com https://*.mercadolibre.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "base-uri 'self'",
  // form-action también rige los REDIRECTS de un submit: el portal postea a
  // /api/auth/google, que redirige a Supabase /auth/v1/authorize y de ahí a
  // accounts.google.com. Sin estos hosts, el login con Google del paciente
  // quedaría bloqueado el día que la CSP pase a enforcing.
  `form-action 'self' ${SUPA} https://accounts.google.com https://*.mercadopago.com https://*.mercadolibre.com`,
  "object-src 'none'",
  "frame-ancestors 'none'",
  // report-uri (legacy, Firefox/Safari) + report-to (Chromium, vía Reporting-Endpoints).
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
    serverActions: { allowedOrigins },
    // Next 14 solo corre instrumentation.ts con este flag. Sin SENTRY_DSN,
    // register() retorna sin importar nada.
    instrumentationHook: true,
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.supabase.co" },
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
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

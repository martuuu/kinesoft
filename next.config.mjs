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

// Server Actions origin allow-list: always localhost:3000 for dev, plus the
// configured public app host (prod / preview) when NEXT_PUBLIC_APP_URL is set.
const allowedOrigins = Array.from(new Set(["localhost:3000", urlHost(appUrl)].filter(Boolean)));

// --- Content-Security-Policy (Report-Only) --------------------------------
// Conservative, non-blocking policy. Report-Only means violations are only
// reported (browser console), never enforced — safe to ship without breaking
// the app while we observe real traffic before flipping to enforcing mode.
const supabaseOrigin = urlOrigin(supabaseUrl); // e.g. https://xxxx.supabase.co
const MP = "https://*.mercadopago.com https://*.mercadolibre.com https://sdk.mercadopago.com";
const SUPA = [supabaseOrigin, "https://*.supabase.co"].filter(Boolean).join(" ");

const cspReportOnly = [
  "default-src 'self'",
  // 'unsafe-inline' + 'unsafe-eval' are required by Next.js (dev overlay, RSC
  // inline bootstrap). Kept permissive intentionally for this first pass.
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${MP}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: https: ${SUPA}`,
  `media-src 'self' data: blob: https: ${SUPA}`,
  `connect-src 'self' https: wss: data: blob: ${SUPA} ${MP}`,
  "frame-src 'self' https://*.mercadopago.com https://*.mercadolibre.com",
  "font-src 'self' data:",
  "base-uri 'self'",
  "form-action 'self' https://*.mercadopago.com https://*.mercadolibre.com",
  "object-src 'none'",
  "frame-ancestors 'none'",
]
  .map((d) => d.replace(/\s+/g, " ").trim())
  .join("; ");

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy-Report-Only", value: cspReportOnly },
];

const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: { allowedOrigins },
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

export default nextConfig;

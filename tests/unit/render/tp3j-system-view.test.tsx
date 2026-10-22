import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [TP-3j] Plataforma → Sistema, grupo «Cobros online (Mercado Pago)» (brief §25.10, C-TP13, Anexo C «3j Sistema:
 * filas nuevas sin valores secretos»). Se renderiza la vista REAL con el DTO que arma el builder REAL
 * (`buildSystemStatus`) a partir de una entrada con valores MARCADOS en cada secreto: ninguno puede llegar al HTML.
 * El builder nunca recibe el client secret ni el secreto del webhook (solo su huella), pero sí recibe el token legado
 * de la plataforma (`MP_ACCESS_TOKEN`), así que ese es el que más importa que no se filtre.
 */
vi.mock("@/lib/platform-realtime-probe", () => ({ probeRealtimeFromServer: vi.fn() }));
vi.mock("@/components/plataforma/reauth-modal", () => ({
  usePlatformAction: () => <T,>(fn: () => Promise<T>) => fn(),
}));

import { SystemView } from "@/components/plataforma/system/system-view";
import { buildSystemStatus, type MpConnectSystemInfo, type SystemConfigInput } from "@/lib/platform-system-logic";

const SECRET = {
  token: "APP_USR-TOKEN-MARCADO-0001",
  pk: "APP_USR-PK-MARCADA-0002",
  hook: "SECRETO-WEBHOOK-LEGADO-0003",
  resend: "re_RESEND_MARCADO_0004",
  cron: "CRON-MARCADO-0005",
};

function mpConnect(over: Partial<MpConnectSystemInfo> = {}): MpConnectSystemInfo {
  return {
    mode: "fake",
    signature: "required",
    clientIdPresent: true,
    clientSecretFingerprint: "a1b2c3d4",
    webhookSecretFingerprint: "0f0e0d0c",
    secretBox: { configured: true, devFallback: false, primaryKid: "k2", kids: ["k2", "k1"], fingerprints: { k2: "aaaaaaaaaaaa", k1: "bbbbbbbbbbbb" } },
    stats: {
      available: true,
      accounts: { active: 3, reauth: 1, disconnected: 2 },
      lastWebhookAt: new Date("2026-10-21T02:30:00.000Z"), // 20/10 23:30 AR
      lastRefreshAt: null,
    },
    ...over,
  };
}

function render(input: Partial<SystemConfigInput> = {}) {
  const status = {
    ...buildSystemStatus(
      {
        MP_ACCESS_TOKEN: SECRET.token,
        MP_PUBLIC_KEY: SECRET.pk,
        MP_WEBHOOK_SECRET: SECRET.hook,
        RESEND_API_KEY: SECRET.resend,
        CRON_SECRET: SECRET.cron,
        mpConnect: mpConnect(),
        ...input,
      },
      { available: true, applied: 80, last: "20261022000000_turnero_cobros_mp" },
      { up: true, ms: 3 },
      new Date("2026-10-22T15:00:00.000Z")
    ),
    emailFailures: { available: true as const, items: [] },
  };
  return renderToStaticMarkup(<SystemView status={status} />);
}

function groupHtml(html: string, id: string): string {
  const start = html.indexOf(`data-testid="system-group-${id}"`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('data-testid="system-group-', start + 10);
  return html.slice(start, next === -1 ? undefined : next);
}

describe("[TP-3j] Sistema · Cobros online (Mercado Pago)", () => {
  it("filas nuevas sin valores secretos: modo, presencias, huellas, firma, claves, cuentas, último webhook y renovación", () => {
    const html = render();
    for (const v of Object.values(SECRET)) expect(html).not.toContain(v);

    const g = groupHtml(html, "mp-connect");
    expect(g).toContain("Cobros online (Mercado Pago)");
    expect(g).toContain("MP_CONNECT_MODE");
    expect(g).toContain("fake");
    expect(g).toContain("Client id de la app");
    expect(g).toContain("huella a1b2c3d4");
    expect(g).toContain("huella 0f0e0d0c");
    expect(g).toContain("Firma del webhook");
    expect(g).toContain("2 claves · sella k2");
    expect(g).toContain("3 activas · 1 a reconectar · 2 desconectadas");
    expect(g).toContain("Último webhook aplicado");
    expect(g).toContain("20/10/2026, 23:30");
    expect(g).toContain("Última renovación de tokens");
    expect(g).toContain("nunca");
  });

  it("el token de la plataforma pasa a «Token de la plataforma (legado)» y sigue sin valor", () => {
    const g = groupHtml(render(), "mp");
    expect(g).toContain("Token de la plataforma (legado)");
    expect(g).not.toContain(SECRET.token);
  });

  it("una huella o un kid con forma rara (un secreto pegado en otro lado) no se muestra tal cual", () => {
    const html = render({
      mpConnect: mpConnect({
        clientSecretFingerprint: "SECRETO-PEGADO-EN-LA-HUELLA",
        secretBox: { configured: true, devFallback: false, primaryKid: "CLAVE ENTERA=", kids: ["CLAVE ENTERA="], fingerprints: {} },
      }),
    });
    expect(html).not.toContain("SECRETO-PEGADO-EN-LA-HUELLA");
    expect(html).not.toContain("CLAVE ENTERA=");
    expect(html).toContain("huella inválida");
  });

  it("en modo fake ofrece abrir el simulador (el panel con «Forzar reconexión»); en otro modo, no", () => {
    const fake = groupHtml(render(), "mp-connect");
    expect(fake).toContain('href="/api/mp/fake/panel"');
    expect(fake).toContain("Abrir el simulador");
    for (const mode of ["off", "sandbox", "live"]) {
      const g = groupHtml(render({ mpConnect: mpConnect({ mode }) }), "mp-connect");
      expect(g).not.toContain("/api/mp/fake");
    }
    // Un modo inválido tampoco ofrece el link (el builder lo muestra como «inválido»).
    expect(groupHtml(render({ mpConnect: mpConnect({ mode: "fake-pero-no" }) }), "mp-connect")).not.toContain("/api/mp/fake");
  });

  it("sin la info del grupo (lectura caída) la página no se cae", () => {
    const g = groupHtml(render({ mpConnect: null }), "mp-connect");
    expect(g).toContain("No se pudo leer la configuración de cobros online.");
    expect(g).not.toContain("/api/mp/fake");
  });
});

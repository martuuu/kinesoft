/**
 * [TP-3j] HTML del Mercado Pago falso (brief §25.9 «Copy del HTML», TP-UI-D10: HTML simple en `/api/mp/fake/*`, 0 kB de
 * bundle). Se prueba el símbolo real (`fakeMpHandle`) con Requests armados a mano; la única red es el POST del webhook
 * simulado, que se captura con un `fetch` falso que contesta como la ruta real (`{ result }`).
 *
 * Lo que se fija: el copy LITERAL de §25.9 (banner, botones, autorización, «Forzar reconexión», línea de resultado), el
 * vocabulario de §25.10 en lo que lee quien prueba (link de pago, nunca «cobro»/«preferencia» para la cosa que se paga),
 * que todo dato que viene de afuera (título del ítem, ids) sale escapado, y lo mínimo de accesibilidad (landmark, foco
 * visible, idioma).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeMpHandle, fakeMpIssueTokens, resetFakeMp } from "@/lib/mp-connect/fake-mp";
import { mpRedirectUri } from "@/lib/mp-connect/constants";

const APP = "http://localhost:3000";
const FAKE = `${APP}/api/mp/fake`;
const HOOK = `${APP}/api/webhooks/mercadopago`;

const BANNER_TITLE = "Simulador de Mercado Pago (solo desarrollo)";
const BANNER_TEXT = "Nada de esto toca Mercado Pago real. El pago pasa por el webhook de verdad, firmado con el secreto de prueba.";

let webhookResult = "applied";

beforeEach(() => {
  vi.stubEnv("MP_CONNECT_MODE", "fake");
  vi.stubEnv("VERCEL_ENV", undefined);
  vi.stubEnv("VERCEL", undefined);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
  vi.stubEnv("MP_OAUTH_CLIENT_ID", "kinesoft-fake-app");
  vi.stubEnv("MP_CONNECT_WEBHOOK_SECRET", "secreto-de-prueba-del-webhook");
  resetFakeMp();
  webhookResult = "applied";
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(HOOK)) return new Response(JSON.stringify({ result: webhookResult }), { status: 200 });
    throw new Error(`red real bloqueada en el test: ${url}`);
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function html(res: Response): Promise<string> {
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-robots-tag")).toContain("noindex");
  return res.text();
}

function expectShell(page: string) {
  expect(page).toContain('<html lang="es-AR">');
  expect(page).toContain(`<strong>${BANNER_TITLE}</strong>`);
  expect(page).toContain(BANNER_TEXT);
  expect(page).toMatch(/<main[ >]/);
  expect(page).toContain(":focus-visible");
}

async function createPref(o: { title?: string; binary?: boolean; expired?: boolean } = {}) {
  const { accessToken } = fakeMpIssueTokens(1);
  const res = await fakeMpHandle(
    new Request(`${FAKE}/checkout/preferences`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        items: [{ title: o.title ?? "Seña del turno", unit_price: 5000, quantity: 1, currency_id: "ARS" }],
        binary_mode: o.binary === true,
        notification_url: `${HOOK}?acct=acc_1`,
        back_urls: { success: `${APP}/reservar/x/ok`, failure: `${APP}/reservar/x/failed`, pending: `${APP}/reservar/x/pending` },
        external_reference: "chg_1",
        ...(o.expired ? { expires: true, expiration_date_to: "2020-01-01T00:00:00.000Z" } : {}),
      }),
    })
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

function form(url: string, fields: Record<string, string>) {
  return new Request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
}

describe("[TP-3j] HTML del simulador de Mercado Pago", () => {
  it("autorización: banner, «Autorizar como Vendedor de prueba 1/2» y «Cancelar»", async () => {
    const q = new URLSearchParams({
      client_id: "kinesoft-fake-app",
      response_type: "code",
      redirect_uri: mpRedirectUri(APP),
      state: "st<ate>",
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
    });
    const res = await fakeMpHandle(new Request(`${FAKE}/authorization?${q}`));
    expect(res.status).toBe(200);
    const page = await html(res);
    expectShell(page);
    expect(page).toContain(">Autorizar como Vendedor de prueba 1</button>");
    expect(page).toContain(">Autorizar como Vendedor de prueba 2</button>");
    expect(page).toContain(">Cancelar</button>");
    // El `state` viene de afuera: va escapado al hidden.
    expect(page).toContain('value="st&lt;ate&gt;"');
    expect(page).not.toContain("st<ate>");
  });

  it("checkout: los seis botones literales, el monto, quién cobra y el título escapado", async () => {
    const id = await createPref({ title: '<img src=x onerror="alert(1)">' });
    const page = await html(await fakeMpHandle(new Request(`${FAKE}/checkout/${id}`)));
    expectShell(page);
    for (const b of ["Simular pago aprobado", "Simular pago rechazado", "Simular pago pendiente", "Simular reintegro", "Simular con otro monto"]) {
      expect(page).toContain(`>${b}</button>`);
    }
    expect(page).toContain(">Volver al sitio</a>");
    expect(page).toContain("$ 5.000");
    expect(page).toContain("Vendedor de prueba 1");
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    // Sin pago aprobado no hay nada que reintegrar.
    expect(page).toMatch(/value="refunded" disabled>Simular reintegro/);
  });

  it("checkout con binary_mode: «Simular pago pendiente» deshabilitado con el motivo en vocabulario de §25.10", async () => {
    const page = await html(await fakeMpHandle(new Request(`${FAKE}/checkout/${await createPref({ binary: true })}`)));
    expect(page).toMatch(/value="pending" disabled>Simular pago pendiente/);
    expect(page).toContain("este link de pago no admite pagos pendientes");
    expect(page).not.toMatch(/este cobro/i);
  });

  it("link de pago vencido: 410, botones apagados y el aviso dice «link de pago»", async () => {
    const res = await fakeMpHandle(new Request(`${FAKE}/checkout/${await createPref({ expired: true })}`));
    expect(res.status).toBe(410);
    const page = await html(res);
    expect(page).toContain("Este link de pago venció: Mercado Pago no deja pagarlo.");
    expect(page).toMatch(/value="approved" disabled>Simular pago aprobado/);
  });

  it("checkout inexistente: 404 en vocabulario de §25.10", async () => {
    const res = await fakeMpHandle(new Request(`${FAKE}/checkout/no-existe`));
    expect(res.status).toBe(404);
    const page = await html(res);
    expectShell(page);
    expect(page).toContain("No encontramos este link de pago");
  });

  it("resultado del reintegro: «Webhook enviado · respuesta 200 · aplicado» y el estado en castellano", async () => {
    const id = await createPref();
    // El aprobado vuelve al sitio (303 a back_urls.success); el reintegro se queda en el simulador con la línea.
    const ok = await fakeMpHandle(form(`${FAKE}/checkout/${id}/simulate`, { outcome: "approved" }));
    expect(ok.status).toBe(303);
    const res = await fakeMpHandle(form(`${FAKE}/checkout/${id}/simulate`, { outcome: "refunded" }));
    const page = await html(res);
    expectShell(page);
    expect(page).toContain("Webhook enviado · respuesta 200 · aplicado");
    expect(page).toContain("reintegrado");
    expect(page).not.toMatch(/·\s*refunded/);
  });

  it("«repetido» y «monto distinto» en la línea de resultado", async () => {
    const id = await createPref();
    await fakeMpHandle(form(`${FAKE}/checkout/${id}/simulate`, { outcome: "approved" }));
    webhookResult = "replay";
    expect(await (await fakeMpHandle(form(`${FAKE}/checkout/${id}/simulate`, { outcome: "refunded" }))).text()).toContain(
      "Webhook enviado · respuesta 200 · repetido"
    );
    webhookResult = "mismatch";
    // Con back_urls el aprobado redirige al sitio; sin back_urls se queda en el simulador con la línea de resultado.
    const { accessToken } = fakeMpIssueTokens(1);
    const res = await fakeMpHandle(
      new Request(`${FAKE}/checkout/preferences`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ items: [{ title: "Turno", unit_price: 5000, quantity: 1, currency_id: "ARS" }], notification_url: `${HOOK}?acct=acc_1` }),
      })
    );
    const noBack = ((await res.json()) as { id: string }).id;
    const page = await (await fakeMpHandle(form(`${FAKE}/checkout/${noBack}/simulate`, { outcome: "approved", amount: "4.000" }))).text();
    expect(page).toContain("Webhook enviado · respuesta 200 · monto distinto");
    expect(page).toContain("aprobado");
  });

  it("panel: cuentas de prueba con «Forzar reconexión» y conteo de links de pago", async () => {
    await createPref();
    const page = await html(await fakeMpHandle(new Request(`${FAKE}/panel`)));
    expectShell(page);
    expect(page).toContain(">Forzar reconexión</button>");
    expect(page).toContain("1 link de pago");
    expect(page).not.toMatch(/\d+ cobros/);
    // Nunca un token en el HTML: solo conteos.
    expect(page).not.toMatch(/FAKE-900000001-/);
  });

  it("fuera de fake o en Vercel: 404 (el guard no depende del HTML)", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await fakeMpHandle(new Request(`${FAKE}/panel`))).status).toBe(404);
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("MP_CONNECT_MODE", "off");
    expect((await fakeMpHandle(new Request(`${FAKE}/panel`))).status).toBe(404);
  });
});

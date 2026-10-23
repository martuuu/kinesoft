/**
 * [MPS-1b] Helper de tests para la suscripción SaaS contra el Mercado Pago FALSO (C-MPS4, brief §26.6; MPS-D8: el mismo
 * simulador de T5, extendido a preapprovals).
 *
 * Por qué arriba de `installFakeMp` (tests/helpers/mp-connect-fake.ts) y no uno nuevo: la red se enruta igual (lo que va
 * a `${APP}/api/mp/fake/*` lo atiende el `fakeMpHandle` real, lo que va al webhook entra por el `POST` real que pase el
 * test, y cualquier otro host TIRA: un test que se olvidó de algo no sale a api.mercadopago.com). Lo que se suma es el
 * env de la suscripción:
 *   - `SAAS_BILLING_MODE=mp` (el puerto `lib/mercadopago-saas.ts` está prendido);
 *   - `MP_WEBHOOK_SECRET` de prueba: con ese secreto firma el fake lo de la plataforma (preapprovals, débitos y los
 *     links de pago de los cargos) y con ese verifica la rama SaaS del webhook (C-MPS6). El de la cuenta del vendedor
 *     (`MP_CONNECT_WEBHOOK_SECRET`) es OTRO a propósito: si una rama verificara con el secreto equivocado, el test lo ve;
 *   - `MP_ACCESS_TOKEN` vacío por default: en modo fake el puerto usa el token falso de la plataforma
 *     (`FAKE_MP_PLATFORM`) y nunca el de `.env*`.
 *
 * Literales de prueba, nunca valores de `.env*`. NOT a `.test.ts`.
 */
import { installFakeMp, type InstalledFakeMp } from "./mp-connect-fake";
import {
  FAKE_MP_PLATFORM,
  authorizeFakePreapproval,
  fakeMpGetAuthorizedPayment,
  fakeMpGetPreapproval,
  simulateFakeDebit,
  type FakeDebitOutcome,
} from "@/lib/mp-connect/fake-mp-saas";

export { FAKE_MP_PLATFORM, authorizeFakePreapproval, fakeMpGetAuthorizedPayment, fakeMpGetPreapproval, simulateFakeDebit };
export type { FakeDebitOutcome };

/** Secreto de las notificaciones de la PLATAFORMA en los tests (distinto del de la cuenta del vendedor). */
export const FAKE_SAAS_HOOK_SECRET = "secreto-de-prueba-del-webhook-de-la-plataforma";

export type InstalledSaasFakeMp = InstalledFakeMp;

/**
 * Prende el fake (vía `installFakeMp`) + el modo `mp` de la suscripción. `webhook` = el `POST` real de
 * `app/api/webhooks/mercadopago/route.ts` (sin él, los POST se registran y responden 200 `applied`).
 * `uninstall()` restaura env y fetch: llamalo en `afterEach`/`finally`.
 */
export function installSaasFakeMp(
  o: {
    webhook?: (req: Request) => Promise<Response>;
    appUrl?: string;
    /** Otro secreto de la plataforma (p. ej. para probar una firma que no valida). `null` = sin secreto. */
    saasHookSecret?: string | null;
    /** Token «real» de la plataforma (para afirmar que en fake NO se usa). */
    accessToken?: string;
    reset?: boolean;
  } = {}
): InstalledSaasFakeMp {
  const ENV: Record<string, string | undefined> = {
    SAAS_BILLING_MODE: "mp",
    MP_WEBHOOK_SECRET: o.saasHookSecret === null ? undefined : (o.saasHookSecret ?? FAKE_SAAS_HOOK_SECRET),
    MP_ACCESS_TOKEN: o.accessToken,
  };
  const prev = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  const setEnv = (vals: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const base = installFakeMp({ webhook: o.webhook, appUrl: o.appUrl, reset: o.reset });
  setEnv(ENV);
  return {
    ...base,
    uninstall: () => {
      setEnv(prev);
      base.uninstall();
    },
  };
}

/** Recorre la página de autorización del débito como el navegador: GET de `initPoint` y POST del botón elegido. */
export async function walkFakeSubscriptionCheckout(
  initPoint: string,
  choice: "authorize" | "cancel"
): Promise<{ page: Response; decision: Response }> {
  const { fakeMpHandle } = await import("@/lib/mp-connect/fake-mp");
  const page = await fakeMpHandle(new Request(initPoint));
  const id = new URL(initPoint).searchParams.get("preapproval_id") ?? "";
  const action = new URL(initPoint);
  action.search = "";
  const decision = await fakeMpHandle(
    new Request(action.toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ preapproval_id: id, decision: choice }).toString(),
    })
  );
  return { page, decision };
}

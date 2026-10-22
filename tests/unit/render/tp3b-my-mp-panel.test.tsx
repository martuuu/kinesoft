import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [TP-3b] «Mi Mercado Pago» (§25.10; TP-UI-D2: pestaña de Configuración + ítem del menú de cuenta). Render real sin
 * jsdom: se mockean solo las server actions (red) y el confirm (el provider vive en la raíz). Los clicks no se pueden
 * disparar sin DOM: los flujos con efecto (desconectar, conectar, delegar) son funciones exportadas del panel que el
 * botón llama tal cual, y se prueban con la action mockeada.
 */
const actions = vi.hoisted(() => ({
  startMpConnect: vi.fn(async (_i: { target: "own" | "clinic" }) => ({ ok: true as const, data: { url: "https://mp.test/auth?state=x" } })),
  disconnectMpAccount: vi.fn(async (_i: { target: "own" | "clinic" }) => ({ ok: true as const, data: { cancelledLinks: 2 } })),
  setMpLinksDelegated: vi.fn(async (_i: { target: "own" | "clinic"; delegated: boolean }) => ({ ok: true as const, data: undefined })),
}));
vi.mock("@/lib/mp-connect-actions", () => actions);
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => async () => true }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/configuracion",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));

import {
  MyMpPanel,
  connectOwnMp,
  disconnectOwnMp,
  mpReturnNotice,
  toggleOwnDelegation,
} from "@/components/configuracion/panels/my-mp-panel";
import { TopbarAccountMenu, MY_MP_HREF } from "@/components/layout/topbar-account-menu";
import { ProfileMenu } from "@/components/global/profile-menu";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { MP_ACCOUNT_NONE, MP_CONNECT_RETURNS, MY_MP_TAB, type MpAccountView } from "@/lib/mp-connect-types";
import { MP_ACCOUNT_STATUS_LABEL, MP_CONNECT_COPY } from "@/lib/online-payments-copy";
import { DEFAULT_PREFERENCES } from "@/lib/preferences-constants";
import { modulesFor } from "@/lib/tenant-modules";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const acct = (over: Partial<MpAccountView>): MpAccountView => ({ ...MP_ACCOUNT_NONE, ...over });
const ACTIVE = acct({ status: "ACTIVE", nickname: "KINE.ANA", connectedAt: "2026-10-20T13:00:00.000Z", linksDelegated: true });

const panel = (account: MpAccountView, extra: Partial<Parameters<typeof MyMpPanel>[0]> = {}) =>
  renderToStaticMarkup(<MyMpPanel account={account} mpReturn={null} {...extra} />);

beforeEach(() => {
  actions.startMpConnect.mockClear();
  actions.disconnectMpAccount.mockClear();
  actions.setMpLinksDelegated.mockClear();
});

describe("[TP-3b] los 4 estados de «Mi Mercado Pago»", () => {
  it("sin cuenta: «Sin conectar» y «Conectar Mercado Pago», sin switch ni «Desconectar»", () => {
    const html = panel(MP_ACCOUNT_NONE);
    const t = text(html);
    expect(html).toContain('data-mp-status="NONE"');
    expect(t).toContain(MP_ACCOUNT_STATUS_LABEL.NONE);
    expect(t).toContain("Conectar Mercado Pago");
    expect(t).not.toContain("Desconectar");
    expect(html).not.toContain('role="switch"');
  });

  it("conectada: nickname, fecha AR, «Desconectar» y el switch de delegación con su valor", () => {
    const html = panel(ACTIVE);
    const t = text(html);
    expect(html).toContain('data-mp-status="ACTIVE"');
    expect(t).toContain(MP_ACCOUNT_STATUS_LABEL.ACTIVE);
    expect(t).toContain("KINE.ANA");
    expect(t).toContain("20 de oct de 2026");
    expect(t).toContain("Desconectar");
    expect(t).not.toContain("Conectar Mercado Pago");
    expect(html).toContain(`role="switch" aria-checked="true" aria-label="${MP_CONNECT_COPY.delegationSwitch}"`);
    expect(t).toContain(MP_CONNECT_COPY.delegationSwitch);
  });

  it("necesita reconectarse: aviso de reconexión, «Reconectar» y «Desconectar»; la delegación se conserva", () => {
    const html = panel(acct({ ...ACTIVE, status: "REAUTH_REQUIRED" }));
    const t = text(html);
    expect(html).toContain('data-mp-status="REAUTH_REQUIRED"');
    expect(t).toContain(MP_ACCOUNT_STATUS_LABEL.REAUTH_REQUIRED);
    expect(t).toContain(MP_CONNECT_COPY.reauthTitle);
    expect(t).toContain(MP_CONNECT_COPY.reauthBody);
    expect(t).toContain("Reconectar Mercado Pago");
    expect(t).toContain("Desconectar");
    expect(html).toContain('role="switch"');
  });

  it("desconectada: fecha AR, aviso de cobros apagados y «Volver a conectar», sin switch", () => {
    const html = panel(acct({ status: "DISCONNECTED", disconnectedAt: "2026-10-21T02:30:00.000Z" }));
    const t = text(html);
    expect(html).toContain('data-mp-status="DISCONNECTED"');
    expect(t).toContain(MP_ACCOUNT_STATUS_LABEL.DISCONNECTED);
    // 02:30 UTC del 21 = 23:30 AR del 20: la fecha es la de Argentina.
    expect(t).toContain("20 de oct de 2026");
    expect(t).toContain("Volver a conectar");
    expect(t).not.toMatch(/(?<!Volver a c)Desconectar/);
    expect(html).not.toContain('role="switch"');
  });

  it("badges «Simulador local» y «Cuenta de prueba»; la cuenta real no lleva badge", () => {
    expect(text(panel({ ...ACTIVE, badge: "fake" }))).toContain(MP_CONNECT_COPY.badgeFake);
    expect(text(panel({ ...ACTIVE, badge: "sandbox" }))).toContain(MP_CONNECT_COPY.badgeSandbox);
    const real = text(panel(ACTIVE));
    expect(real).not.toContain(MP_CONNECT_COPY.badgeFake);
    expect(real).not.toContain(MP_CONNECT_COPY.badgeSandbox);
  });

  it("sesión de soporte: estado visible, sin acciones y switch deshabilitado", () => {
    const html = panel(ACTIVE, { support: true });
    expect(text(html)).not.toContain("Desconectar");
    expect(html).toMatch(/role="switch"[^>]*disabled/);
    expect(text(panel(MP_ACCOUNT_NONE, { support: true }))).not.toContain("Conectar Mercado Pago");
  });
});

describe("[TP-3b] avisos `?mp=`", () => {
  it("cada valor del callback tiene su aviso; ok es éxito y el resto alerta", () => {
    for (const r of MP_CONNECT_RETURNS) {
      const n = mpReturnNotice(r);
      expect(n.text.length).toBeGreaterThan(10);
      expect(n.tone).toBe(r === "ok" ? "success" : r === "denied" ? "warn" : "danger");
    }
    expect(mpReturnNotice("in_use").text).toContain("otro profesional");
  });

  it("el panel muestra el aviso con role status/alert según el tono", () => {
    const ok = panel(ACTIVE, { mpReturn: "ok" });
    expect(ok).toMatch(/role="status"[^>]*data-mp-return="ok"/);
    expect(text(ok)).toContain(mpReturnNotice("ok").text);
    const err = panel(MP_ACCOUNT_NONE, { mpReturn: "error" });
    expect(err).toMatch(/role="alert"[^>]*data-mp-return="error"/);
    expect(panel(ACTIVE)).not.toContain("data-mp-return");
  });
});

describe("[TP-3b] flujos de los botones (la action real está mockeada: es la red)", () => {
  it("desconectar confirma: cancelar no llama a la action; aceptar desconecta la propia", async () => {
    const no = await disconnectOwnMp(async () => false);
    expect(no).toEqual({ kind: "cancelled" });
    expect(actions.disconnectMpAccount).not.toHaveBeenCalled();

    const asked: { title: string; tone?: string; message?: string }[] = [];
    const yes = await disconnectOwnMp(async (o) => {
      asked.push(o);
      return true;
    });
    expect(asked[0].tone).toBe("danger");
    expect(asked[0].message).toContain("links de pago");
    expect(actions.disconnectMpAccount).toHaveBeenCalledWith({ target: "own" });
    expect(yes).toEqual({ kind: "done", cancelledLinks: 2 });
  });

  it("conectar pide la URL al server (target own) y navega con location.assign, sin form POST", async () => {
    const go = vi.fn();
    const r = await connectOwnMp(go);
    expect(actions.startMpConnect).toHaveBeenCalledWith({ target: "own" });
    expect(go).toHaveBeenCalledWith("https://mp.test/auth?state=x");
    expect(r).toBeNull();
    actions.startMpConnect.mockResolvedValueOnce({ ok: false, error: "Los cobros online todavía no están habilitados." } as never);
    const go2 = vi.fn();
    expect(await connectOwnMp(go2)).toBe("Los cobros online todavía no están habilitados.");
    expect(go2).not.toHaveBeenCalled();
  });

  it("delegar llama a setMpLinksDelegated de la propia y devuelve el error si falla", async () => {
    expect(await toggleOwnDelegation(true)).toBeNull();
    expect(actions.setMpLinksDelegated).toHaveBeenCalledWith({ target: "own", delegated: true });
    actions.setMpLinksDelegated.mockResolvedValueOnce({ ok: false, error: "No hay una cuenta de Mercado Pago conectada." } as never);
    expect(await toggleOwnDelegation(false)).toBe("No hay una cuenta de Mercado Pago conectada.");
  });
});

describe("[TP-3b] ítem «Mi Mercado Pago» del menú de cuenta (solo con profesional propio)", () => {
  const OWN = { practitionerId: "pr-1", enabled: true, myMp: true };
  const inTenant = (ui: ReactElement) =>
    renderToStaticMarkup(
      <TenantModulesProvider
        modules={[...modulesFor({ vertical: "KINESIOLOGY", plan: "CONSULTORIO", publicBookingEnabled: true, moduleGrants: [], moduleRevokes: [] })]}
        vertical="KINESIOLOGY"
      >
        {ui}
      </TenantModulesProvider>
    );
  const link = `href="${MY_MP_HREF}" role="menuitem"`;

  it("el href es la pestaña registrada y el texto el de la copy (literales en el menú para no sumar al layout)", () => {
    expect(MY_MP_HREF).toBe(`/configuracion?tab=${MY_MP_TAB}`);
  });

  it("barra superior: con ficha propia aparece; sin ficha (Secretaría, Facturación, soporte) no", () => {
    const own = inTenant(<TopbarAccountMenu name="Ana Pérez" ownPublicBooking={OWN} defaultOpen />);
    expect(own).toContain(link);
    expect(text(own)).toContain(MP_CONNECT_COPY.myMpTab);
    const none = inTenant(<TopbarAccountMenu name="Ana Pérez" ownPublicBooking={null} defaultOpen />);
    expect(none).not.toContain("tab=mercado-pago");
    expect(none).not.toContain("Mi Mercado Pago");
  });

  it("menú de perfil del tablero: mismo criterio", () => {
    const own = inTenant(<ProfileMenu name="Ana Pérez" preferences={DEFAULT_PREFERENCES} ownPublicBooking={OWN} defaultOpen />);
    expect(own).toContain(link);
    expect(text(own)).toContain(MP_CONNECT_COPY.myMpTab);
    const none = inTenant(<ProfileMenu name="Ana Pérez" preferences={DEFAULT_PREFERENCES} ownPublicBooking={null} defaultOpen />);
    expect(none).not.toContain("Mi Mercado Pago");
  });

  it("[TP-3z] con MP_CONNECT_MODE=off (el layout y el tablero mandan la ficha sin `myMp`) no aparece en ningún menú", () => {
    const off = { practitionerId: "pr-1", enabled: true, myMp: false };
    const top = inTenant(<TopbarAccountMenu name="Ana Pérez" ownPublicBooking={off} defaultOpen />);
    expect(top).not.toContain("tab=mercado-pago");
    expect(top).toContain("Mi perfil público"); // el resto del menú sigue
    const prof = inTenant(<ProfileMenu name="Ana Pérez" preferences={DEFAULT_PREFERENCES} ownPublicBooking={off} defaultOpen />);
    expect(prof).not.toContain("tab=mercado-pago");
  });
});

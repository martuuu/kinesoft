/**
 * [BO-Z] Fixer U (UI/copy): canal de soporte (B4), días de prueba coherentes (B5), export de consultorios
 * suspendidos (B6), rebase de los forms de Plataforma (B8), redes de escrituras rechazadas (B10/C4), Esc del Modal
 * (C2), foco inicial (C1), salida de MFA (C3) y porqués visibles del equipo (C5).
 *
 * Componentes y funciones REALES. Sin DOM (vitest en `node`): lo que depende de eventos del browser (Esc, foco,
 * `unhandledrejection`) se prueba en su decisión pura, que es lo que corre adentro del listener. Corre en TZ=UTC
 * (`npm test`) y en TZ=AR (`npm run test:tz-ar`): los días de prueba no pueden depender del TZ del host.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { supportContactText, supportEmail, supportMailto } from "@/lib/support-contact";
import { SupportContact } from "@/components/ui/support-contact";
import {
  AccessBanner,
  TELL_OWNER,
  accessBannerCopy,
  bannerAudienceFor,
} from "@/components/layout/access-banner";
import { READ_ONLY_MESSAGE, tenantAccessFor, SUPPORT_READ_ONLY_MESSAGE } from "@/lib/tenant-access";
import { trialDaysLabel, trialDaysLeft } from "@/components/plataforma/tenants/labels";
import { subscriptionSummary } from "@/lib/tenant-plan-usage-logic";
import { REBASED_FORM_COPY, rebaseForm } from "@/components/plataforma/tenants/rebase-form";
import { ExportPanel, exportHref, orderExportBlocks } from "@/components/configuracion/panels/export-panel";
import { TabsBar } from "@/components/configuracion/controls";
import { isReadOnlyWriteRejection } from "@/components/layout/read-only-write-guard";
import {
  SUPPORT_CONFIG_ERROR_MESSAGE,
  isSupportWriteRejection,
  supportRejectionMessage,
} from "@/components/layout/support-banner";
import { modalOwnsEscape } from "@/components/ui/modal";
import { initialFocusTarget } from "@/hooks/use-focus-trap";
import { MfaFooter } from "@/app/plataforma-mfa/shared";
import { OWNER_LOCKED_REASON, disabledReasons } from "@/components/plataforma/team/team-logic";
import { ONE_TIME_LINK_COPY } from "@/components/plataforma/users/users-logic";
import { SUPABASE_LINK_TTL_COPY } from "@/lib/email/templates";

/** Instante AR («2026-10-14T10:00» = 10:00 en Buenos Aires), sin depender del TZ del host. */
const ar = (local: string) => new Date(`${local}:00-03:00`);

describe("[BO-Z B4] canal de soporte", () => {
  it("supportEmail: recorta, valida y sin valor → null", () => {
    expect(supportEmail("  soporte@kinesoft.test ")).toBe("soporte@kinesoft.test");
    expect(supportEmail("")).toBeNull();
    expect(supportEmail("   ")).toBeNull();
    expect(supportEmail(undefined)).toBeNull();
    expect(supportEmail("no-es-un-mail")).toBeNull();
    expect(supportEmail('x@y.com"><script>')).toBeNull();
  });

  it("mailto con asunto codificado; sin email, nada", () => {
    expect(supportMailto("soporte@kinesoft.test", "Plan del consultorio")).toBe(
      "mailto:soporte@kinesoft.test?subject=Plan%20del%20consultorio"
    );
    expect(supportMailto(null)).toBeNull();
  });

  it("texto plano: con email «escribinos a …», sin email «escribile al equipo de KineSoft»", () => {
    expect(supportContactText({ email: "s@k.test" })).toBe("escribinos a s@k.test");
    expect(supportContactText({ email: null, capital: true })).toBe("Escribile al equipo de KineSoft");
  });

  it("SupportContact: mailto si hay email; texto sin link si no", () => {
    const withMail = renderToStaticMarkup(<SupportContact email="s@k.test" capital />);
    expect(withMail).toContain("Escribinos a ");
    expect(withMail).toMatch(/<a href="mailto:s@k\.test"[^>]*>s@k\.test<\/a>/);
    const bare = renderToStaticMarkup(<SupportContact email={null} />);
    expect(bare).toBe("escribile al equipo de KineSoft");
  });

  it("banda: titular/admin ven el canal; el resto «Avisale al titular del consultorio.»", () => {
    expect(bannerAudienceFor("OWNER")).toBe("admin");
    expect(bannerAudienceFor("ADMIN")).toBe("admin");
    expect(bannerAudienceFor("ASSISTANT")).toBe("member");
    expect(bannerAudienceFor(null)).toBe("member");

    const grace = { mode: "grace" as const, reason: "trial_grace", daysLeft: 3 };
    const admin = renderToStaticMarkup(
      <AccessBanner access={grace} enforcement="banner" audience="admin" supportEmail="s@k.test" />
    );
    expect(admin).toContain("Tu prueba terminó. Te quedan 3 días antes de que el consultorio pase a modo lectura: escribinos a ");
    expect(admin).toContain('href="mailto:s@k.test"');
    expect(admin).toContain("para elegir un plan.");

    const member = accessBannerCopy(grace, "banner", "member");
    expect(member?.text).toContain(TELL_OWNER);
    expect(member?.contact).toBeUndefined();
    const memberHtml = renderToStaticMarkup(
      <AccessBanner access={grace} enforcement="banner" audience="member" supportEmail="s@k.test" />
    );
    expect(memberHtml).not.toContain("mailto:");
    expect(memberHtml).not.toMatch(/scribinos/);
  });

  it("solo lectura con enforce: el llamado arranca oración («Escribinos a …»)", () => {
    const ro = { mode: "read_only" as const, reason: "cancelled", daysLeft: null };
    const html = renderToStaticMarkup(<AccessBanner access={ro} enforcement="enforce" supportEmail="s@k.test" />);
    expect(html).toContain("no cargar ni modificar datos. Escribinos a ");
    expect(html).toContain("para reactivarlo.");
  });

  it("READ_ONLY_MESSAGE (lo ve cualquier rol, sin link): dice quién lo reactiva, sin «Escribinos» pelado", () => {
    expect(READ_ONLY_MESSAGE).not.toMatch(/Escribinos/);
    expect(READ_ONLY_MESSAGE).toContain("el titular del consultorio tiene que escribirle al equipo de KineSoft");
  });
});

describe("[BO-Z B5] días de prueba: Plataforma = banda del consultorio = Plan y uso (mismo trialEndsAt)", () => {
  const end = ar("2026-10-20T23:59");
  const cases: Array<[string, string, string]> = [
    ["2026-10-14T10:00", "Quedan 7 días", "Te quedan 7 días de prueba."],
    ["2026-10-19T23:30", "Quedan 2 días", "Te quedan 2 días de prueba."],
    // 22:00 AR del último día = 01:00 UTC del día siguiente: sigue siendo el último día.
    ["2026-10-20T22:00", "Último día", "Hoy es el último día de tu prueba de KineSoft."],
  ];
  for (const [now, platform, banner] of cases) {
    it(`${now} AR → Plataforma «${platform}» y banda «${banner}»`, () => {
      const access = tenantAccessFor(
        { status: "ACTIVE", subscriptionStatus: "TRIALING", trialEndsAt: end, subscriptionStatusChangedAt: null },
        ar(now)
      );
      expect(trialDaysLeft(end, ar(now))).toBe(access.daysLeft);
      expect(trialDaysLabel(trialDaysLeft(end, ar(now)))).toBe(platform);
      expect(accessBannerCopy(access, "banner")?.text).toBe(banner);
      // Plan y uso (Configuración) dice el mismo número.
      const n = access.daysLeft!;
      const sub = subscriptionSummary(
        { status: "ACTIVE", subscriptionStatus: "TRIALING", trialEndsAt: end, subscriptionStatusChangedAt: null },
        ar(now)
      );
      expect(sub.detail).toContain(n === 1 ? "último día" : `${n} días`);
    });
  }

  it("después del fin: «Venció ayer» el día siguiente, «Venció hace N días» después", () => {
    expect(trialDaysLabel(trialDaysLeft(end, ar("2026-10-21T00:30")))).toBe("Venció ayer");
    expect(trialDaysLabel(trialDaysLeft(end, ar("2026-10-23T12:00")))).toBe("Venció hace 3 días");
  });
});

describe("[BO-Z B6] export de consultorios suspendidos desde Configuración", () => {
  const blocked = [
    { tenantId: "t-a", tenantName: "Kine Norte", kind: "suspended" as const },
    { tenantId: "t-b", tenantName: "Kine Sur", kind: "closed" as const },
  ];

  it("el pedido por URL (?tenant=) va primero", () => {
    expect(orderExportBlocks(blocked, "t-b").map((b) => b.tenantId)).toEqual(["t-b", "t-a"]);
    expect(orderExportBlocks(blocked, "otro").map((b) => b.tenantId)).toEqual(["t-a", "t-b"]);
    expect(orderExportBlocks(blocked, null)).toBe(blocked);
  });

  it("lista cada bloqueado con su link `?tenant=` y el del activo; el pedido en primario", () => {
    const html = renderToStaticMarkup(<ExportPanel blocked={blocked} requestedTenantId="t-a" />);
    expect(html).toContain("Descargar el export de Kine Norte (suspendido)");
    expect(html).toContain("Descargar el export de Kine Sur (dado de baja)");
    expect(html).toContain(`href="${exportHref("t-a")}"`);
    expect(html).toContain(`href="${exportHref("t-b")}"`);
    expect(html).toContain("Descargar el export de este consultorio");
    expect(html).toMatch(/class="k-btn k-btn-primary"[^>]*data-export-download="t-a"/);
    expect(html).toMatch(/class="k-btn k-btn-ghost"[^>]*data-export-download="true"/);
  });

  it("sin bloqueados: el botón de siempre; sin ser OWNER del activo: solo los bloqueados", () => {
    expect(renderToStaticMarkup(<ExportPanel />)).toContain(">Descargar export<");
    const onlyBlocked = renderToStaticMarkup(<ExportPanel blocked={blocked} showActive={false} />);
    expect(onlyBlocked).not.toContain("este consultorio");
    expect(onlyBlocked).not.toContain(">Descargar export<");
  });

  it("pestaña «Exportar datos»: OWNER sí; ADMIN solo si es titular de un suspendido (canExport)", () => {
    const tabs = (html: string) => html.includes("Exportar datos");
    const KINE = ["agenda"] as never;
    expect(tabs(renderToStaticMarkup(<TabsBar tab="general" setTab={() => {}} role="OWNER" modules={KINE} />))).toBe(true);
    expect(tabs(renderToStaticMarkup(<TabsBar tab="general" setTab={() => {}} role="ADMIN" modules={KINE} />))).toBe(false);
    expect(
      tabs(renderToStaticMarkup(<TabsBar tab="general" setTab={() => {}} role="ADMIN" modules={KINE} canExport />))
    ).toBe(true);
  });
});

describe("[BO-Z B8] rebase de los forms de Plataforma sobre una versión nueva", () => {
  const oldBase = { name: "Movare", phone: "111", publicEmail: "" };

  it("lo no tocado toma lo nuevo; lo tocado se queda; avisa que cambió", () => {
    const newBase = { name: "Movare SRL", phone: "222", publicEmail: "" };
    const form = { name: "Movare", phone: "999", publicEmail: "" }; // tocó solo el teléfono
    const r = rebaseForm(oldBase, newBase, form);
    expect(r.form).toEqual({ name: "Movare SRL", phone: "999", publicEmail: "" });
    expect(r.changed).toBe(true);
  });

  it("misma baseline (el refresh del propio guardado): no cambia nada ni avisa", () => {
    const form = { ...oldBase, phone: "999" };
    expect(rebaseForm(oldBase, { ...oldBase }, form)).toEqual({ form, changed: false });
  });

  it("copy del aviso", () => {
    expect(REBASED_FORM_COPY).toBe("Cambió en otra sesión: actualizamos los campos que no tocaste. Revisá y volvé a guardar.");
  });
});

describe("[BO-Z B10/C4] redes de escrituras rechazadas", () => {
  it("solo lectura real: ReadOnlyModeError, su mensaje o un error redactado con digest; nada más", () => {
    expect(isReadOnlyWriteRejection({ name: "ReadOnlyModeError", message: "x" })).toBe(true);
    expect(isReadOnlyWriteRejection(new Error(READ_ONLY_MESSAGE))).toBe(true);
    expect(isReadOnlyWriteRejection({ message: "An error occurred", digest: "123" })).toBe(true);
    expect(isReadOnlyWriteRejection(new TypeError("Failed to fetch"))).toBe(false);
    expect(isReadOnlyWriteRejection(null)).toBe(false);
  });

  it("soporte: misma detección que antes (extraída al hook común)", () => {
    expect(isSupportWriteRejection(new Error(SUPPORT_READ_ONLY_MESSAGE))).toBe(true);
    expect(isSupportWriteRejection({ digest: "abc" })).toBe(true);
    expect(isSupportWriteRejection(new Error("otra cosa"))).toBe(false);
  });

  it("soporte en /configuracion (donde SÍ escribe): un error redactado no es «solo podés mirar»", () => {
    expect(supportRejectionMessage("/configuracion", { digest: "1" })).toBe(SUPPORT_CONFIG_ERROR_MESSAGE);
    expect(SUPPORT_CONFIG_ERROR_MESSAGE).toBe("Probá de nuevo; si sigue, avisá al equipo.");
    expect(supportRejectionMessage("/agenda", { digest: "1" })).toBe(SUPPORT_READ_ONLY_MESSAGE);
    // Un rechazo explícito de solo lectura sigue diciendo eso aunque esté en Configuración.
    expect(supportRejectionMessage("/configuracion", { name: "ReadOnlyModeError" })).toBe(SUPPORT_READ_ONLY_MESSAGE);
  });
});

describe("[BO-Z C1/C2] foco inicial y Esc del Modal", () => {
  const node = { inside: new Set<unknown>(["input"]), contains(el: unknown) { return this.inside.has(el); } };

  it("C1: si el foco ya está adentro (autoFocus), no se mueve; si no, el primer focuseable o el contenedor", () => {
    expect(initialFocusTarget(node, "input", "close-btn")).toBeNull();
    expect(initialFocusTarget(node, "body", "close-btn")).toBe("close-btn");
    expect(initialFocusTarget(node, "body", undefined)).toBe(node);
  });

  it("C2: Esc solo para el Modal de arriba, y no si el foco está en otro diálogo (un useConfirm encima)", () => {
    const own = { d: 1 };
    expect(modalOwnsEscape({ stack: [1, 2], id: 2, focusedDialog: own, ownDialog: own })).toBe(true);
    expect(modalOwnsEscape({ stack: [1, 2], id: 1, focusedDialog: null, ownDialog: own })).toBe(false);
    expect(modalOwnsEscape({ stack: [2], id: 2, focusedDialog: { confirm: true }, ownDialog: own })).toBe(false);
    expect(modalOwnsEscape({ stack: [2], id: 2, focusedDialog: null, ownDialog: own })).toBe(true);
  });
});

describe("[BO-Z C3/C5/B3] copy y salidas", () => {
  it("C3: «Ir a mi consultorio» solo con consultorio propio", () => {
    expect(renderToStaticMarkup(<MfaFooter hasHome />)).toContain("Ir a mi consultorio");
    expect(renderToStaticMarkup(<MfaFooter hasHome={false} />)).not.toContain("Ir a mi consultorio");
    expect(renderToStaticMarkup(<MfaFooter hasHome={false} />)).toContain("Cerrar sesión");
  });

  it("C5: los porqués de lo apagado, sin repetir y sin el del titular (que ya tiene su línea)", () => {
    const why = "Está suspendido: reactivalo antes de mandarle un link para entrar.";
    expect(
      disabledReasons(
        {
          changeRole: { enabled: false, reason: OWNER_LOCKED_REASON },
          suspend: { enabled: false, reason: OWNER_LOCKED_REASON },
          passwordReset: { enabled: false, reason: why },
          remove: { enabled: true },
          transfer: null,
        },
        true
      )
    ).toEqual([why]);
    expect(disabledReasons({ suspend: { enabled: false, reason: OWNER_LOCKED_REASON } }, false)).toEqual([OWNER_LOCKED_REASON]);
  });

  it("B3: el aviso del link copiable usa el mismo TTL que los mails", () => {
    expect(ONE_TIME_LINK_COPY).toBe(
      `Es como una contraseña: sirve una sola vez y vence en ${SUPABASE_LINK_TTL_COPY}. No lo compartas en grupos.`
    );
  });
});

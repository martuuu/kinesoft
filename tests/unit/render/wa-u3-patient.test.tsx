/**
 * [WA-U3] (T6, brief §26.5 «Consentimiento en el paciente» + «Compartir ficha») · UI de WhatsApp en el paciente.
 *
 * Render estático (`renderToStaticMarkup`) de los componentes REALES: la casilla de consentimiento (alta y «Editar
 * paciente»), la fila de estado con «Revocar» y la opción «Enviar también por WhatsApp» del diálogo de compartir
 * ficha. Se mockean solo las server actions (red) y el router; nunca el componente bajo test. Fechas en hora AR: corre
 * igual en TZ=UTC y TZ=AR (un consentimiento de las 22:30 AR del 12/10 es 01:30Z del 13/10).
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/pacientes",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/lib/patients", () => ({
  assignPatientToPractitioner: vi.fn(),
  createPatient: vi.fn(),
  sendPatientPortalInvite: vi.fn(),
  setPatientCoverage: vi.fn(),
  setPatientDefaultCopago: vi.fn(),
  updatePatient: vi.fn(),
}));
vi.mock("@/lib/catalog", () => ({ listPayerPlans: vi.fn(async () => []), proposePayerPlan: vi.fn() }));
vi.mock("@/lib/patient-documents", () => ({
  shareClinicalNoteWithPatient: vi.fn(),
  getPatientPortalShareInfo: vi.fn(),
  revokePatientDocument: vi.fn(),
}));
vi.mock("@/lib/whatsapp-consent-actions", () => ({ setPatientWhatsAppConsent: vi.fn() }));
vi.mock("@/lib/whatsapp-patient-ui", () => ({
  getPatientWhatsAppConsentState: vi.fn(),
  getPatientWhatsAppShareInfo: vi.fn(),
}));

import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { modulesFor } from "@/lib/tenant-modules";
import {
  WA_CONSENT_UI_COPY,
  WhatsAppConsentField,
  WhatsAppConsentRow,
  consentPhoneError,
  consentRowView,
} from "@/components/patients/whatsapp-consent-field";
import { NewPatientModal } from "@/components/patients/new-patient-drawer";
import { EditPatientModal } from "@/components/patients/profile/edit-patient-drawer";
import { ShareFichaContent, waShareResultMessage } from "@/components/fichas/share-ficha-dialog";
import { SHARE_FICHA_COPY } from "@/components/fichas/fichas-copy";
import { WA_CHANNEL_BLOCK_LABEL, WA_CONSENT_TEXT, WA_COPY } from "@/lib/whatsapp/copy";
import type { PatientWaConsentState } from "@/lib/whatsapp-patient-ui-types";
import type { PatientAdminCore } from "@/lib/patients-types";

const KINE = modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] });
const wrap = (node: ReactNode) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>
        <TenantModulesProvider modules={Array.from(KINE)}>{node}</TenantModulesProvider>
      </ConfirmProvider>
    </ToastProvider>,
  );
const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const noop = () => {};

/** 22:30 AR del 12/10 (01:30Z del 13/10): en UTC el día cambiaría. */
const AT = "2026-10-13T01:30:00.000Z";
const state = (over: Partial<PatientWaConsentState> = {}): PatientWaConsentState => ({
  status: "GRANTED",
  at: AT,
  source: "STAFF",
  phoneValid: true,
  phoneChanged: false,
  versionOutdated: false,
  ...over,
});

const ADMIN_CORE: PatientAdminCore = {
  id: "pat_1",
  firstName: "Lucía",
  lastName: "Gómez",
  documentId: "30111222",
  email: null,
  phone: "11 2345 6789",
  dateOfBirth: null,
  coverage: null,
  emergency: [],
  assignedPractitionerName: null,
  nextBookingAt: null,
  updatedAt: new Date("2026-10-01T12:00:00.000Z"),
  access: "admin",
};

describe("[WA-U3] casilla de consentimiento", () => {
  it("[WA-U3] sin WhatsApp activo no se pinta nada", () => {
    expect(wrap(<WhatsAppConsentField active={false} checked={false} onChange={noop} />)).toBe("");
  });

  it("[WA-U3] con WhatsApp activo: casilla DESTILDADA + texto legal en «Ver qué acepta»", () => {
    const html = wrap(<WhatsAppConsentField active checked={false} onChange={noop} />);
    expect(html).toContain('type="checkbox"');
    expect(html).not.toMatch(/checked=""/);
    expect(html).toContain(WA_COPY.consentCheckbox);
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Ver qué acepta<\/summary>/);
    expect(html).toContain(WA_CONSENT_TEXT);
  });

  it("[WA-U3] precheck: tildada exige un celular válido en «Teléfono»", () => {
    expect(consentPhoneError(false, "")).toBeNull();
    expect(consentPhoneError(true, "11 2345 6789")).toBeNull();
    expect(consentPhoneError(true, "")).toBe(WA_CONSENT_UI_COPY.needsMobile);
    expect(consentPhoneError(true, "011 4321-5678")).toBe(WA_CONSENT_UI_COPY.needsMobile);
  });
});

describe("[WA-U3] fila de estado de «Editar paciente»", () => {
  it("[WA-U3] aceptó: fecha en hora AR y «Revocar»; sin casilla", () => {
    const v = consentRowView(state());
    expect(v).toEqual({ line: "Aceptó avisos por WhatsApp el 12/10", canRevoke: true, offerGrant: false, note: null });
    const html = wrap(<WhatsAppConsentRow state={state()} grantChecked={false} onGrantChange={noop} onRevoke={noop} />);
    expect(html).toContain("Aceptó avisos por WhatsApp el 12/10");
    expect(html).toMatch(/<button[^>]*>Revocar<\/button>/);
    expect(html).not.toContain('type="checkbox"');
  });

  it("[WA-U3] baja por WhatsApp: la línea lo dice y el equipo puede volver a registrarlo", () => {
    const v = consentRowView(state({ status: "REVOKED", source: "WHATSAPP" }));
    expect(v.line).toBe("Se dio de baja por WhatsApp el 12/10");
    expect(v.canRevoke).toBe(false);
    expect(v.offerGrant).toBe(true);
    expect(consentRowView(state({ status: "REVOKED", source: "STAFF" })).line).toBe("Dejó de recibir avisos por WhatsApp el 12/10");
  });

  it("[WA-U3] nunca se preguntó: solo la casilla; sin celular, el aviso", () => {
    expect(consentRowView(state({ status: null, at: null, source: null }))).toEqual({ line: null, canRevoke: false, offerGrant: true, note: null });
    expect(consentRowView(state({ status: null, at: null, source: null, phoneValid: false })).note).toBe(WA_CONSENT_UI_COPY.needsMobile);
  });

  it("[WA-U3] celular cambiado o texto viejo: se puede revocar y volver a registrar", () => {
    const changed = consentRowView(state({ phoneChanged: true }));
    expect(changed).toMatchObject({ canRevoke: true, offerGrant: true, note: WA_CHANNEL_BLOCK_LABEL.phone_changed });
    expect(consentRowView(state({ versionOutdated: true })).note).toBe(WA_CONSENT_UI_COPY.outdated);
  });

  it("[WA-U3] cargando y error de lectura", () => {
    expect(wrap(<WhatsAppConsentRow state={undefined} grantChecked={false} onGrantChange={noop} onRevoke={noop} />)).toContain(WA_CONSENT_UI_COPY.loading);
    const err = wrap(<WhatsAppConsentRow state={undefined} error="x" grantChecked={false} onGrantChange={noop} onRevoke={noop} />);
    expect(err).toContain('role="alert"');
  });
});

describe("[WA-U3] alta del paciente", () => {
  it("[WA-U3] con WhatsApp activo el alta monta la casilla (destildada); sin, no", () => {
    const on = wrap(<NewPatientModal insurers={[]} whatsappActive onClose={noop} />);
    expect(on).toContain("data-wa-consent");
    expect(on).toContain(WA_COPY.consentCheckbox);
    expect(on).not.toMatch(/name="waConsent"[^>]*checked=""/);
    expect(wrap(<NewPatientModal insurers={[]} onClose={noop} />)).not.toContain("data-wa-consent");
  });

  it("[WA-U3] la Secretaría (alta de recepción) también registra el consentimiento", () => {
    const html = wrap(<NewPatientModal insurers={[]} assignees={[{ id: "pr_1", name: "Juan" }]} whatsappActive onClose={noop} />);
    expect(html).toContain("data-wa-consent");
  });

  it("[WA-U3] tras crear, llama la action con la versión vigente y un error no pierde el alta", () => {
    const s = src("components/patients/new-patient-drawer.tsx");
    expect(s).toMatch(/setPatientWhatsAppConsent\(\{\s*patientId: [^,]+,\s*granted: true,\s*version: WA_CONSENT_VERSION/);
    expect(s).toContain("WA_CONSENT_UI_COPY.createdWithoutConsent");
    // El import es diferido: el drawer de alta no arrastra la action al chunk ni la carga hasta que se tilda.
    expect(s).toMatch(/await import\("@\/lib\/whatsapp-consent-actions"\)/);
  });
});

describe("[WA-U3] «Editar paciente»", () => {
  it("[WA-U3] con WhatsApp activo, la sección (cargando el estado) en los dos modos; sin, no", () => {
    const admin = wrap(<EditPatientModal mode="admin" patient={ADMIN_CORE} insurers={[]} whatsappActive onClose={noop} />);
    expect(admin).toContain(WA_CONSENT_UI_COPY.sectionTitle);
    expect(admin).toContain(WA_CONSENT_UI_COPY.loading);
    expect(wrap(<EditPatientModal mode="admin" patient={ADMIN_CORE} insurers={[]} onClose={noop} />)).not.toContain(WA_CONSENT_UI_COPY.sectionTitle);
  });

  it("[WA-U3] revocar pide confirmación (`useConfirm`) y otorgar va después de guardar los datos", () => {
    const s = src("components/patients/profile/edit-patient-drawer.tsx");
    expect(s).toContain("confirm(WA_CONSENT_UI_COPY.revokeConfirm)");
    expect(s).not.toMatch(/window\.confirm/);
    const save = s.indexOf("await updatePatient(");
    const grant = s.indexOf("granted: true");
    expect(save).toBeGreaterThan(0);
    expect(grant).toBeGreaterThan(save);
  });
});

describe("[WA-U3] compartir ficha por WhatsApp", () => {
  const base = { patientName: "Ana", notify: true, onNotifyChange: noop, onShare: noop, onInvite: noop, onClose: noop };
  const confirm = { step: "confirm" as const, error: null };
  const buttons = (html: string) => Array.from(html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)).map((m) => m[1]);

  it("[WA-U3] sin WhatsApp (o sin consentimiento): no aparece la opción", () => {
    const html = renderToStaticMarkup(<ShareFichaContent {...base} variant="first" phase={confirm} />);
    expect(html).not.toContain("Enviar también por WhatsApp");
    const blocked = renderToStaticMarkup(
      <ShareFichaContent {...base} variant="first" phase={confirm} wa={{ available: false, send: false, attested: false, onSendChange: noop, onAttestedChange: noop }} />,
    );
    expect(blocked).not.toContain("Enviar también por WhatsApp");
  });

  it("[WA-U3] disponible: «Enviar también por WhatsApp»; tildada, la casilla obligatoria y el botón trabado hasta marcarla", () => {
    const wa = { available: true, send: false, attested: false, onSendChange: noop, onAttestedChange: noop };
    const off = renderToStaticMarkup(<ShareFichaContent {...base} variant="first" phase={confirm} wa={wa} />);
    expect(off).toContain("Enviar también por WhatsApp");
    expect(off).not.toContain(WA_COPY.shareByWhatsApp);
    const on = renderToStaticMarkup(<ShareFichaContent {...base} variant="first" phase={confirm} wa={{ ...wa, send: true }} />);
    expect(on).toContain(WA_COPY.shareByWhatsApp);
    expect(on).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${SHARE_FICHA_COPY.confirm}</button>`));
    const ok = renderToStaticMarkup(<ShareFichaContent {...base} variant="first" phase={confirm} wa={{ ...wa, send: true, attested: true }} />);
    expect(ok).not.toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${SHARE_FICHA_COPY.confirm}</button>`));
    expect(buttons(ok)).toEqual(["Cancelar", SHARE_FICHA_COPY.confirm]);
  });

  it("[WA-U3] resultado del envío: enviado / en cola / no se mandó con motivo / no se pudo", () => {
    expect(waShareResultMessage(null)).toBeNull();
    expect(waShareResultMessage({ channel: "whatsapp", status: "sent" })).toMatchObject({ tone: "success" });
    expect(waShareResultMessage({ channel: "whatsapp", status: "queued" })).toMatchObject({ tone: "info" });
    const skipped = waShareResultMessage({ channel: "whatsapp", status: "skipped" });
    expect(skipped?.tone).toBe("warning");
    expect(skipped?.text).toMatch(/No se mandó por WhatsApp: /);
    expect(waShareResultMessage({ channel: "whatsapp", status: "failed" })).toMatchObject({ tone: "error" });
  });

  it("[WA-U3] el diálogo manda `whatsapp: { attested: true }` solo con las dos casillas, y lee `whatsappDelivery`", () => {
    const s = src("components/fichas/share-ficha-dialog.tsx");
    expect(s).toMatch(/whatsapp: waOn && waAttested \? \{ attested: true \} : undefined/);
    expect(s).toContain("r.data.whatsappDelivery");
    expect(s).toMatch(/import\("@\/lib\/whatsapp-patient-ui"\)/);
  });

  it("[WA-U3] la Secretaría no comparte fichas: el gate de la lectura es el de compartir (`canWrite`)", () => {
    const s = src("lib/whatsapp-patient-ui.ts");
    const fn = s.slice(s.indexOf("export async function getPatientWhatsAppShareInfo"));
    expect(fn).toContain("clinicalNoteGateInTx(tx, actor, patientId)");
    expect(fn).toContain("if (!gate.canWrite)");
  });
});

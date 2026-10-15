import type { AccessEnforcement, TenantAccess } from "@/lib/tenant-access";
import { SupportContact } from "@/components/ui/support-contact";

/**
 * Banda de acceso del consultorio (BO1-A; BO3-F le suma la variante de soporte). La monta `app/(app)/layout.tsx` arriba del contenido.
 *
 * Server component sin estado: el acceso se recalcula en cada request (`Actor.access`, modo REAL), así que la banda
 * aparece o se va sola en la próxima navegación. Solo se ve con `TENANT_ACCESS_ENFORCEMENT` en `banner` o `enforce`
 * (con `off` no hay nada que avisar: nada se corta).
 *
 * Con `banner` un consultorio vencido NO está en solo lectura de verdad (solo se avisa), así que el copy no le dice
 * que no puede cargar datos: le avisa que va a pasar. Con `enforce` sí.
 */
export type AccessBannerCopy = {
  tone: "info" | "warn";
  text: string;
  /**
   * [BO-Z B4] Llamado a escribir a soporte, que va DESPUÉS de `text` con el canal real (`SupportContact`: mailto o
   * «escribile al equipo de KineSoft»). `action` = para qué («para elegir un plan»); `capital` = `text` terminó en
   * punto y el llamado arranca oración. Solo para titular/admin: el resto del equipo no puede elegir plan.
   */
  contact?: { action: string; capital: boolean };
};

/**
 * Quién lee la banda. `admin` = OWNER/ADMIN (pueden pedir el plan); `member` = el resto del equipo, que no decide
 * el plan: antes leía «escribinos para elegir un plan» y escribía a soporte una Secretaria que no puede contratar
 * nada. A ellos se les dice que le avisen al titular (BO-Z B4).
 */
export type AccessBannerAudience = "admin" | "member";

export function bannerAudienceFor(role: string | null | undefined): AccessBannerAudience {
  return role === "OWNER" || role === "ADMIN" ? "admin" : "member";
}

export const TELL_OWNER = "Avisale al titular del consultorio.";

/** «Te queda 1 día» / «Te quedan 3 días». */
function left(n: number): string {
  return n === 1 ? "Te queda 1 día" : `Te quedan ${n} días`;
}

/** Cierra la frase según quién lee: admin → «…: escribinos a X para Y.»; member → «… Avisale al titular…». */
function withCta(
  tone: AccessBannerCopy["tone"],
  head: string,
  action: string,
  audience: AccessBannerAudience
): AccessBannerCopy {
  if (audience === "member") return { tone, text: `${head}. ${TELL_OWNER}` };
  return { tone, text: `${head}:`, contact: { action, capital: false } };
}

/** Lógica pura del copy (exportada para el test de render). null = no se muestra nada. */
export function accessBannerCopy(
  access: TenantAccess,
  enforcement: AccessEnforcement,
  audience: AccessBannerAudience = "admin"
): AccessBannerCopy | null {
  if (enforcement === "off") return null;
  switch (access.reason) {
    case "trial_ending":
      return access.daysLeft === null
        ? null
        : {
            tone: "info",
            text:
              access.daysLeft === 1
                ? "Hoy es el último día de tu prueba de KineSoft."
                : `${left(access.daysLeft)} de prueba.`,
          };
    case "trial_grace":
      return access.daysLeft === null
        ? withCta("warn", "Tu prueba terminó", "para elegir un plan y seguir usando KineSoft sin cortes", audience)
        : withCta(
            "warn",
            `Tu prueba terminó. ${left(access.daysLeft)} antes de que el consultorio pase a modo lectura`,
            "para elegir un plan",
            audience
          );
    case "past_due_grace":
      return access.daysLeft === null
        ? withCta("warn", "Tenés un pago pendiente", "para regularizarlo antes de que el consultorio pase a modo lectura", audience)
        : withCta(
            "warn",
            `Tenés un pago pendiente. ${left(access.daysLeft)} antes de que el consultorio pase a modo lectura`,
            "para regularizarlo",
            audience
          );
    case "trial_expired":
    case "past_due":
    case "cancelled":
      if (enforcement === "enforce") {
        const head = "Tu consultorio está en modo lectura: podés consultar todo, pero no cargar ni modificar datos.";
        return audience === "member"
          ? { tone: "warn", text: `${head} ${TELL_OWNER}` }
          : { tone: "warn", text: head, contact: { action: "para reactivarlo", capital: true } };
      }
      return access.reason === "trial_expired"
        ? withCta("warn", "Tu prueba terminó. Pronto el consultorio va a pasar a modo lectura", "para elegir un plan", audience)
        : withCta(
            "warn",
            "Tu suscripción no está activa. Pronto el consultorio va a pasar a modo lectura",
            "para reactivarla",
            audience
          );
    default:
      return null;
  }
}

/**
 * BO3-F: la misma banda cuando mira un superadmin «como soporte». Ve el acceso REAL del consultorio destino, pero el
 * copy de arriba le habla al titular («Tu prueba…», «Escribinos…») y el soporte ES quien recibe ese «escribinos»: se
 * leía como si su propia cuenta estuviera por vencer. Acá va en tercera persona, sin llamados a la acción, y suma
 * suspendido/baja (el soporte puede entrar a un consultorio suspendido; sus usuarios no). La escritura del soporte ya
 * es de solo lectura por la sesión (banda de soporte), así que no se repite.
 */
export function supportAccessBannerCopy(access: TenantAccess, enforcement: AccessEnforcement): AccessBannerCopy | null {
  const days = (n: number) => (n === 1 ? "1 día" : `${n} días`);
  // Con `off` ni la suspensión corta (`effectiveMode`): decir «no pueden entrar» sería falso.
  if (enforcement === "off") return null;
  switch (access.reason) {
    case "tenant_suspended":
      return { tone: "warn", text: "Este consultorio está suspendido: sus usuarios no pueden entrar." };
    case "tenant_closed":
      return { tone: "warn", text: "Este consultorio está dado de baja: sus usuarios no pueden entrar." };
    case "trial_ending":
      return access.daysLeft === null
        ? null
        : { tone: "info", text: `Al consultorio le quedan ${days(access.daysLeft)} de prueba.` };
    case "trial_grace":
      return {
        tone: "warn",
        text:
          access.daysLeft === null
            ? "La prueba del consultorio terminó (en gracia)."
            : `La prueba del consultorio terminó: le quedan ${days(access.daysLeft)} de gracia.`,
      };
    case "past_due_grace":
      return {
        tone: "warn",
        text:
          access.daysLeft === null
            ? "El consultorio tiene un pago pendiente (en gracia)."
            : `El consultorio tiene un pago pendiente: le quedan ${days(access.daysLeft)} de gracia.`,
      };
    case "trial_expired":
    case "past_due":
    case "cancelled": {
      const why =
        access.reason === "trial_expired"
          ? "La prueba del consultorio terminó"
          : access.reason === "past_due"
            ? "El consultorio tiene un pago vencido"
            : "La suscripción del consultorio está cancelada";
      return {
        tone: "warn",
        text: enforcement === "enforce" ? `${why}: sus usuarios están en modo lectura.` : `${why}.`,
      };
    }
    default:
      return null;
  }
}

export function AccessBanner({
  access,
  enforcement,
  support = false,
  audience = "admin",
  supportEmail,
}: {
  access: TenantAccess;
  enforcement: AccessEnforcement;
  /** BO3-F: lo mira un superadmin como soporte (copy en tercera persona). */
  support?: boolean;
  /** BO-Z B4: OWNER/ADMIN vs el resto del equipo (`bannerAudienceFor(role)`). */
  audience?: AccessBannerAudience;
  /** Solo para el render test; si no, `NEXT_PUBLIC_SUPPORT_EMAIL`. */
  supportEmail?: string | null;
}) {
  const copy = support ? supportAccessBannerCopy(access, enforcement) : accessBannerCopy(access, enforcement, audience);
  if (!copy) return null;
  const warn = copy.tone === "warn";
  return (
    <div
      role="status"
      data-access-reason={access.reason}
      style={{
        margin: "0 0 12px",
        padding: "10px 14px",
        borderRadius: "var(--r-sm)",
        fontSize: 13.5,
        lineHeight: 1.5,
        fontWeight: 500,
        background: warn ? "var(--st-noshow-bg)" : "var(--sky-100)",
        color: warn ? "var(--st-noshow-fg)" : "var(--sky-800)",
      }}
    >
      {copy.text}
      {copy.contact && (
        <>
          {" "}
          <SupportContact capital={copy.contact.capital} email={supportEmail} /> {copy.contact.action}.
        </>
      )}
    </div>
  );
}

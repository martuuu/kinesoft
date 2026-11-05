/**
 * CF3b (CT-U, M23): reglas y copy de «Co-titular» en Configuración → Usuarios. Puro (sin React ni actions) para el
 * test y para que `users-panel.tsx` no sume comparaciones de rol (guard `tests/unit/pl-ownership-guard.test.ts`: quién
 * es el Titular principal llega como booleano).
 *
 * Decisión de Martin (05-nov): el Titular principal se lo da a otro PROFESIONAL. Tiene lo del Titular salvo el rol, los
 * permisos y la cuenta del principal, transferir la titularidad, dar o quitar «Co-titular» y la suscripción a la
 * plataforma (sin `account.billing`: no ve ni delega «Planes y pagos»). Exporta los datos del consultorio. El server
 * lo rechaza igual (CT-K1/CT-K2): esto solo evita ofrecerlo.
 */
import type { ConfirmOptions } from "@/components/ui/confirm-dialog";
import { formatUserLicense } from "@/lib/user-license-logic";
import { isCoOwner } from "@/lib/roles-core";
import type { MemberLicense, TeamMemberView } from "@/lib/co-owner-types";

/** Texto fijo del switch (lo pidió Martin así): lo lee el Titular principal antes de decidir. */
export const CO_OWNER_HINT =
  "Tiene las mismas funciones que vos, salvo la suscripción a la plataforma, transferir la titularidad y tocar tu cuenta. Puede exportar los datos del consultorio.";

/** Con «Co-titular» prendido los permisos delegados no se muestran: ya tiene «Configuración» y nunca el plan. */
export const CO_OWNER_GRANTS_NOTE =
  "Ya puede cambiar la Configuración. El plan y los pagos de la plataforma siguen siendo solo tuyos.";

/** Encabezado de Usuarios para el co-titular: qué puede hacer acá y qué no. */
export const CO_OWNER_VIEWER_NOTE =
  "Sos co-titular: manejás el equipo como el titular, salvo su cuenta, la titularidad, quién es co-titular y el plan de la plataforma.";

/** Fila del Titular principal para quien no lo es (co-titular, Administrador/a, soporte). */
export const OWNER_ROW_LOCKED_REASON = "Solo el titular principal cambia su rol, su acceso y su cuenta.";

/** Fila de OTRO co-titular para quien no es el Titular principal: cambiarle el rol o quitarlo es «quitar co-titular». */
export const CO_OWNER_ROW_LOCKED_REASON = "Solo el titular principal cambia el rol o el acceso de un co-titular.";

export { CO_OWNER_ROLE_CHANGE_SUFFIX } from "@/lib/co-owner-types";

export const NO_LICENSE_COPY = "Sin matrícula cargada";

/** «MN 12345» · «MP 4567 · Córdoba» (`formatUserLicense` de CT-L, el mismo texto que el formulario). null = no la cargó. */
export function memberLicenseText(l: MemberLicense | null | undefined): string | null {
  return l ? formatUserLicense(l) : null;
}

/** Quién mira Usuarios. `principal` = el Titular (OWNER); `coOwner` = un Profesional con «Co-titular». */
export type TeamViewer = { principal: boolean; coOwner: boolean };

export type TeamRowAccess = {
  /** Switch «Co-titular»: solo el principal, en un Profesional activo (o para sacárselo a uno suspendido). */
  coOwnerSwitch: boolean;
  /** Fila sin selector de rol ni menú para quien mira, y el motivo (se muestra en la fila). null = no está bloqueada. */
  lockedReason: string | null;
  /** «Permisos» (Configuración delegada): el principal y el co-titular, nunca en la fila propia ni en la de un co-titular. */
  grants: boolean;
  /** «Planes y pagos» dentro de los permisos: solo el principal (el co-titular no lo delega, decisión del 05-nov). */
  billingGrant: boolean;
};

export function teamRowAccess(
  m: Pick<TeamMemberView, "role" | "isYou" | "disabledAt" | "joinedAt" | "grantCoOwner" | "grantBilling">,
  ctx: { isOwnerRow: boolean; staff: boolean; viewer: TeamViewer }
): TeamRowAccess {
  const { isOwnerRow, staff, viewer } = ctx;
  // `isCoOwner` (CT-K1): PRACTITIONER + `grantCoOwner`; un `grantCoOwner` en otro rol no abre nada (falla cerrado).
  const coOwnerRow = isCoOwner(m);
  const lockedReason = viewer.principal
    ? null
    : isOwnerRow
      ? OWNER_ROW_LOCKED_REASON
      : coOwnerRow && !m.isYou
        ? CO_OWNER_ROW_LOCKED_REASON
        : null;
  const grants = (viewer.principal || viewer.coOwner) && !isOwnerRow && !m.isYou && !coOwnerRow;
  return {
    // Activo = aceptó la invitación y no está suspendido (lo mismo que pide transferir la titularidad). Uno ya
    // co-titular y suspendido igual ve el switch: el principal tiene que poder sacárselo.
    coOwnerSwitch: viewer.principal && m.role === "PRACTITIONER" && (coOwnerRow || (!m.disabledAt && !!m.joinedAt)),
    lockedReason,
    grants,
    // T3d-1g: a la Secretaria y Facturación se les ofrece solo para sacárselo a una fila legada.
    billingGrant: grants && viewer.principal && (!staff || m.grantBilling),
  };
}

/** Confirmación del switch. Al prender, la matrícula (o que no la cargó) va en el texto: es el dato que pidió Martin. */
export function coOwnerConfirm(who: string, next: boolean, license: MemberLicense | null | undefined): ConfirmOptions {
  if (!next) {
    return {
      title: `¿Sacarle «Co-titular» a ${who}?`,
      message:
        "Deja de tener las funciones del titular. Sigue atendiendo con su agenda y conserva los permisos que tenía antes de ser co-titular.",
      confirmLabel: "Sacar co-titular",
      tone: "danger",
    };
  }
  const lic = memberLicenseText(license);
  return {
    title: `¿Hacer co-titular a ${who}?`,
    message:
      "Va a tener las mismas funciones que vos, salvo la suscripción a la plataforma, transferir la titularidad y tocar tu cuenta. " +
      "También va a poder exportar todos los datos del consultorio, con la historia clínica de los pacientes. " +
      (lic ? `Matrícula: ${lic}.` : "No cargó su matrícula.") +
      " Lo podés sacar cuando quieras.",
    confirmLabel: "Hacer co-titular",
  };
}

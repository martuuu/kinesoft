/**
 * LG-G (§27) · gate de aceptación legal del workspace `(app)` y URLs de `/aceptar-terminos`. Lógica PURA (la testea el
 * unit `tests/unit/lg-g-legal-gate.test.ts`); la consulta vive en `lib/legal-acceptance-internal.ts`.
 *
 * Decisión de Martin (27-oct, literal): «Términos en el alta asistida: excelente, lo ajustamos ahora entonces. Cuentas
 * que ya existían: si, da igual. Tenemos que resetar.» → prod se resetea y no hay cuentas viejas que cuidar: TODO
 * usuario que entra a `(app)` sin la versión vigente aceptada va a `/aceptar-terminos?next=<path>&via=app_gate`.
 * Cierra el hueco que dejó ZF1a (que solo encadenaba la pantalla en el link de activación del alta asistida): el
 * reenvío del link de acceso desde Plataforma, «olvidé mi contraseña» y entrar a `/dashboard` a mano después de
 * `/reset` llegaban al panel sin consentimiento registrado.
 *
 * Fuera del gate:
 *  - el acceso de SOPORTE de Plataforma (`actor.support`): el superadmin mira un consultorio ajeno en solo lectura; no
 *    es un usuario del consultorio y su aceptación no es la que importa ahí;
 *  - sin sesión real (el actor demo de dev, `KINESOFT_ALLOW_DEMO_ACTOR`): `/aceptar-terminos` exige una sesión
 *    verificada y lo mandaría al login, que no existe en ese modo;
 *  - Plataforma `(platform)` y el portal no pasan por este layout (superadmin y pacientes). El onboarding ya pide la
 *    casilla en su paso y el gate de onboarding corre ANTES que este en el layout.
 */
import { LEGAL_ACCEPT_PATH, LEGAL_PAGE_VIAS, type LegalPageVia } from "@/lib/legal";
import { safeNext } from "@/lib/safe-next";

export type LegalGateInput = {
  /** Hay sesión real (foto de acceso). false = actor demo de dev. */
  hasSession: boolean;
  /** Acceso de soporte de Plataforma (`actor.support`). */
  support: boolean;
  /** `hasAcceptedCurrentLegal(userId)` (irrelevante si está exento). */
  accepted: boolean;
  /** Path + query del request (`x-pathname`), o null. */
  nextPath: string | null;
};

/** Adónde mandar al usuario, o null si sigue. `next` pasa por `safeNext` (default `/dashboard`). */
export function legalGateFor(p: LegalGateInput): string | null {
  if (!p.hasSession || p.support || p.accepted) return null;
  return legalAcceptHref(safeNext(p.nextPath, "/dashboard"), "app_gate");
}

/**
 * URL de `/aceptar-terminos`. La vía por default (`platform_activation`, la del link de activación de ZF1a) NO viaja:
 * así la URL de la activación queda como estaba (`?next=…`, la fijan los tests de ZF1a) y solo el gate suma
 * `&via=app_gate`. `extra` (p. ej. `error=legal`) va al final.
 */
export function legalAcceptHref(next: string, via: LegalPageVia, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ next });
  if (via !== LEGAL_PAGE_VIAS[0]) q.set("via", via);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return `${LEGAL_ACCEPT_PATH}?${q}`;
}

/** `?via=` de la página → una de las dos vías; cualquier otra cosa (ausente, repetida, desconocida) → la default. */
export function legalPageViaFrom(v: unknown): LegalPageVia {
  return (LEGAL_PAGE_VIAS as readonly unknown[]).includes(v) ? (v as LegalPageVia) : LEGAL_PAGE_VIAS[0];
}

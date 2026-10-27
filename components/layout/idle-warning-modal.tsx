"use client";

/**
 * IN (§27): aviso «¿Seguís ahí?» 60 s antes del cierre por inactividad. Lo carga `idle-logout.tsx` con `next/dynamic`
 * recién cuando hace falta: el `Modal` del design system trae framer y no tiene por qué estar en el first load de cada
 * ruta del workspace.
 *
 * - «Seguir conectado» (primario) tiene el foco al abrirse (`autoFocus`: el focus trap del `Modal` no lo pisa, BO-Z C1),
 *   así un Enter alcanza. Cerrar con la X, Esc o el fondo también es «seguir»: es actividad de alguien que está.
 * - «Cerrar sesión» (ghost) es el mismo POST de siempre (sin `reason`: lo eligió la persona, no venció).
 * - El contador visible baja de a un segundo, pero NO está en `aria-live`: el lector anuncia solo `idleLiveMessage`
 *   (al abrirse, a los 30 y a los 10 s).
 * - Sin datos del paciente ni de la pantalla de atrás: el aviso puede quedar a la vista de cualquiera.
 * - `reducedMotion="user"`: el estado final del `Modal` se ve completo sin animación (variantes de `lib/motion`).
 */
import { Modal, ModalActions } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";

/**
 * Texto del `aria-live` del aviso. Cambia SOLO en tres escalones (al abrirse, a los 30 y a los 10 s): un contador que se
 * anuncia cada segundo tapa todo lo demás que el lector de pantalla tenga para decir. Vive acá y no en `idle-logout.tsx`
 * para que este módulo no importe aquel (lo carga él, con `next/dynamic`).
 */
export function idleLiveMessage(seconds: number): string {
  // Si la pestaña se vuelve visible con el aviso ya corriendo (p. ej. a los 45 s), igual dice 60: el contador visible
  // es el exacto; esto solo marca el escalón.
  if (seconds > 30) return "Quedan 60 segundos.";
  if (seconds > 10) return "Quedan 30 segundos.";
  return "Quedan 10 segundos.";
}

export function IdleWarningModal({ seconds, onStay }: { seconds: number; onStay: () => void }) {
  return (
    <Modal open onClose={onStay} title="¿Seguís ahí?" width={420}>
      <div data-testid="idle-warning">
        <p style={{ margin: "0 0 8px", fontSize: 15, color: "var(--navy-700)", lineHeight: 1.5 }}>
          Tu sesión se va a cerrar en <span data-testid="idle-warning-seconds">{seconds}</span> s por inactividad.
        </p>
        <p style={{ margin: "0 0 18px", fontSize: 14, color: "var(--navy-500)", lineHeight: 1.5 }}>
          Si tenés algo sin guardar, tocá “Seguir conectado”.
        </p>
        <p className="k-sr-only" aria-live="polite" aria-atomic="true">
          {idleLiveMessage(seconds)}
        </p>
        <ModalActions>
          <form action="/api/auth/sign-out" method="post" style={{ display: "contents" }}>
            {/* PV ZF2 (B17): sin `size` medían 42 px; `md` = 44 px (mínimo táctil de AGENTS.md §5) en todos los anchos. */}
            <Button type="submit" variant="ghost" size="md" data-testid="idle-signout">
              Cerrar sesión
            </Button>
          </form>
          <Button type="button" variant="primary" size="md" autoFocus onClick={onStay} data-testid="idle-stay">
            Seguir conectado
          </Button>
        </ModalActions>
      </div>
    </Modal>
  );
}

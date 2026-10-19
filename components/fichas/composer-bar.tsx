"use client";

/**
 * FC-3e1 (§24.7 «Inicio de la HC», FC-UI-D9) · Barra del composer ABAJO de 640 px.
 *
 * Por qué una barra y no el formulario inline también en mobile: a 390 px el formulario completo (tipo, título, turno,
 * diagnósticos, editor) empuja la primera ficha fuera de la pantalla, y lo que el profesional necesita ver al abrir
 * el paciente en el celular es la historia. La barra ocupa una línea, dice qué turno se va a usar (QA 1: «a 390 la
 * barra muestra el turno de hoy») y abre `FichaDrawer` a alto completo. El Drawer NO vive acá: lo monta el inicio de
 * la HC por `next/dynamic` (este archivo está en el first load y no puede arrastrarlo, `hc-first-load-guard`).
 *
 * El turno que se muestra es el mismo default que va a elegir el formulario (`pickDefaultComposerBooking`, FC-3c);
 * mientras esa función no exista (tira) o no haya turno hoy, la barra solo dice «Nueva ficha».
 */
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { IconPlus } from "@/components/ui/icons";
import { HC_HOME_COPY } from "@/components/fichas/fichas-copy";
import type { FichaBookingOption } from "@/components/fichas/fichas-ui-types";
import { bookingLabel } from "@/components/clinical-notes/clinical-notes-ui";
import { pickDefaultComposerBooking } from "@/lib/hc-composer-logic";

/** El turno que la barra anuncia: el fijo (deep link) o el default del chip. Pura, con test. */
export function composerBarBooking(input: {
  candidates: readonly FichaBookingOption[];
  fixedBooking?: FichaBookingOption | null;
  viewerPractitionerId: string | null;
  now: Date;
}): FichaBookingOption | null {
  if (input.fixedBooking) return input.fixedBooking;
  const open = input.candidates.filter((b) => !b.hasLiveNote);
  if (open.length === 0) return null;
  try {
    return pickDefaultComposerBooking({ candidates: open, ownPractitionerId: input.viewerPractitionerId, now: input.now });
  } catch {
    // FC-3c todavía no la implementó: sin turno anunciado (el formulario hace lo mismo).
    return null;
  }
}

export type ComposerBarProps = {
  candidates: readonly FichaBookingOption[];
  fixedBooking?: FichaBookingOption | null;
  viewerPractitionerId: string | null;
  onOpen: () => void;
  /** Precarga del chunk de `FichaDrawer` (hover/foco/touchstart) para que abra sin esperar. */
  onPreload?: () => void;
  /** Hay un borrador sin guardar en el Drawer (se cerró sin guardar): la barra lo dice. */
  dirty?: boolean;
  className?: string;
  /** Solo tests: reloj fijo. */
  now?: Date;
};

export function ComposerBar({
  candidates,
  fixedBooking = null,
  viewerPractitionerId,
  onOpen,
  onPreload,
  dirty = false,
  className,
  now,
}: ComposerBarProps) {
  const booking = composerBarBooking({ candidates, fixedBooking, viewerPractitionerId, now: now ?? new Date() });
  const label = bookingLabel(booking);
  const hintId = useId();
  const hint = dirty ? HC_HOME_COPY.draftDot : label;
  return (
    <div
      className={className}
      data-composer-bar=""
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        borderRadius: "var(--r-md)",
        border: "1px solid rgba(15,30,51,0.1)",
        background: "var(--card-bg)",
      }}
    >
      <Button
        type="button"
        variant="primary"
        className="k-evo-head-btn"
        onClick={onOpen}
        onPointerEnter={onPreload}
        onTouchStart={onPreload}
        onFocus={onPreload}
        aria-haspopup="dialog"
        // El turno (o «borrador sin guardar») es parte de lo que hace el botón: que el lector lo diga al enfocarlo.
        aria-describedby={hint ? hintId : undefined}
        style={{ fontSize: 13, padding: "8px 14px", flexShrink: 0 }}
      >
        <IconPlus size={14} /> {HC_HOME_COPY.composerBar}
      </Button>
      {hint && (
        <span id={hintId} style={{ fontSize: 12, color: "var(--navy-500)", minWidth: 0, overflowWrap: "anywhere" }}>
          {hint}
        </span>
      )}
    </div>
  );
}

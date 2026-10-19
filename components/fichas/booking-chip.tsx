"use client";

/**
 * [FC-3c] Chip del turno de la ficha (§24.7 «Chip del turno»).
 *
 * Por qué un chip y no el `<select>` de siempre: en el composer inline (≥640 px, siempre visible arriba de la HC) el
 * caso de todos los días es «la ficha del turno de recién», que `pickDefaultComposerBooking` ya eligió. Un select
 * abierto a la vista invita a tocarlo y ocupa una fila entera; el chip dice qué turno es y «Cambiar turno» abre la
 * lista (con «Sin turno») solo cuando hace falta. Desde la agenda, el toast o Seguimiento el turno es FIJO: el chip
 * no ofrece cambiarlo (la ficha es de ese turno, no de otro).
 *
 * La lista es un `<select>` nativo a propósito: teclado, lector de pantalla y la rueda de iOS/Android vienen gratis,
 * y la agenda de la Secretaria no suma un combobox propio (AGENTS §5: nada de patrones nuevos sin planning).
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { FICHA_FORM_COPY as COPY } from "@/components/fichas/fichas-copy";
import { bookingLabel } from "@/components/clinical-notes/clinical-notes-ui";

type ChipBooking = { id: string; scheduledFor: string; serviceName: string | null };

export type BookingChipProps = {
  id: string;
  /** null = «Sin turno». */
  value: string | null;
  /** Turno elegido (resuelto por el form). */
  selected: ChipBooking | null;
  /** Candidatos a elegir. Vacío y sin `fixed` → el chip solo informa. */
  choices: readonly ChipBooking[];
  /** El turno no se puede cambiar (entrada desde un turno, editar o enmendar). */
  fixed?: boolean;
  onChange?: (bookingId: string | null) => void;
  disabled?: boolean;
};

export function BookingChip({ id, value, selected, choices, fixed, onChange, disabled }: BookingChipProps) {
  const [open, setOpen] = useState(false);
  // Al cerrar la lista con Escape o eligiendo, el foco vuelve a «Cambiar turno» (el select se desmonta y el foco caía
  // al <body>). Al cerrar por blur NO: el foco ya se fue a donde el usuario lo llevó.
  const returnFocus = useRef(false);
  useEffect(() => {
    if (open || !returnFocus.current) return;
    returnFocus.current = false;
    // Por id: `Button` no reenvía refs.
    document.getElementById(`${id}-change`)?.focus();
  }, [open, id]);
  const closeList = (refocus: boolean) => {
    returnFocus.current = refocus;
    setOpen(false);
  };
  const label = bookingLabel(selected) ?? COPY.noBooking;
  const canChange = !fixed && Boolean(onChange) && choices.length > 0;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }} data-testid="ficha-booking-chip">
      <span id={`${id}-chip`}>
        <Tag tone={selected ? "sky" : "soft"} variant={selected ? "fill" : "outline"}>
          {label}
        </Tag>
      </span>
      {canChange && !open && (
        <Button
          id={`${id}-change`}
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen(true)}
          disabled={disabled}
          aria-describedby={`${id}-chip`}
        >
          {COPY.changeBooking}
        </Button>
      )}
      {canChange && open && (
        <>
          <label htmlFor={id} style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
            {COPY.bookingLabel}
          </label>
          <select
            id={id}
            className="k-input"
            value={value ?? ""}
            disabled={disabled}
            // Se abrió con «Cambiar turno»: el foco pasa a la lista (antes quedaba en un botón que ya no existe).
            autoFocus
            // Elegir cierra la lista: el chip vuelve a decir qué turno quedó.
            onChange={(e) => {
              onChange?.(e.target.value || null);
              closeList(true);
            }}
            onBlur={() => closeList(false)}
            onKeyDown={(e) => {
              // Escape cierra la lista y no el Drawer que contiene el formulario.
              if (e.key !== "Escape") return;
              e.preventDefault();
              e.stopPropagation();
              closeList(true);
            }}
            style={{ flex: "1 1 220px", minWidth: 0 }}
          >
            <option value="">{COPY.noBooking}</option>
            {choices.map((b) => (
              <option key={b.id} value={b.id}>
                {bookingLabel(b)}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}

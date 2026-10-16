"use client";

/**
 * EV2-3b · fila «Evolución» del drawer del turno.
 *
 * Carga perezosa: el drawer pide `getBookingClinicalNote(bookingId)` al abrir el turno, y SOLO si
 * `clinicalNoteRowEligible` (`./status-actions`: paciente vinculado + `clinical.read` + módulo `evoluciones`).
 * La Secretaria no tiene `clinical.read`: ni siquiera viaja la lectura. La barrera real es el server: `null` (sin acceso,
 * turno guest o ajeno) → la fila no se renderiza, sin decir si el turno tiene evolución.
 *
 * La nota se muestra con `NoteCard` en modo LECTURA (`readOnlyNote`). El motivo original (EV2-3b) era que el panel
 * del Drawer tenía `transform` y los diálogos que monta `NoteCard` quedaban `position: fixed` relativos al panel;
 * desde PF1.0-b Drawer y Modal van por portal, por eso «Ver versiones anteriores» ya se ofrece acá (PF1.1). Editar,
 * enmendar y anular siguen en la HC a propósito (un solo lugar para escribir). Se hacen desde la pestaña Evoluciones del paciente
 * (link «Abrir en la historia clínica», `clinicalNoteDeepLink`). Crear sí se ofrece acá: el editor se abre
 * AFUERA del drawer (lo monta `BookingDrawer`, que se cierra antes).
 *
 * Este archivo va en un chunk aparte (`dynamic` en `./index`): la lógica pura vive en `./status-actions`.
 */
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { NoteCard } from "@/components/clinical-notes/note-card";
import { clinicalNoteDeepLink } from "@/lib/clinical-notes-logic";
import type { BookingClinicalNoteView, ClinicalNoteDTO } from "@/lib/clinical-notes-types";
import { menuLabel, sectionCard } from "./styles";

export const CLINICAL_NOTE_ROW_COPY = {
  label: "Evolución",
  create: "Cargar evolución",
  empty: "Este turno todavía no tiene evolución.",
  openHc: "Abrir en la historia clínica",
  editInHc: "Editar, enmendar o anular en la historia clínica",
} as const;

/** Copia de lectura para el drawer: sin editar/enmendar/anular (ver cabecera). */
export function readOnlyNote(note: ClinicalNoteDTO): ClinicalNoteDTO {
  return { ...note, permissions: { canEdit: false, canAmend: false, canVoid: false, editableUntil: null } };
}

function canChangeInHc(view: BookingClinicalNoteView): boolean {
  const p = view.note?.permissions;
  return !!p && (p.canEdit || p.canAmend || p.canVoid);
}

export function ClinicalNoteRow({
  view,
  patientId,
  bookingId,
  pending,
  onCreate,
  onNavigate,
  now,
}: {
  /** null = sin acceso / todavía cargando / guest: no se renderiza nada. */
  view: BookingClinicalNoteView | null;
  patientId: string;
  bookingId: string;
  pending?: boolean;
  onCreate: () => void;
  /** Navegación con el dirty-guard del drawer. */
  onNavigate: (href: string) => void;
  /** Solo tests: reloj fijo. */
  now?: Date;
}) {
  if (!view) return null;
  // Sin viva y sin poder crear (p. ej. solo lectura, o turno cancelado sin evolución): nada que mostrar,
  // salvo anuladas, que se listan colapsadas.
  if (!view.note && !view.canCreate && view.voided.length === 0) return null;
  const href = clinicalNoteDeepLink(patientId, bookingId);

  return (
    <div style={{ ...sectionCard, display: "grid", gap: 10 }} data-testid="clinical-note-row">
      <div style={{ ...menuLabel, padding: 0 }}>{CLINICAL_NOTE_ROW_COPY.label}</div>

      {view.note ? (
        <NoteCard
          note={readOnlyNote(view.note)}
          amendments={view.amendments.map(readOnlyNote)}
          hideBooking
          now={now}
        />
      ) : (
        <>
          {view.voided.map((n) => (
            <NoteCard key={n.id} note={readOnlyNote(n)} hideBooking now={now} />
          ))}
          {view.canCreate && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12.5, color: "var(--navy-500)" }}>{CLINICAL_NOTE_ROW_COPY.empty}</span>
              <Button type="button" variant="primary" onClick={onCreate} disabled={pending}>
                {CLINICAL_NOTE_ROW_COPY.create}
              </Button>
            </div>
          )}
        </>
      )}

      {(view.note || view.voided.length > 0) && (
        <Link
          href={href}
          onClick={(e) => {
            e.preventDefault();
            onNavigate(href);
          }}
          // EV2-Z bajo: target táctil de 44 px (era una línea de texto de ~16 px de alto).
          style={{
            fontSize: 12.5,
            fontWeight: 700,
            color: "var(--sky-700)",
            textDecoration: "none",
            minHeight: 44,
            display: "inline-flex",
            alignItems: "center",
            justifySelf: "start",
          }}
        >
          {canChangeInHc(view) ? CLINICAL_NOTE_ROW_COPY.editInHc : CLINICAL_NOTE_ROW_COPY.openHc} →
        </Link>
      )}
    </div>
  );
}

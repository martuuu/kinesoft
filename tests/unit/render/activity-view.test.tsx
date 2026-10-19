/**
 * [EV2-3d] Actividad del paciente: los eventos de evoluciones (`clinicalNote.*`, EV2-D16) y la impresión auditada
 * (`clinicalRecord.print`, EV2-D11) salen con nombre en castellano, no con la clave cruda. Se monta la lista real
 * (`ActivityTimeline`, la misma que usa `ActivityView` después del fetch); solo se mockea la server action (red).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/patients", () => ({ getPatientActivity: async () => [] }));

import { renderToStaticMarkup } from "react-dom/server";
import { ActivityTimeline } from "@/components/patients/activity-view";
import type { ActivityEvent } from "@/lib/patients-types";

const ev = (action: string, i: number): ActivityEvent => ({
  id: `e${i}`,
  action,
  entity: "Patient",
  entityId: "p1",
  createdAt: new Date("2026-10-14T15:00:00Z"),
  actorName: "Ana Kine",
  ip: null,
  payload: null,
});

describe("[EV2-3d] actividad: evoluciones e impresión", () => {
  it.each([
    ["clinicalNote.create", "Ficha cargada"],
    ["clinicalNote.edit", "Ficha editada"],
    ["clinicalNote.amend", "Enmienda agregada a una ficha"],
    ["clinicalNote.void", "Ficha anulada"],
    ["clinicalRecord.print", "Historia clínica impresa"],
    // [FC-3h2] compartir con el paciente y descargas (C-FC7).
    ["patientDocument.share", "Ficha compartida con el paciente"],
    ["patientDocument.revoke", "Se dejó de compartir una ficha con el paciente"],
    ["patientDocument.download", "El paciente descargó una ficha compartida"],
    ["clinicalNote.download", "Ficha descargada"],
    ["clinicalRecord.download", "Historia clínica descargada"],
  ])("%s → «%s»", (action, label) => {
    const html = renderToStaticMarkup(<ActivityTimeline events={[ev(action, 1)]} />);
    expect(html).toContain(label);
    expect(html).not.toContain(action);
    expect(html).toContain("Paciente · Ana Kine");
  });

  it("la sesión registrada ya no se confunde con la evolución de HC (EV2-D19)", () => {
    const html = renderToStaticMarkup(<ActivityTimeline events={[ev("session.evolution", 1), ev("clinicalNote.create", 2)]} />);
    expect(html).toContain("Sesión registrada");
    expect(html.match(/Ficha cargada/g)).toHaveLength(1);
  });

  it("fecha y hora en AR (corre igual en TZ=UTC y TZ=AR)", () => {
    const html = renderToStaticMarkup(<ActivityTimeline events={[ev("clinicalRecord.print", 1)]} />);
    expect(html).toContain("12:00");
  });
});

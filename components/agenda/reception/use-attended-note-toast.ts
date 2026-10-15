"use client";

import { useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import type { ReceptionAction } from "@/lib/reception-state";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import { ATTENDED_NOTE_TOAST, attendedNoteHref, type ClinicalNoteViewer } from "./attended-note-toast";

/** Cuánto queda el toast: más que el default (4,5 s), el kine lo lee al despedir al paciente. */
const ATTENDED_NOTE_TOAST_MS = 10_000;

/**
 * EV2-3c: devuelve el callback que Recepción y /sala llaman con la fila CONFIRMADA por el server después de cada
 * acción OK. Si fue «Atendido» y el actor es el profesional de ese turno (`attendedNoteHref`), muestra el toast con
 * la acción «Cargar evolución» → perfil del paciente con `?turno=`. Estable entre renders (las cards de /sala son
 * `memo` y el hook de datos lo guarda en un ref).
 */
export function useAttendedNoteToast(
  viewer: { practitionerId: string | null; canReadClinical: boolean } | null | undefined
): (action: ReceptionAction, saved: BookingDTO) => void {
  const toast = useToast();
  const router = useOptionalRouter();
  const evolucionesOn = useTenantModules().has("evoluciones");
  const practitionerId = viewer?.practitionerId ?? null;
  const canReadClinical = !!viewer?.canReadClinical;
  const v = useMemo<ClinicalNoteViewer>(
    () => ({ practitionerId, canReadClinical, evolucionesOn }),
    [practitionerId, canReadClinical, evolucionesOn]
  );
  const ref = useRef({ v, toast, router });
  ref.current = { v, toast, router };

  return useCallback((action: ReceptionAction, saved: BookingDTO) => {
    const { v: viewerNow, toast: t, router: r } = ref.current;
    const href = attendedNoteHref(viewerNow, action, saved);
    if (!href) return;
    t.success(ATTENDED_NOTE_TOAST.title, {
      id: `attended-note:${saved.id}`,
      description: saved.patientName,
      duration: ATTENDED_NOTE_TOAST_MS,
      action: {
        label: ATTENDED_NOTE_TOAST.action,
        onClick: () => (r ? r.push(href) : window.location.assign(href)),
      },
    });
  }, []);
}

/**
 * `useRouter()` tira «invariant expected app router to be mounted» fuera del App Router: Recepción y /sala se
 * renderizan sueltas en los render tests (sin mock de `next/navigation`) y este hook no puede romperlas. El
 * `useContext` de adentro corre siempre (mismo orden de hooks); sin router, el toast navega con `location`.
 */
function useOptionalRouter(): ReturnType<typeof useRouter> | null {
  try {
    return useRouter();
  } catch {
    return null;
  }
}

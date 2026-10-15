"use server";

/**
 * EV2 (C-EV2-4) · Escrituras de evoluciones. STUB de EV2-1a: las firmas están congeladas para que EV2-2 compile en
 * paralelo; los cuerpos los implementa EV2-2a (reglas del brief §3 C-EV2-4: `withReadOnlyResult` → `getActor()` →
 * `assertModule(actor, "evoluciones")` → zod → `runWithRls` con `clinicalNoteGateInTx` adentro).
 * Hasta entonces fallan cerrado: nunca escriben.
 */
import type { ActionResult } from "@/lib/validation";
import type {
  AmendClinicalNoteInput,
  ClinicalNoteDTO,
  CreateClinicalNoteInput,
  EditClinicalNoteInput,
  VoidClinicalNoteInput,
} from "@/lib/clinical-notes-types";

export async function createClinicalNote(
  input: CreateClinicalNoteInput
): Promise<ActionResult<{ note: ClinicalNoteDTO; replayed: boolean }>> {
  void input;
  return { ok: false, error: "EV2-2" };
}

export async function editClinicalNote(input: EditClinicalNoteInput): Promise<ActionResult<{ note: ClinicalNoteDTO }>> {
  void input;
  return { ok: false, error: "EV2-2" };
}

export async function amendClinicalNote(
  input: AmendClinicalNoteInput
): Promise<ActionResult<{ note: ClinicalNoteDTO; replayed: boolean }>> {
  void input;
  return { ok: false, error: "EV2-2" };
}

export async function voidClinicalNote(input: VoidClinicalNoteInput): Promise<ActionResult<{ note: ClinicalNoteDTO }>> {
  void input;
  return { ok: false, error: "EV2-2" };
}

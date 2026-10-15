import type { ClinicalNoteKind } from "@prisma/client";
import { Tag } from "@/components/ui/tag";
import { CLINICAL_NOTE_KIND_LABEL } from "@/lib/clinical-notes-types";
import { KIND_TAG_TONE } from "@/components/clinical-notes/clinical-notes-ui";

/**
 * EV2-D8: tipo de la evolución con la primitiva `Tag` (sin estado: sirve en server y en client).
 *
 * EV2-Z M8: el tono `soft` (Alta) es fondo blanco con borde blanco: sobre una tarjeta blanca no se veía el pill.
 * [VX F-b2] El borde visible lo da la variante `outline` de `Tag` (antes iba inline acá).
 */
export function KindTag({ kind }: { kind: ClinicalNoteKind }) {
  const tone = KIND_TAG_TONE[kind];
  return (
    <Tag tone={tone} variant={tone === "soft" ? "outline" : "fill"}>
      {CLINICAL_NOTE_KIND_LABEL[kind]}
    </Tag>
  );
}

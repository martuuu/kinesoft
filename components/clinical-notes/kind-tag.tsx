import type { ClinicalNoteKind } from "@prisma/client";
import { Tag } from "@/components/ui/tag";
import { CLINICAL_NOTE_KIND_LABEL } from "@/lib/clinical-notes-types";
import { KIND_TAG_TONE } from "@/components/clinical-notes/clinical-notes-ui";

/** EV2-D8: tipo de la evolución con la primitiva `Tag` (sin estado: sirve en server y en client). */
export function KindTag({ kind }: { kind: ClinicalNoteKind }) {
  return <Tag tone={KIND_TAG_TONE[kind]}>{CLINICAL_NOTE_KIND_LABEL[kind]}</Tag>;
}

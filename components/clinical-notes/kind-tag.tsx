import type { ClinicalNoteKind } from "@prisma/client";
import { Tag } from "@/components/ui/tag";
import { CLINICAL_NOTE_KIND_LABEL } from "@/lib/clinical-notes-types";
import { KIND_TAG_TONE, SOFT_TAG_BORDER } from "@/components/clinical-notes/clinical-notes-ui";

/**
 * EV2-D8: tipo de la evolución con la primitiva `Tag` (sin estado: sirve en server y en client).
 *
 * EV2-Z M8: el tono `soft` (Alta) es fondo blanco con borde blanco: sobre una tarjeta blanca no se veía el pill. `Tag`
 * no recibe `style` y `.k-tag-soft` es global (cambiarla toca todos los tags del sistema), así que acá se arma el mismo
 * marcado (`k-tag k-tag-soft`) con el borde visible inline. Los otros tonos siguen siendo `Tag` tal cual.
 */
export function KindTag({ kind }: { kind: ClinicalNoteKind }) {
  const tone = KIND_TAG_TONE[kind];
  if (tone === "soft") {
    return (
      <span className="k-tag k-tag-soft" style={{ border: SOFT_TAG_BORDER }}>
        {CLINICAL_NOTE_KIND_LABEL[kind]}
      </span>
    );
  }
  return <Tag tone={tone}>{CLINICAL_NOTE_KIND_LABEL[kind]}</Tag>;
}

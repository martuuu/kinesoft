/**
 * [FC-3e2 → FC-3i1] Lógica pura de las DESCARGAS de una ficha (`download.ts`) y de `ShareFichaDialog`: URL de la ruta
 * auditada, status → mensaje, nombre del archivo y qué muestra el diálogo después de compartir. La prueba
 * `tests/unit/ficha-card-logic.test.ts` en TZ=UTC.
 *
 * Por qué aparte de `ficha-card-logic.ts` (FC-3i1, bundle de /pacientes/[id], §24.9): webpack reparte por MÓDULO; lo de
 * compartir vivía en el módulo de la tarjeta y viajaba con ella (primero en el first load, ahora en el chunk de la
 * timeline que se precarga con la hidratación) aunque solo lo usa `ShareFichaDialog`, que es diferido.
 */
import { CLINICAL_NOTE_COPY, type ClinicalNoteDTO } from "@/lib/clinical-notes-types";
import { HC_EXPORT_COPY, type HcFichaFormat } from "@/lib/hc-export-logic";
import { PATIENT_DOCUMENT_COPY, type DocumentDeliveryOutcome } from "@/lib/patient-documents-types";
import { FICHA_CARD_COPY as CARD_COPY, SHARE_FICHA_COPY as SHARE_COPY } from "@/components/fichas/fichas-copy";

/** `/api/pacientes/{id}/fichas/{rootId}/{pdf|docx}` (C-FC7). Mismo armado que `fichaPdfUrl` de use-ficha-backup. */
export function fichaDownloadUrl(patientId: string, rootId: string, format: HcFichaFormat): string {
  return `/api/pacientes/${encodeURIComponent(patientId)}/fichas/${encodeURIComponent(rootId)}/${format}`;
}

// ─── Descargas ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Tope del texto del server que se muestra en un toast (es nuestro, pero un proxy podría devolver un HTML entero). */
const SERVER_TEXT_MAX = 300;
function serverText(body: string | null | undefined, fallback: string): string {
  const t = (body ?? "").trim();
  if (!t || t.length > SERVER_TEXT_MAX || t.startsWith("<")) return fallback;
  return t;
}

/**
 * Status de la ruta (C-FC7) → mensaje. 413, 429 y 500 traen el copy en texto plano (FC-2g); 503 viene vacío a
 * propósito (falló el audit y no salió ni un byte). 404 no distingue ajeno de inexistente (igual que la ruta).
 */
export function downloadErrorMessage(status: number, body: string | null): string {
  switch (status) {
    case 401:
      return CARD_COPY.downloadSession;
    case 403:
      return CLINICAL_NOTE_COPY.forbidden;
    case 404:
      return CLINICAL_NOTE_COPY.notFound;
    case 413:
      return serverText(body, HC_EXPORT_COPY.fichaTooLarge);
    case 429:
      return serverText(body, HC_EXPORT_COPY.rateLimited);
    case 503:
      return CARD_COPY.downloadUnavailable;
    default:
      return serverText(body, HC_EXPORT_COPY.renderFailed);
  }
}

/**
 * Nombre del archivo desde el `Content-Disposition` de la ruta (`attachmentDisposition`: `filename*=UTF-8''…` con el
 * nombre real y `filename="…"` ASCII de respaldo). Se saca cualquier separador de ruta: el nombre lo arma el server,
 * pero el atributo `download` es una frontera igual.
 */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (header) {
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
    if (star) {
      try {
        const v = decodeURIComponent(star[1].trim());
        if (v) return sanitizeFilename(v);
      } catch {
        // `filename*` mal codificado: se prueba el ASCII.
      }
    }
    const plain = /filename\s*=\s*"([^"]*)"/i.exec(header);
    if (plain && plain[1].trim()) return sanitizeFilename(plain[1].trim());
  }
  return fallback;
}
function sanitizeFilename(name: string): string {
  return name.replace(/[\\/\u0000-\u001f]/g, "_");
}

// ─── Compartir ──────────────────────────────────────────────────────────────────────────────────────────────────

/** `first` = nunca compartida (o revocada); `reshare` = el documento vivo quedó viejo (la ficha cambió después). */
export function shareDialogVariant(note: Pick<ClinicalNoteDTO, "sharedDocument">): "first" | "reshare" {
  return note.sharedDocument?.status === "stale" ? "reshare" : "first";
}

export type ShareOutcomeView =
  | { kind: "linked"; message: string; warning: string | null }
  | { kind: "not-linked"; message: string; canInvite: boolean; noEmail: string | null };

/**
 * Qué muestra el diálogo después de compartir.
 * - Con portal: «Listo: el paciente ya lo ve…»; si se pidió aviso y el mail falló, el aviso aparte (`emailFailed`):
 *   el documento SÍ quedó compartido y no hay que reintentar. Si el server no lo mandó por el tope de avisos por
 *   paciente (`skipped`, M-2), lo mismo con `emailSkipped`.
 * - Sin portal (`patientPortal: "not-linked"`, `delivery.status: "no-portal-user"`): se ofrece «Invitar al portal»
 *   con `sendPatientPortalInvite` (§24.5); sin email cargado no hay a quién invitar → «Listo: la ficha quedó
 *   compartida…» + cómo seguir (T4-Z A2: antes decía «invitalo» aunque no hubiera cómo).
 */
export function shareOutcomeView(
  data: { patientPortal: "linked" | "not-linked"; delivery: DocumentDeliveryOutcome | null },
  patientEmail: string | null,
): ShareOutcomeView {
  if (data.patientPortal === "not-linked") {
    const hasEmail = Boolean(patientEmail && patientEmail.trim());
    return {
      kind: "not-linked",
      message: hasEmail ? PATIENT_DOCUMENT_COPY.sharedNoPortal : SHARE_COPY.sharedNoPortalNoEmail,
      canInvite: hasEmail,
      noEmail: hasEmail ? null : SHARE_COPY.noEmail,
    };
  }
  return {
    kind: "linked",
    message: PATIENT_DOCUMENT_COPY.shared,
    warning:
      data.delivery?.status === "failed"
        ? PATIENT_DOCUMENT_COPY.emailFailed
        : // M-2: tope de avisos por paciente; el documento SÍ quedó compartido, solo no salió el mail.
          data.delivery?.status === "skipped"
          ? SHARE_COPY.emailSkipped
          : null,
  };
}

/** Lo que el server dice de la cuenta del portal antes de compartir (M-3). Null = no llegó (falló o todavía no). */
export type PortalShareInfo = { portal: "linked" | "not-linked"; maskedEmail: string | null };

/**
 * Qué muestra el paso de confirmar (T4-Z A2 + M-3). La casilla «Avisarle por mail» solo aparece si el mail puede
 * salir: con portal vinculado sí (y se muestra su email ENMASCARADO, que arma el server: el completo nunca viaja);
 * con el portal sin vincular no (el server no manda nada, `no-portal-user`); sin el dato, si el paciente tiene email.
 * Sin email ni portal se avisa ANTES (`noEmail`) y se comparte sin aviso: no se manda un mail que la pantalla no mostró.
 */
export function shareConfirmView(patientEmail: string | null, info: PortalShareInfo | null) {
  const hasEmail = Boolean(patientEmail && patientEmail.trim());
  const masked = info?.maskedEmail?.trim() || null;
  if (info?.portal === "linked") {
    return { showNotify: true, noEmail: null, portalAccount: masked ? SHARE_COPY.portalAccount(masked) : null };
  }
  return {
    showNotify: info === null ? hasEmail : false,
    noEmail: hasEmail ? null : SHARE_COPY.noEmail,
    portalAccount: null,
  };
}

/** El estado nuevo de la tarjeta después de compartir (C-FC6 no devuelve la nota). */
export function sharedDocumentAfterShare(doc: { id: string; sharedAt: string }) {
  return { status: "live" as const, documentId: doc.id, sharedAt: doc.sharedAt };
}


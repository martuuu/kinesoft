import type { ClinicalRecordPrint } from "@/lib/clinical-notes-print-internal";
import { CLINICAL_NOTE_KIND_LABEL, CLINICAL_RECORD_PRINT_MAX, type ClinicalNoteDTO } from "@/lib/clinical-notes-types";
import { ClosePrintButton, PrintButton } from "./print-button";

/**
 * EV2-3d / EV2-Z · Vista de la impresión de la HC, separada de `page.tsx` (que lee, audita y decide el 404) para
 * poder renderizarla en un test sin base ni sesión. Sin estado: lo que se ve es lo que sale en papel.
 */

const TZ = "America/Argentina/Buenos_Aires";

export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: TZ,
  });
}

/** `dateOfBirth` es fecha calendario (YYYY-MM-DD): se formatea sin pasar por zona horaria. */
function fmtBirth(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return `${d}/${m}/${y}`;
}

export const PRINT_COPY = {
  truncated: (n: number) =>
    `Se imprimen las ${n} evoluciones más recientes. Para la historia completa, pedile la exportación al/la Titular.`,
  // Anula el autor o el Titular (`permissionsFor`): si no fue el autor, fue el Titular. No se lee el nombre del
  // Titular: el DTO no lo trae y para la HC alcanza con el rol.
  voidedBy: "el/la Titular",
  close: "Cerrar",
} as const;

/** «Anulada el {fecha} por {quién} · Motivo: {motivo}»; quién = el autor si anuló él, si no «el/la Titular». */
export function voidedLine(note: ClinicalNoteDTO): string | null {
  if (!note.voided) return null;
  const who = note.voided.byUserId === note.author.userId ? note.author.name : PRINT_COPY.voidedBy;
  return `Anulada el ${fmtDateTime(note.voided.at)} por ${who} · Motivo: ${note.voided.reason}`;
}

/** Pie de cada hoja: «Apellido, Nombre · DNI 30123456» (sin documento, solo el nombre). */
export function printFooter(p: ClinicalRecordPrint["patient"]): string {
  const name = `${p.lastName}, ${p.firstName}`;
  return p.documentId ? `${name} · DNI ${p.documentId}` : name;
}

type Entry = { note: ClinicalNoteDTO; amendments: ClinicalNoteDTO[] };

/**
 * Cuelga cada enmienda de su raíz (en el orden cronológico que ya viene). Una enmienda cuya raíz quedó fuera del
 * corte de CLINICAL_RECORD_PRINT_MAX sale suelta en su lugar: se imprime igual, marcada como enmienda.
 */
export function groupNotes(notes: ClinicalNoteDTO[]): Entry[] {
  const byId = new Map<string, Entry>();
  const out: Entry[] = [];
  for (const n of notes) {
    if (!n.amendsNoteId) {
      const e = { note: n, amendments: [] };
      byId.set(n.id, e);
      out.push(e);
    }
  }
  for (const n of notes) {
    if (!n.amendsNoteId) continue;
    const root = byId.get(n.amendsNoteId);
    if (root) root.amendments.push(n);
    else out.push({ note: n, amendments: [] });
  }
  return out.sort((a, b) => (a.note.occurredAt < b.note.occurredAt ? -1 : a.note.occurredAt > b.note.occurredAt ? 1 : 0));
}

/**
 * En papel (EV2-Z): antes se escondía todo con `visibility: hidden` y la raíz iba `position: absolute`; el shell
 * (sidebar, topbar, bandas) seguía ocupando lugar y el contenido largo se cortaba en la primera hoja. Ahora se saca
 * del flujo (`display: none`) todo lo que no sea la raíz, algo adentro de ella o un ancestro suyo (`:has`, no depende
 * de cómo esté armado el shell), y los ancestros se aplanan (`position: static`, sin alto fijo ni overflow) para que
 * el contenido corra por varias hojas. El pie va `position: fixed`: el navegador lo repite en cada hoja.
 * La anulada NO se tacha: tachado se vuelve ilegible en papel y la HC tiene que poder leerse entera.
 */
export const PRINT_CSS = `
.k-print-root { max-width: 820px; margin: 0 auto; color: #0f1e33; font-size: 13px; line-height: 1.5; }
.k-print-root h1 { font-size: 20px; margin: 0; }
.k-print-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 6px 18px; margin-top: 10px; }
.k-print-meta dt { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--navy-500); }
.k-print-meta dd { margin: 0; font-weight: 600; }
.k-print-note { border-top: 1px solid rgba(15,30,51,0.15); padding: 12px 0; break-inside: avoid; }
.k-print-note-head { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--navy-500); }
.k-print-note-head strong { color: #0f1e33; }
.k-print-body { white-space: pre-wrap; margin-top: 6px; }
.k-print-flag { font-weight: 700; font-size: 12px; }
.k-print-amend { margin: 10px 0 0 18px; padding-left: 12px; border-left: 2px solid rgba(15,30,51,0.2); }
.k-print-footer { display: none; }
@media print {
  @page { margin: 16mm 16mm 20mm; }
  body *:not(:has(.k-print-root)):not(.k-print-root):not(.k-print-root *) { display: none !important; }
  body, body *:has(.k-print-root) {
    display: block !important; position: static !important; height: auto !important; min-height: 0 !important;
    max-height: none !important; overflow: visible !important; margin: 0 !important; padding: 0 !important;
    width: auto !important; max-width: none !important; background: none !important; box-shadow: none !important;
    border: 0 !important; transform: none !important;
  }
  .k-print-root { position: static; width: 100%; max-width: none; font-size: 11pt; }
  .k-print-hide { display: none !important; }
  .k-print-footer { display: block; position: fixed; bottom: 0; left: 0; right: 0; font-size: 9pt; color: #555; text-align: center; }
}
`;

function NoteBlock({ note, amendment }: { note: ClinicalNoteDTO; amendment?: boolean }) {
  const label = amendment || note.amendsNoteId ? "Enmienda" : CLINICAL_NOTE_KIND_LABEL[note.kind];
  const voided = voidedLine(note);
  return (
    <div className={note.voided ? "k-print-voided" : undefined} data-note-id={note.id}>
      <div className="k-print-note-head">
        <strong>{label}</strong>
        <span>{fmtDateTime(note.occurredAt)}</span>
        <span>{note.author.name}</span>
        {note.booking?.serviceName && <span>Turno: {note.booking.serviceName}</span>}
        {note.revision > 1 && <span>Editada (versión {note.revision})</span>}
      </div>
      {voided && <div className="k-print-flag">{voided}</div>}
      {note.title && <div style={{ fontWeight: 600, marginTop: 4 }}>{note.title}</div>}
      <div className="k-print-body">{note.body}</div>
    </div>
  );
}

export function ClinicalRecordPrintView({ record, backHref }: { record: ClinicalRecordPrint; backHref: string }) {
  const entries = groupNotes(record.notes);
  const { patient } = record;
  return (
    <div className="k-print-root">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      <div
        className="k-print-hide"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 16 }}
      >
        {/* Se abre en una pestaña nueva desde el perfil (target=_blank): «Volver» dejaba dos perfiles abiertos. */}
        <ClosePrintButton fallbackHref={backHref} />
        <PrintButton />
      </div>

      <header>
        <div style={{ fontSize: 12, color: "var(--navy-500)" }}>{record.tenantName}</div>
        <h1>Historia clínica</h1>
        <dl className="k-print-meta">
          <div>
            <dt>Paciente</dt>
            <dd>
              {patient.lastName}, {patient.firstName}
            </dd>
          </div>
          {patient.documentId && (
            <div>
              <dt>Documento</dt>
              <dd>{patient.documentId}</dd>
            </div>
          )}
          {patient.dateOfBirth && (
            <div>
              <dt>Fecha de nacimiento</dt>
              <dd>{fmtBirth(patient.dateOfBirth)}</dd>
            </div>
          )}
          <div>
            <dt>Impresa</dt>
            <dd>
              {fmtDateTime(record.printedAt)} · {record.printedBy}
            </dd>
          </div>
        </dl>
      </header>

      {record.truncated && (
        <p className="k-print-flag" style={{ marginTop: 14 }}>
          {PRINT_COPY.truncated(CLINICAL_RECORD_PRINT_MAX)}
        </p>
      )}

      <section style={{ marginTop: 18 }}>
        {entries.length === 0 ? (
          <p style={{ color: "var(--navy-500)" }}>Todavía no hay evoluciones cargadas para este paciente.</p>
        ) : (
          entries.map(({ note, amendments }) => (
            <article key={note.id} className="k-print-note">
              <NoteBlock note={note} />
              {amendments.map((a) => (
                <div key={a.id} className="k-print-amend">
                  <NoteBlock note={a} amendment />
                </div>
              ))}
            </article>
          ))
        )}
      </section>

      <div className="k-print-footer" aria-hidden="true">
        {printFooter(patient)}
      </div>
    </div>
  );
}

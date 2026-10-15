import Link from "next/link";
import { notFound } from "next/navigation";
import { getActor } from "@/lib/session";
import { loadClinicalRecordForPrint } from "@/lib/clinical-notes-print-internal";
import { CLINICAL_NOTE_KIND_LABEL, CLINICAL_RECORD_PRINT_MAX, type ClinicalNoteDTO } from "@/lib/clinical-notes-types";
import { PrintButton } from "./print-button";

/**
 * EV2-3d (EV2-D11) · «Imprimir historia clínica».
 *
 * Server y `force-dynamic`: cada visita es una impresión auditada (`clinicalRecord.print`), nunca una página cacheada.
 * Toda la decisión de acceso y el audit viven en `loadClinicalRecordForPrint` (C-EV2-6): null → `notFound()` (no
 * distingue «no existe» de «no podés»); si el audit falla, tira y la página no llega a renderizar ni una nota.
 *
 * Sin framer ni nada animado (el estado final es el impreso). El layout `(app)` sigue alrededor (sidebar, bandas):
 * en papel se esconde todo salvo `.k-print-root` con el truco de `visibility`, que no depende de cómo esté armado
 * el shell. Solo datos de ESTE paciente; el autor sale de `authorName` (snapshot de `displayUserName`, nunca email).
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Historia clínica · KineSoft" };

const TZ = "America/Argentina/Buenos_Aires";

function fmtDateTime(iso: string): string {
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

type Entry = { note: ClinicalNoteDTO; amendments: ClinicalNoteDTO[] };

/**
 * Cuelga cada enmienda de su raíz (en el orden cronológico que ya viene). Una enmienda cuya raíz quedó fuera del
 * corte de CLINICAL_RECORD_PRINT_MAX sale suelta en su lugar: se imprime igual, marcada como enmienda.
 */
function groupNotes(notes: ClinicalNoteDTO[]): Entry[] {
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

const PRINT_CSS = `
.k-print-root { max-width: 820px; margin: 0 auto; color: #0f1e33; font-size: 13px; line-height: 1.5; }
.k-print-root h1 { font-size: 20px; margin: 0; }
.k-print-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 6px 18px; margin-top: 10px; }
.k-print-meta dt { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--navy-500); }
.k-print-meta dd { margin: 0; font-weight: 600; }
.k-print-note { border-top: 1px solid rgba(15,30,51,0.15); padding: 12px 0; break-inside: avoid; }
.k-print-note-head { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--navy-500); }
.k-print-note-head strong { color: #0f1e33; }
.k-print-body { white-space: pre-wrap; margin-top: 6px; }
.k-print-voided .k-print-body { text-decoration: line-through; color: var(--navy-500); }
.k-print-flag { font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; }
.k-print-amend { margin: 10px 0 0 18px; padding-left: 12px; border-left: 2px solid rgba(15,30,51,0.2); }
@media print {
  @page { margin: 16mm; }
  body * { visibility: hidden; }
  .k-print-root, .k-print-root * { visibility: visible; }
  .k-print-root { position: absolute; left: 0; top: 0; width: 100%; max-width: none; font-size: 11pt; }
  .k-print-hide { display: none !important; }
}
`;

function NoteBlock({ note, amendment }: { note: ClinicalNoteDTO; amendment?: boolean }) {
  const label = amendment || note.amendsNoteId ? "Enmienda" : CLINICAL_NOTE_KIND_LABEL[note.kind];
  return (
    <div className={note.voided ? "k-print-voided" : undefined} data-note-id={note.id}>
      <div className="k-print-note-head">
        <strong>{label}</strong>
        <span>{fmtDateTime(note.occurredAt)}</span>
        <span>{note.author.name}</span>
        {note.booking?.serviceName && <span>Turno · {note.booking.serviceName}</span>}
        {note.revision > 1 && <span>Editada (versión {note.revision})</span>}
      </div>
      {note.voided && (
        <div className="k-print-flag">
          Anulada el {fmtDateTime(note.voided.at)} · Motivo: {note.voided.reason}
        </div>
      )}
      {note.title && <div style={{ fontWeight: 600, marginTop: 4 }}>{note.title}</div>}
      <div className="k-print-body">{note.body}</div>
    </div>
  );
}

export default async function PrintClinicalRecordPage({ params }: { params: { id: string } }) {
  const actor = await getActor();
  const record = await loadClinicalRecordForPrint(actor, params.id);
  if (!record) notFound();

  const entries = groupNotes(record.notes);
  const { patient } = record;

  return (
    <div className="k-print-root">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      <div className="k-print-hide" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <Link href={`/pacientes/${params.id}?tab=evoluciones`} style={{ color: "var(--sky-700)", fontWeight: 600, fontSize: 13 }}>
          ← Volver al perfil
        </Link>
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
          Se imprimen las {CLINICAL_RECORD_PRINT_MAX} evoluciones más recientes. Para la historia completa, exportá los
          datos del consultorio.
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
    </div>
  );
}

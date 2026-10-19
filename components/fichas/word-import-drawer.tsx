"use client";

/**
 * [FC-3f] `WordImportDrawer` · importar fichas desde archivos .docx (§24.7 «Importar Word», FC-D10/D11). Firma
 * congelada: `WordImportDrawerProps` (fichas-ui-types.ts).
 *
 * DIFERIDO siempre (§24.9): el inicio de la HC lo carga por `next/dynamic` al abrir «Importar fichas de Word»; nunca
 * entra al first load de `/pacientes/[id]` (`hc-first-load-guard.test.ts`). mammoth baja recién al leer el primer
 * archivo (`word-reader.ts`, por `import()`).
 *
 * Bundle (`/agenda` sin margen, FC-3i1): este grupo NO abre chunks nuevos salvo el de mammoth. `word-reader` va
 * estático (ver su cabecera: con `import()` eran 4 chunks nuevos) y `HC_SSR_PARTS` ancla acá la tarjeta y el composer
 * (`hc-ssr-parts.ts`): el drawer usa `lib/hc-doc.ts`, que vive en ese chunk, y sin el ancla splitChunks sacaba hc-doc
 * a un chunk compartido NUEVO (medido: +1 entrada en el runtime de todas las rutas). Con el ancla el grupo del drawer
 * contiene el de la HC entero y reusa su chunk tal cual; en el perfil ese chunk ya está cargado (SSR + precarga), así
 * que no se baja nada de más. Tiptap (~97 kB gz, ya en caché si el editor se precargó) sí baja con el drawer.
 *
 * Flujo, y por qué cada paso:
 *  1. Chequeos baratos antes de leer: extensión (`.doc` con su aviso), 10 MB, 50 por tanda, y los 4 bytes mágicos
 *     del zip (un PDF renombrado no llega a mammoth).
 *  2. Lectura en el navegador, DE A UNO (50 × 10 MB en paralelo es medio GB de ArrayBuffers en un celular). El .docx
 *     nunca viaja: a la action solo va el `bodyDoc` (`buildImportInputs`).
 *  3. Fecha por archivo (nombre o `lastModified`, mostrando de dónde salió) editable, y la casilla obligatoria «Revisé
 *     las fechas»: las dos fuentes son conjeturas y la fecha de una «carga tardía» es lo que se lee en la HC.
 *  4. Más de 20.000 caracteres → «Dividir en N fichas»: hay que tildarlo, así nadie se encuentra 7 fichas sin haberlo
 *     elegido. Sin tildar, ese archivo no se importa.
 *  5. Una action por parte, en serie, cada una con SU clave (estable mientras el drawer está abierto): si una falla por
 *     red, «Importar» de nuevo sigue desde la que falló y las que ya entraron no se duplican (replay).
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { WORD_IMPORT_COPY as COPY } from "@/components/fichas/fichas-copy-deferred";
import type { WordImportDrawerProps } from "@/components/fichas/fichas-ui-types";
import {
  buildImportInputs,
  hasDocxMagic,
  importDateIssue,
  limitWordFiles,
  precheckWordFile,
  prepareImportedDoc,
  resolveImportDate,
  type ImportDateSource,
} from "@/components/fichas/word-import-logic";
import { newIdempotencyKey } from "@/components/clinical-notes/clinical-notes-ui";
import { createClinicalNote } from "@/lib/clinical-notes";
import type { ClinicalNoteDTO } from "@/lib/clinical-notes-types";
import { HC_DOC_ERROR_COPY, type HcDoc } from "@/lib/hc-doc";
import { toARDateKey } from "@/lib/datetime-ar";

import { readWordDocx, WORD_READER_EDITOR_ANCHOR } from "@/components/fichas/word-reader";
import * as HC_SSR_PARTS from "@/components/patients/profile/views/hc-ssr-parts";

/**
 * Anclas de bundle (ver cabecera y la de `word-reader.ts`). Van en un export de ESTE módulo a propósito: lo carga un
 * `import()` (`hc-header-actions`), así webpack da por usados todos sus exports y no poda las referencias (en un
 * export de `word-reader`, que se importa con nombre, el inner graph las sacaba).
 */
export const WORD_IMPORT_BUNDLE_ANCHORS = [HC_SSR_PARTS, WORD_READER_EDITOR_ANCHOR];

type Row = {
  id: string;
  file: File;
  /** Error que deja el archivo afuera (no se puede importar). */
  error: string | null;
  reading: boolean;
  date: string;
  /** De dónde salió la fecha; null = no había (o se cambió a mano: ya no se muestra la fuente). */
  dateSource: ImportDateSource | null;
  dateFound: boolean;
  parts: HcDoc[];
  chars: number;
  images: number;
  splitConfirmed: boolean;
  /** Una clave por parte, generadas al leer: el reintento de la misma parte es replay. */
  keys: string[];
  /** Partes ya creadas (la siguiente a mandar es `parts[saved]`). */
  saved: number;
  saveError: string | null;
};

const ISSUE_COPY = { doc: COPY.docWarning, "not-docx": COPY.notDocx, "too-big": COPY.tooBig } as const;

function pendingParts(r: Row): number {
  return r.parts.length - r.saved;
}

/** La fila entra en el próximo «Importar»: leída sin error, con algo pendiente y, si se divide, con la casilla. */
function isImportable(r: Row): boolean {
  return !r.error && !r.reading && pendingParts(r) > 0 && (r.parts.length === 1 || r.splitConfirmed);
}

export function WordImportDrawer({ open, onClose, patientId, patientName, onImported }: WordImportDrawerProps) {
  const toast = useToast();
  const uid = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [dropped, setDropped] = useState(0);
  const [reviewed, setReviewed] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // Un lote por apertura del drawer: agrupa en `importSource.batchId` lo que se importó junto.
  const [batchId] = useState(newIdempotencyKey);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const busy = progress !== null;
  const patch = useCallback((id: string, p: Partial<Row>) => {
    if (alive.current) setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  }, []);

  const readRow = useCallback(
    async (row: Row) => {
      try {
        if (!hasDocxMagic(new Uint8Array(await row.file.slice(0, 4).arrayBuffer()))) {
          return patch(row.id, { reading: false, error: COPY.notDocx });
        }
        const buf = await row.file.arrayBuffer();
        const read = await readWordDocx(buf);
        if (!read.ok) return patch(row.id, { reading: false, error: COPY.unreadable });
        const prepared = prepareImportedDoc(read.raw);
        if (!prepared.ok) {
          const error =
            prepared.reason === "empty"
              ? COPY.empty
              : prepared.reason === "too-many-parts"
                ? COPY.tooManyParts
                : HC_DOC_ERROR_COPY[prepared.reason];
          return patch(row.id, { reading: false, error });
        }
        patch(row.id, {
          reading: false,
          parts: prepared.parts,
          chars: prepared.chars,
          images: read.images,
          keys: prepared.parts.map(() => newIdempotencyKey()),
        });
      } catch {
        // El chunk de mammoth no bajó (red) o el navegador no pudo leer el archivo.
        patch(row.id, { reading: false, error: COPY.unreadable });
      }
    },
    [patch]
  );

  const addFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const { accepted, dropped: out } = limitWordFiles(Array.from(list), rows.length);
    setDropped(out);
    const fresh: Row[] = accepted.map((file, i) => {
      const issue = precheckWordFile(file);
      const date = resolveImportDate(file);
      return {
        id: `${uid}-${Date.now()}-${i}`,
        file,
        error: issue ? ISSUE_COPY[issue] : null,
        reading: !issue,
        date: date?.date ?? "",
        dateSource: date?.source ?? null,
        dateFound: date !== null,
        parts: [],
        chars: 0,
        images: 0,
        splitConfirmed: false,
        keys: [],
        saved: 0,
        saveError: null,
      };
    });
    if (fresh.length) setReviewed(false); // fechas nuevas: hay que volver a revisarlas
    setRows((rs) => [...rs, ...fresh]);
    // En serie (ver cabecera): cada lectura espera a la anterior.
    for (const row of fresh.filter((r) => r.reading)) queue.current = queue.current.then(() => readRow(row));
  };

  const now = new Date(); // «hoy» para la validación de fechas: barato y siempre al día en cada render
  const importable = rows.filter(isImportable);
  const dateIssues = importable.filter((r) => importDateIssue(r.date, now) !== null);
  const total = importable.reduce((n, r) => n + pendingParts(r), 0);
  const stillReading = rows.some((r) => r.reading);
  const canImport = !busy && !stillReading && total > 0 && dateIssues.length === 0 && reviewed;
  const dirty = rows.some((r) => r.reading || (!r.error && pendingParts(r) > 0));

  const runImport = async () => {
    if (!canImport) return;
    const created: ClinicalNoteDTO[] = [];
    let done = 0;
    let failed = false;
    setProgress({ done, total });
    for (const row of importable) {
      const inputs = buildImportInputs({ patientId, file: row.file, dateKey: row.date, batchId, parts: row.parts, keys: row.keys });
      let saved = row.saved;
      let saveError: string | null = null;
      for (; saved < inputs.length; saved++) {
        let res: Awaited<ReturnType<typeof createClinicalNote>>;
        try {
          res = await createClinicalNote(inputs[saved]);
        } catch {
          res = { ok: false, error: COPY.network };
        }
        if (!res.ok) {
          // Se corta este archivo (sus partes van en orden) y se sigue con el próximo.
          saveError = res.error;
          failed = true;
          break;
        }
        created.push(res.data.note);
        done++;
        if (alive.current) setProgress({ done, total });
      }
      patch(row.id, { saved, saveError });
    }
    if (!alive.current) return;
    setProgress(null);
    onImported(created);
    if (created.length) toast.success(COPY.done(created.length));
    if (failed) toast.error(COPY.someFailed);
    else onClose();
  };

  const remove = (id: string) => setRows((rs) => rs.filter((r) => r.id !== id));

  return (
    <Drawer open={open} onClose={() => !busy && onClose()} title={COPY.title} width={560} dirty={dirty} dirtyMessage={COPY.dirty}>
      <div style={{ display: "grid", gap: 14 }}>
        <p style={{ margin: 0, fontSize: 14, color: "var(--navy-900)" }}>
          <strong>Paciente: {patientName}</strong>
        </p>
        <div style={{ display: "grid", gap: 4, fontSize: 13, color: "var(--navy-700)" }}>
          <p style={{ margin: 0 }}>{COPY.intro}</p>
          <p style={{ margin: 0, color: "var(--navy-500)" }}>
            {COPY.limits} {COPY.privacy}
          </p>
        </div>

        <div>
          <input
            ref={inputRef}
            id={`${uid}-files`}
            type="file"
            multiple
            accept=".docx,.doc,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            hidden
            data-testid="word-import-input"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = ""; // volver a elegir el mismo archivo dispara onChange
            }}
          />
          <Button type="button" variant={rows.length ? "ghost" : "primary"} disabled={busy} onClick={() => inputRef.current?.click()}>
            {rows.length ? COPY.pickMore : COPY.pick}
          </Button>
        </div>

        {dropped > 0 && (
          <p role="alert" style={{ margin: 0, fontSize: 13, color: "var(--danger-fg)" }}>
            {COPY.dropped(dropped)}
          </p>
        )}

        {rows.length > 0 && (
          <ul aria-label={COPY.title} style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
            {rows.map((r) => (
              <WordImportRow
                key={r.id}
                row={r}
                now={now}
                busy={busy}
                onDate={(date) => patch(r.id, { date, dateSource: null })}
                onSplit={(splitConfirmed) => patch(r.id, { splitConfirmed })}
                onRemove={() => remove(r.id)}
              />
            ))}
          </ul>
        )}

        {rows.length > 0 && (
          <div style={{ display: "grid", gap: 10, borderTop: "1px solid var(--navy-100)", paddingTop: 12 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--navy-500)" }}>{COPY.lateEntryHint}</p>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, color: "var(--navy-900)", minHeight: 44 }}>
              <input
                type="checkbox"
                data-testid="word-import-reviewed"
                checked={reviewed}
                disabled={busy}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              {COPY.datesReviewed}
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                {COPY.close}
              </Button>
              <Button type="button" disabled={!canImport} onClick={() => void runImport()} data-testid="word-import-confirm">
                {progress ? COPY.importing(progress.done, progress.total) : total > 0 ? COPY.confirm(total) : COPY.confirmEmpty}
              </Button>
            </div>
            <p role="status" aria-live="polite" style={{ margin: 0, fontSize: 0, height: 0, overflow: "hidden" }}>
              {progress ? COPY.importing(progress.done, progress.total) : ""}
            </p>
          </div>
        )}
      </div>
    </Drawer>
  );
}

function WordImportRow({
  row: r,
  now,
  busy,
  onDate,
  onSplit,
  onRemove,
}: {
  row: Row;
  now: Date;
  busy: boolean;
  onDate: (date: string) => void;
  onSplit: (on: boolean) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const doneAll = !r.error && !r.reading && r.parts.length > 0 && pendingParts(r) === 0;
  const issue = !r.error && !r.reading && !doneAll ? importDateIssue(r.date, now) : null;
  const dateNote =
    issue === "future"
      ? COPY.dateFuture
      : issue === "invalid"
        ? r.dateFound
          ? COPY.dateInvalid
          : COPY.dateMissing
        : r.dateSource === "name"
          ? COPY.dateFromName
          : r.dateSource === "modified"
            ? COPY.dateFromModified
            : null;
  const muted = { margin: 0, fontSize: 12, color: "var(--navy-500)" } as const;

  return (
    <li
      data-testid="word-import-row"
      style={{ border: "1px solid var(--navy-100)", borderRadius: "var(--r-md)", padding: 12, display: "grid", gap: 8 }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", justifyContent: "space-between" }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--navy-900)", overflowWrap: "anywhere" }}>{r.file.name}</p>
          {!r.error && !r.reading && r.parts.length > 0 && (
            <p style={muted}>
              {COPY.chars(r.chars)}
              {doneAll ? ` · ${COPY.imported}` : ""}
            </p>
          )}
        </div>
        {!doneAll && (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onRemove} aria-label={COPY.removeLabel(r.file.name)}>
            {COPY.remove}
          </Button>
        )}
      </div>

      {r.reading && (
        <p role="status" style={muted}>
          {COPY.reading}
        </p>
      )}
      {r.error && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: "var(--danger-fg)" }}>
          {r.error}
        </p>
      )}

      {!r.error && !r.reading && !doneAll && (
        <>
          <div style={{ display: "grid", gap: 4 }}>
            <label htmlFor={`${id}-date`} style={{ fontSize: 13, color: "var(--navy-700)" }}>
              {COPY.dateLabel}
            </label>
            {/* Excepción de AGENTS.md §4: `<input type="date">` da "AAAA-MM-DD" sin hora ni zona; la hora (12:00 AR) la
                pone `importOccurredAt`. */}
            <input
              id={`${id}-date`}
              type="date"
              className="k-input"
              value={r.date}
              max={toARDateKey(now)}
              disabled={busy}
              aria-invalid={issue ? true : undefined}
              aria-describedby={dateNote ? `${id}-date-note` : undefined}
              onChange={(e) => onDate(e.target.value)}
              style={{ maxWidth: 200 }}
            />
            {dateNote && (
              <p id={`${id}-date-note`} style={{ ...muted, color: issue ? "var(--danger-fg)" : muted.color }}>
                {dateNote}
              </p>
            )}
          </div>

          {r.parts.length > 1 && (
            <div style={{ display: "grid", gap: 2 }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, color: "var(--navy-900)", minHeight: 44 }}>
                <input type="checkbox" checked={r.splitConfirmed} disabled={busy || r.saved > 0} onChange={(e) => onSplit(e.target.checked)} />
                {COPY.split(r.parts.length)}
              </label>
              {!r.splitConfirmed && <p style={muted}>{COPY.splitHint}</p>}
            </div>
          )}

          {r.images > 0 && <p style={muted}>{COPY.imagesOmitted(r.images)}</p>}
          {r.saveError && (
            <p role="alert" style={{ margin: 0, fontSize: 13, color: "var(--danger-fg)" }}>
              {r.saveError}
            </p>
          )}
        </>
      )}
    </li>
  );
}

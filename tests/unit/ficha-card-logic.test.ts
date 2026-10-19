/**
 * [FC-3e2] Lógica pura de la tarjeta de ficha, el menú «⋯», las descargas y el diálogo de compartir
 * (`components/fichas/ficha-card-logic.ts`, `download.ts`). Permisos armados con el `permissionsFor` real; las fechas
 * se afirman en hora AR (corre igual en TZ=UTC y TZ=AR). `downloadFicha` se prueba con un `fetch` falso (la red es lo
 * único que se mockea) y afirmando lo observable: el toast que sale y el archivo que se guarda.
 */
import { describe, expect, it } from "vitest";
import {
  diagnosisChips,
  fichaAuthorLine,
  fichaBackupTarget,
  fichaChips,
  fichaMenuItems,
  fichaRootId,
  isFoldableBody,
  type FichaMenuOptions,
} from "@/components/fichas/ficha-card-logic";
import {
  downloadErrorMessage,
  fichaDownloadUrl,
  filenameFromDisposition,
  shareDialogVariant,
  shareOutcomeView,
  sharedDocumentAfterShare,
} from "@/components/fichas/ficha-share-download-logic";
import { downloadFicha } from "@/components/fichas/download";
import { fichaPdfUrl } from "@/components/fichas/use-ficha-backup";
import { FICHA_CARD_COPY, SHARE_FICHA_COPY } from "@/components/fichas/fichas-copy";
import { permissionsFor } from "@/lib/clinical-notes-logic";
import { CLINICAL_NOTE_COPY, type ClinicalNoteDTO } from "@/lib/clinical-notes-types";
import { HC_EXPORT_COPY } from "@/lib/hc-export-logic";
import { PATIENT_DOCUMENT_COPY } from "@/lib/patient-documents-types";
import type { DiagnosisSnapshot } from "@/lib/diagnoses-types";

const AUTHOR = "user-author";
const NOW = new Date("2026-10-15T14:00:00.000Z"); // 11:00 AR

function note(over: Partial<ClinicalNoteDTO> = {}, ctx: { actor?: string; owner?: boolean; canWrite?: boolean } = {}): ClinicalNoteDTO {
  const n: ClinicalNoteDTO = {
    id: "note-1",
    patientId: "pat-1",
    bookingId: null,
    amendsNoteId: null,
    kind: "EVOLUTION",
    title: "Control de hombro",
    body: "Mejoró la movilidad.",
    occurredAt: "2026-10-15T12:30:00.000Z",
    author: { userId: AUTHOR, practitionerId: "pr-1", name: "Lic. Pérez" },
    revision: 1,
    createdAt: "2026-10-15T13:00:00.000Z",
    updatedAt: "2026-10-15T13:00:00.000Z",
    voided: null,
    booking: null,
    permissions: { canEdit: false, canAmend: false, canVoid: false, editableUntil: null },
    bodyDoc: null,
    diagnoses: [],
    authorLicense: null,
    importSource: null,
    lateEntry: false,
    sharedDocument: { status: "none" },
    ...over,
  };
  n.permissions = permissionsFor(
    { authorUserId: n.author.userId, createdAt: new Date(n.createdAt), voidedAt: n.voided ? new Date(n.voided.at) : null, amendsNoteId: n.amendsNoteId },
    { actorUserId: ctx.actor ?? AUTHOR, isClinicalOwner: ctx.owner ?? false, canWrite: ctx.canWrite ?? true, now: NOW },
  );
  return n;
}

const opts = (o: Partial<FichaMenuOptions> = {}): FichaMenuOptions => ({ now: NOW, isRoot: true, shareAvailable: true, backupStatus: null, ...o });
const ids = (n: ClinicalNoteDTO, o?: Partial<FichaMenuOptions>) => fichaMenuItems(n, opts(o)).map((i) => i.id);

describe("[FC-3e2] chips, autor y diagnósticos", () => {
  it("[FC-3e] chips: Importada + Carga tardía (las dos), Compartida y Compartida · desactualizada; la anulada no dice Compartida", () => {
    const imported = note({
      importSource: { kind: "docx", fileName: "Pérez 2023.docx", importedAt: "2026-10-15T13:00:00.000Z", part: 1, parts: 1 },
      lateEntry: true,
    });
    expect(fichaChips(imported).map((c) => c.label)).toEqual(["Importada", "Carga tardía"]);
    expect(fichaChips(imported)[0].title).toContain("Pérez 2023.docx");
    expect(fichaChips(note({ lateEntry: true })).map((c) => c.label)).toEqual(["Carga tardía"]);
    const live = note({ sharedDocument: { status: "live", documentId: "d1", sharedAt: "2026-10-15T13:10:00.000Z" } });
    expect(fichaChips(live).map((c) => c.label)).toEqual([FICHA_CARD_COPY.shared]);
    // Fecha del title en hora AR (13:10 UTC = 10:10 AR).
    expect(fichaChips(live)[0].title).toContain("15/10/26 10:10");
    const stale = note({ sharedDocument: { status: "stale", documentId: "d1", sharedAt: "2026-10-15T13:10:00.000Z" } });
    expect(fichaChips(stale).map((c) => c.label)).toEqual(["Compartida · desactualizada"]);
    expect(fichaChips({ ...live, voided: { at: NOW.toISOString(), byUserId: AUTHOR, reason: "x" } })).toEqual([]);
    expect(fichaChips(note({ sharedDocument: null }))).toEqual([]);
  });

  it("[FC-3e] autor con matrícula congelada; sin matrícula queda como en EV2; editada al final", () => {
    expect(fichaAuthorLine(note({ authorLicense: "MN 1234" }))).toBe("Lic. Pérez · MN 1234");
    expect(fichaAuthorLine(note())).toBe("Lic. Pérez");
    expect(fichaAuthorLine(note({ authorLicense: "MP 55", revision: 3 }))).toBe("Lic. Pérez · MP 55 · editada");
  });

  it("[FC-3e] diagnósticos: el primero es el principal, título completo y fuente (con atribución OMS en CIE-11)", () => {
    const long = "Trastorno de la articulación de la rodilla, no especificado en otra parte, con limitación funcional";
    const d: DiagnosisSnapshot[] = [
      { v: 1, source: "icd11", refId: "x1", code: "FA01.0", title: long, uri: null, release: "2025-01" },
      { v: 1, source: "text", refId: null, code: null, title: "Dolor lumbar", uri: null, release: null },
    ];
    const chips = diagnosisChips(d);
    expect(chips.map((c) => [c.code, c.title, c.principal])).toEqual([
      ["FA01.0", long, true],
      [null, "Dolor lumbar", false],
    ]);
    expect(chips[0].hint).toContain("CIE-11 © OMS");
    expect(chips[1].hint).toBe("Texto libre");
  });

  it("[FC-3e] plegado: por caracteres o por renglones; lo corto no se pliega", () => {
    expect(isFoldableBody("corta")).toBe(false);
    expect(isFoldableBody("x".repeat(701))).toBe(true);
    expect(isFoldableBody(Array.from({ length: 11 }, (_, i) => `l${i}`).join("\n"))).toBe(true);
    expect(isFoldableBody(Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n"))).toBe(false);
  });
});

describe("[FC-3e2] menú «⋯» por permisos", () => {
  it("[FC-3e] autor dentro de 24 h: PDF · Word · Compartir · Anular (Editar va a la vista, no Enmendar)", () => {
    expect(ids(note())).toEqual(["pdf", "docx", "share", "void"]);
  });

  it("[FC-3e] otro profesional con escritura: PDF · Word · Compartir · Enmendar", () => {
    expect(ids(note({}, { actor: "user-other" }))).toEqual(["pdf", "docx", "share", "amend"]);
  });

  it("[FC-3e] lector sin escritura: solo descargas (y versiones si las hay)", () => {
    expect(ids(note({}, { canWrite: false }))).toEqual(["pdf", "docx"]);
    expect(ids(note({ revision: 2 }, { canWrite: false }))).toEqual(["pdf", "docx", "versions"]);
  });

  it("[FC-3e] compartir: none → Compartir; stale → versión actual + Dejar de compartir; live → Dejar de compartir; sin contexto o sin el dato → nada", () => {
    const other = { actor: "user-other" };
    const stale = note({ sharedDocument: { status: "stale", documentId: "d", sharedAt: NOW.toISOString() } }, other);
    expect(ids(stale)).toEqual(["pdf", "docx", "shareCurrent", "unshare", "amend"]);
    const live = note({ sharedDocument: { status: "live", documentId: "d", sharedAt: NOW.toISOString() } }, other);
    expect(ids(live)).toEqual(["pdf", "docx", "unshare", "amend"]);
    expect(ids(note({}, other), { shareAvailable: false })).toEqual(["pdf", "docx", "amend"]);
    expect(ids(note({ sharedDocument: null }, other))).toEqual(["pdf", "docx", "amend"]);
  });

  it("[FC-3e] etiquetas literales de §24.7 y separadores entre grupos; Anular en rojo", () => {
    const items = fichaMenuItems(note({ revision: 2, sharedDocument: { status: "stale", documentId: "d", sharedAt: NOW.toISOString() } }, { actor: "user-owner", owner: true }), opts({ backupStatus: "ready" }));
    expect(items.map((i) => i.label)).toEqual([
      "PDF", "Word", "Guardar en la carpeta", "Compartir la versión actual", "Dejar de compartir", "Enmendar", "Versiones", "Anular",
    ]);
    expect(items.filter((i) => i.separatorBefore).map((i) => i.id)).toEqual(["shareCurrent", "amend"]);
    expect(items.find((i) => i.id === "void")?.danger).toBe(true);
  });

  it("[FC-3e] carpeta: solo con carpeta elegida (ready / needs-permission); sin soporte o sin elegir, PDF ya descarga", () => {
    for (const s of ["ready", "needs-permission"] as const) expect(ids(note(), { backupStatus: s })).toContain("saveToFolder");
    for (const s of ["checking", "unsupported", "unconfigured", null] as const) expect(ids(note(), { backupStatus: s })).not.toContain("saveToFolder");
  });

  it("[FC-3e] enmienda: solo versiones y anular (la descarga y el compartir son de la raíz); anulada: sin menú", () => {
    const am = note({ id: "am-1", amendsNoteId: "note-1", revision: 2 });
    expect(ids(am, { isRoot: false, backupStatus: "ready" })).toEqual(["versions", "void"]);
    expect(ids(note({ voided: { at: NOW.toISOString(), byUserId: AUTHOR, reason: "x" } }))).toEqual([]);
  });
});

describe("[FC-3e2] descargas", () => {
  it("[FC-3e] por el id de la RAÍZ (la enmienda da 404) y la misma ruta que el respaldo", () => {
    expect(fichaRootId({ id: "am-1", amendsNoteId: "note-1" })).toBe("note-1");
    expect(fichaRootId({ id: "note-1", amendsNoteId: null })).toBe("note-1");
    expect(fichaDownloadUrl("pat-1", "note-1", "docx")).toBe("/api/pacientes/pat-1/fichas/note-1/docx");
    expect(fichaDownloadUrl("pat-1", "note-1", "pdf")).toBe(fichaPdfUrl({ patientId: "pat-1", noteId: "note-1" }));
  });

  it("[FC-3e] status → mensaje: 413/429/500 con el texto del server, 503 vacío, 401, 403, 404", () => {
    expect(downloadErrorMessage(413, HC_EXPORT_COPY.fichaTooLarge)).toBe(HC_EXPORT_COPY.fichaTooLarge);
    expect(downloadErrorMessage(413, "")).toBe(HC_EXPORT_COPY.fichaTooLarge);
    expect(downloadErrorMessage(429, HC_EXPORT_COPY.rateLimited)).toBe(HC_EXPORT_COPY.rateLimited);
    expect(downloadErrorMessage(500, "<html>proxy</html>")).toBe(HC_EXPORT_COPY.renderFailed);
    expect(downloadErrorMessage(503, "")).toMatch(/registrar la descarga/);
    expect(downloadErrorMessage(404, "Not found")).toBe(CLINICAL_NOTE_COPY.notFound);
    expect(downloadErrorMessage(403, "Forbidden")).toBe(CLINICAL_NOTE_COPY.forbidden);
    expect(downloadErrorMessage(401, "Unauthorized")).toMatch(/sesión/);
  });

  it("[FC-3e] nombre: `filename*` UTF-8 primero, ASCII de respaldo, sin separadores de ruta", () => {
    expect(filenameFromDisposition(`attachment; filename="Gomez Juan.pdf"; filename*=UTF-8''G%C3%B3mez%20Juan.pdf`, "x.pdf")).toBe("Gómez Juan.pdf");
    expect(filenameFromDisposition(`attachment; filename="a.docx"`, "x.docx")).toBe("a.docx");
    expect(filenameFromDisposition(`attachment; filename*=UTF-8''..%2F..%2Fetc.pdf`, "x.pdf")).toBe(".._.._etc.pdf");
    expect(filenameFromDisposition(null, "ficha.pdf")).toBe("ficha.pdf");
  });

  function fakeToast() {
    const log: string[] = [];
    return {
      log,
      toast: {
        info: (t: string) => (log.push(`info:${t}`), "id"),
        error: (t: string) => (log.push(`error:${t}`), "id"),
        dismiss: (id: string) => void log.push(`dismiss:${id}`),
      },
    };
  }

  it("[FC-3e] downloadFicha: 413 → toast con el copy del server y no guarda nada", async () => {
    const { log, toast } = fakeToast();
    const saved: string[] = [];
    const urls: string[] = [];
    const r = await downloadFicha({ patientId: "pat-1", rootId: "note-1", format: "pdf" }, toast, {
      fetch: (async (u: string) => (urls.push(u), new Response(HC_EXPORT_COPY.fichaTooLarge, { status: 413 }))) as unknown as typeof fetch,
      save: (_b, f) => void saved.push(f),
    });
    expect(r).toEqual({ ok: false, error: HC_EXPORT_COPY.fichaTooLarge });
    expect(urls).toEqual(["/api/pacientes/pat-1/fichas/note-1/pdf"]);
    expect(saved).toEqual([]);
    expect(log).toEqual(["info:Preparando el archivo…", "dismiss:ficha-dl:note-1:pdf", `error:${HC_EXPORT_COPY.fichaTooLarge}`]);
  });

  it("[FC-3e] downloadFicha: 503 vacío y red caída → su mensaje; 200 → guarda con el nombre del server", async () => {
    const run = async (f: () => Promise<Response>) => {
      const { log, toast } = fakeToast();
      const saved: [number, string][] = [];
      const r = await downloadFicha({ patientId: "p", rootId: "n", format: "docx" }, toast, {
        fetch: f as unknown as typeof fetch,
        save: (b, name) => void saved.push([b.size, name]),
      });
      return { r, log, saved };
    };
    const unavailable = await run(async () => new Response(null, { status: 503 }));
    expect(unavailable.r.ok).toBe(false);
    expect(unavailable.log.at(-1)).toMatch(/^error:No pudimos registrar la descarga/);
    const offline = await run(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(offline.log.at(-1)).toMatch(/Revisá la conexión/);
    const ok = await run(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Disposition": `attachment; filename="a.docx"; filename*=UTF-8''P%C3%A9rez.docx` },
        }),
    );
    expect(ok.r).toEqual({ ok: true, filename: "Pérez.docx" });
    expect(ok.saved).toEqual([[3, "Pérez.docx"]]);
    expect(ok.log.some((l) => l.startsWith("error:"))).toBe(false);
  });

  it("[FC-3e] respaldo: el target es la raíz, con el tipo como título si no tiene", () => {
    const t = fichaBackupTarget(note({ title: null, kind: "FIRST_VISIT" }), { lastName: "Gómez", firstName: "Ana", dni: null });
    expect(t).toEqual({
      patientId: "pat-1",
      noteId: "note-1",
      patient: { lastName: "Gómez", firstName: "Ana", dni: null },
      occurredAt: "2026-10-15T12:30:00.000Z",
      title: "Primera consulta",
    });
  });
});

describe("[FC-3e2] compartir", () => {
  it("[FC-3e] variante: stale → volver a compartir; none/revocada → primera vez", () => {
    expect(shareDialogVariant({ sharedDocument: { status: "stale", documentId: "d", sharedAt: "x" } })).toBe("reshare");
    expect(shareDialogVariant({ sharedDocument: { status: "none" } })).toBe("first");
  });

  it("[FC-3e] resultado: con portal (y mail fallido aparte), sin portal con invitar, sin email sin invitar", () => {
    expect(shareOutcomeView({ patientPortal: "linked", delivery: { channel: "email", status: "sent" } }, "a@b.c")).toEqual({
      kind: "linked",
      message: PATIENT_DOCUMENT_COPY.shared,
      warning: null,
    });
    expect(shareOutcomeView({ patientPortal: "linked", delivery: { channel: "email", status: "failed" } }, null)).toMatchObject({
      warning: PATIENT_DOCUMENT_COPY.emailFailed,
    });
    expect(shareOutcomeView({ patientPortal: "not-linked", delivery: { channel: "email", status: "no-portal-user" } }, "a@b.c")).toEqual({
      kind: "not-linked",
      message: PATIENT_DOCUMENT_COPY.sharedNoPortal,
      canInvite: true,
      noEmail: null,
    });
    expect(shareOutcomeView({ patientPortal: "not-linked", delivery: null }, "  ")).toEqual({
      kind: "not-linked",
      message: PATIENT_DOCUMENT_COPY.sharedNoPortal,
      canInvite: false,
      noEmail: SHARE_FICHA_COPY.noEmail,
    });
  });

  it("[FC-3e] el estado nuevo de la tarjeta sale del documento devuelto", () => {
    expect(sharedDocumentAfterShare({ id: "d9", sharedAt: "2026-10-15T13:00:00.000Z" })).toEqual({
      status: "live",
      documentId: "d9",
      sharedAt: "2026-10-15T13:00:00.000Z",
    });
  });
});

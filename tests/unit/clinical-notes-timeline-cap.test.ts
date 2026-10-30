/**
 * FC-2b · `capTimelinePage` (primera página del inicio de la HC: 10 ítems / 60k caracteres, FC-UI-D10) y
 * `sharedDocumentOf` («none» / «live» / «stale» / null en enmiendas). Puros; viven en el módulo server-only de las
 * lecturas (stub de `server-only` en unit) porque solo los usa el server.
 */
import { describe, it, expect, vi } from "vitest";

// El núcleo de notas arrastra el actor y las capabilities (`lib/authz.ts` → sesión, cookies): no es lo que se prueba
// acá. Se reemplaza solo la proyección de la fila (la usan las lecturas, no estos puros).
vi.mock("@/lib/clinical-notes-internal", () => ({ toClinicalNoteDTO: vi.fn() }));

import {
  CLINICAL_HOME_FIRST_PAGE_ITEMS,
  CLINICAL_HOME_FIRST_PAGE_MAX_CHARS,
  capTimelinePage,
  sharedDocumentOf,
  timelineItemChars,
} from "@/lib/clinical-notes-timeline-internal";
import { decodeTimelineCursor, mergeTimeline } from "@/lib/clinical-notes-logic";
import type { ClinicalNoteDTO, TimelineSessionDTO } from "@/lib/clinical-notes-types";
import { sha256Hex } from "@/lib/hc-print-internal";
import { hcSourceVersion } from "@/lib/hc-print-model";

const BASE = Date.parse("2026-10-01T12:00:00.000Z");
const H = 3_600_000;

function note(i: number, chars: number, over: Partial<ClinicalNoteDTO> = {}): ClinicalNoteDTO {
  const at = new Date(BASE + i * H).toISOString();
  return {
    id: `n${String(i).padStart(3, "0")}`,
    patientId: "p1",
    bookingId: null,
    amendsNoteId: null,
    kind: "EVOLUTION",
    title: null,
    body: "x".repeat(chars),
    occurredAt: at,
    author: { userId: "u1", practitionerId: "pr1", name: "Kine" },
    revision: 1,
    createdAt: at,
    updatedAt: at,
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
}

/** Raíces más nueva primero (como las trae la sentencia 1). */
const roots = (n: number, chars: number) => Array.from({ length: n }, (_, k) => note(n - k, chars));

describe("[FC-2b] capTimelinePage", () => {
  it("sin pasarse del tope de caracteres: igual a `mergeTimeline` con el tope de ítems", () => {
    const rows = { roots: roots(12, 100), amendments: [], sessions: [] };
    const page = capTimelinePage(rows, CLINICAL_HOME_FIRST_PAGE_ITEMS, CLINICAL_HOME_FIRST_PAGE_MAX_CHARS);
    expect(page).toEqual(mergeTimeline(rows.roots, [], [], 10));
    expect(page.items).toHaveLength(10);
  });

  it("corta antes del tope de caracteres y el cursor es el del último ítem que quedó", () => {
    const rows = { roots: roots(11, 9_000), amendments: [], sessions: [] };
    const page = capTimelinePage(rows, 10, 60_000);
    expect(page.items).toHaveLength(6); // 6 × 9.000 = 54k; la 7ª pasaría los 60k
    expect(page).toEqual(mergeTimeline(rows.roots, [], [], 6));
    expect(decodeTimelineCursor(page.nextCursor)?.key).toBe(page.items[5].key);
  });

  it("las enmiendas y el título cuentan para la ficha que las lleva", () => {
    const r = roots(4, 10_000);
    r[0] = { ...r[0], title: "t".repeat(1_000) };
    const am = note(50, 39_000, { id: "am1", amendsNoteId: r[0].id });
    const page = capTimelinePage({ roots: r, amendments: [am], sessions: [] }, 10, 60_000);
    expect(timelineItemChars(page.items[0])).toBe(50_000);
    // 50k + 10k = 60k (entra justo); la tercera pasaría.
    expect(page.items).toHaveLength(2);
  });

  it("una sola ficha enorme sale igual (al menos 1 ítem) y con cursor si hay más", () => {
    const rows = { roots: [note(3, 80_000), note(2, 10), note(1, 10)], amendments: [], sessions: [] };
    const page = capTimelinePage(rows, 10, 60_000);
    expect(page.items.map((i) => i.key)).toEqual(["n:n003"]);
    expect(page.nextCursor).not.toBeNull();
  });

  it("las notas de una sesión suelta cuentan", () => {
    const s: TimelineSessionDTO = {
      id: "s1",
      programId: "pg",
      programTitle: null,
      completedAt: new Date(BASE + 100 * H).toISOString(),
      bookingId: null,
      notes: "y".repeat(59_990),
      rpe: null,
      exercisesDone: 0,
      exercisesTotal: 0,
    };
    const page = capTimelinePage({ roots: roots(2, 100), amendments: [], sessions: [s] }, 10, 60_000);
    expect(page.items.map((i) => i.key)).toEqual(["s:s1"]);
  });
});

describe("[FC-2b] sharedDocumentOf", () => {
  const doc = (digest: string, amends: { id: string; revision: number; voided: boolean }[] = []) => ({
    d_id: "doc1",
    d_sharedAt: new Date(BASE),
    d_sourceDigest: digest,
    d_amends: amends,
  });

  it("enmienda → null; raíz sin documento → none", () => {
    expect(sharedDocumentOf({ amendsNoteId: "r1", revision: 1, ...doc("x") })).toBeNull();
    expect(
      sharedDocumentOf({ amendsNoteId: null, revision: 1, d_id: null, d_sharedAt: null, d_sourceDigest: null, d_amends: null })
    ).toEqual({ status: "none" });
  });

  it("live con la huella actual; stale si cambió la revisión, apareció una enmienda o se anuló una", () => {
    const amends = [{ id: "a1", revision: 1, voided: false }];
    const digest = sha256Hex(hcSourceVersion({ revision: 2 }, amends));
    const live = sharedDocumentOf({ amendsNoteId: null, revision: 2, ...doc(digest, amends) });
    expect(live).toEqual({ status: "live", documentId: "doc1", sharedAt: new Date(BASE).toISOString() });
    expect(sharedDocumentOf({ amendsNoteId: null, revision: 3, ...doc(digest, amends) })?.status).toBe("stale");
    expect(
      sharedDocumentOf({ amendsNoteId: null, revision: 2, ...doc(digest, [...amends, { id: "a2", revision: 1, voided: false }]) })
        ?.status
    ).toBe("stale");
    expect(sharedDocumentOf({ amendsNoteId: null, revision: 2, ...doc(digest, [{ ...amends[0], voided: true }]) })?.status).toBe(
      "stale"
    );
  });
});

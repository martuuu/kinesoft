/**
 * [FC-1b] Contratos de tipos de T4 (brief §24, Anexo B: C-FC2, C-FC4, C-FC6, C-FC10).
 *
 * Los módulos `*-types.ts` son la costura entre las sesiones de T4c/T4d: si un literal de copy o un tope cambia sin
 * querer, la UI y el server dejan de coincidir. Se fijan acá los valores literales del contrato.
 *
 * `lib/hc-print-types.ts` lo importa el portal: el guard del portal es una regex sobre el archivo ENTERO (comentarios
 * incluidos; brief §24.2 hallazgo 2), así que se verifica que el archivo sea neutral y que no nombre los campos que la
 * matriz del portal prohíbe en los payloads.
 *
 * Los imports son dinámicos a propósito: así los `it.fails` del arranque fallaban por el módulo ausente y no tumbaban
 * el archivo entero.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

describe("[FC-1b] tipos de diagnósticos (C-FC2)", () => {
  it("[FC-1b] topes, atribución CIE-11, fuentes y copy literales", async () => {
    const m = await import("@/lib/diagnoses-types");
    expect({
      max: m.DIAGNOSES_MAX,
      textMin: m.DIAGNOSIS_TEXT_MIN,
      textMax: m.DIAGNOSIS_TEXT_MAX,
      search: m.DIAGNOSIS_SEARCH_LIMIT,
      favs: m.DIAGNOSIS_FAVORITES_MAX,
      recents: m.DIAGNOSIS_RECENTS_MAX,
      active: m.ACTIVE_DIAGNOSIS_TITLE_MAX,
    }).toEqual({ max: 5, textMin: 2, textMax: 120, search: 20, favs: 200, recents: 8, active: 80 });
    expect(m.ICD11_ATTRIBUTION).toBe(
      "International Classification of Diseases, Eleventh Revision (ICD-11), World Health Organization (WHO) 2019 https://icd.who.int/browse11. Licensed under CC BY-ND 3.0 IGO"
    );
    expect(m.ICD11_SHORT_ATTRIBUTION).toBe("CIE-11 © OMS · CC BY-ND 3.0 IGO");
    expect(m.DIAGNOSIS_SOURCE_LABEL).toEqual({
      icd11: "CIE-11 (OMS)",
      tenant: "Propios del consultorio",
      kine: "Kinesiología",
      text: "Texto libre",
    });
    expect(m.DIAGNOSIS_COPY.tooMany).toBe("Podés cargar hasta 5 diagnósticos.");
    expect(m.DIAGNOSIS_COPY.favoritesFull).toBe("Llegaste al máximo de 200 favoritos.");
    expect(Object.keys(m.DIAGNOSIS_COPY).sort()).toEqual(
      [
        "notAvailable",
        "retired",
        "tooMany",
        "textLength",
        "duplicateTitle",
        "forbidden",
        "catalogEmpty",
        "activeNeedsPrincipal",
        "favoritesFull",
      ].sort()
    );
  });
});

describe("[FC-1b] tipos de documentos compartidos (C-FC6)", () => {
  it("[FC-1b] PATIENT_DOCUMENT_COPY literal", async () => {
    const m = await import("@/lib/patient-documents-types");
    expect(m.PATIENT_DOCUMENT_COPY).toEqual({
      forbidden: "No tenés acceso para compartir la historia clínica de este paciente.",
      notFound: "No encontramos la ficha.",
      notRoot: "Se comparte la ficha original; las enmiendas van incluidas.",
      voided: "La ficha está anulada: no se puede compartir.",
      changed: "La ficha cambió mientras la compartías. Probá de nuevo.",
      raced: "Alguien compartió esta ficha recién. Recargá para ver el estado.",
      keyReused: "Ese envío ya se usó. Cerrá y volvé a abrir «Compartir con el paciente».",
      pdfFailed: "No pudimos generar el PDF. Probá de nuevo en un rato.",
      storageFailed: "No pudimos guardar el documento. Probá de nuevo.",
      tooLarge: "El documento quedó demasiado pesado para compartirlo. Probá sin logo o sin firma.",
      shared: "Listo: el paciente ya lo ve en su portal.",
      sharedNoPortal: "Listo. El paciente todavía no tiene portal: invitalo para que lo vea.",
      emailFailed: "Se compartió, pero no pudimos mandarle el aviso por mail.",
      revoked: "Dejaste de compartir el documento.",
      docNotFound: "No encontramos el documento.",
      rateLimited: "Compartiste muchas fichas seguidas. Esperá unos minutos y probá de nuevo.",
      patientNotFound: "No encontramos al paciente.",
      notLive: "Ese documento ya no está compartido. Recargá para ver el estado.",
    });
  });
});

describe("[FC-1b] HcPrintable v1 (C-FC4)", () => {
  it("[FC-1b] hc-print-types es neutral: sin la regex del portal ni campos prohibidos, ni en comentarios", async () => {
    await import("@/lib/hc-print-types");
    const src = readFileSync(join(ROOT, "lib", "hc-print-types.ts"), "utf8");
    expect(src).not.toMatch(/clinicalNote|ClinicalNote|clinical-notes/);
    expect(src).not.toMatch(/EVOLUTION|amendsNoteId|voidReason|authorPractitionerId|noteId|StorageKey/);
    // Solo tipos y la versión: nada de runtime que arrastre deps al portal.
    expect(src).not.toMatch(/^import (?!type )/m);
  });
});

describe("[FC-1b] subida firmada de archivos (C-FC10)", () => {
  it("[FC-1b] tope de 25 MB y TTL de 15 min", async () => {
    const m = await import("@/lib/files-types");
    expect(m.PATIENT_FILE_MAX_BYTES).toBe(25 * 1024 * 1024);
    expect(m.PATIENT_FILE_UPLOAD_TTL_S).toBe(900);
  });
});

"use client";

/**
 * [FC-3k] `WordImportDrawer` · stub con la firma congelada (`WordImportDrawerProps`, fichas-ui-types.ts).
 *
 * DIFERIDO siempre (§24.9): el inicio de la HC lo carga por `next/dynamic` al abrir «Importar fichas de Word»; nunca
 * entra al first load de `/pacientes/[id]` (`hc-first-load-guard.test.ts`). FC-3f lo implementa: ≤10 MB, `PK\x03\x04`,
 * ≤50 archivos, `.doc` con aviso; mammoth SOLO por `import()` en `word-reader.ts` → `generateJSON` → `validateHcDoc`;
 * fecha del nombre (5 formatos) o de `lastModified` con la casilla «Revisé las fechas»; una action por archivo con su
 * clave. El .docx nunca viaja al server.
 *
 * Hasta entonces abre, explica y se cierra: el menú puede apuntar acá sin romper nada.
 */
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { WORD_IMPORT_COPY as COPY } from "@/components/fichas/fichas-copy-deferred";
import type { WordImportDrawerProps } from "@/components/fichas/fichas-ui-types";

export function WordImportDrawer({ open, onClose, patientName }: WordImportDrawerProps) {
  return (
    <Drawer open={open} onClose={onClose} title={COPY.title} width={560}>
      <div style={{ display: "grid", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 14, color: "var(--navy-900)" }}>
          <strong>Paciente: {patientName}</strong>
        </p>
        <p style={{ margin: 0, fontSize: 13, color: "var(--navy-700)" }}>{COPY.intro}</p>
        <p role="status" style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>
          {COPY.unavailable}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            {COPY.close}
          </Button>
        </div>
      </div>
    </Drawer>
  );
}

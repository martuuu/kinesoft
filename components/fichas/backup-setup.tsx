"use client";

/**
 * [FC-3k] `BackupSetup` · stub con la firma congelada (`BackupSetupProps`, fichas-ui-types.ts).
 *
 * DIFERIDO (§24.9): lo cargan «Mis fichas» en Configuración y el menú «⋯» de la HC («Carpeta de respaldo») por
 * `next/dynamic`; nunca entra al first load de `/pacientes/[id]`. FC-3g lo implementa: aviso de datos de salud,
 * casilla obligatoria «Esta computadora la uso solo yo», `showDirectoryPicker`, guardar el handle en IndexedDB
 * (`{tenant}:{user}`), cambiar u olvidar la carpeta. En los navegadores sin File System Access dice que el PDF se
 * descarga (que es lo único que hace este stub).
 */
import { Button } from "@/components/ui/button";
import { BACKUP_COPY as COPY } from "@/components/fichas/fichas-copy";
import type { BackupSetupProps } from "@/components/fichas/fichas-ui-types";

export function BackupSetup({ variant, onClose }: BackupSetupProps) {
  return (
    <section aria-label={COPY.title} style={{ display: "grid", gap: 10 }}>
      {variant === "panel" && <h3 style={{ margin: 0, fontSize: 15, color: "var(--navy-900)" }}>{COPY.title}</h3>}
      <p style={{ margin: 0, fontSize: 13, color: "var(--navy-700)" }}>{COPY.intro}</p>
      <p role="status" style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>
        {COPY.unsupported}
      </p>
      {onClose && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      )}
    </section>
  );
}

"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { IconPlus } from "@/components/ui/icons";
import styles from "./patients-directory.module.css";

type InsurerOption = { id: string; name: string };

/**
 * PF1.1 (C-PF2): el drawer de alta (`new-patient-drawer.tsx`) se baja recién al abrirlo, y se precarga en
 * `pointerenter`/`focus` del botón para que el click no espere red. `ssr: false`: solo existe después de un click.
 */
const loadNewPatientDrawer = () => import("@/components/patients/new-patient-drawer");
const NewPatientModal = dynamic(() => loadNewPatientDrawer().then((m) => m.NewPatientModal), {
  ssr: false,
  loading: () => null,
});
function preload() {
  void loadNewPatientDrawer().catch(() => {});
}

/**
 * MB-1d (C-MB3 Pacientes): < 768 la acción es un FAB (`.k-fab`, sobre la barra inferior) y el botón de la cabecera se
 * esconde; en escritorio, al revés. Los dos se pintan en el SSR y los alterna el CSS (`patients-directory.module.css`):
 * el server no conoce el ancho y así no hay salto al hidratar. Abren el mismo drawer.
 */
export function NewPatientButton({ insurers = [] }: { insurers?: InsurerOption[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span className={styles.desktopAction}>
        <Button variant="primary" onClick={() => setOpen(true)} onPointerEnter={preload} onFocus={preload}>
          <IconPlus size={14} /> Nuevo paciente
        </Button>
      </span>
      <span className={styles.fabOnly}>
        <button
          type="button"
          className="k-fab"
          aria-label="Nuevo paciente"
          title="Nuevo paciente"
          onClick={() => setOpen(true)}
          onPointerEnter={preload}
          onFocus={preload}
        >
          <IconPlus size={24} />
        </button>
      </span>
      {open && <NewPatientModal insurers={insurers} onClose={() => setOpen(false)} />}
    </>
  );
}

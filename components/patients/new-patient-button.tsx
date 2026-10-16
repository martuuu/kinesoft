"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { IconPlus } from "@/components/ui/icons";

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

export function NewPatientButton({ insurers = [] }: { insurers?: InsurerOption[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)} onPointerEnter={preload} onFocus={preload}>
        <IconPlus size={14} /> Nuevo paciente
      </Button>
      {open && <NewPatientModal insurers={insurers} onClose={() => setOpen(false)} />}
    </>
  );
}

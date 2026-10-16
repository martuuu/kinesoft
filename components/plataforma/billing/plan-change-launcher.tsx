"use client";

/**
 * [PF1.2-plataforma · C-PF2] Disparador de «Cambiar de plan» en la pestaña Suscripción del detalle de un consultorio.
 * El Drawer (`PlatformPlanChangePanel`, ~390 líneas con el preview, la selección y el catálogo de planes) no está en el
 * primer pintado: se baja con `next/dynamic` recién al primer click, y se precarga en `pointerenter`/`focus` del botón
 * para que el click no espere red. El botón es estático (lo que se ve no depende del chunk). Cada apertura remonta el
 * panel con una `key` nueva: arranca sin plan elegido ni preview, como hacía `openDrawer` cuando todo vivía junto.
 */
import { useState } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import type { PlatformPlanChangeProps } from "@/components/plataforma/billing/plan-change-drawer";

const loadPanel = () => import("@/components/plataforma/billing/plan-change-drawer");

const PlatformPlanChangePanel = dynamic(() => loadPanel().then((m) => m.PlatformPlanChangePanel), {
  ssr: false,
  loading: () => null,
});

const preload = () => {
  void loadPanel();
};

export function PlatformPlanChangeDrawer(props: PlatformPlanChangeProps) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        onPointerEnter={preload}
        onFocus={preload}
        onClick={() => {
          setSession((s) => s + 1);
          setOpen(true);
        }}
      >
        Cambiar de plan
      </Button>
      {session > 0 && (
        <PlatformPlanChangePanel key={session} {...props} open={open} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

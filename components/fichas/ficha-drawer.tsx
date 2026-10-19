"use client";

/**
 * [FC-3c] `FichaDrawer`: el mismo `FichaForm` adentro de un `Drawer` (composer abajo de 640 px, agenda, toast
 * «Atendido», Seguimiento, editar y enmendar). DIFERIDO: quien lo use lo carga por `next/dynamic` (el Drawer y su
 * motion no van en el first load de /pacientes/[id]; lo frena `hc-first-load-guard.test.ts`).
 *
 * - Alto completo: el `Drawer` ya es un panel de arriba abajo; abajo de 640 px `.k-drawer-panel` pasa a `inset: 0`
 *   (pantalla entera, encabezado sticky), que es el «Drawer de alto completo» de FC-UI-D9. No se toca la primitiva.
 * - Dirty-guard: cerrar con cambios pide confirmación, SALVO que haya borrador en memoria (`draftScope` en crear): ahí
 *   cerrar no pierde nada (FC-UI-D2), el borrador queda y el punto de la pestaña lo recuerda.
 * - Pasó la ventana de 24 h mientras editaba: el mismo drawer pasa a enmendar con el texto escrito (EV2-Z M5).
 */
import { useCallback, useState } from "react";
import { Drawer } from "@/components/ui/drawer";
import { FichaForm } from "@/components/fichas/ficha-form";
import { FICHA_FORM_COPY as COPY } from "@/components/fichas/fichas-copy";
import type { FichaDrawerProps, FichaFormMode } from "@/components/fichas/fichas-ui-types";
import type { HcDoc } from "@/lib/hc-doc";

export const FICHA_DRAWER_WIDTH = 560;

export function fichaDrawerTitle(mode: FichaFormMode): string {
  if (mode.type === "edit") return COPY.editTitle;
  if (mode.type === "amend") return COPY.amendTitle;
  return COPY.newTitle;
}

export function FichaDrawer({ open, onClose, mode, onSaved, onDirtyChange, onSwitchToAmend, ...rest }: FichaDrawerProps) {
  const [dirty, setDirty] = useState(false);
  const [override, setOverride] = useState<FichaFormMode | null>(null);
  const [carry, setCarry] = useState<{ doc: HcDoc | null; text: string } | null>(null);
  const active = override ?? mode;
  const keepsDraft = active.type === "create" && Boolean(rest.draftScope);

  // Estable: el form llama `onDirtyChange` en un effect con esta función de dependencia.
  const handleDirty = useCallback(
    (d: boolean) => {
      setDirty(d);
      onDirtyChange?.(d);
    },
    [onDirtyChange]
  );

  const close = (saved = false) => {
    setOverride(null);
    setCarry(null);
    setDirty(false);
    // Con borrador en memoria, cerrar no lo descarta: el «sucio» del caller (punto de la pestaña) sigue en pie.
    // Guardar sí lo limpia (el store ya lo borró).
    if (saved || !keepsDraft) onDirtyChange?.(false);
    onClose();
  };

  return (
    <Drawer
      open={open}
      onClose={() => close()}
      title={fichaDrawerTitle(active)}
      width={FICHA_DRAWER_WIDTH}
      dirty={dirty && !keepsDraft}
      dirtyMessage={COPY.dirtyMessage}
    >
      <FichaForm
        key={active.type}
        {...rest}
        mode={active}
        variant="drawer"
        carry={override ? carry : null}
        onDirtyChange={handleDirty}
        onCancel={() => close()}
        onSaved={(note, info) => {
          onSaved(note, info);
          close(true);
        }}
        onSwitchToAmend={
          // Solo una raíz se enmienda (EV2-D14). Si el caller maneja el pase él mismo, manda el suyo.
          active.type === "edit" && active.note.amendsNoteId == null
            ? (onSwitchToAmend ??
              ((c) => {
                setCarry(c.text.trim() === "" ? null : c);
                setOverride({ type: "amend", note: active.note });
              }))
            : undefined
        }
      />
    </Drawer>
  );
}

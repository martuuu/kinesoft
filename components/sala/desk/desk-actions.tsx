"use client";

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { IconArrow, IconBell, IconCheck } from "@/components/ui/icons";
import { fmtHour, type BookingDTO } from "@/components/agenda/agenda-utils";
import { formatARS } from "@/lib/format";
import { RECEPTION_STATE_LABEL, type ReceptionAction } from "@/lib/reception-state";
import { stateTagText, undoHint } from "@/lib/reception-view-state";
import { deskMenuItems, deskPrimary, type DeskEntry, type DeskViewer } from "@/lib/reception-desk-state";

/**
 * Piezas por fila del escritorio de Recepción (RX-1b, brief RX §1.1): el tag de estado, el botón primario y el menú
 * ⋯. Las usan las dos caras (A «Lista y panel», B «Flujo», RX-2) sin recibir callbacks por props: el shell
 * (`ReceptionDesk`) las conecta con `DeskActionsContext` (acción con toast «Deshacer», abrir el cobro). Así C-RX5
 * (`{ live, query, proFilter, onProFilter }`) no crece con cada acción nueva.
 *
 * Qué botón y qué ítems: la lógica es pura y vive en `lib/reception-desk-state.ts` (`deskPrimary`, `deskMenuItems`:
 * rol, «solo hoy», `canOperate`, Cobrar solo con `billing.manage`). Acá solo se dibuja.
 *
 * PD-13: se lee nombre, hora, estado y copago. Nunca `title`, `notes`, `description` ni `patientCondition` (el
 * render test pasa filas con esos campos llenos y verifica que no aparecen).
 */

export type DeskActionsApi = {
  viewer: DeskViewer;
  /** Día AR del reloj (`live.dayKey`): el link «Ver turno en la agenda» abre ese día. */
  dayKey: string;
  /** Reloj único de la pantalla (`live.clock`). */
  now: Date;
  /** Filas con una acción en vuelo: sus botones van deshabilitados. */
  pendingIds: ReadonlySet<string>;
  /** Nombre del profesional para el encabezado del menú (sin email nunca: sale del catálogo de la page). */
  practitionerName: (id: string) => string;
  /** Acción de Recepción con toast «Deshacer» si se guardó. */
  run: (entry: DeskEntry, action: ReceptionAction) => void;
  /** Abre el modal de cobro (solo llega a llamarse con `viewer.canCollect`). */
  collect: (entry: DeskEntry) => void;
};

/**
 * Lo que no cambia con el reloj: rol, día, nombres y los callbacks estables del shell. `getNow()` lee el reloj
 * VIGENTE (un ref) en el momento en que se lo pide, sin que el tick cambie la identidad del objeto.
 */
export type DeskActionsStable = Pick<DeskActionsApi, "viewer" | "dayKey" | "practitionerName" | "run" | "collect"> & {
  getNow: () => Date;
};
/** Lo que ven las piezas por fila: lo estable más las filas en vuelo. */
export type DeskActions = DeskActionsStable & Pick<DeskActionsApi, "pendingIds">;

/**
 * RX-Z #12: antes el contexto era UN objeto con `now: live.clock` y se rehacía con cada tick (30 s): todas las filas
 * memoizadas de las dos caras se re-renderizaban por el contexto aunque nada suyo cambiara. Ahora hay dos contextos:
 * el estable (esta función conserva la identidad mientras sus campos sean los mismos) y `pendingIds`, que solo cambia
 * cuando sale o vuelve una acción. El `now` deja de viajar por contexto: el menú ⋯ lo pide con `getNow()` al abrirse.
 * Pura para el test: `prev` es el valor del render anterior.
 */
export function stableDeskActions(
  prev: DeskActionsStable | null,
  api: Pick<DeskActionsApi, "viewer" | "dayKey" | "practitionerName" | "run" | "collect">,
  getNow: () => Date
): DeskActionsStable {
  if (
    prev &&
    prev.viewer === api.viewer &&
    prev.dayKey === api.dayKey &&
    prev.practitionerName === api.practitionerName &&
    prev.run === api.run &&
    prev.collect === api.collect &&
    prev.getNow === getNow
  ) {
    return prev;
  }
  return { viewer: api.viewer, dayKey: api.dayKey, practitionerName: api.practitionerName, run: api.run, collect: api.collect, getNow };
}

const DeskStableContext = createContext<DeskActionsStable | null>(null);
const DeskPendingContext = createContext<ReadonlySet<string>>(new Set());

/**
 * Recibe el `DeskActionsApi` plano (el shell y los tests de las caras lo arman igual que antes) y lo reparte en los
 * dos contextos. El tick cambia `now` y, con él, este `value`; ninguno de los dos contextos cambia por eso.
 */
export function DeskActionsProvider({ value, children }: { value: DeskActionsApi; children: ReactNode }) {
  const nowRef = useRef(value.now);
  nowRef.current = value.now;
  const getNow = useCallback(() => nowRef.current, []);
  const stableRef = useRef<DeskActionsStable | null>(null);
  const stable = stableDeskActions(stableRef.current, value, getNow);
  stableRef.current = stable;
  return (
    <DeskStableContext.Provider value={stable}>
      <DeskPendingContext.Provider value={value.pendingIds}>{children}</DeskPendingContext.Provider>
    </DeskStableContext.Provider>
  );
}

export function useDeskActions(): DeskActions {
  const stable = useContext(DeskStableContext);
  const pendingIds = useContext(DeskPendingContext);
  if (!stable) throw new Error("useDeskActions va adentro de <ReceptionDesk> (DeskActionsProvider)");
  return { ...stable, pendingIds };
}

/** «María G., 10:30»: cómo se nombra una fila en los aria-label (mismo formato que las cards del Tablero). */
export function deskRowLabel(row: Pick<BookingDTO, "patientName" | "scheduledFor">): string {
  return `${row.patientName}, ${fmtHour(new Date(row.scheduledFor))}`;
}

/**
 * Texto del toast después de una acción guardada (prototipo `act()`). `name` ya corto (`shortPatientName`). null =
 * sin toast (Deshacer no ofrece deshacer el deshacer).
 */
export function deskActionToast(action: ReceptionAction, name: string, at: Date): string | null {
  switch (action) {
    case "llego":
      return `Llegó ${name} · ${fmtHour(at)}`;
    case "llamar":
      return `Llamaste a ${name}`;
    case "en-atencion":
      return `${name} pasó a atención`;
    case "atendido":
      return `${name} · atendido`;
    case "ausente":
      return `${name} · ausente`;
    case "deshacer":
      return null;
  }
}

// ── Tag de estado ────────────────────────────────────────────────────────────

/**
 * Tag de estado con minutos donde importan («Demorado 12'», «En sala 8'»): el estado va escrito, el color nunca es
 * el único canal. El label largo va en `title`.
 */
export function DeskStateTag({ entry }: { entry: Pick<DeskEntry, "state" | "waitingMinutes" | "lateMinutes" | "calledMinutes"> }) {
  return (
    <span className="desk-tag" data-state={entry.state} title={RECEPTION_STATE_LABEL[entry.state]}>
      {stateTagText(entry)}
    </span>
  );
}

// ── Botón primario ───────────────────────────────────────────────────────────

const KIND: Partial<Record<ReceptionAction, "arrive" | "call" | "attend" | "done">> = {
  llego: "arrive",
  llamar: "call",
  "en-atencion": "attend",
  atendido: "done",
};

function ActionIcon({ kind }: { kind: "arrive" | "call" | "attend" | "done" | "pay" }) {
  const icon =
    kind === "arrive" || kind === "done" ? <IconCheck size={16} /> : kind === "call" ? <IconBell size={16} /> : kind === "attend" ? <IconArrow size={16} /> : null;
  if (!icon) return null;
  return (
    <span className="desk-act-ico" aria-hidden="true">
      {icon}
    </span>
  );
}

/**
 * Botón primario de la fila: Llegó / Llamar / En atención / Atendido, o Cobrar para un atendido que debe (solo a
 * quien cobra). Un atendido ya cobrado muestra «Cobrado» a quien cobra (para la Secretaria no es información). Sin
 * primaria, nada: el menú ⋯ tiene el resto.
 */
export function DeskPrimaryAction({ entry, block = false }: { entry: DeskEntry; block?: boolean }) {
  const api = useDeskActions();
  const p = deskPrimary(entry, api.viewer);
  const b = entry.row;
  const pending = api.pendingIds.has(b.id);
  if (!p) {
    const settled = b.paymentStatus === "PAID" || b.paymentStatus === "AUTHORIZED";
    if (entry.state === "atendido" && api.viewer.canCollect && b.copagoCents > 0 && settled) {
      return (
        <span className="desk-paid">
          <span className="desk-act-ico" aria-hidden="true">
            <IconCheck size={16} />
          </span>
          Cobrado
        </span>
      );
    }
    return null;
  }
  if (p.kind === "collect") {
    return (
      <button
        type="button"
        className="desk-act"
        data-kind="pay"
        data-block={block || undefined}
        aria-label={`Cobrar a ${b.patientName}, ${formatARS(b.copagoCents)}`}
        disabled={pending}
        onClick={() => api.collect(entry)}
      >
        {p.label}
      </button>
    );
  }
  const kind = KIND[p.action] ?? "attend";
  return (
    <button
      type="button"
      className="desk-act"
      data-kind={kind}
      data-primary="true"
      data-block={block || undefined}
      aria-label={`${p.label}: ${deskRowLabel(b)}`}
      disabled={pending}
      onClick={() => api.run(entry, p.action)}
    >
      <ActionIcon kind={kind} />
      {p.label}
    </button>
  );
}

// ── Menú ⋯ ───────────────────────────────────────────────────────────────────

function DotsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

/**
 * Menú ⋯ de la fila (prototipo `openMenu()`): saltear pasos (En atención o Atendido desde la sala), Ausente,
 * Deshacer, «Cobrar ahora» (quien cobra, antes de terminar) y «Ver turno en la agenda».
 *
 * Va en un portal al body: `.desk` es contenedor de container queries, y la contención de layout ancla un `fixed`
 * al contenedor y lo recorta con su overflow. Se posiciona contra el botón (abajo, o arriba si no entra), se cierra
 * con Esc (devuelve el foco al ⋯), con un clic afuera, al elegir, al hacer scroll o al cambiar el tamaño. Flechas
 * arriba/abajo recorren los ítems.
 */
export function DeskMenu({ entry }: { entry: DeskEntry }) {
  const api = useDeskActions();
  const b = entry.row;
  const items = deskMenuItems(entry, api.viewer, api.dayKey);
  const [open, setOpen] = useState(false);
  // El reloj al abrir el menú (para «Deshacer (quedan N')»): el menú vive segundos, no hace falta seguir el tick.
  const [openedAt, setOpenedAt] = useState<Date | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setPos(null);
    if (refocus) btnRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const btn = btnRef.current;
    const menu = menuRef.current;
    if (!btn || !menu) return;
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
    const top = r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6;
    setPos({ left, top });
    menu.querySelector<HTMLElement>(".desk-menu-item")?.focus();

    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (menu.contains(t) || btn.contains(t))) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const list = Array.from(menu.querySelectorAll<HTMLElement>(".desk-menu-item"));
      if (list.length === 0) return;
      e.preventDefault();
      const i = list.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "ArrowDown" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      list[next]?.focus();
    };
    // Scroll de una lista interna o resize: el menú quedaría flotando lejos de su fila.
    const onMove = () => close(false);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, close]);

  const time = fmtHour(new Date(b.scheduledFor));
  const hint = open && openedAt ? undoHint(b, openedAt) : null;
  const actionItems = items.filter((i) => i.kind !== "agenda");

  const menu = (
    <div
      ref={menuRef}
      id={menuId}
      className="desk-menu"
      role="menu"
      aria-label={`Acciones de ${b.patientName}`}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
    >
      <div className="desk-menu-h" aria-hidden="true">
        {b.patientName} · {time} · {api.practitionerName(b.practitionerId)}
      </div>
      {items.map((it, i) => {
        const sep = it.kind === "agenda" && actionItems.length > 0 ? <hr key={`sep-${i}`} className="desk-menu-sep" /> : null;
        if (it.kind === "agenda") {
          return [
            sep,
            <Link key="agenda" href={it.href} role="menuitem" className="desk-menu-item" onClick={() => close(false)}>
              {it.label}
            </Link>,
          ];
        }
        if (it.kind === "collect") {
          return (
            <button
              key="collect"
              type="button"
              role="menuitem"
              className="desk-menu-item"
              onClick={() => {
                close(false);
                api.collect(entry);
              }}
            >
              {it.label}
            </button>
          );
        }
        const label = it.action === "deshacer" && hint ? `${it.label} (${hint})` : it.label;
        return (
          <button
            key={it.action}
            type="button"
            role="menuitem"
            className="desk-menu-item"
            disabled={api.pendingIds.has(b.id)}
            onClick={() => {
              close(true);
              api.run(entry, it.action);
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="desk-act"
        data-kind="more"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Más acciones: ${deskRowLabel(b)}`}
        onClick={() => {
          if (open) {
            close(true);
            return;
          }
          setOpenedAt(api.getNow());
          setOpen(true);
        }}
      >
        <DotsIcon />
      </button>
      {open && typeof document !== "undefined" ? createPortal(menu, document.body) : null}
    </>
  );
}

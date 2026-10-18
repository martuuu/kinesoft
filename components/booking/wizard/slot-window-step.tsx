"use client";

/**
 * Paso «Fecha y hora» del turnero con un profesional elegido (TP-1). Reemplaza a `SlotStep`, que mostraba UN día:
 * el paciente tenía que ir día por día con ‹ › hasta encontrar uno con lugar (y en un día sin atención veía «No hay
 * horarios», sin saber si era el consultorio cerrado o todo ocupado). Ahora se ven 5 días HÁBILES (días en que el
 * profesional atiende) con sus horarios libres; un día sin libres dice «Completo» y, si los 5 lo están, el server
 * avanza solo (`skippedFrom`). Decisión de Martin (§22.5 TP-1).
 *
 * `SlotWindowView` es la vista sin efectos (render test a 390 px); `SlotWindowStep` pide la ventana con
 * `listPublicSlotWindow` (un hit de rate limit para los 5 días) y resuelve «Próximo turno disponible». La navegación
 * es pura (`WindowNav` en `lib/public-wizard-state.ts`) y vive en el wizard, para que el primer turno de «cualquier
 * profesional» y «Ver más horarios de X» la posicionen en su día.
 */
import { useEffect, useId, useRef, useState } from "react";
import { listPublicSlotWindow } from "@/lib/public-booking";
import type { PublicLocation, PublicSlot, PublicSlotWindow, PublicWindowDay } from "@/lib/public-booking-types";
import { toARDateKey } from "@/lib/datetime-ar";
import {
  canGoPrevWindow,
  dayHeading,
  firstAvailable,
  initialWindowNav,
  jumpToDate,
  keepSelectionInWindow,
  laterFrom,
  nextWindow,
  prevWindow,
  slotAccessibleName,
  windowNavAt,
  windowNotice,
  windowRangeLabel,
  type WindowNav,
} from "@/lib/public-wizard-state";
import { Button } from "@/components/ui/button";
import { EmptyBox, StepHeader } from "./shared";
import s from "../public-booking.module.css";

/** A 390 px un día con 20 horarios empujaba los otros 4 fuera de la pantalla: se muestran 8 y «Ver N más». */
const VISIBLE_PER_DAY = 8;

type LoadState = { status: "loading" | "rate" | "ready"; window: PublicSlotWindow | null };

export function SlotWindowStep({
  tenantSlug,
  practitionerId,
  serviceId,
  locations,
  locationId,
  onLocationChange,
  nav,
  setNav,
  slotISO,
  setSlot,
}: {
  tenantSlug: string;
  practitionerId: string;
  serviceId: string;
  /** Sedes donde atiende el profesional (orden del consultorio). */
  locations: PublicLocation[];
  /** Sede elegida (null = todas). */
  locationId: string | null;
  onLocationChange: (id: string | null) => void;
  nav: WindowNav;
  setNav: (nav: WindowNav) => void;
  slotISO: string | null;
  setSlot: (iso: string | null, locationId: string | null) => void;
}) {
  // «Hoy» AR: pasadas las 21:00 AR un `toISOString` ya sería mañana.
  const today = toARDateKey(new Date());
  const [load, setLoad] = useState<LoadState>({ status: "loading", window: null });
  // El último movimiento fue «Ir a una fecha»: solo ahí se avisa que el día pedido no es hábil.
  const [jumped, setJumped] = useState(false);
  const [retry, setRetry] = useState(0);
  // «Próximo turno disponible» con la ventana en otro lado: se elige al llegar la ventana de hoy.
  const autoPick = useRef(false);
  const [focusISO, setFocusISO] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Sede filtrada que el profesional no tiene (filtro viejo): no se manda.
  const effectiveLocationId = locationId && locations.some((l) => l.id === locationId) ? locationId : null;

  const pickFirst = (w: PublicSlotWindow) => {
    const f = firstAvailable(w);
    if (!f) return;
    setSlot(f.slot.iso, f.slot.locationId ?? null);
    setFocusISO(f.slot.iso);
  };

  useEffect(() => {
    let cancelled = false;
    setLoad((l) => ({ status: "loading", window: l.window }));
    listPublicSlotWindow({
      tenantSlug,
      practitionerId,
      serviceId,
      from: nav.from,
      ...(effectiveLocationId ? { locationId: effectiveLocationId } : {}),
    })
      .then((w) => {
        if (cancelled) return;
        setLoad({ status: "ready", window: w });
        if (autoPick.current) {
          autoPick.current = false;
          pickFirst(w);
          return;
        }
        const kept = keepSelectionInWindow(w, slotISO);
        if (kept) setSlot(kept.iso, kept.locationId ?? null);
        else if (slotISO) setSlot(null, null);
      })
      .catch(() => {
        // Rate limit (`RATE_LIMITED`): en prod Next redacta el mensaje de la action, así que todo error es «esperá».
        if (!cancelled) setLoad({ status: "rate", window: null });
      });
    return () => {
      cancelled = true;
    };
    // slotISO/setSlot se leen al llegar la respuesta; no disparan otra búsqueda.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantSlug, practitionerId, serviceId, nav.from, effectiveLocationId, retry]);

  // Foco al horario que eligió «Próximo turno disponible»: el lector anuncia día y hora y Enter/Continuar sigue.
  useEffect(() => {
    if (!focusISO) return;
    const btn = rootRef.current?.querySelector<HTMLButtonElement>(`[data-slot-iso="${CSS.escape(focusISO)}"]`);
    btn?.focus();
    setFocusISO(null);
  }, [focusISO, load]);

  const w = load.window;
  const go = (next: WindowNav, byJump = false) => {
    setJumped(byJump);
    setNav(next);
  };
  const later = w && w.days.length === 0 ? laterFrom(nav, w, today) : null;

  return (
    <div ref={rootRef} className={s.windowStep}>
      <SlotWindowView
        status={load.status}
        window={w}
        notice={w && load.status === "ready" ? windowNotice({ requestedFrom: nav.from, jumped, window: w }) : null}
        canPrev={canGoPrevWindow(nav, today)}
        jumpValue={nav.from}
        today={today}
        slotISO={slotISO}
        locations={locations}
        locationId={effectiveLocationId}
        onLocationChange={onLocationChange}
        onPrev={() => go(prevWindow(nav, today))}
        onNext={() => w && go(nextWindow(nav, w))}
        onJump={(date) => go(jumpToDate(nav, date, today), true)}
        onFirstAvailable={() => {
          if (nav.from === today) {
            // Ya está en la ventana de hoy: si cargó, se elige ya; si está cargando, al llegar.
            if (load.status === "ready" && w) pickFirst(w);
            else {
              autoPick.current = true;
              if (load.status === "rate") setRetry((n) => n + 1);
            }
            setJumped(false);
            return;
          }
          autoPick.current = true;
          go(initialWindowNav(today));
        }}
        onPick={(sl) => setSlot(sl.iso, sl.locationId ?? null)}
        onLater={later ? () => go(windowNavAt(later, today, [...nav.history, nav.from])) : null}
        onRetry={() => setRetry((n) => n + 1)}
      />
    </div>
  );
}

export type SlotWindowViewProps = {
  status: LoadState["status"];
  window: PublicSlotWindow | null;
  notice: string | null;
  canPrev: boolean;
  /** Valor del «Ir a una fecha» (el `from` pedido). */
  jumpValue: string;
  today: string;
  slotISO: string | null;
  locations: PublicLocation[];
  locationId: string | null;
  onLocationChange: (id: string | null) => void;
  onPrev: () => void;
  onNext: () => void;
  onJump: (date: string) => void;
  onFirstAvailable: () => void;
  onPick: (slot: PublicSlot) => void;
  /** «Buscar más adelante» con la ventana vacía; null = no hay más adelante (tope de la búsqueda). */
  onLater: (() => void) | null;
  onRetry: () => void;
};

export function SlotWindowView(p: SlotWindowViewProps) {
  const w = p.window;
  const multiLoc = p.locations.length > 1;
  const locName = (id: string | null | undefined) =>
    multiLoc && !p.locationId ? (p.locations.find((l) => l.id === id)?.name ?? null) : null;
  const dateInputId = useId();
  const range = w ? windowRangeLabel(w.days.map((d) => d.date)) : "";

  return (
    <>
      <StepHeader title="Elegí día y horario" subtitle="Te mostramos los próximos días en que atiende, con sus horarios libres." />
      {multiLoc && (
        <div role="group" aria-label="Sede" className={s.chips}>
          {[{ id: null as string | null, name: "Todas las sedes" }, ...p.locations].map((l) => (
            <button
              key={l.id ?? "all"}
              type="button"
              aria-pressed={p.locationId === l.id}
              onClick={() => p.onLocationChange(l.id)}
              className={`${s.choice} ${s.chip}`}
            >
              {l.name}
            </button>
          ))}
        </div>
      )}

      <div className={s.windowBar}>
        {/* El rango se anuncia al cambiar de ventana (los botones no dicen adónde llevaron). */}
        <p className={`k-display ${s.windowRange}`} aria-live="polite">
          {range}
        </p>
        <div className={s.windowNav}>
          <Button variant="ghost" size="md" onClick={p.onPrev} disabled={!p.canPrev || p.status === "loading"}>
            ‹ Anteriores
          </Button>
          <Button variant="ghost" size="md" onClick={p.onNext} disabled={!w?.nextFrom || p.status === "loading"}>
            Siguientes ›
          </Button>
        </div>
        <div className={s.windowTools}>
          <Button variant="primary" size="md" onClick={p.onFirstAvailable}>
            Próximo turno disponible
          </Button>
          <label htmlFor={dateInputId} className={s.windowJump}>
            <span>Ir a una fecha</span>
            {/* `<input type="date">` va en fecha local por definición (excepción de AGENTS §4); `min` = hoy AR. */}
            <input
              id={dateInputId}
              type="date"
              className={`k-input ${s.dateInput}`}
              value={p.jumpValue}
              min={p.today}
              onChange={(e) => e.target.value && p.onJump(e.target.value)}
            />
          </label>
        </div>
      </div>

      {p.notice && (
        <p className={s.windowNotice} role="status">
          {p.notice}
        </p>
      )}

      {p.status === "loading" ? (
        <div className={s.loading} role="status">
          Buscando horarios…
        </div>
      ) : p.status === "rate" ? (
        <EmptyBox>
          Demasiadas consultas seguidas. Esperá unos segundos y reintentá.
          <div className={s.emptyActions}>
            <Button variant="ghost" onClick={p.onRetry}>
              Reintentar
            </Button>
          </div>
        </EmptyBox>
      ) : !w || w.days.length === 0 ? (
        <EmptyBox>
          {p.locationId ? "No hay turnos libres en esta sede en las próximas 6 semanas." : "No hay turnos libres en las próximas 6 semanas."}
          {p.onLater && (
            <div className={s.emptyActions}>
              <Button variant="ghost" onClick={p.onLater}>
                Buscar más adelante
              </Button>
            </div>
          )}
        </EmptyBox>
      ) : (
        <div className={s.windowDays}>
          {w.days.map((d) => (
            <DayColumn key={d.date} day={d} slotISO={p.slotISO} locName={locName} onPick={p.onPick} />
          ))}
        </div>
      )}
    </>
  );
}

function DayColumn({
  day,
  slotISO,
  locName,
  onPick,
}: {
  day: PublicWindowDay;
  slotISO: string | null;
  locName: (id: string | null | undefined) => string | null;
  onPick: (slot: PublicSlot) => void;
}) {
  const id = useId();
  const free = day.slots.filter((x) => x.available);
  // Si el horario elegido quedó después de los 8 (volvió al paso), el día arranca abierto: no se esconde la selección.
  const selectedIdx = free.findIndex((x) => x.iso === slotISO);
  const [open, setOpen] = useState(selectedIdx >= VISIBLE_PER_DAY);
  const shown = open ? free : free.slice(0, VISIBLE_PER_DAY);
  const hidden = free.length - VISIBLE_PER_DAY;
  const full = day.status === "full" || free.length === 0;
  const headingId = `${id}-h`;
  const listId = `${id}-l`;
  return (
    <section aria-labelledby={headingId} className={`${s.day} ${full ? s.dayFull : ""}`}>
      <h3 id={headingId} className={s.dayTitle}>
        {dayHeading(day)}
      </h3>
      {!full && (
        <>
          <div id={listId} className={s.daySlots}>
            {shown.map((sl) => {
              const where = locName(sl.locationId);
              return (
                <button
                  key={sl.iso}
                  type="button"
                  className={s.slot}
                  aria-label={slotAccessibleName(day.date, sl.time, where)}
                  aria-pressed={sl.iso === slotISO}
                  data-slot-iso={sl.iso}
                  onClick={() => onPick(sl)}
                >
                  {sl.time}
                  {where && (
                    <span className={s.slotWhere} aria-hidden="true">
                      {where}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {hidden > 0 && (
            <button
              type="button"
              className={s.dayMore}
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? "Ver menos" : `Ver ${hidden} más`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

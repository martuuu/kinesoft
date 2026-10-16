"use client";

/**
 * Configuración › Profesionales › Horarios (B3.4 CFG-UI-1, B-pre).
 *
 * Vista de la semana del profesional + editor en Drawer (convención del repo
 * para formularios de carga: Drawer con dirty-guard). El estado y el mapeo de
 * errores son puros en `lib/schedule-editor-state.ts` (testeado).
 *
 * Contrato con `lib/practitioner-schedule.ts`:
 *   • `savePractitionerWeek` REEMPLAZA la semana completa; `version` viaja
 *     como `expectedUpdatedAt` (optimistic lock). Si otra pestaña/persona
 *     guardó en el medio, la action se niega: acá se detecta comparando la
 *     versión (al fallar y al volver el foco a la ventana) y se ofrece
 *     recargar en vez de pisar.
 *   • Errores por fila en `fieldErrors["ranges.<i>"]` (posición en el array
 *     plano): `fieldErrorsToRowErrors` los devuelve a la fila que los causó.
 *   • Semana vacía se rechaza: sin franjas el motor aplica el horario del
 *     consultorio (no "no atiende"). Para no atender un día: Excepciones.
 *   • SR-U2: cada franja lleva sala (`roomId`) y vigencia (`validFrom`/
 *     `validUntil`). Como el guardado REEMPLAZA la semana, el draft las
 *     arrastra siempre (si no, guardar sin tocar borraba la sala). El select
 *     de sala solo aparece si la sede de la fila tiene salas: sin salas
 *     cargadas la pantalla queda igual que antes de SR. El choque de sala con
 *     otros profesionales se marca en la fila antes de ir al server
 *     (`validateDraft` + `roomUsage`); la action lo vuelve a validar bajo lock.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Tag } from "@/components/ui/tag";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import type { LocationRow } from "@/lib/locations-schemas";
import type { PractitionerScheduleView } from "@/lib/practitioner-schedule-schemas";
import { getPractitionerSchedule, savePractitionerWeek } from "@/lib/practitioner-schedule";
import { formatHHMM } from "@/lib/schedule-validate";
import { toARDateKey } from "@/lib/datetime-ar";
import {
  DOW_LONG,
  WEEK_ORDER,
  copyDay,
  draftFromView,
  draftToPayload,
  fieldErrorsToRowErrors,
  rangeDetailLabel,
  roomLabel,
  validateDraft,
  weekSignature,
  type DraftRange,
  type RoomCatalogEntry,
  type WeekDraft,
} from "@/lib/schedule-editor-state";
import { ErrorBox } from "../../controls";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { RangeRowsEditor, infoBox, linkBtn, locationName } from "@/components/schedule/range-rows-editor";

// VX2-e: las filas de franjas (y sus estilos) viven en `components/schedule/range-rows-editor.tsx` para que el alta no
// arrastre este archivo entero. Se re-exportan: exceptions-editor y los render tests las siguen pidiendo de acá.
export {
  RangeRowsEditor,
  SCHEDULE_ROOM_COPY,
  infoBox,
  linkBtn,
  locationName,
  selectStyle,
} from "@/components/schedule/range-rows-editor";

/**
 * PL-2f (C-PL1, PL-D7): sin el módulo `salas` (Individual / Consultorio) no hay selector de sala ni validación de
 * choques en el cliente. La sala que una franja YA tiene (cargada en Clínica) queda en el borrador sin mostrarse y
 * el server la conserva al guardar (`savePractitionerWeek`); cambiar la sede de la franja la suelta (la FK la ata a
 * su sede). Esconder es UX: la barrera es el server (403 a una sala nueva).
 */
const ROOMS_UPSELL = "Las salas vienen con los planes Clínica y Libre. El plan se cambia en Configuración → Plan y uso.";

// ─────────────────────────────────────────────────────────────────────────────
// Sub-tab Horarios
// ─────────────────────────────────────────────────────────────────────────────

export function ScheduleEditor({
  practitionerId,
  practitionerName,
  locations,
  rooms,
}: {
  practitionerId: string;
  practitionerName: string;
  locations: LocationRow[];
  /** SR-U2: catálogo de salas (archivadas incluidas, para rotular). Opcional: sin salas, todo igual que antes. */
  rooms?: ReadonlyArray<RoomCatalogEntry>;
}) {
  // PL-2f: sin el módulo, ni sala en el resumen ni catálogo para el drawer.
  const shownRooms = useTenantModules().has("salas") ? rooms : undefined;
  const [view, setView] = useState<PractitionerScheduleView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const v = await getPractitionerSchedule(practitionerId);
      if (!v) setLoadError("No encontramos a este profesional. Recargá la página.");
      setView(v);
      return v;
    } catch {
      setLoadError("No pudimos cargar el horario. Probá de nuevo.");
      return null;
    }
  }, [practitionerId]);

  useEffect(() => {
    setView(null);
    void load();
  }, [load]);

  const active = locations.filter((l) => l.active);
  const primary = active.find((l) => l.isPrimary) ?? active[0] ?? null;
  const multiLocation = active.length > 1 || (view?.ranges.some((r) => r.locationId !== primary?.id) ?? false);

  if (loadError) {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <ErrorBox>{loadError}</ErrorBox>
        <div>
          <Button variant="ghost" onClick={() => void load()}>
            Reintentar
          </Button>
        </div>
      </div>
    );
  }
  if (!view) {
    return <div style={{ fontSize: 13, color: "var(--navy-300)", padding: "8px 0" }}>Cargando horario…</div>;
  }

  const byDow = WEEK_ORDER.map((dow) => ({
    dow,
    ranges: view.isFallback
      ? dow === 0
        ? []
        : [
            {
              startMin: view.tenantHours.startMin,
              endMin: view.tenantHours.endMin,
              locationId: primary?.id ?? "",
              roomId: null as string | null | undefined,
              validFrom: null as string | null,
              validUntil: null as string | null,
            },
          ]
      : view.ranges
          .filter((r) => r.dow === dow)
          .sort((a, b) => a.startMin - b.startMin || (a.validFrom ?? "").localeCompare(b.validFrom ?? "")),
  }));

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 13, color: "var(--navy-500)", flex: "1 1 240px" }}>
          Días y horarios en que {practitionerName} recibe turnos. Lo usan la agenda y el turnero online.
        </div>
        <Button variant="primary" onClick={() => setEditing(true)} disabled={!primary}>
          {view.isFallback ? "Cargar horario propio" : "Editar horario"}
        </Button>
      </div>

      {!primary && (
        <ErrorBox>No hay sedes activas. Creá una en la pestaña Sedes para poder cargar horarios.</ErrorBox>
      )}

      {view.isFallback && (
        <div style={infoBox}>
          <Tag tone="soft">Igual al horario del consultorio</Tag>
          <div style={{ marginTop: 6 }}>
            Todavía no tiene horario propio: atiende de lunes a sábado de {formatHHMM(view.tenantHours.startMin)} a{" "}
            {formatHHMM(view.tenantHours.endMin)}
            {primary ? ` en ${primary.name}` : ""} (el horario general, de la pestaña General). Cargá uno propio si
            atiende otros días u horarios.
          </div>
        </div>
      )}

      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "grid",
          gap: 0,
          borderRadius: "var(--r-sm)",
          border: "1px solid rgba(15,30,51,0.06)",
          overflow: "hidden",
          opacity: view.isFallback ? 0.75 : 1,
        }}
      >
        {byDow.map(({ dow, ranges }) => (
          <li
            key={dow}
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
              padding: "10px 12px",
              borderBottom: "1px solid rgba(15,30,51,0.04)",
            }}
          >
            <span style={{ width: 88, fontSize: 13, fontWeight: 600, flexShrink: 0 }}>{DOW_LONG[dow]}</span>
            {ranges.length === 0 ? (
              <span style={{ fontSize: 12.5, color: "var(--navy-300)" }}>No atiende</span>
            ) : (
              <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {ranges.map((r, i) => (
                  <span
                    key={i}
                    className="k-mono"
                    style={{
                      fontSize: 12.5,
                      padding: "4px 8px",
                      borderRadius: 8,
                      background: "rgba(15,30,51,0.05)",
                    }}
                  >
                    {formatHHMM(r.startMin)}–{formatHHMM(r.endMin)}
                    {(() => {
                      // SR-U2: "· Centro · Consultorio 2 · hasta el 30/11". Sin sala ni vigencia, igual que antes.
                      const detail = rangeDetailLabel(r, {
                        locationName: multiLocation ? locationName(locations, r.locationId) : null,
                        roomName: r.roomId && shownRooms ? roomLabel(shownRooms, r.roomId) : null,
                      });
                      return detail ? (
                        <span style={{ fontFamily: "inherit", color: "var(--navy-500)" }}> · {detail}</span>
                      ) : null;
                    })()}
                  </span>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>

      {editing && primary && (
        <WeekDrawer
          view={view}
          practitionerId={practitionerId}
          practitionerName={practitionerName}
          locations={locations}
          rooms={shownRooms}
          primaryLocationId={primary.id}
          reload={load}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Drawer de edición de la semana
// ─────────────────────────────────────────────────────────────────────────────

const CONFLICT_CHECK_EVERY_MS = 5_000;

/** Exportado para el test de render (tests/unit/render/schedule-editor-rooms.test.tsx). */
export function WeekDrawer({
  view,
  practitionerId,
  practitionerName,
  locations,
  rooms,
  primaryLocationId,
  reload,
  onClose,
  onSaved,
}: {
  view: PractitionerScheduleView;
  practitionerId: string;
  practitionerName: string;
  locations: LocationRow[];
  rooms?: ReadonlyArray<RoomCatalogEntry>;
  primaryLocationId: string;
  reload: () => Promise<PractitionerScheduleView | null>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<WeekDraft>(() => draftFromView(view, primaryLocationId));
  const [baseline, setBaseline] = useState(() => weekSignature(draft));
  const [version, setVersion] = useState<string | null>(view.version);
  const [tenantHours, setTenantHours] = useState(view.tenantHours);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [copyFrom, setCopyFrom] = useState<number | null>(null);
  const [copyTargets, setCopyTargets] = useState<Set<number>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const [roomUsage, setRoomUsage] = useState(view.roomUsage ?? []);
  const roomsOn = useTenantModules().has("salas");

  const activeSet = useMemo(
    () => new Set(locations.filter((l) => l.active).map((l) => l.id)),
    [locations]
  );
  const showLocation = activeSet.size > 1 || draft.some((d) => d.some((r) => !activeSet.has(r.locationId)));
  // SR-U2: la sala se valida en el cliente con el roomUsage de la última
  // lectura (franjas con sala de los DEMÁS) y "hoy AR"; el server repite todo bajo lock.
  const roomCheck = useMemo(
    () =>
      roomsOn && rooms && rooms.length > 0
        ? { rooms, usage: roomUsage, practitionerId, today: toARDateKey(new Date()) }
        : undefined,
    [roomsOn, rooms, roomUsage, practitionerId]
  );
  const liveErrors = useMemo(() => validateDraft(draft, activeSet, roomCheck), [draft, activeSet, roomCheck]);
  const dirty = weekSignature(draft) !== baseline;
  const defaults = { ...tenantHours, locationId: primaryLocationId };

  // Errores visibles: los del server tienen prioridad (incluyen sede archivada
  // en la base); los locales aparecen apenas hay algo mal en la fila, salvo
  // "elegí la sede" antes del primer intento.
  const rowErrors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(liveErrors)) {
      if (attempted || !/Elegí la sede/.test(v)) out[k] = v;
    }
    return { ...out, ...serverErrors };
  }, [liveErrors, serverErrors, attempted]);

  // ── Conflicto: ¿cambió en otra pestaña? Se mira al volver el foco. ──
  const lastCheck = useRef(0);
  const checkConflict = useCallback(async () => {
    const now = Date.now();
    if (now - lastCheck.current < CONFLICT_CHECK_EVERY_MS) return;
    lastCheck.current = now;
    try {
      const fresh = await getPractitionerSchedule(practitionerId);
      if (fresh && fresh.version !== version) setConflict(true);
    } catch {
      // sin red: el lock del server igual protege al guardar
    }
  }, [practitionerId, version]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") void checkConflict();
    };
    window.addEventListener("focus", onVis);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", onVis);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [checkConflict]);

  // Cerrar la pestaña del navegador con cambios: aviso nativo (el Drawer cubre Esc/fondo/X).
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const setDay = (dow: number, rows: DraftRange[]) => {
    setDraft((w) => w.map((d, i) => (i === dow ? rows : d)));
    // La fila que el usuario tocó ya no tiene el error del server.
    setServerErrors({});
  };

  const reloadFresh = async () => {
    if (dirty) {
      const ok = await confirm({
        title: "¿Recargar el horario?",
        message: "Se descartan los cambios que hiciste acá y se muestra la versión guardada.",
        confirmLabel: "Recargar",
        tone: "danger",
      });
      if (!ok) return;
    }
    const fresh = await reload();
    if (!fresh) return;
    const d = draftFromView(fresh, primaryLocationId);
    setDraft(d);
    setBaseline(weekSignature(d));
    setVersion(fresh.version);
    setTenantHours(fresh.tenantHours);
    setRoomUsage(fresh.roomUsage ?? []);
    setServerErrors({});
    setFormError(null);
    setConflict(false);
    setAttempted(false);
  };

  const save = () => {
    setAttempted(true);
    setFormError(null);
    setServerErrors({});
    const { ranges, keys } = draftToPayload(draft);
    if (ranges.length === 0) {
      setFormError(
        "Cargá al menos una franja. Sin franjas, el profesional hereda el horario del consultorio; para que no atienda un día puntual usá Excepciones."
      );
      return;
    }
    if (Object.keys(liveErrors).length > 0) {
      setFormError("Revisá las franjas marcadas.");
      return;
    }
    start(async () => {
      const r = await savePractitionerWeek(practitionerId, ranges, version);
      if (r.ok) {
        toast.success(`Horario de ${practitionerName} guardado`);
        // SR1c: choques con horarios especiales futuros de otros = aviso, se guarda igual.
        const warnings = r.data?.warnings ?? [];
        if (warnings.length > 0) {
          toast.warning(warnings.length === 1 ? "Revisá un día" : `Revisá ${warnings.length} días`, {
            description: warnings.join(" "),
          });
        }
        onSaved();
        router.refresh();
        return;
      }
      setServerErrors(fieldErrorsToRowErrors(r.fieldErrors, keys));
      setFormError(r.error);
      // ¿Fue el optimistic lock? La action no tipa el motivo: se confirma
      // mirando si la versión guardada cambió.
      if (!r.fieldErrors) {
        try {
          const fresh = await getPractitionerSchedule(practitionerId);
          if (fresh && fresh.version !== version) setConflict(true);
        } catch {
          /* el mensaje del server ya está a la vista */
        }
      }
    });
  };

  const openCopy = (dow: number) => {
    setCopyFrom(copyFrom === dow ? null : dow);
    setCopyTargets(new Set());
  };
  const applyCopy = () => {
    if (copyFrom === null || copyTargets.size === 0) return;
    setDraft((w) => copyDay(w, copyFrom, [...copyTargets]));
    setServerErrors({});
    setCopyFrom(null);
    setCopyTargets(new Set());
  };

  return (
    <Drawer
      open
      onClose={onClose}
      dirty={dirty}
      title={`Horario de ${practitionerName}`}
      width={640}
    >
      <div style={{ display: "grid", gap: 14 }}>
        <div style={{ fontSize: 12.5, color: "var(--navy-500)" }}>
          Cargá una o más franjas por día{showLocation ? ", cada una en su sede" : ""}. Los horarios van de a 5
          minutos. Para cerrar un día puntual (feriado, vacaciones) usá Excepciones, no borres el día acá.
        </div>

        {view.isFallback && version === null && (
          <div style={infoBox}>
            Precargamos el horario del consultorio (lunes a sábado, {formatHHMM(tenantHours.startMin)} a{" "}
            {formatHHMM(tenantHours.endMin)}), que es el que rige hoy. Ajustalo y guardá.
          </div>
        )}

        {conflict && (
          <div
            role="alert"
            style={{
              ...infoBox,
              background: "rgba(245,166,35,0.12)",
              border: "1px solid rgba(245,166,35,0.4)",
              color: "#7A4B00",
            }}
          >
            <div style={{ fontWeight: 700 }}>Este horario cambió en otra pestaña o desde otra computadora.</div>
            <div style={{ marginTop: 2 }}>
              Si guardás ahora no se va a poder. Recargá para ver la versión actual y volvé a aplicar tus cambios.
            </div>
            <button type="button" style={{ ...linkBtn, color: "#7A4B00", paddingLeft: 0 }} onClick={() => void reloadFresh()}>
              Recargar horario
            </button>
          </div>
        )}

        <div style={{ display: "grid", gap: 4 }}>
          {WEEK_ORDER.map((dow) => {
            const rows = draft[dow];
            const label = DOW_LONG[dow];
            return (
              <section
                key={dow}
                aria-label={label}
                style={{
                  padding: "10px 0",
                  borderBottom: "1px solid rgba(15,30,51,0.06)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>
                    {label}
                    {rows.length === 0 && (
                      <span style={{ fontWeight: 500, fontSize: 12.5, color: "var(--navy-300)", marginLeft: 8 }}>
                        No atiende
                      </span>
                    )}
                  </div>
                  {rows.length > 0 && (
                    <button
                      type="button"
                      style={linkBtn}
                      onClick={() => openCopy(dow)}
                      aria-expanded={copyFrom === dow}
                    >
                      Copiar a otros días
                    </button>
                  )}
                </div>

                {copyFrom === dow && (
                  <div
                    style={{
                      margin: "6px 0 8px",
                      padding: 10,
                      borderRadius: 10,
                      background: "rgba(15,30,51,0.04)",
                      display: "grid",
                      gap: 8,
                    }}
                  >
                    <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
                      Copiar las franjas del {label.toLowerCase()} a (reemplaza lo que tengan):
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {WEEK_ORDER.filter((d) => d !== dow).map((d) => {
                        const on = copyTargets.has(d);
                        return (
                          <label
                            key={d}
                            style={{
                              position: "relative",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 6,
                              padding: "6px 10px",
                              minHeight: 34,
                              borderRadius: 999,
                              fontSize: 12.5,
                              cursor: "pointer",
                              background: on ? "var(--navy-900)" : "#fff",
                              color: on ? "#fff" : "var(--navy-700)",
                              border: "1px solid rgba(15,30,51,0.12)",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() =>
                                setCopyTargets((s) => {
                                  const n = new Set(s);
                                  if (n.has(d)) n.delete(d);
                                  else n.add(d);
                                  return n;
                                })
                              }
                              style={{ position: "absolute", opacity: 0, width: 1, height: 1 }}
                            />
                            {DOW_LONG[d].slice(0, 3)}
                          </label>
                        );
                      })}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                      <button
                        type="button"
                        style={linkBtn}
                        onClick={() => setCopyTargets(new Set([1, 2, 3, 4, 5].filter((d) => d !== dow)))}
                      >
                        Lunes a viernes
                      </button>
                      <button
                        type="button"
                        style={linkBtn}
                        onClick={() => setCopyTargets(new Set([0, 1, 2, 3, 4, 5, 6].filter((d) => d !== dow)))}
                      >
                        Todos
                      </button>
                      <span style={{ flex: 1 }} />
                      <Button type="button" variant="ghost" onClick={() => setCopyFrom(null)}>
                        Cancelar
                      </Button>
                      <Button type="button" variant="primary" onClick={applyCopy} disabled={copyTargets.size === 0}>
                        Copiar
                      </Button>
                    </div>
                  </div>
                )}

                <div style={{ marginTop: rows.length ? 6 : 0 }}>
                  <RangeRowsEditor
                    rows={rows}
                    onChange={(next) => setDay(dow, next)}
                    errors={rowErrors}
                    locations={locations}
                    showLocation={showLocation}
                    defaults={defaults}
                    disabled={pending}
                    dayLabel={label}
                    rooms={roomsOn ? rooms : undefined}
                    // SRZ-FX3 (M3): sin salas la línea de vigencia no sale (el
                    // cliente vivo, sin salas, veía ~12 líneas "Siempre · Solo por
                    // un período" de más). Su caso de uso es "cambio de
                    // consultorio": sin salas no hace falta. Una franja con
                    // vigencia ya cargada la muestra igual (ver RangeRowsEditor).
                    showValidity={roomsOn && rooms != null && rooms.length > 0}
                  />
                </div>
              </section>
            );
          })}
        </div>

        {!roomsOn && <div style={{ fontSize: 12, color: "var(--navy-500)" }}>{ROOMS_UPSELL}</div>}

        {formError && <ErrorBox>{formError}</ErrorBox>}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Button
            type="button"
            variant="primary"
            onClick={save}
            disabled={pending || (!dirty && !view.isFallback)}
            style={{ width: "100%", justifyContent: "center" }}
          >
            {pending ? "Guardando…" : view.isFallback && !dirty ? "Guardar como horario propio" : "Guardar horario"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={pending}
            style={{ width: "100%", justifyContent: "center" }}
          >
            Cancelar
          </Button>
        </div>
      </div>
    </Drawer>
  );
}

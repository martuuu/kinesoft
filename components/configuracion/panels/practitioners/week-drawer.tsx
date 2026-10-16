"use client";

/**
 * Configuración › Profesionales › Horarios: el Drawer que edita la semana del profesional (contrato con
 * `lib/practitioner-schedule.ts` en la cabecera de `schedule-editor.tsx`).
 *
 * [PF1.1-config · C-PF2] Vivía dentro de `schedule-editor.tsx`; se separó para bajarlo con `next/dynamic` recién al
 * tocar «Editar horario» (con precarga en hover/foco del botón). Es el formulario más pesado de Configuración y la
 * mayoría de las visitas a Profesionales solo miran la semana.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
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
  validateDraft,
  weekSignature,
  type DraftRange,
  type RoomCatalogEntry,
  type WeekDraft,
} from "@/lib/schedule-editor-state";
import { ErrorBox } from "../../controls";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { RangeRowsEditor, infoBox, linkBtn } from "@/components/schedule/range-rows-editor";

// [PF1.1-config · C-PF4] Sin `router.refresh()` después de las actions de este archivo: todas revalidan `/configuracion`
// y la respuesta de la action ya trae el árbol nuevo (un refresh era un segundo render entero, PF-0d).

/**
 * PL-2f (C-PL1, PL-D7): sin el módulo `salas` (Individual / Consultorio) no hay selector de sala ni validación de
 * choques en el cliente. La sala que una franja YA tiene (cargada en Clínica) queda en el borrador sin mostrarse y
 * el server la conserva al guardar (`savePractitionerWeek`); cambiar la sede de la franja la suelta (la FK la ata a
 * su sede). Esconder es UX: la barrera es el server (403 a una sala nueva).
 */
const ROOMS_UPSELL = "Las salas vienen con los planes Clínica y Libre. El plan se cambia en Configuración → Plan y uso.";

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
              background: "var(--warn-bg)",
              border: "1px solid var(--warn-border)",
              color: "var(--warn-fg)",
            }}
          >
            <div style={{ fontWeight: 700 }}>Este horario cambió en otra pestaña o desde otra computadora.</div>
            <div style={{ marginTop: 2 }}>
              Si guardás ahora no se va a poder. Recargá para ver la versión actual y volvé a aplicar tus cambios.
            </div>
            <button type="button" style={{ ...linkBtn, color: "var(--warn-fg)", paddingLeft: 0 }} onClick={() => void reloadFresh()}>
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
                              background: on ? "var(--navy-900)" : "var(--card-bg)",
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

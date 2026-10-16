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
import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import type { LocationRow } from "@/lib/locations-schemas";
import type { PractitionerScheduleView } from "@/lib/practitioner-schedule-schemas";
import { getPractitionerSchedule } from "@/lib/practitioner-schedule";
import { formatHHMM } from "@/lib/schedule-validate";
import {
  DOW_LONG,
  WEEK_ORDER,
  rangeDetailLabel,
  roomLabel,
  type RoomCatalogEntry,
} from "@/lib/schedule-editor-state";
import { ErrorBox } from "../../controls";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { infoBox, locationName } from "@/components/schedule/range-rows-editor";

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

// [PF1.1-config · C-PF2] El Drawer de la semana se baja recién al abrirlo (precarga en hover/foco de «Editar»). Sin SSR:
// solo existe tras un click, y como capa fija no desplaza nada mientras llega.
const loadWeekDrawer = () => import("./week-drawer");
const WeekDrawer = dynamic(() => loadWeekDrawer().then((m) => m.WeekDrawer), { ssr: false, loading: () => null });
const preloadWeekDrawer = () => void loadWeekDrawer();

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
        <Button variant="primary" onClick={() => setEditing(true)} onPointerEnter={preloadWeekDrawer} onFocus={preloadWeekDrawer} disabled={!primary}>
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

"use client";

/**
 * Configuración › Profesionales (B3.4 CFG-UI-1, B-pre): shell con la lista de
 * profesionales (con su horario resumido, de `getPractitionerScheduleSummary`)
 * y, para el elegido, las sub-pestañas Horarios, Excepciones, Servicios y
 * Coberturas.
 *
 * Servicios y Coberturas son de B3.5 (`ServicesEditor` / `PayersEditor`,
 * contrato `{ practitionerId, practitionerName, onDirtyChange? }`): se editan
 * en línea, así que el shell frena el cambio de profesional / sub-pestaña (y,
 * vía `onDirtyChange`, el de pestaña de Configuración) si quedaron cambios sin
 * guardar. Horarios y Excepciones editan en Drawer, que tiene su propio
 * dirty-guard y tapa la pantalla mientras está abierto.
 *
 * Layout: tarjetas que se acomodan solas (grid auto-fill) arriba y el detalle
 * abajo; en un celular quedan apiladas sin necesitar un breakpoint.
 */
import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { Tag } from "@/components/ui/tag";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { LocationRow } from "@/lib/locations-schemas";
import type { PractitionerScheduleSummaryRow } from "@/lib/practitioner-schedule-schemas";
import type { RoomCatalogEntry } from "@/lib/schedule-editor-state";
import { ScheduleEditor } from "./schedule-editor";
import { ExceptionsEditor } from "./exceptions-editor";
import { ServicesEditor } from "./services-editor";
import { PayersEditor } from "./payers-editor";
import { PublicBookingSwitch } from "./public-booking-switch";
import type { TeamMemberRow } from "@/lib/invitations-types";

type SubTab = "horarios" | "excepciones" | "servicios" | "coberturas";
const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: "horarios", label: "Horarios" },
  { key: "excepciones", label: "Excepciones" },
  { key: "servicios", label: "Servicios" },
  { key: "coberturas", label: "Coberturas" },
];

export function PractitionerPanel({
  summary,
  locations,
  rooms,
  onDirtyChange,
  team,
}: {
  summary: PractitionerScheduleSummaryRow[];
  locations: LocationRow[];
  /**
   * SR-U2: catálogo de salas (`listRooms({ includeArchived: true })`). Las
   * archivadas solo rotulan franjas viejas; el select y las capacidades usan
   * las activas. Sin salas, Horarios y Excepciones se ven igual que antes.
   */
  rooms?: ReadonlyArray<RoomCatalogEntry>;
  /** Hay cambios sin guardar en una sub-pestaña en línea (para frenar el cambio de pestaña de arriba). */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * PL-3b (H-TURN): el equipo (`listTeamMembers`), de donde sale si cada profesional aparece en el turnero online
   * (`TeamMemberRow.practitionerId` / `publicBookingEnabled`). Sin él, la ficha no muestra el switch.
   */
  team?: ReadonlyArray<Pick<TeamMemberRow, "practitionerId" | "publicBookingEnabled">>;
}) {
  const confirm = useConfirm();
  const [selectedId, setSelectedId] = useState<string | null>(summary[0]?.practitionerId ?? null);
  const [sub, setSub] = useState<SubTab>("horarios");
  const [svcDirty, setSvcDirty] = useState(false);
  const [payDirty, setPayDirty] = useState(false);
  const dirty = svcDirty || payDirty;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // Después de un router.refresh el profesional elegido puede no estar más
  // (membresía removida en otra pestaña): caer en el primero.
  useEffect(() => {
    if (!summary.some((s) => s.practitionerId === selectedId)) {
      setSelectedId(summary[0]?.practitionerId ?? null);
    }
  }, [summary, selectedId]);

  const guard = useCallback(
    async (go: () => void) => {
      if (dirty) {
        const ok = await confirm({
          title: "¿Descartar los cambios sin guardar?",
          message: "Tenés cambios sin guardar en esta pestaña. Si seguís, se pierden.",
          tone: "danger",
          confirmLabel: "Descartar",
          cancelLabel: "Seguir editando",
        });
        if (!ok) return;
      }
      setSvcDirty(false);
      setPayDirty(false);
      go();
    },
    [dirty, confirm]
  );

  const activeLocations = locations.filter((l) => l.active);
  const multiLocation = activeLocations.length > 1;
  const selected = summary.find((s) => s.practitionerId === selectedId) ?? null;
  const selectedTeam = selected ? team?.find((m) => m.practitionerId === selected.practitionerId) : undefined;

  if (summary.length === 0) {
    return (
      <Card style={{ padding: 28, textAlign: "center", color: "var(--navy-500)", fontSize: 13 }}>
        Todavía no hay profesionales con la invitación aceptada. Invitalos desde la pestaña Usuarios.
      </Card>
    );
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Card style={{ padding: 16 }}>
        <EyebrowLabel>Profesionales</EyebrowLabel>
        <div style={{ fontSize: 13, color: "var(--navy-500)", margin: "4px 0 12px" }}>
          Elegí un profesional para configurar sus horarios, días especiales, servicios y coberturas.
        </div>
        <ul
          aria-label="Profesionales"
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 240px), 1fr))",
            gap: 8,
          }}
        >
          {summary.map((p) => {
            const on = p.practitionerId === selectedId;
            const locNames = p.locationIds
              .map((id) => locations.find((l) => l.id === id)?.name)
              .filter(Boolean)
              .join(", ");
            return (
              <li key={p.practitionerId}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    if (!on) void guard(() => setSelectedId(p.practitionerId));
                  }}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "12px 14px",
                    borderRadius: "var(--r-sm)",
                    border: on ? "2px solid var(--navy-900)" : "1px solid rgba(15,30,51,0.1)",
                    background: on ? "var(--sky-50)" : "var(--card-bg)",
                    cursor: "pointer",
                    color: "inherit",
                    display: "grid",
                    gap: 4,
                    minHeight: 64,
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.name}
                  </span>
                  <span className="k-mono" style={{ fontSize: 12, color: "var(--navy-500)" }}>
                    {p.summary || "Sin horario"}
                  </span>
                  {(p.isFallback || (multiLocation && locNames)) && (
                    <span style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                      {p.isFallback && <Tag tone="soft">Horario del consultorio</Tag>}
                      {multiLocation && locNames && (
                        <span style={{ fontSize: 11, color: "var(--navy-300)" }}>{locNames}</span>
                      )}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </Card>

      {selected && (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <header style={{ padding: "14px 18px 0", borderBottom: "1px solid rgba(15,30,51,0.06)" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", alignItems: "flex-start", justifyContent: "space-between" }}>
              <div className="k-display" style={{ fontSize: 18, fontWeight: 700, minWidth: 0 }}>
                {selected.name}
              </div>
              {selectedTeam && (
                <div style={{ flex: "1 1 240px", maxWidth: 420 }}>
                  <PublicBookingSwitch
                    key={selected.practitionerId}
                    practitionerId={selected.practitionerId}
                    name={selected.name}
                    enabled={selectedTeam.publicBookingEnabled}
                  />
                </div>
              )}
            </div>
            <div
              role="tablist"
              aria-label={`Configuración de ${selected.name}`}
              className="k-scroll"
              style={{ display: "flex", gap: 4, overflowX: "auto", marginTop: 8 }}
            >
              {SUB_TABS.map((t) => {
                const on = sub === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => {
                      if (!on) void guard(() => setSub(t.key));
                    }}
                    style={{
                      padding: "10px 12px",
                      minHeight: 40,
                      border: "none",
                      borderBottom: on ? "2px solid var(--navy-900)" : "2px solid transparent",
                      background: "transparent",
                      color: on ? "var(--navy-900)" : "var(--navy-500)",
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </header>
          <div role="tabpanel" style={{ padding: 18 }}>
            {/* `key`: al cambiar de profesional cada editor arranca de cero (sin estado del anterior). */}
            {sub === "horarios" && (
              <ScheduleEditor
                key={selected.practitionerId}
                practitionerId={selected.practitionerId}
                practitionerName={selected.name}
                locations={locations}
                rooms={rooms}
              />
            )}
            {sub === "excepciones" && (
              <ExceptionsEditor
                key={selected.practitionerId}
                practitionerId={selected.practitionerId}
                practitionerName={selected.name}
                locations={locations}
                rooms={rooms}
              />
            )}
            {sub === "servicios" && (
              <ServicesEditor
                key={selected.practitionerId}
                practitionerId={selected.practitionerId}
                practitionerName={selected.name}
                onDirtyChange={setSvcDirty}
              />
            )}
            {sub === "coberturas" && (
              <PayersEditor
                key={selected.practitionerId}
                practitionerId={selected.practitionerId}
                practitionerName={selected.name}
                onDirtyChange={setPayDirty}
              />
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

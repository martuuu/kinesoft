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
 * DIR-3c (C-DIR9): sub-pestaña Especialidades (catálogo global, ≤ 5) cuando el directorio está prendido (`directory`
 * llega del loader; con `DIRECTORY_MODE=off` no existe). Se edita en línea, con el mismo dirty-guard.
 *
 * T3e-2c (C-AS3, plan §23.7): arriba de Horarios, el tope de turnos del profesional («Usar el del consultorio / Sin
 * tope / Propio: N cada X min»). Se edita en línea con el mismo dirty-guard. Llega en la fila del resumen
 * (`bookingCap`, loader de Configuración); sin él (otro caller, fixture viejo) no se muestra.
 *
 * CF-U4 (§28, decisiones 1 y 3): debajo del tope, las reglas de agenda (`PractitionerAgendaRulesEditor`:
 * «Atiende servicios distintos a la vez» y los intervalos de la agenda y del turnero). Mismo patrón: en línea, con el
 * dirty-guard del shell, y solo si la fila trae `agendaRules`.
 *
 * Layout: tarjetas que se acomodan solas (grid auto-fill) arriba y el detalle
 * abajo; en un celular quedan apiladas sin necesitar un breakpoint.
 */
import { useCallback, useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { setPractitionerBookingCap } from "@/lib/practitioner-schedule";
import {
  INTERVAL_CAP_COUNT_MAX,
  INTERVAL_CAP_COUNT_MIN,
  INTERVAL_CAP_MINUTES,
  bookingCapLabel,
  parsePractitionerBookingCap,
  type BookingCapMode,
  type PractitionerBookingCapView,
} from "@/lib/booking-cap-config";
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
import { SpecialtiesEditor } from "./specialties-editor";
import { PractitionerAgendaRulesEditor, type PractitionerAgendaRulesView } from "./agenda-rules-editor";
import type { TeamMemberRow } from "@/lib/invitations-types";

type SubTab = "horarios" | "excepciones" | "servicios" | "coberturas" | "especialidades";
const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: "horarios", label: "Horarios" },
  { key: "excepciones", label: "Excepciones" },
  { key: "servicios", label: "Servicios" },
  { key: "coberturas", label: "Coberturas" },
  { key: "especialidades", label: "Especialidades" },
];

/** DIR-3c: lo que necesita el editor de especialidades (del loader de `/configuracion`). */
export type PractitionerSpecialtiesData = {
  catalog: ReadonlyArray<{ id: string; name: string }>;
  byPractitioner: Readonly<Record<string, readonly string[]>>;
};

/**
 * Fila del resumen con el tope (T3e-2c) y las reglas de agenda (CF-U4). Opcionales: el tipo base de
 * `configuracion-client` no los declara (el loader sí los trae, `ConfiguracionScheduleRow`).
 */
export type PractitionerPanelRow = PractitionerScheduleSummaryRow & {
  bookingCap?: PractitionerBookingCapView;
  agendaRules?: PractitionerAgendaRulesView;
};

export function PractitionerPanel({
  summary,
  locations,
  rooms,
  onDirtyChange,
  team,
  specialties,
  support = false,
  sensitive = false,
}: {
  summary: PractitionerPanelRow[];
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
  /** DIR-3c: sin él (directorio en `off`) no hay sub-pestaña Especialidades. */
  specialties?: PractitionerSpecialtiesData | null;
  /** DIR-3c: sesión de soporte → especialidades en solo lectura. */
  support?: boolean;
  /**
   * T3d-1g (C-AS1): `tenant.sensitive`. El turnero de un profesional ajeno es lo delicado: sin él, la ficha no muestra
   * el switch (el propio se prende desde el menú de perfil, que no pasa por acá). Default `false`: deny por default.
   */
  sensitive?: boolean;
}) {
  const confirm = useConfirm();
  const [selectedId, setSelectedId] = useState<string | null>(summary[0]?.practitionerId ?? null);
  const [sub, setSub] = useState<SubTab>("horarios");
  const [svcDirty, setSvcDirty] = useState(false);
  const [payDirty, setPayDirty] = useState(false);
  const [speDirty, setSpeDirty] = useState(false);
  const [capDirty, setCapDirty] = useState(false);
  const [rulesDirty, setRulesDirty] = useState(false);
  const dirty = svcDirty || payDirty || speDirty || capDirty || rulesDirty;
  const subTabs = specialties ? SUB_TABS : SUB_TABS.filter((t) => t.key !== "especialidades");

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
      setSpeDirty(false);
      setCapDirty(false);
      setRulesDirty(false);
      go();
    },
    [dirty, confirm]
  );

  const activeLocations = locations.filter((l) => l.active);
  const multiLocation = activeLocations.length > 1;
  const selected = summary.find((s) => s.practitionerId === selectedId) ?? null;
  const selectedTeam =
    selected && sensitive ? team?.find((m) => m.practitionerId === selected.practitionerId) : undefined;

  if (summary.length === 0) {
    return (
      <Card style={{ padding: 28, textAlign: "center", color: "var(--navy-500)", fontSize: 13 }}>
        {/* T3d-1g: la pestaña Usuarios es `tenant.sensitive`: a quien no la ve no se le dice que invite desde ahí. */}
        {sensitive
          ? "Todavía no hay profesionales con la invitación aceptada. Invitalos desde la pestaña Usuarios."
          : "Todavía no hay profesionales con la invitación aceptada. Los invita el titular o el administrador."}
      </Card>
    );
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Card style={{ padding: 16 }}>
        <EyebrowLabel>Profesionales</EyebrowLabel>
        <div style={{ fontSize: 13, color: "var(--navy-500)", margin: "4px 0 12px" }}>
          {specialties
            ? "Elegí un profesional para configurar sus horarios, días especiales, servicios, coberturas y especialidades."
            : "Elegí un profesional para configurar sus horarios, días especiales, servicios y coberturas."}
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
              {subTabs.map((t) => {
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
            {sub === "horarios" && selected.bookingCap && (
              <BookingCapEditor
                key={`cap-${selected.practitionerId}`}
                practitionerId={selected.practitionerId}
                practitionerName={selected.name}
                cap={selected.bookingCap}
                onDirtyChange={setCapDirty}
              />
            )}
            {/* CF-U4 (decisiones 1 y 3): «Atiende servicios distintos a la vez» y el intervalo propio de horarios. */}
            {sub === "horarios" && selected.agendaRules && (
              <PractitionerAgendaRulesEditor
                key={`rules-${selected.practitionerId}`}
                practitionerId={selected.practitionerId}
                practitionerName={selected.name}
                rules={selected.agendaRules}
                onDirtyChange={setRulesDirty}
              />
            )}
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
            {sub === "especialidades" && specialties && (
              <SpecialtiesEditor
                key={selected.practitionerId}
                practitionerId={selected.practitionerId}
                practitionerName={selected.name}
                catalog={specialties.catalog}
                initial={specialties.byPractitioner[selected.practitionerId] ?? []}
                readOnly={support}
                onDirtyChange={setSpeDirty}
              />
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

const CAP_MODE_LABEL: Record<BookingCapMode, string> = {
  INHERIT: "Usar el del consultorio",
  NONE: "Sin tope",
  CUSTOM: "Propio",
};

/**
 * Tope de turnos del profesional (T3e-2c). Tres opciones en radio (no un select: «Propio» abre dos campos y se tiene
 * que ver qué hay en cada una sin abrir nada). La validación es la del server (`parsePractitionerBookingCap`).
 */
export function BookingCapEditor({
  practitionerId,
  practitionerName,
  cap,
  onDirtyChange,
}: {
  practitionerId: string;
  practitionerName: string;
  cap: PractitionerBookingCapView;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<BookingCapMode>(cap.mode);
  const [count, setCount] = useState(cap.count == null ? "" : String(cap.count));
  const [interval, setIntervalMin] = useState(String(cap.intervalMin ?? cap.tenant?.intervalMin ?? 15));
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  // Lo guardado (se mueve al guardar; la action revalida y el loader trae lo mismo).
  const [saved, setSaved] = useState(cap);

  const dirty =
    mode !== saved.mode ||
    (mode === "CUSTOM" && (count.trim() !== String(saved.count ?? "") || interval !== String(saved.intervalMin ?? "")));
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const inherited = `${CAP_MODE_LABEL.INHERIT} (${cap.tenant ? bookingCapLabel(cap.tenant) : "hoy, sin tope"})`;
  const group = `cap-${practitionerId}`;

  const save = () => {
    setMsg(null);
    const input = { mode, count: count.trim() === "" ? null : Number(count), intervalMin: Number(interval) };
    const parsed = parsePractitionerBookingCap(input);
    if (!parsed.ok) {
      setMsg({ tone: "err", text: parsed.error });
      return;
    }
    start(async () => {
      const r = await setPractitionerBookingCap(practitionerId, input);
      if (!r.ok) {
        setMsg({ tone: "err", text: r.error });
        return;
      }
      setSaved({
        ...saved,
        mode: parsed.data.bookingCapMode,
        count: parsed.data.bookingCapCount,
        intervalMin: parsed.data.bookingCapIntervalMin,
      });
      setMsg({ tone: "ok", text: "Tope guardado." });
    });
  };

  return (
    <fieldset
      data-booking-cap-editor
      style={{
        border: "1px solid rgba(15,30,51,0.08)",
        borderRadius: "var(--r-sm)",
        padding: 14,
        margin: "0 0 16px",
        display: "grid",
        gap: 10,
      }}
    >
      <legend style={{ fontSize: 13, fontWeight: 700, padding: "0 4px" }}>Tope de turnos de {practitionerName}</legend>
      <div style={{ fontSize: 12.5, color: "var(--navy-500)", lineHeight: 1.45 }}>
        Cuántos turnos pueden empezar en el mismo intervalo. Pasado el tope, el turno se carga como sobreturno si lo
        confirmás.
      </div>
      <div role="radiogroup" aria-label={`Tope de turnos de ${practitionerName}`} style={{ display: "grid", gap: 8 }}>
        {/* T3-Z B4: toda la fila (label) es el área táctil del radio: 44 px como el resto de los controles táctiles. */}
        {(["INHERIT", "NONE", "CUSTOM"] as const).map((m) => (
          <label key={m} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 13, minHeight: 44 }}>
            <input
              type="radio"
              name={group}
              value={m}
              checked={mode === m}
              onChange={() => setMode(m)}
              disabled={pending}
            />
            <span>{m === "INHERIT" ? inherited : m === "CUSTOM" ? `${CAP_MODE_LABEL.CUSTOM}:` : CAP_MODE_LABEL[m]}</span>
            {m === "CUSTOM" && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input
                  type="number"
                  inputMode="numeric"
                  min={INTERVAL_CAP_COUNT_MIN}
                  max={INTERVAL_CAP_COUNT_MAX}
                  step={1}
                  value={count}
                  onChange={(e) => {
                    setCount(e.target.value);
                    setMode("CUSTOM");
                  }}
                  disabled={pending}
                  aria-label={`Máximo de turnos de ${practitionerName}`}
                  style={{
                    width: 64,
                    minHeight: 36,
                    padding: "6px 8px",
                    borderRadius: 8,
                    border: "1px solid rgba(15,30,51,0.12)",
                    font: "inherit",
                  }}
                />
                <span>cada</span>
                <select
                  value={interval}
                  onChange={(e) => {
                    setIntervalMin(e.target.value);
                    setMode("CUSTOM");
                  }}
                  disabled={pending}
                  aria-label={`Intervalo del tope de ${practitionerName}`}
                  style={{
                    minHeight: 36,
                    padding: "6px 8px",
                    borderRadius: 8,
                    border: "1px solid rgba(15,30,51,0.12)",
                    font: "inherit",
                    background: "var(--card-bg)",
                  }}
                >
                  {INTERVAL_CAP_MINUTES.map((x) => (
                    <option key={x} value={x}>
                      {x} min
                    </option>
                  ))}
                </select>
              </span>
            )}
          </label>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 12, flexWrap: "wrap" }}>
        {msg && (
          <span
            role={msg.tone === "err" ? "alert" : "status"}
            style={{ fontSize: 12.5, fontWeight: 600, color: msg.tone === "ok" ? "var(--navy-900)" : "var(--danger-fg)" }}
          >
            {msg.text}
          </span>
        )}
        <Button type="button" variant="primary" onClick={save} disabled={pending || !dirty}>
          {pending ? "Guardando…" : "Guardar tope"}
        </Button>
      </div>
    </fieldset>
  );
}

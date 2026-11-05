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
 * CF2 (§29, T.A/T.B; D-CF2-8/9): debajo de las reglas, la anticipación del turnero del profesional
 * (`PractitionerLeadEditor`, solo si la fila trae `publicLead`; mismo dirty-guard) y, para `tenant.sensitive` con el
 * contacto del profesional prendido (`leadContactShown`), el «Ocultar su contacto del turnero».
 *
 * CF2 (§29 P.3, decisión 4 + D-CF2-18): sub-pestaña «Reparto» (`RevenueShareEditor`) SOLO con `tenant.sensitive`: el %
 * que un profesional le destina a otro es plata del equipo (la action exige lo mismo). Carga lazy al montar
 * (`listRevenueShares`), en línea y con el mismo dirty-guard.
 *
 * CF3 (§30, D-CF3-12; PR-U): arriba de las sub-pestañas, el link directo al turnero del profesional
 * (`bookingHref(slug, practitionerId)` con el origin) con «Copiar» y «Compartir por WhatsApp». Estado honesto: con el
 * turnero del consultorio (`turneroPublico`) o el switch del profesional apagados, el link se ve deshabilitado y dice qué
 * falta. Necesita `turnero` (slug + nombre del consultorio, de `props.tenant` en `configuracion-client`); sin él no se
 * muestra. En Coberturas, para `tenant.sensitive`, «Ocultar su WhatsApp para obras sociales»
 * (`hidePractitionerInsuredContact`): el titular solo apaga, prenderlo es del profesional (consentimiento, Mi agenda).
 *
 * Layout: tarjetas que se acomodan solas (grid auto-fill) arriba y el detalle
 * abajo; en un celular quedan apiladas sin necesitar un breakpoint.
 */
import { useCallback, useEffect, useId, useState, useTransition } from "react";
import { Button, buttonClassName } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { bookingHref } from "@/lib/public-booking-links";
import { turneroInviteText, whatsAppShareUrl } from "@/lib/booking-share";
import { hidePractitionerInsuredContact } from "@/lib/practitioner-self-settings";
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
import { PractitionerLeadContactHide, PractitionerLeadEditor, type PractitionerPublicLeadView } from "./lead-editor";
import { RevenueShareEditor } from "./revenue-share-editor";
import type { TeamMemberRow } from "@/lib/invitations-types";

type SubTab = "horarios" | "excepciones" | "servicios" | "coberturas" | "especialidades" | "reparto";
const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: "horarios", label: "Horarios" },
  { key: "excepciones", label: "Excepciones" },
  { key: "servicios", label: "Servicios" },
  { key: "coberturas", label: "Coberturas" },
  { key: "especialidades", label: "Especialidades" },
  { key: "reparto", label: "Reparto" },
];

/** DIR-3c: lo que necesita el editor de especialidades (del loader de `/configuracion`). */
export type PractitionerSpecialtiesData = {
  catalog: ReadonlyArray<{ id: string; name: string }>;
  byPractitioner: Readonly<Record<string, readonly string[]>>;
};

/**
 * Fila del resumen con el tope (T3e-2c), las reglas de agenda (CF-U4) y la anticipación del turnero (CF2). Opcionales:
 * el tipo base de `configuracion-client` no los declara (el loader sí los trae, `ConfiguracionScheduleRow`).
 * `leadContactShown`: el profesional muestra su contacto dentro de la anticipación (`showContactInLeadWindow`).
 */
export type PractitionerPanelRow = PractitionerScheduleSummaryRow & {
  bookingCap?: PractitionerBookingCapView;
  agendaRules?: PractitionerAgendaRulesView;
  publicLead?: PractitionerPublicLeadView;
  leadContactShown?: boolean;
  /**
   * CF3 (D-CF3-12): switch «Aparece en el turnero online» del profesional (`Practitioner.publicBookingEnabled`), para el
   * estado del link. Sin él se usa el de `team` (solo `tenant.sensitive`); sin ninguno el link no afirma nada del switch.
   */
  publicBookingEnabled?: boolean;
  /** CF3 (D-CF3-5): el profesional muestra su WhatsApp a pacientes con OS → el titular ve «Ocultar su WhatsApp…». */
  insuredContactShown?: boolean;
};

/** CF3 (D-CF3-12): lo del consultorio que hace falta para el link del turnero (de `TenantSettings`). */
export type PractitionerTurneroInfo = { slug: string; clinicName: string };

export function PractitionerPanel({
  summary,
  locations,
  rooms,
  onDirtyChange,
  team,
  specialties,
  support = false,
  sensitive = false,
  turnero = null,
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
  /** CF3 (D-CF3-12): slug + nombre del consultorio para el link del turnero de cada profesional. Sin él, no hay link. */
  turnero?: PractitionerTurneroInfo | null;
}) {
  const confirm = useConfirm();
  const tenantTurneroOpen = useTenantModules().has("turneroPublico");
  const [selectedId, setSelectedId] = useState<string | null>(summary[0]?.practitionerId ?? null);
  const [sub, setSub] = useState<SubTab>("horarios");
  const [svcDirty, setSvcDirty] = useState(false);
  const [payDirty, setPayDirty] = useState(false);
  const [speDirty, setSpeDirty] = useState(false);
  const [capDirty, setCapDirty] = useState(false);
  const [rulesDirty, setRulesDirty] = useState(false);
  const [leadDirty, setLeadDirty] = useState(false);
  const [shareDirty, setShareDirty] = useState(false);
  const dirty = svcDirty || payDirty || speDirty || capDirty || rulesDirty || leadDirty || shareDirty;
  const subTabs = SUB_TABS.filter(
    (t) => (t.key !== "especialidades" || !!specialties) && (t.key !== "reparto" || sensitive)
  );

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
      setLeadDirty(false);
      setShareDirty(false);
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
            {turnero && (
              <PractitionerTurneroLink
                key={`link-${selected.practitionerId}`}
                practitionerId={selected.practitionerId}
                practitionerName={selected.name}
                slug={turnero.slug}
                clinicName={turnero.clinicName}
                tenantOpen={tenantTurneroOpen}
                practitionerOn={selected.publicBookingEnabled ?? selectedTeam?.publicBookingEnabled}
              />
            )}
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
            {/* CF2 (D-CF2-8): anticipación propia del turnero («Usar la del consultorio» = NULL). */}
            {sub === "horarios" && selected.publicLead && (
              <PractitionerLeadEditor
                key={`lead-${selected.practitionerId}`}
                practitionerId={selected.practitionerId}
                practitionerName={selected.name}
                own={selected.publicLead.own}
                tenant={selected.publicLead.tenant}
                onDirtyChange={setLeadDirty}
              />
            )}
            {/* CF2 (D-CF2-9): el titular solo apaga el contacto; prenderlo es del profesional (Mi agenda). */}
            {/* CF3 (PR-U, B): soporte no lo ve; la action lo rechazaría. */}
            {sub === "horarios" && sensitive && !support && selected.leadContactShown && (
              <PractitionerLeadContactHide
                key={`lead-contact-${selected.practitionerId}`}
                practitionerId={selected.practitionerId}
                practitionerName={selected.name}
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
            {/* CF3 (D-CF3-5): el titular solo apaga el WhatsApp para OS; prenderlo es del profesional (Mi agenda). */}
            {sub === "coberturas" && sensitive && !support && selected.insuredContactShown && (
              <PractitionerInsuredContactHide
                key={`insured-${selected.practitionerId}`}
                practitionerId={selected.practitionerId}
                practitionerName={selected.name}
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
            {sub === "reparto" && sensitive && (
              <RevenueShareEditor
                key={selected.practitionerId}
                practitionerId={selected.practitionerId}
                practitionerName={selected.name}
                readOnly={support}
                onDirtyChange={setShareDirty}
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

/** CF3 (D-CF3-12): copy del link del turnero en la ficha del profesional. */
export const TURNERO_LINK_COPY = {
  title: "Link directo a su turnero",
  hint: "Quien entra con este link ve solo los turnos de este profesional.",
  tenantOff: "El consultorio tiene los turnos online apagados. Se prenden en Configuración › General.",
  practitionerOff: (name: string) => `Prendé «Aparece en el turnero online» de ${name} para que el link funcione.`,
  copy: "Copiar",
  whatsapp: "Compartir por WhatsApp",
} as const;

export type PractitionerTurneroLinkState = {
  /** Absoluto con `origin`; relativo mientras no se conoce (primer render, server). */
  url: string;
  /** null = se puede usar; si no, el motivo (se muestra y deshabilita Copiar/WhatsApp). */
  disabledReason: string | null;
  /** `wa.me/?text=` sin destinatario (WhatsApp pide elegir el contacto); null si está deshabilitado o sin origin. */
  whatsappHref: string | null;
};

/**
 * CF3 (D-CF3-12): estado del link. Puro (testeado). El consultorio apagado gana sobre el switch del profesional: si el
 * turnero no existe, prender al profesional no alcanza. `practitionerOn` undefined = no se sabe (no se afirma).
 */
export function practitionerTurneroLink(input: {
  origin: string;
  slug: string;
  practitionerId: string;
  practitionerName: string;
  clinicName: string;
  tenantOpen: boolean;
  practitionerOn: boolean | undefined;
}): PractitionerTurneroLinkState {
  const url = `${input.origin}${bookingHref(input.slug, input.practitionerId)}`;
  const disabledReason = !input.tenantOpen
    ? TURNERO_LINK_COPY.tenantOff
    : input.practitionerOn === false
      ? TURNERO_LINK_COPY.practitionerOff(input.practitionerName)
      : null;
  const whatsappHref =
    disabledReason || !input.origin
      ? null
      : whatsAppShareUrl(
          turneroInviteText({ clinicName: input.clinicName, practitionerName: input.practitionerName, url }),
          null
        );
  return { url, disabledReason, whatsappHref };
}

function PractitionerTurneroLink({
  practitionerId,
  practitionerName,
  slug,
  clinicName,
  tenantOpen,
  practitionerOn,
}: {
  practitionerId: string;
  practitionerName: string;
  slug: string;
  clinicName: string;
  tenantOpen: boolean;
  practitionerOn: boolean | undefined;
}) {
  const toast = useToast();
  // El origin solo existe en el cliente: el server (y el primer render) muestran el link relativo, sin acciones.
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const st = practitionerTurneroLink({ origin, slug, practitionerId, practitionerName, clinicName, tenantOpen, practitionerOn });
  const usable = !st.disabledReason && !!origin;
  const reasonId = useId();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(st.url);
      toast.success("Link copiado");
    } catch {
      toast.error("No se pudo copiar", { description: "Seleccioná el link y copialo a mano." });
    }
  };

  return (
    <div data-turnero-link style={{ display: "grid", gap: 6, marginTop: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--navy-700)" }}>{TURNERO_LINK_COPY.title}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <input
          readOnly
          value={st.url}
          aria-label={`${TURNERO_LINK_COPY.title} de ${practitionerName}`}
          aria-disabled={!!st.disabledReason}
          aria-describedby={reasonId}
          onFocus={(e) => e.currentTarget.select()}
          style={{
            flex: "1 1 240px",
            minWidth: 0,
            minHeight: 36,
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid rgba(15,30,51,0.12)",
            background: st.disabledReason ? "rgba(15,30,51,0.04)" : "var(--card-bg)",
            // CF3 ZF3: `--navy-300` sobre el gris no llegaba a AA (≈4:1 a 12 px); `--navy-500` sí.
            color: st.disabledReason ? "var(--navy-500)" : "var(--navy-900)",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
          }}
        />
        <Button type="button" variant="ghost" onClick={() => void copy()} disabled={!usable}>
          {TURNERO_LINK_COPY.copy}
        </Button>
        {usable && st.whatsappHref ? (
          <a className={buttonClassName({ variant: "ghost" })} href={st.whatsappHref} target="_blank" rel="noopener noreferrer">
            {TURNERO_LINK_COPY.whatsapp}
          </a>
        ) : (
          <Button type="button" variant="ghost" disabled>
            {TURNERO_LINK_COPY.whatsapp}
          </Button>
        )}
      </div>
      {/* CF3 ZF3: el motivo (turnero apagado, profesional sin turnos online) no es un error: navy como en «Mi agenda»
          (`mi-agenda-panel.tsx`), no `--danger-fg`. */}
      <div
        id={reasonId}
        role={st.disabledReason ? "note" : undefined}
        data-turnero-link-reason={st.disabledReason ? "" : undefined}
        style={{ fontSize: 12, lineHeight: 1.45, color: st.disabledReason ? "var(--navy-700)" : "var(--navy-500)", fontWeight: st.disabledReason ? 600 : undefined }}
      >
        {st.disabledReason ?? TURNERO_LINK_COPY.hint}
      </div>
    </div>
  );
}

/**
 * CF3 (D-CF3-5): el titular (`tenant.sensitive`) APAGA el WhatsApp para pacientes con obra social de otro profesional.
 * Nunca lo prende: mostrarlo requiere el consentimiento del profesional (Mi agenda). Mismo patrón que
 * `PractitionerLeadContactHide`; la barrera es la action.
 */
export function PractitionerInsuredContactHide({
  practitionerId,
  practitionerName,
}: {
  practitionerId: string;
  practitionerName: string;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

  const hide = async () => {
    const ok = await confirm({
      title: `¿Ocultar el WhatsApp de ${practitionerName} para obras sociales?`,
      message: `Los pacientes con obra social dejan de ver su WhatsApp en el turnero. Volver a mostrarlo lo decide ${practitionerName} desde Configuración › Mi agenda.`,
      tone: "danger",
      confirmLabel: "Ocultar",
      cancelLabel: "Cancelar",
    });
    if (!ok) return;
    start(async () => {
      const r = await hidePractitionerInsuredContact(practitionerId);
      if (!r.ok) {
        toast.error("No pudimos ocultar el WhatsApp", { description: r.error });
        return;
      }
      setHidden(true);
      toast.success(`Ocultaste el WhatsApp de ${practitionerName} para obras sociales`);
    });
  };

  return (
    <div
      data-insured-contact-hide
      style={{
        border: "1px solid rgba(15,30,51,0.08)",
        borderRadius: "var(--r-sm)",
        padding: 14,
        margin: "0 0 16px",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <span style={{ fontSize: 12.5, color: "var(--navy-500)", lineHeight: 1.45, flex: "1 1 240px" }}>
        {practitionerName} muestra su WhatsApp en el turnero a los pacientes con obra social, para que consulten su
        cobertura.
      </span>
      <Button type="button" variant="ghost" onClick={() => void hide()} disabled={pending}>
        {pending ? "Ocultando…" : "Ocultar su WhatsApp para obras sociales"}
      </Button>
    </div>
  );
}

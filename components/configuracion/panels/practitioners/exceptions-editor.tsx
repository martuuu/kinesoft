"use client";

/**
 * Configuración › Profesionales › Excepciones (B3.4 CFG-UI-1, B-pre).
 *
 * Una excepción pisa la plantilla semanal UN día: "Día cerrado" (no atiende)
 * u "Horario especial" (estas franjas en vez de las de siempre). Puede ser del
 * profesional o de todo el consultorio (`practitionerId` null); la lista del
 * mes muestra las dos porque las dos le cambian la agenda a este profesional.
 *
 * Hay a lo sumo una por (profesional | consultorio, día): `upsertException`
 * reemplaza. Por eso al editar no se cambian ni la fecha ni el alcance (sería
 * otra excepción), y al crear se avisa si ya hay una ese día.
 *
 * Fechas: `<input type="date">` da "YYYY-MM-DD" = DayKey AR tal cual (la
 * excepción de TZ permitida por AGENTS.md); "hoy" sale de `toARDateKey`.
 */
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { FormField } from "@/components/ui/form-field";
import { Tag } from "@/components/ui/tag";
import { IconChevL, IconChevR, IconPlus } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import type { LocationRow } from "@/lib/locations-schemas";
import type {
  PractitionerScheduleView,
  ScheduleExceptionRow,
} from "@/lib/practitioner-schedule-schemas";
import {
  deleteException,
  getPractitionerSchedule,
  listExceptions,
  upsertException,
} from "@/lib/practitioner-schedule";
import { toARDateKey } from "@/lib/datetime-ar";
import {
  dayKeyLabel,
  dowOfDayKey,
  exceptionPayloadRanges,
  fieldErrorsToRowErrors,
  monthLabel,
  monthOf,
  monthRange,
  newRangeKey,
  rangesLabel,
  rangesSignature,
  shiftMonth,
  roomLabel,
  validateDayDraft,
  type DraftRange,
  type RoomCatalogEntry,
} from "@/lib/schedule-editor-state";
import { isValidDayKey } from "@/lib/schedule-validate";
import { FALLBACK_TENANT_HOURS } from "@/lib/availability/types";
import { ErrorBox } from "../../controls";
import { RangeRowsEditor, infoBox, linkBtn, locationName } from "./schedule-editor";

type Kind = "CLOSED" | "CUSTOM_HOURS";
type Scope = "practitioner" | "tenant";

const REASON_SUGGESTIONS = ["Feriado", "Vacaciones", "Capacitación", "Licencia"];

export function ExceptionsEditor({
  practitionerId,
  practitionerName,
  locations,
  rooms,
}: {
  practitionerId: string;
  practitionerName: string;
  locations: LocationRow[];
  /** SR-U2: catálogo de salas (archivadas incluidas). Sin salas, todo igual que antes. */
  rooms?: ReadonlyArray<RoomCatalogEntry>;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const today = toARDateKey(new Date());
  const [month, setMonth] = useState(() => monthOf(today));
  const [rows, setRows] = useState<ScheduleExceptionRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [template, setTemplate] = useState<PractitionerScheduleView | null>(null);
  const [drawer, setDrawer] = useState<{ edit?: ScheduleExceptionRow } | null>(null);
  const [pending, start] = useTransition();

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const list = await listExceptions({ ...monthRange(month), practitionerId });
      setRows(list);
    } catch {
      setLoadError("No pudimos cargar las excepciones. Probá de nuevo.");
    }
  }, [month, practitionerId]);

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  // Plantilla semanal: para precargar "Horario especial" con lo de ese día.
  useEffect(() => {
    let alive = true;
    getPractitionerSchedule(practitionerId)
      .then((v) => alive && setTemplate(v))
      .catch(() => alive && setTemplate(null));
    return () => {
      alive = false;
    };
  }, [practitionerId]);

  const onDelete = async (r: ScheduleExceptionRow) => {
    const ok = await confirm({
      title: `¿Borrar la excepción del ${dayKeyLabel(r.date)}?`,
      message:
        r.practitionerId === null
          ? "Es de todo el consultorio: ese día vuelve a regir el horario normal para todos los profesionales."
          : `Ese día vuelve a regir el horario normal de ${practitionerName}.`,
      confirmLabel: "Borrar",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      const res = await deleteException(r.id);
      if (!res.ok) toast.error("No se pudo borrar", { description: res.error });
      else {
        toast.success("Excepción borrada");
        await load();
        router.refresh();
      }
    });
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 13, color: "var(--navy-500)", flex: "1 1 240px" }}>
          Días puntuales en que {practitionerName} no atiende o atiende en otro horario: feriados, vacaciones,
          capacitaciones.
        </div>
        <Button variant="primary" onClick={() => setDrawer({})} disabled={pending}>
          <IconPlus size={14} /> Nueva excepción
        </Button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          aria-label="Mes anterior"
          onClick={() => setMonth((m) => shiftMonth(m, -1))}
          style={{ ...linkBtn, width: 36, height: 36, justifyContent: "center" }}
        >
          <IconChevL size={16} />
        </button>
        <div style={{ fontSize: 14, fontWeight: 700, minWidth: 140, textAlign: "center" }} aria-live="polite">
          {monthLabel(month)}
        </div>
        <button
          type="button"
          aria-label="Mes siguiente"
          onClick={() => setMonth((m) => shiftMonth(m, 1))}
          style={{ ...linkBtn, width: 36, height: 36, justifyContent: "center" }}
        >
          <IconChevR size={16} />
        </button>
        {month !== monthOf(today) && (
          <button type="button" style={linkBtn} onClick={() => setMonth(monthOf(today))}>
            Hoy
          </button>
        )}
      </div>

      {loadError ? (
        <div style={{ display: "grid", gap: 8 }}>
          <ErrorBox>{loadError}</ErrorBox>
          <div>
            <Button variant="ghost" onClick={() => void load()}>
              Reintentar
            </Button>
          </div>
        </div>
      ) : rows === null ? (
        <div style={{ fontSize: 13, color: "var(--navy-300)" }}>Cargando…</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--navy-500)", padding: "12px 0" }}>
          Sin excepciones en {monthLabel(month).toLowerCase()}: rige el horario semanal.
        </div>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            borderRadius: "var(--r-sm)",
            border: "1px solid rgba(15,30,51,0.06)",
            overflow: "hidden",
          }}
        >
          {rows.map((r) => {
            const past = r.date < today;
            return (
              <li
                key={r.id}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 10,
                  alignItems: "center",
                  padding: "10px 12px",
                  borderBottom: "1px solid rgba(15,30,51,0.04)",
                  opacity: past ? 0.6 : 1,
                }}
              >
                <div style={{ width: 92, flexShrink: 0, fontSize: 13, fontWeight: 700 }}>{dayKeyLabel(r.date)}</div>
                <div style={{ flex: "1 1 200px", minWidth: 0, display: "grid", gap: 3 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                    {r.kind === "CLOSED" ? (
                      <Tag tone="soft">Día cerrado</Tag>
                    ) : (
                      <Tag tone="sky">Horario especial</Tag>
                    )}
                    {r.practitionerId === null && <Tag tone="lime">Todo el consultorio</Tag>}
                  </div>
                  {r.kind === "CUSTOM_HOURS" && r.ranges && (
                    <div className="k-mono" style={{ fontSize: 12.5, color: "var(--navy-700)" }}>
                      {rangesLabel(r.ranges)}
                      {locations.filter((l) => l.active).length > 1 && (
                        <span style={{ fontFamily: "inherit", color: "var(--navy-500)" }}>
                          {" "}
                          · {[...new Set(r.ranges.map((x) => locationName(locations, x.locationId)))].join(", ")}
                        </span>
                      )}
                      {r.ranges.some((x) => x.roomId) && (
                        <span style={{ fontFamily: "inherit", color: "var(--navy-500)" }}>
                          {" "}
                          ·{" "}
                          {[...new Set(r.ranges.filter((x) => x.roomId).map((x) => roomLabel(rooms, x.roomId!)))].join(
                            ", "
                          )}
                        </span>
                      )}
                    </div>
                  )}
                  {r.reason && <div style={{ fontSize: 12, color: "var(--navy-500)" }}>{r.reason}</div>}
                </div>
                <div style={{ display: "flex", gap: 2 }}>
                  <button type="button" style={linkBtn} onClick={() => setDrawer({ edit: r })} disabled={pending}>
                    Editar
                  </button>
                  <button
                    type="button"
                    style={{ ...linkBtn, color: "var(--danger-fg)" }}
                    onClick={() => onDelete(r)}
                    disabled={pending}
                  >
                    Borrar
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {drawer && (
        <ExceptionDrawer
          edit={drawer.edit}
          practitionerId={practitionerId}
          practitionerName={practitionerName}
          locations={locations}
          rooms={rooms}
          template={template}
          known={rows ?? []}
          defaultDate={month === monthOf(today) ? today : `${month}-01`}
          onClose={() => setDrawer(null)}
          onSaved={(date) => {
            setDrawer(null);
            if (monthOf(date) !== month) setMonth(monthOf(date));
            else void load();
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function ExceptionDrawer({
  edit,
  practitionerId,
  practitionerName,
  locations,
  rooms,
  template,
  known,
  defaultDate,
  onClose,
  onSaved,
}: {
  edit?: ScheduleExceptionRow;
  practitionerId: string;
  practitionerName: string;
  locations: LocationRow[];
  rooms?: ReadonlyArray<RoomCatalogEntry>;
  template: PractitionerScheduleView | null;
  /** Excepciones ya cargadas (mes visible): para avisar que se va a reemplazar. */
  known: ScheduleExceptionRow[];
  defaultDate: string;
  onClose: () => void;
  onSaved: (date: string) => void;
}) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const active = locations.filter((l) => l.active);
  const primary = active.find((l) => l.isPrimary) ?? active[0] ?? null;
  // Sin plantilla cargada (falló o todavía no llegó): el default de
  // Tenant.businessHours (8-19), el mismo que usan el loader y la agenda.
  // Antes decía 8-20 a mano y precargaba una hora de más.
  const tenantHours = useMemo(
    () => template?.tenantHours ?? { startMin: FALLBACK_TENANT_HOURS.startMin, endMin: FALLBACK_TENANT_HOURS.endMin },
    [template]
  );

  /** Franjas que rigen ese día según la plantilla (o el horario del consultorio). */
  const templateRangesFor = useCallback(
    (dayKey: string): DraftRange[] => {
      if (!isValidDayKey(dayKey)) return [];
      const dow = dowOfDayKey(dayKey);
      const src: ReadonlyArray<{
        startMin: number;
        endMin: number;
        locationId: string;
        roomId?: string | null;
        validFrom?: string | null;
        validUntil?: string | null;
      }> =
        template && !template.isFallback
          ? template.ranges.filter((r) => r.dow === dow)
          : dow === 0
            ? []
            : [{ ...tenantHours, locationId: primary?.id ?? "" }];
      // SR-U2: precarga la sala de la plantilla de ese día (solo franjas vigentes ese día).
      const out: DraftRange[] = src
        .filter((r) => (!r.validFrom || r.validFrom <= dayKey) && (!r.validUntil || r.validUntil >= dayKey))
        .map((r) => ({
          key: newRangeKey(),
          startMin: r.startMin,
          endMin: r.endMin,
          locationId: r.locationId,
          roomId: r.roomId ?? null,
          validFrom: null,
          validUntil: null,
        }));
      return out.length
        ? out
        : [
            {
              key: newRangeKey(),
              ...tenantHours,
              locationId: primary?.id ?? "",
              roomId: null,
              validFrom: null,
              validUntil: null,
            },
          ];
    },
    [template, tenantHours, primary?.id]
  );

  const initial = useMemo(
    () => ({
      date: edit?.date ?? defaultDate,
      scope: (edit && edit.practitionerId === null ? "tenant" : "practitioner") as Scope,
      kind: (edit?.kind ?? "CLOSED") as Kind,
      rows: (edit?.ranges ?? []).map(
        (r): DraftRange => ({ key: newRangeKey(), ...r, roomId: r.roomId ?? null, validFrom: null, validUntil: null })
      ),
      reason: edit?.reason ?? "",
    }),
    // foto al abrir
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const [date, setDate] = useState(initial.date);
  const [scope, setScope] = useState<Scope>(initial.scope);
  const [kind, setKind] = useState<Kind>(initial.kind);
  const [rows, setRows] = useState<DraftRange[]>(initial.rows);
  const [rowsTouched, setRowsTouched] = useState(!!edit);
  const [reason, setReason] = useState(initial.reason);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[] | undefined>>({});
  const [serverRowErrors, setServerRowErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);

  const sig = (s: { date: string; scope: Scope; kind: Kind; rows: DraftRange[]; reason: string }) =>
    [s.date, s.scope, s.kind, s.kind === "CUSTOM_HOURS" ? rangesSignature(s.rows) : "", s.reason.trim()].join("|");
  const dirty = sig({ date, scope, kind, rows, reason }) !== sig(initial);

  const activeSet = useMemo(() => new Set(active.map((l) => l.id)), [active]);
  const liveRowErrors = useMemo(
    () => (kind === "CUSTOM_HOURS" ? validateDayDraft(rows, activeSet) : {}),
    [kind, rows, activeSet]
  );
  const rowErrors = { ...(attempted ? liveRowErrors : filterSoft(liveRowErrors)), ...serverRowErrors };
  const showLocation = active.length > 1 || rows.some((r) => !activeSet.has(r.locationId));

  // "Horario especial" sin franjas tocadas: se precarga lo que rige ese día.
  const pickKind = (k: Kind) => {
    setKind(k);
    if (k === "CUSTOM_HOURS" && !rowsTouched) setRows(templateRangesFor(date));
  };
  const pickDate = (d: string) => {
    setDate(d);
    if (kind === "CUSTOM_HOURS" && !rowsTouched) setRows(templateRangesFor(d));
  };

  const existing = !edit
    ? known.find(
        (k) => k.date === date && (scope === "tenant" ? k.practitionerId === null : k.practitionerId === practitionerId)
      )
    : undefined;

  const save = () => {
    setAttempted(true);
    setError(null);
    setFieldErrors({});
    setServerRowErrors({});
    if (!isValidDayKey(date)) {
      setFieldErrors({ date: ["Elegí una fecha."] });
      return;
    }
    if (kind === "CUSTOM_HOURS") {
      if (rows.length === 0) {
        setError("Cargá al menos una franja (o marcá el día como cerrado).");
        return;
      }
      if (Object.keys(liveRowErrors).length) {
        setError("Revisá las franjas marcadas.");
        return;
      }
    }
    start(async () => {
      const r = await upsertException({
        practitionerId: scope === "tenant" ? null : practitionerId,
        date,
        kind,
        // SR-U2: la sala viaja por franja; la de todo el consultorio va sin sala.
        ranges: kind === "CUSTOM_HOURS" ? exceptionPayloadRanges(rows, scope) : null,
        reason,
      });
      if (!r.ok) {
        setError(r.error);
        setFieldErrors(r.fieldErrors ?? {});
        setServerRowErrors(fieldErrorsToRowErrors(r.fieldErrors, rows.map((x) => x.key)));
        return;
      }
      toast.success(edit ? "Excepción guardada" : "Excepción creada");
      onSaved(date);
    });
  };

  const segBtn = (on: boolean): React.CSSProperties => ({
    flex: "1 1 0",
    padding: "9px 12px",
    minHeight: 40,
    borderRadius: 10,
    border: on ? "1px solid var(--navy-900)" : "1px solid rgba(15,30,51,0.12)",
    background: on ? "var(--navy-900)" : "#fff",
    color: on ? "#fff" : "var(--navy-700)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  });

  return (
    <Drawer
      open
      onClose={onClose}
      dirty={dirty}
      title={edit ? `Excepción del ${dayKeyLabel(edit.date)}` : "Nueva excepción"}
      width={560}
    >
      <div style={{ display: "grid", gap: 14 }}>
        <FormField
          label="Fecha"
          type="date"
          required
          value={date}
          onChange={pickDate}
          disabled={!!edit}
          error={fieldErrors.date?.[0]}
        />

        <fieldset style={{ border: "none", margin: 0, padding: 0, display: "grid", gap: 6 }} disabled={!!edit}>
          <legend style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)", marginBottom: 6 }}>
            ¿A quién aplica?
          </legend>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <button
              type="button"
              aria-pressed={scope === "practitioner"}
              style={{ ...segBtn(scope === "practitioner"), opacity: edit ? 0.6 : 1 }}
              onClick={() => setScope("practitioner")}
            >
              Solo {practitionerName}
            </button>
            <button
              type="button"
              aria-pressed={scope === "tenant"}
              style={{ ...segBtn(scope === "tenant"), opacity: edit ? 0.6 : 1 }}
              onClick={() => setScope("tenant")}
            >
              Todo el consultorio
            </button>
          </div>
          {scope === "tenant" && (
            <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
              Aplica a todos los profesionales, también a los que se sumen después.
            </div>
          )}
        </fieldset>

        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>Ese día</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <button type="button" aria-pressed={kind === "CLOSED"} style={segBtn(kind === "CLOSED")} onClick={() => pickKind("CLOSED")}>
              Día cerrado
            </button>
            <button
              type="button"
              aria-pressed={kind === "CUSTOM_HOURS"}
              style={segBtn(kind === "CUSTOM_HOURS")}
              onClick={() => pickKind("CUSTOM_HOURS")}
            >
              Horario especial
            </button>
          </div>
          <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
            {kind === "CLOSED"
              ? "No se dan turnos ese día (ni en la agenda ni en el turnero)."
              : "Ese día se atiende solo en estas franjas, en vez del horario semanal."}
          </div>
        </div>

        {kind === "CUSTOM_HOURS" && (
          <RangeRowsEditor
            rows={rows}
            onChange={(next) => {
              setRows(next);
              setRowsTouched(true);
              setServerRowErrors({});
            }}
            errors={rowErrors}
            locations={locations}
            showLocation={showLocation}
            defaults={{ ...tenantHours, locationId: primary?.id ?? "" }}
            disabled={pending}
            dayLabel={isValidDayKey(date) ? dayKeyLabel(date) : "Ese día"}
            // SR1c: un horario especial de todo el consultorio no lleva sala (el server lo rechaza).
            rooms={scope === "tenant" ? undefined : rooms}
          />
        )}

        <div style={{ display: "grid", gap: 6 }}>
          <FormField
            label="Motivo"
            value={reason}
            onChange={setReason}
            placeholder="Opcional. Ej.: Feriado"
            error={fieldErrors.reason?.[0]}
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {REASON_SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setReason(s)}
                style={{
                  padding: "4px 10px",
                  minHeight: 30,
                  borderRadius: 999,
                  border: "1px solid rgba(15,30,51,0.12)",
                  background: reason === s ? "var(--sky-100)" : "#fff",
                  color: "var(--navy-700)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {existing && (
          <div style={infoBox}>
            Ya hay una excepción ese día
            {existing.practitionerId === null ? " para todo el consultorio" : ` para ${practitionerName}`} (
            {existing.kind === "CLOSED" ? "día cerrado" : "horario especial"}). Si guardás, se reemplaza.
          </div>
        )}

        {error && <ErrorBox>{error}</ErrorBox>}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Button
            type="button"
            variant="primary"
            onClick={save}
            disabled={pending || (!!edit && !dirty)}
            style={{ width: "100%", justifyContent: "center" }}
          >
            {pending ? "Guardando…" : "Guardar"}
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

/** Antes del primer intento no se grita "Elegí la sede" (la fila recién nace). */
function filterSoft(errs: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(errs).filter(([, v]) => !/Elegí la sede/.test(v)));
}

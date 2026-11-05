"use client";

/**
 * Configuración → Profesionales → Servicios (B3.5 CFG-UI-2, B-pre).
 *
 * Qué servicios del consultorio atiende el profesional y con qué reglas:
 * duración propia, visibilidad en el turnero online, anticipación mínima y
 * máxima y cupo propio. Lo lee el motor de disponibilidad
 * (`lib/availability/*` vía el loader); los campos vacíos HEREDAN (del
 * servicio o del canal), por eso el placeholder muestra lo heredado.
 *
 * Guardado POR FILA (upsert): cada servicio es independiente en el server
 * (`upsertPractitionerService`) y un "Guardar todo" con un error a mitad de
 * camino dejaría filas guardadas y otras no sin que se vea cuál. La fila
 * muestra su propio estado (sin guardar / guardando / guardado / error).
 *
 * Contrato con B3.4 (`practitioner-panel.tsx` lo monta): props
 * `{ practitionerId, practitionerName }`; el editor carga sus datos solo.
 * `onDirtyChange` es opcional, para que el shell pueda frenar el cambio de
 * profesional/pestaña con filas sin guardar.
 *
 * Layout: grilla tipo tabla en desktop; en < 640 px cada servicio es una card
 * apilada con etiquetas visibles (la fila tiene 7 columnas: no entra).
 *
 * CF2 (§29, T.C): sale la columna del aviso al reservar. El aviso de los turnos online
 * pasa a ser del profesional (mail / push en Configuración › Mi agenda), no por
 * servicio: el switch por servicio no mandaba nada que el profesional viera.
 * La columna `notifyOnBooking` sigue en la base y el borrador manda el valor
 * guardado (`rowToDraft` → `draftToInput`), así que guardar otra celda no lo
 * apaga solo.
 *
 * La anticipación vacía hereda la del profesional (CF2, D-CF2-8) y, si no
 * tiene, la del consultorio: el hint lo dice.
 *
 * CF3 (§30, sesión AU-U1):
 * - Columna «Precio» / «Tu precio» (`PractitionerService.priceCents`, M22, D-CF3-1) con `MoneyInput`. Vacío = usa el
 *   precio del consultorio (`Service.priceCents`, que el hint muestra). Un precio que no cambió NO viaja al guardar
 *   la fila (`draftToInput(draft, baseline)`): Configuración y «Mi agenda» pueden editar la misma fila sin pisarse.
 * - Prop `scope`: `"config"` (default, Configuración › Profesionales: igual que antes + precio) o `"self"` («Mi
 *   agenda», el profesional sobre sí mismo; contrato en `ServicesEditorProps`). En `"self"`:
 *   - no se listan los servicios propios de OTRO profesional (por la vía propia no los puede habilitar);
 *   - se ocultan «Anticipación mínima», «Hasta» y «Cupo por horario»: D-CF3-7/13 le dan al profesional habilitar,
 *     precio, duración y público/privado; su anticipación ya está en la sección «Turnero online» de «Mi agenda»
 *     (CF2, D-CF2-8) y el cupo/«servicios distintos a la vez» remiten a Profesionales › Horarios, que él no ve. Los
 *     valores guardados de esas columnas viajan igual (`rowToDraft` → `draftToInput`), así que no se pierden;
 *   - «Nuevo servicio» crea un servicio PROPIO (`own-service-form.tsx`, D-CF3-6, tope `OWN_SERVICES_MAX`), y los
 *     propios se editan y borran desde «Editar»; los del consultorio solo se habilitan y se les pone precio.
 *   - CF3b (SV, 05-nov): el alta tiene «Para todo el consultorio». El botón ya no se apaga con el tope de propios
 *     lleno (el tope cuenta solo los propios): abre el alta con el checkbox fijo en marcado y el hint lo explica.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { Tag } from "@/components/ui/tag";
import { MoneyInput } from "@/components/ui/money-input";
import { formatARS } from "@/lib/format";
import {
  listPractitionerServices,
  upsertPractitionerService,
} from "@/lib/practitioner-services";
import {
  PS_MAX_CONCURRENT_MAX,
  PS_MAX_LEAD_DAYS_MAX,
  type PractitionerServiceRow,
} from "@/lib/practitioner-config-schemas";
import {
  draftToInput,
  inheritedPriceHint,
  isDraftDirty,
  isOwnService,
  ownServicesLeft,
  rowToDraft,
  visibleServiceRows,
  type ServiceDraft,
  type ServiceDraftErrors,
  type ServicesEditorScope,
} from "@/lib/practitioner-editors-state";
import { OwnServiceDrawer, type OwnServiceSaved } from "./own-service-form";
import { ErrorBox } from "../../controls";
import { durationOptionsWith } from "@/lib/service-durations";

/** CF-U4: la misma línea en Servicios (catálogo) y en los servicios del profesional. */
export const CUPO_SCOPE_HINT =
  "El cupo es por servicio. Un profesional no atiende servicios distintos a la vez salvo que lo actives en Profesionales → Horarios («Atiende servicios distintos a la vez»).";

type RowStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

export type RowState = {
  row: PractitionerServiceRow;
  baseline: ServiceDraft;
  draft: ServiceDraft;
  errors: ServiceDraftErrors;
  status: RowStatus;
  /** El texto del precio no se puede leer («1,2,3»): la fila no se guarda hasta corregirlo. */
  priceInvalid?: boolean;
};

export type { ServicesEditorScope };

/**
 * Contrato de props (CF3, para AU-U2 / «Mi agenda»). Montarlo dentro de `ConfirmProvider` (el drawer de «Nuevo
 * servicio» usa `useConfirm` vía `Drawer`), como el resto de Configuración.
 * - `practitionerId`: en `"self"`, el `Practitioner` del propio usuario (el server igual lo exige: AU-S).
 * - `practitionerName`: para el copy y los aria-label.
 * - `onDirtyChange`: opcional, el shell frena el cambio de pestaña/sección con filas sin guardar.
 * - `scope`: `"config"` (default) o `"self"`.
 */
export type ServicesEditorProps = {
  practitionerId: string;
  practitionerName: string;
  /** Opcional: avisa al shell si hay filas con cambios sin guardar. */
  onDirtyChange?: (dirty: boolean) => void;
  scope?: ServicesEditorScope;
};

const freshState = (row: PractitionerServiceRow): RowState => {
  const d = rowToDraft(row);
  return { row, baseline: d, draft: d, errors: {}, status: { kind: "idle" } };
};

/**
 * Lista recargada (tras crear un servicio propio) sobre el estado actual: una fila con cambios sin guardar conserva
 * su borrador (recargar no le borra lo que estaba tipeando); el resto toma lo del server.
 */
function mergeReloaded(prev: RowState[] | null, next: PractitionerServiceRow[]): RowState[] {
  return next.map((row) => {
    const ex = prev?.find((s) => s.row.serviceId === row.serviceId);
    if (ex && isDraftDirty(ex.draft, ex.baseline)) return { ...ex, row };
    return freshState(row);
  });
}

export function ServicesEditor({
  practitionerId,
  practitionerName,
  onDirtyChange,
  scope = "config",
}: ServicesEditorProps) {
  const [rows, setRows] = useState<RowState[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const self = scope === "self";
  /** Drawer del servicio propio: alta (`row` ausente) o edición. */
  const [ownDrawer, setOwnDrawer] = useState<{ row?: PractitionerServiceRow } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setLoadError(null);
    (async () => {
      try {
        const r = await listPractitionerServices(practitionerId);
        if (cancelled) return;
        if (!r.ok) {
          setLoadError(r.error);
          return;
        }
        setRows(r.data.map(freshState));
      } catch {
        // `requireCapability` tira ForbiddenError (rol sin `schedule.configure`)
        // y en prod Next oculta el mensaje: mostramos uno genérico.
        if (!cancelled) setLoadError("No pudimos cargar los servicios. Reintentá en un momento.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [practitionerId, reloadKey]);

  const dirtyCount = useMemo(
    () => (rows ?? []).filter((s) => isDraftDirty(s.draft, s.baseline)).length,
    [rows]
  );

  const onDirtyRef = useRef(onDirtyChange);
  onDirtyRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyRef.current?.(dirtyCount > 0);
  }, [dirtyCount]);

  // Dirty-guard al cerrar/recargar la pestaña del navegador. El cambio de
  // profesional dentro de Configuración lo frena el shell vía `onDirtyChange`.
  useEffect(() => {
    if (dirtyCount === 0) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirtyCount]);

  const shown = useMemo(
    () => (rows ? visibleServiceRows(rows.map((s) => s.row), scope, practitionerId) : null),
    [rows, scope, practitionerId]
  );
  const shownIds = useMemo(() => new Set((shown ?? []).map((r) => r.serviceId)), [shown]);
  const own = useMemo(
    () => ownServicesLeft((rows ?? []).map((s) => s.row), practitionerId),
    [rows, practitionerId]
  );

  const setPriceInvalid = useCallback((serviceId: string, invalid: boolean) => {
    setRows((prev) =>
      prev ? prev.map((s) => (s.row.serviceId === serviceId ? { ...s, priceInvalid: invalid } : s)) : prev
    );
  }, []);

  const onOwnSaved = useCallback(
    async (result: OwnServiceSaved) => {
      setOwnDrawer(null);
      if (result.kind === "deleted") {
        setRows((prev) => (prev ? prev.filter((s) => s.row.serviceId !== result.serviceId) : prev));
        setNotice("Servicio borrado.");
        return;
      }
      if (result.kind === "updated") {
        const p = result.payload;
        setRows((prev) =>
          prev
            ? prev.map((s) =>
                s.row.serviceId === result.serviceId
                  ? {
                      ...s,
                      row: {
                        ...s.row,
                        serviceName: p.name,
                        serviceColor: p.color || null,
                        serviceDurationMin: p.durationMin,
                        servicePriceCents: p.priceCents,
                        serviceMaxConcurrent: p.maxConcurrent === "" ? null : Number(p.maxConcurrent),
                      },
                    }
                  : s
              )
            : prev
        );
        setNotice("Servicio actualizado.");
        return;
      }
      // Alta: la fila nueva (y su `PractitionerService` habilitado por el server) sale de recargar la lista.
      try {
        const r = await listPractitionerServices(practitionerId);
        if (r.ok) setRows((prev) => mergeReloaded(prev, r.data));
        else setReloadKey((k) => k + 1);
      } catch {
        setReloadKey((k) => k + 1);
      }
      setNotice(
        result.forClinic
          ? "Servicio creado para todo el consultorio. Ya aparece en tu agenda."
          : "Servicio creado. Ya aparece en tu agenda."
      );
    },
    [practitionerId]
  );

  const patch = useCallback((serviceId: string, change: Partial<ServiceDraft>) => {
    setRows((prev) =>
      prev
        ? prev.map((s) =>
            s.row.serviceId === serviceId
              ? {
                  ...s,
                  draft: { ...s.draft, ...change },
                  // Editar limpia el error del campo y el "Guardado" anterior.
                  errors: {},
                  status: s.status.kind === "saving" ? s.status : { kind: "idle" },
                }
              : s
          )
        : prev
    );
  }, []);

  const discard = useCallback((serviceId: string) => {
    setRows((prev) =>
      prev
        ? prev.map((s) =>
            s.row.serviceId === serviceId
              ? { ...s, draft: s.baseline, errors: {}, status: { kind: "idle" } }
              : s
          )
        : prev
    );
  }, []);

  const save = useCallback(
    async (serviceId: string) => {
      const current = rows?.find((s) => s.row.serviceId === serviceId);
      if (!current) return;
      if (current.priceInvalid) {
        setRows((prev) =>
          prev
            ? prev.map((s) =>
                s.row.serviceId === serviceId
                  ? { ...s, status: { kind: "error", message: "Revisá el precio: el monto no es válido." } }
                  : s
              )
            : prev
        );
        return;
      }
      // Con baseline: un precio que no cambió no viaja (no pisa el que se cargó desde la otra pantalla).
      const parsed = draftToInput(current.draft, current.baseline);
      const setRow = (fn: (s: RowState) => RowState) =>
        setRows((prev) => (prev ? prev.map((s) => (s.row.serviceId === serviceId ? fn(s) : s)) : prev));
      if (!parsed.ok) {
        setRow((s) => ({
          ...s,
          errors: parsed.errors,
          status: { kind: "error", message: "Revisá los campos marcados." },
        }));
        return;
      }
      const sent = current.draft;
      setRow((s) => ({ ...s, errors: {}, status: { kind: "saving" } }));
      let message: string | null = null;
      let fieldErrors: ServiceDraftErrors = {};
      try {
        const r = await upsertPractitionerService(practitionerId, serviceId, parsed.input);
        if (!r.ok) {
          message = r.error;
          const fe = r.fieldErrors ?? {};
          fieldErrors = {
            ...(fe.durationMin?.[0] ? { durationMin: fe.durationMin[0] } : {}),
            ...(fe.minLeadMinutes?.[0] ? { minLead: fe.minLeadMinutes[0] } : {}),
            ...(fe.maxLeadDays?.[0] ? { maxLeadDays: fe.maxLeadDays[0] } : {}),
            ...(fe.maxConcurrent?.[0] ? { maxConcurrent: fe.maxConcurrent[0] } : {}),
            ...(fe.priceCents?.[0] ? { priceCents: fe.priceCents[0] } : {}),
          };
        }
      } catch {
        message = "No pudimos guardar. Revisá la conexión y reintentá.";
      }
      if (message) {
        setRow((s) => ({ ...s, errors: fieldErrors, status: { kind: "error", message } }));
        return;
      }
      // El baseline pasa a ser lo que se mandó. Si el usuario siguió tipeando
      // mientras se guardaba, su draft nuevo queda (y la fila sigue "sucia").
      setRow((s) => ({
        ...s,
        row: { ...s.row, hasRow: true },
        baseline: sent,
        status: { kind: "saved" },
      }));
    },
    [rows, practitionerId]
  );

  return (
    <Card style={{ padding: 0, overflow: "hidden" }} className="pse">
      <style>{PSE_CSS}</style>
      <header style={{ padding: "16px 20px", borderBottom: "1px solid rgba(15,30,51,0.06)" }}>
        <div className="pse-top">
          <div style={{ minWidth: 0 }}>
            <EyebrowLabel>{self ? "Servicios y precios" : "Servicios que atiende"}</EyebrowLabel>
            <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 4 }}>
              {self ? (
                <>
                  Elegí qué servicios atendés, cuánto dura cada uno, si aparece en el turnero online y cuánto cobrás.
                  Si dejás el precio vacío, se usa el del consultorio. Cada fila se guarda por separado.
                </>
              ) : (
                <>
                  Qué servicios ofrece {practitionerName} y con qué reglas. Lo que dejes vacío toma el valor
                  del servicio. Cada fila se guarda por separado.
                </>
              )}
            </div>
          </div>
          {self && rows !== null && !loadError && (
            <div style={{ display: "grid", gap: 4, justifyItems: "end" }}>
              {/* CF3b (SV): con el tope de propios lleno se puede seguir creando para todo el consultorio. */}
              <Button
                type="button"
                variant="primary"
                className="pse-new"
                aria-describedby={own.limitMessage ? "pse-own-limit" : undefined}
                onClick={() => setOwnDrawer({})}
              >
                Nuevo servicio
              </Button>
              {own.limitMessage && (
                <span id="pse-own-limit" className="pse-hint" style={{ maxWidth: 260, textAlign: "right" }}>
                  {own.limitMessage}
                </span>
              )}
            </div>
          )}
        </div>
        {/* CF-U4 (decisión 1): el cupo no habilita a atender OTRO servicio en el mismo horario; eso es el interruptor
            «Atiende servicios distintos a la vez» de la ficha (sub-pestaña Horarios). En «Mi agenda» no hay columna de
            cupo ni pestaña Horarios: el hint no se muestra. */}
        {!self && <div style={{ fontSize: 12, color: "var(--navy-500)", marginTop: 4 }}>{CUPO_SCOPE_HINT}</div>}
        {notice && (
          <div role="status" style={{ fontSize: 12, color: "var(--success-fg)", marginTop: 6, fontWeight: 600 }}>
            {notice}
          </div>
        )}
        {dirtyCount > 0 && (
          <div role="status" style={{ fontSize: 12, color: "var(--warn-fg)", marginTop: 6, fontWeight: 600 }}>
            {dirtyCount === 1 ? "1 servicio con cambios sin guardar" : `${dirtyCount} servicios con cambios sin guardar`}
          </div>
        )}
      </header>

      {loadError ? (
        <div style={{ padding: 20, display: "grid", gap: 10, justifyItems: "start" }}>
          <ErrorBox>{loadError}</ErrorBox>
          <Button variant="ghost" onClick={() => setReloadKey((k) => k + 1)}>
            Reintentar
          </Button>
        </div>
      ) : rows === null ? (
        <div role="status" style={{ padding: 28, textAlign: "center", color: "var(--navy-500)", fontSize: 13 }}>
          Cargando servicios…
        </div>
      ) : shownIds.size === 0 ? (
        <div style={{ padding: 28, textAlign: "center", color: "var(--navy-500)", fontSize: 13 }}>
          {self
            ? "Todavía no hay servicios. Creá el tuyo con «Nuevo servicio»."
            : "Todavía no cargaste servicios. Crealos en la pestaña Servicios y después volvé acá."}
        </div>
      ) : (
        <div className="pse-scroll" data-scope={scope}>
          <div className="pse-head" aria-hidden="true">
            <span>Servicio</span>
            <span>Duración</span>
            <span>{self ? "Tu precio" : "Precio"}</span>
            <span>Visibilidad</span>
            {!self && (
              <>
                <span>Anticipación mínima</span>
                <span>Hasta</span>
                <span>Cupo por horario</span>
              </>
            )}
            <span />
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {rows
              .filter((s) => shownIds.has(s.row.serviceId))
              .map((s) => (
                <ServiceRowEditor
                  key={s.row.serviceId}
                  state={s}
                  practitionerId={practitionerId}
                  scope={scope}
                  onPatch={patch}
                  onSave={save}
                  onDiscard={discard}
                  onPriceInvalid={setPriceInvalid}
                  onEditOwn={self ? (row) => setOwnDrawer({ row }) : undefined}
                />
              ))}
          </ul>
        </div>
      )}
      {ownDrawer && (
        <OwnServiceDrawer
          row={ownDrawer.row}
          onClose={() => setOwnDrawer(null)}
          onSaved={onOwnSaved}
          ownLimitReached={!ownDrawer.row && !own.canCreate}
        />
      )}
    </Card>
  );
}

/** Exportado para los render tests (`renderToStaticMarkup` no corre el efecto que carga la lista). */
export function ServiceRowEditor({
  state,
  practitionerId,
  scope = "config",
  onPatch,
  onSave,
  onDiscard,
  onPriceInvalid,
  onEditOwn,
}: {
  state: RowState;
  practitionerId: string;
  scope?: ServicesEditorScope;
  onPatch: (serviceId: string, change: Partial<ServiceDraft>) => void;
  onSave: (serviceId: string) => void;
  onDiscard: (serviceId: string) => void;
  onPriceInvalid?: (serviceId: string, invalid: boolean) => void;
  /** Solo en `"self"`: abre el drawer de edición de un servicio PROPIO. */
  onEditOwn?: (row: PractitionerServiceRow) => void;
}) {
  const { row, draft: d, errors, status } = state;
  const self = scope === "self";
  const mine = isOwnService(row, practitionerId);
  const sid = row.serviceId;
  const idp = `pse-${sid}`;
  const dirty = isDraftDirty(d, state.baseline);
  const priceInvalid = !!state.priceInvalid;
  const saving = status.kind === "saving";
  const off = !d.enabled;
  const set = (change: Partial<ServiceDraft>) => onPatch(sid, change);
  const ownedByOther =
    row.serviceOwnerPractitionerId !== null && row.serviceOwnerPractitionerId !== practitionerId;
  const serviceCap =
    row.serviceMaxConcurrent == null ? "sin límite" : String(row.serviceMaxConcurrent);
  const n = row.serviceName;

  return (
    <li className="pse-row" data-off={off || undefined} aria-labelledby={`${idp}-name`}>
      {/* Servicio + Atiende */}
      <div className="pse-cell pse-name">
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span
            aria-hidden="true"
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              background: row.serviceColor ?? "rgba(15,30,51,0.12)",
              flexShrink: 0,
            }}
          />
          <span id={`${idp}-name`} style={{ fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" }}>
            {n}
          </span>
        </div>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginTop: 6, fontSize: 12, color: "var(--navy-500)", fontWeight: 600 }}>
          <MiniSwitch
            on={d.enabled}
            onChange={() => set({ enabled: !d.enabled })}
            label={`Atiende ${n}`}
            disabled={saving}
          />
          Atiende
        </label>
        {ownedByOther && (
          <div style={{ marginTop: 4 }}>
            <Tag tone="soft">Asignado a otro profesional</Tag>
          </div>
        )}
        {self && (
          <div style={{ marginTop: 4 }}>
            {/* Canal no cromático (AGENTS §5): de quién es el servicio se dice con texto, no con color. */}
            <Tag tone="soft">{mine ? "Tuyo" : "Del consultorio"}</Tag>
          </div>
        )}
      </div>

      {/* Duración */}
      <div className="pse-cell">
        <label className="pse-label" htmlFor={`${idp}-dur`}>Duración</label>
        <div className="pse-inline">
          {/* T3 (§23.8): la grilla de 15 (lib/service-durations.ts); vacío = la del servicio (hereda). Un valor propio
              guardado fuera de grilla (40, 50) se muestra tal cual («50 min (actual)»): guardar la fila sin tocarlo no
              lo cambia. El server sigue aceptando múltiplos de 5 (`PS_DURATION_MIN/MAX`). */}
          <select
            id={`${idp}-dur`}
            className="pse-input"
            value={d.durationMin}
            disabled={off || saving}
            aria-label={`Duración de ${n} en minutos (vacío: ${row.serviceDurationMin} del servicio)`}
            aria-invalid={!!errors.durationMin || undefined}
            aria-describedby={errors.durationMin ? `${idp}-dur-err` : undefined}
            onChange={(e) => set({ durationMin: e.target.value })}
            style={{ minWidth: 132 }}
          >
            <option value="">{`Del servicio (${row.serviceDurationMin} min)`}</option>
            {durationOptionsWith(d.durationMin === "" ? null : Number(d.durationMin)).map((o) => (
              <option key={o.value} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <FieldError id={`${idp}-dur-err`} msg={errors.durationMin} />
      </div>

      {/* CF3 ZF3 (revisor de UI): un servicio PROPIO en «Mi agenda» tenía dos precios editables (este «Tu precio» y el
          «Precio» del Drawer de «Editar»). El precio de lo propio se edita solo en el Drawer; la fila lo muestra. */}
      {self && mine ? (
        <div className="pse-cell pse-price">
          <span className="pse-label" id={`${idp}-price-l`}>Precio</span>
          <span className="pse-value" style={{ fontSize: 14, fontWeight: 600 }}>
            {formatARS(d.price ?? row.servicePriceCents)}
          </span>
          <span className="pse-hint">Lo cambiás desde «Editar»</span>
        </div>
      ) : (
      /* Precio (CF3, D-CF3-1): vacío = el del consultorio. Lo cobra a particulares; con OS manda el copago. */
      <div className="pse-cell pse-price">
        <span className="pse-label" id={`${idp}-price-l`}>{self ? "Tu precio" : "Precio"}</span>
        <MoneyInput
          variant="compact"
          value={d.price}
          onChange={(cents) => set({ price: cents })}
          onInvalidChange={(inv) => onPriceInvalid?.(sid, inv)}
          ariaLabel={self ? `Tu precio para ${n} (vacío: el del consultorio)` : `Precio de ${n} para este profesional (vacío: el del consultorio)`}
          placeholder="—"
          disabled={off || saving}
          error={errors.priceCents}
          width={128}
        />
        <span className="pse-hint">
          {d.price === null
            ? inheritedPriceHint(row, mine)
            : self
              ? "Lo pagan tus particulares; con obra social, el copago"
              : "Lo pagan sus particulares; con obra social, el copago"}
        </span>
      </div>
      )}

      {/* Visibilidad */}
      <div className="pse-cell">
        <label className="pse-label" htmlFor={`${idp}-vis`}>Visibilidad</label>
        <select
          id={`${idp}-vis`}
          className="pse-input"
          value={d.visibility}
          disabled={off || saving}
          aria-label={`Visibilidad de ${n}`}
          aria-describedby={`${idp}-vis-hint`}
          onChange={(e) => set({ visibility: e.target.value === "PRIVATE" ? "PRIVATE" : "PUBLIC" })}
          style={{ background: "var(--card-bg)", appearance: "auto" }}
        >
          <option value="PUBLIC">Pública</option>
          <option value="PRIVATE">Privada</option>
        </select>
        <span id={`${idp}-vis-hint`} className="pse-hint">
          {d.visibility === "PUBLIC" ? "Aparece en el turnero online" : "Solo la agenda del consultorio"}
        </span>
      </div>

      {!self && (
      <>
      {/* Anticipación mínima */}
      <div className="pse-cell">
        <span className="pse-label" id={`${idp}-lead-l`}>Anticipación mínima</span>
        <div className="pse-inline" role="group" aria-labelledby={`${idp}-lead-l`}>
          <input
            className="pse-input"
            type="number"
            inputMode="numeric"
            min={0}
            placeholder="—"
            value={d.leadHours}
            disabled={off || saving}
            aria-label={`Anticipación mínima de ${n}: horas`}
            aria-invalid={!!errors.minLead || undefined}
            aria-describedby={errors.minLead ? `${idp}-lead-err` : `${idp}-lead-hint`}
            onChange={(e) => set({ leadHours: e.target.value })}
            style={{ width: 58 }}
          />
          <span className="pse-unit">h</span>
          <input
            className="pse-input"
            type="number"
            inputMode="numeric"
            min={0}
            max={59}
            step={5}
            placeholder="—"
            value={d.leadMinutes}
            disabled={off || saving}
            aria-label={`Anticipación mínima de ${n}: minutos`}
            aria-invalid={!!errors.minLead || undefined}
            aria-describedby={errors.minLead ? `${idp}-lead-err` : `${idp}-lead-hint`}
            onChange={(e) => set({ leadMinutes: e.target.value })}
            style={{ width: 58 }}
          />
          <span className="pse-unit">min</span>
        </div>
        {errors.minLead ? (
          <FieldError id={`${idp}-lead-err`} msg={errors.minLead} />
        ) : (
          <span id={`${idp}-lead-hint`} className="pse-hint">Vacío: la del profesional o la del consultorio</span>
        )}
      </div>

      {/* Anticipación máxima */}
      <div className="pse-cell">
        <label className="pse-label" htmlFor={`${idp}-max`}>Hasta</label>
        <div className="pse-inline">
          <input
            id={`${idp}-max`}
            className="pse-input"
            type="number"
            inputMode="numeric"
            min={0}
            max={PS_MAX_LEAD_DAYS_MAX}
            placeholder="Sin tope"
            value={d.maxLeadDays}
            disabled={off || saving}
            aria-label={`Anticipación máxima de ${n} en días (vacío: sin tope)`}
            aria-invalid={!!errors.maxLeadDays || undefined}
            aria-describedby={errors.maxLeadDays ? `${idp}-max-err` : undefined}
            onChange={(e) => set({ maxLeadDays: e.target.value })}
            style={{ width: 80 }}
          />
          <span className="pse-unit">días</span>
        </div>
        <FieldError id={`${idp}-max-err`} msg={errors.maxLeadDays} />
      </div>

      {/* Cupo */}
      <div className="pse-cell">
        <span className="pse-label">Cupo por horario</span>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--navy-500)" }}>
          <MiniSwitch
            on={d.concurrencyOverride}
            onChange={() => set({ concurrencyOverride: !d.concurrencyOverride })}
            label={`Cupo de ${n} distinto al del servicio`}
            disabled={off || saving}
          />
          Distinto al del servicio
        </label>
        {d.concurrencyOverride ? (
          <div className="pse-inline" style={{ marginTop: 6 }}>
            <input
              className="pse-input"
              type="number"
              inputMode="numeric"
              min={1}
              max={PS_MAX_CONCURRENT_MAX}
              value={d.concurrencyUnlimited ? "" : d.maxConcurrent}
              placeholder={d.concurrencyUnlimited ? "∞" : "1"}
              disabled={off || saving || d.concurrencyUnlimited}
              aria-label={`Cupo propio de ${n} (pacientes por horario)`}
              aria-invalid={!!errors.maxConcurrent || undefined}
              aria-describedby={errors.maxConcurrent ? `${idp}-cap-err` : undefined}
              onChange={(e) => set({ maxConcurrent: e.target.value })}
              style={{ width: 64 }}
            />
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--navy-500)" }}>
              <input
                type="checkbox"
                checked={d.concurrencyUnlimited}
                disabled={off || saving}
                onChange={(e) => set({ concurrencyUnlimited: e.target.checked })}
              />
              Sin límite
            </label>
          </div>
        ) : (
          <span className="pse-hint">Del servicio: {serviceCap}</span>
        )}
        <FieldError id={`${idp}-cap-err`} msg={errors.maxConcurrent} />
      </div>
      </>
      )}

      {/* Acción + estado */}
      <div className="pse-cell pse-actions">
        <Button
          variant="primary"
          type="button"
          disabled={!dirty || saving || priceInvalid}
          onClick={() => onSave(sid)}
          aria-label={`Guardar ${n}`}
          style={{ padding: "8px 14px", fontSize: 13 }}
        >
          {saving ? "Guardando…" : "Guardar"}
        </Button>
        {dirty && !saving && (
          <button type="button" className="pse-link" onClick={() => onDiscard(sid)} aria-label={`Deshacer cambios de ${n}`}>
            Deshacer
          </button>
        )}
        {self && mine && onEditOwn && (
          <button
            type="button"
            className="pse-link"
            onClick={() => onEditOwn(row)}
            disabled={saving}
            aria-label={`Editar o borrar ${n}`}
          >
            Editar
          </button>
        )}
        <div aria-live="polite" style={{ minHeight: 16 }}>
          {status.kind === "saved" && !dirty && (
            <span style={{ fontSize: 12, color: "var(--success-fg)", fontWeight: 600 }}>Guardado</span>
          )}
          {dirty && !saving && status.kind !== "error" && (
            <span style={{ fontSize: 12, color: "var(--warn-fg)" }}>Sin guardar</span>
          )}
        </div>
        {status.kind === "error" && (
          <span role="alert" style={{ fontSize: 12, color: "var(--danger-fg)" }}>
            {status.message}
          </span>
        )}
      </div>
    </li>
  );
}

function FieldError({ id, msg }: { id: string; msg?: string }) {
  if (!msg) return null;
  return (
    <span id={id} className="pse-hint" style={{ color: "var(--danger-fg)" }}>
      {msg}
    </span>
  );
}

/**
 * Switch accesible chico. No reusa `Switch` de `../../controls` porque ese no
 * acepta `aria-label` (en una tabla con N filas, "switch, activado" sin nombre
 * no le dice nada a un lector de pantalla) y su tamaño es el de Configuración
 * General, demasiado grande para una celda.
 */
function MiniSwitch({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onChange}
      disabled={disabled}
      className="pse-switch"
      style={{
        width: 38,
        height: 22,
        borderRadius: 999,
        border: "none",
        background: on ? "var(--sky-700)" : "rgba(15,30,51,0.18)",
        position: "relative",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 160ms ease",
        flexShrink: 0,
        padding: 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 2,
          left: on ? 18 : 2,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "var(--card-bg)",
          boxShadow: "0 1px 4px rgba(15,30,51,0.2)",
          transition: "left 160ms ease",
        }}
      />
    </button>
  );
}

// Grilla compartida por el encabezado y las filas. Entre 640 y ~1100 px la
// grilla puede no entrar: el contenedor scrollea horizontal en vez de apretar
// los inputs. Debajo de 640 px cada fila es una card apilada con etiquetas.
// CF3: + «Precio» (150 px) en Configuración; en «Mi agenda» quedan 5 columnas y entra sin scroll en 1366×768.
const PSE_COLS =
  "minmax(150px,1.4fr) 110px 150px 140px 170px 120px minmax(170px,1fr) 110px";
const PSE_COLS_SELF = "minmax(180px,1.6fr) 150px 170px 160px 120px";
const PSE_CSS = `
.pse .pse-scroll { overflow-x: auto; }
.pse .pse-head, .pse .pse-row {
  display: grid; grid-template-columns: ${PSE_COLS}; gap: 12px; align-items: start;
  min-width: 1150px; padding: 12px 20px;
}
.pse .pse-scroll[data-scope="self"] .pse-head, .pse .pse-scroll[data-scope="self"] .pse-row {
  grid-template-columns: ${PSE_COLS_SELF}; min-width: 780px;
}
.pse .pse-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.pse .pse-price { align-items: flex-start; }
.pse .pse-price > div { justify-items: start !important; }
.pse .pse-head {
  font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
  color: var(--navy-300); border-bottom: 1px solid rgba(15,30,51,0.06); padding-top: 10px; padding-bottom: 10px;
}
.pse .pse-row { border-bottom: 1px solid rgba(15,30,51,0.04); }
.pse .pse-row[data-off] .pse-cell:not(.pse-name):not(.pse-actions) { opacity: 0.55; }
.pse .pse-cell { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.pse .pse-label { display: none; font-size: 12px; font-weight: 600; color: var(--navy-500); }
.pse .pse-inline { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.pse .pse-unit { font-size: 12px; color: var(--navy-500); }
.pse .pse-hint { font-size: 11px; color: var(--navy-500); } /* CF3 ZF3: --navy-300 a 11 px no llegaba a AA. */
.pse .pse-input {
  padding: 7px 9px; border-radius: 10px; background: rgba(255,255,255,0.96);
  border: 1px solid rgba(15,30,51,0.12); font-size: 13px; color: var(--navy-900); min-width: 0;
}
.pse .pse-input[aria-invalid="true"] { border-color: var(--danger-border); }
.pse .pse-input:disabled { cursor: not-allowed; opacity: 0.6; }
.pse .pse-actions { align-items: flex-start; }
.pse .pse-link {
  background: transparent; border: none; padding: 0; font-size: 12px; font-weight: 700;
  color: var(--sky-700); cursor: pointer;
}
.pse input:focus-visible, .pse select:focus-visible, .pse button:focus-visible {
  outline: 2px solid var(--sky-700); outline-offset: 2px;
}
@media (max-width: 639px) {
  .pse .pse-head { display: none; }
  .pse .pse-scroll { overflow-x: visible; }
  .pse .pse-row {
    grid-template-columns: 1fr 1fr; min-width: 0; padding: 14px 16px; gap: 12px 14px;
    border-bottom: 1px solid rgba(15,30,51,0.08);
  }
  .pse .pse-label { display: block; }
  .pse .pse-name, .pse .pse-actions { grid-column: 1 / -1; }
  .pse .pse-scroll[data-scope="self"] .pse-row { grid-template-columns: 1fr 1fr; min-width: 0; }
  .pse .pse-top > div:last-child { width: 100%; justify-items: stretch !important; }
  .pse .pse-actions { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 10px; }
}
/* T3a-3t: MiniSwitch 38×22 → 44×44 de área táctil < 768 con un pseudo transparente (el switch se ve igual). El botón
   ya es position: relative inline (la perilla). Los vecinos en la celda son texto, no controles. */
@media (max-width: 767px) {
  .pse .pse-switch::before { content: ""; position: absolute; inset: -11px -3px; }
  .pse .pse-input { min-height: 44px; font-size: 16px; }
  /* El MoneyInput compacto trae 14 px inline: < 16 px iOS hace zoom al enfocar. */
  .pse .pse-price input { min-height: 44px; font-size: 16px !important; }
  .pse .pse-actions button, .pse .pse-new { min-height: 44px; }
  .pse .pse-link { min-height: 44px; padding: 0 6px; }
}
`;

"use client";

/**
 * Configuración → Profesionales → [profesional] → «Reparto» (CF2 · P.3, plan §29: decisión 4 de Martin + D-CF2-18).
 *
 * Qué % de lo cobrado le destina este profesional a otro, y sobre cuáles de las 3 fuentes (copagos del consultorio,
 * cobros online, obra social). Solo con `tenant.sensitive` (el shell no muestra la sub-pestaña sin él; la action
 * vuelve a exigirlo).
 *
 * - Datos LAZY: `listRevenueShares()` al montar la sub-pestaña, no en el loader de `/configuracion` (el reparto es de
 *   pocos y el loader tiene presupuesto de sentencias). Trae TODO el consultorio: el editor filtra por profesional
 *   y valida el grafo (sin mutuos ni cadenas, D-CF2-18) con las vigentes, antes de mandar.
 * - Vigencia por INSTANTE (D-CF2-18): «Guardar desde ahora» cierra la vigente en `now` y abre otra; nunca hay fechas
 *   retroactivas, así que el formulario no tiene fecha. Si ya había regla, se confirma con `useConfirm` porque lo
 *   que cambia es lo que se cobre DESDE ahora (lo ya cobrado no se recalcula).
 * - CAS: se manda `expectedOpenId` (la vigente que se ve). Si otra pestaña la cambió, el server responde «Cambió
 *   mientras lo editabas» y acá se ofrece recargar (no se reintenta a ciegas sobre una regla que no se vio).
 * - Formulario en línea (como Coberturas/Servicios): sus cambios entran al dirty-guard del shell por `onDirtyChange`.
 *
 * Partido en dos: `RevenueShareEditor` (carga) y `RevenueShareEditorBody` (estado del formulario sobre datos ya
 * cargados), así el render test ve el cuerpo con datos sin red, y al recargar después de guardar el cuerpo se
 * remonta (`key` = la vigente) con el borrador nuevo de base.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { Tag } from "@/components/ui/tag";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { endRevenueShare, listRevenueShares, setRevenueShare } from "@/lib/revenue-share";
import {
  formatSharePct,
  formatSharePctInput,
  openRuleForGiver,
  openRulesReceivedBy,
  openShareEdges,
  parseSharePct,
  rulesForGiver,
  validateShareGraph,
} from "@/lib/revenue-share-logic";
import {
  REVENUE_SHARE_COPY,
  REVENUE_SOURCES,
  REVENUE_SOURCE_LABEL,
  SHARE_GRAPH_ERROR_COPY,
  type RevenueShareListView,
  type RevenueShareReceiverOption,
  type RevenueShareRuleView,
  type RevenueShareSources,
} from "@/lib/revenue-share-types";
import { ErrorBox } from "../../controls";

const AR_TZ = "America/Argentina/Buenos_Aires";

// ─── Lógica pura del formulario (exportada para el unit test) ────────────────────────────────────────────────────

export type RevenueShareDraft = {
  /** El % tal como se escribe («12,5»); se valida con `parseSharePct` (bps enteros, sin float). */
  pct: string;
  /** "" = sin elegir. */
  receiverId: string;
  sources: RevenueShareSources;
};

/** Regla nueva: las 3 fuentes marcadas (decisión 4: «completo, incluida la OS»; se destilda lo que no va). */
const ALL_SOURCES: RevenueShareSources = { manual: true, online: true, insurer: true };

/** Borrador de partida: la vigente (si hay) o vacío con las 3 fuentes. */
export function revenueShareDraftFrom(rule: RevenueShareRuleView | null): RevenueShareDraft {
  if (!rule) return { pct: "", receiverId: "", sources: { ...ALL_SOURCES } };
  return { pct: formatSharePctInput(rule.shareBps), receiverId: rule.receiverPractitionerId, sources: { ...rule.sources } };
}

/**
 * ¿Hay cambios sin guardar? El % se compara por su valor («20» = «20,0» = «20 %») cuando los dos parsean, para que
 * reescribir lo mismo no frene el cambio de pestaña; si alguno no parsea, por texto.
 */
export function isRevenueShareDraftDirty(draft: RevenueShareDraft, base: RevenueShareDraft): boolean {
  if (draft.receiverId !== base.receiverId) return true;
  if (REVENUE_SOURCES.some((s) => draft.sources[s] !== base.sources[s])) return true;
  const a = parseSharePct(draft.pct);
  const b = parseSharePct(base.pct);
  if (a !== null && b !== null) return a !== b;
  return draft.pct.trim() !== base.pct.trim();
}

export type RevenueShareFormError = { field: "pct" | "receiver" | "sources" | "form"; error: string };

export type RevenueShareFormResult =
  | {
      ok: true;
      input: {
        giverPractitionerId: string;
        receiverPractitionerId: string;
        sharePct: string;
        sources: RevenueShareSources;
        expectedOpenId: string | null;
      };
    }
  | { ok: false; errors: RevenueShareFormError[] };

export const REVENUE_SHARE_EDITOR_COPY = {
  noReceiver: "Elegí quién recibe.",
} as const;

/**
 * Validación del formulario ANTES de mandar (la action repite todo dentro de la tx con el lock: esto es para
 * mostrar el error en su campo, no la barrera). El grafo se valida con las vigentes del consultorio
 * (`validateShareGraph`, D-CF2-18); el payload es el de `SetRevenueShareSchema` (el % viaja como texto).
 */
export function revenueShareFormInput(
  draft: RevenueShareDraft,
  ctx: { giverPractitionerId: string; rules: readonly RevenueShareRuleView[] },
): RevenueShareFormResult {
  const errors: RevenueShareFormError[] = [];
  if (parseSharePct(draft.pct) === null) errors.push({ field: "pct", error: REVENUE_SHARE_COPY.invalidPct });
  if (!draft.receiverId) errors.push({ field: "receiver", error: REVENUE_SHARE_EDITOR_COPY.noReceiver });
  if (!REVENUE_SOURCES.some((s) => draft.sources[s])) errors.push({ field: "sources", error: REVENUE_SHARE_COPY.noSources });
  if (draft.receiverId) {
    const bad = validateShareGraph(openShareEdges(ctx.rules), {
      giverPractitionerId: ctx.giverPractitionerId,
      receiverPractitionerId: draft.receiverId,
    });
    if (bad) errors.push({ field: bad === "giverReceives" ? "form" : "receiver", error: SHARE_GRAPH_ERROR_COPY[bad] });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    input: {
      giverPractitionerId: ctx.giverPractitionerId,
      receiverPractitionerId: draft.receiverId,
      sharePct: draft.pct.trim(),
      sources: { manual: draft.sources.manual, online: draft.sources.online, insurer: draft.sources.insurer },
      expectedOpenId: openRuleForGiver(ctx.rules, ctx.giverPractitionerId)?.id ?? null,
    },
  };
}

/** «Copagos cobrados en el consultorio, Cobros online, Obra social» (orden fijo de `REVENUE_SOURCES`). */
export function revenueSourcesText(sources: RevenueShareSources): string {
  return REVENUE_SOURCES.filter((s) => sources[s])
    .map((s) => REVENUE_SOURCE_LABEL[s])
    .join(", ");
}

const INSTANT_FMT = new Intl.DateTimeFormat("es-AR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: AR_TZ,
});

/**
 * Instante de una vigencia en hora AR: «02/11 15:40»; con el año («02/11/2025 15:40») si no es el de `now`, para que
 * el historial de un año a otro no se lea como reciente. Por partes (`formatToParts`) y no `toLocaleString`, cuyo
 * separador fecha/hora («, ») cambia entre el ICU de Node y el del navegador.
 */
export function formatShareInstant(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const part = (date: Date) => {
    const out: Record<string, string> = {};
    for (const p of INSTANT_FMT.formatToParts(date)) out[p.type] = p.value;
    return out;
  };
  const p = part(d);
  const sameYear = p.year === part(now).year;
  return `${p.day}/${p.month}${sameYear ? "" : `/${p.year}`} ${p.hour}:${p.minute}`;
}

/** «Destina 20% a Ana Pérez · Copagos cobrados en el consultorio, Cobros online · desde 02/11 15:40». */
export function openRuleSentence(rule: RevenueShareRuleView, now: Date = new Date()): string {
  return `Destina ${formatSharePct(rule.shareBps)} a ${rule.receiverName} · ${revenueSourcesText(rule.sources)} · desde ${formatShareInstant(rule.effectiveFrom, now)}`;
}

/**
 * Receptores del select: los reservables del consultorio menos él mismo. Si la vigente apunta a alguien que ya no
 * puede recibir (lo suspendieron), se agrega igual para que el select no mienta sobre lo que rige; guardar contra él
 * lo rechaza el server con su copy.
 */
export function receiverOptionsFor(
  receivers: readonly RevenueShareReceiverOption[],
  giverPractitionerId: string,
  open: RevenueShareRuleView | null,
): Array<RevenueShareReceiverOption & { unavailable?: true }> {
  const out: Array<RevenueShareReceiverOption & { unavailable?: true }> = receivers.filter(
    (r) => r.practitionerId !== giverPractitionerId,
  );
  if (open && !out.some((r) => r.practitionerId === open.receiverPractitionerId)) {
    out.push({ practitionerId: open.receiverPractitionerId, name: open.receiverName, unavailable: true });
  }
  return out;
}

// ─── Componentes ─────────────────────────────────────────────────────────────────────────────────────────────────

type EditorProps = {
  practitionerId: string;
  practitionerName: string;
  /** Sesión de soporte: lee, no escribe (sus escrituras caen en la tx de solo lectura igual). */
  readOnly?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
};

export function RevenueShareEditor(props: EditorProps) {
  const { practitionerId } = props;
  const [data, setData] = useState<RevenueShareListView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    (async () => {
      try {
        const r = await listRevenueShares();
        if (cancelled) return;
        if (!r.ok) {
          setLoadError(r.error);
          return;
        }
        setData(r.data);
      } catch {
        // Red o un error del server redactado en prod: copy genérico.
        if (!cancelled) setLoadError("No pudimos cargar el reparto. Reintentá en un momento.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [practitionerId, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  if (loadError && !data) {
    return (
      <div data-revenue-share-editor style={{ display: "grid", gap: 10, justifyItems: "start" }}>
        <ErrorBox>{loadError}</ErrorBox>
        <Button variant="ghost" type="button" onClick={reload}>
          Reintentar
        </Button>
      </div>
    );
  }
  if (!data) {
    return (
      <div role="status" data-revenue-share-editor style={{ padding: 20, textAlign: "center", color: "var(--navy-500)", fontSize: 13 }}>
        Cargando reparto…
      </div>
    );
  }
  const open = openRuleForGiver(data.rules, practitionerId);
  // `key`: después de guardar/terminar/recargar, el borrador vuelve a partir de la vigente nueva.
  return <RevenueShareEditorBody key={`${open?.id ?? "none"}-${reloadKey}`} {...props} data={data} onReload={reload} />;
}

const box = {
  border: "1px solid rgba(15,30,51,0.08)",
  borderRadius: "var(--r-sm)",
  padding: 14,
  margin: 0,
  display: "grid",
  gap: 10,
} as const;
const hint = { fontSize: 12.5, color: "var(--navy-500)", lineHeight: 1.45 } as const;
const fieldErr = { fontSize: 12.5, fontWeight: 600, color: "var(--danger-fg)" } as const;
const control = {
  minHeight: 40,
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid rgba(15,30,51,0.12)",
  font: "inherit",
  background: "var(--card-bg)",
} as const;

export function RevenueShareEditorBody({
  practitionerId,
  practitionerName,
  readOnly = false,
  onDirtyChange,
  data,
  onReload,
  now,
}: EditorProps & {
  data: RevenueShareListView;
  onReload: () => void;
  /** Reloj inyectable (render test); default `new Date()`. */
  now?: Date;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const clock = now ?? new Date();
  const open = openRuleForGiver(data.rules, practitionerId);
  const history = rulesForGiver(data.rules, practitionerId);
  const receivedFrom = openRulesReceivedBy(data.rules, practitionerId);
  const options = receiverOptionsFor(data.receivers, practitionerId, open);

  const [base] = useState(() => revenueShareDraftFrom(open));
  const [draft, setDraft] = useState<RevenueShareDraft>(base);
  const [errors, setErrors] = useState<RevenueShareFormError[]>([]);
  const [serverError, setServerError] = useState<{ text: string; conflict: boolean } | null>(null);
  const [pending, setPending] = useState(false);

  const dirty = isRevenueShareDraftDirty(draft, base);
  const onDirtyRef = useRef(onDirtyChange);
  onDirtyRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyRef.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => onDirtyRef.current?.(false), []);

  const errorOf = (field: RevenueShareFormError["field"]) => errors.find((e) => e.field === field)?.error ?? null;
  const ids = {
    pct: `rs-${practitionerId}-pct`,
    pctErr: `rs-${practitionerId}-pct-err`,
    receiver: `rs-${practitionerId}-receiver`,
    receiverErr: `rs-${practitionerId}-receiver-err`,
    sourcesErr: `rs-${practitionerId}-sources-err`,
  };

  const showServerError = (text: string) => setServerError({ text, conflict: text === REVENUE_SHARE_COPY.conflict });

  const save = async () => {
    setServerError(null);
    const res = revenueShareFormInput(draft, { giverPractitionerId: practitionerId, rules: data.rules });
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    setErrors([]);
    if (open) {
      const ok = await confirm({
        title: "¿Guardar el reparto nuevo?",
        message: "Desde ahora rige la nueva; lo ya cobrado no cambia.",
        confirmLabel: "Guardar desde ahora",
        cancelLabel: "Seguir editando",
      });
      if (!ok) return;
    }
    setPending(true);
    try {
      const r = await setRevenueShare(res.input);
      if (!r.ok) {
        showServerError(r.error);
        return;
      }
      toast.success("Reparto guardado", { description: `${practitionerName}: rige desde ahora.` });
      onDirtyRef.current?.(false);
      onReload();
    } catch {
      showServerError("No pudimos guardar el reparto. Revisá la conexión y reintentá.");
    } finally {
      setPending(false);
    }
  };

  const end = async () => {
    if (!open) return;
    setServerError(null);
    const ok = await confirm({
      title: "¿Dejar de destinar?",
      message: `Desde ahora ${practitionerName} deja de destinarle ${formatSharePct(open.shareBps)} a ${open.receiverName}. Lo ya cobrado no cambia.`,
      confirmLabel: "Dejar de destinar",
      cancelLabel: "Cancelar",
      tone: "danger",
    });
    if (!ok) return;
    setPending(true);
    try {
      const r = await endRevenueShare({ giverPractitionerId: practitionerId, expectedOpenId: open.id });
      if (!r.ok) {
        showServerError(r.error);
        return;
      }
      toast.success("Reparto terminado", { description: `${practitionerName} ya no destina un porcentaje.` });
      onDirtyRef.current?.(false);
      onReload();
    } catch {
      showServerError("No pudimos terminar el reparto. Revisá la conexión y reintentá.");
    } finally {
      setPending(false);
    }
  };

  // Recibe de alguien y no destina: D-CF2-18 no permite cadenas, así que no hay formulario (se explica por qué).
  const blockedByReceiving = !open && receivedFrom.length > 0;
  const noCandidates = options.length === 0;
  const pctErr = errorOf("pct");
  const receiverErr = errorOf("receiver");
  const sourcesErr = errorOf("sources");
  const formErr = errorOf("form");

  return (
    <div data-revenue-share-editor style={{ display: "grid", gap: 14 }}>
      <section aria-labelledby={`rs-${practitionerId}-title`} style={{ display: "grid", gap: 6 }}>
        <EyebrowLabel>
          <span id={`rs-${practitionerId}-title`}>Reparto de {practitionerName}</span>
        </EyebrowLabel>
        <div style={hint}>
          Qué porcentaje de lo que cobra le destina a otro profesional del consultorio, y sobre qué cobros. Rige desde
          el momento en que lo guardás: lo ya cobrado no cambia.
        </div>
        <div data-rs-open style={{ fontSize: 13.5, fontWeight: 600, color: "var(--navy-900)" }}>
          {open ? openRuleSentence(open, clock) : "No destina un porcentaje a nadie."}
        </div>
      </section>

      {!readOnly && blockedByReceiving && (
        <div data-rs-blocked style={hint}>
          {SHARE_GRAPH_ERROR_COPY.giverReceives}
        </div>
      )}
      {!readOnly && !blockedByReceiving && noCandidates && (
        <div data-rs-empty style={hint}>
          No hay otro profesional activo del consultorio que pueda recibir.
        </div>
      )}

      {!readOnly && !blockedByReceiving && !noCandidates && (
        <form
          data-rs-form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          style={box}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 16px", alignItems: "flex-start" }}>
            <div style={{ display: "grid", gap: 4 }}>
              <label htmlFor={ids.pct} style={{ fontSize: 13, fontWeight: 700 }}>
                Porcentaje que destina
              </label>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input
                  id={ids.pct}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={draft.pct}
                  placeholder="20"
                  onChange={(e) => setDraft((d) => ({ ...d, pct: e.target.value }))}
                  disabled={pending}
                  aria-invalid={pctErr ? true : undefined}
                  aria-describedby={pctErr ? ids.pctErr : undefined}
                  style={{ ...control, width: 88 }}
                />
                <span aria-hidden="true">%</span>
              </span>
              {pctErr && (
                <span id={ids.pctErr} style={fieldErr}>
                  {pctErr}
                </span>
              )}
            </div>
            <div style={{ display: "grid", gap: 4, flex: "1 1 220px", minWidth: 0 }}>
              <label htmlFor={ids.receiver} style={{ fontSize: 13, fontWeight: 700 }}>
                Quién recibe
              </label>
              <select
                id={ids.receiver}
                value={draft.receiverId}
                onChange={(e) => setDraft((d) => ({ ...d, receiverId: e.target.value }))}
                disabled={pending}
                aria-invalid={receiverErr ? true : undefined}
                aria-describedby={receiverErr ? ids.receiverErr : undefined}
                style={{ ...control, maxWidth: 360 }}
              >
                <option value="">Elegí un profesional</option>
                {options.map((o) => (
                  <option key={o.practitionerId} value={o.practitionerId}>
                    {o.unavailable ? `${o.name} (ya no puede recibir)` : o.name}
                  </option>
                ))}
              </select>
              {receiverErr && (
                <span id={ids.receiverErr} style={fieldErr}>
                  {receiverErr}
                </span>
              )}
            </div>
          </div>

          <fieldset
            aria-describedby={sourcesErr ? ids.sourcesErr : undefined}
            disabled={pending}
            style={{ border: "none", margin: 0, padding: 0, minWidth: 0, display: "grid", gap: 4 }}
          >
            <legend style={{ fontSize: 13, fontWeight: 700, padding: 0, marginBottom: 4 }}>Sobre qué cobros</legend>
            {REVENUE_SOURCES.map((s) => (
              <label key={s} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, minHeight: 44 }}>
                <input
                  type="checkbox"
                  name={`rs-${practitionerId}-source`}
                  value={s}
                  checked={draft.sources[s]}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setDraft((d) => ({ ...d, sources: { ...d.sources, [s]: on } }));
                  }}
                  style={{ width: 16, height: 16, accentColor: "var(--sky-700)" }}
                />
                <span>{REVENUE_SOURCE_LABEL[s]}</span>
              </label>
            ))}
            {sourcesErr && (
              <span id={ids.sourcesErr} style={fieldErr}>
                {sourcesErr}
              </span>
            )}
          </fieldset>

          {(formErr || serverError) && (
            <div role="alert" style={{ display: "grid", gap: 8, justifyItems: "start" }}>
              <ErrorBox>{serverError?.text ?? formErr}</ErrorBox>
              {serverError?.conflict && (
                <Button variant="ghost" type="button" onClick={onReload}>
                  Recargar el reparto
                </Button>
              )}
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            {/* ZB-12: navy-300 sobre blanco no llegaba a AA en 12 px; navy-400 es el tono de `.k-hint`. */}
            <span role="status" style={{ fontSize: 12, color: dirty ? "var(--warn-fg)" : "var(--navy-400)", fontWeight: dirty ? 600 : 400 }}>
              {dirty ? "Tenés cambios sin guardar" : "Sin cambios"}
            </span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {open && (
                <Button variant="ghost" type="button" onClick={() => void end()} disabled={pending}>
                  Dejar de destinar
                </Button>
              )}
              <Button variant="primary" type="submit" disabled={pending || !dirty}>
                {pending ? "Guardando…" : "Guardar desde ahora"}
              </Button>
            </div>
          </div>
        </form>
      )}

      <section aria-labelledby={`rs-${practitionerId}-received`} style={{ display: "grid", gap: 6 }}>
        <h3 id={`rs-${practitionerId}-received`} style={{ fontSize: 13, fontWeight: 700, margin: 0 }}>
          Recibe de
        </h3>
        {receivedFrom.length === 0 ? (
          <div style={hint}>Nadie le destina un porcentaje.</div>
        ) : (
          <ul data-rs-received style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
            {receivedFrom.map((r) => (
              <li key={r.id} style={{ fontSize: 13 }}>
                {r.giverName} le destina {formatSharePct(r.shareBps)} · {revenueSourcesText(r.sources)} · desde{" "}
                {formatShareInstant(r.effectiveFrom, clock)}
              </li>
            ))}
          </ul>
        )}
      </section>

      {history.length > 0 && (
        <section aria-labelledby={`rs-${practitionerId}-history`} style={{ display: "grid", gap: 6 }}>
          <h3 id={`rs-${practitionerId}-history`} style={{ fontSize: 13, fontWeight: 700, margin: 0 }}>
            Historial
          </h3>
          <ul data-rs-history style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {history.map((r) => (
              <li key={r.id} style={{ fontSize: 13, display: "flex", flexWrap: "wrap", gap: "4px 8px", alignItems: "center" }}>
                <span>
                  {formatSharePct(r.shareBps)} a {r.receiverName} · {revenueSourcesText(r.sources)}
                </span>
                <span className="k-mono" style={{ fontSize: 12, color: "var(--navy-500)" }}>
                  {r.effectiveTo
                    ? `del ${formatShareInstant(r.effectiveFrom, clock)} al ${formatShareInstant(r.effectiveTo, clock)}`
                    : `desde ${formatShareInstant(r.effectiveFrom, clock)}`}
                </span>
                {!r.effectiveTo && <Tag tone="lime">Vigente</Tag>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

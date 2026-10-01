"use client";

/**
 * Configuración → Profesionales → Coberturas (B3.5 CFG-UI-2, B-pre).
 *
 * Qué obras sociales atiende el profesional. Lo consumen el turnero (filtro
 * de cobertura) y `firstFreeAcrossPractitioners` del motor.
 *
 * A diferencia de Servicios (guardado por fila), acá se guarda TODO junto:
 * `setPractitionerPayers` es un reemplazo atómico del set (un id ajeno rechaza
 * todo y no se escribe nada), así que la UI edita una selección local y la
 * manda entera con "Guardar". Dirty-guard: aviso de cambios sin guardar,
 * "Descartar" con `useConfirm` y `beforeunload`; `onDirtyChange` (opcional)
 * le permite al shell de B3.4 frenar el cambio de profesional/pestaña.
 *
 * Particular siempre marcada y deshabilitada: el server la fuerza activa
 * (`lib/practitioner-payers.ts`) — un paciente sin obra social tiene Coverage a
 * Particular y destildarla dejaría al profesional sin poder atenderlo.
 *
 * "Todas"/"Ninguna" actúan sobre lo que se ve: con una búsqueda escrita, solo
 * sobre las filtradas (decisión de B3.5; ver `applyBulk`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { Tag } from "@/components/ui/tag";
import { IconSearch } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { listPractitionerPayers, setPractitionerPayers } from "@/lib/practitioner-payers";
import type { PractitionerPayerRow } from "@/lib/practitioner-config-schemas";
import {
  applyBulk,
  filterPayers,
  initialPayerSelection,
  isPayerSelectionDirty,
  payerIdsForSave,
  togglePayer,
} from "@/lib/practitioner-editors-state";
import { ErrorBox } from "../../controls";

const PARTICULAR_TIP =
  "Particular siempre queda activa: es la cobertura de los pacientes sin obra social.";

export function PayersEditor({
  practitionerId,
  practitionerName,
  onDirtyChange,
}: {
  practitionerId: string;
  practitionerName: string;
  /** Opcional: avisa al shell si hay cambios sin guardar. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<PractitionerPayerRow[] | null>(null);
  const [baseline, setBaseline] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setLoadError(null);
    setSaveError(null);
    setQuery("");
    (async () => {
      try {
        const r = await listPractitionerPayers(practitionerId);
        if (cancelled) return;
        if (!r.ok) {
          setLoadError(r.error);
          return;
        }
        const init = initialPayerSelection(r.data);
        setRows(r.data);
        setBaseline(init);
        setSelected(new Set(init));
      } catch {
        // ForbiddenError (rol sin `schedule.configure`) o red: Next oculta el
        // mensaje en prod, mostramos uno genérico.
        if (!cancelled) setLoadError("No pudimos cargar las coberturas. Reintentá en un momento.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [practitionerId, reloadKey]);

  const dirty = useMemo(
    () => (rows ? isPayerSelectionDirty(rows, baseline, selected) : false),
    [rows, baseline, selected]
  );

  const onDirtyRef = useRef(onDirtyChange);
  onDirtyRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyRef.current?.(dirty);
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const visible = useMemo(() => (rows ? filterPayers(rows, query) : []), [rows, query]);
  const nonParticular = useMemo(() => (rows ?? []).filter((r) => !r.isParticular), [rows]);
  const selectedCount = nonParticular.filter((r) => selected.has(r.insurerId)).length;

  const save = useCallback(async () => {
    if (!rows) return;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await setPractitionerPayers(practitionerId, payerIdsForSave(rows, selected));
      if (!r.ok) {
        setSaveError(r.error);
        return;
      }
      setBaseline(new Set(selected));
      toast.success("Coberturas guardadas", {
        description: `${practitionerName}: ${r.data.active} activas.`,
      });
    } catch {
      setSaveError("No pudimos guardar. Revisá la conexión y reintentá.");
    } finally {
      setSaving(false);
    }
  }, [rows, selected, practitionerId, practitionerName, toast]);

  const discard = useCallback(async () => {
    const ok = await confirm({
      title: "¿Descartar los cambios?",
      message: "Las coberturas vuelven a como estaban guardadas.",
      confirmLabel: "Descartar",
      tone: "danger",
    });
    if (ok) {
      setSelected(new Set(baseline));
      setSaveError(null);
    }
  }, [confirm, baseline]);

  const headerId = `ppe-${practitionerId}-title`;

  return (
    <Card style={{ padding: 0, overflow: "hidden" }} className="ppe">
      <style>{PPE_CSS}</style>
      <header style={{ padding: "16px 20px", borderBottom: "1px solid rgba(15,30,51,0.06)" }}>
        <EyebrowLabel>
          <span id={headerId}>Coberturas que atiende</span>
        </EyebrowLabel>
        <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 4 }}>
          Las obras sociales con las que {practitionerName} toma turnos. Las que agregues después en
          Obras sociales quedan activas para todos hasta que las desmarques acá.
        </div>
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
          Cargando coberturas…
        </div>
      ) : (
        <div style={{ padding: "14px 20px 18px", display: "grid", gap: 12 }}>
          {nonParticular.length > 0 && (
            <div className="ppe-toolbar">
              <label className="ppe-search">
                <span className="ppe-sr">Buscar obra social</span>
                <IconSearch size={14} />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar obra social"
                  disabled={saving}
                />
              </label>
              <div style={{ display: "flex", gap: 6 }}>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={saving}
                  onClick={() => setSelected((s) => applyBulk(s, visible, "all"))}
                  style={{ padding: "7px 12px", fontSize: 12.5 }}
                >
                  {query.trim() ? "Marcar filtradas" : "Todas"}
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={saving}
                  onClick={() => setSelected((s) => applyBulk(s, visible, "none"))}
                  style={{ padding: "7px 12px", fontSize: 12.5 }}
                >
                  {query.trim() ? "Desmarcar filtradas" : "Ninguna"}
                </Button>
              </div>
              <span aria-live="polite" style={{ fontSize: 12, color: "var(--navy-500)" }}>
                {selectedCount} de {nonParticular.length} obras sociales + Particular
              </span>
            </div>
          )}

          {nonParticular.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--navy-500)" }}>
              Todavía no cargaste obras sociales: por ahora atiende solo particulares. Agregalas en la
              pestaña Obras sociales.
            </div>
          )}

          {visible.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--navy-500)", padding: "8px 0" }}>
              Ninguna obra social coincide con «{query.trim()}».
            </div>
          ) : (
            <fieldset className="ppe-list" aria-labelledby={headerId} disabled={saving}>
              {visible.map((r) => {
                const checked = r.isParticular || selected.has(r.insurerId);
                const tipId = r.isParticular ? `ppe-${r.insurerId}-tip` : undefined;
                return (
                  <label
                    key={r.insurerId}
                    className="ppe-item"
                    data-checked={checked || undefined}
                    data-locked={r.isParticular || undefined}
                    title={r.isParticular ? PARTICULAR_TIP : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={r.isParticular}
                      aria-describedby={tipId}
                      onChange={() => setSelected((s) => togglePayer(s, r))}
                    />
                    <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{r.name}</span>
                    {r.isParticular && (
                      <>
                        <Tag tone="soft">Siempre</Tag>
                        <span id={tipId} className="ppe-sr">
                          {PARTICULAR_TIP}
                        </span>
                      </>
                    )}
                    {!r.insurerActive && !r.isParticular && <Tag tone="soft">Inactiva en el consultorio</Tag>}
                  </label>
                );
              })}
            </fieldset>
          )}

          {saveError && (
            <div role="alert">
              <ErrorBox>{saveError}</ErrorBox>
            </div>
          )}

          <div className="ppe-actions">
            <span role="status" style={{ fontSize: 12, color: dirty ? "#9A5B00" : "var(--navy-300)", fontWeight: dirty ? 600 : 400 }}>
              {dirty ? "Tenés cambios sin guardar" : "Sin cambios"}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              {dirty && (
                <Button variant="ghost" type="button" onClick={discard} disabled={saving}>
                  Descartar
                </Button>
              )}
              <Button variant="primary" type="button" onClick={save} disabled={!dirty || saving}>
                {saving ? "Guardando…" : "Guardar coberturas"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

const PPE_CSS = `
.ppe .ppe-sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}
.ppe .ppe-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ppe .ppe-search {
  display: inline-flex; align-items: center; gap: 8px; flex: 1 1 220px; max-width: 360px;
  padding: 7px 10px; border-radius: 10px; background: rgba(255,255,255,0.96);
  border: 1px solid rgba(15,30,51,0.12); color: var(--navy-500);
}
.ppe .ppe-search input {
  border: none; outline: none; background: transparent; font-size: 13px; color: var(--navy-900);
  width: 100%; min-width: 0;
}
.ppe .ppe-search:focus-within { outline: 2px solid var(--sky-700); outline-offset: 2px; }
.ppe .ppe-list {
  border: none; margin: 0; padding: 0; min-width: 0;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 6px;
}
.ppe .ppe-item {
  display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 10px;
  border: 1px solid rgba(15,30,51,0.08); font-size: 13px; color: var(--navy-900); cursor: pointer;
}
.ppe .ppe-item[data-checked] { background: rgba(31,79,190,0.05); border-color: rgba(31,79,190,0.2); }
.ppe .ppe-item[data-locked] { cursor: help; }
.ppe .ppe-item input { width: 16px; height: 16px; flex-shrink: 0; accent-color: var(--sky-700); }
.ppe .ppe-item:focus-within { outline: 2px solid var(--sky-700); outline-offset: 1px; }
.ppe .ppe-actions {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
  padding-top: 6px; border-top: 1px solid rgba(15,30,51,0.06);
}
.ppe button:focus-visible { outline: 2px solid var(--sky-700); outline-offset: 2px; }
@media (max-width: 639px) {
  .ppe .ppe-list { grid-template-columns: 1fr; }
  .ppe .ppe-search { max-width: none; flex-basis: 100%; }
  .ppe .ppe-actions > div { width: 100%; }
  .ppe .ppe-actions > div > button { flex: 1; justify-content: center; }
}
`;

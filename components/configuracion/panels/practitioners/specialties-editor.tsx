"use client";

/**
 * Configuración → Profesionales → Especialidades (DIR-3c, C-DIR9; DIR-D19).
 *
 * Hasta 5 especialidades del catálogo global por profesional. Hoy las lee solo el directorio público (el perfil
 * muestra la unión de sus consultorios y `/profesionales` filtra por ellas); el turnero sigue usando el texto libre de
 * `Practitioner.specialty`. Escribe `setPractitionerSpecialties` (`lib/directory-settings.ts`: `tenant.admin` o el
 * propio, catálogo vigente, ≤ 5; la barrera es la action).
 *
 * Como Coberturas: se edita una selección local y se guarda entera («Guardar especialidades»), con aviso de cambios
 * sin guardar, «Descartar» con `useConfirm`, `beforeunload` y `onDirtyChange` para que el shell frene el cambio de
 * profesional o de pestaña. El catálogo llega por props desde el loader de `/configuracion` (misma tx de PF2): sin
 * fetch al abrir. Después de guardar, la action revalida `/configuracion` y el árbol nuevo trae lo guardado.
 *
 * Soporte: solo lectura (DIR-D9; la action no está en la allowlist de soporte y su sesión no escribe ahí).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { Tag } from "@/components/ui/tag";
import { TagCombobox } from "@/components/ui/tag-combobox";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { setPractitionerSpecialties } from "@/lib/directory-settings";
import { MAX_PRACTITIONER_SPECIALTIES } from "@/lib/directory-constants";
import { ErrorBox } from "../../controls";

/** Puro: misma selección sin importar el orden (el server reemplaza el set). */
export function sameSpecialtySet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

/** Puro: agrega respetando el tope (lo que pase de 5 se descarta; el server igual lo rechazaría). */
export function capSpecialties(next: readonly string[], max = MAX_PRACTITIONER_SPECIALTIES): string[] {
  return [...new Set(next)].slice(0, max);
}

export function SpecialtiesEditor({
  practitionerId,
  practitionerName,
  catalog,
  initial,
  readOnly = false,
  onDirtyChange,
}: {
  practitionerId: string;
  practitionerName: string;
  /** Catálogo vigente (sin archivadas), ordenado por nombre. */
  catalog: ReadonlyArray<{ id: string; name: string }>;
  /** Ids guardados hoy. */
  initial: readonly string[];
  /** Soporte: ve, no edita. */
  readOnly?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [baseline, setBaseline] = useState<string[]>(() => [...initial]);
  const [selected, setSelected] = useState<string[]>(() => [...initial]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Cuando llega el árbol nuevo (la action revalida) manda el server, salvo que haya cambios sin guardar.
  const initialKey = [...initial].sort().join(",");
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (dirtyRef.current) return;
    setBaseline([...initial]);
    setSelected([...initial]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]);

  const dirty = !sameSpecialtySet(baseline, selected);
  dirtyRef.current = dirty;

  const onDirtyRef = useRef(onDirtyChange);
  onDirtyRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyRef.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => onDirtyRef.current?.(false), []);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const options = useMemo(() => catalog.map((c) => ({ slug: c.id, label: c.name })), [catalog]);
  const nameOf = useMemo(() => new Map(catalog.map((c) => [c.id, c.name])), [catalog]);
  // Una asignada que ya no está en el catálogo vigente (archivada) no llega en `initial` (el loader la filtra).
  const selectedNames = selected.map((id) => nameOf.get(id)).filter((n): n is string => !!n);

  // Con el tope alcanzado el combobox no ofrece más (sus sugerencias quedan en las elegidas, que necesita para rotular
  // los chips).
  const atMax = selected.length >= MAX_PRACTITIONER_SPECIALTIES;

  const onChange = (next: string[]) => {
    setError(null);
    setSelected(capSpecialties(next));
  };

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await setPractitionerSpecialties(practitionerId, selected);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setBaseline([...r.data.specialtyIds]);
      setSelected([...r.data.specialtyIds]);
      toast.success("Especialidades guardadas", { description: practitionerName });
    } catch {
      setError("No pudimos guardar. Revisá la conexión y reintentá.");
    } finally {
      setSaving(false);
    }
  }, [practitionerId, practitionerName, selected, toast]);

  const discard = useCallback(async () => {
    const ok = await confirm({
      title: "¿Descartar los cambios?",
      message: "Las especialidades vuelven a como estaban guardadas.",
      confirmLabel: "Descartar",
      tone: "danger",
    });
    if (ok) {
      setSelected([...baseline]);
      setError(null);
    }
  }, [confirm, baseline]);

  const titleId = `spe-${practitionerId}-title`;
  const hintId = `spe-${practitionerId}-hint`;

  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <header style={{ padding: "16px 20px", borderBottom: "1px solid rgba(15,30,51,0.06)" }}>
        <EyebrowLabel>
          <span id={titleId}>Especialidades</span>
        </EyebrowLabel>
        <div id={hintId} style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 4, lineHeight: 1.45 }}>
          Hasta {MAX_PRACTITIONER_SPECIALTIES} especialidades de {practitionerName}. Se muestran en el directorio
          público y sirven para que los pacientes lo encuentren al filtrar.
        </div>
      </header>

      <div style={{ padding: "14px 20px 18px", display: "grid", gap: 12 }}>
        {catalog.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--navy-500)" }}>
            Todavía no hay especialidades cargadas en el catálogo. Escribinos desde Soporte si te falta alguna.
          </div>
        ) : readOnly ? (
          <div role="group" aria-labelledby={titleId} style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {selectedNames.length === 0 ? (
              <span style={{ fontSize: 13, color: "var(--navy-500)" }}>Sin especialidades cargadas.</span>
            ) : (
              selectedNames.map((n) => (
                <Tag key={n} tone="sky">
                  {n}
                </Tag>
              ))
            )}
          </div>
        ) : (
          <div role="group" aria-labelledby={titleId} aria-describedby={hintId} data-saving={saving || undefined}>
            <TagCombobox
              suggestions={atMax ? options.filter((o) => selected.includes(o.slug)) : options}
              value={selected}
              onChange={onChange}
              placeholder="Buscá una especialidad"
            />
          </div>
        )}

        {!readOnly && (
          <span aria-live="polite" style={{ fontSize: 12, color: atMax ? "var(--warn-fg)" : "var(--navy-500)" }}>
            {atMax
              ? `Llegaste al máximo (${MAX_PRACTITIONER_SPECIALTIES}). Sacá una para sumar otra.`
              : `${selected.length} de ${MAX_PRACTITIONER_SPECIALTIES}`}
          </span>
        )}

        {readOnly && (
          <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
            Soporte puede ver las especialidades, pero no cambiarlas.
          </div>
        )}

        {error && (
          <div role="alert">
            <ErrorBox>{error}</ErrorBox>
          </div>
        )}

        {!readOnly && catalog.length > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              flexWrap: "wrap",
              paddingTop: 6,
              borderTop: "1px solid rgba(15,30,51,0.06)",
            }}
          >
            <span
              role="status"
              style={{ fontSize: 12, color: dirty ? "var(--warn-fg)" : "var(--navy-300)", fontWeight: dirty ? 600 : 400 }}
            >
              {dirty ? "Tenés cambios sin guardar" : "Sin cambios"}
            </span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {dirty && (
                <Button variant="ghost" type="button" onClick={discard} disabled={saving}>
                  Descartar
                </Button>
              )}
              <Button variant="primary" type="button" onClick={save} disabled={!dirty || saving}>
                {saving ? "Guardando…" : "Guardar especialidades"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

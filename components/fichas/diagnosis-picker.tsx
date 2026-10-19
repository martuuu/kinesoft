"use client";

/**
 * [FC-3b] `DiagnosisPicker` · selector DIFERIDO de diagnósticos (brief T4 §24.7 «Diagnósticos (FC-3b)», §24.9).
 *
 * Nunca entra al first load de `/pacientes/[id]`: lo carga `DiagnosisField` con `next/dynamic` (`ssr:false`) recién
 * cuando el profesional enfoca o escribe en el campo (lo frena `hc-first-load-guard.test.ts`). Todo lo que decide qué
 * se ve y qué hace cada tecla está en `diagnosis-picker-logic.ts` (puro, con unit test); acá solo se pinta y se habla
 * con el server.
 *
 * Combobox WAI-ARIA 1.2 «list autocomplete» con `aria-activedescendant` (mismo patrón que `PatientPicker`, S18s): el
 * foco queda en el input; ↑/↓ recorren (con vuelta), Enter elige la activa, Escape cierra (y no cierra el Drawer que
 * lo contiene), Tab cierra. El mouse elige con `mousedown` para no perder el blur antes del click.
 *
 * Grupos en orden fijo: Favoritos · Recientes · Del consultorio · Kinesiología (solo con el módulo, lo decide el
 * server) · CIE-11; al final «Crear "{texto}" como diagnóstico propio» y «Usar "{texto}" como texto libre».
 *
 * Licencia CIE-11 (CC BY-ND 3.0 IGO, §24.2 hallazgo 1): la atribución «CIE-11 © OMS · CC BY-ND 3.0 IGO» va FUERA del
 * listbox (si estuviera adentro, el lector de pantalla la anunciaría como una opción más y las flechas pararían ahí);
 * los títulos oficiales NUNCA se acortan (ni `text-overflow`, ni `line-clamp`): hacen wrap, porque acortar un título de
 * la OMS es modificarlo. Con el catálogo sin importar se dice (`DIAGNOSIS_COPY.catalogEmpty`) en vez de mostrar
 * «sin resultados» como si la CIE-11 no tuviera la lumbalgia.
 *
 * La ★ de cada fila es solo para el mouse (`tabIndex=-1`: un botón adentro de una opción no es navegable en un
 * listbox); con teclado la ★ está en el chip del campo. El favorito CIE-11 RETIRADO es la excepción: como no se puede
 * elegir ni llegar al chip, la opción misma dice «Código no vigente · Sacar de favoritos» y Enter le saca la ★.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createTenantDiagnosis, getDiagnosisPickerHome, searchDiagnoses } from "@/lib/diagnoses";
import {
  DIAGNOSIS_COPY,
  DIAGNOSIS_TEXT_MAX,
  ICD11_SHORT_ATTRIBUTION,
  type DiagnosisOption,
  type DiagnosisPickerHome,
  type DiagnosisSearchResult,
} from "@/lib/diagnoses-types";
import { DIAGNOSIS_FIELD_COPY as COPY } from "@/components/fichas/fichas-copy";
import {
  blurClosesPicker,
  buildPickerModel,
  nextActiveIndex,
  resultMatches,
  type PickerItem,
} from "@/components/fichas/diagnosis-picker-logic";
import { parseDiagnosisQuery } from "@/lib/diagnoses-logic";

/** handoff ZF4: `DIAGNOSIS_FIELD_COPY.favorite` («Favorito»). El integrador saca el fallback. */
const FAVORITE_LABEL = (COPY as typeof COPY & { favorite?: string }).favorite ?? "Favorito";

/**
 * Targets táctiles (revisión b): con `pointer: coarse` las filas y la ★ van a 44 px. Es un `<style>` y no un CSS
 * module porque el picker es un chunk diferido sin CSS propio: un archivo de estilos sumaría otro pedido al abrirlo.
 */
const PICKER_CSS = `@media (pointer: coarse) { .k-dxp-row { min-height: 44px; align-items: center !important; } .k-dxp-star { min-width: 44px; min-height: 44px; } }`;

/** Espera entre teclas antes de pedirle al server (mismo valor que `PatientPicker`). */
const SEARCH_DEBOUNCE_MS = 200;

export type DiagnosisPickerProps = {
  /** id del input (el campo lo usa para devolverle el foco). */
  id: string;
  /** Lo ya elegido: no se vuelve a ofrecer. */
  selected: readonly DiagnosisOption[];
  /** Portada (favoritos/recientes). undefined = se pide al abrir; null = no hay (sin acceso clínico). */
  home: DiagnosisPickerHome | null | undefined;
  onHomeLoaded: (home: DiagnosisPickerHome | null) => void;
  /** ★ cambiadas en esta sesión del campo (las maneja el campo: la ★ del chip y la de la fila son la misma). */
  favoriteOverrides?: ReadonlyMap<string, boolean>;
  onPick: (option: DiagnosisOption) => void;
  onToggleFavorite: (option: DiagnosisOption) => void;
  /** Lo que se tipeó en el input estático antes de que llegara este chunk (no se pierde). */
  initialText?: string;
  /** Se llama al montar: recién ahí el campo esconde su input estático y le pasa el foco a este (sin parpadeo). */
  onReady?: () => void;
  autoFocus?: boolean;
  disabled?: boolean;
  ariaLabel: string;
  /** Solo tests (render estático, sin efectos): arranca abierto con este resultado. */
  initialOpen?: boolean;
  initialResult?: DiagnosisSearchResult | null;
};

/** Estilo de una fila del listbox (exportado para el test: la activa no se puede fijar en un render estático). */
export function pickerRowStyle(isActive: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    padding: "8px 10px",
    borderRadius: 8,
    cursor: "pointer",
    fontSize: 13,
    color: "var(--navy-900)",
    // Activa con fondo y filete (antes un gris al 6 %, que no se distinguía): el foco real sigue en el input.
    background: isActive ? "var(--sky-100)" : "transparent",
    boxShadow: isActive ? "inset 2px 0 0 var(--sky-700)" : undefined,
  };
}

export function DiagnosisPicker({
  id,
  selected,
  home,
  onHomeLoaded,
  favoriteOverrides,
  onPick,
  onToggleFavorite,
  initialText = "",
  onReady,
  autoFocus,
  disabled,
  ariaLabel,
  initialOpen,
  initialResult = null,
}: DiagnosisPickerProps) {
  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-opt-${i}`;
  const [text, setText] = useState(initialText);
  const [open, setOpen] = useState(initialOpen ?? (autoFocus === true));
  const [active, setActive] = useState(-1);
  const [result, setResult] = useState<DiagnosisSearchResult | null>(initialResult);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const homeRequested = useRef(false);

  const model = useMemo(
    () => buildPickerModel({ text, home, result, selected, favoriteOverrides }),
    [text, home, result, selected, favoriteOverrides]
  );
  const flat = model.flat;
  const activeItem = active >= 0 ? flat[active] : undefined;

  useEffect(() => {
    onReady?.();
    // Solo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // El input estático tenía el foco y el cursor al final: se los devolvemos al montar.
  useEffect(() => {
    if (!autoFocus || !inputRef.current) return;
    const el = inputRef.current;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);

  // Portada: una sola vez por montaje, al abrir.
  useEffect(() => {
    if (!open || home !== undefined || homeRequested.current) return;
    homeRequested.current = true;
    getDiagnosisPickerHome()
      .then((h) => onHomeLoaded(h))
      .catch(() => onHomeLoaded(null));
  }, [open, home, onHomeLoaded]);

  // Búsqueda con debounce; `seq` descarta las respuestas viejas (y el modelo además compara `result.query`).
  useEffect(() => {
    if (!open || !parseDiagnosisQuery(text) || resultMatches(result, text)) return;
    const seq = ++seqRef.current;
    const q = text;
    const t = setTimeout(async () => {
      try {
        const r = await searchDiagnoses({ q });
        if (seq !== seqRef.current) return;
        // null = sin acceso clínico (no debería llegar a abrirse): se muestra como «sin resultados».
        setResult(r ?? { query: q, groups: [], canCreateOwn: false, icdCatalogLoaded: true });
      } catch {
        if (seq === seqRef.current) setResult({ query: q, groups: [], canCreateOwn: false, icdCatalogLoaded: true });
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // `result` NO va en las deps: cambiarlo no tiene que relanzar la búsqueda.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // La lista cambió (llegó la respuesta, se eligió algo): la activa se reinicia para no apuntar a otra fila.
  useEffect(() => setActive(-1), [flat.length, text]);

  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  const activate = async (item: PickerItem) => {
    setError(null);
    if (item.type === "option") {
      if (item.action === "unfavorite") return onToggleFavorite(item.option);
      onPick(item.option);
    } else if (item.type === "text") {
      onPick({ ref: { kind: "text", text: item.text }, source: "text", code: null, title: item.text, retired: false, favorite: false });
    } else {
      if (creating) return;
      setCreating(true);
      try {
        const r = await createTenantDiagnosis({ title: item.text });
        if (!r.ok) return setError(r.error);
        onPick(r.data.option);
      } finally {
        setCreating(false);
      }
    }
    setText("");
    setResult(null);
    close();
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) setOpen(true);
      setActive((i) => nextActiveIndex(i, e.key as "ArrowDown" | "ArrowUp", flat.length));
    } else if (e.key === "Enter") {
      // Dentro del formulario de la ficha, Enter nunca lo manda desde acá (Ctrl/⌘+Enter es «Guardar ficha»).
      if (e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      if (open && activeItem) void activate(activeItem);
    } else if (e.key === "Escape") {
      if (open) {
        // Que el Escape cierre la lista y no el Drawer que contiene el formulario.
        e.stopPropagation();
        close();
      } else if (text) {
        e.stopPropagation();
        setText("");
      }
    } else if (e.key === "Tab") {
      close();
    }
  };

  const statusText =
    model.status === "searching" ? COPY.searching : model.status === "no-results" ? COPY.noResults : model.status === "hint" ? COPY.hint : null;
  const listOpen = open && !disabled;

  let idx = -1;
  const renderItem = (item: PickerItem) => {
    const i = ++idx;
    const isActive = i === active;
    const base = pickerRowStyle(isActive);
    const common = {
      id: optionId(i),
      role: "option" as const,
      "aria-selected": isActive,
      onMouseEnter: () => setActive(i),
      onMouseDown: (e: ReactMouseEvent) => {
        e.preventDefault();
        void activate(item);
      },
    };
    if (item.type !== "option") {
      const label = item.type === "create" ? COPY.createOwn(item.text) : COPY.asFreeText(item.text);
      return (
        <div key={item.key} {...common} className="k-dxp-row" aria-disabled={item.type === "create" && creating ? true : undefined} data-picker-action={item.type} style={{ ...base, fontWeight: 600, color: "var(--sky-700)" }}>
          <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{item.type === "create" && creating ? COPY.creating : label}</span>
        </div>
      );
    }
    const o = item.option;
    const retired = item.action === "unfavorite";
    return (
      <div key={item.key} {...common} className="k-dxp-row" data-option-key={item.key} style={base}>
        <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", lineHeight: 1.35, color: retired ? "var(--navy-500)" : undefined }}>
          {o.code ? <strong className="k-mono" style={{ marginRight: 6 }}>{o.code}</strong> : null}
          {o.title}
          {retired ? (
            <span style={{ display: "block", fontSize: 12, color: "var(--navy-500)" }}>
              {COPY.retiredChip} · {COPY.favoriteOff}
            </span>
          ) : null}
        </span>
        {!retired && (
          <button
            type="button"
            tabIndex={-1}
            className="k-dxp-star"
            // Fuera del árbol accesible: un botón adentro de una opción la vuelve «opción con hijos interactivos» y
            // el lector la lee rara; con teclado la ★ está en el chip. Nombre fijo + aria-pressed igual, por si un
            // lector ignora el aria-hidden.
            aria-hidden="true"
            aria-label={`${FAVORITE_LABEL}: ${o.title}`}
            aria-pressed={o.favorite}
            title={o.favorite ? COPY.favoriteOff : COPY.favoriteOn}
            onMouseDown={(e) => {
              // Que el click en la ★ no elija la fila ni le saque el foco al input.
              e.preventDefault();
              e.stopPropagation();
              onToggleFavorite(o);
            }}
            style={{ border: 0, background: "transparent", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: 2, color: o.favorite ? "var(--lime-700)" : "var(--navy-300)" }}
          >
            {o.favorite ? "★" : "☆"}
          </button>
        )}
      </div>
    );
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "grid", gap: 6 }}>
      <style dangerouslySetInnerHTML={{ __html: PICKER_CSS }} />
      {/* Estado de la búsqueda: región siempre montada (la del popup aparecía y desaparecía con él y no se anunciaba). */}
      <div role="status" className="k-sr-only" data-testid="diagnosis-picker-live">
        {listOpen ? statusText ?? "" : ""}
      </div>
      <input
        ref={inputRef}
        id={id}
        className="k-input"
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={listOpen}
        aria-controls={listId}
        aria-activedescendant={listOpen && activeItem ? optionId(active) : undefined}
        value={text}
        maxLength={DIAGNOSIS_TEXT_MAX}
        placeholder={COPY.searchPlaceholder}
        disabled={disabled}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          if (error) setError(null);
        }}
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          if (blurClosesPicker(wrapRef.current, e.relatedTarget as Node | null)) close();
        }}
        onKeyDown={onKeyDown}
        style={{ width: "100%", minWidth: 0 }}
      />
      {listOpen && (
        <div
          className="k-glass-strong"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            marginTop: 4,
            zIndex: 30,
            borderRadius: 12,
            padding: 4,
            background: "rgba(255,255,255,0.98)",
            boxShadow: "0 10px 32px rgba(15,30,51,0.18)",
            display: "grid",
            gap: 4,
          }}
          data-testid="diagnosis-picker-popup"
        >
          <div id={listId} role="listbox" aria-label={ariaLabel} className="k-scroll" style={{ maxHeight: 320, overflowY: "auto" }}>
            {model.groups.map((g) => (
              <div key={g.id} role="group" aria-labelledby={`${id}-grp-${g.id}`} data-group={g.id}>
                <div
                  id={`${id}-grp-${g.id}`}
                  role="presentation"
                  style={{ padding: "6px 10px 2px", fontSize: 11, fontWeight: 700, color: "var(--navy-500)", textTransform: "uppercase", letterSpacing: 0.4 }}
                >
                  {g.label}
                </div>
                {g.items.map(renderItem)}
              </div>
            ))}
            {model.footer.length > 0 && (
              <div role="group" aria-label={COPY.add} data-group="footer" style={{ borderTop: model.groups.length ? "1px solid rgba(15,30,51,0.08)" : undefined, marginTop: model.groups.length ? 4 : 0, paddingTop: model.groups.length ? 4 : 0 }}>
                {model.footer.map(renderItem)}
              </div>
            )}
          </div>
          {/* Fuera del listbox a propósito (ver cabecera): estado, error, catálogo vacío y la atribución de la OMS. */}
          {statusText && (
            <div aria-hidden="true" style={{ padding: "4px 10px", fontSize: 12, color: "var(--navy-500)" }}>
              {statusText}
            </div>
          )}
          {error && (
            <div role="alert" style={{ padding: "4px 10px", fontSize: 12, color: "var(--danger-fg)" }}>
              {error}
            </div>
          )}
          {model.icdCatalogLoaded === false ? (
            <p data-testid="icd-catalog-empty" style={{ margin: 0, padding: "4px 10px 6px", fontSize: 12, color: "var(--navy-500)" }}>
              {DIAGNOSIS_COPY.catalogEmpty}
            </p>
          ) : (
            <p data-testid="icd-attribution" style={{ margin: 0, padding: "4px 10px 6px", fontSize: 11, color: "var(--navy-500)" }}>
              {ICD11_SHORT_ATTRIBUTION}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

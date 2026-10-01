"use client";

import { IconStar } from "@/components/ui/icons";
import { PractitionerBadge } from "./grid/practitioner-badge";

/**
 * Selector multi-profesional de la agenda (B4.2, plan §11.3 punto 1: "chips
 * todos / mis favoritos / uno" + punto 2: "filtro por profesional con conteo").
 *
 * Contrato (presentacional y controlado; lo cablea `agenda-client` en B4.3):
 * - `practitioners`: en el orden a mostrar (favoritos primero: el caller usa
 *   `practitionerOrder`). `count` = turnos del día/semana a la vista.
 * - `selectedIds`: VACÍO = "Todos" (así un profesional nuevo aparece sin tocar
 *   nada). Ids que no están en `practitioners` se ignoran.
 * - `onChange(ids)`: nueva selección; `[]` = todos.
 * - `favoriteIds` + `onToggleFavorite(id)`: la estrella de cada chip; sin
 *   `onToggleFavorite` no se dibuja la estrella (solo lectura).
 *
 * Reglas de selección (`nextSelection`, pura y testeable):
 * - Click en un chip con "Todos" activo → queda solo ese.
 * - Click en un chip suelto → lo suma o lo saca (multi-select).
 * - Si se saca el último, o quedan todos marcados → vuelve a "Todos".
 * - "Favoritos" selecciona exactamente los favoritos (deshabilitado sin favoritos).
 *
 * Identidad no cromática: iniciales (`PractitionerBadge`), nunca un color por
 * profesional (AGENTS §5). Activo = badge relleno navy + borde, y
 * `aria-pressed` para lectores de pantalla.
 */
export type PractitionerChip = { id: string; name: string; initials: string; count: number };

export function nextSelection(
  allIds: ReadonlyArray<string>,
  selectedIds: ReadonlyArray<string>,
  clickedId: string
): string[] {
  const valid = selectedIds.filter((id) => allIds.includes(id));
  if (valid.length === 0) return allIds.length <= 1 ? [] : [clickedId];
  const next = valid.includes(clickedId) ? valid.filter((id) => id !== clickedId) : [...valid, clickedId];
  if (next.length === 0 || next.length === allIds.length) return [];
  // Orden estable = el de la lista (columnas en el mismo orden que los chips).
  return allIds.filter((id) => next.includes(id));
}

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((x) => b.includes(x));

export function PractitionerChips({
  practitioners,
  selectedIds,
  onChange,
  favoriteIds = [],
  onToggleFavorite,
}: {
  practitioners: ReadonlyArray<PractitionerChip>;
  selectedIds: ReadonlyArray<string>;
  onChange: (ids: string[]) => void;
  favoriteIds?: ReadonlyArray<string>;
  onToggleFavorite?: (practitionerId: string) => void;
}) {
  const allIds = practitioners.map((p) => p.id);
  const selected = selectedIds.filter((id) => allIds.includes(id));
  const all = selected.length === 0;
  const favs = favoriteIds.filter((id) => allIds.includes(id));
  const favsActive = favs.length > 0 && sameSet(favs, selected);
  const total = practitioners.reduce((n, p) => n + p.count, 0);
  const favTotal = practitioners.filter((p) => favs.includes(p.id)).reduce((n, p) => n + p.count, 0);

  return (
    <div
      role="group"
      aria-label="Profesionales a mostrar"
      style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
    >
      <button
        type="button"
        aria-pressed={all}
        aria-label={`Todos los profesionales, ${total} ${total === 1 ? "turno" : "turnos"}`}
        onClick={() => onChange([])}
        style={chipStyle(all)}
      >
        Todos <Count n={total} active={all} />
      </button>
      <button
        type="button"
        aria-pressed={favsActive}
        aria-label={favs.length > 0 ? `Mis favoritos, ${favTotal} ${favTotal === 1 ? "turno" : "turnos"}` : "Mis favoritos (no marcaste ninguno)"}
        disabled={favs.length === 0}
        title={favs.length === 0 ? "Marcá profesionales con la estrella para armar tus favoritos" : undefined}
        onClick={() => onChange(favs.length === allIds.length ? [] : allIds.filter((id) => favs.includes(id)))}
        style={{ ...chipStyle(favsActive), opacity: favs.length === 0 ? 0.5 : 1, cursor: favs.length === 0 ? "default" : "pointer" }}
      >
        <IconStar size={12} fill={favsActive ? "currentColor" : "none"} /> Favoritos{" "}
        {favs.length > 0 && <Count n={favTotal} active={favsActive} />}
      </button>

      <span aria-hidden style={{ width: 1, height: 20, background: "rgba(15,30,51,0.12)", margin: "0 2px" }} />

      {practitioners.map((p) => {
        const on = !all && selected.includes(p.id);
        const fav = favoriteIds.includes(p.id);
        return (
          <span
            key={p.id}
            data-chip={p.id}
            style={{
              ...chipStyle(on),
              padding: 0,
              gap: 0,
              overflow: "hidden",
            }}
          >
            <button
              type="button"
              aria-pressed={on}
              aria-label={`${p.name}, ${p.count} ${p.count === 1 ? "turno" : "turnos"}`}
              title={p.name}
              onClick={() => onChange(nextSelection(allIds, selectedIds, p.id))}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                height: "100%",
                padding: onToggleFavorite ? "0 4px 0 4px" : "0 10px 0 4px",
                border: "none",
                background: "transparent",
                color: "inherit",
                font: "inherit",
                cursor: "pointer",
                maxWidth: 200,
              }}
            >
              <PractitionerBadge initials={p.initials} name={p.name} size={22} selected={on} decorative />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
              <Count n={p.count} active={on} />
            </button>
            {onToggleFavorite && (
              <button
                type="button"
                aria-pressed={fav}
                aria-label={fav ? `Quitar a ${p.name} de favoritos` : `Marcar a ${p.name} como favorito`}
                title={fav ? "Quitar de favoritos" : "Marcar como favorito"}
                onClick={() => onToggleFavorite(p.id)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 26,
                  height: "100%",
                  border: "none",
                  background: "transparent",
                  // Sobre el chip activo (fondo navy) la estrella va en blanco.
                  color: on ? (fav ? "#fff" : "rgba(255,255,255,0.5)") : fav ? "var(--navy-900)" : "var(--navy-200)",
                  cursor: "pointer",
                  paddingRight: 4,
                }}
              >
                <IconStar size={13} fill={fav ? "currentColor" : "none"} />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

function Count({ n, active }: { n: number; active: boolean }) {
  return (
    <span
      className="k-mono"
      aria-hidden
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        minWidth: 18,
        textAlign: "center",
        borderRadius: 999,
        padding: "0 5px",
        background: active ? "rgba(255,255,255,0.18)" : "rgba(15,30,51,0.06)",
        color: active ? "#fff" : "var(--navy-500)",
      }}
    >
      {n}
    </span>
  );
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 32,
    padding: "0 12px",
    borderRadius: 999,
    fontSize: 12.5,
    fontWeight: 600,
    border: `1px solid ${active ? "var(--navy-900)" : "rgba(15,30,51,0.12)"}`,
    background: active ? "var(--navy-900)" : "rgba(255,255,255,0.7)",
    color: active ? "#fff" : "var(--navy-700)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

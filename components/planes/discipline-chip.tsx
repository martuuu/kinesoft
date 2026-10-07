import type { CSSProperties } from "react";
import type { Discipline } from "@/lib/plans-constants";
import { disciplineColorVar, disciplineLabel, disciplineShortLabel, planChip } from "@/lib/plan-display";

/**
 * Chip de disciplina / de sesión de plan (P3-C, ES3 · V1-D18 de C13b).
 *
 * Dos usos, un solo componente (lo consumen la agenda S19a/S19e, Recepción,
 * el drawer S19c, la PlanCard S22a, el hero S22h y `/planes` S21):
 *   - **Sesión de plan** (`ordinal` + `totalLive`): `Kine · 3/10`; legacy sin
 *     disciplina → `Plan · 2/8`. Lectores de pantalla: "Sesión 3 de 10 ·
 *     Kinesiología" (`planChip`, que también usan ICS y recordatorio).
 *   - **Solo disciplina** (sin contador): `Kine` / `Kinesiología`
 *     (`label="long"`); sin disciplina → `Plan`.
 *
 * Canal NO cromático primero (AGENTS §5): el texto dice la disciplina y el
 * color (`--disc-kine` / `--disc-osteo`, AA sobre blanco) solo acompaña, como
 * borde y texto. El fondo queda blanco: en la agenda el fondo es del estado.
 * **Nunca muestra el título del plan** (PHI, PD-11): la entrada no lo recibe.
 *
 * `role="img"` + `aria-label` (mismo patrón que `PractitionerBadge`): el texto
 * visible abreviado no se lee dos veces.
 */
export type DisciplineChipProps = {
  discipline: Discipline | null;
  /** Con `totalLive`: chip de sesión `Kine · 3/10`. */
  ordinal?: number;
  totalLive?: number;
  /** Sin contador: `short` = "Kine"/"Osteo" (default), `long` = "Kinesiología"/"Osteopatía". */
  label?: "short" | "long";
  size?: "xs" | "sm";
  style?: CSSProperties;
};

/** Texto visible y aria del chip (puro: lo testean las vistas que lo usan). */
export function disciplineChipText(p: Pick<DisciplineChipProps, "discipline" | "ordinal" | "totalLive" | "label">): {
  text: string;
  ariaLabel: string;
} {
  const { discipline, ordinal, totalLive, label = "short" } = p;
  if (ordinal !== undefined && totalLive !== undefined) {
    const chip = planChip({ discipline, ordinal, totalLive });
    return { text: chip.label, ariaLabel: chip.ariaLabel };
  }
  if (!discipline) return { text: "Plan", ariaLabel: "Plan sin disciplina" };
  return {
    text: label === "long" ? disciplineLabel(discipline) : disciplineShortLabel(discipline),
    ariaLabel: disciplineLabel(discipline),
  };
}

export function DisciplineChip({ discipline, ordinal, totalLive, label, size = "sm", style }: DisciplineChipProps) {
  const { text, ariaLabel } = disciplineChipText({ discipline, ordinal, totalLive, label });
  const color = disciplineColorVar(discipline) ?? "var(--navy-700)";
  return (
    <span
      role="img"
      aria-label={ariaLabel}
      title={ariaLabel}
      data-discipline={discipline ?? "NONE"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexShrink: 0,
        whiteSpace: "nowrap",
        lineHeight: 1.2,
        borderRadius: 999,
        padding: size === "xs" ? "0 5px" : "1px 7px",
        fontSize: size === "xs" ? 10 : 11,
        fontWeight: 700,
        letterSpacing: "0.01em",
        color,
        background: "#fff",
        border: `1px solid ${color}`,
        ...style,
      }}
    >
      {text}
    </span>
  );
}

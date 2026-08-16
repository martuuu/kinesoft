/**
 * 16 fixed pastel colours a practitioner can assign to a service. Stored as a
 * literal HEX on `Service.color` (not a palette key) so the colour that
 * identifies a service stays stable regardless of the user's theme. Rendered
 * inline as the agenda card's left bar. Client-safe (no server imports).
 */
export const SERVICE_COLORS = [
  "#F7A9A9", // coral
  "#F7C6A0", // peach
  "#F7DFA0", // apricot
  "#F3EDA0", // butter
  "#D7EFA0", // lime
  "#AEE9AE", // green
  "#A6E9C9", // spring
  "#A6E6E6", // aqua
  "#A6D8F0", // sky
  "#A6BEF0", // blue
  "#B4B0F2", // periwinkle
  "#C9B0F0", // lavender
  "#E0AEEC", // orchid
  "#F0AEDD", // pink
  "#F2AEC6", // rose
  "#C7CCD6", // slate
] as const;

export type ServiceColor = (typeof SERVICE_COLORS)[number];

/** True if the value is one of the allowed service colours. */
export function isServiceColor(v: string | null | undefined): v is ServiceColor {
  return !!v && (SERVICE_COLORS as readonly string[]).includes(v);
}

/** Fallback colour for the agenda left bar when a service has no colour. */
export const SERVICE_COLOR_FALLBACK = "var(--sky-500)";

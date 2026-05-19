/**
 * Uppercase mini-label that sits above a section / card title.
 * Replaces ~20 inline copies of the same pattern across the codebase
 * (font-size 10-11, uppercase, letter-spacing 0.06em, weight 700).
 */
export function EyebrowLabel({
  children,
  tone = "muted",
  as: As = "div",
  style,
}: {
  children: React.ReactNode;
  tone?: "muted" | "accent" | "lime";
  as?: "div" | "span" | "h2" | "h3";
  style?: React.CSSProperties;
}) {
  const color =
    tone === "accent"
      ? "var(--sky-700)"
      : tone === "lime"
        ? "var(--lime-700)"
        : "var(--navy-300)";
  return (
    <As
      style={{
        fontSize: 11,
        color,
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        ...style,
      }}
    >
      {children}
    </As>
  );
}

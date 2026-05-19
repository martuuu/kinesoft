import type { CSSProperties } from "react";

type Props = {
  name?: string;
  size?: number;
  tone?: "sky" | "lime" | "navy";
  style?: CSSProperties;
};

export function Avatar({ name = "JP", size = 36, tone = "sky", style }: Props) {
  const initials = name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  const bg =
    tone === "lime"
      ? "var(--lime-300)"
      : tone === "navy"
        ? "var(--navy-700)"
        : "linear-gradient(135deg, var(--sky-400), var(--sky-600))";
  const color = tone === "lime" ? "var(--navy-900)" : "#fff";
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: bg,
        color,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        fontSize: size * 0.36,
        letterSpacing: "-0.01em",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.3), 0 1px 2px rgba(15,30,51,0.1)",
        flexShrink: 0,
        ...style,
      }}
    >
      {initials}
    </span>
  );
}

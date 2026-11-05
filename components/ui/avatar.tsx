import type { CSSProperties } from "react";
import { personInitials } from "@/lib/person-initials";

type Props = {
  name?: string;
  size?: number;
  tone?: "sky" | "lime" | "navy";
  style?: CSSProperties;
};

export function Avatar({ name = "JP", size = 36, tone = "sky", style }: Props) {
  // CF3 (ZF4b): la regla compartida (nombre y apellido, sin «Lic.»/«Dra.»). Antes eran las dos primeras palabras y el
  // avatar del shell decía «LA» para «Lic. Ana Pérez» mientras la foto del profesional decía «AP».
  const initials = personInitials(name);
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

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type Tone = "lime" | "sky" | "soft";
type Variant = "fill" | "outline";

/**
 * [VX F-b2] Borde visible de la variante `outline` (cierra `ev2-kindtag-borde-inline`). El de `.k-tag-soft` es blanco
 * translúcido: sobre una tarjeta blanca el pill desaparece (EV2-Z M8). Va acá y no en `globals.css` porque F-b2 no es
 * dueña de ese archivo y cambiar `.k-tag-soft` toca todos los tags del sistema; si PF1 lo pasa a una clase
 * `.k-tag-outline`, se cambia solo esta primitiva.
 */
export const TAG_OUTLINE_BORDER = "1px solid var(--navy-200)";

export function Tag({
  tone = "sky",
  variant = "fill",
  children,
  className,
}: {
  tone?: Tone;
  variant?: Variant;
  children: ReactNode;
  className?: string;
}) {
  const toneClass =
    tone === "lime" ? "k-tag-lime" : tone === "soft" ? "k-tag-soft" : "k-tag-sky";
  return (
    <span
      className={cn("k-tag", toneClass, className)}
      style={variant === "outline" ? { border: TAG_OUTLINE_BORDER } : undefined}
    >
      {children}
    </span>
  );
}

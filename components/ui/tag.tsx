import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type Tone = "lime" | "sky" | "soft";

export function Tag({
  tone = "sky",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  const toneClass =
    tone === "lime" ? "k-tag-lime" : tone === "soft" ? "k-tag-soft" : "k-tag-sky";
  return <span className={cn("k-tag", toneClass, className)}>{children}</span>;
}

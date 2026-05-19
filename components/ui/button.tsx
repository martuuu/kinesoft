import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "lime" | "ghost";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  children: ReactNode;
};

export function Button({ variant = "primary", className, children, ...rest }: Props) {
  const variantClass =
    variant === "primary" ? "k-btn-primary" : variant === "lime" ? "k-btn-lime" : "k-btn-ghost";
  return (
    <button className={cn("k-btn", variantClass, className)} {...rest}>
      {children}
    </button>
  );
}

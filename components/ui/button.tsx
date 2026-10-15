import type { ButtonHTMLAttributes, ComponentProps } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * Botón del design system (C-F5). Server-safe: sin "use client", así lo pueden montar las superficies públicas
 * server (landing, sin-acceso, suspendido…) sin sumar JS.
 *
 * `size` y `block` son modificadores de C-F2 (`.k-btn-sm/md/lg`, `.k-btn-block`): la base `.k-btn` no cambia porque es
 * la densidad del workspace (PF1 migra por área). Sin `size` el botón se ve exactamente como antes de VX.
 */
export type ButtonVariant = "primary" | "lime" | "ghost" | "dark";
export type ButtonSize = "sm" | "md" | "lg";

type ButtonLookProps = { variant?: ButtonVariant; size?: ButtonSize; block?: boolean };

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "k-btn-primary",
  lime: "k-btn-lime",
  ghost: "k-btn-ghost",
  dark: "k-btn-dark",
};

const SIZE_CLASS: Record<ButtonSize, string> = { sm: "k-btn-sm", md: "k-btn-md", lg: "k-btn-lg" };

export function buttonClassName(o?: ButtonLookProps & { className?: string }): string {
  const variant = o?.variant ?? "primary";
  return cn("k-btn", VARIANT_CLASS[variant], o?.size && SIZE_CLASS[o.size], o?.block && "k-btn-block", o?.className);
}

export function Button({
  variant = "primary",
  size,
  block,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & ButtonLookProps) {
  return (
    <button className={buttonClassName({ variant, size, block, className })} {...rest}>
      {children}
    </button>
  );
}

/**
 * Link con aspecto de botón: un solo `<a>`. Reemplaza `<Link><Button/></Link>`, que anida un `<button>` dentro de un
 * `<a>` (HTML inválido: dos paradas de tab, y el lector de pantalla anuncia «enlace, botón»). El ratchet
 * `tests/unit/ui-ratchets.test.ts` congela los que quedan para que solo bajen.
 */
export function ButtonLink({
  variant = "primary",
  size,
  block,
  className,
  ...rest
}: ComponentProps<typeof Link> & ButtonLookProps) {
  return <Link className={buttonClassName({ variant, size, block, className })} {...rest} />;
}

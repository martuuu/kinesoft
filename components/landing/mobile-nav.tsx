"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { buttonClassName } from "@/components/ui/button";
import s from "./site-header.module.css";

/**
 * [VX2-c1] Menú mobile de la landing (< 1024). Patrón disclosure: un botón con `aria-expanded`/`aria-controls` que
 * muestra/oculta el panel. Escape lo cierra y devuelve el foco al botón; tocar un link lo cierra (son anclas de la
 * misma página); pasar a ≥ 1024 lo cierra (ahí el nav de escritorio ya está a la vista).
 *
 * Sin framer (C-F3: superficie pública): la entrada del panel es `k-rise` en CSS y con reduce motion no se anima.
 * Sin JS el botón no hace nada, pero todo lo del menú también está en el footer (anclas) y en el hero (CTAs).
 */
export function MobileNav({
  links,
  ctaLabel = "Creá tu cuenta",
}: {
  links: readonly { href: string; label: string }[];
  /** VX-Z: el mismo texto que el CTA del header (`signupCtaLabel`). */
  ctaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    const onResize = () => {
      if (window.innerWidth >= 1024) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <>
      <button
        ref={toggleRef}
        type="button"
        className={s.toggle}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Cerrar menú" : "Abrir menú"}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        )}
      </button>
      <div className={s.panel} id={panelId} hidden={!open}>
        <nav aria-label="Secciones (menú)">
          <ul className={s.panelList} role="list">
            {links.map((l) => (
              <li key={l.href}>
                <a href={l.href} onClick={close}>
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className={s.panelCta}>
          <Link href="/signup" className={buttonClassName({ variant: "primary", size: "md", block: true })} onClick={close}>
            {ctaLabel}
          </Link>
          <Link href="/login" className={buttonClassName({ variant: "ghost", size: "md", block: true })} onClick={close}>
            Ingresar
          </Link>
        </div>
      </div>
    </>
  );
}

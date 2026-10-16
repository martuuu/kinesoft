"use client";

/**
 * Barra de navegación inferior del workspace (MB-0c, contrato C-MB1, variante **fija** MB-D1).
 *
 * Por qué fija y no flotante ni oculta al scrollear: una píldora flotante tapa la última fila de las listas y el pie de
 * los Drawers (el mismo problema que tuvo el engranaje de Tweaks, VX0-b S2), y la Secretaria alterna Agenda ↔ Sala
 * decenas de veces por hora: esconderla al scrollear le agrega un gesto y genera toques fallidos cuando reaparece.
 *
 * Se renderiza siempre y decide el CSS (`bottom-nav.module.css`: visible solo bajo 768 px, el mismo corte que
 * `.desktopOnly`): el server no conoce el ancho y así no hay salto al hidratar. Los destinos salen de `bottomNavFor`
 * (`lib/nav.ts`, única fuente del nav); el activo, del mismo `activeNavHref` del sidebar.
 *
 * «Más» abre el `MobileNavDrawer` (antes lo abría el botón «Menú» de la barra superior, que se fue): el Drawer baja con
 * `next/dynamic` recién al primer toque (precarga en hover/foco/toque), así en escritorio nunca se descarga (C-PF2).
 *
 * Teclado virtual: en iOS una barra `position: fixed` salta sobre el teclado y tapa el campo. Con un campo enfocado y
 * el viewport visual por debajo del 75 % del alto, la barra se oculta (`hidden`), sin animación: con
 * `reducedMotion` el estado final es el mismo.
 */
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { IconMenu } from "@/components/ui/icons";
import { bottomNavFor } from "@/lib/nav";
import type { Capability } from "@/lib/capabilities";
import { useTenantModules } from "./tenant-modules-context";
import { NAV_ICONS, activeNavHref, useCapSet } from "./sidebar";
import styles from "./bottom-nav.module.css";

const loadDrawer = () => import("./mobile-nav-drawer");
const preloadDrawer = () => void loadDrawer();

const MobileNavDrawer = dynamic(() => loadDrawer().then((m) => m.MobileNavDrawer), {
  ssr: false,
  // El Drawer es una capa fija: mientras llega no hay nada que reservar (CLS 0).
  loading: () => null,
});

/** Lo mínimo de un `Element` que hace falta para decidir si abre teclado (testeable sin DOM). */
type FocusLike = { tagName: string; type?: string; isContentEditable?: boolean } | null | undefined;

/** Tipos de `<input>` que NO abren el teclado virtual (se tocan, no se escriben). */
const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image", "hidden"]);

/** ¿El elemento enfocado abre el teclado en pantalla? */
export function isEditableTarget(el: FocusLike): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has((el.type ?? "text").toLowerCase());
  return false;
}

/**
 * ¿Está el teclado virtual abierto? Hace falta el campo enfocado: el viewport visual también se achica con el zoom de
 * pellizco, y ahí la barra no tiene que desaparecer. 0,75 = umbral de C-MB1 (un teclado de celular ocupa ~40 % del
 * alto; la barra de direcciones de Safari al colapsar mueve ~10 %).
 */
export function isVirtualKeyboardOpen(p: { editable: boolean; viewportHeight: number; innerHeight: number }): boolean {
  return p.editable && p.innerHeight > 0 && p.viewportHeight < 0.75 * p.innerHeight;
}

function useVirtualKeyboardOpen(initial: boolean): boolean {
  const [open, setOpen] = useState(initial);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () =>
      setOpen(
        isVirtualKeyboardOpen({
          editable: isEditableTarget(document.activeElement as HTMLElement | null),
          viewportHeight: vv.height,
          innerHeight: window.innerHeight,
        })
      );
    // `resize` del viewport visual = el teclado entró o salió; focusin/focusout = cambió el campo (en Android el
    // viewport puede no cambiar de alto si el navegador redimensiona el layout entero).
    vv.addEventListener("resize", update);
    window.addEventListener("focusin", update);
    window.addEventListener("focusout", update);
    return () => {
      vv.removeEventListener("resize", update);
      window.removeEventListener("focusin", update);
      window.removeEventListener("focusout", update);
    };
  }, []);
  return open;
}

export function BottomNav({
  caps,
  isPlatformAdmin,
  onOpenAppearance,
  defaultMoreOpen = false,
  defaultKeyboardOpen = false,
}: {
  caps: readonly Capability[];
  isPlatformAdmin: boolean;
  onOpenAppearance?: () => void;
  /** Solo para el test de render (sin jsdom no hay click). */
  defaultMoreOpen?: boolean;
  /** Solo para el test de render (sin jsdom no hay visualViewport). */
  defaultKeyboardOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultMoreOpen);
  // Una vez abierto queda montado: así el Drawer anima la salida y el segundo toque no vuelve a pedir el chunk.
  const [mounted, setMounted] = useState(defaultMoreOpen);
  const keyboardOpen = useVirtualKeyboardOpen(defaultKeyboardOpen);
  const pathname = usePathname();
  const search = useSearchParams();
  const { list: modules } = useTenantModules();
  const capSet = useCapSet(caps);
  const entries = useMemo(() => bottomNavFor(modules, capSet), [modules, capSet]);
  const active = activeNavHref(
    entries.flatMap((e) => (e.kind === "link" ? [e.href] : [])),
    pathname,
    search
  );

  // Navegar (también con atrás/adelante) cierra el menú.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <>
      <nav
        aria-label="Navegación principal"
        className={`k-glass-strong ${styles.bar}`}
        data-k-bottom-nav
        hidden={keyboardOpen || undefined}
      >
        {entries.map((e) => {
          if (e.kind === "more") {
            return (
              <button
                key="more"
                type="button"
                className={styles.item}
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => {
                  setMounted(true);
                  setOpen(true);
                }}
                onPointerEnter={preloadDrawer}
                onTouchStart={preloadDrawer}
                onFocus={preloadDrawer}
              >
                <span className={styles.icon}>
                  <IconMenu size={24} />
                </span>
                <span className={styles.label}>{e.label}</span>
              </button>
            );
          }
          const on = active === e.href;
          const I = NAV_ICONS[e.icon];
          return (
            <Link
              key={e.href}
              href={e.href}
              aria-current={on ? "page" : undefined}
              className={on ? `${styles.item} ${styles.itemOn}` : styles.item}
            >
              {/* El activo no va solo por color (AA): la pastilla detrás del ícono es un canal de forma. */}
              <span className={styles.icon}>
                <I size={24} />
              </span>
              <span className={styles.label}>{e.label}</span>
            </Link>
          );
        })}
      </nav>
      {mounted && (
        <MobileNavDrawer
          open={open}
          onClose={() => setOpen(false)}
          isPlatformAdmin={isPlatformAdmin}
          caps={caps}
          onOpenAppearance={onOpenAppearance}
        />
      )}
    </>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { KineLogo } from "@/components/ui/kine-logo";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { IconArrow, IconLogout, IconMenu } from "@/components/ui/icons";
import type { ActionResult } from "@/lib/validation";
import { PlatformNav } from "./platform-nav";

/**
 * Shell de Plataforma (BO3-A, plan §19.5 «Superadmin sin consultorio casa»).
 *
 * Por qué no es el `AppShell`: ese cuelga de `app/(app)/layout.tsx`, que exige un Actor de consultorio (un
 * superadmin sin consultorio rebotaba a /onboarding o /sin-acceso) y, con una sesión de soporte abierta, mostraba el
 * consultorio DESTINO como si fuera el contexto de /plataforma. Este shell no depende de ningún módulo del
 * consultorio (tweaks, módulos, realtime, selector): solo de lo que el layout de `(platform)` le pasa, que sale de
 * `requirePlatformAdmin` y de la cookie de soporte.
 *
 * Reusa los tokens y las clases del AppShell (`k-app`, `k-glass`, pastilla sky para el activo) para que se lea como
 * la misma app. Bajo 900 px el sidebar se esconde y el nav sale en un `Drawer` desde el botón «Menú» (CSS en
 * `app/globals.css`, `.k-plat-*`): nada de scroll horizontal a 360 px.
 */

export type PlatformShellSupport = { tenantName: string } | null;

/** `endSupport` de `lib/platform-support.ts`. Llega por prop desde el layout (server), igual que `switchTenant` en el AppShell. */
export type EndSupportAction = () => Promise<ActionResult<{ redirectTo: string }>>;

export function PlatformShell({
  name,
  email,
  hasHome,
  support,
  endSupportAction,
  children,
}: {
  /** Nombre del superadmin (`displayUserName`): nunca el email (decisión 19). */
  name: string;
  email: string;
  /** El superadmin tiene un consultorio propio usable (`PlatformActor.homeTenantId`). */
  hasHome: boolean;
  support: PlatformShellSupport;
  endSupportAction: EndSupportAction | null;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="k-app" style={{ minHeight: "100vh", background: "var(--bg-app)", display: "flex" }}>
      <aside
        className="k-glass k-plat-side"
        aria-label="Plataforma"
        style={{
          width: 232,
          flexShrink: 0,
          padding: 18,
          margin: 14,
          marginRight: 0,
          borderRadius: "var(--r-xl)",
          position: "sticky",
          top: 14,
          // PF1.0-a (S4 de VX0-b): `dvh` y no `vh`. En Safari iOS `100vh` cuenta la barra de direcciones y el pie del
          // sidebar quedaba tapado. (El «bloque cortado» de las capturas de VX0-b era la captura de página completa:
          // un sticky se dibuja una sola vez arriba.)
          height: "calc(100dvh - 28px)",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        <Link href="/plataforma" style={{ textDecoration: "none", padding: "4px 6px" }}>
          <KineLogo size={28} />
        </Link>
        <PlatformNav />
      </aside>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <PlatformTopBar
          name={name}
          email={email}
          hasHome={hasHome}
          support={support}
          endSupportAction={endSupportAction}
          onOpenMenu={() => setMenuOpen(true)}
        />
        <main className="k-plat-main" style={{ flex: 1, minWidth: 0, padding: 14 }}>
          {children}
        </main>
      </div>
      <Drawer open={menuOpen} onClose={() => setMenuOpen(false)} title="Secciones de Plataforma" width={300}>
        <div style={{ paddingTop: 36 }}>
          <PlatformNav onNavigate={() => setMenuOpen(false)} />
        </div>
      </Drawer>
    </div>
  );
}

export function PlatformTopBar({
  name,
  email,
  hasHome,
  support,
  endSupportAction,
  onOpenMenu,
}: {
  name: string;
  email: string;
  hasHome: boolean;
  support: PlatformShellSupport;
  endSupportAction: EndSupportAction | null;
  onOpenMenu?: () => void;
}) {
  return (
    <header
      className="k-glass"
      style={{
        margin: 14,
        marginBottom: 0,
        padding: "10px 14px",
        borderRadius: "var(--r-xl)",
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 10,
        minWidth: 0,
      }}
    >
      <button
        type="button"
        className="k-plat-menu-btn"
        onClick={onOpenMenu}
        aria-label="Abrir menú de Plataforma"
        style={{
          all: "unset",
          cursor: "pointer",
          // El display lo maneja `.k-plat-menu-btn` (oculto en escritorio); acá solo la forma.
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderRadius: 999,
          fontSize: 13,
          fontWeight: 600,
          color: "var(--navy-700)",
          background: "rgba(255,255,255,0.7)",
        }}
      >
        <IconMenu size={16} />
        <span>Menú</span>
      </button>
      <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--navy-900)" }}>Plataforma</span>

      {support && <SupportChip support={support} endSupportAction={endSupportAction} />}

      <div style={{ flex: 1 }} />

      <span
        className="k-plat-email"
        // VX0-b (decisión 19): el nombre, no el email; el email queda en el tooltip, rotulado.
        title={`Email: ${email}`}
        style={{
          fontSize: 12.5,
          color: "var(--navy-500)",
          maxWidth: 240,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </span>
      {/*
        Solo con consultorio propio: sin uno, /dashboard rebota a /onboarding o /sin-acceso. Con soporte abierto
        tampoco: /dashboard mostraría el consultorio DESTINO (la cookie de soporte gana sobre la propia), así que
        «Volver a mi consultorio» mentiría; el chip ofrece ir al consultorio de soporte o salir.
      */}
      {hasHome && !support && (
        <Link
          href="/dashboard"
          className="k-btn k-btn-ghost"
          style={{ textDecoration: "none", padding: "8px 14px" }}
        >
          Volver a mi consultorio
        </Link>
      )}
      {/* PL-2a (C-PL6): la 2FA del superadmin se maneja como la de cualquiera, en /cuenta/seguridad (fuera de los grupos). */}
      <a
        href="/cuenta/seguridad"
        className="k-btn k-btn-ghost"
        style={{ textDecoration: "none", padding: "8px 14px" }}
      >
        Seguridad
      </a>
      <form action="/api/auth/sign-out" method="post" style={{ margin: 0 }}>
        <button
          type="submit"
          aria-label="Cerrar sesión"
          title="Cerrar sesión"
          style={{
            all: "unset",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            borderRadius: 999,
            fontSize: 13,
            color: "var(--navy-500)",
          }}
        >
          <IconLogout size={16} />
          <span className="k-plat-email">Cerrar sesión</span>
        </button>
      </form>
    </header>
  );
}

function SupportChip({
  support,
  endSupportAction,
}: {
  support: NonNullable<PlatformShellSupport>;
  endSupportAction: EndSupportAction | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const exit = () => {
    if (!endSupportAction) return;
    setError(null);
    start(async () => {
      try {
        const res = await endSupportAction();
        if (!res.ok) {
          setError(res.error);
          return;
        }
        // PF1.0-a (C-PF4): sin `router.refresh()`. `endSupport` ya hace `revalidatePath("/", "layout")`, así que la
        // navegación sale con el layout re-leído (sin la cookie de soporte, sin el chip); el refresh era un segundo
        // render completo.
        router.push(res.data.redirectTo);
      } catch {
        setError("No se pudo salir de soporte. Probá de nuevo.");
      }
    });
  };

  return (
    <div
      role="status"
      data-testid="support-chip"
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
        padding: "6px 8px 6px 12px",
        borderRadius: 999,
        background: "rgba(217,130,0,0.12)",
        border: "1px solid rgba(217,130,0,0.35)",
        color: "var(--navy-900)",
        fontSize: 12.5,
        minWidth: 0,
        maxWidth: "100%",
      }}
    >
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        Soporte activo en <strong>{support.tenantName}</strong>
      </span>
      {/* La cookie de soporte gana en (app): /dashboard ES el consultorio destino. */}
      <Link
        href="/dashboard"
        style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--sky-700)", fontWeight: 600 }}
      >
        Ir al consultorio <IconArrow size={13} />
      </Link>
      {endSupportAction && (
        <Button
          type="button"
          variant="ghost"
          onClick={exit}
          disabled={pending}
          style={{ padding: "6px 12px", fontSize: 12.5 }}
        >
          {pending ? "Saliendo…" : "Salir de soporte"}
        </Button>
      )}
      {error && (
        <span role="alert" style={{ color: "var(--danger-fg)", fontSize: 12 }}>
          {error}
        </span>
      )}
    </div>
  );
}

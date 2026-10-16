import Link from "next/link";
import type { PortalSection } from "@/lib/portal-nav";
import { PORTAL_TABS_LABEL, portalTabLabel, type PortalTab } from "@/lib/portal-copy";

/**
 * ES4 S24 · tabs de un consultorio en el portal (`/portal/c/<slug>`, `/cuenta`, `/ejercicios` y «Sacar un turno»).
 *
 * Por qué así:
 * - qué tabs hay lo decide `portalSectionsFor` (lib/portal-nav.ts), la misma fuente que el gate server-side de cada
 *   page: un consultorio sin `ejercicios` no ve la tab Y su page da 404 (no es solo esconder). Las pages pasan las
 *   secciones de la ficha (`PortalPatient.sections`, o `portalSectionsFor(ref.modules)`);
 * - server component, solo `<Link>` y nada de estado: el portal tiene presupuesto de 125 kB y no puede importar
 *   Drawer/Modal/Toast (C-F3); la tab activa la pasa la page (`active`), así no hace falta `usePathname` en cliente;
 * - «Sacar un turno» sale del portal al turnero público (`/c/<slug>/booking`), solo con `turneroPublico`;
 * - controles de 44 px (criterio AA de VX §5) y `aria-current="page"` en la activa.
 *
 * Uso (S24p/S24e): `<PortalTabs slug={slug} sections={portalSectionsFor(ref.modules)} active="cuenta" />`.
 */

const TAB_ORDER: readonly PortalTab[] = ["inicio", "ejercicios", "cuenta", "reservar"];

export type PortalTabItem = { key: PortalTab; href: string; label: string; external: boolean };

/** Pura (testeada en tests/unit/portal-copy.test.ts): las tabs visibles para esas secciones, en orden. */
export function portalTabItems(
  slug: string,
  sections: readonly PortalSection[] | ReadonlySet<PortalSection>
): PortalTabItem[] {
  const set = new Set<PortalSection>(sections);
  const has = (s: PortalSection) => set.has(s);
  const base = `/portal/c/${encodeURIComponent(slug)}`;
  const href: Record<PortalTab, string> = {
    inicio: base,
    ejercicios: `${base}/ejercicios`,
    cuenta: `${base}/cuenta`,
    reservar: `/c/${encodeURIComponent(slug)}/booking`,
  };
  return TAB_ORDER.filter(has).map((key) => ({
    key,
    href: href[key],
    label: portalTabLabel(key, has("plan")),
    external: key === "reservar",
  }));
}

const tabStyle = (active: boolean): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  minHeight: 44,
  padding: "0 14px",
  borderRadius: 999,
  fontSize: 14,
  fontWeight: active ? 700 : 600,
  textDecoration: "none",
  whiteSpace: "nowrap",
  color: active ? "var(--navy-900)" : "var(--sky-700)",
  background: active ? "var(--sky-100)" : "transparent",
  border: "1px solid rgba(15,30,51,0.08)",
});

export function PortalTabs({
  slug,
  sections,
  active,
}: {
  slug: string;
  sections: readonly PortalSection[] | ReadonlySet<PortalSection>;
  /** Tab de la page actual. Sin `active` (p. ej. la tarjeta de la home) ninguna queda marcada. */
  active?: PortalTab;
}) {
  const items = portalTabItems(slug, sections);
  // Una sola tab (no debería pasar: «inicio» y «cuenta» están siempre) no es navegación.
  if (items.length < 2) return null;
  return (
    <nav aria-label={PORTAL_TABS_LABEL}>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 8 }}>
        {items.map((t) => {
          const on = t.key === active;
          return (
            <li key={t.key}>
              <Link href={t.href} aria-current={on ? "page" : undefined} style={tabStyle(on)}>
                {t.label}
                {t.external ? " →" : ""}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Directorio de usuarios de /plataforma (BO3-D). Sin "use client": filas y paginado se renderizan en el server con
 * la página que trajo `searchPlatformUsers`; solo el buscador y la tarjeta «Solo en Auth» son client components.
 *
 * PHI: para la parte de portal la fila dice «Paciente en N consultorios» y nada más (`rowTenantsSummary`). El
 * render test lo fija con un fixture.
 *
 * La tabla tiene scroll horizontal propio (`overflowX: auto` + `minWidth`), como la de consultorios, para que en
 * 360 px no scrollee la página entera.
 */
import { displayUserName } from "@/lib/display-name";
import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import type { PlatformUserPage, PlatformUserRow } from "@/lib/platform-health-logic";
import { UserSearch } from "@/components/plataforma/users/user-search";
import { AuthOnlyCard } from "@/components/plataforma/users/auth-only-card";
import {
  USER_KIND_LABEL,
  buildUsersHref,
  rowTenantsSummary,
  totalPages,
  userHref,
  usersCountLabel,
  type UsersQuery,
} from "@/components/plataforma/users/users-logic";

// Mínimos 240+130+200+110+110 = 790 + 4 gaps de 12 + padding 32 = 870.
const COLS = "minmax(240px,1.6fr) 130px minmax(200px,1.2fr) 110px 110px";
const MIN_WIDTH = 870;

function Head({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--navy-300)" }}>
      {children}
    </div>
  );
}

function Row({ r }: { r: PlatformUserRow }) {
  return (
    <div
      data-user-row={r.id}
      style={{
        display: "grid",
        gridTemplateColumns: COLS,
        gap: 12,
        padding: "12px 16px",
        borderBottom: "1px solid rgba(15,30,51,0.05)",
        alignItems: "center",
        fontSize: 13,
        color: "var(--navy-700)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <Link href={userHref(r.id)} style={{ fontWeight: 700, color: "var(--navy-900)", textDecoration: "none", overflowWrap: "anywhere" }}>
          {displayUserName(r.fullName)}
        </Link>
        {/* DIR-0: el email va siempre en su línea (es el dato «Email»), nunca en lugar del nombre. */}
        <div style={{ fontSize: 12, color: "var(--navy-300)", overflowWrap: "anywhere" }}>{r.email}</div>
      </div>
      <div>{USER_KIND_LABEL[r.kind]}</div>
      <div style={{ fontSize: 12.5 }}>{rowTenantsSummary(r)}</div>
      <div>{r.isPlatformAdmin ? <Tag tone="lime">Superadmin</Tag> : <span style={{ color: "var(--navy-300)" }}>—</span>}</div>
      <div>
        {r.disabled ? (
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--danger-fg)" }}>Deshabilitado</span>
        ) : (
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--lime-700)" }}>Habilitado</span>
        )}
      </div>
    </div>
  );
}

function Pagination({ page, query }: { page: PlatformUserPage; query: UsersQuery }) {
  const pages = totalPages(page.total, page.pageSize);
  if (pages <= 1) return null;
  const linkStyle: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: "var(--sky-700)" };
  return (
    <nav aria-label="Paginación" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <span style={{ fontSize: 13, color: "var(--navy-500)" }}>
        Página {page.page} de {pages}
      </span>
      <span style={{ display: "flex", gap: 16 }}>
        {page.page > 1 && (
          <Link href={buildUsersHref(query, page.page - 1)} style={linkStyle}>
            ← Anterior
          </Link>
        )}
        {page.page < pages && (
          <Link href={buildUsersHref(query, page.page + 1)} style={linkStyle}>
            Siguiente →
          </Link>
        )}
      </span>
    </nav>
  );
}

export function UserList({ page, query }: { page: PlatformUserPage; query: UsersQuery }) {
  const filtered = !!query.q || query.kind !== "all";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card style={{ padding: 16 }}>
        <UserSearch q={query.q} kind={query.kind} />
      </Card>

      {page.authOnly && <AuthOnlyCard hit={page.authOnly} />}

      <div style={{ fontSize: 13, color: "var(--navy-500)" }}>
        {usersCountLabel(page.total)}
        {filtered ? " con estos filtros" : ""}
      </div>

      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: MIN_WIDTH }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: COLS,
                gap: 12,
                padding: "10px 16px",
                borderBottom: "1px solid rgba(15,30,51,0.07)",
                background: "rgba(246,249,253,0.6)",
              }}
            >
              <Head>Usuario</Head>
              <Head>Tipo</Head>
              <Head>Consultorios</Head>
              <Head>Plataforma</Head>
              <Head>Estado</Head>
            </div>
            {page.rows.length === 0 ? (
              <div style={{ padding: 24, fontSize: 13, color: "var(--navy-500)" }}>
                {filtered ? "No hay usuarios con estos filtros." : "Todavía no hay usuarios."}
              </div>
            ) : (
              page.rows.map((r) => <Row key={r.id} r={r} />)
            )}
          </div>
        </div>
      </Card>

      <Pagination page={page} query={query} />
    </div>
  );
}

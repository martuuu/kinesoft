/**
 * [DIR-3e] Filtros y listas de /plataforma/directorio. Sin "use client": los filtros son links + un
 * `<form method="get">` (la URL es la fuente de verdad, como Facturación y Consultorios) y las filas son HTML del
 * server; solo las acciones de cada fila son cliente (`moderation-actions.tsx`).
 *
 * Filas apiladas (no una grilla de columnas fijas): cada una envuelve sus datos y sus botones con `flex-wrap`, así a
 * 360 px se lee sin scroll horizontal y en escritorio queda en una línea. Son pocas filas (tope de 200 por lista) y
 * cada una tiene acciones distintas según su estado; una tabla ancha no aporta.
 *
 * Privacidad: sin email (DIR-D15 y C-DIR9: el superadmin identifica a la persona por su nombre público y entra a
 * /plataforma/usuarios/<id>, que muestra el mail con su propia barrera). El `userId` solo viaja en ese href.
 */
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { formatDateAR } from "@/lib/format";
import type {
  PlatformDirectoryClinicRow,
  PlatformDirectoryProfileRow,
  PlatformDirectoryView,
} from "@/lib/platform-directory-read";
import { PLATFORM_DIRECTORY_LIMIT } from "@/lib/platform-directory-read";
import type { DirectoryMode } from "@/lib/directory-mode";
import { tenantHref } from "@/components/plataforma/tenants/labels";
import {
  DIRECTORY_ADMIN_PATH,
  ESTADO_FILTERS,
  clinicStatus,
  directoryAdminHref,
  licenseText,
  platformUserHref,
  profileDisplayName,
  profileStatus,
  publicClinicHref,
  publicProfileHref,
  type DerivedStatus,
} from "@/components/plataforma/directory/moderation-logic";
import { ClinicModerationActions, ProfileModerationActions } from "@/components/plataforma/directory/moderation-actions";

const linkStyle: CSSProperties = { color: "var(--sky-700)", fontWeight: 600, textDecoration: "none" };
const metaStyle: CSSProperties = { fontSize: 12.5, color: "var(--navy-500)", lineHeight: 1.45 };
const inputStyle: CSSProperties = {
  padding: "9px 12px",
  borderRadius: 12,
  border: "1px solid rgba(15,30,51,0.08)",
  background: "rgba(255,255,255,0.96)",
  fontSize: 13.5,
  color: "var(--navy-900)",
  minWidth: 0,
};

function StatusTag({ s }: { s: DerivedStatus }) {
  if (s.tone === "warn") {
    return (
      <span className="k-tag" style={{ background: "var(--warn-bg)", color: "var(--warn-fg)", fontWeight: 700 }}>
        {s.label}
      </span>
    );
  }
  return <Tag tone={s.tone}>{s.label}</Tag>;
}

export function DirectoryFilters({ filters }: { filters: PlatformDirectoryView["filters"] }) {
  const filtered = filters.q !== "" || filters.estado !== "todos";
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div role="group" aria-label="Estado" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {ESTADO_FILTERS.map((o) => {
          const active = o.value === filters.estado;
          return (
            <Link
              key={o.value}
              href={directoryAdminHref({ q: filters.q, estado: o.value })}
              aria-current={active ? "true" : undefined}
              style={{
                textDecoration: "none",
                padding: "6px 12px",
                borderRadius: 999,
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                color: active ? "#fff" : "var(--navy-700)",
                background: active ? "var(--sky-700)" : "rgba(15,30,51,0.05)",
              }}
            >
              {o.label}
            </Link>
          );
        })}
      </div>
      <form method="get" action={DIRECTORY_ADMIN_PATH} role="search" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {filters.estado !== "todos" && <input type="hidden" name="estado" value={filters.estado} />}
        <input
          type="search"
          name="q"
          defaultValue={filters.q}
          maxLength={100}
          placeholder="Buscar por nombre o slug"
          aria-label="Buscar por nombre o slug"
          style={{ ...inputStyle, flex: "1 1 220px" }}
        />
        <Button type="submit" variant="ghost">
          Buscar
        </Button>
        {filtered && (
          <Link href={DIRECTORY_ADMIN_PATH} style={{ ...linkStyle, fontSize: 13 }}>
            Limpiar
          </Link>
        )}
      </form>
    </div>
  );
}

function ListCard({
  title,
  count,
  truncated,
  empty,
  children,
}: {
  title: string;
  count: number;
  truncated: boolean;
  empty: string | null;
  children: ReactNode;
}) {
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
          padding: "12px 16px",
          borderBottom: "1px solid rgba(15,30,51,0.07)",
          background: "var(--bg-panel)",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--navy-900)" }}>{title}</h2>
        <span style={metaStyle}>{count === 1 ? "1 resultado" : `${count} resultados`}</span>
      </div>
      {truncated && (
        <p role="status" style={{ margin: 0, padding: "10px 16px", fontSize: 13, background: "var(--warn-bg)", color: "var(--warn-fg)" }}>
          Se muestran los primeros {PLATFORM_DIRECTORY_LIMIT}. Afiná la búsqueda para ver el resto.
        </p>
      )}
      {empty ? (
        <div style={{ padding: "36px 20px", textAlign: "center", fontSize: 13.5, color: "var(--navy-700)", fontWeight: 600 }}>{empty}</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{children}</ul>
      )}
    </Card>
  );
}

const rowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "10px 16px",
  padding: "14px 16px",
  borderTop: "1px solid rgba(15,30,51,0.06)",
};

function HiddenReason({ hidden }: { hidden: PlatformDirectoryClinicRow["hidden"] }) {
  if (!hidden) return null;
  return (
    <div style={{ ...metaStyle, color: "var(--navy-700)" }}>
      Oculto el {formatDateAR(hidden.at, "short")}: «{hidden.reason}»
    </div>
  );
}

function ClinicRow({ c, mode }: { c: PlatformDirectoryClinicRow; mode: DirectoryMode }) {
  const status = clinicStatus(c);
  const pub = publicClinicHref(c, mode);
  return (
    <li style={rowStyle}>
      <div style={{ display: "grid", gap: 4, flex: "1 1 260px", minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Link href={tenantHref(c.tenantId)} style={{ ...linkStyle, fontSize: 14, overflowWrap: "anywhere" }}>
            {c.name}
          </Link>
          <StatusTag s={status} />
        </div>
        <div style={metaStyle}>
          <span style={{ fontFamily: "var(--font-mono)" }}>{c.slug}</span>
          {c.directoryListedAt && <> · Publicado por el titular el {formatDateAR(c.directoryListedAt, "short")}</>}
          {!c.hasDescription && <> · Sin descripción</>}
          {pub && (
            <>
              {" · "}
              <a href={pub} target="_blank" rel="noopener noreferrer" style={linkStyle}>
                Ver en el directorio
              </a>
            </>
          )}
        </div>
        {status.note && <div style={metaStyle}>{status.note}</div>}
        <HiddenReason hidden={c.hidden} />
      </div>
      <ClinicModerationActions tenantId={c.tenantId} name={c.name} hidden={c.hidden} />
    </li>
  );
}

function ProfileRow({ p, mode }: { p: PlatformDirectoryProfileRow; mode: DirectoryMode }) {
  const status = profileStatus(p);
  const name = profileDisplayName(p);
  const lic = licenseText(p.license);
  const pub = publicProfileHref(p, mode);
  return (
    <li style={rowStyle}>
      <div style={{ display: "grid", gap: 4, flex: "1 1 260px", minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Link href={platformUserHref(p.userId)} style={{ ...linkStyle, fontSize: 14, overflowWrap: "anywhere" }}>
            {name}
          </Link>
          <StatusTag s={status} />
        </div>
        <div style={metaStyle}>
          {lic ? (
            <>
              Matrícula {lic} ·{" "}
              {p.license?.verifiedAt ? (
                <strong style={{ color: "var(--navy-900)" }}>verificada el {formatDateAR(p.license.verifiedAt, "short")}</strong>
              ) : (
                "sin verificar"
              )}
            </>
          ) : (
            "Sin matrícula cargada"
          )}
          {pub && (
            <>
              {" · "}
              <a href={pub} target="_blank" rel="noopener noreferrer" style={linkStyle}>
                Ver en el directorio
              </a>
            </>
          )}
        </div>
        <div style={metaStyle}>
          {p.clinics.length ? (
            <>
              Atiende en{" "}
              {p.clinics.map((c, i) => (
                <span key={c.tenantId}>
                  {i > 0 && ", "}
                  <Link href={tenantHref(c.tenantId)} style={{ ...linkStyle, fontWeight: 500 }}>
                    {c.name}
                  </Link>
                </span>
              ))}
            </>
          ) : (
            "No atiende en ningún consultorio"
          )}
          {p.consentWithdrawnAt
            ? <> · Retiró el consentimiento el {formatDateAR(p.consentWithdrawnAt, "short")}</>
            : p.consentAt && <> · Consentimiento del {formatDateAR(p.consentAt, "short")}</>}
        </div>
        <HiddenReason hidden={p.hidden} />
      </div>
      <ProfileModerationActions
        profileId={p.profileId}
        name={name}
        hidden={p.hidden}
        license={lic ? { text: lic, verified: !!p.license?.verifiedAt } : null}
      />
    </li>
  );
}

export function DirectoryClinicList({ view, mode }: { view: PlatformDirectoryView; mode: DirectoryMode }) {
  const filtered = view.filters.q !== "" || view.filters.estado !== "todos";
  const empty =
    view.clinics.length > 0
      ? null
      : view.filters.estado === "sin_verificar"
        ? "La verificación es de la matrícula de cada profesional: no aplica a consultorios."
        : filtered
          ? "Ningún consultorio coincide con el filtro."
          : "Todavía ningún consultorio se publicó en el directorio.";
  return (
    <ListCard title="Consultorios" count={view.clinics.length} truncated={view.truncated.clinics} empty={empty}>
      {view.clinics.map((c) => (
        <ClinicRow key={c.tenantId} c={c} mode={mode} />
      ))}
    </ListCard>
  );
}

export function DirectoryProfileList({ view, mode }: { view: PlatformDirectoryView; mode: DirectoryMode }) {
  const filtered = view.filters.q !== "" || view.filters.estado !== "todos";
  const empty =
    view.profiles.length > 0
      ? null
      : view.filters.estado === "sin_verificar" && view.filters.q === ""
        ? "No hay matrículas para verificar."
        : filtered
          ? "Ningún perfil coincide con el filtro."
          : "Todavía nadie creó su perfil público.";
  return (
    <ListCard title="Perfiles de profesionales" count={view.profiles.length} truncated={view.truncated.profiles} empty={empty}>
      {view.profiles.map((p) => (
        <ProfileRow key={p.profileId} p={p} mode={mode} />
      ))}
    </ListCard>
  );
}

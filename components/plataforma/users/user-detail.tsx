/**
 * Detalle de un usuario de /plataforma (BO3-D). Sin "use client": datos del server (`getPlatformUser`), y las
 * acciones en `UserActions` (client).
 *
 * PHI: las membresías (equipo) se nombran con su consultorio; de las fichas de portal solo el conteo
 * («Paciente en N consultorios»). El DTO no trae más que eso.
 */
import { displayUserName } from "@/lib/display-name";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import type { PlatformUserDetail, PlatformUserMembership } from "@/lib/platform-health-logic";
import { tenantHref } from "@/components/plataforma/tenants/labels";
import { UserActions } from "@/components/plataforma/users/user-actions";
import {
  TENANT_STATUS_LABEL,
  USERS_PATH,
  USER_KIND_LABEL,
  authStateLines,
  formatDateTimeAR,
  membershipNeedsPractitioner,
  membershipRoleLabel,
  membershipStatusLabel,
  portalLinksLabel,
} from "@/components/plataforma/users/users-logic";

const TONE_COLOR = { ok: "var(--navy-900)", warn: "#9A5B00", muted: "var(--navy-500)" } as const;

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 10px", color: "var(--navy-900)" }}>{children}</h2>;
}

function MembershipRow({ m }: { m: PlatformUserMembership }) {
  return (
    <li
      style={{
        display: "flex",
        gap: 12,
        justifyContent: "space-between",
        alignItems: "flex-start",
        flexWrap: "wrap",
        padding: "10px 0",
        borderTop: "1px solid rgba(15,30,51,0.06)",
        fontSize: 13,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <Link href={tenantHref(m.tenantId)} style={{ fontWeight: 700, color: "var(--navy-900)", textDecoration: "none" }}>
          {m.tenantName}
        </Link>
        <div style={{ fontSize: 12, color: "var(--navy-300)", fontFamily: "var(--font-mono)" }}>{m.tenantSlug}</div>
        {membershipNeedsPractitioner(m) && (
          <div style={{ fontSize: 12, color: "#9A5B00", marginTop: 4 }}>
            Le falta el profesional en este consultorio: se repara desde <Link href="/plataforma/salud">Salud</Link>.
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <Tag tone="sky">{membershipRoleLabel(m.role, m.tenantVertical)}</Tag>
        <Tag tone={m.accepted && !m.suspended ? "lime" : "soft"}>{membershipStatusLabel(m)}</Tag>
        {m.tenantStatus !== "ACTIVE" && <Tag tone="soft">Consultorio {TENANT_STATUS_LABEL[m.tenantStatus].toLowerCase()}</Tag>}
      </div>
    </li>
  );
}

export function UserDetailView({ user, actorId }: { user: PlatformUserDetail; actorId: string }) {
  const lines = authStateLines(user.auth);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Link href={USERS_PATH} style={{ fontSize: 13, fontWeight: 600, color: "var(--sky-700)" }}>
        ← Usuarios
      </Link>

      <Card style={{ padding: 24 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <h1 className="k-display" style={{ fontSize: 24, margin: 0, overflowWrap: "anywhere" }}>
            {displayUserName(user.fullName)}
          </h1>
          {user.isPlatformAdmin && <Tag tone="lime">Superadmin</Tag>}
          {user.disabled && <Tag tone="soft">Deshabilitado</Tag>}
          {user.id === actorId && <Tag tone="sky">Sos vos</Tag>}
        </div>
        <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 6, overflowWrap: "anywhere" }}>
          {user.email} · {USER_KIND_LABEL[user.kind]} · Alta {formatDateTimeAR(user.createdAt)}
        </div>
        {user.disabled && user.disabledAt && (
          <div style={{ fontSize: 12.5, color: "#9F1F1F", marginTop: 6 }}>Deshabilitado el {formatDateTimeAR(user.disabledAt)}</div>
        )}
      </Card>

      <Card style={{ padding: 20 }}>
        <SectionTitle>Consultorios</SectionTitle>
        {user.memberships.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--navy-500)", margin: 0 }}>No es parte del equipo de ningún consultorio.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {user.memberships.map((m) => (
              <MembershipRow key={m.membershipId} m={m} />
            ))}
          </ul>
        )}
        {user.portalLinkCount > 0 && (
          <p style={{ fontSize: 13, color: "var(--navy-700)", margin: "12px 0 0" }}>
            {portalLinksLabel(user.portalLinkCount)}
            <span style={{ color: "var(--navy-300)" }}> · por privacidad no mostramos cuáles</span>
          </p>
        )}
      </Card>

      <Card style={{ padding: 20 }}>
        <SectionTitle>Cuenta de acceso</SectionTitle>
        <dl style={{ display: "grid", gridTemplateColumns: "minmax(0, max-content) minmax(0, 1fr)", gap: "6px 16px", margin: 0, fontSize: 13 }}>
          {lines.map((l) => (
            <div key={l.label} style={{ display: "contents" }}>
              <dt style={{ color: "var(--navy-500)" }}>{l.label}</dt>
              <dd style={{ margin: 0, color: TONE_COLOR[l.tone], overflowWrap: "anywhere" }}>{l.value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card style={{ padding: "6px 20px 6px" }}>
        <UserActions user={user} actorId={actorId} />
      </Card>
    </div>
  );
}

import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignOutButton, StatusHeading, StatusText } from "@/app/plataforma-mfa/shared";
import { Tag } from "@/components/ui/tag";
import { getAccessSnapshot } from "@/lib/session";
import { getTenantChoiceState, safeChoiceNext } from "@/lib/tenant-choice";
import { tenantOptionRoleLabel } from "@/lib/co-owner-types";
import { VERTICAL_LABEL } from "@/lib/tenant-modules";
import { TenantLogo } from "@/components/layout/tenant-logo";
import { tenantInitials } from "@/lib/person-initials";
import { chooseTenantAction } from "./choose-action";

export const dynamic = "force-dynamic";
export const metadata = { title: "Elegí tu consultorio" };

/**
 * `/elegir-consultorio` (IAM-3a, decisión 6 de Martin del 14-oct): **cada vez que inicia sesión con más de un
 * consultorio usable, la app le pregunta a cuál entrar.** El login borra la cookie `kine_tenant`; el layout de la
 * app ve 2+ opciones sin cookie válida (`needsChoice`) y manda acá con `?next=` (a dónde iba).
 *
 * Fuera de `(app)`: no depende de un Actor. Una card por consultorio con un form cada una (sin JS de cliente: la
 * server action escribe la cookie y redirige). Con una sola opción no hay nada que preguntar → directo a `next`
 * (sin escribir la cookie: con una sola usable `getActor` entra a esa). Sin ninguna → el destino que corresponde
 * (alta o /sin-acceso), que no vuelven acá solos.
 *
 * CF3 (BR-L): cada card con el logo de ESE consultorio (`TenantOption.logoUrl`, de la misma foto: 0 sentencias; la ruta
 * `/api/consultorio/logo?t=` acepta cualquier consultorio usable de la sesión, sin consultorio activo). Sin logo o si
 * no carga, las iniciales de siempre, del mismo tamaño.
 */
export default async function ElegirConsultorioPage({
  searchParams,
}: {
  searchParams: { next?: string; error?: string };
}) {
  const next = safeChoiceNext(typeof searchParams.next === "string" ? searchParams.next : null);
  const snapshot = await getAccessSnapshot();
  if (!snapshot) {
    redirect(`/login?next=${encodeURIComponent(`/elegir-consultorio${next !== "/dashboard" ? `?next=${encodeURIComponent(next)}` : ""}`)}`);
  }
  const { options, activeTenantId, needsChoice } = await getTenantChoiceState();
  if (options.length === 0) {
    redirect(snapshot.state.kind === "needs_onboarding" ? "/onboarding" : "/sin-acceso");
  }
  if (options.length === 1) redirect(next);

  // Decisión 19 (§20): el email nunca hace de nombre. Un perfil viejo con el email en `fullName` cae al genérico.
  const rawFirst = (snapshot.profile?.fullName ?? "").trim().split(/\s+/)[0] || null;
  const firstName = rawFirst && !rawFirst.includes("@") ? rawFirst : null;
  // Con cookie válida (vino a cambiar desde la app) se marca el actual; recién logueado no hay «actual».
  const current = needsChoice ? null : activeTenantId;

  return (
    <AuthShell variant="centered" introAs="p">
      <StatusHeading eyebrow={firstName ? `Hola, ${firstName}` : "Tus consultorios"} title="¿A qué consultorio querés entrar?" />
      <StatusText muted last>
        Trabajás en más de un consultorio. Elegí en cuál entrar; después podés cambiar desde el menú.
      </StatusText>

      {searchParams.error === "no_disponible" && (
        <div role="alert" className="k-alert" style={{ marginBottom: 14 }}>
          Ese consultorio ya no está disponible para tu usuario. Elegí otro.
        </div>
      )}

      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 10 }}>
        {options.map((o) => {
          const isCurrent = o.tenantId === current;
          return (
            <li key={o.tenantId}>
              <form action={chooseTenantAction}>
                <input type="hidden" name="tenantId" value={o.tenantId} />
                <input type="hidden" name="next" value={next} />
                <button
                  type="submit"
                  aria-label={`Entrar a ${o.name}`}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    padding: "14px 16px",
                    borderRadius: "var(--r-lg)",
                    border: isCurrent ? "1.5px solid var(--sky-500)" : "1px solid var(--navy-100)",
                    background: "var(--card-bg)",
                    boxShadow: "var(--shadow-card)",
                    cursor: "pointer",
                    font: "inherit",
                    color: "inherit",
                  }}
                >
                  {o.logoUrl ? (
                    <TenantLogo src={o.logoUrl} size={40} fallback={<InitialsBox name={o.name} />} />
                  ) : (
                    <InitialsBox name={o.name} />
                  )}
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: "block",
                        fontWeight: 600,
                        fontSize: 15,
                        color: "var(--navy-900)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {o.name}
                    </span>
                    <span style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6, alignItems: "center" }}>
                      <Tag tone="lime">{tenantOptionRoleLabel(o)}</Tag>
                      <span style={{ fontSize: 12, color: "var(--navy-500)" }}>{VERTICAL_LABEL[o.vertical]}</span>
                      {isCurrent && <span style={{ fontSize: 12, color: "var(--sky-700)", fontWeight: 600 }}>· Actual</span>}
                    </span>
                  </span>
                  <span aria-hidden style={{ color: "var(--navy-300)", fontSize: 18 }}>
                    →
                  </span>
                </button>
              </form>
            </li>
          );
        })}
      </ul>

      <div style={{ marginTop: 8 }}>
        <SignOutButton />
      </div>
    </AuthShell>
  );
}

/**
 * Las iniciales en su caja de 40 px (la misma que ocupa el logo: sin salto si no carga). Decorativa. CF3 (ZF4b): la
 * misma regla que el selector del sidebar (`lib/person-initials.ts`); antes era una copia literal acá.
 */
function InitialsBox({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      style={{
        flex: "0 0 auto",
        width: 40,
        height: 40,
        borderRadius: "var(--r-md)",
        display: "grid",
        placeItems: "center",
        fontWeight: 700,
        fontSize: 15,
        background: "var(--sky-100)",
        color: "var(--sky-700)",
      }}
    >
      {tenantInitials(name)}
    </span>
  );
}

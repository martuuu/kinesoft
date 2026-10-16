import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ProfileChangeForm, SignOutEverywhereForm } from "@/components/portal/profile-change-form";
import { loadPortalProfile } from "@/lib/portal-profile-internal";
import { PORTAL_PROFILE_FIELD_LABELS } from "@/lib/portal-profile-types";
import { BRAND_NAME } from "@/lib/brand";

export const dynamic = "force-dynamic";
export const metadata = { title: `Mi cuenta · ${BRAND_NAME}` };

/*
 * VX2-f (D-VX28): textos de 12 px mínimo, filas y botones con 44 px de alto, `Button` del design system con `block`.
 *
 * ES4 S24d («Mis datos»):
 *   - lee `loadPortalProfile()` (fichas VINCULADAS por userId, `PortalProfileDTO`), ya no `getPortalAuth()`;
 *   - «Reservar turno» solo con el turnero abierto (`canBook` = `turneroPublico` y consultorio abierto): antes salía
 *     siempre y llevaba a un turnero cerrado;
 *   - por consultorio, el pedido de cambio de datos (inline, ES4-D8) y el aviso de pedidos abiertos con los NOMBRES de
 *     los campos (los valores no se muestran: lo que vale es lo que el consultorio apruebe);
 *   - «Cerrar sesión en todos lados» (`signOut({ scope: "global" })`).
 */

const overline: React.CSSProperties = {
  fontSize: 12,
  color: "var(--sky-700)",
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

function pendingDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "numeric",
    month: "long",
  });
}

export default async function PortalMe() {
  const profile = await loadPortalProfile();
  if (!profile) redirect("/portal");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 className="k-display" style={{ fontSize: 26, margin: 0 }}>
        Mi cuenta
      </h1>

      <Card glass style={{ padding: 18 }}>
        <div style={overline}>Email</div>
        <div style={{ fontSize: 16, fontWeight: 700, overflowWrap: "anywhere" }}>{profile.email}</div>
        {profile.fullName && <div style={{ fontSize: 13, color: "var(--navy-500)" }}>{profile.fullName}</div>}
      </Card>

      <Card style={{ padding: 18 }}>
        <h2 className="k-display" style={{ fontSize: 14, fontWeight: 700, margin: "0 0 10px" }}>
          Tus consultorios
        </h2>
        {profile.tenants.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--navy-500)" }}>Ninguno todavía.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {profile.tenants.map((t) => {
              const pending = profile.pending.find((p) => p.slug === t.slug);
              return (
                <section
                  key={t.slug}
                  aria-label={t.name}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    background: "rgba(246,249,253,0.7)",
                    border: "1px solid rgba(15,30,51,0.06)",
                  }}
                >
                  <div
                    style={{
                      minHeight: 44,
                      gap: 12,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{t.name}</div>
                      <div style={{ fontSize: 12, color: "var(--navy-500)" }}>Ficha: {t.patientName}</div>
                    </div>
                    {t.canBook && (
                      <Link
                        href={`/c/${t.slug}/booking`}
                        style={{
                          color: "var(--sky-700)",
                          fontSize: 13,
                          fontWeight: 600,
                          flexShrink: 0,
                          minHeight: 44,
                          display: "inline-flex",
                          alignItems: "center",
                          textDecoration: "none",
                        }}
                      >
                        Reservar turno →
                      </Link>
                    )}
                  </div>
                  {pending && (
                    <p role="status" style={{ fontSize: 13, margin: "4px 0", lineHeight: 1.5 }}>
                      Pediste cambiar: {pending.fields.map((f) => PORTAL_PROFILE_FIELD_LABELS[f] ?? f).join(", ")}{" "}
                      (el {pendingDate(pending.updatedAt)}). El consultorio todavía lo tiene que revisar.
                    </p>
                  )}
                  <ProfileChangeForm slug={t.slug} tenantName={t.name} />
                </section>
              );
            })}
          </div>
        )}
      </Card>

      <form action="/api/auth/sign-out?next=/portal" method="post">
        <Button variant="ghost" size="md" block type="submit">
          Cerrar sesión
        </Button>
      </form>
      <SignOutEverywhereForm />
    </div>
  );
}

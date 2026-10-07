import { KineLogo } from "@/components/ui/kine-logo";
import { Card } from "@/components/ui/card";
import { IconClock } from "@/components/ui/icons";
import type { PublicClinicContact } from "@/lib/public-booking-internal";

/**
 * `/c/[slug]/booking` con los turnos online apagados (EV0, `publicBookingEnabled`
 * opt-in). Server component sin estado: el link del turnero ya puede estar
 * circulando y un 404 parece un link roto, así que se dice qué pasa y por dónde
 * pedir el turno. Solo muestra el contacto que el consultorio publicó; sin
 * contacto cargado, el texto no promete un canal que no existe.
 */
export function BookingUnavailable({ contact }: { contact: PublicClinicContact }) {
  const channels: { label: string; value: string; href: string }[] = [];
  if (contact.whatsapp) {
    const digits = contact.whatsapp.replace(/\D/g, "");
    if (digits) channels.push({ label: "WhatsApp", value: contact.whatsapp, href: `https://wa.me/${digits}` });
  }
  if (contact.phone) {
    channels.push({ label: "Teléfono", value: contact.phone, href: `tel:${contact.phone.replace(/[^\d+]/g, "")}` });
  }
  if (contact.email) {
    channels.push({ label: "Email", value: contact.email, href: `mailto:${contact.email}` });
  }

  return (
    <div
      className="k-app"
      style={{
        minHeight: "100vh",
        background: "var(--bg-app)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        className="k-glass"
        style={{
          margin: "18px 16px 0",
          padding: "12px 20px",
          borderRadius: 999,
          display: "flex",
          alignItems: "center",
          gap: 12,
          minWidth: 0,
        }}
      >
        <KineLogo size={24} />
        <span
          style={{
            fontSize: 12,
            color: "var(--navy-300)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          · {contact.name}
        </span>
      </header>

      <main style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
        <Card glass style={{ padding: 32, borderRadius: 24, maxWidth: 480, width: "100%", textAlign: "center" }}>
          <div
            aria-hidden
            style={{
              width: 56,
              height: 56,
              margin: "0 auto",
              borderRadius: 18,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--sky-100)",
              color: "var(--sky-700)",
            }}
          >
            <IconClock size={26} />
          </div>
          <h1 className="k-display" style={{ fontSize: 24, margin: "16px 0 8px", letterSpacing: "-0.02em" }}>
            Turnos online no disponibles
          </h1>
          <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0 }}>
            {channels.length > 0
              ? `${contact.name} no está tomando turnos online. Escribiles o llamalos para pedir tu turno.`
              : `${contact.name} no está tomando turnos online. Comunicate directamente con el consultorio para pedir tu turno.`}
          </p>

          {channels.length > 0 && (
            <ul
              style={{
                listStyle: "none",
                margin: "22px 0 0",
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: 8,
                textAlign: "left",
              }}
            >
              {channels.map((c) => (
                <li key={c.label}>
                  <a
                    href={c.href}
                    {...(c.href.startsWith("https://") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 12,
                      padding: "12px 16px",
                      borderRadius: "var(--r-md)",
                      background: "rgba(255,255,255,0.5)",
                      border: "1px solid rgba(15,30,51,0.06)",
                      textDecoration: "none",
                      color: "var(--navy-900)",
                    }}
                  >
                    <span style={{ fontSize: 12, color: "var(--navy-500)" }}>{c.label}</span>
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: "var(--sky-700)",
                        // Un email largo con nowrap+ellipsis quedaba cortado en
                        // mobile y el paciente no podía leerlo: se parte donde
                        // haga falta (revisión EV0).
                        overflowWrap: "anywhere",
                        textAlign: "right",
                        minWidth: 0,
                      }}
                    >
                      {c.value}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </main>
    </div>
  );
}

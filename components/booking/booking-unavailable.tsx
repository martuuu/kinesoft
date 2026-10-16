import Link from "next/link";
import type { ReactNode } from "react";
import { KineLogo } from "@/components/ui/kine-logo";
import { IconClock } from "@/components/ui/icons";
import { BRAND_NAME } from "@/lib/brand";
import { cn } from "@/lib/cn";
import type { PublicClinicContact } from "@/lib/public-booking-internal";
import s from "./booking-result.module.css";

/** Hasta dos iniciales del nombre del consultorio (letras/números), para el monograma de la marca. */
export function clinicInitials(name: string): string {
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/**
 * [VX2-d2] Marco «centered» del turnero (resultado del pago, turnos apagados, error del segmento). Server-safe (sin
 * hooks ni "use client"): lo montan este server component, `BookingResult` (cliente) y `app/(booking)/error.tsx`.
 *
 * Arriba va la marca DEL CONSULTORIO (monograma + nombre): el paciente llegó por el link del consultorio y no sabe qué
 * es KineSoft; KineSoft queda chico en el pie. Sin `clinicName` (el error del segmento no lo conoce) va el logo de la
 * app. Una sola h1 por página: la pone el contenido de la card; el nombre del consultorio es un `<p>`.
 */
export function BookingFrame({
  clinicName,
  topRight,
  narrow = false,
  children,
}: {
  clinicName?: string | null;
  topRight?: ReactNode;
  /** Card de 460 (estados cortos) en vez de 520 (resultado con detalle). */
  narrow?: boolean;
  children: ReactNode;
}) {
  const initials = clinicName ? clinicInitials(clinicName) : "";
  return (
    <div className={s.page} data-surface="turnero">
      <header className={s.top}>
        {clinicName ? (
          <div className={s.brand}>
            {initials && (
              <span className={s.mono} aria-hidden="true">
                {initials}
              </span>
            )}
            <p className={s.clinic}>{clinicName}</p>
          </div>
        ) : (
          <KineLogo size={32} />
        )}
        {topRight}
      </header>
      <main id="main" className={s.main}>
        <div className={cn(s.card, "k-enter", narrow && s.cardNarrow)}>{children}</div>
      </main>
      <footer className={s.foot}>
        {clinicName ? (
          <>
            <span>Turnos online con</span>
            <Link href="/" className="k-link" aria-label={`${BRAND_NAME}, inicio`}>
              <KineLogo size={18} />
            </Link>
          </>
        ) : (
          <span>© 2026 {BRAND_NAME}</span>
        )}
      </footer>
    </div>
  );
}

/** Link «Reservar otro turno» de arriba a la derecha (resultado y error). */
export function BookAgainLink({ slug }: { slug: string }) {
  return (
    <Link href={`/c/${slug}/booking`} className={cn("k-link", s.topLink)}>
      Reservar otro turno
    </Link>
  );
}

/**
 * `/c/[slug]/booking` con los turnos online apagados (EV0, `publicBookingEnabled`
 * opt-in). Server component sin estado: el link del turnero ya puede estar
 * circulando y un 404 parece un link roto, así que se dice qué pasa y por dónde
 * pedir el turno. Solo muestra el contacto que el consultorio publicó; sin
 * contacto cargado, el texto no promete un canal que no existe.
 */
export function BookingUnavailable({ contact }: { contact: PublicClinicContact }) {
  const channels: { label: string; value: string; href: string }[] = [];
  // Es el WhatsApp DEL CONSULTORIO (canal de contacto que cargó el consultorio), no una función de la app (§3.4).
  if (contact.whatsapp) { // claim-ok: prisma/schema.prisma:58
    const digits = contact.whatsapp.replace(/\D/g, ""); // claim-ok: prisma/schema.prisma:58
    if (digits) channels.push({ label: "WhatsApp", value: contact.whatsapp, href: `https://wa.me/${digits}` }); // claim-ok: prisma/schema.prisma:58
  }
  if (contact.phone) {
    channels.push({ label: "Teléfono", value: contact.phone, href: `tel:${contact.phone.replace(/[^\d+]/g, "")}` });
  }
  if (contact.email) {
    channels.push({ label: "Email", value: contact.email, href: `mailto:${contact.email}` });
  }

  return (
    <BookingFrame clinicName={contact.name} narrow>
      <div className={cn(s.icon, s.iconPending)} aria-hidden="true">
        <IconClock size={28} />
      </div>
      <h1 className={cn("k-display", s.title)}>Turnos online no disponibles</h1>
      <p className={s.lead}>
        {channels.length > 0
          ? `${contact.name} no está tomando turnos online. Escribiles o llamalos para pedir tu turno.`
          : `${contact.name} no está tomando turnos online. Comunicate directamente con el consultorio para pedir tu turno.`}
      </p>

      {channels.length > 0 && (
        <ul className={s.channels}>
          {channels.map((c) => (
            <li key={c.label}>
              <a
                href={c.href}
                className={s.channel}
                {...(c.href.startsWith("https://") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              >
                <span className={s.channelLabel}>{c.label}</span>
                <span className={s.channelValue}>{c.value}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </BookingFrame>
  );
}

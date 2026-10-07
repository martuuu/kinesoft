import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicClinic } from "@/lib/public-booking";
import { getPublicBookingGate, loadPublicBookingPage } from "@/lib/public-booking-internal";
import { PublicBookingWizard } from "@/components/booking/public-booking-wizard";
import { BookingUnavailable } from "@/components/booking/booking-unavailable";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const gate = await getPublicBookingGate(params.slug);
  if (gate?.state === "closed") {
    // Turnero apagado (EV0): que los buscadores no indexen una página sin reserva.
    return { title: `Turnos online · ${gate.contact.name}`, robots: { index: false, follow: false } };
  }
  const clinic = gate ? await getPublicClinic(params.slug) : null;
  return { title: clinic ? `Reservar turno · ${clinic.name}` : "Reservar turno · KineSoft" };
}

export default async function PublicBookingPage({ params }: { params: { slug: string } }) {
  // Loader en lib/ (testeado en tests/integration/public-booking-disabled.test.ts):
  // con el turnero cerrado no lee la sesión ni hace el prefill de PII.
  const data = await loadPublicBookingPage(params.slug);
  if (!data) notFound();
  if (data.state === "closed") return <BookingUnavailable contact={data.contact} />;

  return <PublicBookingWizard clinic={data.clinic} session={data.session} prefill={data.prefill} />;
}

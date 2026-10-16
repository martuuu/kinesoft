import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { getPublicClinic } from "@/lib/public-booking";
import { getPublicBookingGate, loadPublicBookingPage } from "@/lib/public-booking-internal";
import { PublicBookingWizard } from "@/components/booking/public-booking-wizard";
import { BookingUnavailable } from "@/components/booking/booking-unavailable";
import { visibleOAuthProviders } from "@/lib/oauth-providers-public";
import { withSearchParams } from "@/lib/public-booking-links";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const gate = await getPublicBookingGate(params.slug);
  // Slug viejo (BO2-D): la página redirige; que nadie indexe la URL vieja.
  if (gate?.state === "moved") return { robots: { index: false, follow: false } };
  if (gate?.state === "closed") {
    // Turnero apagado (EV0): que los buscadores no indexen una página sin reserva.
    return { title: `Turnos online · ${gate.contact.name}`, robots: { index: false, follow: false } };
  }
  const clinic = gate ? await getPublicClinic(params.slug) : null;
  return { title: clinic ? `Reservar turno · ${clinic.name}` : "Reservar turno · KineSoft" };
}

export default async function PublicBookingPage({
  params,
  searchParams = {},
}: {
  params: { slug: string };
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  // Loader en lib/ (testeado en tests/integration/public-booking-disabled.test.ts):
  // con el turnero cerrado no lee la sesión ni hace el prefill de PII.
  const data = await loadPublicBookingPage(params.slug);
  if (!data) notFound();
  // BO2-D (BO-D9): slug viejo → redirect PERMANENTE al vigente. `permanentRedirect` de Next responde 308 (no
  // 301): mismo significado para buscadores y navegadores (permanente, cacheable) y además conserva el método.
  // Un 301 exacto pediría middleware con acceso a la base (edge, sin Prisma): no vale la pena.
  // DIR-2d (C-DIR7): con la query entera. El deep link del directorio (`?pro=<id>`) a un slug viejo perdía el
  // profesional elegido.
  if (data.state === "moved") {
    permanentRedirect(withSearchParams(`/c/${encodeURIComponent(data.slug)}/booking`, searchParams));
  }
  if (data.state === "closed") return <BookingUnavailable contact={data.contact} />;

  // VX-Z (D-VX16): mismo criterio que el login. Solo hace falta sin sesión (con sesión no hay botón de Google), y
  // tiene tope propio de 600 ms: si Supabase tarda, se muestra.
  const googleEnabled = data.session ? true : (await visibleOAuthProviders()).includes("google");
  // DIR-2d: profesional preelegido por el deep link. Solo un string (`?pro=a&pro=b` no es un id); si no es reservable
  // en este consultorio, el wizard lo ignora en silencio (`initialWizardSelection`).
  const pro = typeof searchParams.pro === "string" ? searchParams.pro : null;
  return (
    <PublicBookingWizard
      clinic={data.clinic}
      session={data.session}
      prefill={data.prefill}
      googleEnabled={googleEnabled}
      initialPractitionerId={pro}
    />
  );
}

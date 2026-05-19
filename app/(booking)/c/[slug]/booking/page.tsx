import { notFound } from "next/navigation";
import { getPublicClinic } from "@/lib/public-booking";
import { findPatientByEmailForPrefill } from "@/lib/public-booking-internal";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { PublicBookingWizard } from "@/components/booking/public-booking-wizard";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { slug: string } }) {
  const clinic = await getPublicClinic(params.slug);
  return { title: clinic ? `Reservar turno · ${clinic.name}` : "Reservar turno · KineSoft" };
}

export default async function PublicBookingPage({ params }: { params: { slug: string } }) {
  const clinic = await getPublicClinic(params.slug);
  if (!clinic) notFound();

  // Prefill is only attempted when the user has a verified Supabase
  // session — the `findPatientByEmailForPrefill` helper trusts the email
  // it receives, so we must prove it belongs to the requester first.
  let prefill: Awaited<ReturnType<typeof findPatientByEmailForPrefill>> = null;
  let userEmail: string | null = null;
  let userName: string | null = null;
  try {
    const supabase = getSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user?.email && user.email_confirmed_at) {
      userEmail = user.email;
      userName = (user.user_metadata?.full_name as string | undefined) ?? null;
      prefill = await findPatientByEmailForPrefill(user.email);
    }
  } catch {
    /* Supabase not configured — anonymous flow is the default */
  }

  return (
    <PublicBookingWizard
      clinic={clinic}
      session={userEmail ? { email: userEmail, fullName: userName } : null}
      prefill={prefill}
    />
  );
}

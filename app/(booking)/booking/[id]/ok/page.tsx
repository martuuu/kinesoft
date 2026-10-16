import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getPublicBookingStatus } from "@/lib/public-booking";
import { BookingResult } from "@/components/booking/booking-result";
import { BRAND_NAME } from "@/lib/brand";

export const dynamic = "force-dynamic";
// [VX2-d2] Página de UN turno (id en la URL): no se indexa.
export const metadata: Metadata = { title: `Turno confirmado · ${BRAND_NAME}`, robots: { index: false, follow: false } };

export default async function BookingOkPage({ params }: { params: { id: string } }) {
  const status = await getPublicBookingStatus(params.id);
  if (!status) notFound();
  return <BookingResult initial={status} variant="ok" />;
}

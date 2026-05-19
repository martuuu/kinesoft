import { notFound } from "next/navigation";
import { getPublicBookingStatus } from "@/lib/public-booking";
import { BookingResult } from "@/components/booking/booking-result";

export const dynamic = "force-dynamic";
export const metadata = { title: "Turno confirmado · KineSoft" };

export default async function BookingOkPage({ params }: { params: { id: string } }) {
  const status = await getPublicBookingStatus(params.id);
  if (!status) notFound();
  return <BookingResult initial={status} variant="ok" />;
}

"use client";

import { RouteError } from "@/components/ui/route-error";

export default function BookingError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError
      kind="booking"
      {...props}
      title="No pudimos cargar la reserva"
    />
  );
}

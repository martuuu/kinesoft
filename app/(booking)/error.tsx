"use client";

import { RouteError } from "@/components/ui/route-error";

export default function BookingError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError
      {...props}
      title="No pudimos cargar la reserva"
    />
  );
}

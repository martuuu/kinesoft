"use client";

import { RouteError } from "@/components/ui/route-error";

export default function PortalError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError
      kind="portal"
      {...props}
      title="No pudimos cargar tu portal"
    />
  );
}

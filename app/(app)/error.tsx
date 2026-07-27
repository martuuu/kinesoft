"use client";

import { RouteError } from "@/components/ui/route-error";

export default function AppSectionError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} />;
}

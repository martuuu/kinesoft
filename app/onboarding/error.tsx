"use client";

import { RouteError } from "@/components/ui/route-error";

/**
 * BO1-D — boundary del alta del consultorio. Es la primera pantalla de un cliente nuevo: si falla, que vea
 * «Reintentar» y que el error nos llegue por el beacon.
 */
export default function OnboardingError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} kind="onboarding" />;
}

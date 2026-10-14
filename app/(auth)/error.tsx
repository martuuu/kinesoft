"use client";

import { RouteError } from "@/components/ui/route-error";

/**
 * BO1-D — boundary de login/signup/forgot/reset. Sin esto, un error de render en auth subía hasta
 * `global-error` (pantalla completa sin layout) y no quedaba reportado.
 */
export default function AuthError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} kind="auth" />;
}

/**
 * Tipos de `lib/public-profile.ts` (DIR-2b). Viven acá porque un archivo `"use server"` exporta solo funciones async
 * (AGENTS §4); el tipo estaba exportado desde la action (revisor A de DIR-Z, public-profile.ts:57).
 */
import type { PublicProfileFields, PublicProfileStatus } from "@/lib/public-profile-logic";

/** Lo que ve la persona de SU perfil (incluye el estado de moderación: es suyo). */
export type MyPublicProfile = {
  /** Para prellenar el nombre público la primera vez (nunca el email: decisión 19). */
  defaultPublicName: string;
  status: PublicProfileStatus;
  profile:
    | (PublicProfileFields & {
        consentVersion: string | null;
        consentAt: string | null;
        hiddenReason: string | null;
        licenseVerified: boolean;
      })
    | null;
};

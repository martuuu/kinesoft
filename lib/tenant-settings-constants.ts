/**
 * Constants extracted from `lib/tenant-settings.ts` because that file
 * is `"use server"` — and Next.js only allows async function exports
 * from server-action modules. Pure values live here so the UI can
 * import them without dragging in the server bundle.
 */

export const BUSINESS_HOUR_MIN = 6;
export const BUSINESS_HOUR_MAX = 23;

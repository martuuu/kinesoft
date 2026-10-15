/**
 * [VX F-b1] Shim de compatibilidad: AuthShell v2 vive en `components/auth/auth-shell.tsx` (C-F4). Los 13
 * consumidores de hoy importan desde acá y compilan sin cambios (default `variant="split"`, D-VX21). VX2 los migra
 * al import nuevo y VX-Z borra este archivo.
 */
export { AuthShell } from "@/components/auth/auth-shell";
export type { AuthShellProps, AuthShellVariant } from "@/components/auth/auth-shell";

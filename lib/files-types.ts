import type { PatientFileCategory } from "@prisma/client";

export type PatientFileRow = {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  category: PatientFileCategory;
  description: string | null;
  createdAt: Date;
  hasDownload: boolean;
};

/**
 * Subida firmada de archivos del paciente (T4 FC-4b, contrato C-FC10; brief §24.8). El tope viejo de 25 MB era
 * inalcanzable: el body de una server action en Vercel corta en 4,5 MB (`next.config.mjs`). Ahora el navegador sube
 * directo a Storage con una URL firmada (prefijo `pending/`) y el server confirma con un token HMAC.
 *
 * `{ mode: "stub" }`: sin Storage configurado (dev/CI) la UI cae al camino de siempre, como el resto de `lib/files.ts`.
 */
export const PATIENT_FILE_MAX_BYTES = 25 * 1024 * 1024; export const PATIENT_FILE_UPLOAD_TTL_S = 900;
export type PatientFileUploadTicket = { mode: "signed"; uploadUrl: string; confirmToken: string; expiresAt: string } | { mode: "stub" };
/**
 * Lo que firma el token de confirmación (`lib/patient-file-upload-token.ts`). La clave de Storage se deriva de estos
 * claims, nunca de algo que mande el cliente al confirmar.
 */
export type PatientFileUploadClaims = { tenantId: string; patientId: string; fileId: string; mime: string; sizeBytes: number; category: PatientFileCategory; fileName: string; userId: string; exp: number };

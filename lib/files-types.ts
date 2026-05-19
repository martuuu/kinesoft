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

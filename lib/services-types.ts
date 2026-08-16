export type ServiceRow = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  durationMin: number;
  priceCents: number;
  practitionerId: string | null;
  practitionerName: string | null;
  /** Cupos simultáneos por horario; null = ilimitado. */
  maxConcurrent: number | null;
  bookingsCount: number;
};

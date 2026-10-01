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
  /** Práctica del catálogo global que representa (B1.4); null = servicio libre. */
  practiceId: string | null;
  practiceName: string | null;
};

export type ServiceRow = {
  id: string;
  name: string;
  description: string | null;
  durationMin: number;
  priceCents: number;
  practitionerId: string | null;
  practitionerName: string | null;
  bookingsCount: number;
};

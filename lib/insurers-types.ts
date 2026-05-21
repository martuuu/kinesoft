export type InsurerRow = {
  id: string;
  name: string;
  copagoCents: number;
  fixedFeeCents: number;
  active: boolean;
  notes: string | null;
  patientsCount: number;
  createdAt: Date;
};

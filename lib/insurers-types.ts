export type InsurerRow = {
  id: string;
  name: string;
  copagoCents: number;
  fixedFeeCents: number;
  /** The special out-of-pocket row — can't be deleted; price is editable. */
  isParticular: boolean;
  active: boolean;
  notes: string | null;
  patientsCount: number;
  createdAt: Date;
};

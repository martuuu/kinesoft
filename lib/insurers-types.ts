export type InsurerRow = {
  id: string;
  name: string;
  copagoCents: number;
  fixedFeeCents: number;
  /** The special out-of-pocket row — can't be deleted; price is editable. */
  isParticular: boolean;
  active: boolean;
  notes: string | null;
  /** Prestadora del catálogo global a la que está vinculada (B1.4); null = sin vincular. */
  payerId: string | null;
  payerName: string | null;
  patientsCount: number;
  createdAt: Date;
};

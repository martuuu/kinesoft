export type PlanTemplateRow = {
  id: string;
  name: string;
  description: string | null;
  totalSessions: number;
  frequency: number;
  exerciseCount: number;
  createdAt: Date;
};

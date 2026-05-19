export type OpenSessionRow = {
  id: string;
  index: number;
  scheduledFor: Date;
  completedAt: Date | null;
  patientId: string;
  patientName: string;
  programTitle: string;
  totalSessions: number;
  exerciseCount: number;
  doneCount: number;
};

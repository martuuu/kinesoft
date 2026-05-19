import type { NotificationKind } from "@prisma/client";

export type NotificationRow = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
};

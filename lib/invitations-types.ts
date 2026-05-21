import type { Role } from "@prisma/client";

export type InvitationRow = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  specialty: string | null;
  invitedAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  url: string | null; // present only on freshly created invitations
};

export type TeamMemberRow = {
  membershipId: string;
  userId: string;
  email: string;
  fullName: string | null;
  role: Role;
  specialty: string | null;
  joinedAt: Date | null;
  isYou: boolean;
};

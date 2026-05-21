-- CreateEnum
CREATE TYPE "ExerciseKind" AS ENUM ('EXERCISE', 'MANUAL_THERAPY');

-- AlterTable
ALTER TABLE "Coverage" ADD COLUMN     "insurerId" TEXT;

-- AlterTable
ALTER TABLE "Exercise" ADD COLUMN     "kind" "ExerciseKind" NOT NULL DEFAULT 'EXERCISE';

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "assignedPractitionerId" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "sharedPatientView" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Insurer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "copagoCents" INTEGER NOT NULL DEFAULT 0,
    "fixedFeeCents" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Insurer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'PRACTITIONER',
    "specialty" TEXT,
    "token" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Insurer_tenantId_idx" ON "Insurer"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Insurer_tenantId_name_key" ON "Insurer"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_token_key" ON "Invitation"("token");

-- CreateIndex
CREATE INDEX "Invitation_tenantId_idx" ON "Invitation"("tenantId");

-- CreateIndex
CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");

-- CreateIndex
CREATE INDEX "Coverage_insurerId_idx" ON "Coverage"("insurerId");

-- CreateIndex
CREATE INDEX "Exercise_kind_idx" ON "Exercise"("kind");

-- CreateIndex
CREATE INDEX "Patient_tenantId_assignedPractitionerId_idx" ON "Patient"("tenantId", "assignedPractitionerId");

-- AddForeignKey
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_assignedPractitionerId_fkey" FOREIGN KEY ("assignedPractitionerId") REFERENCES "Practitioner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Coverage" ADD CONSTRAINT "Coverage_insurerId_fkey" FOREIGN KEY ("insurerId") REFERENCES "Insurer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Insurer" ADD CONSTRAINT "Insurer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "TenantPlan" AS ENUM ('FREE', 'STARTER', 'PRO', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCELLED');

-- AlterTable
ALTER TABLE "Exercise" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "isBasic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "plan" "TenantPlan" NOT NULL DEFAULT 'FREE',
ADD COLUMN     "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "trialEndsAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Favorite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "exerciseId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Favorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "totalSessions" INTEGER NOT NULL DEFAULT 10,
    "frequency" INTEGER NOT NULL DEFAULT 2,
    "exerciseIds" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Favorite_tenantId_userId_idx" ON "Favorite"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Favorite_userId_exerciseId_key" ON "Favorite"("userId", "exerciseId");

-- CreateIndex
CREATE INDEX "PlanTemplate_tenantId_authorId_idx" ON "PlanTemplate"("tenantId", "authorId");

-- CreateIndex
CREATE INDEX "Exercise_tenantId_idx" ON "Exercise"("tenantId");

-- CreateIndex
CREATE INDEX "Exercise_isBasic_idx" ON "Exercise"("isBasic");

-- AddForeignKey
ALTER TABLE "Exercise" ADD CONSTRAINT "Exercise_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "Exercise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanTemplate" ADD CONSTRAINT "PlanTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanTemplate" ADD CONSTRAINT "PlanTemplate_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Practitioner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Exercise" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "durationSeconds" INTEGER,
ALTER COLUMN "defaultSets" DROP NOT NULL,
ALTER COLUMN "defaultSets" DROP DEFAULT,
ALTER COLUMN "defaultReps" DROP NOT NULL,
ALTER COLUMN "defaultReps" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "Exercise_archivedAt_idx" ON "Exercise"("archivedAt");

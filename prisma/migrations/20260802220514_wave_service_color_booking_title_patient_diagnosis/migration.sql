-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "description" TEXT,
ADD COLUMN     "title" TEXT;

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "diagnosisNote" TEXT,
ADD COLUMN     "diagnosisTitle" TEXT;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "color" TEXT;

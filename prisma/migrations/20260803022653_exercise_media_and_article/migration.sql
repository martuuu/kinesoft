-- CreateEnum
CREATE TYPE "ExerciseMediaType" AS ENUM ('VIDEO', 'IMAGE', 'GIF', 'YOUTUBE');

-- CreateTable
CREATE TABLE "ExerciseMedia" (
    "id" TEXT NOT NULL,
    "exerciseId" TEXT NOT NULL,
    "type" "ExerciseMediaType" NOT NULL,
    "url" TEXT NOT NULL,
    "caption" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExerciseMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExerciseArticle" (
    "id" TEXT NOT NULL,
    "exerciseId" TEXT NOT NULL,
    "title" TEXT,
    "subtitle" TEXT,
    "focus" TEXT,
    "readingMinutes" INTEGER,
    "bodyMarkdown" TEXT,
    "references" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExerciseArticle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExerciseMedia_exerciseId_order_idx" ON "ExerciseMedia"("exerciseId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "ExerciseArticle_exerciseId_key" ON "ExerciseArticle"("exerciseId");

-- AddForeignKey
ALTER TABLE "ExerciseMedia" ADD CONSTRAINT "ExerciseMedia_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "Exercise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExerciseArticle" ADD CONSTRAINT "ExerciseArticle_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "Exercise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── RLS: global catalog content (no tenantId) ────────────────────────
-- ExerciseMedia / ExerciseArticle belong to the global catalog and carry no
-- tenantId — visibility is inherited from the parent Exercise, gated at the
-- app layer (getExercise). Posture: READ = anyone (the app role needs it under
-- runWithRls); WRITE = nobody via the app role — only the BYPASSRLS service
-- channel (superadmin authoring) writes. FORCE so even the owner obeys the
-- policies (the superuser/BYPASSRLS service role bypasses regardless).
ALTER TABLE "ExerciseMedia" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExerciseMedia" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS exercise_media_read ON "ExerciseMedia";
CREATE POLICY exercise_media_read ON "ExerciseMedia" FOR SELECT USING (true);

ALTER TABLE "ExerciseArticle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExerciseArticle" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS exercise_article_read ON "ExerciseArticle";
CREATE POLICY exercise_article_read ON "ExerciseArticle" FOR SELECT USING (true);

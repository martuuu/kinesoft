-- CreateIndex
CREATE INDEX "Booking_patientId_scheduledFor_idx" ON "Booking"("patientId", "scheduledFor");

-- CreateIndex
CREATE INDEX "Session_programId_index_idx" ON "Session"("programId", "index");

-- CreateIndex
CREATE INDEX "Session_completedAt_idx" ON "Session"("completedAt");

-- CreateIndex
CREATE INDEX "TreatmentProgram_patientId_createdAt_idx" ON "TreatmentProgram"("patientId", "createdAt");

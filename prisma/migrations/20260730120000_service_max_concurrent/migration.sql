-- Per-service overlap capacity. NULL = unlimited (default): overlapping turnos
-- are the norm in kinesiología (several patients in the same time band). Set to
-- 1 for single-occupancy services (osteopatía = one per hour), or N for a cap.
-- Existing services get NULL → unlimited, so overlaps stop being blocked.
ALTER TABLE "Service" ADD COLUMN "maxConcurrent" INTEGER;

/**
 * Diagnosis matching engine — pure, client-safe.
 *
 * Lives in its own file (no `"use server"`) so it can run in the browser
 * for the live preview while the practitioner refines the case, AND on
 * the server when persisting the case authoritatively. No Prisma import,
 * no Node-only APIs — every input arrives as a `CatalogDTO`.
 *
 * Server actions that hit Prisma live in `lib/diagnosis.ts` and import
 * from this file.
 */
import type { AnatomicalView, AnatomyRole, ExerciseRelation, ProgramPhase } from "@prisma/client";

// ──────────────────────────────────────────────────────────────────────
// Catalog DTOs
// ──────────────────────────────────────────────────────────────────────

export type RegionDTO = {
  slug: string;
  label: string;
  view: AnatomicalView;
  side: "LEFT" | "RIGHT" | "CENTER";
  parentSlug: string | null;
  tagSlug: string | null;
  shape: "RECT" | "ELLIPSE" | "PATH";
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  rx: number | null;
  ry: number | null;
  path: string | null;
};

export type CatalogConditionDTO = {
  id: string;
  slug: string;
  cie10: string | null;
  name: string;
  summary: string | null;
  severity: "MILD" | "MODERATE" | "SEVERE" | null;
  recoveryWeeksMin: number | null;
  recoveryWeeksMax: number | null;
  mechanism: string | null;
  redFlags: string | null;
  tags: { slug: string; label: string; kind: string; weight: number }[];
  anatomy: { regionSlug: string; role: AnatomyRole }[];
  exercises: {
    exerciseId: string;
    slug: string;
    name: string;
    relation: ExerciseRelation;
    phase: ProgramPhase;
    weight: number;
    rationale: string | null;
    muscleGroups: string | null;
    equipment: string | null;
    defaultSets: number;
    defaultReps: number;
    difficulty: number;
  }[];
};

export type ChipChoice = { slug: string; label: string };

export type CatalogDTO = {
  regions: RegionDTO[];
  conditions: CatalogConditionDTO[];
  symptoms: ChipChoice[];
  triggers: ChipChoice[];
  phases: ChipChoice[];
};

export type CaseSelection = {
  regions: string[];        // region slugs marked as painful
  symptoms: string[];       // tag slugs of kind SYMPTOM
  triggers: string[];       // tag slugs of kind TRIGGER
  phase: string | null;     // tag slug of kind PHASE (or null)
  intensity: number;        // 0..10
};

export type Ranking = {
  conditionId: string;
  slug: string;
  name: string;
  cie10: string | null;
  matchScore: number;       // 0..1
  primaryMatches: string[]; // region slugs that contributed primary score
  relatedRegions: string[]; // region slugs surfaced as kinematic-chain hints
  reasons: string[];        // human-readable signals that fired
};

const RELATION_ORDER: Record<ExerciseRelation, number> = {
  DIRECT: 0,
  INDIRECT: 1,
  ANTAGONIST: 2,
  PREVENTIVE: 3,
};
const PHASE_ORDER: Record<ProgramPhase, number> = {
  ACTIVATION: 0,
  STABILITY: 1,
  LOAD: 2,
  PROGRESSION: 3,
};

/**
 * Rank conditions for a given selection. The score combines:
 *   - tag overlap (weighted)
 *   - anatomy overlap (PRIMARY x3, SECONDARY x1.5, RELATED x0.5)
 *   - intensity boost (0.7 at intensity 0 → 1.15 at intensity 10)
 *   - phase boost (chronic 1.10, acute 1.05)
 *   - specificity penalty: subtract for noise (regions selected that the
 *     condition does not touch via PRIMARY/SECONDARY/RELATED).
 */
export function rankSelection(
  selection: CaseSelection,
  catalog: CatalogDTO
): Ranking[] {
  const regionTagSlugs = new Set<string>();
  const regionsSet = new Set(selection.regions);
  for (const r of catalog.regions) {
    if (regionsSet.has(r.slug) && r.tagSlug) regionTagSlugs.add(r.tagSlug);
  }
  const selectedTagSlugs = new Set<string>([
    ...regionTagSlugs,
    ...selection.symptoms,
    ...selection.triggers,
    ...(selection.phase ? [selection.phase] : []),
  ]);
  const intensityBoost = 0.7 + (selection.intensity / 10) * 0.45; // 0.7..1.15
  const phaseBoost =
    selection.phase === "phase-chronic" ? 1.1 : selection.phase === "phase-acute" ? 1.05 : 1;

  const ranked: Ranking[] = catalog.conditions.map((c) => {
    const totalTagWeight = c.tags.reduce((s, t) => s + t.weight, 0) || 1;
    let tagScore = 0;
    const tagReasons: string[] = [];
    for (const t of c.tags) {
      if (selectedTagSlugs.has(t.slug)) {
        tagScore += t.weight;
        tagReasons.push(t.label);
      }
    }

    // Anatomy contribution.
    let anatomyScore = 0;
    let anatomyTotal = 0;
    const primaryMatches: string[] = [];
    const relatedRegions: string[] = [];
    for (const a of c.anatomy) {
      const w = a.role === "PRIMARY" ? 3 : a.role === "SECONDARY" ? 1.5 : 0.5;
      anatomyTotal += w;
      if (regionsSet.has(a.regionSlug)) {
        anatomyScore += w;
        if (a.role === "PRIMARY") primaryMatches.push(a.regionSlug);
      }
      if (a.role === "RELATED") relatedRegions.push(a.regionSlug);
    }
    const anatomyRatio = anatomyTotal ? anatomyScore / anatomyTotal : 0;
    const tagRatio = tagScore / totalTagWeight;

    // Specificity penalty.
    const conditionRegionSet = new Set(c.anatomy.map((a) => a.regionSlug));
    const noise =
      selection.regions.filter((r) => !conditionRegionSet.has(r)).length /
      Math.max(selection.regions.length, 1);
    const noisePenalty = 1 - 0.25 * noise;

    const raw =
      (tagRatio * 0.55 + anatomyRatio * 0.45) *
      intensityBoost *
      phaseBoost *
      noisePenalty;

    const matchScore = Math.max(0, Math.min(1, raw));

    return {
      conditionId: c.id,
      slug: c.slug,
      name: c.name,
      cie10: c.cie10,
      matchScore,
      primaryMatches,
      relatedRegions,
      reasons: tagReasons,
    };
  });

  return ranked.filter((r) => r.matchScore > 0).sort((a, b) => b.matchScore - a.matchScore);
}

/** Exercises for a confirmed condition, sorted DIRECT→INDIRECT, then by phase, then by weight. */
export function exercisesFor(
  conditionSlug: string,
  catalog: CatalogDTO
): CatalogConditionDTO["exercises"] {
  const c = catalog.conditions.find((x) => x.slug === conditionSlug);
  if (!c) return [];
  return [...c.exercises].sort(
    (a, b) =>
      RELATION_ORDER[a.relation] - RELATION_ORDER[b.relation] ||
      PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] ||
      b.weight - a.weight
  );
}

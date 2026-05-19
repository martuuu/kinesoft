/**
 * Diagnosis matching engine — pure functions over the catalog.
 *
 * Given a set of selected tag slugs (zones, sub-zones, symptoms, triggers,
 * phase, intensity), compute the ranked list of candidate conditions and a
 * de-duplicated, ranked list of exercises split by relation (DIRECT |
 * INDIRECT | ANTAGONIST).
 *
 * The function is deliberately framework-free so it can be reused in the
 * upcoming AI override engine, in unit tests, and on the client for live
 * preview as the practitioner refines selections.
 */
export type CaseSelection = {
  zones: string[];           // tag slugs
  subZones: string[];
  symptoms: string[];
  triggers: string[];
  phase?: "acute" | "subacute" | "chronic";
  intensity?: number;        // 0..10
};

export type CatalogCondition = {
  id: string;
  cie10?: string | null;
  slug: string;
  name: string;
  summary?: string | null;
  tags: { tagSlug: string; weight: number }[];
  exercises: { exerciseId: string; relation: ExerciseRelation; weight: number; rationale?: string | null }[];
};

export type ExerciseRelation = "DIRECT" | "INDIRECT" | "ANTAGONIST" | "PREVENTIVE";

export type Ranking = {
  conditionId: string;
  matchScore: number;        // 0..1
  matchedTags: string[];
  relatedTags: string[];
};

export function rankConditions(
  selection: CaseSelection,
  conditions: CatalogCondition[]
): Ranking[] {
  const selected = new Set<string>([
    ...selection.zones,
    ...selection.subZones,
    ...selection.symptoms,
    ...selection.triggers,
  ]);
  const intensityBoost =
    selection.intensity != null ? 0.5 + selection.intensity / 20 : 1; // 0.5..1.0 → mild..severe
  const phaseBoost = selection.phase === "chronic" ? 1.1 : selection.phase === "acute" ? 1.05 : 1;

  const results: Ranking[] = conditions.map((c) => {
    const totalWeight = c.tags.reduce((s, t) => s + t.weight, 0) || 1;
    let scored = 0;
    const matched: string[] = [];
    const related: string[] = [];
    for (const t of c.tags) {
      if (selected.has(t.tagSlug)) {
        scored += t.weight;
        matched.push(t.tagSlug);
      } else {
        related.push(t.tagSlug);
      }
    }
    const raw = (scored / totalWeight) * intensityBoost * phaseBoost;
    return {
      conditionId: c.id,
      matchScore: Math.min(1, Math.max(0, raw)),
      matchedTags: matched,
      relatedTags: related,
    };
  });

  return results
    .filter((r) => r.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore);
}

export function suggestedExercises(
  condition: CatalogCondition
): { exerciseId: string; relation: ExerciseRelation; weight: number; rationale?: string | null }[] {
  const order: Record<ExerciseRelation, number> = {
    DIRECT: 0,
    INDIRECT: 1,
    ANTAGONIST: 2,
    PREVENTIVE: 3,
  };
  return [...condition.exercises].sort(
    (a, b) => order[a.relation] - order[b.relation] || b.weight - a.weight
  );
}

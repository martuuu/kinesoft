/**
 * KineSoft — catalog + demo-tenant seed.
 *
 * Idempotent (every write is upsert or scoped-then-recreate). Run via
 * `npm run prisma:seed`. The catalog seeded here is production-grade:
 *
 *   - 42 AnatomicalRegions across FRONT + BACK views with SVG geometry,
 *     covering head→toe and L/R/CENTER sides, with `tagSlug` bridging
 *     into the Tag tree so the matching engine treats anatomical hits
 *     and tag hits uniformly.
 *
 *   - 8 zone tags, 18 sub-zone tags, 8 symptom tags, 9 trigger tags,
 *     3 phase tags, 4 chain tags.
 *
 *   - 28 Conditions covering the most common kinesiology presentations
 *     (knee/hip/ankle/shoulder/lumbar/cervical/wrist/elbow), each with
 *     CIE-10, severity, recovery-week range, mechanism, red-flags,
 *     anatomy roles (PRIMARY/SECONDARY/RELATED), and weighted tag links.
 *
 *   - 60 Exercises with instructions, equipment, muscle groups and cues,
 *     and ConditionExerciseLink entries split DIRECT/INDIRECT/ANTAGONIST
 *     across ACTIVATION/STABILITY/LOAD/PROGRESSION phases — enough for
 *     the engine to produce a real, varied plan for every condition.
 *
 * Demo tenant `movare` is seeded after the catalog with 6 patients,
 * 2 active programs (Sofía's ITBS + Eugenio's LCA), 18 bookings spread
 * across past + current + next week, payments and EVA scores.
 */
import {
  PrismaClient,
  TagKind,
  ExerciseRelation,
  ProgramPhase,
  AnatomicalView,
  BodySide,
  ShapeKind,
  AnatomyRole,
  Severity,
  PaymentStatus,
  BookingStatus,
  ProgramStatus,
} from "@prisma/client";

const prisma = new PrismaClient();

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

async function tag(slug: string, label: string, kind: TagKind, parentSlug?: string) {
  const parent = parentSlug ? await prisma.tag.findUnique({ where: { slug: parentSlug } }) : null;
  return prisma.tag.upsert({
    where: { slug },
    create: { slug, label, kind, parentId: parent?.id },
    update: { label, kind, parentId: parent?.id },
  });
}

async function region(
  slug: string,
  label: string,
  view: AnatomicalView,
  side: BodySide,
  shape: ShapeKind,
  geom: { x?: number; y?: number; width?: number; height?: number; rx?: number; ry?: number; path?: string },
  opts: { parentSlug?: string; tagSlug?: string; sortOrder?: number } = {}
) {
  return prisma.anatomicalRegion.upsert({
    where: { slug },
    create: {
      slug,
      label,
      view,
      side,
      shape,
      ...geom,
      parentSlug: opts.parentSlug,
      tagSlug: opts.tagSlug,
      sortOrder: opts.sortOrder ?? 0,
    },
    update: {
      label,
      view,
      side,
      shape,
      ...geom,
      parentSlug: opts.parentSlug,
      tagSlug: opts.tagSlug,
      sortOrder: opts.sortOrder ?? 0,
    },
  });
}

async function condition(input: {
  slug: string;
  cie10?: string;
  name: string;
  summary?: string;
  severity?: Severity;
  recoveryWeeksMin?: number;
  recoveryWeeksMax?: number;
  mechanism?: string;
  redFlags?: string;
}) {
  return prisma.condition.upsert({
    where: { slug: input.slug },
    create: input,
    update: input,
  });
}

async function linkConditionTag(condSlug: string, tagSlug: string, weight = 1) {
  const c = await prisma.condition.findUnique({ where: { slug: condSlug } });
  const t = await prisma.tag.findUnique({ where: { slug: tagSlug } });
  if (!c || !t) return;
  await prisma.conditionTag.upsert({
    where: { conditionId_tagId: { conditionId: c.id, tagId: t.id } },
    create: { conditionId: c.id, tagId: t.id, weight },
    update: { weight },
  });
}

async function linkConditionAnatomy(condSlug: string, regionSlug: string, role: AnatomyRole) {
  const c = await prisma.condition.findUnique({ where: { slug: condSlug } });
  if (!c) return;
  await prisma.conditionAnatomy.upsert({
    where: { conditionId_regionSlug_role: { conditionId: c.id, regionSlug, role } },
    create: { conditionId: c.id, regionSlug, role },
    update: {},
  });
}

async function exercise(input: {
  slug: string;
  name: string;
  description?: string;
  defaultSets?: number;
  defaultReps?: number;
  difficulty?: number;
  equipment?: string;
  muscleGroups?: string;
  cues?: string;
  instructions?: string;
}) {
  return prisma.exercise.upsert({
    where: { slug: input.slug },
    create: input,
    update: input,
  });
}

async function linkConditionExercise(
  condSlug: string,
  exSlug: string,
  relation: ExerciseRelation,
  phase: ProgramPhase,
  weight = 1,
  rationale?: string
) {
  const c = await prisma.condition.findUnique({ where: { slug: condSlug } });
  const e = await prisma.exercise.findUnique({ where: { slug: exSlug } });
  if (!c || !e) return;
  await prisma.conditionExerciseLink.upsert({
    where: {
      conditionId_exerciseId_relation: { conditionId: c.id, exerciseId: e.id, relation },
    },
    create: { conditionId: c.id, exerciseId: e.id, relation, phase, weight, rationale },
    update: { phase, weight, rationale },
  });
}

// ──────────────────────────────────────────────────────────────────────
// Tags
// ──────────────────────────────────────────────────────────────────────

async function seedTags() {
  console.log("[seed] tags");

  // Zones
  await tag("zone-knee", "Rodilla", TagKind.ZONE);
  await tag("zone-hip", "Cadera", TagKind.ZONE);
  await tag("zone-ankle", "Tobillo", TagKind.ZONE);
  await tag("zone-shoulder", "Hombro", TagKind.ZONE);
  await tag("zone-elbow", "Codo", TagKind.ZONE);
  await tag("zone-wrist", "Muñeca", TagKind.ZONE);
  await tag("zone-lumbar", "Lumbar", TagKind.ZONE);
  await tag("zone-cervical", "Cervical", TagKind.ZONE);

  // Sub-zones
  await tag("knee-lateral", "Rodilla lateral", TagKind.SUBZONE, "zone-knee");
  await tag("knee-anterior", "Rodilla anterior", TagKind.SUBZONE, "zone-knee");
  await tag("knee-medial", "Rodilla medial", TagKind.SUBZONE, "zone-knee");
  await tag("knee-posterior", "Rodilla posterior", TagKind.SUBZONE, "zone-knee");
  await tag("hip-external", "Cadera externa (trocánter)", TagKind.SUBZONE, "zone-hip");
  await tag("hip-anterior", "Cadera anterior (ingle)", TagKind.SUBZONE, "zone-hip");
  await tag("hip-posterior", "Cadera posterior (glúteo)", TagKind.SUBZONE, "zone-hip");
  await tag("ankle-lateral", "Tobillo lateral", TagKind.SUBZONE, "zone-ankle");
  await tag("ankle-medial", "Tobillo medial", TagKind.SUBZONE, "zone-ankle");
  await tag("ankle-achilles", "Tendón de Aquiles", TagKind.SUBZONE, "zone-ankle");
  await tag("ankle-plantar", "Planta del pie", TagKind.SUBZONE, "zone-ankle");
  await tag("shoulder-anterior", "Hombro anterior", TagKind.SUBZONE, "zone-shoulder");
  await tag("shoulder-posterior", "Hombro posterior", TagKind.SUBZONE, "zone-shoulder");
  await tag("shoulder-superior", "Hombro superior (manguito)", TagKind.SUBZONE, "zone-shoulder");
  await tag("lumbar-central", "Lumbar central", TagKind.SUBZONE, "zone-lumbar");
  await tag("lumbar-lateral", "Lumbar lateral", TagKind.SUBZONE, "zone-lumbar");
  await tag("lumbar-si", "Sacroilíaca", TagKind.SUBZONE, "zone-lumbar");
  await tag("elbow-lateral", "Codo lateral (epicóndilo)", TagKind.SUBZONE, "zone-elbow");
  await tag("elbow-medial", "Codo medial (epitróclea)", TagKind.SUBZONE, "zone-elbow");

  // Symptoms
  await tag("symptom-sharp", "Punzante", TagKind.SYMPTOM);
  await tag("symptom-dull", "Sordo / continuo", TagKind.SYMPTOM);
  await tag("symptom-burning", "Quemante", TagKind.SYMPTOM);
  await tag("symptom-stiff", "Tirante / rigidez", TagKind.SYMPTOM);
  await tag("symptom-inflammation", "Inflamación", TagKind.SYMPTOM);
  await tag("symptom-crepitus", "Crepitación / chasquidos", TagKind.SYMPTOM);
  await tag("symptom-tingling", "Hormigueo", TagKind.SYMPTOM);
  await tag("symptom-weakness", "Pérdida de fuerza", TagKind.SYMPTOM);

  // Triggers
  await tag("trigger-rest", "En reposo", TagKind.TRIGGER);
  await tag("trigger-start", "Al iniciar la actividad", TagKind.TRIGGER);
  await tag("trigger-stairs-up", "Al subir escaleras", TagKind.TRIGGER);
  await tag("trigger-stairs-down", "Al bajar escaleras / pendientes", TagKind.TRIGGER);
  await tag("trigger-running", "Al correr", TagKind.TRIGGER);
  await tag("trigger-sitting", "Al sentarse mucho tiempo", TagKind.TRIGGER);
  await tag("trigger-night", "A la noche / al despertar", TagKind.TRIGGER);
  await tag("trigger-overhead", "Al elevar los brazos", TagKind.TRIGGER);
  await tag("trigger-grip", "Al agarrar / cargar peso", TagKind.TRIGGER);

  // Phases
  await tag("phase-acute", "< 1 semana (aguda)", TagKind.PHASE);
  await tag("phase-subacute", "1-4 semanas (subaguda)", TagKind.PHASE);
  await tag("phase-chronic", "+1 mes (crónica)", TagKind.PHASE);

  // Kinematic chains
  await tag("chain-glute-med", "Glúteo medio", TagKind.CHAIN);
  await tag("chain-core", "Core / abdominal", TagKind.CHAIN);
  await tag("chain-scapula", "Estabilizadores escapulares", TagKind.CHAIN);
  await tag("chain-foot-arch", "Arco plantar / pie", TagKind.CHAIN);
}

// ──────────────────────────────────────────────────────────────────────
// Anatomical regions (with SVG geometry — drives the body map)
// ──────────────────────────────────────────────────────────────────────

async function seedRegions() {
  console.log("[seed] anatomical regions");

  // FRONT view
  await region("head-front", "Cabeza", "FRONT", "CENTER", "ELLIPSE", { x: 120, y: 50, rx: 30, ry: 36 }, { sortOrder: 1 });
  await region("neck-front", "Cuello", "FRONT", "CENTER", "RECT", { x: 108, y: 84, width: 24, height: 22, rx: 8 }, { tagSlug: "zone-cervical", sortOrder: 2 });
  await region("shoulder-l", "Hombro izq.", "FRONT", "LEFT", "ELLIPSE", { x: 85, y: 116, rx: 22, ry: 18 }, { tagSlug: "zone-shoulder", sortOrder: 3 });
  await region("shoulder-r", "Hombro der.", "FRONT", "RIGHT", "ELLIPSE", { x: 155, y: 116, rx: 22, ry: 18 }, { tagSlug: "zone-shoulder", sortOrder: 4 });
  await region("chest", "Pecho", "FRONT", "CENTER", "RECT", { x: 80, y: 125, width: 80, height: 60, rx: 14 }, { sortOrder: 5 });
  await region("abdomen", "Abdomen", "FRONT", "CENTER", "RECT", { x: 86, y: 188, width: 68, height: 60, rx: 14 }, { sortOrder: 6 });
  await region("arm-upper-l", "Brazo izq.", "FRONT", "LEFT", "RECT", { x: 57, y: 130, width: 22, height: 70, rx: 10 }, { sortOrder: 7 });
  await region("arm-upper-r", "Brazo der.", "FRONT", "RIGHT", "RECT", { x: 161, y: 130, width: 22, height: 70, rx: 10 }, { sortOrder: 8 });
  await region("elbow-l", "Codo izq.", "FRONT", "LEFT", "ELLIPSE", { x: 68, y: 210, rx: 13, ry: 10 }, { tagSlug: "zone-elbow", sortOrder: 9 });
  await region("elbow-r", "Codo der.", "FRONT", "RIGHT", "ELLIPSE", { x: 172, y: 210, rx: 13, ry: 10 }, { tagSlug: "zone-elbow", sortOrder: 10 });
  await region("forearm-l", "Antebrazo izq.", "FRONT", "LEFT", "RECT", { x: 57, y: 222, width: 22, height: 64, rx: 10 }, { sortOrder: 11 });
  await region("forearm-r", "Antebrazo der.", "FRONT", "RIGHT", "RECT", { x: 161, y: 222, width: 22, height: 64, rx: 10 }, { sortOrder: 12 });
  await region("wrist-l", "Muñeca izq.", "FRONT", "LEFT", "ELLIPSE", { x: 68, y: 290, rx: 12, ry: 8 }, { tagSlug: "zone-wrist", sortOrder: 13 });
  await region("wrist-r", "Muñeca der.", "FRONT", "RIGHT", "ELLIPSE", { x: 172, y: 290, rx: 12, ry: 8 }, { tagSlug: "zone-wrist", sortOrder: 14 });
  await region("hand-l", "Mano izq.", "FRONT", "LEFT", "ELLIPSE", { x: 68, y: 306, rx: 13, ry: 12 }, { sortOrder: 15 });
  await region("hand-r", "Mano der.", "FRONT", "RIGHT", "ELLIPSE", { x: 172, y: 306, rx: 13, ry: 12 }, { sortOrder: 16 });
  await region("hip-l", "Cadera izq.", "FRONT", "LEFT", "ELLIPSE", { x: 102, y: 262, rx: 18, ry: 12 }, { tagSlug: "hip-external", sortOrder: 17 });
  await region("hip-r", "Cadera der.", "FRONT", "RIGHT", "ELLIPSE", { x: 138, y: 262, rx: 18, ry: 12 }, { tagSlug: "hip-external", sortOrder: 18 });
  await region("thigh-l", "Muslo izq.", "FRONT", "LEFT", "RECT", { x: 86, y: 275, width: 28, height: 108, rx: 14 }, { sortOrder: 19 });
  await region("thigh-r", "Muslo der.", "FRONT", "RIGHT", "RECT", { x: 126, y: 275, width: 28, height: 108, rx: 14 }, { sortOrder: 20 });
  await region("knee-l", "Rodilla izq.", "FRONT", "LEFT", "ELLIPSE", { x: 100, y: 390, rx: 16, ry: 12 }, { tagSlug: "zone-knee", sortOrder: 21 });
  await region("knee-r", "Rodilla der.", "FRONT", "RIGHT", "ELLIPSE", { x: 140, y: 390, rx: 16, ry: 12 }, { tagSlug: "zone-knee", sortOrder: 22 });
  await region("shin-l", "Pantorrilla izq.", "FRONT", "LEFT", "RECT", { x: 88, y: 402, width: 24, height: 78, rx: 12 }, { sortOrder: 23 });
  await region("shin-r", "Pantorrilla der.", "FRONT", "RIGHT", "RECT", { x: 128, y: 402, width: 24, height: 78, rx: 12 }, { sortOrder: 24 });
  await region("ankle-l", "Tobillo izq.", "FRONT", "LEFT", "ELLIPSE", { x: 100, y: 488, rx: 13, ry: 10 }, { tagSlug: "zone-ankle", sortOrder: 25 });
  await region("ankle-r", "Tobillo der.", "FRONT", "RIGHT", "ELLIPSE", { x: 140, y: 488, rx: 13, ry: 10 }, { tagSlug: "zone-ankle", sortOrder: 26 });

  // BACK view
  await region("nuca", "Nuca", "BACK", "CENTER", "ELLIPSE", { x: 120, y: 50, rx: 30, ry: 36 }, { sortOrder: 1 });
  await region("cervical-back", "Cervical posterior", "BACK", "CENTER", "RECT", { x: 108, y: 84, width: 24, height: 22, rx: 8 }, { tagSlug: "zone-cervical", sortOrder: 2 });
  await region("upper-back", "Espalda alta", "BACK", "CENTER", "RECT", { x: 80, y: 110, width: 80, height: 60, rx: 14 }, { tagSlug: "chain-scapula", sortOrder: 3 });
  await region("lower-back", "Lumbar / espalda baja", "BACK", "CENTER", "RECT", { x: 86, y: 172, width: 68, height: 50, rx: 14 }, { tagSlug: "lumbar-central", sortOrder: 4 });
  await region("glute-l", "Glúteo izq.", "BACK", "LEFT", "ELLIPSE", { x: 105, y: 240, rx: 22, ry: 22 }, { tagSlug: "chain-glute-med", sortOrder: 5 });
  await region("glute-r", "Glúteo der.", "BACK", "RIGHT", "ELLIPSE", { x: 135, y: 240, rx: 22, ry: 22 }, { tagSlug: "chain-glute-med", sortOrder: 6 });
  await region("hamstring-l", "Isquios izq.", "BACK", "LEFT", "RECT", { x: 86, y: 265, width: 28, height: 110, rx: 14 }, { sortOrder: 7 });
  await region("hamstring-r", "Isquios der.", "BACK", "RIGHT", "RECT", { x: 126, y: 265, width: 28, height: 110, rx: 14 }, { sortOrder: 8 });
  await region("calf-l", "Gemelo izq.", "BACK", "LEFT", "RECT", { x: 88, y: 395, width: 24, height: 80, rx: 12 }, { sortOrder: 9 });
  await region("calf-r", "Gemelo der.", "BACK", "RIGHT", "RECT", { x: 128, y: 395, width: 24, height: 80, rx: 12 }, { sortOrder: 10 });
  await region("achilles-l", "Aquiles izq.", "BACK", "LEFT", "ELLIPSE", { x: 100, y: 486, rx: 10, ry: 8 }, { tagSlug: "ankle-achilles", sortOrder: 11 });
  await region("achilles-r", "Aquiles der.", "BACK", "RIGHT", "ELLIPSE", { x: 140, y: 486, rx: 10, ry: 8 }, { tagSlug: "ankle-achilles", sortOrder: 12 });
}

// ──────────────────────────────────────────────────────────────────────
// Conditions (28) — production-grade catalog
// ──────────────────────────────────────────────────────────────────────

async function seedConditions() {
  console.log("[seed] conditions (28)");

  // ── Knee ────────────────────────────────────────────────────────────
  await condition({
    slug: "itband",
    cie10: "M76.3",
    name: "Síndrome de la cintilla iliotibial",
    summary: "Inflamación de la banda IT. Frecuente en corredores; asociada a debilidad del glúteo medio.",
    severity: "MODERATE",
    recoveryWeeksMin: 4,
    recoveryWeeksMax: 8,
    mechanism: "Sobrecarga repetitiva",
    redFlags: "Bloqueo articular o derrame importante",
  });
  await condition({
    slug: "patellar-tendinopathy",
    cie10: "M76.5",
    name: "Tendinopatía rotuliana",
    summary: "Sobrecarga del tendón rotuliano (jumper's knee). Frecuente en saltadores.",
    severity: "MODERATE",
    recoveryWeeksMin: 6,
    recoveryWeeksMax: 12,
    mechanism: "Repetitivo / salto",
  });
  await condition({
    slug: "pf-pain",
    cie10: "M22.2",
    name: "Síndrome patelofemoral",
    summary: "Dolor anterior de rodilla por mal-tracking patelar. Common en mujeres jóvenes.",
    severity: "MILD",
    recoveryWeeksMin: 6,
    recoveryWeeksMax: 12,
    mechanism: "Disfunción del tracking patelar",
  });
  await condition({
    slug: "meniscus-lateral",
    cie10: "S83.2",
    name: "Lesión meniscal lateral",
    summary: "Lesión del menisco externo. Suele cursar con bloqueo articular.",
    severity: "MODERATE",
    recoveryWeeksMin: 8,
    recoveryWeeksMax: 16,
    mechanism: "Trauma rotacional",
    redFlags: "Bloqueo persistente → derivar a cirugía",
  });
  await condition({
    slug: "acl-postop",
    cie10: "S83.5",
    name: "Post-operatorio LCA",
    summary: "Rehabilitación tras reconstrucción del ligamento cruzado anterior.",
    severity: "SEVERE",
    recoveryWeeksMin: 24,
    recoveryWeeksMax: 36,
    mechanism: "Trauma deportivo",
  });

  // ── Hip ─────────────────────────────────────────────────────────────
  await condition({
    slug: "trochanteric-bursitis",
    cie10: "M70.6",
    name: "Bursitis trocantérea",
    summary: "Inflamación de la bolsa sobre el trocánter mayor. Coexiste con debilidad del glúteo medio.",
    severity: "MILD",
    recoveryWeeksMin: 3,
    recoveryWeeksMax: 6,
    mechanism: "Sobrecarga / postural",
  });
  await condition({
    slug: "hip-impingement",
    cie10: "M25.85",
    name: "Pinzamiento femoroacetabular (FAI)",
    summary: "Contacto anómalo entre cabeza femoral y acetábulo durante flexión.",
    severity: "MODERATE",
    recoveryWeeksMin: 8,
    recoveryWeeksMax: 16,
    mechanism: "Morfológico / sobreuso",
  });
  await condition({
    slug: "psoas-tendinitis",
    cie10: "M76.1",
    name: "Tendinitis del psoas",
    summary: "Inflamación del tendón del psoas-ilíaco; dolor anterior de cadera.",
    severity: "MILD",
    recoveryWeeksMin: 4,
    recoveryWeeksMax: 8,
    mechanism: "Sobrecarga repetitiva en flexión de cadera",
  });

  // ── Ankle / foot ────────────────────────────────────────────────────
  await condition({
    slug: "ankle-sprain-lateral",
    cie10: "S93.4",
    name: "Esguince lateral de tobillo",
    summary: "Lesión de los ligamentos peroneoastragalinos. La más común del tobillo.",
    severity: "MODERATE",
    recoveryWeeksMin: 3,
    recoveryWeeksMax: 8,
    mechanism: "Inversión forzada",
  });
  await condition({
    slug: "achilles-tendinopathy",
    cie10: "M76.6",
    name: "Tendinopatía del Aquiles",
    summary: "Degeneración del tendón de Aquiles por sobrecarga; frecuente en runners.",
    severity: "MODERATE",
    recoveryWeeksMin: 8,
    recoveryWeeksMax: 16,
    mechanism: "Sobrecarga repetitiva",
  });
  await condition({
    slug: "plantar-fasciitis",
    cie10: "M72.2",
    name: "Fascitis plantar",
    summary: "Inflamación de la fascia plantar; dolor matinal característico en el talón.",
    severity: "MILD",
    recoveryWeeksMin: 6,
    recoveryWeeksMax: 16,
    mechanism: "Sobrecarga / pie plano",
  });

  // ── Shoulder ────────────────────────────────────────────────────────
  await condition({
    slug: "shoulder-impingement",
    cie10: "M75.4",
    name: "Pinzamiento subacromial",
    summary: "Compresión del manguito al elevar el brazo; dolor por debajo del acromion.",
    severity: "MODERATE",
    recoveryWeeksMin: 6,
    recoveryWeeksMax: 12,
    mechanism: "Discinesia escapular + postural",
  });
  await condition({
    slug: "rotator-cuff-tendinopathy",
    cie10: "M75.1",
    name: "Tendinopatía del manguito rotador",
    summary: "Sobrecarga / degeneración del supraespinoso. Dolor con elevación.",
    severity: "MODERATE",
    recoveryWeeksMin: 8,
    recoveryWeeksMax: 16,
    mechanism: "Repetitivo / overhead",
  });
  await condition({
    slug: "frozen-shoulder",
    cie10: "M75.0",
    name: "Hombro congelado (capsulitis adhesiva)",
    summary: "Pérdida progresiva de movilidad activa y pasiva; fases inflamatoria → rigidez → recuperación.",
    severity: "MODERATE",
    recoveryWeeksMin: 24,
    recoveryWeeksMax: 52,
    mechanism: "Inflamatorio / idiopático",
  });
  await condition({
    slug: "ac-joint-sprain",
    cie10: "S43.5",
    name: "Esguince acromioclavicular",
    summary: "Lesión de los ligamentos AC tras caída sobre el hombro.",
    severity: "MILD",
    recoveryWeeksMin: 3,
    recoveryWeeksMax: 8,
    mechanism: "Trauma directo",
  });

  // ── Elbow / wrist ───────────────────────────────────────────────────
  await condition({
    slug: "lateral-epicondylitis",
    cie10: "M77.1",
    name: "Epicondilitis lateral (codo de tenista)",
    summary: "Tendinopatía de los extensores comunes; dolor epicóndilo lateral.",
    severity: "MILD",
    recoveryWeeksMin: 6,
    recoveryWeeksMax: 16,
    mechanism: "Repetitivo / agarre",
  });
  await condition({
    slug: "medial-epicondylitis",
    cie10: "M77.0",
    name: "Epicondilitis medial (codo de golfista)",
    summary: "Tendinopatía de los flexores-pronadores en epitróclea.",
    severity: "MILD",
    recoveryWeeksMin: 6,
    recoveryWeeksMax: 16,
    mechanism: "Repetitivo / agarre",
  });
  await condition({
    slug: "bicep-tendinopathy",
    cie10: "M75.2",
    name: "Tendinopatía del bíceps",
    summary: "Inflamación del tendón largo del bíceps; dolor anterior del hombro irradiado.",
    severity: "MILD",
    recoveryWeeksMin: 6,
    recoveryWeeksMax: 12,
    mechanism: "Sobrecarga repetitiva",
  });
  await condition({
    slug: "carpal-tunnel",
    cie10: "G56.0",
    name: "Síndrome del túnel carpiano",
    summary: "Compresión del nervio mediano en muñeca; hormigueo nocturno típico.",
    severity: "MILD",
    recoveryWeeksMin: 8,
    recoveryWeeksMax: 16,
    mechanism: "Repetitivo / atrapamiento",
    redFlags: "Pérdida de fuerza significativa → derivación",
  });
  await condition({
    slug: "dequervain",
    cie10: "M65.4",
    name: "Tenosinovitis de De Quervain",
    summary: "Inflamación de los tendones del pulgar; dolor con pinza y desviación cubital.",
    severity: "MILD",
    recoveryWeeksMin: 6,
    recoveryWeeksMax: 12,
    mechanism: "Repetitivo (madres, pantalla)",
  });

  // ── Lumbar / cervical ───────────────────────────────────────────────
  await condition({
    slug: "lumbar-mechanical",
    cie10: "M54.5",
    name: "Lumbalgia mecánica",
    summary: "Dolor lumbar de origen muscular / facetario, no radicular.",
    severity: "MILD",
    recoveryWeeksMin: 2,
    recoveryWeeksMax: 6,
    mechanism: "Postural / sobrecarga",
  });
  await condition({
    slug: "lumbar-disc",
    cie10: "M51.2",
    name: "Discopatía lumbar con ciatalgia",
    summary: "Hernia o protrusión discal con compromiso radicular L5/S1.",
    severity: "MODERATE",
    recoveryWeeksMin: 8,
    recoveryWeeksMax: 16,
    mechanism: "Degenerativo / sobrecarga",
    redFlags: "Pérdida de fuerza o sensibilidad progresiva → derivación urgente",
  });
  await condition({
    slug: "si-dysfunction",
    cie10: "M53.3",
    name: "Disfunción sacroilíaca",
    summary: "Dolor en la articulación SI; frecuente postparto y en deportistas.",
    severity: "MILD",
    recoveryWeeksMin: 4,
    recoveryWeeksMax: 10,
    mechanism: "Hipo/hipermovilidad",
  });
  await condition({
    slug: "cervicalgia",
    cie10: "M54.2",
    name: "Cervicalgia mecánica",
    summary: "Dolor cervical de origen postural / muscular.",
    severity: "MILD",
    recoveryWeeksMin: 2,
    recoveryWeeksMax: 6,
    mechanism: "Postural",
  });
  await condition({
    slug: "tension-headache",
    cie10: "G44.2",
    name: "Cefalea tensional",
    summary: "Dolor de cabeza bilateral por contractura cervical alta.",
    severity: "MILD",
    recoveryWeeksMin: 2,
    recoveryWeeksMax: 8,
    mechanism: "Postural / tensión",
  });

  // ── Calf / hamstring ────────────────────────────────────────────────
  await condition({
    slug: "calf-strain",
    cie10: "S86.1",
    name: "Distensión del gemelo",
    summary: "Lesión muscular del gastrocnemio; frecuente al sprint o salto.",
    severity: "MODERATE",
    recoveryWeeksMin: 4,
    recoveryWeeksMax: 8,
    mechanism: "Trauma indirecto / sprint",
  });
  await condition({
    slug: "hamstring-strain",
    cie10: "S76.3",
    name: "Distensión de isquiotibiales",
    summary: "Lesión muscular del bíceps femoral / semitendinoso.",
    severity: "MODERATE",
    recoveryWeeksMin: 4,
    recoveryWeeksMax: 10,
    mechanism: "Sprint / desaceleración",
  });
  await condition({
    slug: "groin-strain",
    cie10: "S76.2",
    name: "Pubalgia / distensión aductores",
    summary: "Dolor inguinal por sobrecarga de aductores. Frecuente en futbolistas.",
    severity: "MODERATE",
    recoveryWeeksMin: 6,
    recoveryWeeksMax: 12,
    mechanism: "Repetitivo / cambio de dirección",
  });
}

// ──────────────────────────────────────────────────────────────────────
// Anatomy / Tag / Exercise links
// ──────────────────────────────────────────────────────────────────────

async function seedRelations() {
  console.log("[seed] tag + anatomy + exercise links");

  // ── ITBS ────────────────────────────────────────────────────────────
  await linkConditionAnatomy("itband", "knee-r", "PRIMARY");
  await linkConditionAnatomy("itband", "knee-l", "PRIMARY");
  await linkConditionAnatomy("itband", "hip-r", "SECONDARY");
  await linkConditionAnatomy("itband", "hip-l", "SECONDARY");
  await linkConditionAnatomy("itband", "glute-r", "RELATED");
  await linkConditionAnatomy("itband", "glute-l", "RELATED");
  for (const [t, w] of [
    ["zone-knee", 2], ["knee-lateral", 3], ["hip-external", 2],
    ["symptom-burning", 1.5], ["symptom-stiff", 1], ["trigger-running", 2],
    ["trigger-stairs-down", 1.5], ["chain-glute-med", 2], ["phase-subacute", 0.5],
  ] as const) {
    await linkConditionTag("itband", t, w);
  }

  // ── Patellar tendinopathy ───────────────────────────────────────────
  await linkConditionAnatomy("patellar-tendinopathy", "knee-r", "PRIMARY");
  await linkConditionAnatomy("patellar-tendinopathy", "knee-l", "PRIMARY");
  await linkConditionAnatomy("patellar-tendinopathy", "thigh-r", "RELATED");
  await linkConditionAnatomy("patellar-tendinopathy", "thigh-l", "RELATED");
  for (const [t, w] of [
    ["zone-knee", 2], ["knee-anterior", 3], ["symptom-sharp", 1.5],
    ["trigger-stairs-up", 2], ["trigger-running", 1.5],
  ] as const) {
    await linkConditionTag("patellar-tendinopathy", t, w);
  }

  // ── Patellofemoral pain syndrome ────────────────────────────────────
  await linkConditionAnatomy("pf-pain", "knee-r", "PRIMARY");
  await linkConditionAnatomy("pf-pain", "knee-l", "PRIMARY");
  await linkConditionAnatomy("pf-pain", "hip-r", "RELATED");
  await linkConditionAnatomy("pf-pain", "hip-l", "RELATED");
  for (const [t, w] of [
    ["zone-knee", 2], ["knee-anterior", 3], ["symptom-dull", 1.5],
    ["trigger-stairs-down", 2], ["trigger-sitting", 2], ["chain-glute-med", 1.5],
  ] as const) {
    await linkConditionTag("pf-pain", t, w);
  }

  // ── Lateral meniscus ────────────────────────────────────────────────
  await linkConditionAnatomy("meniscus-lateral", "knee-r", "PRIMARY");
  await linkConditionAnatomy("meniscus-lateral", "knee-l", "PRIMARY");
  for (const [t, w] of [
    ["zone-knee", 3], ["knee-lateral", 3], ["symptom-sharp", 2],
    ["symptom-crepitus", 2], ["phase-acute", 1],
  ] as const) {
    await linkConditionTag("meniscus-lateral", t, w);
  }

  // ── ACL post-op ─────────────────────────────────────────────────────
  await linkConditionAnatomy("acl-postop", "knee-r", "PRIMARY");
  await linkConditionAnatomy("acl-postop", "knee-l", "PRIMARY");
  await linkConditionAnatomy("acl-postop", "thigh-r", "SECONDARY");
  await linkConditionAnatomy("acl-postop", "thigh-l", "SECONDARY");
  await linkConditionAnatomy("acl-postop", "glute-r", "RELATED");
  await linkConditionAnatomy("acl-postop", "glute-l", "RELATED");
  for (const [t, w] of [
    ["zone-knee", 3], ["symptom-stiff", 2], ["symptom-weakness", 2.5],
    ["phase-chronic", 1.5], ["chain-glute-med", 1.5],
  ] as const) {
    await linkConditionTag("acl-postop", t, w);
  }

  // ── Trochanteric bursitis ───────────────────────────────────────────
  await linkConditionAnatomy("trochanteric-bursitis", "hip-r", "PRIMARY");
  await linkConditionAnatomy("trochanteric-bursitis", "hip-l", "PRIMARY");
  await linkConditionAnatomy("trochanteric-bursitis", "glute-r", "RELATED");
  await linkConditionAnatomy("trochanteric-bursitis", "glute-l", "RELATED");
  for (const [t, w] of [
    ["zone-hip", 2], ["hip-external", 3], ["symptom-sharp", 1.5],
    ["trigger-night", 1.5], ["chain-glute-med", 2],
  ] as const) {
    await linkConditionTag("trochanteric-bursitis", t, w);
  }

  // ── FAI ─────────────────────────────────────────────────────────────
  await linkConditionAnatomy("hip-impingement", "hip-r", "PRIMARY");
  await linkConditionAnatomy("hip-impingement", "hip-l", "PRIMARY");
  for (const [t, w] of [
    ["zone-hip", 2], ["hip-anterior", 3], ["symptom-sharp", 1.5],
    ["trigger-sitting", 2], ["chain-core", 1.5],
  ] as const) {
    await linkConditionTag("hip-impingement", t, w);
  }

  // ── Psoas tendinitis ────────────────────────────────────────────────
  await linkConditionAnatomy("psoas-tendinitis", "hip-r", "PRIMARY");
  await linkConditionAnatomy("psoas-tendinitis", "hip-l", "PRIMARY");
  await linkConditionAnatomy("psoas-tendinitis", "abdomen", "RELATED");
  for (const [t, w] of [
    ["zone-hip", 2], ["hip-anterior", 3], ["symptom-stiff", 1.5],
    ["trigger-stairs-up", 1.5], ["chain-core", 2],
  ] as const) {
    await linkConditionTag("psoas-tendinitis", t, w);
  }

  // ── Ankle sprain ────────────────────────────────────────────────────
  await linkConditionAnatomy("ankle-sprain-lateral", "ankle-r", "PRIMARY");
  await linkConditionAnatomy("ankle-sprain-lateral", "ankle-l", "PRIMARY");
  for (const [t, w] of [
    ["zone-ankle", 2], ["ankle-lateral", 3], ["symptom-inflammation", 2],
    ["symptom-sharp", 1.5], ["phase-acute", 2],
  ] as const) {
    await linkConditionTag("ankle-sprain-lateral", t, w);
  }

  // ── Achilles tendinopathy ───────────────────────────────────────────
  await linkConditionAnatomy("achilles-tendinopathy", "achilles-r", "PRIMARY");
  await linkConditionAnatomy("achilles-tendinopathy", "achilles-l", "PRIMARY");
  await linkConditionAnatomy("achilles-tendinopathy", "calf-r", "SECONDARY");
  await linkConditionAnatomy("achilles-tendinopathy", "calf-l", "SECONDARY");
  for (const [t, w] of [
    ["zone-ankle", 2], ["ankle-achilles", 3], ["symptom-stiff", 1.5],
    ["trigger-start", 2], ["trigger-running", 2], ["trigger-night", 1.5],
  ] as const) {
    await linkConditionTag("achilles-tendinopathy", t, w);
  }

  // ── Plantar fasciitis ───────────────────────────────────────────────
  await linkConditionAnatomy("plantar-fasciitis", "ankle-r", "PRIMARY");
  await linkConditionAnatomy("plantar-fasciitis", "ankle-l", "PRIMARY");
  await linkConditionAnatomy("plantar-fasciitis", "calf-r", "RELATED");
  await linkConditionAnatomy("plantar-fasciitis", "calf-l", "RELATED");
  for (const [t, w] of [
    ["zone-ankle", 2], ["ankle-plantar", 3], ["symptom-sharp", 2],
    ["trigger-night", 2], ["trigger-start", 2], ["chain-foot-arch", 2],
  ] as const) {
    await linkConditionTag("plantar-fasciitis", t, w);
  }

  // ── Shoulder impingement ────────────────────────────────────────────
  await linkConditionAnatomy("shoulder-impingement", "shoulder-r", "PRIMARY");
  await linkConditionAnatomy("shoulder-impingement", "shoulder-l", "PRIMARY");
  await linkConditionAnatomy("shoulder-impingement", "upper-back", "RELATED");
  for (const [t, w] of [
    ["zone-shoulder", 2], ["shoulder-superior", 3], ["trigger-overhead", 2.5],
    ["symptom-sharp", 1.5], ["chain-scapula", 2],
  ] as const) {
    await linkConditionTag("shoulder-impingement", t, w);
  }

  // ── Rotator cuff tendinopathy ───────────────────────────────────────
  await linkConditionAnatomy("rotator-cuff-tendinopathy", "shoulder-r", "PRIMARY");
  await linkConditionAnatomy("rotator-cuff-tendinopathy", "shoulder-l", "PRIMARY");
  await linkConditionAnatomy("rotator-cuff-tendinopathy", "upper-back", "RELATED");
  for (const [t, w] of [
    ["zone-shoulder", 2], ["shoulder-superior", 2.5], ["trigger-overhead", 2.5],
    ["symptom-weakness", 1.5], ["chain-scapula", 2],
  ] as const) {
    await linkConditionTag("rotator-cuff-tendinopathy", t, w);
  }

  // ── Frozen shoulder ─────────────────────────────────────────────────
  await linkConditionAnatomy("frozen-shoulder", "shoulder-r", "PRIMARY");
  await linkConditionAnatomy("frozen-shoulder", "shoulder-l", "PRIMARY");
  for (const [t, w] of [
    ["zone-shoulder", 2], ["symptom-stiff", 3], ["trigger-overhead", 2],
    ["phase-chronic", 2],
  ] as const) {
    await linkConditionTag("frozen-shoulder", t, w);
  }

  // ── AC joint sprain ─────────────────────────────────────────────────
  await linkConditionAnatomy("ac-joint-sprain", "shoulder-r", "PRIMARY");
  await linkConditionAnatomy("ac-joint-sprain", "shoulder-l", "PRIMARY");
  for (const [t, w] of [
    ["zone-shoulder", 2], ["shoulder-superior", 2.5], ["symptom-sharp", 2],
    ["phase-acute", 1.5],
  ] as const) {
    await linkConditionTag("ac-joint-sprain", t, w);
  }

  // ── Lateral epicondylitis ───────────────────────────────────────────
  await linkConditionAnatomy("lateral-epicondylitis", "elbow-r", "PRIMARY");
  await linkConditionAnatomy("lateral-epicondylitis", "elbow-l", "PRIMARY");
  await linkConditionAnatomy("lateral-epicondylitis", "forearm-r", "SECONDARY");
  await linkConditionAnatomy("lateral-epicondylitis", "forearm-l", "SECONDARY");
  for (const [t, w] of [
    ["zone-elbow", 2], ["elbow-lateral", 3], ["symptom-burning", 1.5],
    ["trigger-grip", 2.5],
  ] as const) {
    await linkConditionTag("lateral-epicondylitis", t, w);
  }

  // ── Medial epicondylitis ────────────────────────────────────────────
  await linkConditionAnatomy("medial-epicondylitis", "elbow-r", "PRIMARY");
  await linkConditionAnatomy("medial-epicondylitis", "elbow-l", "PRIMARY");
  for (const [t, w] of [
    ["zone-elbow", 2], ["elbow-medial", 3], ["trigger-grip", 2.5],
  ] as const) {
    await linkConditionTag("medial-epicondylitis", t, w);
  }

  // ── Bicep tendinopathy ──────────────────────────────────────────────
  await linkConditionAnatomy("bicep-tendinopathy", "shoulder-r", "PRIMARY");
  await linkConditionAnatomy("bicep-tendinopathy", "shoulder-l", "PRIMARY");
  await linkConditionAnatomy("bicep-tendinopathy", "abdomen", "RELATED");
  await linkConditionAnatomy("bicep-tendinopathy", "upper-back", "RELATED");
  for (const [t, w] of [
    ["zone-shoulder", 2], ["shoulder-anterior", 2.5], ["symptom-dull", 1.5],
    ["chain-core", 1.5], ["chain-scapula", 1.5],
  ] as const) {
    await linkConditionTag("bicep-tendinopathy", t, w);
  }

  // ── Carpal tunnel ───────────────────────────────────────────────────
  await linkConditionAnatomy("carpal-tunnel", "wrist-r", "PRIMARY");
  await linkConditionAnatomy("carpal-tunnel", "wrist-l", "PRIMARY");
  for (const [t, w] of [
    ["zone-wrist", 2.5], ["symptom-tingling", 3], ["symptom-weakness", 1.5],
    ["trigger-night", 2],
  ] as const) {
    await linkConditionTag("carpal-tunnel", t, w);
  }

  // ── De Quervain ─────────────────────────────────────────────────────
  await linkConditionAnatomy("dequervain", "wrist-r", "PRIMARY");
  await linkConditionAnatomy("dequervain", "wrist-l", "PRIMARY");
  for (const [t, w] of [
    ["zone-wrist", 2.5], ["symptom-sharp", 2], ["trigger-grip", 2.5],
  ] as const) {
    await linkConditionTag("dequervain", t, w);
  }

  // ── Lumbar mechanical ───────────────────────────────────────────────
  await linkConditionAnatomy("lumbar-mechanical", "lower-back", "PRIMARY");
  await linkConditionAnatomy("lumbar-mechanical", "glute-r", "RELATED");
  await linkConditionAnatomy("lumbar-mechanical", "glute-l", "RELATED");
  await linkConditionAnatomy("lumbar-mechanical", "abdomen", "RELATED");
  for (const [t, w] of [
    ["zone-lumbar", 3], ["lumbar-central", 3], ["symptom-stiff", 2],
    ["trigger-sitting", 2], ["chain-core", 2], ["chain-glute-med", 1],
  ] as const) {
    await linkConditionTag("lumbar-mechanical", t, w);
  }

  // ── Lumbar disc ─────────────────────────────────────────────────────
  await linkConditionAnatomy("lumbar-disc", "lower-back", "PRIMARY");
  await linkConditionAnatomy("lumbar-disc", "hamstring-r", "SECONDARY");
  await linkConditionAnatomy("lumbar-disc", "hamstring-l", "SECONDARY");
  await linkConditionAnatomy("lumbar-disc", "calf-r", "RELATED");
  await linkConditionAnatomy("lumbar-disc", "calf-l", "RELATED");
  for (const [t, w] of [
    ["zone-lumbar", 3], ["lumbar-lateral", 2.5], ["symptom-tingling", 2.5],
    ["symptom-burning", 1.5], ["trigger-sitting", 2.5], ["chain-core", 2],
  ] as const) {
    await linkConditionTag("lumbar-disc", t, w);
  }

  // ── SI dysfunction ──────────────────────────────────────────────────
  await linkConditionAnatomy("si-dysfunction", "lower-back", "PRIMARY");
  await linkConditionAnatomy("si-dysfunction", "glute-r", "SECONDARY");
  await linkConditionAnatomy("si-dysfunction", "glute-l", "SECONDARY");
  for (const [t, w] of [
    ["zone-lumbar", 2], ["lumbar-si", 3], ["symptom-dull", 1.5],
    ["chain-glute-med", 2], ["chain-core", 1.5],
  ] as const) {
    await linkConditionTag("si-dysfunction", t, w);
  }

  // ── Cervicalgia ─────────────────────────────────────────────────────
  await linkConditionAnatomy("cervicalgia", "cervical-back", "PRIMARY");
  await linkConditionAnatomy("cervicalgia", "neck-front", "PRIMARY");
  await linkConditionAnatomy("cervicalgia", "upper-back", "SECONDARY");
  for (const [t, w] of [
    ["zone-cervical", 3], ["symptom-stiff", 2], ["trigger-sitting", 2.5],
    ["chain-scapula", 1.5],
  ] as const) {
    await linkConditionTag("cervicalgia", t, w);
  }

  // ── Tension headache ────────────────────────────────────────────────
  await linkConditionAnatomy("tension-headache", "cervical-back", "PRIMARY");
  await linkConditionAnatomy("tension-headache", "nuca", "PRIMARY");
  for (const [t, w] of [
    ["zone-cervical", 2], ["symptom-dull", 2], ["trigger-sitting", 2],
    ["trigger-night", 1.5],
  ] as const) {
    await linkConditionTag("tension-headache", t, w);
  }

  // ── Calf strain ─────────────────────────────────────────────────────
  await linkConditionAnatomy("calf-strain", "calf-r", "PRIMARY");
  await linkConditionAnatomy("calf-strain", "calf-l", "PRIMARY");
  await linkConditionAnatomy("calf-strain", "achilles-r", "RELATED");
  await linkConditionAnatomy("calf-strain", "achilles-l", "RELATED");
  for (const [t, w] of [
    ["symptom-sharp", 2], ["phase-acute", 2], ["trigger-running", 2],
  ] as const) {
    await linkConditionTag("calf-strain", t, w);
  }

  // ── Hamstring strain ────────────────────────────────────────────────
  await linkConditionAnatomy("hamstring-strain", "hamstring-r", "PRIMARY");
  await linkConditionAnatomy("hamstring-strain", "hamstring-l", "PRIMARY");
  await linkConditionAnatomy("hamstring-strain", "glute-r", "RELATED");
  await linkConditionAnatomy("hamstring-strain", "glute-l", "RELATED");
  for (const [t, w] of [
    ["symptom-sharp", 2], ["phase-acute", 1.5], ["trigger-running", 2.5],
    ["chain-glute-med", 1.5], ["chain-core", 1],
  ] as const) {
    await linkConditionTag("hamstring-strain", t, w);
  }

  // ── Groin strain ────────────────────────────────────────────────────
  await linkConditionAnatomy("groin-strain", "hip-r", "PRIMARY");
  await linkConditionAnatomy("groin-strain", "hip-l", "PRIMARY");
  await linkConditionAnatomy("groin-strain", "abdomen", "RELATED");
  for (const [t, w] of [
    ["zone-hip", 2], ["hip-anterior", 3], ["symptom-sharp", 2],
    ["trigger-running", 1.5], ["chain-core", 2],
  ] as const) {
    await linkConditionTag("groin-strain", t, w);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Exercises (60)
// ──────────────────────────────────────────────────────────────────────

async function seedExercises() {
  console.log("[seed] exercises (60)");

  const E: Array<Parameters<typeof exercise>[0]> = [
    // Glute / hip activation
    { slug: "clamshell", name: "Clamshell con banda", defaultSets: 3, defaultReps: 15, difficulty: 1, equipment: "banda", muscleGroups: "Glúteo medio", cues: "Pelvis estable, sólo abre la rodilla" },
    { slug: "clamshell-elevated", name: "Clamshell elevado", defaultSets: 3, defaultReps: 12, difficulty: 2, equipment: "banda", muscleGroups: "Glúteo medio" },
    { slug: "glute-bridge-uni", name: "Puente glúteo unilateral", defaultSets: 3, defaultReps: 12, difficulty: 1, muscleGroups: "Glúteo mayor, isquios" },
    { slug: "glute-bridge", name: "Puente glúteo bilateral", defaultSets: 3, defaultReps: 15, difficulty: 1, muscleGroups: "Glúteo mayor" },
    { slug: "hip-thrust", name: "Hip thrust", defaultSets: 3, defaultReps: 10, difficulty: 3, equipment: "mancuerna", muscleGroups: "Glúteo mayor" },
    { slug: "monster-walk", name: "Monster walk con banda", defaultSets: 3, defaultReps: 12, difficulty: 2, equipment: "banda", muscleGroups: "Glúteo medio" },
    { slug: "fire-hydrant", name: "Fire hydrant", defaultSets: 3, defaultReps: 12, difficulty: 1, muscleGroups: "Glúteo medio, cadera" },
    { slug: "single-leg-stance", name: "Apoyo monopodal", defaultSets: 3, defaultReps: 30, difficulty: 1, muscleGroups: "Estabilizadores cadera, tobillo" },

    // Knee / quad
    { slug: "step-down-slow", name: "Step-down lento controlado", defaultSets: 3, defaultReps: 10, difficulty: 2, equipment: "step", muscleGroups: "Cuádriceps, control rodilla" },
    { slug: "step-up", name: "Step-up", defaultSets: 3, defaultReps: 10, difficulty: 2, equipment: "step", muscleGroups: "Cuádriceps, glúteo mayor" },
    { slug: "wall-sit", name: "Sentadilla isométrica en pared", defaultSets: 3, defaultReps: 45, difficulty: 1, muscleGroups: "Cuádriceps" },
    { slug: "spanish-squat", name: "Sentadilla española", defaultSets: 3, defaultReps: 10, difficulty: 2, equipment: "banda", muscleGroups: "Cuádriceps", cues: "Tronco erguido, banda atrás de rodillas" },
    { slug: "goblet-squat", name: "Sentadilla goblet", defaultSets: 3, defaultReps: 12, difficulty: 2, equipment: "mancuerna", muscleGroups: "Cuádriceps, glúteos" },
    { slug: "split-squat", name: "Split squat", defaultSets: 3, defaultReps: 10, difficulty: 2, muscleGroups: "Cuádriceps, glúteo mayor" },
    { slug: "bulgarian-split", name: "Búlgaras", defaultSets: 3, defaultReps: 8, difficulty: 3, equipment: "step", muscleGroups: "Cuádriceps, glúteo" },
    { slug: "leg-extension-iso", name: "Iso de cuádriceps con toalla", defaultSets: 3, defaultReps: 10, difficulty: 1, equipment: "toalla", muscleGroups: "Cuádriceps" },
    { slug: "vmo-quad-set", name: "Quad-set con énfasis VMO", defaultSets: 3, defaultReps: 12, difficulty: 1, muscleGroups: "Cuádriceps (VMO)" },

    // Hamstring / posterior chain
    { slug: "sl-rdl", name: "Peso muerto unilateral", defaultSets: 3, defaultReps: 8, difficulty: 3, equipment: "mancuerna", muscleGroups: "Isquios, glúteo, cadena posterior" },
    { slug: "nordic-hamstring", name: "Nordic hamstring", defaultSets: 3, defaultReps: 6, difficulty: 4, muscleGroups: "Isquiotibiales" },
    { slug: "ham-bridge", name: "Puente isquiotibial con talones", defaultSets: 3, defaultReps: 12, difficulty: 2, equipment: "step", muscleGroups: "Isquiotibiales" },
    { slug: "good-morning", name: "Good morning", defaultSets: 3, defaultReps: 10, difficulty: 3, equipment: "barra", muscleGroups: "Isquios, lumbar" },

    // Calf / ankle
    { slug: "calf-raise", name: "Elevación de talones", defaultSets: 3, defaultReps: 15, difficulty: 1, muscleGroups: "Gemelos, sóleo" },
    { slug: "calf-raise-eccentric", name: "Excéntricos de gemelo en escalón", defaultSets: 3, defaultReps: 12, difficulty: 2, equipment: "step", muscleGroups: "Gemelos, Aquiles", cues: "Bajada lenta 3 seg" },
    { slug: "alfredson-protocol", name: "Protocolo Alfredson Aquiles", defaultSets: 3, defaultReps: 15, difficulty: 2, equipment: "step", muscleGroups: "Aquiles, gemelos" },
    { slug: "ankle-eversion-band", name: "Eversión de tobillo con banda", defaultSets: 3, defaultReps: 15, difficulty: 1, equipment: "banda", muscleGroups: "Peroneos" },
    { slug: "ankle-balance-foam", name: "Equilibrio en foam", defaultSets: 3, defaultReps: 30, difficulty: 2, equipment: "foam", muscleGroups: "Estabilizadores tobillo" },
    { slug: "toe-yoga", name: "Toe yoga", defaultSets: 3, defaultReps: 10, difficulty: 1, muscleGroups: "Intrínsecos del pie" },
    { slug: "short-foot", name: "Pie corto (short foot)", defaultSets: 3, defaultReps: 10, difficulty: 1, muscleGroups: "Arco plantar" },

    // Core / lumbar
    { slug: "side-plank-raise", name: "Plancha lateral con elevación", defaultSets: 3, defaultReps: 30, difficulty: 2, muscleGroups: "Core lateral, glúteo medio" },
    { slug: "side-plank", name: "Plancha lateral", defaultSets: 3, defaultReps: 30, difficulty: 2, muscleGroups: "Core lateral" },
    { slug: "front-plank", name: "Plancha frontal", defaultSets: 3, defaultReps: 30, difficulty: 1, muscleGroups: "Core anterior" },
    { slug: "dead-bug", name: "Dead bug", defaultSets: 3, defaultReps: 10, difficulty: 1, muscleGroups: "Core anterior, control lumbar" },
    { slug: "bird-dog", name: "Bird dog", defaultSets: 3, defaultReps: 10, difficulty: 1, muscleGroups: "Core, multífidos" },
    { slug: "mckenzie-extension", name: "Extensión McKenzie", defaultSets: 3, defaultReps: 10, difficulty: 1, muscleGroups: "Lumbar (descompresión disco)" },
    { slug: "cat-cow", name: "Gato-vaca", defaultSets: 2, defaultReps: 10, difficulty: 1, muscleGroups: "Movilidad lumbar" },
    { slug: "pelvic-tilt", name: "Báscula pélvica", defaultSets: 3, defaultReps: 12, difficulty: 1, muscleGroups: "Core / control pélvico" },
    { slug: "lumbar-rotation", name: "Rotación lumbar tendido", defaultSets: 3, defaultReps: 10, difficulty: 1, muscleGroups: "Movilidad lumbar" },

    // Shoulder / scapula
    { slug: "scapular-pull", name: "Retracción escapular con banda", defaultSets: 3, defaultReps: 15, difficulty: 1, equipment: "banda", muscleGroups: "Romboides, trapecio medio" },
    { slug: "wall-slide", name: "Wall slide", defaultSets: 3, defaultReps: 12, difficulty: 1, muscleGroups: "Estabilizadores escapulares" },
    { slug: "y-t-w-raises", name: "Elevaciones Y-T-W", defaultSets: 3, defaultReps: 10, difficulty: 2, equipment: "mancuerna", muscleGroups: "Manguito, escapulares" },
    { slug: "external-rotation-band", name: "Rotación externa con banda", defaultSets: 3, defaultReps: 15, difficulty: 1, equipment: "banda", muscleGroups: "Manguito (infraespinoso, redondo menor)" },
    { slug: "prone-i-y", name: "Prone I-Y", defaultSets: 3, defaultReps: 10, difficulty: 2, muscleGroups: "Trapecio inferior" },
    { slug: "face-pull", name: "Face pull", defaultSets: 3, defaultReps: 12, difficulty: 2, equipment: "banda", muscleGroups: "Trapecio medio, deltoide posterior" },
    { slug: "pendulum", name: "Péndulos (Codman)", defaultSets: 3, defaultReps: 20, difficulty: 1, muscleGroups: "Hombro · descompresión" },
    { slug: "cross-body-stretch", name: "Estiramiento posterior de hombro", defaultSets: 3, defaultReps: 30, difficulty: 1, muscleGroups: "Cápsula posterior" },
    { slug: "sleeper-stretch", name: "Sleeper stretch", defaultSets: 3, defaultReps: 30, difficulty: 1, muscleGroups: "Cápsula posterior hombro" },

    // Elbow / wrist
    { slug: "wrist-extensor-eccentric", name: "Excéntricos de extensores", defaultSets: 3, defaultReps: 12, difficulty: 1, equipment: "mancuerna", muscleGroups: "Extensores muñeca" },
    { slug: "wrist-flexor-eccentric", name: "Excéntricos de flexores", defaultSets: 3, defaultReps: 12, difficulty: 1, equipment: "mancuerna", muscleGroups: "Flexores muñeca" },
    { slug: "rice-grip", name: "Agarre en arroz", defaultSets: 3, defaultReps: 30, difficulty: 1, equipment: "balde", muscleGroups: "Antebrazo, mano" },
    { slug: "median-nerve-glide", name: "Deslizamiento nervio mediano", defaultSets: 3, defaultReps: 10, difficulty: 1, muscleGroups: "Movilización neural" },
    { slug: "tendon-glide", name: "Deslizamiento tendinoso", defaultSets: 3, defaultReps: 10, difficulty: 1, muscleGroups: "Tendones flexores" },
    { slug: "thumb-extension-band", name: "Extensión del pulgar con banda", defaultSets: 3, defaultReps: 15, difficulty: 1, equipment: "banda elástica chica", muscleGroups: "Abductor pulgar" },

    // Stretches / releases
    { slug: "foam-roller-itb", name: "Foam roller cintilla / TFL", defaultSets: 2, defaultReps: 90, difficulty: 1, equipment: "foam roller", muscleGroups: "Banda IT, TFL" },
    { slug: "foam-roller-glute", name: "Foam roller glúteo", defaultSets: 2, defaultReps: 90, difficulty: 1, equipment: "foam roller", muscleGroups: "Glúteo medio, piriforme" },
    { slug: "itb-stretch", name: "Estiramiento de cintilla IT", defaultSets: 3, defaultReps: 45, difficulty: 1, muscleGroups: "Banda IT" },
    { slug: "psoas-stretch", name: "Estiramiento psoas (caballero)", defaultSets: 3, defaultReps: 30, difficulty: 1, muscleGroups: "Psoas" },
    { slug: "piriformis-stretch", name: "Estiramiento piriforme (4)", defaultSets: 3, defaultReps: 30, difficulty: 1, muscleGroups: "Piriforme" },
    { slug: "doorway-stretch", name: "Estiramiento pectoral en puerta", defaultSets: 3, defaultReps: 30, difficulty: 1, muscleGroups: "Pectoral mayor" },
    { slug: "upper-trap-stretch", name: "Estiramiento de trapecio superior", defaultSets: 3, defaultReps: 30, difficulty: 1, muscleGroups: "Trapecio superior" },
    { slug: "neck-cars", name: "CARs cervicales", defaultSets: 2, defaultReps: 6, difficulty: 1, muscleGroups: "Movilidad cervical" },
    { slug: "chin-tuck", name: "Chin tuck", defaultSets: 3, defaultReps: 12, difficulty: 1, muscleGroups: "Flexores profundos cervicales" },

    // Plyo / progression
    { slug: "skater-jump", name: "Skater jump", defaultSets: 3, defaultReps: 10, difficulty: 4, muscleGroups: "Cadena lateral, control rodilla" },
    { slug: "drop-landing", name: "Drop landing", defaultSets: 3, defaultReps: 8, difficulty: 3, equipment: "step", muscleGroups: "Control rodilla, tobillo" },
  ];

  for (const e of E) await exercise(e);
}

// ──────────────────────────────────────────────────────────────────────
// Condition ↔ Exercise links — DIRECT + INDIRECT + ANTAGONIST across phases
// ──────────────────────────────────────────────────────────────────────

async function seedExerciseLinks() {
  console.log("[seed] condition ↔ exercise links");

  // ── ITBS ────────────────────────────────────────────────────────────
  await linkConditionExercise("itband", "clamshell", "DIRECT", "ACTIVATION", 3, "Activación de glúteo medio — músculo clave");
  await linkConditionExercise("itband", "glute-bridge-uni", "DIRECT", "ACTIVATION", 2.5);
  await linkConditionExercise("itband", "foam-roller-itb", "DIRECT", "ACTIVATION", 2, "Liberación miofascial");
  await linkConditionExercise("itband", "monster-walk", "DIRECT", "STABILITY", 2);
  await linkConditionExercise("itband", "step-down-slow", "DIRECT", "STABILITY", 2, "Control de rodilla en cadena cinética");
  await linkConditionExercise("itband", "single-leg-stance", "DIRECT", "STABILITY", 1.5);
  await linkConditionExercise("itband", "sl-rdl", "DIRECT", "LOAD", 2, "Cadena posterior");
  await linkConditionExercise("itband", "hip-thrust", "DIRECT", "LOAD", 2);
  await linkConditionExercise("itband", "skater-jump", "DIRECT", "PROGRESSION", 2.5, "Return to running");
  await linkConditionExercise("itband", "side-plank-raise", "INDIRECT", "STABILITY", 2, "Estabilidad lumbo-pélvica — el core falla y la cadera compensa");
  await linkConditionExercise("itband", "dead-bug", "INDIRECT", "ACTIVATION", 1.5);
  await linkConditionExercise("itband", "goblet-squat", "INDIRECT", "LOAD", 1.5, "Cuádriceps + glúteo balanceado");
  await linkConditionExercise("itband", "itb-stretch", "DIRECT", "ACTIVATION", 1.5);

  // ── Patellar tendinopathy ───────────────────────────────────────────
  await linkConditionExercise("patellar-tendinopathy", "vmo-quad-set", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("patellar-tendinopathy", "wall-sit", "DIRECT", "ACTIVATION", 2, "Iso de carga progresiva");
  await linkConditionExercise("patellar-tendinopathy", "spanish-squat", "DIRECT", "LOAD", 3, "Variante con banda — gold standard tendinopatía");
  await linkConditionExercise("patellar-tendinopathy", "step-down-slow", "DIRECT", "STABILITY", 2.5);
  await linkConditionExercise("patellar-tendinopathy", "split-squat", "DIRECT", "LOAD", 2);
  await linkConditionExercise("patellar-tendinopathy", "bulgarian-split", "DIRECT", "PROGRESSION", 2);
  await linkConditionExercise("patellar-tendinopathy", "clamshell", "INDIRECT", "ACTIVATION", 1.5, "Glúteo medio — alinea la cadena");
  await linkConditionExercise("patellar-tendinopathy", "sl-rdl", "INDIRECT", "LOAD", 1.5, "Cadena posterior balanceada");
  await linkConditionExercise("patellar-tendinopathy", "calf-raise", "INDIRECT", "ACTIVATION", 1);

  // ── PFPS ────────────────────────────────────────────────────────────
  await linkConditionExercise("pf-pain", "clamshell", "DIRECT", "ACTIVATION", 2.5, "Mejor tracking patelar vía cadera");
  await linkConditionExercise("pf-pain", "vmo-quad-set", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("pf-pain", "wall-sit", "DIRECT", "ACTIVATION", 1.5);
  await linkConditionExercise("pf-pain", "step-down-slow", "DIRECT", "STABILITY", 2.5);
  await linkConditionExercise("pf-pain", "monster-walk", "DIRECT", "STABILITY", 2);
  await linkConditionExercise("pf-pain", "single-leg-stance", "DIRECT", "STABILITY", 1.5);
  await linkConditionExercise("pf-pain", "split-squat", "DIRECT", "LOAD", 2);
  await linkConditionExercise("pf-pain", "side-plank-raise", "INDIRECT", "STABILITY", 1.5);
  await linkConditionExercise("pf-pain", "foam-roller-itb", "INDIRECT", "ACTIVATION", 1);

  // ── Meniscus ────────────────────────────────────────────────────────
  await linkConditionExercise("meniscus-lateral", "wall-sit", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("meniscus-lateral", "leg-extension-iso", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("meniscus-lateral", "step-down-slow", "DIRECT", "STABILITY", 2);
  await linkConditionExercise("meniscus-lateral", "clamshell", "INDIRECT", "ACTIVATION", 1.5);
  await linkConditionExercise("meniscus-lateral", "goblet-squat", "DIRECT", "LOAD", 2);

  // ── ACL post-op ─────────────────────────────────────────────────────
  await linkConditionExercise("acl-postop", "vmo-quad-set", "DIRECT", "ACTIVATION", 3);
  await linkConditionExercise("acl-postop", "leg-extension-iso", "DIRECT", "ACTIVATION", 2.5);
  await linkConditionExercise("acl-postop", "ham-bridge", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("acl-postop", "step-up", "DIRECT", "STABILITY", 2);
  await linkConditionExercise("acl-postop", "single-leg-stance", "DIRECT", "STABILITY", 2);
  await linkConditionExercise("acl-postop", "split-squat", "DIRECT", "LOAD", 2);
  await linkConditionExercise("acl-postop", "sl-rdl", "DIRECT", "LOAD", 2);
  await linkConditionExercise("acl-postop", "drop-landing", "DIRECT", "PROGRESSION", 3);
  await linkConditionExercise("acl-postop", "skater-jump", "DIRECT", "PROGRESSION", 2.5);
  await linkConditionExercise("acl-postop", "clamshell", "INDIRECT", "ACTIVATION", 1.5);
  await linkConditionExercise("acl-postop", "side-plank-raise", "INDIRECT", "STABILITY", 1.5);

  // ── Trochanteric bursitis ───────────────────────────────────────────
  await linkConditionExercise("trochanteric-bursitis", "clamshell", "DIRECT", "ACTIVATION", 3);
  await linkConditionExercise("trochanteric-bursitis", "fire-hydrant", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("trochanteric-bursitis", "monster-walk", "DIRECT", "STABILITY", 2);
  await linkConditionExercise("trochanteric-bursitis", "single-leg-stance", "DIRECT", "STABILITY", 1.5);
  await linkConditionExercise("trochanteric-bursitis", "glute-bridge", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("trochanteric-bursitis", "side-plank-raise", "INDIRECT", "STABILITY", 2);
  await linkConditionExercise("trochanteric-bursitis", "foam-roller-glute", "INDIRECT", "ACTIVATION", 1);

  // ── FAI ─────────────────────────────────────────────────────────────
  await linkConditionExercise("hip-impingement", "dead-bug", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("hip-impingement", "bird-dog", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("hip-impingement", "clamshell", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("hip-impingement", "pelvic-tilt", "DIRECT", "ACTIVATION", 1.5);
  await linkConditionExercise("hip-impingement", "side-plank-raise", "INDIRECT", "STABILITY", 2, "Core lateral controla la cadera");

  // ── Psoas ───────────────────────────────────────────────────────────
  await linkConditionExercise("psoas-tendinitis", "psoas-stretch", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("psoas-tendinitis", "dead-bug", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("psoas-tendinitis", "pelvic-tilt", "DIRECT", "ACTIVATION", 1.5);
  await linkConditionExercise("psoas-tendinitis", "glute-bridge", "INDIRECT", "ACTIVATION", 1.5, "Glúteo balancea el flexor");
  await linkConditionExercise("psoas-tendinitis", "front-plank", "INDIRECT", "STABILITY", 1);

  // ── Ankle sprain ────────────────────────────────────────────────────
  await linkConditionExercise("ankle-sprain-lateral", "ankle-eversion-band", "DIRECT", "ACTIVATION", 3);
  await linkConditionExercise("ankle-sprain-lateral", "calf-raise", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("ankle-sprain-lateral", "single-leg-stance", "DIRECT", "STABILITY", 2.5);
  await linkConditionExercise("ankle-sprain-lateral", "ankle-balance-foam", "DIRECT", "STABILITY", 2);
  await linkConditionExercise("ankle-sprain-lateral", "skater-jump", "DIRECT", "PROGRESSION", 2);
  await linkConditionExercise("ankle-sprain-lateral", "clamshell", "INDIRECT", "ACTIVATION", 1, "Glúteo medio estabiliza la cadena");
  await linkConditionExercise("ankle-sprain-lateral", "short-foot", "DIRECT", "ACTIVATION", 1.5);

  // ── Achilles tendinopathy ───────────────────────────────────────────
  await linkConditionExercise("achilles-tendinopathy", "calf-raise-eccentric", "DIRECT", "LOAD", 3);
  await linkConditionExercise("achilles-tendinopathy", "alfredson-protocol", "DIRECT", "LOAD", 3, "Gold standard tendinopatía Aquiles");
  await linkConditionExercise("achilles-tendinopathy", "calf-raise", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("achilles-tendinopathy", "single-leg-stance", "DIRECT", "STABILITY", 1.5);
  await linkConditionExercise("achilles-tendinopathy", "glute-bridge", "INDIRECT", "ACTIVATION", 1);

  // ── Plantar fasciitis ───────────────────────────────────────────────
  await linkConditionExercise("plantar-fasciitis", "calf-raise", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("plantar-fasciitis", "calf-raise-eccentric", "DIRECT", "LOAD", 2.5);
  await linkConditionExercise("plantar-fasciitis", "toe-yoga", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("plantar-fasciitis", "short-foot", "DIRECT", "ACTIVATION", 2.5);
  await linkConditionExercise("plantar-fasciitis", "single-leg-stance", "DIRECT", "STABILITY", 1.5);
  await linkConditionExercise("plantar-fasciitis", "clamshell", "INDIRECT", "ACTIVATION", 1);

  // ── Shoulder impingement ────────────────────────────────────────────
  await linkConditionExercise("shoulder-impingement", "scapular-pull", "DIRECT", "ACTIVATION", 3);
  await linkConditionExercise("shoulder-impingement", "wall-slide", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("shoulder-impingement", "y-t-w-raises", "DIRECT", "STABILITY", 2.5);
  await linkConditionExercise("shoulder-impingement", "external-rotation-band", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("shoulder-impingement", "prone-i-y", "DIRECT", "STABILITY", 1.5);
  await linkConditionExercise("shoulder-impingement", "face-pull", "DIRECT", "LOAD", 2);
  await linkConditionExercise("shoulder-impingement", "doorway-stretch", "ANTAGONIST", "ACTIVATION", 1.5, "Estira pectoral, contrarresta postura");
  await linkConditionExercise("shoulder-impingement", "front-plank", "INDIRECT", "STABILITY", 1);

  // ── Rotator cuff tendinopathy ───────────────────────────────────────
  await linkConditionExercise("rotator-cuff-tendinopathy", "external-rotation-band", "DIRECT", "ACTIVATION", 3);
  await linkConditionExercise("rotator-cuff-tendinopathy", "scapular-pull", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("rotator-cuff-tendinopathy", "y-t-w-raises", "DIRECT", "STABILITY", 2);
  await linkConditionExercise("rotator-cuff-tendinopathy", "prone-i-y", "DIRECT", "STABILITY", 2);
  await linkConditionExercise("rotator-cuff-tendinopathy", "face-pull", "DIRECT", "LOAD", 2);
  await linkConditionExercise("rotator-cuff-tendinopathy", "doorway-stretch", "ANTAGONIST", "ACTIVATION", 1.5);

  // ── Frozen shoulder ─────────────────────────────────────────────────
  await linkConditionExercise("frozen-shoulder", "pendulum", "DIRECT", "ACTIVATION", 3);
  await linkConditionExercise("frozen-shoulder", "wall-slide", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("frozen-shoulder", "cross-body-stretch", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("frozen-shoulder", "sleeper-stretch", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("frozen-shoulder", "scapular-pull", "INDIRECT", "STABILITY", 1.5);

  // ── AC joint sprain ─────────────────────────────────────────────────
  await linkConditionExercise("ac-joint-sprain", "pendulum", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("ac-joint-sprain", "scapular-pull", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("ac-joint-sprain", "external-rotation-band", "DIRECT", "ACTIVATION", 1.5);
  await linkConditionExercise("ac-joint-sprain", "wall-slide", "DIRECT", "STABILITY", 2);

  // ── Lateral epicondylitis ───────────────────────────────────────────
  await linkConditionExercise("lateral-epicondylitis", "wrist-extensor-eccentric", "DIRECT", "LOAD", 3);
  await linkConditionExercise("lateral-epicondylitis", "rice-grip", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("lateral-epicondylitis", "tendon-glide", "DIRECT", "ACTIVATION", 1.5);
  await linkConditionExercise("lateral-epicondylitis", "scapular-pull", "INDIRECT", "STABILITY", 1.5, "Hombro estable descarga al codo");

  // ── Medial epicondylitis ────────────────────────────────────────────
  await linkConditionExercise("medial-epicondylitis", "wrist-flexor-eccentric", "DIRECT", "LOAD", 3);
  await linkConditionExercise("medial-epicondylitis", "rice-grip", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("medial-epicondylitis", "tendon-glide", "DIRECT", "ACTIVATION", 1.5);
  await linkConditionExercise("medial-epicondylitis", "scapular-pull", "INDIRECT", "STABILITY", 1.5);

  // ── Bicep tendinopathy ──────────────────────────────────────────────
  await linkConditionExercise("bicep-tendinopathy", "scapular-pull", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("bicep-tendinopathy", "external-rotation-band", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("bicep-tendinopathy", "y-t-w-raises", "DIRECT", "STABILITY", 2);
  await linkConditionExercise("bicep-tendinopathy", "front-plank", "INDIRECT", "STABILITY", 1.5, "Core anterior — el tendón distal del bíceps actúa en cadena con la pared anterior");
  await linkConditionExercise("bicep-tendinopathy", "dead-bug", "INDIRECT", "ACTIVATION", 1.5, "Core anterior + control escapular en cadena anterior");

  // ── Carpal tunnel ───────────────────────────────────────────────────
  await linkConditionExercise("carpal-tunnel", "median-nerve-glide", "DIRECT", "ACTIVATION", 3);
  await linkConditionExercise("carpal-tunnel", "tendon-glide", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("carpal-tunnel", "wrist-extensor-eccentric", "DIRECT", "LOAD", 1.5);
  await linkConditionExercise("carpal-tunnel", "scapular-pull", "INDIRECT", "STABILITY", 1.5);

  // ── De Quervain ─────────────────────────────────────────────────────
  await linkConditionExercise("dequervain", "thumb-extension-band", "DIRECT", "LOAD", 3);
  await linkConditionExercise("dequervain", "tendon-glide", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("dequervain", "rice-grip", "DIRECT", "ACTIVATION", 1.5);

  // ── Lumbar mechanical ───────────────────────────────────────────────
  await linkConditionExercise("lumbar-mechanical", "pelvic-tilt", "DIRECT", "ACTIVATION", 2.5);
  await linkConditionExercise("lumbar-mechanical", "cat-cow", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("lumbar-mechanical", "bird-dog", "DIRECT", "STABILITY", 2.5);
  await linkConditionExercise("lumbar-mechanical", "dead-bug", "DIRECT", "STABILITY", 2.5);
  await linkConditionExercise("lumbar-mechanical", "front-plank", "DIRECT", "STABILITY", 2);
  await linkConditionExercise("lumbar-mechanical", "side-plank", "DIRECT", "STABILITY", 2);
  await linkConditionExercise("lumbar-mechanical", "glute-bridge", "INDIRECT", "ACTIVATION", 2);
  await linkConditionExercise("lumbar-mechanical", "clamshell", "INDIRECT", "ACTIVATION", 1.5);

  // ── Lumbar disc ─────────────────────────────────────────────────────
  await linkConditionExercise("lumbar-disc", "mckenzie-extension", "DIRECT", "ACTIVATION", 3);
  await linkConditionExercise("lumbar-disc", "pelvic-tilt", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("lumbar-disc", "bird-dog", "DIRECT", "STABILITY", 2);
  await linkConditionExercise("lumbar-disc", "dead-bug", "DIRECT", "STABILITY", 2);
  await linkConditionExercise("lumbar-disc", "glute-bridge", "INDIRECT", "ACTIVATION", 2);
  await linkConditionExercise("lumbar-disc", "side-plank", "INDIRECT", "STABILITY", 1.5);

  // ── SI dysfunction ──────────────────────────────────────────────────
  await linkConditionExercise("si-dysfunction", "clamshell", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("si-dysfunction", "glute-bridge-uni", "DIRECT", "ACTIVATION", 2.5);
  await linkConditionExercise("si-dysfunction", "bird-dog", "DIRECT", "STABILITY", 2);
  await linkConditionExercise("si-dysfunction", "side-plank-raise", "DIRECT", "STABILITY", 2);
  await linkConditionExercise("si-dysfunction", "piriformis-stretch", "ANTAGONIST", "ACTIVATION", 1.5);

  // ── Cervicalgia ─────────────────────────────────────────────────────
  await linkConditionExercise("cervicalgia", "chin-tuck", "DIRECT", "ACTIVATION", 3);
  await linkConditionExercise("cervicalgia", "neck-cars", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("cervicalgia", "upper-trap-stretch", "ANTAGONIST", "ACTIVATION", 2);
  await linkConditionExercise("cervicalgia", "scapular-pull", "INDIRECT", "STABILITY", 2);
  await linkConditionExercise("cervicalgia", "wall-slide", "INDIRECT", "STABILITY", 1.5);
  await linkConditionExercise("cervicalgia", "doorway-stretch", "ANTAGONIST", "ACTIVATION", 1.5);

  // ── Tension headache ────────────────────────────────────────────────
  await linkConditionExercise("tension-headache", "chin-tuck", "DIRECT", "ACTIVATION", 2.5);
  await linkConditionExercise("tension-headache", "neck-cars", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("tension-headache", "upper-trap-stretch", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("tension-headache", "scapular-pull", "INDIRECT", "STABILITY", 1.5);

  // ── Calf strain ─────────────────────────────────────────────────────
  await linkConditionExercise("calf-strain", "calf-raise", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("calf-strain", "calf-raise-eccentric", "DIRECT", "LOAD", 3);
  await linkConditionExercise("calf-strain", "single-leg-stance", "DIRECT", "STABILITY", 1.5);
  await linkConditionExercise("calf-strain", "ham-bridge", "INDIRECT", "ACTIVATION", 1.5, "Cadena posterior balanceada");

  // ── Hamstring strain ────────────────────────────────────────────────
  await linkConditionExercise("hamstring-strain", "ham-bridge", "DIRECT", "ACTIVATION", 2.5);
  await linkConditionExercise("hamstring-strain", "sl-rdl", "DIRECT", "LOAD", 2.5);
  await linkConditionExercise("hamstring-strain", "nordic-hamstring", "DIRECT", "PROGRESSION", 3);
  await linkConditionExercise("hamstring-strain", "good-morning", "DIRECT", "LOAD", 2);
  await linkConditionExercise("hamstring-strain", "glute-bridge", "INDIRECT", "ACTIVATION", 1.5);
  await linkConditionExercise("hamstring-strain", "clamshell", "INDIRECT", "ACTIVATION", 1);

  // ── Groin strain ────────────────────────────────────────────────────
  await linkConditionExercise("groin-strain", "side-plank", "DIRECT", "STABILITY", 2.5);
  await linkConditionExercise("groin-strain", "dead-bug", "DIRECT", "ACTIVATION", 2);
  await linkConditionExercise("groin-strain", "split-squat", "DIRECT", "LOAD", 2);
  await linkConditionExercise("groin-strain", "clamshell", "INDIRECT", "ACTIVATION", 1.5);
  await linkConditionExercise("groin-strain", "front-plank", "INDIRECT", "STABILITY", 1.5);
}

// ──────────────────────────────────────────────────────────────────────
// Demo tenant
// ──────────────────────────────────────────────────────────────────────

async function seedDemoTenant() {
  console.log("[seed] demo tenant: movare");

  const tenant = await prisma.tenant.upsert({
    where: { slug: "movare" },
    create: {
      slug: "movare",
      name: "Centro KineMovare",
      legalName: "Movare S.R.L.",
      palette: "sky",
    },
    update: { name: "Centro KineMovare" },
  });

  const userId = "demo-lucia";
  await prisma.userProfile.upsert({
    where: { id: userId },
    create: { id: userId, email: "lucia@movare.demo", fullName: "Lucía Méndez" },
    update: {},
  });
  const practitioner = await prisma.practitioner.upsert({
    where: { userId },
    create: {
      tenantId: tenant.id,
      userId,
      licenseNumber: "MN-5412",
      specialty: "Kinesiología deportiva",
      yearsExp: 12,
      rating: 4.9,
    },
    update: {},
  });
  await prisma.membership.upsert({
    where: { userId_tenantId: { userId, tenantId: tenant.id } },
    create: { userId, tenantId: tenant.id, role: "OWNER", acceptedAt: new Date() },
    update: {},
  });

  const services = await Promise.all([
    prisma.service.upsert({
      where: { id: `${tenant.id}-svc-particular` },
      create: {
        id: `${tenant.id}-svc-particular`,
        tenantId: tenant.id,
        practitionerId: practitioner.id,
        name: "Sesión kinésica · particular",
        durationMin: 45,
        priceCents: 1_850_000,
      },
      update: {},
    }),
    prisma.service.upsert({
      where: { id: `${tenant.id}-svc-os` },
      create: {
        id: `${tenant.id}-svc-os`,
        tenantId: tenant.id,
        practitionerId: practitioner.id,
        name: "Sesión kinésica · obra social",
        durationMin: 45,
        priceCents: 850_000,
      },
      update: {},
    }),
    prisma.service.upsert({
      where: { id: `${tenant.id}-svc-eval` },
      create: {
        id: `${tenant.id}-svc-eval`,
        tenantId: tenant.id,
        practitionerId: practitioner.id,
        name: "Evaluación inicial",
        durationMin: 60,
        priceCents: 2_500_000,
      },
      update: {},
    }),
  ]);
  const [particularSvc, osSvc] = services;

  const seedsP = [
    { first: "Sofía", last: "Linares", dni: "33245117", dob: "1993-08-12", email: "sofi.linares@gmail.com", phone: "+5493414158821", insurer: "Swiss Medical" },
    { first: "Martín", last: "Aguirre", dni: "30412889", dob: "1984-03-21", email: "martin.aguirre@gmail.com", phone: "+5491133221145", insurer: "OSDE" },
    { first: "Eugenio", last: "Paz", dni: "28991410", dob: "1981-11-04", email: "epaz@outlook.com", phone: "+5493418876221", insurer: "Galeno" },
    { first: "Marta", last: "Costa", dni: "12554320", dob: "1969-05-30", email: "marta.costa@gmail.com", phone: "+5491144112233", insurer: "Particular" },
    { first: "Laura", last: "Báez", dni: "37889102", dob: "1990-01-15", email: "lbaez@gmail.com", phone: "+5491133554477", insurer: "Medifé" },
    { first: "Diego", last: "Sosa", dni: "34119876", dob: "1988-09-09", email: "diego.sosa@gmail.com", phone: "+5491168772211", insurer: "OSDE" },
  ];

  const patients: { id: string }[] = [];
  for (const s of seedsP) {
    const p = await prisma.patient.upsert({
      where: { tenantId_documentId: { tenantId: tenant.id, documentId: s.dni } },
      create: {
        tenantId: tenant.id,
        firstName: s.first,
        lastName: s.last,
        documentId: s.dni,
        dateOfBirth: new Date(s.dob),
        email: s.email,
        phone: s.phone,
        notes: s.first === "Sofía" ? "Maratonista amateur. Dolor lateral de rodilla der. al correr." : null,
      },
      update: {},
    });
    await prisma.coverage.deleteMany({ where: { patientId: p.id } });
    await prisma.coverage.create({
      data: { patientId: p.id, insurer: s.insurer, planName: s.insurer === "OSDE" ? "410" : null },
    });
    patients.push({ id: p.id });
  }

  // Sofía's ITBS case + program (3 of 8 done).
  const sofia = patients[0];
  const itband = await prisma.condition.findUnique({ where: { slug: "itband" } });
  await prisma.treatmentProgram.deleteMany({ where: { patientId: sofia.id } });
  await prisma.clinicalCase.deleteMany({ where: { patientId: sofia.id } });

  const now = new Date();
  now.setHours(10, 0, 0, 0);
  const sofiaStart = new Date(now);
  sofiaStart.setDate(sofiaStart.getDate() - 14);

  const sofiaCase = await prisma.clinicalCase.create({
    data: {
      tenantId: tenant.id,
      authorId: practitioner.id,
      patientId: sofia.id,
      selectedZones: ["knee-r", "hip-r"],
      refinements: {
        symptoms: ["symptom-burning", "symptom-sharp"],
        triggers: ["trigger-running", "trigger-stairs-down"],
        phase: "phase-subacute",
        intensity: 6,
      },
    },
  });
  if (itband) {
    await prisma.diagnosis.create({
      data: { caseId: sofiaCase.id, conditionId: itband.id, matchScore: 0.94, confirmed: true, rank: 1 },
    });
  }

  const sofiaProgram = await prisma.treatmentProgram.create({
    data: {
      tenantId: tenant.id,
      patientId: sofia.id,
      caseId: sofiaCase.id,
      title: "Plan banda iliotibial · 8 sesiones",
      totalSessions: 8,
      frequency: 2,
      startDate: sofiaStart,
      status: ProgramStatus.ACTIVE,
      sessions: {
        create: Array.from({ length: 8 }).map((_, i) => {
          const sched = new Date(sofiaStart);
          sched.setDate(sched.getDate() + Math.floor(i * 3.5));
          return {
            practitionerId: practitioner.id,
            index: i + 1,
            scheduledFor: sched,
            completedAt: i < 3 ? new Date(sched.getTime() + 45 * 60_000) : null,
            notes:
              i === 0 ? "Eval inicial. EVA 7/10."
                : i === 1 ? "Trabajo isométrico cuádriceps + step-down."
                : i === 2 ? "Excéntrico isquios + activación glúteo medio."
                : null,
            paInPre: i < 3 ? [7, 6, 5][i] : null,
            paInPost: i < 3 ? [6, 5, 4][i] : null,
            rpe: i < 3 ? [6, 7, 6][i] : null,
          };
        }),
      },
    },
    include: { sessions: true },
  });
  await prisma.evaScore.deleteMany({ where: { patientId: sofia.id } });
  await prisma.evaScore.createMany({
    data: [
      { patientId: sofia.id, value: 7, source: "session-1-pre", takenAt: sofiaProgram.sessions[0].scheduledFor },
      { patientId: sofia.id, value: 6, source: "session-1-post", takenAt: new Date(+sofiaProgram.sessions[0].scheduledFor + 60 * 60_000) },
      { patientId: sofia.id, value: 6, source: "session-2-pre", takenAt: sofiaProgram.sessions[1].scheduledFor },
      { patientId: sofia.id, value: 5, source: "session-2-post", takenAt: new Date(+sofiaProgram.sessions[1].scheduledFor + 60 * 60_000) },
      { patientId: sofia.id, value: 5, source: "session-3-pre", takenAt: sofiaProgram.sessions[2].scheduledFor },
      { patientId: sofia.id, value: 4, source: "session-3-post", takenAt: new Date(+sofiaProgram.sessions[2].scheduledFor + 60 * 60_000) },
    ],
  });

  // Eugenio's post-LCA program.
  const eugenio = patients[2];
  await prisma.treatmentProgram.deleteMany({ where: { patientId: eugenio.id } });
  const eugStart = new Date(now);
  eugStart.setDate(eugStart.getDate() - 30);
  await prisma.treatmentProgram.create({
    data: {
      tenantId: tenant.id,
      patientId: eugenio.id,
      title: "Rehab post-op LCA · 24 sesiones",
      totalSessions: 24,
      frequency: 3,
      startDate: eugStart,
      status: ProgramStatus.ACTIVE,
      sessions: {
        create: Array.from({ length: 24 }).map((_, i) => {
          const sched = new Date(eugStart);
          sched.setDate(sched.getDate() + Math.floor((i * 7) / 3));
          return {
            practitionerId: practitioner.id,
            index: i + 1,
            scheduledFor: sched,
            completedAt: i < 14 ? new Date(sched.getTime() + 45 * 60_000) : null,
            paInPre: i < 14 ? Math.max(2, 7 - Math.floor(i / 3)) : null,
            paInPost: i < 14 ? Math.max(1, 5 - Math.floor(i / 3)) : null,
          };
        }),
      },
    },
  });

  await prisma.payment.deleteMany({ where: { booking: { tenantId: tenant.id } } });
  await prisma.booking.deleteMany({ where: { tenantId: tenant.id } });

  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  const dayOffset = (weekStart.getDay() + 6) % 7;
  weekStart.setDate(weekStart.getDate() - dayOffset);

  const plan: { dayOffset: number; hour: number; patientIdx: number; svc: typeof particularSvc; status: BookingStatus }[] = [
    { dayOffset: -7, hour: 9, patientIdx: 1, svc: particularSvc, status: "COMPLETED" },
    { dayOffset: -7, hour: 10, patientIdx: 0, svc: particularSvc, status: "COMPLETED" },
    { dayOffset: -7, hour: 11, patientIdx: 2, svc: osSvc, status: "COMPLETED" },
    { dayOffset: -5, hour: 14, patientIdx: 4, svc: particularSvc, status: "COMPLETED" },
    { dayOffset: -3, hour: 9, patientIdx: 0, svc: particularSvc, status: "COMPLETED" },
    { dayOffset: -2, hour: 11, patientIdx: 3, svc: osSvc, status: "NO_SHOW" },
    { dayOffset: 0, hour: 9, patientIdx: 1, svc: osSvc, status: "CONFIRMED" },
    { dayOffset: 0, hour: 10, patientIdx: 0, svc: particularSvc, status: "CONFIRMED" },
    { dayOffset: 0, hour: 11, patientIdx: 3, svc: particularSvc, status: "CONFIRMED" },
    { dayOffset: 0, hour: 14, patientIdx: 2, svc: osSvc, status: "CONFIRMED" },
    { dayOffset: 0, hour: 16, patientIdx: 5, svc: particularSvc, status: "CONFIRMED" },
    { dayOffset: 1, hour: 9, patientIdx: 4, svc: particularSvc, status: "CONFIRMED" },
    { dayOffset: 1, hour: 10, patientIdx: 0, svc: osSvc, status: "CONFIRMED" },
    { dayOffset: 1, hour: 15, patientIdx: 2, svc: particularSvc, status: "CONFIRMED" },
    { dayOffset: 2, hour: 9, patientIdx: 3, svc: osSvc, status: "CONFIRMED" },
    { dayOffset: 2, hour: 11, patientIdx: 5, svc: particularSvc, status: "CONFIRMED" },
    { dayOffset: 3, hour: 14, patientIdx: 4, svc: osSvc, status: "CONFIRMED" },
    { dayOffset: 4, hour: 10, patientIdx: 0, svc: particularSvc, status: "CONFIRMED" },
  ];

  for (const [i, b] of plan.entries()) {
    const scheduledFor = new Date(weekStart);
    scheduledFor.setDate(scheduledFor.getDate() + b.dayOffset);
    scheduledFor.setHours(b.hour, 0, 0, 0);
    const booking = await prisma.booking.create({
      data: {
        tenantId: tenant.id,
        practitionerId: practitioner.id,
        serviceId: b.svc.id,
        patientId: patients[b.patientIdx].id,
        scheduledFor,
        durationMin: b.svc.durationMin,
        status: b.status,
        paymentStatus: b.status === "COMPLETED" ? PaymentStatus.PAID : PaymentStatus.UNPAID,
        idempotencyKey: `seed-${i}-${tenant.id}`,
      },
    });
    if (b.status === "COMPLETED") {
      await prisma.payment.create({
        data: {
          bookingId: booking.id,
          provider: "manual",
          status: PaymentStatus.PAID,
          amountCents: b.svc.priceCents,
          currency: "ARS",
          createdAt: scheduledFor,
        },
      });
    }
  }

  console.log(`[seed] tenant ${tenant.slug}: ${patients.length} patients, ${plan.length} bookings`);
}

async function main() {
  await seedTags();
  await seedRegions();
  await seedConditions();
  await seedRelations();
  await seedExercises();
  await seedExerciseLinks();
  await seedDemoTenant();
  console.log("[seed] done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

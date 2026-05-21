/**
 * One-shot seed for Sprint 13 additions:
 *
 *   - Seeds a starter set of Obras Sociales for each tenant.
 *   - Marks a handful of existing exercises as MANUAL_THERAPY so the
 *     Terapia Manual library has content on day one.
 *   - Idempotent: re-running is safe.
 *
 * Run with:  npx tsx scripts/seed-sprint13.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const STARTER_INSURERS = [
  { name: "OSDE", copagoCents: 0, fixedFeeCents: 12_000_00 },
  { name: "Swiss Medical", copagoCents: 0, fixedFeeCents: 11_500_00 },
  { name: "Galeno", copagoCents: 200_00, fixedFeeCents: 9_500_00 },
  { name: "Medicus", copagoCents: 0, fixedFeeCents: 10_500_00 },
  { name: "Omint", copagoCents: 300_00, fixedFeeCents: 9_000_00 },
  { name: "IOMA", copagoCents: 500_00, fixedFeeCents: 7_500_00 },
  { name: "PAMI", copagoCents: 0, fixedFeeCents: 6_800_00 },
  { name: "Particular", copagoCents: 0, fixedFeeCents: 0 },
];

// Curated set of manual-therapy maneuvers seeded as global catalogue
// rows (tenantId null). Plan gating still applies — basic ones are
// flagged `isBasic` so FREE/STARTER tenants get at least the staples.
const MANUAL_THERAPY_SEED = [
  {
    slug: "masaje-descontracturante-trapecio",
    name: "Masaje descontracturante de trapecio",
    description: "Trabajo de descontracturación con técnicas suecas + amasamiento profundo sobre fibras del trapecio superior.",
    instructions: "1. Posición prono o sentado.\n2. Roces superficiales 1-2 min.\n3. Amasamiento digital 3-5 min por lado.\n4. Estiramientos pasivos al cierre.",
    cues: "Buscar puntos gatillo activos antes de profundizar. Respetar la tolerancia del paciente.",
    muscleGroups: "Trapecio superior, Cervicales",
    difficulty: 2,
    defaultSets: 1,
    defaultReps: 1,
    isBasic: true,
  },
  {
    slug: "liberacion-miofascial-itb",
    name: "Liberación miofascial de banda iliotibial",
    description: "Inhibición miofascial de tensor de fascia lata + banda IT con maniobras manuales (sin foam).",
    instructions: "1. Decúbito lateral, cadera arriba.\n2. Localizar TFL.\n3. Presión sostenida 90s.\n4. Deslizamiento longitudinal hacia distal.",
    cues: "No comprimir directamente sobre la cintilla — trabajar tejido contiguo.",
    muscleGroups: "TFL, Banda IT, Cuádriceps lateral",
    difficulty: 3,
    defaultSets: 1,
    defaultReps: 1,
    isBasic: true,
  },
  {
    slug: "movilizacion-articular-grado-3-tobillo",
    name: "Movilización articular grado III de tobillo",
    description: "Movilización accesoria postero-anterior del astrágalo para recuperar dorsiflexión.",
    instructions: "1. Paciente en supino, rodilla flexionada.\n2. Tomar astrágalo entre pulgar e índice.\n3. Imprimir movimiento postero-anterior rítmico, 2-3 min.",
    cues: "Mantener el tobillo en posición neutra durante la maniobra. Sin dolor.",
    muscleGroups: "Tobillo, Astrágalo",
    difficulty: 4,
    defaultSets: 1,
    defaultReps: 1,
    isBasic: false,
  },
  {
    slug: "tecnica-cyriax-epicondilitis",
    name: "Técnica de Cyriax (masaje transverso profundo) - Epicondilitis",
    description: "Fricción transversa profunda en la inserción de los epicondíleos.",
    instructions: "1. Codo a 90°, antebrazo en pronación.\n2. Localizar epicondilo lateral.\n3. Fricción transversa 5-10 min con presión gradual.",
    cues: "El paciente puede sentir incomodidad los primeros 2-3 min, luego mejora.",
    muscleGroups: "Epicondíleos, Codo lateral",
    difficulty: 3,
    defaultSets: 1,
    defaultReps: 1,
    isBasic: true,
  },
  {
    slug: "puntos-gatillo-piramidal",
    name: "Liberación de puntos gatillo en piramidal",
    description: "Inhibición de puntos gatillo en músculo piriforme con compresión isquémica.",
    instructions: "1. Decúbito lateral, cadera en flexión y rotación interna.\n2. Localizar el PG en el cuerpo del piramidal.\n3. Compresión 60-90s hasta atenuación del dolor.",
    cues: "Verificar irradiación al ciático antes y después. Si reproduce, derivar.",
    muscleGroups: "Piramidal, Glúteo profundo",
    difficulty: 3,
    defaultSets: 1,
    defaultReps: 1,
    isBasic: false,
  },
  {
    slug: "drenaje-linfatico-mmii",
    name: "Drenaje linfático manual de miembros inferiores",
    description: "Maniobras de drenaje linfático manual para reducir edema de tobillo o rodilla post-cirugía.",
    instructions: "1. Decúbito supino con elevación de MI.\n2. Iniciar por ganglios inguinales.\n3. Maniobras circulares y bombeos en sentido proximal, 15-20 min.",
    cues: "Presión muy suave (~30 mmHg). Movilizar piel, no comprimir.",
    muscleGroups: "Sistema linfático MMII",
    difficulty: 2,
    defaultSets: 1,
    defaultReps: 1,
    isBasic: true,
  },
  {
    slug: "estiramiento-pasivo-isquiotibiales",
    name: "Estiramiento pasivo de isquiotibiales (kinesiólogo asistido)",
    description: "Estiramiento pasivo asistido en cadena posterior con énfasis isquiotibial.",
    instructions: "1. Paciente en supino.\n2. Cadera a 90°, extender rodilla pasivamente.\n3. Mantener 30-45s × 3 series por pierna.",
    cues: "Coordinar con la respiración del paciente. Aprovechar exhalación para ganar rango.",
    muscleGroups: "Isquiotibiales, Cadena posterior",
    difficulty: 1,
    defaultSets: 3,
    defaultReps: 1,
    isBasic: true,
  },
  {
    slug: "fnp-cervical",
    name: "Facilitación neuromuscular propioceptiva cervical",
    description: "Patrones FNP para fortalecimiento y reeducación de musculatura cervical profunda.",
    instructions: "1. Paciente sentado.\n2. Patrón D1 flexión-rotación con resistencia manual.\n3. 6-8 reps por patrón × 2 series por lado.",
    cues: "Velocidad moderada, resistencia gradual. Ajustar según respuesta.",
    muscleGroups: "Flexores profundos del cuello, Esternocleidomastoideo",
    difficulty: 4,
    defaultSets: 2,
    defaultReps: 8,
    isBasic: false,
  },
  {
    slug: "manipulacion-toracica-postero-anterior",
    name: "Manipulación torácica postero-anterior",
    description: "Manipulación de alta velocidad y baja amplitud (HVLA) sobre segmentos torácicos hipomóviles.",
    instructions: "1. Paciente en supino, brazos cruzados.\n2. Localizar segmento.\n3. Impulso PA controlado al fin del rango.",
    cues: "Requiere formación en manipulación. Excluir banderas rojas antes.",
    muscleGroups: "Columna torácica",
    difficulty: 5,
    defaultSets: 1,
    defaultReps: 1,
    isBasic: false,
  },
  {
    slug: "bombeos-articulares-rodilla",
    name: "Bombeos articulares de rodilla",
    description: "Movilización rítmica de rodilla en flexo-extensión con tracción suave para favorecer nutrición articular.",
    instructions: "1. Paciente en supino.\n2. Tomar tibia y aplicar tracción longitudinal suave.\n3. Movilizar flexo-extensión rítmica 3-5 min.",
    cues: "Indicado en rodillas con derrame leve y en post-operatorio temprano.",
    muscleGroups: "Articulación de rodilla",
    difficulty: 2,
    defaultSets: 1,
    defaultReps: 1,
    isBasic: true,
  },
];

async function main() {
  const tenants = await prisma.tenant.findMany({ select: { id: true, slug: true } });
  console.log(`Found ${tenants.length} tenants.`);

  // 1) Insurers per tenant.
  for (const t of tenants) {
    let created = 0;
    for (const ins of STARTER_INSURERS) {
      const result = await prisma.insurer.upsert({
        where: { tenantId_name: { tenantId: t.id, name: ins.name } },
        create: { ...ins, tenantId: t.id },
        update: {},
      });
      if (result) created++;
    }
    console.log(`  · ${t.slug}: ${created} insurers ensured`);
  }

  // 2) Seed manual-therapy maneuvers as global catalogue rows.
  let mtCreated = 0;
  let mtUpdated = 0;
  for (const m of MANUAL_THERAPY_SEED) {
    const r = await prisma.exercise.upsert({
      where: { slug: m.slug },
      create: { ...m, kind: "MANUAL_THERAPY", tenantId: null },
      update: { ...m, kind: "MANUAL_THERAPY" },
    });
    // Differentiating create vs update via createdAt vs updatedAt is
    // not perfectly reliable, but good enough for the log.
    if (Math.abs(r.createdAt.getTime() - Date.now()) < 5_000) mtCreated++;
    else mtUpdated++;
  }
  console.log(`Manual therapy seeded: ${mtCreated} new, ${mtUpdated} updated`);
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

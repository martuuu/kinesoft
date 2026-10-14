import { PrismaClient, Role, TenantPlan } from "@prisma/client";

import { assertSafeTarget } from "./lib/assert-safe-target";

const prisma = new PrismaClient();

async function main() {
  // Local-only (AUDIT 2026-09-23): this seed rewrites/wipes tenant data; it
  // must never reach production, whatever `.env` currently points to.
  assertSafeTarget({ url: process.env.DATABASE_URL, allowRemote: false, scriptName: "seed-santiago" });
  const userId = "5485a113-128f-4038-8243-8161174ce3de";
  const email = "santiago@kinesoft.com";

  console.log("Seeding user:", email, "with ID:", userId);

  // 1. Crear o actualizar el UserProfile
  await prisma.userProfile.upsert({
    where: { id: userId },
    update: { email },
    create: {
      id: userId,
      email,
      fullName: "Santiago (Demo)",
    },
  });
  console.log("✅ UserProfile creado/actualizado");

  // 2. Crear un Tenant (Consultorio)
  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo-kinesoft" },
    update: {},
    create: {
      slug: "demo-kinesoft",
      name: "Consultorio KineSoft Demo",
      plan: TenantPlan.PRO,
    },
  });
  console.log(`✅ Tenant '${tenant.slug}' listo`);

  // 3. Crear el perfil de Practitioner (Profesional)
  // IAM-1 (M6): Practitioner es único por (tenantId, userId), ya no global.
  await prisma.practitioner.upsert({
    where: { tenantId_userId: { tenantId: tenant.id, userId } },
    update: {},
    create: {
      userId,
      tenantId: tenant.id,
      specialty: "Kinesiología General",
      bio: "Perfil demo para Santiago",
    },
  });
  console.log("✅ Practitioner creado/actualizado");

  // 4. Crear el Membership (membresía) que le da rol de OWNER
  await prisma.membership.upsert({
    where: {
      userId_tenantId: {
        userId,
        tenantId: tenant.id,
      },
    },
    update: { role: Role.OWNER, acceptedAt: new Date() },
    create: {
      userId,
      tenantId: tenant.id,
      role: Role.OWNER,
      acceptedAt: new Date(),
    },
  });
  console.log("✅ Membership creado (Rol: OWNER)");

  // 5. Servicios del consultorio
  const SERVICIOS = [
    { name: "Kinesiología General",  durationMin: 45, priceCents: 0 },
    { name: "Osteopatía",            durationMin: 60, priceCents: 0 },
    { name: "ATM",                   durationMin: 45, priceCents: 0 },
    { name: "RPG",                   durationMin: 60, priceCents: 0 },
    { name: "Traumatología",         durationMin: 45, priceCents: 0 },
  ];
  for (const srv of SERVICIOS) {
    // Verificamos si ya existe para no duplicar
    const existing = await prisma.service.findFirst({
      where: { tenantId: tenant.id, name: srv.name },
    });
    if (!existing) {
      await prisma.service.create({
        data: { ...srv, tenantId: tenant.id },
      });
    }
  }
  console.log("✅ Servicios creados: " + SERVICIOS.map((s) => s.name).join(", "));

  console.log("🎉 ¡Listo! Ya podés iniciar sesión con la clave que tenga ese usuario en Supabase Auth.");
}

main()
  .catch((e) => {
    console.error("❌ Error en el seed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

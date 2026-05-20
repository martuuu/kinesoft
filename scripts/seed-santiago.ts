import { PrismaClient, Role, TenantPlan } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
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
  await prisma.practitioner.upsert({
    where: { userId },
    update: { tenantId: tenant.id },
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

  console.log("🎉 ¡Listo! Ya podés iniciar sesión con 'olimpo' u otra clave que hayas puesto.");
}

main()
  .catch((e) => {
    console.error("❌ Error en el seed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

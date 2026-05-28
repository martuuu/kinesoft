/**
 * CLI helper to provision a brand-new consultorio (tenant) with its
 * OWNER user. Mirrors what the `/signup` web flow does
 * (`lib/auth.ts#signUpPractitioner`) but runs from the shell so you can
 * bootstrap clients without the browser — useful for onboarding,
 * staging seeds, or migrating an existing clinic into the system.
 *
 * Steps performed:
 *   1. `supabase.auth.admin.createUser` with the supplied email +
 *      password (auto-confirmed so the user can log in immediately).
 *   2. `prisma.$transaction` provisioning UserProfile + Tenant +
 *      Practitioner + Membership(OWNER) + AuditEvent.
 *   3. Optional: seed a starter set of `Service` rows.
 *
 * Idempotency: if the email already exists in Supabase Auth, we re-use
 * the existing user.id. If a tenant with the same slug already exists,
 * we bail rather than overwrite — pick a different slug.
 *
 * Usage:
 *
 *   npx tsx scripts/create-tenant.ts \
 *     --email owner@clinica.com \
 *     --password "TuPasswordSegura123" \
 *     --clinic "Centro Movare" \
 *     --slug movare \
 *     --owner-name "Camila Rossi" \
 *     --license "MN 12345"           # opcional
 *
 * Or pass everything via environment:
 *
 *   TENANT_EMAIL=... TENANT_PASSWORD=... TENANT_CLINIC=... \
 *   TENANT_SLUG=... TENANT_OWNER_NAME=... npx tsx scripts/create-tenant.ts
 *
 * The DATABASE_URL / DIRECT_URL / NEXT_PUBLIC_SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY env vars must be set (same as the app).
 */
import { PrismaClient, Role } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";

type Args = {
  email: string;
  password: string;
  clinic: string;
  slug: string;
  ownerName: string;
  license?: string;
  skipServices?: boolean;
};

function parseArgs(): Args {
  const out: Record<string, string | boolean> = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = process.argv[i + 1];
    if (next == null || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  const env = process.env;
  const merged: Args = {
    email: (out["email"] as string) ?? env.TENANT_EMAIL ?? "",
    password: (out["password"] as string) ?? env.TENANT_PASSWORD ?? "",
    clinic: (out["clinic"] as string) ?? env.TENANT_CLINIC ?? "",
    slug: (out["slug"] as string) ?? env.TENANT_SLUG ?? "",
    ownerName:
      (out["owner-name"] as string) ?? env.TENANT_OWNER_NAME ?? "",
    license:
      (out["license"] as string | undefined) ?? env.TENANT_LICENSE ?? undefined,
    skipServices: out["skip-services"] === true || env.TENANT_SKIP_SERVICES === "1",
  };
  const missing: string[] = [];
  if (!merged.email) missing.push("email");
  if (!merged.password || merged.password.length < 8) missing.push("password (≥8 chars)");
  if (!merged.clinic) missing.push("clinic");
  if (!merged.slug) missing.push("slug");
  if (!merged.ownerName) missing.push("owner-name");
  if (missing.length) {
    console.error(`Missing required args: ${missing.join(", ")}`);
    console.error("Run with --help to see the usage block in the source.");
    process.exit(1);
  }
  return merged;
}

const RESERVED_SLUGS = new Set([
  "admin", "api", "app", "auth", "agenda", "biblioteca", "booking",
  "c", "configuracion", "dashboard", "diagnostico", "forgot", "invite",
  "login", "logout", "pacientes", "portal", "reportes", "reset",
  "seguimiento", "signup", "terapia-manual", "www",
]);

const slugRe = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

async function main() {
  const args = parseArgs();
  const slug = args.slug.toLowerCase();
  if (!slugRe.test(slug)) {
    throw new Error(
      `Slug "${slug}" inválido. Solo minúsculas, números y guiones; sin guiones al inicio/fin; 3-40 chars.`
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new Error(`Slug "${slug}" está reservado por el router. Elegí otro.`);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      "Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY. Cargalas en .env o exportalas antes de correr."
    );
  }

  const prisma = new PrismaClient();
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Step 1 — Supabase Auth user ──────────────────────────────────────
  console.log(`[1/3] Provisioning Supabase user: ${args.email}`);
  let userId: string | null = null;

  const created = await admin.auth.admin.createUser({
    email: args.email,
    password: args.password,
    email_confirm: true,
    user_metadata: { full_name: args.ownerName },
  });

  if (created.error) {
    // If the user already exists, list users and find the id. Supabase
    // doesn't expose a "get by email" endpoint, but listUsers does.
    const msg = created.error.message ?? "";
    if (msg.toLowerCase().includes("already")) {
      console.log("    User already exists in Supabase Auth — re-using.");
      let page = 1;
      while (!userId) {
        const list = await admin.auth.admin.listUsers({ page, perPage: 1000 });
        if (list.error) throw list.error;
        const found = list.data.users.find(
          (u) => u.email?.toLowerCase() === args.email.toLowerCase()
        );
        if (found) userId = found.id;
        if (!list.data.users.length || list.data.users.length < 1000) break;
        page++;
      }
      if (!userId) {
        throw new Error(
          "Supabase reportó duplicado pero no encontré el user en listUsers. Reintentá."
        );
      }
    } else {
      throw created.error;
    }
  } else {
    userId = created.data.user.id;
  }
  console.log(`    Supabase user.id = ${userId}`);

  // ── Step 2 — Tenant + UserProfile + Practitioner + Membership ───────
  console.log("[2/3] Provisioning tenant + practitioner + OWNER membership");

  const existingTenant = await prisma.tenant.findUnique({
    where: { slug },
    select: { id: true, name: true },
  });
  if (existingTenant) {
    throw new Error(
      `Ya existe un tenant con slug "${slug}" (id=${existingTenant.id}, name="${existingTenant.name}"). Elegí otro slug o usá el script de invitación.`
    );
  }

  const tenantId = await prisma.$transaction(async (tx) => {
    await tx.userProfile.upsert({
      where: { id: userId! },
      update: { email: args.email, fullName: args.ownerName },
      create: { id: userId!, email: args.email, fullName: args.ownerName },
    });

    const tenant = await tx.tenant.create({
      data: { slug, name: args.clinic },
    });

    // Reuse the existing Practitioner row if the user already had one
    // (unique on userId). Otherwise create one for this tenant.
    const existingPrac = await tx.practitioner.findUnique({
      where: { userId: userId! },
      select: { id: true },
    });
    if (existingPrac) {
      console.log(
        "    User already has a Practitioner row from another tenant — keeping it."
      );
    } else {
      await tx.practitioner.create({
        data: {
          tenantId: tenant.id,
          userId: userId!,
          licenseNumber: args.license ?? null,
        },
      });
    }

    await tx.membership.create({
      data: {
        tenantId: tenant.id,
        userId: userId!,
        role: Role.OWNER,
        acceptedAt: new Date(),
      },
    });

    await tx.auditEvent.create({
      data: {
        tenantId: tenant.id,
        actorId: userId!,
        action: "tenant.create",
        entity: "Tenant",
        entityId: tenant.id,
        payload: { source: "scripts/create-tenant.ts", slug, name: args.clinic },
      },
    });

    return tenant.id;
  });

  console.log(`    Tenant created: id=${tenantId}, slug=${slug}`);

  // ── Step 3 — Starter Services ───────────────────────────────────────
  if (!args.skipServices) {
    console.log("[3/3] Seeding starter services");
    const starter = [
      { name: "Consulta inicial", durationMin: 45, priceCents: 0 },
      { name: "Sesión kinésica", durationMin: 45, priceCents: 0 },
      { name: "RPG / Reeducación postural", durationMin: 60, priceCents: 0 },
    ];
    for (const s of starter) {
      const exists = await prisma.service.findFirst({
        where: { tenantId, name: s.name },
        select: { id: true },
      });
      if (!exists) {
        await prisma.service.create({ data: { ...s, tenantId } });
      }
    }
    console.log(`    Seeded ${starter.length} services (skip with --skip-services).`);
  } else {
    console.log("[3/3] Skipping starter services (--skip-services).");
  }

  console.log("");
  console.log("🎉 Listo. El OWNER puede iniciar sesión en /login con:");
  console.log(`     Email:    ${args.email}`);
  console.log(`     Password: ${args.password}`);
  console.log(`     URL:      /c/${slug}/booking  (turnero público)`);
  console.log("");

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("❌ Falló:", err instanceof Error ? err.message : err);
  process.exit(1);
});

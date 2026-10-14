/**
 * CLI helper to provision a brand-new consultorio (tenant) with its
 * OWNER user. Mirrors what the web flow does (`/signup` + `/onboarding`,
 * A3c) but runs from the shell so you can
 * bootstrap clients without the browser — useful for onboarding,
 * staging seeds, or migrating an existing clinic into the system.
 *
 * Steps performed:
 *   1. `supabase.auth.admin.createUser` with the supplied email +
 *      password (auto-confirmed so the user can log in immediately).
 *   2. `prisma.$transaction` + `bootstrapTenant` (lib/tenant-bootstrap.ts,
 *      la misma lógica que el alta web): UserProfile + Tenant + Practitioner +
 *      Membership(OWNER) + Insurer "Particular" + servicios iniciales de la
 *      vertical (`starterServicesFor`, lib/tenant-starter-services.ts; `--skip-services`
 *      los saltea) + AuditEvent, TODO en una sola transacción. El alta queda
 *      completa (`onboardingCompletedAt`), así el OWNER no ve el stepper.
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
 *     --license "MN 12345" \          # opcional
 *     --vertical general             # opcional: general | kinesiologia (default kinesiologia)
 *
 * Or pass everything via environment:
 *
 *   TENANT_EMAIL=... TENANT_PASSWORD=... TENANT_CLINIC=... \
 *   TENANT_SLUG=... TENANT_OWNER_NAME=... [TENANT_VERTICAL=general] \
 *   npx tsx scripts/create-tenant.ts
 *
 * Tipo de consultorio (EV0): `--vertical general|kinesiologia` se mapea al enum
 * `TenantVertical` (GENERAL | KINESIOLOGY). Un valor fuera de esa lista corta
 * el script antes de tocar Supabase o la base. El turnero público nace APAGADO
 * (EV-D2): se prende desde Configuración → General o /plataforma.
 *
 * The DATABASE_URL / DIRECT_URL / NEXT_PUBLIC_SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY env vars must be set (same as the app).
 */
import { PrismaClient, type TenantVertical } from "@prisma/client";
import { bootstrapTenant, OpenOnboardingExistsError } from "../lib/tenant-bootstrap";
import { starterServicesFor } from "../lib/tenant-starter-services";
import { RESERVED_SLUGS, SLUG_RE } from "../lib/onboarding-logic";
import { assertSafeTarget } from "./lib/assert-safe-target";
import { createClient } from "@supabase/supabase-js";

type Args = {
  email: string;
  password: string;
  clinic: string;
  slug: string;
  ownerName: string;
  license?: string;
  skipServices?: boolean;
  vertical: TenantVertical;
};

/**
 * `--vertical` → `TenantVertical`. Puro y exportado para el unit test
 * (`tests/unit/create-tenant-args.test.ts`). Sin valor = KINESIOLOGY (el
 * cliente de hoy); se aceptan mayúsculas/espacios de más y también el nombre
 * del enum. Cualquier otra cosa → null (el caller corta con el error de uso),
 * para que un typo no cree un consultorio con la vertical equivocada.
 */
export const VERTICAL_FLAG_VALUES = ["general", "kinesiologia"] as const;
export function parseVerticalFlag(raw: string | boolean | undefined | null): TenantVertical | null {
  if (raw === undefined || raw === null) return "KINESIOLOGY";
  if (typeof raw !== "string") return null; // `--vertical` sin valor
  const v = raw.trim().toLowerCase();
  if (v === "general") return "GENERAL";
  if (v === "kinesiologia" || v === "kinesiología" || v === "kinesiology") return "KINESIOLOGY";
  return null;
}

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
    // Lower-cased: every email comparison in the app (portal, set-platform-admin,
    // invitations) is on the normalized form; a mixed-case owner email broke them.
    email: ((out["email"] as string) ?? env.TENANT_EMAIL ?? "").trim().toLowerCase(),
    password: (out["password"] as string) ?? env.TENANT_PASSWORD ?? "",
    clinic: (out["clinic"] as string) ?? env.TENANT_CLINIC ?? "",
    slug: (out["slug"] as string) ?? env.TENANT_SLUG ?? "",
    ownerName:
      (out["owner-name"] as string) ?? env.TENANT_OWNER_NAME ?? "",
    license:
      (out["license"] as string | undefined) ?? env.TENANT_LICENSE ?? undefined,
    skipServices: out["skip-services"] === true || env.TENANT_SKIP_SERVICES === "1",
    vertical: "KINESIOLOGY",
  };
  const vertical = parseVerticalFlag(out["vertical"] ?? env.TENANT_VERTICAL);
  const missing: string[] = [];
  if (!merged.email) missing.push("email");
  if (!merged.password || merged.password.length < 8) missing.push("password (≥8 chars)");
  if (!merged.clinic) missing.push("clinic");
  if (!merged.slug) missing.push("slug");
  if (!merged.ownerName) missing.push("owner-name");
  if (vertical === null) {
    console.error(`--vertical inválido: usá ${VERTICAL_FLAG_VALUES.join(" | ")} (default kinesiologia).`);
    process.exit(1);
  }
  merged.vertical = vertical;
  if (missing.length) {
    console.error(`Missing required args: ${missing.join(", ")}`);
    console.error("Run with --help to see the usage block in the source.");
    process.exit(1);
  }
  return merged;
}

async function main() {
  const args = parseArgs();
  const slug = args.slug.toLowerCase();
  if (!SLUG_RE.test(slug)) {
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

  // Prisma reads DATABASE_URL and the Supabase admin client the Auth project of
  // the same env: state the target and require confirmation when remote.
  assertSafeTarget({
    url: process.env.DATABASE_URL,
    allowRemote: true,
    confirm: process.env.KINESOFT_CONFIRM_PROD,
    scriptName: "create-tenant",
  });
  const prisma = new PrismaClient();
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Step 1 — Supabase Auth user ──────────────────────────────────────
  console.log(`[1/2] Provisioning Supabase user: ${args.email}`);
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
  console.log("[2/2] Provisioning tenant + practitioner + OWNER membership + starter services");

  const existingTenant = await prisma.tenant.findUnique({
    where: { slug },
    select: { id: true, name: true },
  });
  if (existingTenant) {
    throw new Error(
      `Ya existe un tenant con slug "${slug}" (id=${existingTenant.id}, name="${existingTenant.name}"). Elegí otro slug o usá el script de invitación.`
    );
  }

  // Misma lógica que el alta web (`/onboarding`): lib/tenant-bootstrap.ts.
  // Crea además el "Particular" (antes el script no lo creaba) y SIEMPRE un
  // Practitioner del tenant nuevo. IAM-1 (M6): un usuario que ya es
  // profesional de otro consultorio ahora puede ser dueño de este (Practitioner
  // único por consultorio); antes se rechazaba (PractitionerElsewhereError).
  // Sí se rechaza si ya es OWNER de un consultorio con el alta sin terminar.
  // El alta queda COMPLETA (el operador ya configuró): el OWNER no ve el stepper.
  let tenantId: string;
  try {
    ({ tenantId } = await prisma.$transaction((tx) =>
      bootstrapTenant(tx, {
        userId: userId!,
        email: args.email,
        fullName: args.ownerName,
        clinicName: args.clinic,
        slug,
        licenseNumber: args.license ?? null,
        onboardingCompleted: true,
        vertical: args.vertical,
        // BO2-A: los servicios iniciales van en la MISMA tx del alta. Antes el script los sembraba después, en txs
        // sueltas: un corte en el medio dejaba un consultorio sin servicios (y re-correr chocaba con el slug).
        // BO1-C: dependen de la vertical; precio 0 (el arancel lo carga el consultorio).
        starterServices: args.skipServices ? [] : starterServicesFor(args.vertical),
        source: "scripts/create-tenant.ts",
      })
    ));
  } catch (e) {
    if (e instanceof OpenOnboardingExistsError) {
      throw new Error(
        `El usuario ya es dueño del tenant ${e.tenantId} con el alta sin terminar. Terminala (o borrala) antes de crearle otro consultorio.`
      );
    }
    throw e;
  }

  console.log(`    Tenant created: id=${tenantId}, slug=${slug}, vertical=${args.vertical}`);

  console.log(
    args.skipServices
      ? "    Sin servicios iniciales (--skip-services)."
      : `    ${starterServicesFor(args.vertical).length} servicios iniciales para ${args.vertical} (saltealos con --skip-services).`
  );

  console.log("");
  console.log("🎉 Listo. El OWNER puede iniciar sesión en /login con:");
  console.log(`     Email:    ${args.email}`);
  console.log(`     Password: (la que pasaste por --password; no se imprime)`);
  console.log(`     URL:      /c/${slug}/booking  (turnero público, APAGADO: activalo en Configuración → General)`);
  console.log("");

  await prisma.$disconnect();
}

// Solo como entrypoint (`tsx scripts/create-tenant.ts`): el unit test importa
// `parseVerticalFlag` y no tiene que disparar el alta ni el `process.exit`.
if (/create-tenant\.ts$/.test(process.argv[1] ?? "")) {
  main().catch(async (err) => {
    console.error("❌ Falló:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

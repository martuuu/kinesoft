/**
 * Grant / revoke platform-superadmin (UserProfile.isPlatformAdmin).
 *
 * Platform admins see the "Plataforma" panel and can author the GLOBAL exercise
 * catalog. Run with the owner (BYPASSRLS) connection — DATABASE_URL explícita,
 * y contra prod además KINESOFT_CONFIRM_PROD=<project ref>:
 *
 *   DATABASE_URL="postgresql://kinesoft:kinesoft@localhost:5433/kinesoft?schema=public" \
 *     npx tsx scripts/set-platform-admin.ts martin.navarro.dev@gmail.com
 *
 *   # revoke:
 *   ... npx tsx scripts/set-platform-admin.ts someone@x.com --revoke
 *   # list current admins:
 *   ... npx tsx scripts/set-platform-admin.ts --list
 */
import { PrismaClient } from "@prisma/client";
import { assertSafeTarget } from "./lib/assert-safe-target";

// DATABASE_URL is REQUIRED (no localhost fallback): the old fallback made a
// run meant for prod silently mark the admin in local Docker, and `--list`
// (same URL) "confirmed" it. Prod needs KINESOFT_CONFIRM_PROD=<project ref>.
const url = process.env.DATABASE_URL;
assertSafeTarget({ url, allowRemote: true, confirm: process.env.KINESOFT_CONFIRM_PROD, scriptName: "set-platform-admin" });
const db = new PrismaClient({ datasources: { db: { url } } });

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    const admins = await db.userProfile.findMany({
      where: { isPlatformAdmin: true },
      select: { email: true, fullName: true },
    });
    console.log(
      admins.length ? admins.map((a) => `  • ${a.email}${a.fullName ? ` (${a.fullName})` : ""}`).join("\n") : "  (ninguno)",
    );
    return;
  }
  const revoke = args.includes("--revoke");
  const email = args.find((a) => !a.startsWith("--"))?.trim().toLowerCase();
  if (!email) {
    console.error("Uso: set-platform-admin.ts <email> [--revoke] | --list");
    process.exit(1);
  }
  const user = await db.userProfile.findUnique({ where: { email } });
  if (!user) {
    console.error(`No existe un usuario con email ${email}.`);
    process.exit(1);
  }
  await db.userProfile.update({
    where: { email },
    data: { isPlatformAdmin: !revoke },
  });
  console.log(`${revoke ? "Revocado" : "Otorgado"} isPlatformAdmin a ${email}.`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });

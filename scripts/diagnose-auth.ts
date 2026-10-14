/**
 * IAM-0d · Script de CONTRATO del puerto de Auth admin contra Supabase real.
 *
 * Por qué: los tests de identidad corren contra `tests/helpers/gotrue-fake.ts`. Si
 * el fake supone algo que GoTrue no hace (p. ej. que un magic link a un email sin
 * cuenta falla, cuando en realidad la crea), los tests dan verde y prod no. Este
 * script ejercita el puerto REAL (`lib/identity/auth-admin.ts`, el mismo código que
 * corre en la app) y verifica, uno por uno, los supuestos [S1]…[S11] del fake.
 * Si algo da FAIL: se corrige el fake (y el puerto si hace falta), no el test.
 *
 * Qué hace, con un email DESCARTABLE que no tenga cuenta (y dos derivados con
 * `+ks-diag-…`):
 *   crea la cuenta sin confirmar → la intenta crear de nuevo (email_exists) →
 *   findUserByEmail → generateLink signup / magiclink / recovery → recovery y
 *   magiclink sobre emails sin cuenta → updateUserById (clave débil, clave buena +
 *   confirmar, ban y desban) → signup sobre confirmada → deleteUser.
 * Borra SOLO las cuentas que creó (por id), también si algo falla a la mitad. Si el
 * email (o un derivado) ya tiene cuenta al empezar, frena sin tocar nada.
 *
 * Seguridad:
 *  - No imprime secretos: ni la service key, ni tokens, ni contraseñas. Solo el host
 *    del proyecto, el ref, los emails de prueba y códigos.
 *  - Exige `--confirm=<project ref>` igual al ref de NEXT_PUBLIC_SUPABASE_URL: no
 *    corre contra un proyecto «por las dudas». Rechaza localhost (el Docker local no
 *    tiene GoTrue).
 *  - No manda mails: `generateLink` y `createUser` (email_confirm) no envían nada.
 *    Lo único que queda son entradas en el audit log de Auth.
 *
 * `lib/identity/auth-admin.ts` es `server-only`: tsx tiene que correr con la
 * condición `react-server` (molde `scripts/realtime-verify.ts`).
 *
 * Uso (lo corre Martin):
 *   npx dotenv -e <env del proyecto> -- npx tsx --conditions=react-server \
 *     scripts/diagnose-auth.ts --email diag+auth@tu-dominio.com --confirm=<project ref>
 * Variables: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 * Sale con código 1 si algún supuesto da FAIL.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { authAdmin, type AuthAdminResult } from "../lib/identity/auth-admin";

const NAME = "diagnose-auth";

type Check = { id: string; desc: string; pass: boolean; detail: string };
const results: Check[] = [];

function check(id: string, desc: string, pass: boolean, detail: string) {
  results.push({ id, desc, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id.padEnd(5)} ${desc}${detail ? `  (${detail})` : ""}`);
}

/** Resumen de un resultado sin datos sensibles: `ok` o el código. */
function show<T>(r: AuthAdminResult<T>): string {
  return r.ok ? "ok" : `code=${r.code}`;
}

function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

function derive(email: string, tag: string): string {
  const at = email.lastIndexOf("@");
  return `${email.slice(0, at)}+${tag}${email.slice(at)}`;
}

async function main(): Promise<number> {
  const email = argValue("email")?.trim().toLowerCase();
  const confirm = argValue("confirm");
  if (!email || !/^[^\s@+]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error(`[${NAME}] Falta --email <descartable> (sin «+»: el script deriva +ks-diag-…).`);
    return 2;
  }
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!rawUrl || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(`[${NAME}] Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el entorno.`);
    return 2;
  }
  let host: string;
  try {
    host = new URL(rawUrl).host;
  } catch {
    console.error(`[${NAME}] NEXT_PUBLIC_SUPABASE_URL no es una URL.`);
    return 2;
  }
  if (/localhost|127\.0\.0\.1/.test(host)) {
    console.error(`[${NAME}] ${host} es local: el Docker local no tiene GoTrue. Corrélo contra el proyecto Supabase.`);
    return 2;
  }
  const ref = host.split(".")[0];
  if (!confirm || confirm !== ref) {
    console.error(`[${NAME}] Pasá --confirm=${ref} para confirmar que querés correr contra ${host}.`);
    return 2;
  }

  const emailMl = derive(email, "ks-diag-ml"); // magiclink sobre email sin cuenta [S4]
  const emailNone = derive(email, "ks-diag-none"); // recovery sobre email sin cuenta [S3]
  console.log(`[${NAME}] proyecto ${host} · emails ${email}, ${emailMl}, ${emailNone}`);

  const a = authAdmin();
  const created = new Set<string>();

  // Precondición: ninguno de los tres tiene cuenta. Si alguno la tiene, NO se toca.
  for (const e of [email, emailMl, emailNone]) {
    const r = await a.findUserByEmail(e);
    if (!r.ok) {
      console.error(`[${NAME}] findUserByEmail(${e}) falló (${show(r)}): reviso config/red antes de seguir.`);
      return 1;
    }
    if (r.data) {
      console.error(`[${NAME}] ${e} YA tiene cuenta (${r.data.id}). Usá otro email descartable: no toco cuentas ajenas.`);
      return 2;
    }
  }

  try {
    // S1/S2 · alta sin confirmar + duplicado
    const c = await a.createUser({ email, emailConfirm: false, fullName: "Diagnóstico KineSoft" });
    if (!c.ok) {
      check("S1a", "createUser sin confirmar", false, show(c));
      return 1;
    }
    created.add(c.data.id);
    const id = c.data.id;
    check("S1a", "createUser sin confirmar → ok, emailConfirmedAt null", c.data.emailConfirmedAt === null, show(c));
    check("S2", "GoTrue guarda el email en minúsculas", c.data.email === email, `email=${c.data.email}`);

    const dup = await a.createUser({ email: email.toUpperCase(), emailConfirm: true });
    if (dup.ok) created.add(dup.data.id);
    check("S1b", "createUser repetido (en MAYÚSCULAS) → email_exists", !dup.ok && dup.code === "email_exists", show(dup));

    const f = await a.findUserByEmail(`  ${email.toUpperCase()} `);
    check("S2b", "findUserByEmail normalizado encuentra la cuenta", f.ok && f.data?.id === id, show(f));

    // S9 · ids inexistentes
    const ghost = randomUUID();
    const g = await a.getUser(ghost);
    check("S9a", "getUser de un id inexistente → not_found", !g.ok && g.code === "not_found", show(g));
    const gu = await a.updateUserById(ghost, { fullName: "x" });
    check("S9b", "updateUserById de un id inexistente → not_found", !gu.ok && gu.code === "not_found", show(gu));
    const gd = await a.deleteUser(ghost);
    check("S9c", "deleteUser de un id inexistente → not_found", !gd.ok && gd.code === "not_found", show(gd));

    // S6/S5 · links sobre la cuenta sin confirmar
    const su = await a.generateLink({ type: "signup", email });
    check(
      "S6a",
      "signup sin password sobre cuenta SIN confirmar → re-emite (verificationType signup, mismo userId)",
      su.ok && su.data.verificationType === "signup" && su.data.userId === id && su.data.hashedToken.length > 0,
      su.ok ? `type=${su.data.verificationType}` : show(su)
    );
    const ml = await a.generateLink({ type: "magiclink", email });
    check(
      "S5a",
      "magiclink sobre cuenta existente → verificationType magiclink",
      ml.ok && ml.data.verificationType === "magiclink" && ml.data.userId === id,
      ml.ok ? `type=${ml.data.verificationType}` : show(ml)
    );
    const rc = await a.generateLink({ type: "recovery", email });
    check(
      "S5b",
      "recovery sobre cuenta existente → verificationType recovery",
      rc.ok && rc.data.verificationType === "recovery" && rc.data.userId === id,
      rc.ok ? `type=${rc.data.verificationType}` : show(rc)
    );

    // S3 · recovery sobre email sin cuenta
    const rn = await a.generateLink({ type: "recovery", email: emailNone });
    if (rn.ok && rn.data.userId) created.add(rn.data.userId);
    check("S3a", "recovery sobre email SIN cuenta → not_found", !rn.ok && rn.code === "not_found", show(rn));
    const rnf = await a.findUserByEmail(emailNone);
    if (rnf.ok && rnf.data) created.add(rnf.data.id);
    check("S3b", "…y no crea la cuenta", rnf.ok && rnf.data === null, show(rnf));

    // S4 · magiclink sobre email sin cuenta
    const mn = await a.generateLink({ type: "magiclink", email: emailMl });
    if (mn.ok && mn.data.userId) created.add(mn.data.userId);
    check(
      "S4a",
      "magiclink sobre email SIN cuenta → ok con verificationType signup",
      mn.ok && mn.data.verificationType === "signup",
      mn.ok ? `type=${mn.data.verificationType}` : show(mn)
    );
    const mnf = await a.findUserByEmail(emailMl);
    if (mnf.ok && mnf.data) created.add(mnf.data.id);
    check(
      "S4b",
      "…y la cuenta quedó CREADA sin confirmar",
      mnf.ok && !!mnf.data && mnf.data.emailConfirmedAt === null,
      mnf.ok ? (mnf.data ? `confirmada=${mnf.data.emailConfirmedAt !== null}` : "no existe") : show(mnf)
    );

    // S8 · clave débil; después clave buena + confirmar
    const weak = await a.updateUserById(id, { password: "123" });
    check("S8", "updateUserById con clave de 3 caracteres → weak_password", !weak.ok && weak.code === "weak_password", show(weak));
    const pw = `Kd-${randomBytes(18).toString("base64url")}`;
    const up = await a.updateUserById(id, { password: pw, emailConfirm: true });
    check("S11a", "updateUserById con clave buena + emailConfirm → confirmada", up.ok && up.data.emailConfirmedAt !== null, show(up));
    const un = await a.updateUserById(id, { emailConfirm: false });
    check(
      "S11b",
      "emailConfirm:false NO des-confirma",
      un.ok && un.data.emailConfirmedAt !== null,
      un.ok ? `confirmada=${un.data.emailConfirmedAt !== null}` : show(un)
    );

    // S6 · signup sobre cuenta confirmada
    const sc = await a.generateLink({ type: "signup", email });
    check("S6b", "signup sobre cuenta CONFIRMADA → email_exists", !sc.ok && sc.code === "email_exists", show(sc));
    // S7 · invite sobre cuenta confirmada
    const ic = await a.generateLink({ type: "invite", email });
    check("S7", "invite sobre cuenta CONFIRMADA → email_exists", !ic.ok && ic.code === "email_exists", show(ic));
    // S6 · signup sobre email sin cuenta y sin password
    const snp = await a.generateLink({ type: "signup", email: emailNone });
    if (snp.ok && snp.data.userId) created.add(snp.data.userId);
    check(
      "S6c",
      "signup sobre email SIN cuenta y sin password → error de validación (no crea)",
      !snp.ok && snp.code === "error",
      show(snp)
    );

    // S10 · ban y desban
    const ban = await a.updateUserById(id, { banDuration: "1h" });
    const inAnHour = Date.now() + 3_600_000;
    check(
      "S10a",
      "banDuration 1h → bannedUntil ≈ ahora + 1h",
      ban.ok && !!ban.data.bannedUntil && Math.abs(new Date(ban.data.bannedUntil).getTime() - inAnHour) < 5 * 60_000,
      ban.ok ? `bannedUntil=${ban.data.bannedUntil}` : show(ban)
    );
    const unban = await a.updateUserById(id, { banDuration: "none" });
    check(
      "S10b",
      "banDuration none → bannedUntil null",
      unban.ok && unban.data.bannedUntil === null,
      unban.ok ? `bannedUntil=${unban.data.bannedUntil}` : show(unban)
    );

    // Baja
    const del = await a.deleteUser(id);
    if (del.ok) created.delete(id);
    check("DEL", "deleteUser → ok", del.ok, show(del));
    const after = await a.getUser(id);
    check("DEL2", "…y getUser después → not_found", !after.ok && after.code === "not_found", show(after));
    const delAgain = await a.deleteUser(id);
    check("DEL3", "deleteUser de nuevo → not_found", !delAgain.ok && delAgain.code === "not_found", show(delAgain));
  } finally {
    for (const uid of created) {
      const d = await a.deleteUser(uid);
      console.log(`[${NAME}] limpieza: deleteUser(${uid}) → ${show(d)}`);
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n[${NAME}] ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) {
    console.log(`[${NAME}] FAIL: ${failed.map((r) => r.id).join(", ")} → corregir tests/helpers/gotrue-fake.ts (y el puerto si hace falta).`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    // El puerto nunca tira; si algo llega acá es del script. Sin stack con datos.
    console.error(`[${NAME}] error inesperado: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });

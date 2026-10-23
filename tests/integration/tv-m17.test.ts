/**
 * M17 `20261023120000_reception_displays` · bloque TV (T7), ola X0, sesión MIG (brief T6+T7 §26.4 y Anexo A).
 *
 * Qué se prueba (molde tpm-m18.test.ts; corre igual en `test:integration` y en `:owner`, los 2 roles):
 *   1. Objetos (catálogo, por el owner): 5 enums, la tabla con tipo/nulabilidad/default, los 2 PARCIALES con su
 *      predicado (no los expresa Prisma: drift aceptado), las 3 FKs (incluida la compuesta de la sede), los 5 CHECKs y
 *      RLS ENABLE + FORCE con la policy por tenant (categoría por defecto del guard: el staff escribe con RLS).
 *   2. CHECKs con su SQLSTATE: `mediaRef` es el id canónico y NUNCA la URL cruda (el iframe lo arma lib/youtube.ts);
 *      hashes con formato base64url de 32 bytes; revocada ⇒ sin secretos.
 *   3. Únicos parciales: nombre vivo por consultorio (case-insensitive, libera al revocar) y código global (la TV lo
 *      busca SIN tenant).
 *   4. FK compuesta: la sede de OTRO consultorio → 23503 (la FK simple salta RLS y prod es BYPASSRLS).
 *   5. RLS con `kinesoft_app`: A ve y escribe lo suyo, no lo de B; sin GUC, nada.
 *   6. `deleteTenantDeep` con pantallas.
 */
import { randomBytes } from "node:crypto";
import { type Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asApp,
  attempt,
  columns,
  constraintDefs,
  enumLabels,
  inTx,
  indexNames,
  partialIndexes,
  rlsState,
  TENANT_QUAL,
} from "@/tests/helpers/migration-sql";
import {
  createEphemeralTenant,
  ownerClient,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
type Db = Prisma.TransactionClient | PrismaClient;

/** sha256 / HMAC-SHA256 en base64url sin padding = 43 caracteres (formato de los dos hashes). */
const h43 = () => randomBytes(32).toString("base64url");

type DisplayOpts = {
  name?: string;
  locationId?: string | null;
  mediaKind?: "NONE" | "VIDEO" | "LIVE" | "PLAYLIST" | "CHANNEL_LIVE";
  mediaRef?: string | null;
  pairingCodeHash?: string | null;
  pairingExpiresAt?: "now" | null;
  deviceSecretHash?: string | null;
  pairedAt?: "now" | null;
  revoked?: boolean;
  revokedByUserId?: string | null;
};
async function display(db: Db, tenantId: string, o: DisplayOpts = {}): Promise<string> {
  const id = `tvm-${uniqueSuffix()}`;
  const revoked = o.revoked ?? false;
  await db.$executeRaw`
    INSERT INTO "ReceptionDisplay" (id, "tenantId", "locationId", name, "mediaKind", "mediaRef", "pairingCodeHash",
      "pairingExpiresAt", "deviceSecretHash", "pairedAt", "revokedAt", "createdByUserId", "revokedByUserId", "updatedAt")
    VALUES (${id}, ${tenantId}, ${o.locationId ?? null}, ${o.name ?? `Recepción ${uniqueSuffix()}`},
      ${o.mediaKind ?? "NONE"}::"DisplayMediaKind", ${o.mediaRef ?? null},
      ${o.pairingCodeHash ?? null}, CASE WHEN ${o.pairingExpiresAt ?? null}::text = 'now' THEN now() + interval '10 minutes' END,
      ${o.deviceSecretHash ?? null}, CASE WHEN ${o.pairedAt ?? null}::text = 'now' THEN now() END,
      CASE WHEN ${revoked} THEN now() END, 'test-user',
      ${o.revokedByUserId !== undefined ? o.revokedByUserId : revoked ? "test-user" : null}, now())`;
  return id;
}

// ═════════════════════════════════════════════════════════════════════
// 1. Objetos
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M17 reception_displays · objetos", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("[TV-M] 5 enums y la tabla ReceptionDisplay con tipo, nulabilidad y default", async () => {
    expect(
      await enumLabels(db, ["DisplayNameMode", "DisplayTheme", "DisplayMediaKind", "DisplayMediaLayout", "DisplayMediaDuringCall"])
    ).toEqual({
      DisplayNameMode: ["SHORT_NAME", "TURN_TIME"],
      DisplayTheme: ["DARK", "LIGHT"],
      DisplayMediaKind: ["NONE", "VIDEO", "LIVE", "PLAYLIST", "CHANNEL_LIVE"],
      DisplayMediaLayout: ["SIDE", "HERO_IDLE"],
      DisplayMediaDuringCall: ["DUCK", "HIDE", "KEEP"],
    });
    expect(await columns(db, "ReceptionDisplay")).toEqual({
      id: "text NO",
      tenantId: "text NO",
      locationId: "text YES",
      name: "text NO",
      nameMode: `DisplayNameMode NO 'SHORT_NAME'::"DisplayNameMode"`,
      theme: `DisplayTheme NO 'DARK'::"DisplayTheme"`,
      mediaKind: `DisplayMediaKind NO 'NONE'::"DisplayMediaKind"`,
      mediaRef: "text YES",
      mediaLayout: `DisplayMediaLayout NO 'SIDE'::"DisplayMediaLayout"`,
      mediaMuted: "bool NO true",
      mediaDuringCall: `DisplayMediaDuringCall NO 'DUCK'::"DisplayMediaDuringCall"`,
      pairingCodeHash: "text YES",
      pairingExpiresAt: "timestamp YES",
      deviceSecretHash: "text YES",
      pairedAt: "timestamp YES",
      lastSeenAt: "timestamp YES",
      revokedAt: "timestamp YES",
      createdByUserId: "text NO",
      revokedByUserId: "text YES",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
      updatedAt: "timestamp NO",
    });
  });

  it("[TV-M] índices (2 parciales con su predicado), FKs exactas y CHECKs por nombre", async () => {
    expect(await indexNames(db, ["ReceptionDisplay"])).toEqual([
      "ReceptionDisplay_locationId_idx",
      "ReceptionDisplay_pairingCodeHash_key",
      "ReceptionDisplay_pkey",
      "ReceptionDisplay_tenantId_idx",
      "ReceptionDisplay_tenant_name_live_key",
    ]);
    expect(await partialIndexes(db, ["ReceptionDisplay"])).toEqual({
      ReceptionDisplay_pairingCodeHash_key: `("pairingCodeHash") WHERE ("pairingCodeHash" IS NOT NULL)`,
      ReceptionDisplay_tenant_name_live_key: `("tenantId", lower(name)) WHERE ("revokedAt" IS NULL)`,
    });
    const uniq = await db.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'ReceptionDisplay'
        AND indexdef LIKE 'CREATE UNIQUE%' ORDER BY indexname`;
    expect(uniq.map((u) => u.indexname)).toEqual([
      "ReceptionDisplay_pairingCodeHash_key",
      "ReceptionDisplay_pkey",
      "ReceptionDisplay_tenant_name_live_key",
    ]);
    expect(await constraintDefs(db, ["ReceptionDisplay"], "f")).toEqual({
      ReceptionDisplay_locationId_fkey: `FOREIGN KEY ("locationId") REFERENCES "Location"(id) ON UPDATE CASCADE ON DELETE CASCADE`,
      ReceptionDisplay_location_tenant_fkey: `FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"(id, "tenantId") ON DELETE CASCADE`,
      ReceptionDisplay_tenantId_fkey: `FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE CASCADE`,
    });
    expect(Object.keys(await constraintDefs(db, ["ReceptionDisplay"], "c"))).toEqual([
      "ReceptionDisplay_device_check",
      "ReceptionDisplay_media_check",
      "ReceptionDisplay_name_check",
      "ReceptionDisplay_pairing_check",
      "ReceptionDisplay_revoked_check",
    ]);
    // Sin triggers: el CAS del código de un solo uso es del server (updateMany count===1), no de la base.
    const [{ n }] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = '"ReceptionDisplay"'::regclass`;
    expect(n).toBe(0);
  });

  it("[TV-M] RLS: ENABLE + FORCE y una policy ALL por tenant; sin GRANT para anon/authenticated", async () => {
    const { rel, pol, grants } = await rlsState(db, ["ReceptionDisplay"]);
    expect(rel).toEqual([{ relname: "ReceptionDisplay", rls: true, force: true }]);
    expect(pol).toEqual([
      {
        tablename: "ReceptionDisplay",
        policyname: "ReceptionDisplay_tenant_isolation",
        cmd: "ALL",
        qual: TENANT_QUAL,
        with_check: TENANT_QUAL,
      },
    ]);
    expect(grants).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 2-5. Comportamiento (todo en txs con ROLLBACK)
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M17 reception_displays · comportamiento", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let locA: string;
  let locB: string;

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    locA = (await db.location.create({ data: { tenantId: A.tenantId, name: "Principal", isPrimary: true } })).id;
    locB = (await db.location.create({ data: { tenantId: B.tenantId, name: "Principal", isPrimary: true } })).id;
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db.$disconnect();
  });

  it("[TV-M] CHECKs: mediaRef canónico (nunca la URL cruda), nombre, código y secreto con formato, revocada sin secretos", async () => {
    await inTx(db, async (tx) => {
      const d = (o: DisplayOpts) => attempt(tx, () => display(tx, A.tenantId, o));
      // ── media: la URL cruda NUNCA entra (el CHECK es la última barrera si el server se olvida de parsear).
      expect((await d({ mediaKind: "VIDEO", mediaRef: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })).code).toBe("23514");
      expect((await d({ mediaKind: "VIDEO", mediaRef: "https://youtu.be/dQw4w9WgXcQ" })).code).toBe("23514");
      expect((await d({ mediaKind: "PLAYLIST", mediaRef: "https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG" })).code).toBe("23514");
      expect((await d({ mediaKind: "VIDEO", mediaRef: null })).code).toBe("23514"); // VIDEO sin id (COALESCE … false)
      expect((await d({ mediaKind: "NONE", mediaRef: "dQw4w9WgXcQ" })).code).toBe("23514");
      expect((await d({ mediaKind: "VIDEO", mediaRef: "dQw4w9WgXc" })).code).toBe("23514"); // 10 chars
      expect((await d({ mediaKind: "LIVE", mediaRef: "PLx0sYbCqOb8TBPRdmBHs5" })).code).toBe("23514"); // lista como vivo
      expect((await d({ mediaKind: "CHANNEL_LIVE", mediaRef: "dQw4w9WgXcQ" })).code).toBe("23514");
      expect((await d({ mediaKind: "PLAYLIST", mediaRef: "XXx0sYbCqOb8TBPRdmBHs5" })).code).toBe("23514"); // prefijo no válido
      expect((await d({ mediaKind: "VIDEO", mediaRef: "dQw4w9WgXcQ" })).code).toBe("OK");
      expect((await d({ mediaKind: "LIVE", mediaRef: "jfKfPfyJRdk" })).code).toBe("OK");
      expect((await d({ mediaKind: "PLAYLIST", mediaRef: "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG" })).code).toBe("OK");
      expect((await d({ mediaKind: "PLAYLIST", mediaRef: "UUBR8-60-B28hp2BmDPdntcQ" })).code).toBe("OK");
      expect((await d({ mediaKind: "CHANNEL_LIVE", mediaRef: "UCBR8-60-B28hp2BmDPdntcQ" })).code).toBe("OK");
      expect((await d({ mediaKind: "CHANNEL_LIVE", mediaRef: "UCBR8-60-B28hp2BmDPdntc" })).code).toBe("23514"); // 21 tras UC

      // ── nombre: 1..60 sin espacios en los bordes.
      expect((await d({ name: "" })).code).toBe("23514");
      expect((await d({ name: " Recepción" })).code).toBe("23514");
      expect((await d({ name: "x".repeat(61) })).code).toBe("23514");
      expect((await d({ name: "x".repeat(60) })).code).toBe("OK");

      // ── código: hash y vencimiento juntos; formato base64url de 32 bytes (nunca el código en claro).
      expect((await d({ pairingCodeHash: h43() })).code).toBe("23514"); // sin vencimiento
      expect((await d({ pairingExpiresAt: "now" })).code).toBe("23514"); // vencimiento sin hash
      expect((await d({ pairingCodeHash: "ABCDEFGH", pairingExpiresAt: "now" })).code).toBe("23514"); // código en claro
      expect((await d({ pairingCodeHash: h43(), pairingExpiresAt: "now" })).code).toBe("OK");

      // ── secreto del dispositivo: formato y pairedAt.
      expect((await d({ deviceSecretHash: h43() })).code).toBe("23514"); // sin pairedAt
      expect((await d({ deviceSecretHash: randomBytes(32).toString("hex"), pairedAt: "now" })).code).toBe("23514"); // hex = 64
      expect((await d({ deviceSecretHash: h43(), pairedAt: "now" })).code).toBe("OK");

      // ── revocada: sin secretos vivos y con quién la revocó.
      expect((await d({ revoked: true, deviceSecretHash: h43(), pairedAt: "now" })).code).toBe("23514");
      expect((await d({ revoked: true, pairingCodeHash: h43(), pairingExpiresAt: "now" })).code).toBe("23514");
      expect((await d({ revoked: true, revokedByUserId: null })).code).toBe("23514");
      expect((await d({ revoked: true, pairedAt: "now" })).code).toBe("OK");
    });
  });

  it("[TV-M] únicos parciales: nombre vivo por consultorio (sin mayúsculas, libera al revocar) y código global", async () => {
    await inTx(db, async (tx) => {
      const first = await display(tx, A.tenantId, { name: "Recepción PB" });
      expect((await attempt(tx, () => display(tx, A.tenantId, { name: "recepción pb" }))).code).toBe("23505");
      // Otro consultorio puede llamarla igual.
      expect((await attempt(tx, () => display(tx, B.tenantId, { name: "Recepción PB" }))).code).toBe("OK");
      // Revocada, el nombre se libera (el doble submit del alta lo frena el parcial, no el historial).
      await tx.$executeRaw`UPDATE "ReceptionDisplay" SET "revokedAt" = now(), "revokedByUserId" = 'u' WHERE id = ${first}`;
      expect((await attempt(tx, () => display(tx, A.tenantId, { name: "Recepción PB" }))).code).toBe("OK");

      // El código lo busca la TV SIN tenant → único global mientras está vivo; muchos NULL conviven.
      const code = h43();
      await display(tx, A.tenantId, { pairingCodeHash: code, pairingExpiresAt: "now" });
      expect((await attempt(tx, () => display(tx, B.tenantId, { pairingCodeHash: code, pairingExpiresAt: "now" }))).code).toBe("23505");
      expect((await attempt(tx, () => display(tx, B.tenantId, {}))).code).toBe("OK");
      expect((await attempt(tx, () => display(tx, B.tenantId, {}))).code).toBe("OK");
    });
  });

  it("[TV-M] FK compuesta: la sede de OTRO consultorio → 23503; la propia entra", async () => {
    await inTx(db, async (tx) => {
      expect((await attempt(tx, () => display(tx, A.tenantId, { locationId: locB }))).code).toBe("23503");
      expect((await attempt(tx, () => display(tx, A.tenantId, { locationId: "no-existe" }))).code).toBe("23503");
      const ok = await display(tx, A.tenantId, { locationId: locA });
      // Mudar la pantalla al otro consultorio sin cambiar la sede también rompe la FK compuesta.
      expect((await attempt(tx, () => tx.$executeRaw`UPDATE "ReceptionDisplay" SET "tenantId" = ${B.tenantId} WHERE id = ${ok}`)).code).toBe("23503");
    });
  });

  it("[TV-M] la sede borrada se lleva sus pantallas (CASCADE)", async () => {
    await inTx(db, async (tx) => {
      const loc = await tx.location.create({ data: { tenantId: A.tenantId, name: `Anexo ${uniqueSuffix()}` } });
      const id = await display(tx, A.tenantId, { locationId: loc.id });
      await tx.location.delete({ where: { id: loc.id } });
      expect(await tx.$queryRaw`SELECT id FROM "ReceptionDisplay" WHERE id = ${id}`).toEqual([]);
    });
  });

  it("[TV-M] RLS con kinesoft_app: A lee y escribe lo suyo; no ve ni toca lo de B; sin GUC, nada", async () => {
    await inTx(db, async (tx) => {
      const dA = await display(tx, A.tenantId, { locationId: locA });
      const dB = await display(tx, B.tenantId, { locationId: locB });
      await asApp(tx, A.tenantId);
      const [{ u }] = await tx.$queryRaw<{ u: string }[]>`SELECT current_user AS u`;
      expect(u).toBe("kinesoft_app");
      expect(await tx.$queryRaw`SELECT id FROM "ReceptionDisplay" WHERE id IN (${dA}, ${dB})`).toEqual([{ id: dA }]);
      // Escritura del staff (categoría por defecto: RLS es la 2.ª barrera).
      expect((await attempt(tx, () => display(tx, A.tenantId, { name: "Box 2" }))).code).toBe("OK");
      expect(await tx.$executeRaw`UPDATE "ReceptionDisplay" SET theme = 'LIGHT' WHERE id = ${dA}`).toBe(1);
      // Lo de B: INSERT con su tenantId rechazado por el WITH CHECK; UPDATE/DELETE 0 filas.
      expect((await attempt(tx, () => display(tx, B.tenantId, {}))).code).toBe("42501");
      expect(await tx.$executeRaw`UPDATE "ReceptionDisplay" SET theme = 'LIGHT' WHERE id = ${dB}`).toBe(0);
      expect(await tx.$executeRaw`DELETE FROM "ReceptionDisplay" WHERE id = ${dB}`).toBe(0);
      expect((await attempt(tx, () => tx.$executeRaw`UPDATE "ReceptionDisplay" SET "tenantId" = ${B.tenantId}, "locationId" = NULL WHERE id = ${dA}`)).code).toBe("42501");
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', '', true)`;
      expect(await tx.$queryRaw`SELECT count(*)::int AS n FROM "ReceptionDisplay" WHERE id IN (${dA}, ${dB})`).toEqual([{ n: 0 }]);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════
// 6. deleteTenantDeep
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M17 reception_displays · deleteTenantDeep", () => {
  it("[TV-M] tenant-factory limpia un consultorio con pantallas (con y sin sede, vinculadas y revocadas)", async () => {
    const db = ownerClient();
    try {
      const D = await createEphemeralTenant(db);
      const loc = await db.location.create({ data: { tenantId: D.tenantId, name: "Principal", isPrimary: true } });
      await display(db, D.tenantId, { locationId: loc.id, deviceSecretHash: h43(), pairedAt: "now" });
      await display(db, D.tenantId, { pairingCodeHash: h43(), pairingExpiresAt: "now" });
      await display(db, D.tenantId, { revoked: true });
      await D.cleanup();
      const left = await db.$queryRaw<{ n: number }[]>`
        SELECT (SELECT count(*) FROM "ReceptionDisplay" WHERE "tenantId" = ${D.tenantId})::int
             + (SELECT count(*) FROM "Tenant" WHERE id = ${D.tenantId})::int AS n`;
      expect(left).toEqual([{ n: 0 }]);
    } finally {
      await db.$disconnect();
    }
  });
});

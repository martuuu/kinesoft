/**
 * [TV-2s] T7 (plan §26.4, C-TV «Actions del staff») · pantallas de la sala desde el drawer «Pantallas» de /sala, contra
 * Postgres real y con los DOS roles (`test:integration` = kinesoft_app con RLS; `:owner` = BYPASSRLS = prod, donde el
 * `where: { tenantId }` a mano es la única barrera).
 *
 * Símbolos reales: las 5 actions de `lib/reception-displays.ts` sobre el `getActor()` real (se mockean solo la sesión
 * de Supabase, `next/headers` y `next/cache` en integration-setup.ts) y `hashPairingCode` / `normalizePairingCode`
 * para atar el hash guardado al código que vio la persona.
 *
 * Lo que se afirma es el efecto observable: la fila quedó así, el evento de auditoría salió con este payload, la
 * respuesta no trae hashes, el código en claro no está en ninguna columna ni en ningún audit.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  createReceptionDisplay,
  getDisplaysPanel,
  regenerateDisplayPairingCode,
  revokeReceptionDisplay,
  updateReceptionDisplay,
} from "@/lib/reception-displays";
import {
  MAX_LIVE_DISPLAYS,
  PAIRING_TTL_MS,
  normalizePairingCode,
  type DisplayUpsertInput,
} from "@/lib/reception-displays-types";
import { hashPairingCode } from "@/lib/display-pairing-internal";
import { MODULE_REVOKED_COPY } from "@/lib/tenant-modules";
import { READ_ONLY_MESSAGE } from "@/lib/tenant-access";
import { __rateLimitInternals } from "@/lib/rate-limit";
import {
  addPractitioner,
  addStaff,
  createEphemeralTenant,
  ownerClient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asAnonymous, asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

const NAME_TAKEN = "Ya hay una pantalla con ese nombre";

function input(over: Partial<DisplayUpsertInput> = {}): DisplayUpsertInput {
  return {
    name: `Recepción ${uniqueSuffix()}`.slice(0, 60),
    locationId: null,
    nameMode: "SHORT_NAME",
    theme: "DARK",
    mediaUrl: null,
    mediaLayout: "SIDE",
    mediaMuted: true,
    mediaDuringCall: "DUCK",
    ...over,
  };
}

/** Un dispositivo «ya vinculado» escrito a mano (lo hace `pairDisplay` de TV-2d; acá solo importa que exista). */
const FAKE_DEVICE_HASH = "D".repeat(43);

describe.skipIf(!RUN)("[TV-2s] pantallas de la sala · actions del staff", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let admin: string;
  let assistant: string;
  let practitioner: string;
  let billing: string;
  let locA: string;
  let locAArchived: string;
  let locB: string;

  beforeAll(async () => {
    db = ownerClient();
    // PRO → saasPlan CLINICA: trae `salaEspera` (Clínica y Libre).
    A = await createEphemeralTenant(db, { plan: "PRO" });
    B = await createEphemeralTenant(db, { plan: "PRO" });
    admin = (await addStaff(db, A, "ADMIN")).userId;
    assistant = (await addStaff(db, A, "ASSISTANT")).userId;
    practitioner = (await addPractitioner(db, A, "PRACTITIONER")).userId;
    billing = (await addStaff(db, A, "BILLING")).userId;
    locA = (await db.location.create({ data: { tenantId: A.tenantId, name: "Sede Centro", isPrimary: true } })).id;
    locAArchived = (await db.location.create({ data: { tenantId: A.tenantId, name: "Sede Vieja", active: false } })).id;
    locB = (await db.location.create({ data: { tenantId: B.tenantId, name: "Sede de B", isPrimary: true } })).id;
  });

  beforeEach(async () => {
    // El limitador en memoria es por proceso: cada caso arranca con el cupo de 20 códigos por hora entero.
    __rateLimitInternals.reset();
    // Y sin las pantallas del caso anterior: si no, A llega al tope de 10 a mitad del archivo.
    await db.receptionDisplay.deleteMany({ where: { tenantId: { in: [A.tenantId, B.tenantId] } } });
  });

  afterAll(async () => {
    asAnonymous();
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  const live = (tenantId: string) => db.receptionDisplay.count({ where: { tenantId, revokedAt: null } });

  it("[TV-2s] matriz de roles: OWNER, ADMIN y ASSISTANT operan; PRACTITIONER y BILLING no ven ni crean", async () => {
    for (const userId of [A.userId, admin, assistant]) {
      asUser(userId);
      const panel = await getDisplaysPanel();
      expect(panel.ok).toBe(true);
      const created = await createReceptionDisplay(input());
      expect(created.ok).toBe(true);
    }
    const before = await live(A.tenantId);
    for (const userId of [practitioner, billing]) {
      asUser(userId);
      const panel = await getDisplaysPanel();
      expect(panel.ok).toBe(false);
      const created = await createReceptionDisplay(input());
      expect(created.ok).toBe(false);
    }
    expect(await live(A.tenantId)).toBe(before);
  });

  it("[TV-2s] módulo revocado por Plataforma (M12 moduleRevokes) → rechazo con el copy de revocado, sin filas", async () => {
    const T = await createEphemeralTenant(db, { plan: "PRO" });
    try {
      await db.tenant.update({ where: { id: T.tenantId }, data: { moduleRevokes: ["salaEspera"] } });
      asUser(T.userId);
      const panel = await getDisplaysPanel();
      expect(panel).toEqual({ ok: false, error: MODULE_REVOKED_COPY });
      const created = await createReceptionDisplay(input());
      expect(created).toEqual({ ok: false, error: MODULE_REVOKED_COPY });
      expect(await live(T.tenantId)).toBe(0);
      // Control contra el falso verde: el mismo tenant sin el revoke sí crea.
      await db.tenant.update({ where: { id: T.tenantId }, data: { moduleRevokes: [] } });
      expect((await createReceptionDisplay(input())).ok).toBe(true);
    } finally {
      await T.cleanup();
    }
  });

  it("[TV-2s] sede: la de otro tenant y una archivada se rechazan; la activa propia queda con su nombre", async () => {
    asUser(admin);
    for (const locationId of [locB, locAArchived, "no-existe"]) {
      const r = await createReceptionDisplay(input({ locationId }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.fieldErrors?.locationId?.length).toBe(1);
    }
    expect(await db.receptionDisplay.count({ where: { locationId: { in: [locB, locAArchived] } } })).toBe(0);

    const ok = await createReceptionDisplay(input({ locationId: locA }));
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.data.display.locationId).toBe(locA);
    expect(ok.data.display.locationName).toBe("Sede Centro");

    // Edición hacia la sede de B: mismo rechazo, la fila no cambia.
    const moved = await updateReceptionDisplay({
      ...input({ name: ok.data.display.name, locationId: locB }),
      id: ok.data.display.id,
      expectedUpdatedAt: ok.data.display.updatedAt,
    });
    expect(moved.ok).toBe(false);
    expect((await db.receptionDisplay.findUniqueOrThrow({ where: { id: ok.data.display.id } })).locationId).toBe(locA);

    // El panel lista solo sedes activas del tenant.
    const panel = await getDisplaysPanel();
    expect(panel.ok).toBe(true);
    if (panel.ok) {
      expect(panel.data.locations.map((l) => l.id)).toEqual([locA]);
      expect(panel.data.locations[0]).toMatchObject({ id: locA, name: "Sede Centro", isPrimary: true });
      expect(panel.data.maxLive).toBe(MAX_LIVE_DISPLAYS);
    }
  });

  it("[TV-2s] B no ve, no edita, no regenera ni revoca una pantalla de A", async () => {
    asUser(A.userId);
    const r = await createReceptionDisplay(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data.display;
    asUser(B.userId);
    const panel = await getDisplaysPanel();
    expect(panel.ok && panel.data.displays.some((x) => x.id === d.id)).toBe(false);
    expect((await updateReceptionDisplay({ ...input(), id: d.id, expectedUpdatedAt: d.updatedAt })).ok).toBe(false);
    expect((await regenerateDisplayPairingCode({ id: d.id })).ok).toBe(false);
    expect((await revokeReceptionDisplay({ id: d.id })).ok).toBe(false);
    const row = await db.receptionDisplay.findUniqueOrThrow({ where: { id: d.id } });
    expect(row.revokedAt).toBeNull();
    expect(row.name).toBe(d.name);
    expect(row.updatedAt.toISOString()).toBe(d.updatedAt);
  });

  it("[TV-2s] CAS: editar con un updatedAt viejo → stale, la fila no cambia; con el vigente → guarda y parsea YouTube", async () => {
    asUser(assistant);
    const r = await createReceptionDisplay(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data.display;

    const first = await updateReceptionDisplay({
      ...input({ name: d.name, theme: "LIGHT", mediaUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
      id: d.id,
      expectedUpdatedAt: d.updatedAt,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.display).toMatchObject({ theme: "LIGHT", mediaKind: "VIDEO", mediaRef: "dQw4w9WgXcQ" });

    const stale = await updateReceptionDisplay({
      ...input({ name: "Otro nombre", theme: "DARK" }),
      id: d.id,
      expectedUpdatedAt: d.updatedAt,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error).toMatch(/cambió/);
    const row = await db.receptionDisplay.findUniqueOrThrow({ where: { id: d.id } });
    expect(row).toMatchObject({ name: d.name, theme: "LIGHT", mediaKind: "VIDEO", mediaRef: "dQw4w9WgXcQ" });

    // Link que no es de YouTube → error de copy en el campo; vacío → sin video.
    const bad = await updateReceptionDisplay({
      ...input({ name: d.name, mediaUrl: "https://vimeo.com/123" }),
      id: d.id,
      expectedUpdatedAt: first.data.display.updatedAt,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.fieldErrors?.mediaUrl?.[0]).toMatch(/YouTube/);
    const none = await updateReceptionDisplay({
      ...input({ name: d.name, mediaUrl: "   " }),
      id: d.id,
      expectedUpdatedAt: first.data.display.updatedAt,
    });
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.data.display).toMatchObject({ mediaKind: "NONE", mediaRef: null });

    const audits = await db.auditEvent.findMany({
      where: { tenantId: A.tenantId, entity: "ReceptionDisplay", entityId: d.id, action: "display.updated" },
    });
    expect(audits).toHaveLength(2);
  });

  it(`[TV-2s] tope de ${MAX_LIVE_DISPLAYS} pantallas vivas; revocar una libera el lugar`, async () => {
    const T = await createEphemeralTenant(db, { plan: "PRO" });
    try {
      asUser(T.userId);
      const ids: string[] = [];
      for (let i = 0; i < MAX_LIVE_DISPLAYS; i++) {
        const r = await createReceptionDisplay(input({ name: `TV ${i}` }));
        expect(r.ok).toBe(true);
        if (r.ok) ids.push(r.data.display.id);
      }
      const over = await createReceptionDisplay(input({ name: "TV de más" }));
      expect(over.ok).toBe(false);
      if (!over.ok) expect(over.error).toMatch(String(MAX_LIVE_DISPLAYS));
      expect(await live(T.tenantId)).toBe(MAX_LIVE_DISPLAYS);

      expect((await revokeReceptionDisplay({ id: ids[0] })).ok).toBe(true);
      expect((await createReceptionDisplay(input({ name: "TV de más" }))).ok).toBe(true);
      expect(await live(T.tenantId)).toBe(MAX_LIVE_DISPLAYS);
    } finally {
      await T.cleanup();
    }
  });

  it("[TV-2s] nombre duplicado entre las vivas (sin distinguir mayúsculas) → mensaje claro; revocada libera el nombre", async () => {
    asUser(A.userId);
    const name = `Planta Baja ${uniqueSuffix()}`;
    const first = await createReceptionDisplay(input({ name }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const dup = await createReceptionDisplay(input({ name: name.toUpperCase() }));
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.error).toMatch(NAME_TAKEN);
      expect(dup.fieldErrors?.name?.[0]).toMatch(NAME_TAKEN);
    }

    // Renombrar otra pantalla a ese nombre: mismo mensaje.
    const other = await createReceptionDisplay(input());
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    const rename = await updateReceptionDisplay({
      ...input({ name: ` ${name.toLowerCase()} ` }),
      id: other.data.display.id,
      expectedUpdatedAt: other.data.display.updatedAt,
    });
    expect(rename.ok).toBe(false);
    if (!rename.ok) expect(rename.error).toMatch(NAME_TAKEN);

    expect((await revokeReceptionDisplay({ id: first.data.display.id })).ok).toBe(true);
    expect((await createReceptionDisplay(input({ name }))).ok).toBe(true);
  });

  it("[TV-2s] el código en claro sale solo en la respuesta: la base guarda el HMAC, no queda en ninguna columna ni audit", async () => {
    asUser(admin);
    const t0 = Date.now();
    const r = await createReceptionDisplay(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { display, pairing } = r.data;
    expect(pairing.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const plain = normalizePairingCode(pairing.code);
    expect(plain).not.toBeNull();

    const row = await db.receptionDisplay.findUniqueOrThrow({ where: { id: display.id } });
    expect(row.pairingCodeHash).toBe(hashPairingCode(plain!));
    expect(row.pairingExpiresAt!.getTime()).toBeGreaterThanOrEqual(t0 + PAIRING_TTL_MS - 5_000);
    expect(row.pairingExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + PAIRING_TTL_MS + 5_000);
    expect(new Date(pairing.expiresAt).getTime()).toBe(row.pairingExpiresAt!.getTime());
    expect(row.createdByUserId).toBe(admin);
    const rowText = JSON.stringify(row);
    expect(rowText).not.toContain(plain!);
    expect(rowText).not.toContain(pairing.code);

    const regen = await regenerateDisplayPairingCode({ id: display.id });
    expect(regen.ok).toBe(true);
    if (!regen.ok) return;
    const plain2 = normalizePairingCode(regen.data.code)!;

    const audits = await db.auditEvent.findMany({ where: { tenantId: A.tenantId, entityId: display.id } });
    expect(audits.map((a) => a.action).sort()).toEqual(["display.code_regenerated", "display.created"]);
    for (const a of audits) {
      expect(a.actorId).toBe(admin);
      expect(a.entity).toBe("ReceptionDisplay");
      const text = JSON.stringify(a);
      for (const s of [plain!, pairing.code, plain2, regen.data.code, row.pairingCodeHash!]) expect(text).not.toContain(s);
    }
  });

  it("[TV-2s] la salida nunca trae hashes (panel, alta, edición)", async () => {
    asUser(A.userId);
    const r = await createReceptionDisplay(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await db.receptionDisplay.update({
      where: { id: r.data.display.id },
      data: { deviceSecretHash: FAKE_DEVICE_HASH, pairedAt: new Date() },
    });
    const row = await db.receptionDisplay.findUniqueOrThrow({ where: { id: r.data.display.id } });
    const upd = await updateReceptionDisplay({
      ...input({ name: r.data.display.name }),
      id: row.id,
      expectedUpdatedAt: row.updatedAt.toISOString(),
    });
    expect(upd.ok).toBe(true);
    const panel = await getDisplaysPanel();
    expect(panel.ok).toBe(true);
    for (const out of [r, upd, panel]) {
      const text = JSON.stringify(out);
      expect(text).not.toMatch(/Hash/);
      expect(text).not.toContain(FAKE_DEVICE_HASH);
      expect(text).not.toContain(row.pairingCodeHash!);
    }
    if (panel.ok) {
      const item = panel.data.displays.find((x) => x.id === row.id)!;
      expect(item.pairedAt).toBe(row.pairedAt!.toISOString());
      expect(item.pairingExpiresAt).toBe(row.pairingExpiresAt!.toISOString());
    }
  });

  it("[TV-2s] regenerar: código nuevo, el vínculo viejo sigue hasta que un vínculo nuevo lo pise", async () => {
    asUser(assistant);
    const r = await createReceptionDisplay(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pairedAt = new Date();
    await db.receptionDisplay.update({
      where: { id: r.data.display.id },
      data: { deviceSecretHash: FAKE_DEVICE_HASH, pairedAt, pairingCodeHash: null, pairingExpiresAt: null },
    });
    const regen = await regenerateDisplayPairingCode({ id: r.data.display.id });
    expect(regen.ok).toBe(true);
    if (!regen.ok) return;
    const row = await db.receptionDisplay.findUniqueOrThrow({ where: { id: r.data.display.id } });
    expect(row.pairingCodeHash).toBe(hashPairingCode(normalizePairingCode(regen.data.code)!));
    expect(row.deviceSecretHash).toBe(FAKE_DEVICE_HASH);
    expect(row.pairedAt?.getTime()).toBe(pairedAt.getTime());
  });

  it("[TV-2s] revocar: revokedAt + revokedByUserId, hashes en null, sale del panel y ya no se edita", async () => {
    asUser(A.userId);
    const r = await createReceptionDisplay(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await db.receptionDisplay.update({
      where: { id: r.data.display.id },
      data: { deviceSecretHash: FAKE_DEVICE_HASH, pairedAt: new Date() },
    });
    const rev = await revokeReceptionDisplay({ id: r.data.display.id });
    expect(rev).toEqual({ ok: true, data: undefined });
    const row = await db.receptionDisplay.findUniqueOrThrow({ where: { id: r.data.display.id } });
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedByUserId).toBe(A.userId);
    expect(row).toMatchObject({ pairingCodeHash: null, pairingExpiresAt: null, deviceSecretHash: null });
    const panel = await getDisplaysPanel();
    expect(panel.ok && panel.data.displays.some((x) => x.id === row.id)).toBe(false);
    expect((await revokeReceptionDisplay({ id: row.id })).ok).toBe(false);
    expect((await regenerateDisplayPairingCode({ id: row.id })).ok).toBe(false);
    expect(
      (await updateReceptionDisplay({ ...input(), id: row.id, expectedUpdatedAt: row.updatedAt.toISOString() })).ok
    ).toBe(false);
    const audit = await db.auditEvent.findFirst({ where: { entityId: row.id, action: "display.revoked" } });
    expect(audit?.actorId).toBe(A.userId);
  });

  it("[TV-2s] rate limit: 20 códigos por hora por usuario (alta + regenerar); el 21 se rechaza sin escribir", async () => {
    const T = await createEphemeralTenant(db, { plan: "PRO" });
    try {
      asUser(T.userId);
      const r = await createReceptionDisplay(input());
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      for (let i = 0; i < 19; i++) expect((await regenerateDisplayPairingCode({ id: r.data.display.id })).ok).toBe(true);
      const before = await db.receptionDisplay.findUniqueOrThrow({ where: { id: r.data.display.id } });
      const limited = await regenerateDisplayPairingCode({ id: r.data.display.id });
      expect(limited.ok).toBe(false);
      if (!limited.ok) expect(limited.error).toMatch(/Demasiados intentos/);
      expect((await createReceptionDisplay(input())).ok).toBe(false);
      const after = await db.receptionDisplay.findUniqueOrThrow({ where: { id: r.data.display.id } });
      expect(after.pairingCodeHash).toBe(before.pairingCodeHash);
      expect(await live(T.tenantId)).toBe(1);
    } finally {
      await T.cleanup();
    }
  });

  it("[TV-2s] consultorio en solo lectura: el alta devuelve el copy del modo lectura y no escribe", async () => {
    const T = await createEphemeralTenant(db, { plan: "PRO" });
    const prev = process.env.TENANT_ACCESS_ENFORCEMENT;
    try {
      await db.tenant.update({ where: { id: T.tenantId }, data: { subscriptionStatus: "CANCELLED" } });
      process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
      asUser(T.userId);
      expect(await createReceptionDisplay(input())).toEqual({ ok: false, error: READ_ONLY_MESSAGE });
      expect(await live(T.tenantId)).toBe(0);
      // Leer sí: el panel abre (vacío).
      const panel = await getDisplaysPanel();
      expect(panel.ok && panel.data.displays).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.TENANT_ACCESS_ENFORCEMENT;
      else process.env.TENANT_ACCESS_ENFORCEMENT = prev;
      await T.cleanup();
    }
  });
});

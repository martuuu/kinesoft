/**
 * CF3b PH-S (M24 `cf3_practitioner_photo`, contrato FOTO) · foto del profesional contra Postgres real.
 *
 * Corre los símbolos REALES: las actions de `lib/user-photo.ts` (sesión por `getAccessSnapshot`, tx del canal service),
 * los dos route handlers (`/api/me/photo`, `/api/public/pro-photo/[practitionerId]`), `getPublicClinic`, el builder de la
 * sede y el loader de /configuracion. Red mockeada: la sesión de Supabase (tests/helpers/actor.ts vía el setup),
 * `next/cache` (setup) y el admin client de Storage (`tests/helpers/storage-fake.ts`). Se corre con los dos roles
 * (`test:integration` = kinesoft_app con RLS y `test:integration:owner` = BYPASSRLS, como prod).
 *
 * Lo observable: la fila (`UserProfile.photo*`, `Practitioner.showPhotoPublic`, `AuditEvent`), el objeto en Storage
 * (bytes guardados, viejo borrado), status y headers de las rutas, que Storage NO se toque cuando no corresponde y las
 * sentencias de las lecturas.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import type { PrismaClient } from "@prisma/client";
import {
  addPractitioner,
  addStaff,
  createEphemeralTenant,
  ownerClient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { storageFake } from "@/tests/helpers/storage-fake";
import { jpeg, png } from "@/tests/helpers/image-bytes";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import { measure } from "@/tests/helpers/query-counter";
import { revalidatePathSpy, revalidateTagSpy } from "@/tests/helpers/integration-setup";
import { __rateLimitInternals, rateLimit } from "@/lib/rate-limit";

vi.mock("@/lib/supabase/admin", async () => {
  const { storageFake: fake } = await import("@/tests/helpers/storage-fake");
  return { getSupabaseAdminClient: () => fake.client() };
});
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { removeOwnPhoto, setOwnShowPhotoPublic, uploadOwnPhoto } from "@/lib/user-photo";
import { PUBLIC_PHOTO_BYTES_RATE_LIMIT, USER_PHOTO_COPY, USER_PHOTO_LIMITS, ownPhotoUrlFor } from "@/lib/user-photo-logic";
import { getPublicClinic } from "@/lib/public-booking";
import { buildClinicSiteSnapshot } from "@/lib/clinic-site-internal";
import { expandClinicSite } from "@/lib/clinic-site-logic";
import { clinicSiteSchema } from "@/lib/clinic-site-types";
import { loadConfiguracionPage } from "@/lib/configuracion-page-loader";
import { capabilitiesForActor } from "@/lib/authz";
import { getAccessSnapshot, getActor } from "@/lib/session";

const RUN = process.env.INTEGRATION === "1";
const BUCKET = "practice-assets";
const ORIGIN = "http://localhost";
const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const chunk = (type: string, data: Uint8Array) => {
  const b = new Uint8Array(12 + data.length);
  new DataView(b.buffer).setUint32(0, data.length);
  b.set(enc(type), 4);
  b.set(data, 8);
  return b;
};
/** PNG entero (firma + IHDR de `png()` + IDAT + IEND): el limpiador exige el IEND, como cualquier PNG real. */
const fullPng = (w: number, h: number, extra: Uint8Array[] = []) =>
  cat(png(w, h), ...extra, chunk("IDAT", enc("pixeles")), chunk("IEND", new Uint8Array(0)));
const form = (bytes: Uint8Array, type: string, extra: Record<string, string> = {}) => {
  const f = new FormData();
  f.set("file", new File([new Uint8Array(bytes)], "foto", { type }));
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
};
const hasBytes = (hay: Uint8Array, needle: Uint8Array) => Buffer.from(hay).includes(Buffer.from(needle));

describe.skipIf(!RUN)("[PH-S] foto del profesional (M24)", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];
  const extraUsers: string[] = [];
  const prevEnforcement = process.env.TENANT_ACCESS_ENFORCEMENT;
  let T: EphemeralTenant; // turnero abierto
  let U: EphemeralTenant; // otro consultorio del mismo profesional de T
  let pro: { userId: string; practitionerId: string }; // profesional de T (y de U)
  let proInU = "";
  let other: { userId: string; practitionerId: string }; // otro profesional de T
  const ownRoute = () => import("@/app/api/me/photo/route");
  const pubRoute = () => import("@/app/api/public/pro-photo/[practitionerId]/route");
  const getOwn = async (qs = "") => (await ownRoute()).GET(new Request(`${ORIGIN}/api/me/photo${qs}`));
  const getPub = async (id: string, qs = "") =>
    (await pubRoute()).GET(new Request(`${ORIGIN}/api/public/pro-photo/${id}${qs}`), { params: { practitionerId: id } });
  const downloads = () => storageFake.calls.filter((c) => c.op === "download");
  const uploads = () => storageFake.calls.filter((c) => c.op === "upload");
  const row = (userId: string) =>
    db.userProfile.findUniqueOrThrow({ where: { id: userId }, select: { photoStorageKey: true, photoUpdatedAt: true } });

  /** Foto directa en la base + Storage (sin pasar por la action), para las rutas. */
  async function seedPhoto(userId: string, at: Date, bytes = fullPng(64, 64)): Promise<string> {
    const key = `users/${userId}/photo/${uniqueSuffix()}.png`;
    await db.userProfile.update({ where: { id: userId }, data: { photoStorageKey: key, photoUpdatedAt: at } });
    storageFake.put(BUCKET, key, bytes, "image/png");
    return key;
  }

  beforeAll(async () => {
    if (!RUN) return;
    delete process.env.TENANT_ACCESS_ENFORCEMENT; // default (banner): suspendido cierra lo público
    db = ownerClient();
    storageFake.reset();
    T = await createEphemeralTenant(db);
    U = await createEphemeralTenant(db);
    tenants.push(T, U);
    pro = await addPractitioner(db, T);
    other = await addPractitioner(db, T);
    // El mismo profesional también atiende en U (una foto para los dos; el opt-in es de cada consultorio).
    proInU = (
      await db.practitioner.create({ data: { tenantId: U.tenantId, userId: pro.userId, specialty: "Test", publicBookingEnabled: true } })
    ).id;
    await db.membership.create({ data: { userId: pro.userId, tenantId: U.tenantId, role: "PRACTITIONER", acceptedAt: new Date() } });
    // Servicios propios: sin uno que ofrezcan online no salen en el turnero (`getPublicClinic`).
    for (const [tenantId, practitionerId] of [
      [T.tenantId, pro.practitionerId],
      [T.tenantId, other.practitionerId],
      [U.tenantId, proInU],
    ]) {
      await db.service.create({ data: { tenantId, practitionerId, name: "Kinesiología", durationMin: 30, priceCents: 5000 } });
    }
  }, 60_000);

  afterAll(async () => {
    if (db) {
      for (const t of tenants) await t.cleanup();
      if (extraUsers.length) await db.userProfile.deleteMany({ where: { id: { in: extraUsers } } });
      await db.$disconnect();
    }
    storageFake.reset();
    if (prevEnforcement === undefined) delete process.env.TENANT_ACCESS_ENFORCEMENT;
    else process.env.TENANT_ACCESS_ENFORCEMENT = prevEnforcement;
  });

  beforeEach(() => {
    __rateLimitInternals.reset();
    storageFake.calls = [];
    revalidatePathSpy.mockClear();
    revalidateTagSpy.mockClear();
    cookies().set("kine_tenant", T.tenantId);
    asAnonymous();
  });

  // ── Subida ──────────────────────────────────────────────────────────────────────────────────────────────────────

  it("[PH-S-1] subida ok: clave users/<id>/photo/<nonce>.png, las dos columnas en una escritura, URL con ?v y revalidación", async () => {
    asUser(pro.userId);
    const r = await uploadOwnPhoto(form(fullPng(512, 512), "image/png"));
    expect(r.ok).toBe(true);
    const after = await row(pro.userId);
    expect(after.photoStorageKey).toMatch(new RegExp(`^users/${pro.userId}/photo/[0-9a-f]{24}\\.png$`));
    expect(after.photoUpdatedAt).toBeInstanceOf(Date);
    expect(r.ok && r.data.photoUrl).toBe(`/api/me/photo?v=${after.photoUpdatedAt!.getTime()}`);
    expect(storageFake.get(BUCKET, after.photoStorageKey!)?.contentType).toBe("image/png");
    // CF3 ZF5 (B): sin `revalidatePath("/", "layout")` (purgaba TODO el sitio: sedes, turneros y directorio de todos los
    // consultorios) y sin tags: esta persona no publica la foto en ningún consultorio todavía (sin opt-in), así que
    // ninguna superficie pública la muestra. Solo «Mi agenda» (/configuracion) se vuelve a pintar.
    expect(revalidatePathSpy.mock.calls).toEqual([["/configuracion"]]);
    expect(revalidateTagSpy).not.toHaveBeenCalled();
  });

  it("[PH-S-2] tipo falso (HTML con type image/png), SVG y PNG roto → rechazo SIN subir y sin tocar la fila", async () => {
    asUser(other.userId);
    const before = await row(other.userId);
    const cases: [Uint8Array, string, string][] = [
      [enc("<!doctype html><script>alert(1)</script>"), "image/png", USER_PHOTO_COPY.fake],
      [enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), "image/svg+xml", USER_PHOTO_COPY.format],
      [png(10, 10), "image/png", USER_PHOTO_COPY.fake], // sin IEND: estructura rota
      [fullPng(10, 10), "image/jpeg", USER_PHOTO_COPY.fake],
    ];
    for (const [bytes, type, error] of cases) {
      expect(await uploadOwnPhoto(form(bytes, type)), type).toEqual({ ok: false, error });
    }
    expect(uploads()).toEqual([]);
    expect(await row(other.userId)).toEqual(before);
  });

  it("[PH-S-3] > 1 MB → rechazo sin leer ni subir; > 2048 px (bomba de descompresión) → rechazo", async () => {
    asUser(other.userId);
    const big = new Uint8Array(USER_PHOTO_LIMITS.maxBytes + 1);
    big.set(fullPng(10, 10));
    expect(await uploadOwnPhoto(form(big, "image/png"))).toEqual({ ok: false, error: USER_PHOTO_COPY.format });
    expect(await uploadOwnPhoto(form(fullPng(20_000, 20_000), "image/png"))).toEqual({ ok: false, error: USER_PHOTO_COPY.tooBig });
    expect(uploads()).toEqual([]);
  });

  it("[PH-S-4] EXIF/GPS y bytes después del IEND/EOI no llegan a Storage (la foto se publica)", async () => {
    asUser(other.userId);
    const withGps = fullPng(32, 32, [chunk("eXIf", enc("GPS-34.6037")), chunk("tEXt", enc("Author\0Casa"))]);
    const r = await uploadOwnPhoto(form(cat(withGps, enc("<html>polyglot</html>")), "image/png"));
    expect(r.ok).toBe(true);
    const key = (await row(other.userId)).photoStorageKey!;
    const stored = storageFake.get(BUCKET, key)!.bytes;
    for (const leak of ["GPS", "Casa", "polyglot"]) expect(hasBytes(stored, enc(leak)), leak).toBe(false);
    expect(hasBytes(stored, enc("IDAT"))).toBe(true);
    // JPEG con APP1 Exif: se sube sin el segmento.
    const exifPayload = enc("Exif\0\0GPS-34.60");
    const exif = cat(new Uint8Array([0xff, 0xe1, 0, exifPayload.length + 2]), exifPayload);
    const j = jpeg(40, 40);
    const r2 = await uploadOwnPhoto(form(cat(j.subarray(0, 2), exif, j.subarray(2)), "image/jpeg"));
    expect(r2.ok).toBe(true);
    const key2 = (await row(other.userId)).photoStorageKey!;
    expect(key2).toMatch(/\.jpg$/);
    expect(hasBytes(storageFake.get(BUCKET, key2)!.bytes, enc("Exif"))).toBe(false);
  });

  it("[PH-S-5] reemplazo: clave nueva, versión mayor y el objeto viejo se borra DESPUÉS del commit", async () => {
    asUser(pro.userId);
    const before = await row(pro.userId);
    expect(before.photoStorageKey).not.toBeNull();
    const r = await uploadOwnPhoto(form(jpeg(300, 300), "image/jpeg"));
    expect(r.ok).toBe(true);
    const after = await row(pro.userId);
    expect(after.photoStorageKey).not.toBe(before.photoStorageKey);
    expect(after.photoUpdatedAt!.getTime()).toBeGreaterThan(before.photoUpdatedAt!.getTime());
    expect(storageFake.get(BUCKET, before.photoStorageKey!)).toBeUndefined();
    expect(storageFake.get(BUCKET, after.photoStorageKey!)).toBeDefined();
    const ops = storageFake.calls.map((c) => c.op);
    expect(ops.indexOf("upload")).toBeLessThan(ops.indexOf("remove"));
  });

  it("[PH-S-6] otro usuario no puede escribir la foto ajena: el userId sale de la sesión, nunca del form; la base lo frena igual", async () => {
    const proBefore = await row(pro.userId);
    asUser(other.userId);
    const r = await uploadOwnPhoto(form(fullPng(20, 20), "image/png", { userId: pro.userId, practitionerId: pro.practitionerId }));
    expect(r.ok).toBe(true);
    expect(await row(pro.userId)).toEqual(proBefore);
    expect((await row(other.userId)).photoStorageKey).toMatch(new RegExp(`^users/${other.userId}/`));
    // Defensa en la base (CHECK de M24): una fila no puede apuntar a la carpeta de otro ni a la firma de nadie.
    for (const key of [`users/${other.userId}/photo/x.png`, `${T.tenantId}/signature/${pro.practitionerId}/a.png`]) {
      await expect(
        db.userProfile.update({ where: { id: pro.userId }, data: { photoStorageKey: key, photoUpdatedAt: new Date() } }),
        key
      ).rejects.toThrow(/UserProfile_photoStorageKey_check|23514/);
    }
  });

  it("[PH-S-7] sin sesión → error sin tocar nada; sin consultorio usable no sube (sí puede borrar)", async () => {
    asAnonymous();
    expect(await uploadOwnPhoto(form(fullPng(10, 10), "image/png"))).toEqual({ ok: false, error: USER_PHOTO_COPY.noSession });
    expect(await removeOwnPhoto()).toEqual({ ok: false, error: USER_PHOTO_COPY.noSession });
    const loneId = `test-user-${uniqueSuffix()}`;
    extraUsers.push(loneId);
    await db.userProfile.create({ data: { id: loneId, email: `${loneId}@test.local` } });
    asUser(loneId);
    expect(await uploadOwnPhoto(form(fullPng(10, 10), "image/png"))).toEqual({ ok: false, error: USER_PHOTO_COPY.noMembership });
    expect(await removeOwnPhoto()).toEqual({ ok: true, data: undefined });
    expect(uploads()).toEqual([]);
  });

  it("[PH-S-8] quitar: las dos columnas a null, objeto borrado; quitar de nuevo es ok sin escribir", async () => {
    asUser(other.userId);
    const key = (await row(other.userId)).photoStorageKey!;
    expect(await removeOwnPhoto()).toEqual({ ok: true, data: undefined });
    expect(await row(other.userId)).toEqual({ photoStorageKey: null, photoUpdatedAt: null });
    expect(storageFake.get(BUCKET, key)).toBeUndefined();
    revalidatePathSpy.mockClear();
    expect(await removeOwnPhoto()).toEqual({ ok: true, data: undefined });
    expect(revalidatePathSpy).not.toHaveBeenCalled();
  });

  // CF3 ZF4a (B, auditoría de PH-S): la foto es un dato de la cuenta que sale en páginas públicas; como la matrícula
  // (CT-L), cada cambio queda en «Seguridad de la cuenta» (`UserSecurityEvent`), en la MISMA tx de la escritura.
  it("[CF3-ZF4a7] subir, reemplazar y borrar la foto dejan photo.updated / photo.removed; quitar sin foto no deja evento", async () => {
    // Los de PH-S-6/PH-S-8 (la misma persona) quedan afuera: solo cuentan los de este test.
    const all = () =>
      db.userSecurityEvent.findMany({
        where: { userId: other.userId, kind: { startsWith: "photo." } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, kind: true, payload: true, tenantId: true },
      });
    const seen = new Set((await all()).map((e) => e.id));
    const events = async () => (await all()).filter((e) => !seen.has(e.id)).map(({ id: _id, ...e }) => e);
    asUser(other.userId); // sin foto (PH-S-8)
    expect((await uploadOwnPhoto(form(fullPng(64, 64), "image/png"))).ok).toBe(true);
    expect((await uploadOwnPhoto(form(jpeg(32, 32), "image/jpeg"))).ok).toBe(true);
    expect(await removeOwnPhoto()).toEqual({ ok: true, data: undefined });
    expect(await removeOwnPhoto()).toEqual({ ok: true, data: undefined }); // sin foto: no escribe ni deja evento
    // Sin payload: ni la clave del objeto ni nada de la imagen (el registro lo ve la persona y Plataforma).
    expect(await events()).toEqual([
      { kind: "photo.updated", payload: null, tenantId: null },
      { kind: "photo.updated", payload: null, tenantId: null },
      { kind: "photo.removed", payload: null, tenantId: null },
    ]);
    // Una subida rechazada (tipo falso) no deja evento.
    expect((await uploadOwnPhoto(form(enc("<html>"), "image/png"))).ok).toBe(false);
    expect(await events()).toHaveLength(3);
    expect(await row(other.userId)).toEqual({ photoStorageKey: null, photoUpdatedAt: null });
  });

  // CF3 ZF5 (B): subir o borrar la foto revalida SOLO los consultorios donde la persona la publica (`showPhotoPublic`):
  // su sede `/<slug>`, su turnero y el snapshot de las sedes (tags). Antes `revalidatePath("/", "layout")` tiraba el
  // cache de todas las páginas de todos los consultorios por cada foto de cualquiera.
  it("[CF3-ZF5-4] subir/borrar la foto revalida solo /<slug> y el turnero de los consultorios con opt-in, más los tags", async () => {
    // `pro` atiende en T y en U; opt-in solo en U (en T queda como estaba).
    const { showPhotoPublic: inT } = await db.practitioner.findUniqueOrThrow({ where: { id: pro.practitionerId }, select: { showPhotoPublic: true } });
    await db.practitioner.update({ where: { id: proInU }, data: { showPhotoPublic: true } });
    await db.practitioner.update({ where: { id: pro.practitionerId }, data: { showPhotoPublic: false } });
    try {
      asUser(pro.userId);
      const { result: r, m } = await measure(() => uploadOwnPhoto(form(jpeg(300, 300), "image/jpeg")));
      expect(r.ok).toBe(true);
      const paths = revalidatePathSpy.mock.calls.map((c) => c.join(" "));
      expect(paths.sort()).toEqual(["/configuracion", `/${U.slug}`, `/c/${U.slug}/booking`].sort());
      expect(revalidateTagSpy.mock.calls.map((c) => c[0]).sort()).toEqual(["global:directory", "global:sites"]);
      // La lista de consultorios sale en la MISMA lectura bloqueante de la fila: 0 sentencias nuevas. Las 4 de siempre:
      // foto de acceso (sesión) + en la tx el SELECT … FOR UPDATE (con la subconsulta), el UPDATE y el evento.
      expect(m.statements).toBe(4);
      revalidatePathSpy.mockClear();
      revalidateTagSpy.mockClear();
      // Sin opt-in en ningún lado: solo /configuracion, sin tags.
      await db.practitioner.update({ where: { id: proInU }, data: { showPhotoPublic: false } });
      expect((await uploadOwnPhoto(form(jpeg(300, 300), "image/jpeg"))).ok).toBe(true);
      expect(revalidatePathSpy.mock.calls).toEqual([["/configuracion"]]);
      expect(revalidateTagSpy).not.toHaveBeenCalled();
      // Borrar con opt-in en T: lo mismo para T.
      revalidatePathSpy.mockClear();
      await db.practitioner.update({ where: { id: pro.practitionerId }, data: { showPhotoPublic: true } });
      const before = await row(pro.userId);
      expect(await removeOwnPhoto()).toEqual({ ok: true, data: undefined });
      expect(revalidatePathSpy.mock.calls.map((c) => c.join(" ")).sort()).toEqual(["/configuracion", `/${T.slug}`, `/c/${T.slug}/booking`].sort());
      expect(revalidateTagSpy.mock.calls.map((c) => c[0]).sort()).toEqual(["global:directory", "global:sites"]);
      // Se deja la foto como estaba para los tests que siguen (rutas públicas y «Mi agenda»).
      await seedPhoto(pro.userId, before.photoUpdatedAt!, new Uint8Array(jpeg(300, 300)));
    } finally {
      await db.practitioner.update({ where: { id: pro.practitionerId }, data: { showPhotoPublic: inT } });
      await db.practitioner.update({ where: { id: proInU }, data: { showPhotoPublic: false } });
    }
  });

  // ── Foto propia: /api/me/photo ──────────────────────────────────────────────────────────────────────────────────

  it("[PH-S-9] /api/me/photo: 401 sin sesión, 404 sin foto, 308 sin bajar con v vieja/ausente/extra, 200 privado inmutable", async () => {
    expect((await getOwn("?v=1")).status).toBe(401);
    asUser(other.userId); // sin foto (PH-S-8)
    const none = await getOwn("?v=1");
    expect(none.status).toBe(404);
    expect(none.headers.get("cache-control")).toBe("private, no-store");

    asUser(pro.userId);
    const { photoUpdatedAt } = await row(pro.userId);
    const v = String(photoUpdatedAt!.getTime());
    for (const qs of ["", "?v=1", `?v=${v}0`, `?v=${v}&x=1`]) {
      storageFake.calls = [];
      const res = await getOwn(qs);
      expect(res.status, qs).toBe(308);
      expect(new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search).toBe(`/api/me/photo?v=${v}`);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(downloads(), qs).toEqual([]);
    }
    const { result: ok, m } = await measure(() => getOwn(`?v=${v}`));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");
    expect(ok.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(jpeg(300, 300));
    // La foto de acceso (lib/session.ts) + 1 sentencia de la foto.
    expect(m.byClient.service).toBeLessThanOrEqual(2);
    // El avatar del shell sale de la misma versión (CF3 ZF4a: de la foto de acceso, sin lectura propia).
    expect(ownPhotoUrlFor((await getAccessSnapshot())?.profile)).toBe(`/api/me/photo?v=${v}`);
  });

  // CF3 ZF4a (handoff de PH-U1): el avatar propio sale de la foto de acceso (`loadAccessMemberships`, que ya lee
  // `UserProfile`), no de una lectura aparte del layout. Antes: +1 sentencia por carga completa del workspace.
  it("[CF3-ZF4a3] el layout de (app) le pasa al shell el avatar propio de la foto de acceso: 0 sentencias para la foto", async () => {
    const { default: AppLayout } = await import("@/app/(app)/layout");
    const { isValidElement } = await import("react");
    const findProp = (node: unknown, key: string): unknown => {
      if (Array.isArray(node)) {
        for (const n of node) {
          const r = findProp(n, key);
          if (r !== undefined) return r;
        }
        return undefined;
      }
      if (!isValidElement(node)) return undefined;
      const props = node.props as Record<string, unknown>;
      return key in props ? props[key] : findProp(props.children, key);
    };
    const recorded = () => (globalThis as unknown as { __kineQueryRecorder: { events: { query: string }[] } }).__kineQueryRecorder.events;

    asUser(pro.userId);
    const { photoUpdatedAt } = await row(pro.userId);
    const { result: tree } = await measure(() => AppLayout({ children: null }));
    expect(findProp(tree, "userPhotoUrl")).toBe(`/api/me/photo?v=${photoUpdatedAt!.getTime()}`);
    // Ninguna lectura de Prisma de las columnas de M24 (la foto de acceso es SQL a mano: `u."photoUpdatedAt"`).
    expect(recorded().filter((e) => /"UserProfile"\."photo(StorageKey|UpdatedAt)"/.test(e.query))).toEqual([]);

    asUser(other.userId); // sin foto (PH-S-8)
    expect(findProp(await AppLayout({ children: null }), "userPhotoUrl")).toBeNull();
  });

  // ── Foto pública: /api/public/pro-photo/<id> ────────────────────────────────────────────────────────────────────

  it("[PH-S-10] sin opt-in → 404 público uniforme (igual que un id inexistente o roto), sin bajar nada; nunca avatarUrl", async () => {
    await db.userProfile.update({ where: { id: other.userId }, data: { avatarUrl: "https://lh3.googleusercontent.com/a/foto" } });
    await db.practitioner.update({ where: { id: other.practitionerId }, data: { showPhotoPublic: true } }); // opt-in, sin foto
    const { photoUpdatedAt } = await row(pro.userId);
    const v = photoUpdatedAt!.getTime();
    for (const [id, qs] of [
      [pro.practitionerId, `?v=${v}`], // con foto, sin opt-in
      [other.practitionerId, "?v=1"], // opt-in con avatarUrl de Google, sin foto subida
      ["clz0000000000000000000000", "?v=1"],
      ["..%2Fx", "?v=1"],
      ["a b", ""],
    ]) {
      const res = await getPub(id, qs);
      expect(res.status, id).toBe(404);
      // CF3 ZF5: el CDN también guarda el 404 un minuto (sin `s-maxage`, cada id inventado llegaba a la base).
      expect(res.headers.get("cache-control"), id).toBe("public, max-age=60, s-maxage=60");
    }
    expect(downloads()).toEqual([]);
  });

  // CF3 ZF4a (M, auditoría de PH-S): 200 público de UN DÍA, no `immutable` de un año. Si el profesional apaga el opt-in o
  // borra la foto, la URL ya servida deja de verse en un día como máximo (antes un navegador o un CDN la seguían
  // mostrando un año a quien tuviera la URL exacta: es la imagen de una persona en una página pública, Ley 25.326).
  it("[PH-S-11][CF3-ZF4a1] con opt-in y foto: 200 público de 1 día (no inmutable) nosniff; v vieja/ausente/extra → 308 a la canónica sin bajar", async () => {
    asUser(pro.userId);
    expect(await setOwnShowPhotoPublic(true)).toEqual({ ok: true, data: { showPhotoPublic: true } });
    asAnonymous();
    const { photoUpdatedAt } = await row(pro.userId);
    const v = String(photoUpdatedAt!.getTime());
    for (const qs of ["", "?v=1", `?v=${v}&utm=x`]) {
      storageFake.calls = [];
      const res = await getPub(pro.practitionerId, qs);
      expect(res.status, qs).toBe(308);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname + loc.search).toBe(`/api/public/pro-photo/${pro.practitionerId}?v=${v}`);
      expect(res.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=300");
      expect(downloads(), qs).toEqual([]);
    }
    const { result: res, m } = await measure(() => getPub(pro.practitionerId, `?v=${v}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400, s-maxage=86400");
    expect(res.headers.get("cache-control")).not.toMatch(/immutable/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(jpeg(300, 300));
    expect(m.statements).toBeLessThanOrEqual(2);
    // El opt-in es de ESTE consultorio: en U (otro practitionerId de la misma persona) no sale.
    expect((await getPub(proInU, `?v=${v}`)).status).toBe(404);
  });

  // CF3 ZF5: el rate limit por IP del camino que baja bytes no tenía test. Se agota con el limitador real y la MISMA
  // clave que usa la ruta (la IP sale del `x-forwarded-for` del request, como en el logo de la sede).
  it("[CF3-ZF5-5] cupo de la IP agotado → 429 sin bajar de Storage; otra IP sigue; el 308 y el 404 no gastan cupo", async () => {
    const { photoUpdatedAt } = await row(pro.userId);
    const v = String(photoUpdatedAt!.getTime());
    const IP = "203.0.113.91";
    const from = async (ip: string, qs: string) =>
      (await pubRoute()).GET(new Request(`${ORIGIN}/api/public/pro-photo/${pro.practitionerId}${qs}`, { headers: { "x-forwarded-for": ip } }), {
        params: { practitionerId: pro.practitionerId },
      });
    expect((await from(IP, "?v=1")).status).toBe(308);
    expect(__rateLimitInternals.size()).toBe(0);
    for (let i = 0; i < PUBLIC_PHOTO_BYTES_RATE_LIMIT.limit; i++) await rateLimit(`pro-photo:ip:${IP}`, PUBLIC_PHOTO_BYTES_RATE_LIMIT);
    const limited = await from(IP, `?v=${v}`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(downloads()).toEqual([]);
    expect((await from("203.0.113.92", `?v=${v}`)).status).toBe(200);
    expect(downloads()).toHaveLength(1);
  });

  it("[PH-S-12] consultorio cerrado (turnero y sede apagados, o suspendido) y miembro suspendido → 404; sede publicada sola → 200", async () => {
    const { photoUpdatedAt } = await row(pro.userId);
    const qs = `?v=${photoUpdatedAt!.getTime()}`;
    await db.tenant.update({ where: { id: T.tenantId }, data: { publicBookingEnabled: false, siteEnabled: false } });
    expect((await getPub(pro.practitionerId, qs)).status).toBe(404);
    // Turnero apagado pero sede publicada: superficie pública abierta.
    await db.tenant.update({ where: { id: T.tenantId }, data: { siteEnabled: true, siteEnabledAt: new Date() } });
    expect((await getPub(pro.practitionerId, qs)).status).toBe(200);
    // Suspendido: cierra todo lo público aunque los switches estén prendidos.
    await db.tenant.update({ where: { id: T.tenantId }, data: { publicBookingEnabled: true, status: "SUSPENDED", statusChangedAt: new Date() } });
    expect((await getPub(pro.practitionerId, qs)).status).toBe(404);
    await db.tenant.update({ where: { id: T.tenantId }, data: { status: "ACTIVE", siteEnabled: false, siteEnabledAt: null } });
    expect((await getPub(pro.practitionerId, qs)).status).toBe(200);
    // Profesional fuera del turnero o miembro suspendido: no es reservable → 404.
    await db.practitioner.update({ where: { id: pro.practitionerId }, data: { publicBookingEnabled: false } });
    expect((await getPub(pro.practitionerId, qs)).status).toBe(404);
    await db.practitioner.update({ where: { id: pro.practitionerId }, data: { publicBookingEnabled: true } });
    await db.membership.update({
      where: { userId_tenantId: { userId: pro.userId, tenantId: T.tenantId } },
      data: { disabledAt: new Date() },
    });
    expect((await getPub(pro.practitionerId, qs)).status).toBe(404);
    await db.membership.update({ where: { userId_tenantId: { userId: pro.userId, tenantId: T.tenantId } }, data: { disabledAt: null } });
    expect((await getPub(pro.practitionerId, qs)).status).toBe(200);
  });

  // ── Opt-in por consultorio ──────────────────────────────────────────────────────────────────────────────────────

  it("[PH-S-13] setOwnShowPhotoPublic: solo el profesional propio del consultorio activo, audit en la tx, no-boolean rechazado", async () => {
    asUser(pro.userId);
    cookies().set("kine_tenant", U.tenantId);
    expect(await setOwnShowPhotoPublic(true)).toEqual({ ok: true, data: { showPhotoPublic: true } });
    expect(await setOwnShowPhotoPublic(false)).toEqual({ ok: true, data: { showPhotoPublic: false } });
    // El de T no cambió (lo prendió PH-S-11).
    expect((await db.practitioner.findUniqueOrThrow({ where: { id: pro.practitionerId } })).showPhotoPublic).toBe(true);
    expect((await db.practitioner.findUniqueOrThrow({ where: { id: proInU } })).showPhotoPublic).toBe(false);
    const audits = await db.auditEvent.findMany({
      where: { tenantId: U.tenantId, action: "practitioner.public_photo", entityId: proInU },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.map((a) => a.payload)).toEqual([{ from: false, to: true }, { from: true, to: false }]);
    expect(audits.every((a) => a.actorId === pro.userId)).toBe(true);
    expect(revalidatePathSpy).toHaveBeenCalledWith(`/c/${U.slug}/booking`);
    expect(revalidateTagSpy).toHaveBeenCalledWith("global:sites");
    expect(await setOwnShowPhotoPublic("false" as unknown as boolean)).toEqual({ ok: false, error: USER_PHOTO_COPY.invalid });
    // Sin profesional propio (Secretaria): no hay opt-in que tocar.
    const sec = await addStaff(db, T, "ASSISTANT");
    asUser(sec.userId);
    cookies().set("kine_tenant", T.tenantId);
    expect(await setOwnShowPhotoPublic(true)).toEqual({ ok: false, error: USER_PHOTO_COPY.ownOnly });
  });

  // ── DTOs ────────────────────────────────────────────────────────────────────────────────────────────────────────

  it("[PH-S-14] getPublicClinic y la sede: photoUrl solo con opt-in Y foto (la URL de la ruta pública), 0 sentencias nuevas", async () => {
    const { photoUpdatedAt } = await row(pro.userId);
    const expected = `/api/public/pro-photo/${pro.practitionerId}?v=${photoUpdatedAt!.getTime()}`;
    const { result: clinic, m } = await measure(() => getPublicClinic(T.slug));
    const byId = Object.fromEntries(clinic!.practitioners.map((p) => [p.id, p.photoUrl]));
    expect(byId[pro.practitionerId]).toBe(expected);
    expect(byId[other.practitionerId]).toBeNull(); // opt-in con avatarUrl, sin foto subida
    expect(byId[T.practitionerId]).toBeNull(); // sin opt-in ni foto
    expect(JSON.stringify(clinic)).not.toContain("googleusercontent");
    expect(JSON.stringify(clinic)).not.toContain("users/");
    // Sin opt-in en U: null aunque la persona tenga foto.
    const inU = await getPublicClinic(U.slug);
    expect(inU!.practitioners.find((p) => p.id === proInU)?.photoUrl ?? null).toBeNull();
    // Mismas sentencias que antes de PH-S (la fecha viaja en la relación `user`, que ya era su propia sentencia).
    const { m: m2 } = await measure(() => getPublicClinic(T.slug));
    expect(m2.statements).toBe(m.statements);

    await db.tenant.update({ where: { id: T.tenantId }, data: { siteEnabled: true, siteEnabledAt: new Date() } });
    const snap = await buildClinicSiteSnapshot();
    const compact = snap.sites.find((x) => x.slug === T.slug)!;
    const site = expandClinicSite(JSON.parse(JSON.stringify(compact)));
    expect(() => clinicSiteSchema.parse(site)).not.toThrow();
    expect(site.practitioners.find((p) => p.id === pro.practitionerId)?.photoUrl).toBe(expected);
    expect(site.practitioners.find((p) => p.id === other.practitionerId)?.photoUrl).toBeNull();
    await db.tenant.update({ where: { id: T.tenantId }, data: { siteEnabled: false, siteEnabledAt: null } });
  });

  it("[PH-S-15] «Mi agenda»: photo = { url propia, opt-in de ESTE consultorio }, sin sentencias nuevas", async () => {
    asUser(pro.userId);
    cookies().set("kine_tenant", T.tenantId);
    const actor = await getActor();
    const caps = await capabilitiesForActor(actor);
    const { result: r } = await measure(() => loadConfiguracionPage(actor, caps));
    const { photoUpdatedAt } = await row(pro.userId);
    expect(r.miAgenda?.photo).toEqual({ url: `/api/me/photo?v=${photoUpdatedAt!.getTime()}`, showPublic: true });
    expect(r.miAgenda?.license).toEqual({ license: null, updatedAt: null });
    cookies().set("kine_tenant", U.tenantId);
    const actorU = await getActor();
    const rU = await loadConfiguracionPage(actorU, await capabilitiesForActor(actorU));
    expect(rU.miAgenda?.photo).toEqual({ url: `/api/me/photo?v=${photoUpdatedAt!.getTime()}`, showPublic: false });
    expect(JSON.stringify(rU.miAgenda)).not.toContain("users/");
  });
});

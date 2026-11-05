/**
 * CF3 (SD-S) · logo público de la sede digital `GET /<slug>/logo?v=` (D-CF3-9, D-CF3-10).
 *
 * Corre el route handler REAL (`app/(sede)/[slug]/logo/route.ts`) con `getClinicSite` real (snapshot de SD-K por el
 * canal service). Red mockeada: solo el admin client de Supabase Storage (`tests/helpers/storage-fake.ts`); `next/cache`
 * es el pass-through del setup. `@/lib/db` lleva el contador de sentencias (mismos clientes, solo un listener) para
 * fijar «slug inválido → 404 sin tocar la base». Se corre con los dos roles.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createEphemeralTenant, ownerClient, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { storageFake } from "@/tests/helpers/storage-fake";
import { jpeg, png, pngFile } from "@/tests/helpers/image-bytes";
import { __rateLimitInternals, rateLimit } from "@/lib/rate-limit";
import { PUBLIC_PHOTO_BYTES_RATE_LIMIT } from "@/lib/user-photo-logic";
import { measure } from "@/tests/helpers/query-counter";
import { asUser } from "@/tests/helpers/actor";
import { revalidatePathSpy, revalidateTagSpy } from "@/tests/helpers/integration-setup";

vi.mock("@/lib/supabase/admin", async () => {
  const { storageFake: fake } = await import("@/tests/helpers/storage-fake");
  return { getSupabaseAdminClient: () => fake.client() };
});
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

const RUN = process.env.INTEGRATION === "1";
const BUCKET = "practice-assets";

describe.skipIf(!RUN)("[CF3-SDS] logo público de la sede", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];
  const s = uniqueSuffix();
  let ON: EphemeralTenant;
  let OFF: EphemeralTenant;
  let NOLOGO: EphemeralTenant;
  const logoAt = new Date("2026-11-01T12:00:00.000Z");
  const route = () => import("@/app/(sede)/[slug]/logo/route");
  const get = async (slug: string, v?: string) =>
    (await route()).GET(new Request(`http://localhost/${slug}/logo${v === undefined ? "" : `?v=${v}`}`), {
      params: { slug },
    });

  async function site(enabled: boolean, logo: { bytes: Uint8Array; mime: string } | null) {
    const t = await createEphemeralTenant(db);
    tenants.push(t);
    const key = `${t.tenantId}/logo/${uniqueSuffix()}.${logo?.mime === "image/jpeg" ? "jpg" : "png"}`;
    await db.tenant.update({
      where: { id: t.tenantId },
      data: {
        siteEnabled: enabled,
        siteEnabledAt: enabled ? new Date() : null,
        ...(logo ? { logoStorageKey: key, logoUpdatedAt: logoAt } : {}),
      },
    });
    if (logo) storageFake.put(BUCKET, key, logo.bytes, logo.mime);
    return { t, key };
  }

  beforeAll(async () => {
    if (!RUN) return;
    db = ownerClient();
    storageFake.reset();
    ON = (await site(true, { bytes: png(40, 20), mime: "image/png" })).t;
    OFF = (await site(false, { bytes: png(40, 20), mime: "image/png" })).t;
    NOLOGO = (await site(true, null)).t;
  });

  afterAll(async () => {
    for (const t of tenants) await t.cleanup();
    await db?.$disconnect();
    storageFake.reset();
  });

  afterEach(() => {
    storageFake.calls = [];
  });

  // CF3 ZF5 (M): `s-maxage` igual al `max-age`. Sin él el CDN de Vercel no guarda la respuesta de una función y cada
  // visita a la sede bajaba el objeto de Storage (el `max-age` solo lo respeta el navegador).
  it("[CF3-SDS1][CF3-ZF5-1a] sede prendida con logo y ?v vigente → 200, Content-Type real, cache public immutable con s-maxage", async () => {
    const res = await get(ON.slug, String(logoAt.getTime()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, s-maxage=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(png(40, 20));
  });

  // CF3 ZF2 (M3): antes un `?v` al azar servía los bytes con cache corto, así que cada `?v=<random>` era un MISS de CDN
  // que bajaba el objeto de Storage (amplificador de egress/latencia gratis para cualquiera). Ahora → 308 a la URL
  // vigente sin tocar Storage; la vigente sí se cachea un año.
  it("[CF3-ZF2-1] sin ?v, con uno viejo o al azar → 308 a ?v=<vigente> sin bajar nada de Storage", async () => {
    const vigente = String(logoAt.getTime());
    // CF3b PH-S: `${vigente}&x=1` = la vigente con un parámetro de más (otra clave de CDN): también 308.
    for (const v of [undefined, "123", "", "zzz", `${vigente}0`, `${vigente}&x=1`]) {
      storageFake.calls = [];
      const res = await get(ON.slug, v);
      expect(res.status, String(v)).toBe(308);
      const loc = new URL(res.headers.get("location")!, "http://localhost");
      expect(loc.pathname).toBe(`/${ON.slug}/logo`);
      expect([...loc.searchParams.entries()]).toEqual([["v", vigente]]);
      // CF3 ZF5: el 308 también lo absorbe el CDN (5 min), no solo el navegador.
      expect(res.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=300");
      expect(storageFake.calls.filter((c) => c.op === "download"), String(v)).toEqual([]);
    }
    // Control: la vigente sí baja (si no, el `[]` de arriba no probaría nada).
    storageFake.calls = [];
    expect((await get(ON.slug, vigente)).status).toBe(200);
    expect(storageFake.calls.filter((c) => c.op === "download")).toHaveLength(1);
  });

  it("[CF3-SDS3] sede apagada y turnero cerrado → 404 sin bajar nada de Storage", async () => {
    // CF3b PH-S (opción (b)): con el turnero abierto la ruta sirve igual (ver [PH-S-L1]); acá se cierran los dos.
    await db.tenant.update({ where: { id: OFF.tenantId }, data: { publicBookingEnabled: false } });
    const res = await get(OFF.slug, String(logoAt.getTime()));
    expect(res.status).toBe(404);
    expect(storageFake.calls.filter((c) => c.op === "download")).toEqual([]);
    await db.tenant.update({ where: { id: OFF.tenantId }, data: { publicBookingEnabled: true } });
  });

  it("[PH-S-L1] sede apagada con el turnero abierto → 200 (la marca sale en el turnero), 308 por v y la URL = PublicClinic.logoUrl", async () => {
    const { getPublicClinic } = await import("@/lib/public-booking");
    const vigente = String(logoAt.getTime());
    const clinic = await getPublicClinic(OFF.slug);
    expect(clinic?.logoUrl).toBe(`/${OFF.slug}/logo?v=${vigente}`);
    const res = await get(OFF.slug, vigente);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, s-maxage=31536000, immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png(40, 20));
    storageFake.calls = [];
    const old = await get(OFF.slug, "123");
    expect(old.status).toBe(308);
    expect(new URL(old.headers.get("location")!).search).toBe(`?v=${vigente}`);
    expect(storageFake.calls.filter((c) => c.op === "download")).toEqual([]);
    // Suspendido: cierra el turnero → el mismo 404, y `getPublicClinic` ni responde.
    await db.tenant.update({ where: { id: OFF.tenantId }, data: { status: "SUSPENDED", statusChangedAt: new Date() } });
    expect((await get(OFF.slug, vigente)).status).toBe(404);
    expect(await getPublicClinic(OFF.slug)).toBeNull();
    await db.tenant.update({ where: { id: OFF.tenantId }, data: { status: "ACTIVE", statusChangedAt: null } });
  });

  it("[CF3-SDS4][CF3-ZF5-1b] sede prendida sin logo → 404 que el CDN también guarda un minuto", async () => {
    const res = await get(NOLOGO.slug);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    // Slug con forma inválida: el mismo 404 cacheable.
    expect((await get("..")).headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
  });

  // CF3 ZF5 (M): rate limit por IP SOLO en el camino que baja bytes (`?v` vigente), como la foto pública
  // (`PUBLIC_PHOTO_BYTES_RATE_LIMIT`). Con el `s-maxage` el CDN absorbe lo repetido; esto es el techo de un bucle sin
  // cache. El cupo se agota con el limitador real y la MISMA clave que usa la ruta (como `lockKey` en los tests de
  // carrera); recorrer la ruta 300 veces reconstruiría el snapshot de la sede en cada una (el cache es pass-through).
  it("[CF3-ZF5-1c] cupo de la IP agotado → 429 sin bajar de Storage; otra IP sigue; el 308 no gasta cupo", async () => {
    const vigente = String(logoAt.getTime());
    const IP = "203.0.113.77";
    const getFrom = async (ip: string, v?: string) =>
      (await route()).GET(
        new Request(`http://localhost/${ON.slug}/logo${v === undefined ? "" : `?v=${v}`}`, { headers: { "x-forwarded-for": ip } }),
        { params: { slug: ON.slug } }
      );
    __rateLimitInternals.reset();
    try {
      // Los 308 no tocan el limitador (no bajan nada).
      for (let i = 0; i < 3; i++) expect((await getFrom(IP, "123")).status).toBe(308);
      expect(__rateLimitInternals.size()).toBe(0);
      for (let i = 0; i < PUBLIC_PHOTO_BYTES_RATE_LIMIT.limit; i++) {
        await rateLimit(`site-logo:ip:${IP}`, PUBLIC_PHOTO_BYTES_RATE_LIMIT);
      }
      storageFake.calls = [];
      const limited = await getFrom(IP, vigente);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("cache-control")).toBe("no-store");
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(storageFake.calls.filter((c) => c.op === "download")).toEqual([]);
      const other = await getFrom("203.0.113.78", vigente);
      expect(other.status).toBe(200);
      expect(storageFake.calls.filter((c) => c.op === "download")).toHaveLength(1);
    } finally {
      __rateLimitInternals.reset();
    }
  });

  it("[CF3-SDS5] slug con forma inválida → 404 sin una sola sentencia a la base", async () => {
    for (const bad of ["..", "WP_ADMIN", "a b", "-x", `x${"a".repeat(90)}`]) {
      const { result, m } = await measure(() => get(bad));
      expect(result.status, bad).toBe(404);
      expect(m.statements, bad).toBe(0);
    }
    // Control del contador: un slug con forma válida sí consulta (si no, el 0 de arriba no probaría nada).
    expect((await measure(() => get(`no-existe-${s}`))).m.statements).toBeGreaterThan(0);
  });

  it("[CF3-SDS6] slug inexistente → 404", async () => {
    expect((await get(`no-existe-${s}`)).status).toBe(404);
  });

  it("[CF3-SDS7] JPEG → image/jpeg; un objeto reemplazado por otra cosa (SVG) → 404 sin cache", async () => {
    const j = await site(true, { bytes: jpeg(30, 30), mime: "image/jpeg" });
    const ok = await get(j.t.slug, String(logoAt.getTime()));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");

    storageFake.put(BUCKET, j.key, new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/png");
    const bad = await get(j.t.slug, String(logoAt.getTime()));
    expect(bad.status).toBe(404);
    expect(bad.headers.get("cache-control")).toBe("no-store");
  });

  it("[CF3-SDS8] consultorio suspendido con la sede prendida → 404 (el logo no queda colgado)", async () => {
    const susp = await site(true, { bytes: png(10, 10), mime: "image/png" });
    await db.tenant.update({ where: { id: susp.t.tenantId }, data: { status: "SUSPENDED", statusChangedAt: new Date() } });
    expect((await get(susp.t.slug, String(logoAt.getTime()))).status).toBe(404);
  });

  it("[CF3-SDS9] subir y borrar el logo invalida la sede (tag global:sites y /<slug>) después del commit", async () => {
    const { uploadTenantLogo, removeTenantLogo } = await import("@/lib/practice-assets");
    asUser(ON.userId);
    revalidateTagSpy.mockClear();
    revalidatePathSpy.mockClear();
    const fd = new FormData();
    // CF3 ZF5: PNG entero (con IEND): desde que el logo se limpia de metadatos, un PNG cortado se rechaza.
    fd.set("file", new File([new Uint8Array(pngFile(12, 12))], "logo.png", { type: "image/png" }));
    expect(await uploadTenantLogo(fd)).toMatchObject({ ok: true });
    expect(revalidateTagSpy.mock.calls.map((c) => c[0])).toContain("global:sites");
    expect(revalidatePathSpy.mock.calls.map((c) => c[0])).toContain(`/${ON.slug}`);

    revalidateTagSpy.mockClear();
    expect(await removeTenantLogo()).toMatchObject({ ok: true });
    expect(revalidateTagSpy.mock.calls.map((c) => c[0])).toContain("global:sites");
    // Sin logo, la ruta da 404 (también sin ?v: no redirige a una versión que ya no existe).
    expect((await get(ON.slug)).status).toBe(404);
  });

  it("[CF3-SDS9b] un rechazo (Secretaria sin tenant.sensitive) no invalida nada", async () => {
    const { addStaff } = await import("@/tests/helpers/tenant-factory");
    const sec = await addStaff(db, ON, "ASSISTANT", { grantSettings: true });
    const { uploadTenantLogo } = await import("@/lib/practice-assets");
    asUser(sec.userId);
    revalidateTagSpy.mockClear();
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array(png(12, 12))], "logo.png", { type: "image/png" }));
    expect(await uploadTenantLogo(fd)).toMatchObject({ ok: false });
    expect(revalidateTagSpy).not.toHaveBeenCalled();
  });

  // CF3 ZF5 (B): con el turnero abierto el logo es público (`/<slug>/logo`, CF3b PH-S), y un logo sacado con el
  // teléfono (la foto del cartel de la puerta) trae EXIF con el GPS. Se guarda limpio, como la foto del profesional:
  // sin APP1/EXIF ni chunks de texto, y cortado en el EOI/IEND (un polyglot no sobrevive).
  it("[CF3-ZF5-6] el logo se guarda SIN metadatos (EXIF/GPS, tEXt/eXIf) ni bytes después del final", async () => {
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
    const has = (hay: Uint8Array, needle: string) => Buffer.from(hay).includes(Buffer.from(needle));
    const GPS = "GPS-34.6037,-58.3816";
    const { uploadTenantLogo } = await import("@/lib/practice-assets");
    const { readImageInfo } = await import("@/lib/file-sniff");
    const up = async (bytes: Uint8Array, type: string) => {
      const fd = new FormData();
      fd.set("file", new File([new Uint8Array(bytes)], "logo", { type }));
      storageFake.calls = [];
      expect(await uploadTenantLogo(fd)).toMatchObject({ ok: true });
      const { logoStorageKey } = await db.tenant.findUniqueOrThrow({ where: { id: ON.tenantId }, select: { logoStorageKey: true } });
      return storageFake.get(BUCKET, logoStorageKey!)!.bytes;
    };
    asUser(ON.userId);

    // JPEG: SOI + APP1 «Exif» con el GPS + APP0 + SOF0 + EOI + un ZIP pegado atrás.
    const exifPayload = enc(`Exif\0\0${GPS}`);
    const app1 = cat(new Uint8Array([0xff, 0xe1, 0, exifPayload.length + 2]), exifPayload);
    const j = jpeg(40, 20);
    const dirtyJpeg = cat(j.subarray(0, 2), app1, j.subarray(2), enc("PK\x03\x04polyglot"));
    const storedJpeg = await up(dirtyJpeg, "image/jpeg");
    expect(has(storedJpeg, GPS)).toBe(false);
    expect(has(storedJpeg, "polyglot")).toBe(false);
    expect([...storedJpeg.subarray(-2)]).toEqual([0xff, 0xd9]);
    expect(readImageInfo(storedJpeg)).toMatchObject({ mime: "image/jpeg", width: 40, height: 20 });

    // PNG: tEXt y eXIf con el GPS + basura después del IEND.
    const dirtyPng = cat(pngFile(30, 10, [chunk("tEXt", enc(`Comment\0${GPS}`)), chunk("eXIf", enc(`MM\0*${GPS}`))]), enc("<html>polyglot"));
    const storedPng = await up(dirtyPng, "image/png");
    expect(has(storedPng, GPS)).toBe(false);
    expect(has(storedPng, "polyglot")).toBe(false);
    expect(has(storedPng, "IDAT")).toBe(true);
    expect(readImageInfo(storedPng)).toMatchObject({ mime: "image/png", width: 30, height: 10 });
    // El audit describe lo que se guardó (los bytes limpios), no lo que mandó el navegador.
    const ev = await db.auditEvent.findFirst({
      where: { tenantId: ON.tenantId, action: "tenant.logo.update" },
      orderBy: { createdAt: "desc" },
    });
    expect(ev?.payload).toMatchObject({ mime: "image/png", sizeBytes: storedPng.length, width: 30, height: 10 });

    // Un PNG cortado (sin IEND) no se puede limpiar: se rechaza sin subir nada.
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array(png(12, 12))], "logo.png", { type: "image/png" }));
    storageFake.calls = [];
    expect(await uploadTenantLogo(fd)).toMatchObject({ ok: false });
    expect(storageFake.calls.filter((c) => c.op === "upload")).toEqual([]);
  });
});

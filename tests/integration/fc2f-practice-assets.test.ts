/**
 * T4 FC-2f · logo del consultorio y firma de cada profesional (C-FC9; brief §24.4, Anexo C «FC-2f»).
 *
 * Red mockeada (C14): solo el admin client de Supabase (`tests/helpers/storage-fake.ts`). Corren de verdad las actions
 * de `lib/practice-assets.ts` con el `getActor()` real contra Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { addPractitioner, addStaff, createEphemeralTenant, ownerClient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { storageFake } from "@/tests/helpers/storage-fake";
import { jpeg, png, pngFile } from "@/tests/helpers/image-bytes";

vi.mock("@/lib/supabase/admin", async () => {
  const { storageFake: fake } = await import("@/tests/helpers/storage-fake");
  return { getSupabaseAdminClient: () => fake.client() };
});

const RUN = process.env.INTEGRATION === "1";
const BUCKET = "practice-assets";
const enc = (s: string) => new TextEncoder().encode(s);

function form(bytes: Uint8Array, type: string, name = "img"): FormData {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array(bytes)], name, { type }));
  return fd;
}

describe.skipIf(!RUN)("[FC-2f] logo y firma (practice-assets)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let pro: { userId: string; practitionerId: string };
  let secretaria: { userId: string };
  const assets = () => import("@/lib/practice-assets");

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    pro = await addPractitioner(db, A, "PRACTITIONER");
    secretaria = await addStaff(db, A, "ASSISTANT", { grantSettings: true });
  });

  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });

  afterEach(() => storageFake.reset());

  it("[FC-2f] logo PNG/JPEG ≤1 MB con magic bytes: sube, guarda la clave y audita", async () => {
    asUser(A.userId);
    const { uploadTenantLogo } = await assets();
    // CF3 ZF5: PNG entero (con IEND): el logo se limpia de metadatos (`stripImageMetadata`) y uno cortado se rechaza.
    const r = await uploadTenantLogo(form(pngFile(800, 200), "image/png", "logo.png"));
    expect(r).toMatchObject({ ok: true });
    const t = await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } });
    expect(t.logoStorageKey).toMatch(new RegExp(`^${A.tenantId}/logo/[0-9a-f]{24}\\.png$`));
    expect(t.logoUpdatedAt?.toISOString()).toBe((r as { data: { updatedAt: string } }).data.updatedAt);
    expect(storageFake.get(BUCKET, t.logoStorageKey!)?.contentType).toBe("image/png");
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "tenant.logo.update" } })).toBe(1);
  });

  it("[FC-2f] reemplazar el logo: el viejo se borra DESPUÉS del commit (la fila nunca apunta a un objeto borrado)", async () => {
    asUser(A.userId);
    const { uploadTenantLogo } = await assets();
    expect(await uploadTenantLogo(form(pngFile(10, 10), "image/png"))).toMatchObject({ ok: true });
    const first = (await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } })).logoStorageKey!;
    storageFake.calls = [];
    expect(await uploadTenantLogo(form(jpeg(20, 20), "image/jpeg"))).toMatchObject({ ok: true });
    const second = (await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } })).logoStorageKey!;
    expect(second).toMatch(/\.jpg$/);
    expect(second).not.toBe(first);
    expect(storageFake.calls.map((c) => c.op)).toEqual(["upload", "remove"]);
    expect(storageFake.calls[1].args).toEqual([[first]]);
    expect(storageFake.keys(BUCKET)).toEqual([second]);
  });

  it.each([
    ["WEBP", (() => { const b = new Uint8Array(40); b.set(enc("RIFF")); b.set(enc("WEBPVP8 "), 8); return b; })(), "image/webp", "Subí el logo en PNG o JPG (hasta 1 MB)."],
    ["SVG", enc('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/svg+xml", "Subí el logo en PNG o JPG (hasta 1 MB)."],
    ["SVG con type PNG", enc("<svg/>"), "image/png", "El archivo no es lo que dice ser."],
    ["JPEG con type PNG", jpeg(10, 10), "image/png", "El archivo no es lo que dice ser."],
    ["más de 3000 px", png(3001, 100), "image/png", "La imagen es demasiado grande (máximo 3000 × 3000 px)."],
    ["más de 1 MB", (() => { const b = new Uint8Array(1_048_577); b.set(png(10, 10)); return b; })(), "image/png", "Subí el logo en PNG o JPG (hasta 1 MB)."],
  ])("[FC-2f] logo %s → rechazo sin subir", async (_n, bytes, type, error) => {
    asUser(A.userId);
    const before = (await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } })).logoStorageKey;
    const { uploadTenantLogo } = await assets();
    expect(await uploadTenantLogo(form(bytes, type))).toEqual({ ok: false, error });
    expect(storageFake.calls).toEqual([]);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } })).logoStorageKey).toBe(before);
  });

  it("[FC-2f] logo: solo tenant.sensitive (un profesional sin «Configuración» y la Secretaria, no)", async () => {
    const { uploadTenantLogo, removeTenantLogo } = await assets();
    for (const u of [pro.userId, secretaria.userId]) {
      asUser(u);
      const r = await uploadTenantLogo(form(png(10, 10), "image/png"));
      expect(r).toMatchObject({ ok: false });
      expect(await removeTenantLogo()).toMatchObject({ ok: false });
    }
    expect(storageFake.calls).toEqual([]);
  });

  it("[FC-2f] firma: solo la propia; la del titular no cambia cuando sube el profesional", async () => {
    const { uploadOwnSignature } = await assets();
    asUser(pro.userId);
    expect(await uploadOwnSignature(form(png(600, 200), "image/png"))).toMatchObject({ ok: true });
    const mine = await db.practitioner.findUniqueOrThrow({ where: { id: pro.practitionerId } });
    expect(mine.signatureStorageKey).toMatch(new RegExp(`^${A.tenantId}/signature/${pro.practitionerId}/[0-9a-f]{24}\\.png$`));
    const owner = await db.practitioner.findUniqueOrThrow({ where: { id: A.practitionerId } });
    expect(owner.signatureStorageKey).toBeNull();
    // Un practitionerId en el form no cambia nada: el id sale del Actor.
    const fd = form(png(10, 10), "image/png");
    fd.set("practitionerId", A.practitionerId);
    expect(await uploadOwnSignature(fd)).toMatchObject({ ok: true });
    expect((await db.practitioner.findUniqueOrThrow({ where: { id: A.practitionerId } })).signatureStorageKey).toBeNull();
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "practitioner.signature.update", entityId: pro.practitionerId } })).toBe(2);
  });

  it("[FC-2f] firma: >512 KB o >2000 px → rechazo sin subir; la Secretaria (sin Practitioner clínico) no tiene firma", async () => {
    const { uploadOwnSignature } = await assets();
    asUser(pro.userId);
    const big = new Uint8Array(524_289);
    big.set(png(10, 10));
    expect(await uploadOwnSignature(form(big, "image/png"))).toEqual({
      ok: false,
      error: "La firma tiene que ser PNG o JPG (hasta 512 KB). Mejor en PNG con fondo transparente.",
    });
    expect(await uploadOwnSignature(form(png(2001, 10), "image/png"))).toEqual({
      ok: false,
      error: "La imagen es demasiado grande (máximo 2000 × 2000 px).",
    });
    asUser(secretaria.userId);
    expect(await uploadOwnSignature(form(png(10, 10), "image/png"))).toEqual({
      ok: false,
      error: "La firma es solo para profesionales que atienden en el consultorio.",
    });
    expect(storageFake.calls).toEqual([]);
  });

  it("[FC-2f] borrar la firma: limpia la fila y después el objeto", async () => {
    const { uploadOwnSignature, removeOwnSignature, getPracticeAssetPreviewUrl } = await assets();
    asUser(pro.userId);
    await uploadOwnSignature(form(png(10, 10), "image/png"));
    const key = (await db.practitioner.findUniqueOrThrow({ where: { id: pro.practitionerId } })).signatureStorageKey!;
    const prev = await getPracticeAssetPreviewUrl("signature");
    expect(prev).toMatchObject({ ok: true, data: { url: expect.stringContaining(encodeURIComponent(key)) } });
    expect(storageFake.calls.find((c) => c.op === "sign")?.args[1]).toBe(60);
    expect(await removeOwnSignature()).toEqual({ ok: true, data: undefined });
    const row = await db.practitioner.findUniqueOrThrow({ where: { id: pro.practitionerId } });
    expect(row.signatureStorageKey).toBeNull();
    expect(row.signatureUpdatedAt).toBeNull();
    expect(storageFake.get(BUCKET, key)).toBeUndefined();
    expect(await getPracticeAssetPreviewUrl("signature")).toEqual({ ok: true, data: { url: null } });
  });

  it("[FC-2f] honorífico y matrícula propios", async () => {
    const { updateOwnSignatureInfo } = await assets();
    asUser(pro.userId);
    expect(await updateOwnSignatureInfo({ honorific: "KLGA", licenseNumber: "  MN 1234 " })).toEqual({ ok: true, data: undefined });
    const row = await db.practitioner.findUniqueOrThrow({ where: { id: pro.practitionerId } });
    expect(row).toMatchObject({ honorific: "KLGA", licenseNumber: "MN 1234" });
    expect(await updateOwnSignatureInfo({ honorific: "XX" as never, licenseNumber: null })).toMatchObject({ ok: false });
    expect(await updateOwnSignatureInfo({ honorific: null, licenseNumber: "" })).toEqual({ ok: true, data: undefined });
    expect(await db.practitioner.findUniqueOrThrow({ where: { id: pro.practitionerId } })).toMatchObject({
      honorific: null,
      licenseNumber: null,
    });
    asUser(secretaria.userId);
    expect(await updateOwnSignatureInfo({ honorific: "LIC", licenseNumber: "1" })).toMatchObject({ ok: false });
  });

  it("[FC-2f] solo lectura (enforce): el logo se corta antes de Storage", async () => {
    const prev = process.env.TENANT_ACCESS_ENFORCEMENT;
    process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
    await db.tenant.update({ where: { id: A.tenantId }, data: { subscriptionStatus: "CANCELLED" } });
    try {
      asUser(A.userId);
      const { uploadTenantLogo } = await assets();
      expect(await uploadTenantLogo(form(png(10, 10), "image/png"))).toMatchObject({ ok: false });
      expect(storageFake.calls).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.TENANT_ACCESS_ENFORCEMENT;
      else process.env.TENANT_ACCESS_ENFORCEMENT = prev;
      await db.tenant.update({ where: { id: A.tenantId }, data: { subscriptionStatus: "ACTIVE" } });
    }
  });
});

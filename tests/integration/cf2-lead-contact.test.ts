/**
 * [CF2-TS1-L] CF2 (§29, D-CF2-10; brief T.B): `listPublicSlotWindow` devuelve `leadContact` (WhatsApp / llamar al
 * profesional) SOLO cuando hoy hay lugar libre dentro de la anticipación que el turnero no deja reservar.
 *
 * `listPublicSlotWindow` y `findFirstPublicSlot` REALES contra Postgres, canal de servicio (sin Actor), en los dos roles.
 * Se mockea solo el rate limit (para contar los hits por bucket y negar el del contacto) y los clientes de Prisma con el
 * contador de sentencias (0 sentencias nuevas: el contacto viaja en la lectura del profesional que ya corría).
 *
 * Reloj real a propósito (no fake timers: el reloj lo usan Prisma y el pool): franjas de 00:00 a 24:00 los 7 días y
 * anticipación de 10 h, así que a cualquier hora hay un hueco libre en [ahora + 30', ahora + 10 h).
 *
 * [CF2-ZF3-2] (fixer ZF3, ZA-2): el consentimiento tiene que ser de la versión vigente (`LEAD_CONTACT_CONSENT_VERSION`).
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

const rl = vi.hoisted(() => ({ keys: [] as string[], deny: new Set<string>() }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async (key: string) => {
    rl.keys.push(key);
    const prefix = key.split(":").slice(0, 2).join(":");
    return rl.deny.has(prefix) ? { ok: false, remaining: 0, retryAfterMs: 60_000 } : { ok: true, remaining: 99, retryAfterMs: 0 };
  },
}));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { findFirstPublicSlot, listPublicSlotWindow } from "@/lib/public-booking";
import { buildLeadContact, LEAD_CONTACT_CONSENT_VERSION } from "@/lib/public-lead-contact";
import { publicPractitionerName } from "@/lib/display-name";
import { addDays } from "@/lib/availability/day";
import { toARDateKey } from "@/lib/datetime-ar";
import { logger } from "@/lib/logger";
import { measure } from "@/tests/helpers/query-counter";
import {
  ownerClient,
  createEphemeralTenant,
  addService,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const E164 = "+5491161234567";
/** Sentencias de `listPublicSlotWindow` (rate limit mockeado) antes de T-S1, medidas con el contador. */
const WINDOW_STATEMENTS = 14;

describe.skipIf(!RUN)("[CF2-TS1-L] leadContact en la ventana del turnero", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let svc: string;
  let locationId: string;

  const leadHits = () => rl.keys.filter((k) => k.startsWith("pub:leadcontact:")).length;
  const win = (extra: { from?: string } = {}) =>
    listPublicSlotWindow({ tenantSlug: T.slug, practitionerId: T.practitionerId, serviceId: svc, ...extra });
  async function setContact(p: { show: boolean; lead?: number }) {
    await db.practitioner.update({
      where: { id: T.practitionerId },
      data: p.show
        ? {
            contactWhatsapp: E164,
            showContactInLeadWindow: true,
            contactConsentAt: new Date(),
            contactConsentVersion: LEAD_CONTACT_CONSENT_VERSION,
            publicMinLeadMinutes: p.lead ?? 600,
          }
        : { showContactInLeadWindow: false, contactWhatsapp: E164, publicMinLeadMinutes: p.lead ?? 600 },
    });
  }
  async function expected() {
    const [tenant, prac] = await Promise.all([
      db.tenant.findUniqueOrThrow({ where: { id: T.tenantId }, select: { name: true } }),
      db.practitioner.findUniqueOrThrow({ where: { id: T.practitionerId }, select: { user: { select: { fullName: true } } } }),
    ]);
    return buildLeadContact({ name: publicPractitionerName(prac.user.fullName), e164: E164, tenantName: tenant.name });
  }

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db);
    svc = await addService(db, T, { name: "Evaluación", durationMin: 30, priceCents: 0, maxConcurrent: 1 });
    locationId = (await db.location.create({ data: { tenantId: T.tenantId, name: "Centro", isPrimary: true } })).id;
    await db.practitionerSchedule.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({
        tenantId: T.tenantId,
        practitionerId: T.practitionerId,
        locationId,
        dow,
        startMin: 0,
        endMin: 1440,
      })),
    });
  });
  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    rl.keys.length = 0;
    rl.deny.clear();
    await setContact({ show: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it("[CF2-TS1-L1] hoy, opt-in con consentimiento y lugar dentro de la anticipación → leadContact (un hit de rate limit)", async () => {
    const w = await win();
    expect(w.leadContact).toEqual(await expected());
    expect(w.minLeadMinutes).toBe(600);
    expect(leadHits()).toBe(1);
  });

  it("[CF2-TS1-L2] la ventana de otro día (from = mañana) → sin la clave y sin gastar el rate limit", async () => {
    const w = await win({ from: addDays(toARDateKey(new Date()), 1) });
    expect("leadContact" in w).toBe(false);
    expect(leadHits()).toBe(0);
  });

  it("[CF2-TS1-L3] sin opt-in → sin la clave (aunque el número siga guardado)", async () => {
    await setContact({ show: false });
    const w = await win();
    expect("leadContact" in w).toBe(false);
    expect(leadHits()).toBe(0);
  });

  it("[CF2-ZF3-2] consentimiento de OTRA versión (vieja o futura) → sin la clave: hay que volver a aceptar el texto vigente", async () => {
    for (const version of ["cf2-lead-contact-v0", "cf2-lead-contact-v9"]) {
      await db.practitioner.update({ where: { id: T.practitionerId }, data: { contactConsentVersion: version } });
      const w = await win();
      expect("leadContact" in w, version).toBe(false);
    }
    expect(leadHits()).toBe(0);
  });

  it("[CF2-TS1-L4] anticipación ≤ 30' → sin la clave", async () => {
    await setContact({ show: true, lead: 30 });
    const w = await win();
    expect("leadContact" in w).toBe(false);
    expect(leadHits()).toBe(0);
  });

  it("[CF2-TS1-L5] sin lugar libre dentro de la anticipación → sin la clave", async () => {
    // Un turno largo del mismo servicio (cupo 1) que tapa de hace 1 h a dentro de 12 h: nada libre en [now+30', now+10 h).
    const b = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: T.practitionerId,
        serviceId: svc,
        locationId,
        scheduledFor: new Date(Date.now() - 60 * 60_000),
        durationMin: 13 * 60,
        status: "CONFIRMED",
        paymentStatus: "UNPAID",
        idempotencyKey: randomUUID(),
        guestName: "Ocupado",
      },
    });
    try {
      const w = await win();
      expect("leadContact" in w).toBe(false);
      expect(leadHits()).toBe(0);
    } finally {
      await db.booking.delete({ where: { id: b.id } });
    }
  });

  it("[CF2-TS1-L6] rate limit del contacto excedido → se omite en silencio; la ventana es la misma", async () => {
    const open = await win();
    rl.deny.add("pub:leadcontact");
    const w = await win();
    expect(leadHits()).toBe(2);
    expect("leadContact" in w).toBe(false);
    const { leadContact: _drop, ...rest } = open;
    void _drop;
    expect(w).toEqual(rest);
  });

  it("[CF2-TS1-L7] «cualquier profesional» nunca trae el contacto ni gasta su rate limit", async () => {
    const first = await findFirstPublicSlot({ tenantSlug: T.slug, serviceId: svc });
    expect(first).not.toBeNull();
    expect("leadContact" in (first as object)).toBe(false);
    expect(leadHits()).toBe(0);
  });

  it("[CF2-TS1-L8] sin contacto: las sentencias de siempre; con contacto: +1 (el nombre) y el número nunca va a un log", async () => {
    const logs: string[] = [];
    for (const lvl of ["info", "warn", "error"] as const) {
      vi.spyOn(logger, lvl).mockImplementation(((msg: string, ctx?: unknown) => {
        logs.push(`${msg} ${JSON.stringify(ctx ?? {})}`);
      }) as never);
    }
    const on = await measure(() => win());
    expect(on.result.leadContact).toBeDefined();
    await setContact({ show: false });
    const off = await measure(() => win());
    // 14 = lo que hacía la ventana ANTES de T-S1 (medido en este archivo con el código de la base). Las columnas del
    // contacto viajan en la lectura del profesional que ya corría; el nombre (relación → SELECT aparte en Prisma 5) se
    // lee solo cuando el contacto sale.
    expect(off.m.statements).toBe(WINDOW_STATEMENTS);
    expect(on.m.statements).toBe(WINDOW_STATEMENTS + 1);
    expect(logs.join("\n")).not.toContain(E164.slice(1));
  });
});

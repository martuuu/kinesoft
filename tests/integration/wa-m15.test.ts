/**
 * M15 `20261024120000_whatsapp_messaging` · bloque WA (T6), ola X0, sesión MIG (brief T6+T7 §26.5 y Anexo B).
 *
 * Qué se prueba (molde tpm-m18.test.ts; corre igual en `test:integration` y en `:owner`, los 2 roles):
 *   1. Objetos (catálogo, por el owner): 10 enums + los 2 valores nuevos de NotificationKind, las 5 tablas con
 *      tipo/nulabilidad/default, las columnas nuevas de Patient (6) y Booking (3), los 5 PARCIALES con su predicado,
 *      las FKs exactas (las compuestas por tenant son las ÚNICAS hacia la cuenta y el paciente), los CHECKs por nombre,
 *      RLS: Account/Template/Message/Inbound TENANT_READONLY (solo SELECT por tenant) y Credential SERVICE_ONLY.
 *   2. CHECKs con su SQLSTATE: credencial SIN formato de secret-box (token en claro) → 23514; ids de Meta numéricos;
 *      la cola sin cuerpo (hash del teléfono, clave idempotente con prefijo, estados coherentes); consentimiento
 *      anclado al número; respuesta del paciente siempre con `patientReplyFor`.
 *   3. Únicos parciales: una cuenta viva por consultorio y un número/WABA vivo en UN consultorio (el webhook rutea
 *      por phone_number_id); al desconectar se liberan.
 *   4. FKs compuestas cross-tenant → 23503 (credencial, plantilla, mensaje, entrante, paciente de otro consultorio).
 *   5. RLS con `kinesoft_app`: lee solo lo suyo, no escribe en ninguna TENANT_READONLY, la credencial es invisible
 *      con cualquier GUC.
 *   6. `deleteTenantDeep` con cuenta, credencial, plantillas, mensajes y entrantes.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { type Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealSecret, sealedKid } from "@/lib/secret-box";
import {
  asApp,
  attempt,
  columns,
  constraintDefs,
  enumLabels,
  inTx,
  partialIndexes,
  rlsState,
  TENANT_QUAL,
} from "@/tests/helpers/migration-sql";
import {
  addPatient,
  createEphemeralTenant,
  ownerClient,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const WA_TABLES = ["WhatsAppAccount", "WhatsAppCredential", "WhatsAppTemplate", "WhatsAppMessage", "WhatsAppInbound"];
const READONLY = ["WhatsAppAccount", "WhatsAppInbound", "WhatsAppMessage", "WhatsAppTemplate"];
type Db = Prisma.TransactionClient | PrismaClient;

let numSeq = 0;
/** Id numérico de Meta único por corrida (5..25 dígitos). */
const metaId = () => `${Date.now()}${String(++numSeq).padStart(4, "0")}`;
const hex64 = () => randomBytes(32).toString("hex");
/** Sobre con el formato de lib/secret-box.ts (`v1.<kid>.<iv 12 B>.<ct>.<tag 16 B>`), sin abrir. */
const fakeBox = (kid: string) =>
  ["v1", kid, randomBytes(12).toString("base64url"), randomBytes(24).toString("base64url"), randomBytes(16).toString("base64url")].join(".");

type AccountStatus = "SETUP" | "ACTIVE" | "REAUTH_REQUIRED" | "DISCONNECTED";
type AccountOpts = {
  status?: AccountStatus;
  setupStep?: "TOKEN" | "SUBSCRIBED" | "REGISTERED" | "TEMPLATES" | "DONE";
  mode?: string;
  wabaId?: string;
  phoneNumberId?: string;
  businessId?: string | null;
  lastErrorCode?: string | null;
  displayPhone?: string | null;
};
async function account(db: Db, tenantId: string, o: AccountOpts = {}): Promise<string> {
  const id = `wam-acc-${uniqueSuffix()}`;
  const status = o.status ?? "ACTIVE";
  const step = o.setupStep ?? (status === "ACTIVE" ? "DONE" : "TOKEN");
  await db.$executeRaw`
    INSERT INTO "WhatsAppAccount" (id, "tenantId", mode, "wabaId", "phoneNumberId", "businessId", "displayPhone", status,
      "setupStep", "lastErrorCode", "connectedByUserId", "connectedAt", "reauthRequiredAt", "disconnectedAt", "updatedAt")
    VALUES (${id}, ${tenantId}, ${o.mode ?? "fake"}, ${o.wabaId ?? metaId()}, ${o.phoneNumberId ?? metaId()},
      ${o.businessId ?? null}, ${o.displayPhone ?? null}, ${status}::"WhatsAppAccountStatus",
      ${step}::"WhatsAppSetupStep", ${o.lastErrorCode ?? null}, 'test-user', now(),
      CASE WHEN ${status} = 'REAUTH_REQUIRED' THEN now() END, CASE WHEN ${status} = 'DISCONNECTED' THEN now() END, now())`;
  return id;
}

async function credential(db: Db, tenantId: string, accountId: string, o: { token?: string; pin?: string; keyId?: string } = {}) {
  const id = `wam-cred-${uniqueSuffix()}`;
  const keyId = o.keyId ?? "k1";
  await db.$executeRaw`
    INSERT INTO "WhatsAppCredential" (id, "tenantId", "accountId", "tokenBox", "pinBox", "keyId", "updatedAt")
    VALUES (${id}, ${tenantId}, ${accountId}, ${o.token ?? fakeBox(keyId)}, ${o.pin ?? fakeBox(keyId)}, ${keyId}, now())`;
  return id;
}

async function template(db: Db, tenantId: string, accountId: string, o: { key?: string; name?: string; language?: string } = {}) {
  const id = `wam-tpl-${uniqueSuffix()}`;
  await db.$executeRaw`
    INSERT INTO "WhatsAppTemplate" (id, "tenantId", "accountId", key, name, language, "specVersion", "updatedAt")
    VALUES (${id}, ${tenantId}, ${accountId}, ${o.key ?? "BOOKING_REMINDER"}::"WhatsAppTemplateKey",
      ${o.name ?? "cs_recordatorio_turno_v1"}, ${o.language ?? "es_AR"}, 1, now())`;
  return id;
}

type MessageOpts = {
  kind?: string;
  status?: string;
  idempotencyKey?: string;
  patientId?: string | null;
  bookingId?: string | null;
  scheduled?: boolean;
  documentId?: string | null;
  seriesCount?: number | null;
  templateName?: string | null;
  toHash?: string;
  toMasked?: string;
  wamid?: string | null;
  errorCode?: string | null;
  failed?: boolean;
  skipReason?: string | null;
  attempts?: number;
};
async function message(db: Db, tenantId: string, accountId: string, o: MessageOpts = {}): Promise<string> {
  const id = `wam-msg-${uniqueSuffix()}`;
  const kind = o.kind ?? "BOOKING_CREATED";
  await db.$executeRaw`
    INSERT INTO "WhatsAppMessage" (id, "tenantId", "accountId", kind, trigger, status, "idempotencyKey", "patientId",
      "bookingId", "bookingScheduledFor", "documentId", "seriesCount", "templateName", "toHash", "toMasked", attempts,
      "expiresAt", wamid, "errorCode", "skipReason", "failedAt", "updatedAt")
    VALUES (${id}, ${tenantId}, ${accountId}, ${kind}::"WhatsAppMessageKind", 'AUTO', ${o.status ?? "QUEUED"}::"WhatsAppMessageStatus",
      ${o.idempotencyKey ?? `bc:${randomUUID()}`}, ${o.patientId ?? null}, ${o.bookingId ?? null},
      CASE WHEN ${o.scheduled ?? true} THEN now() + interval '2 days' END, ${o.documentId ?? null},
      ${o.seriesCount ?? null}::int, ${o.templateName !== undefined ? o.templateName : kind === "REPLY" ? null : "cs_turno_agendado_v1"},
      ${o.toHash ?? hex64()}, ${o.toMasked ?? "+54 9 11 ****-1234"}, ${o.attempts ?? 0}::int, now() + interval '1 day',
      ${o.wamid ?? null}, ${o.errorCode ?? null}, ${o.skipReason ?? null}, CASE WHEN ${o.failed ?? false} THEN now() END, now())`;
  return id;
}

async function inbound(db: Db, tenantId: string, accountId: string, o: { messageId?: string | null; fromHash?: string; outcome?: string } = {}) {
  const id = `wam-in-${uniqueSuffix()}`;
  await db.$executeRaw`
    INSERT INTO "WhatsAppInbound" (id, "tenantId", "accountId", wamid, kind, "fromHash", "messageId", outcome, "receivedAt")
    VALUES (${id}, ${tenantId}, ${accountId}, ${`wamid.${randomUUID()}`}, 'CONFIRM', ${o.fromHash ?? hex64()},
      ${o.messageId ?? null}, ${o.outcome ?? "confirmed"}, now())`;
  return id;
}

async function addBooking(db: Db, t: EphemeralTenant, patientId: string) {
  const b = await db.booking.create({
    data: {
      tenantId: t.tenantId,
      patientId,
      practitionerId: t.practitionerId,
      serviceId: t.serviceId,
      scheduledFor: new Date(Date.now() + 3 * 86_400_000),
      durationMin: 45,
      idempotencyKey: `wam-${randomUUID()}`,
    },
    select: { id: true },
  });
  return b.id;
}

// ═════════════════════════════════════════════════════════════════════
// 1. Objetos
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M15 whatsapp_messaging · objetos", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("[WA-M] 10 enums nuevos y los 2 valores nuevos de NotificationKind (al final, sin tocar los previos)", async () => {
    expect(
      await enumLabels(db, [
        "WhatsAppAccountStatus",
        "WhatsAppSetupStep",
        "WhatsAppTemplateKey",
        "WhatsAppTemplateStatus",
        "WhatsAppMessageKind",
        "WhatsAppMessageTrigger",
        "WhatsAppMessageStatus",
        "WhatsAppInboundKind",
        "WhatsAppConsentStatus",
        "WhatsAppConsentSource",
        "NotificationKind",
      ])
    ).toEqual({
      WhatsAppAccountStatus: ["SETUP", "ACTIVE", "REAUTH_REQUIRED", "DISCONNECTED"],
      WhatsAppSetupStep: ["TOKEN", "SUBSCRIBED", "REGISTERED", "TEMPLATES", "DONE"],
      WhatsAppTemplateKey: ["BOOKING_CREATED", "BOOKING_MOVED", "BOOKINGS_UPDATED", "BOOKING_REMINDER", "DOCUMENT_SHARED"],
      WhatsAppTemplateStatus: ["NOT_SUBMITTED", "PENDING", "APPROVED", "REJECTED", "PAUSED", "DISABLED"],
      WhatsAppMessageKind: ["BOOKING_CREATED", "BOOKING_MOVED", "BOOKINGS_UPDATED", "BOOKING_REMINDER", "DOCUMENT_SHARED", "TEST", "REPLY"],
      WhatsAppMessageTrigger: ["AUTO", "CRON", "MANUAL", "INBOUND"],
      WhatsAppMessageStatus: ["QUEUED", "SENDING", "SENT", "DELIVERED", "READ", "FAILED", "SKIPPED", "CANCELLED", "EXPIRED"],
      WhatsAppInboundKind: ["CONFIRM", "CANCEL_REQUEST", "OPT_OUT", "OPT_IN", "TEXT", "OTHER"],
      WhatsAppConsentStatus: ["GRANTED", "REVOKED"],
      WhatsAppConsentSource: ["STAFF", "TURNERO", "PORTAL", "WHATSAPP"],
      NotificationKind: [
        "BOOKING_CREATED",
        "BOOKING_CANCELLED",
        "PAYMENT_RECEIVED",
        "PROGRAM_NEARING_DISCHARGE",
        "PATIENT_NEW",
        // Orden REAL de la base: PATIENT_SHARED se agregó con ADD VALUE después de SYSTEM (el schema lo lista antes).
        "SYSTEM",
        "PATIENT_SHARED",
        "BOOKING_PATIENT_REPLY",
        "WHATSAPP_ACCOUNT",
      ],
    });
  });

  it("[WA-M] columnas de las 5 tablas y las nuevas de Patient (6) y Booking (3), todas NULL sin DEFAULT", async () => {
    expect(await columns(db, "WhatsAppAccount")).toEqual({
      id: "text NO",
      tenantId: "text NO",
      mode: "text NO",
      wabaId: "text NO",
      phoneNumberId: "text NO",
      businessId: "text YES",
      displayPhone: "text YES",
      verifiedName: "text YES",
      nameStatus: "text YES",
      qualityRating: "text YES",
      messagingLimit: "text YES",
      status: `WhatsAppAccountStatus NO 'SETUP'::"WhatsAppAccountStatus"`,
      setupStep: `WhatsAppSetupStep NO 'TOKEN'::"WhatsAppSetupStep"`,
      autoBookingNotice: "bool NO true",
      autoReminder: "bool NO true",
      autoReplyText: "bool NO true",
      paymentIssueAt: "timestamp YES",
      lastErrorCode: "text YES",
      lastErrorAt: "timestamp YES",
      lastWebhookAt: "timestamp YES",
      connectedByUserId: "text NO",
      connectedAt: "timestamp NO",
      reauthRequiredAt: "timestamp YES",
      disconnectedAt: "timestamp YES",
      disconnectedByUserId: "text YES",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
      updatedAt: "timestamp NO",
    });
    expect(await columns(db, "WhatsAppCredential")).toEqual({
      id: "text NO",
      tenantId: "text NO",
      accountId: "text NO",
      tokenBox: "text NO",
      pinBox: "text NO",
      keyId: "text NO",
      tokenExpiresAt: "timestamp YES",
      version: "int4 NO 1",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
      updatedAt: "timestamp NO",
    });
    expect(await columns(db, "WhatsAppTemplate")).toEqual({
      id: "text NO",
      tenantId: "text NO",
      accountId: "text NO",
      key: "WhatsAppTemplateKey NO",
      name: "text NO",
      language: "text NO 'es_AR'::text",
      specVersion: "int4 NO",
      metaTemplateId: "text YES",
      status: `WhatsAppTemplateStatus NO 'NOT_SUBMITTED'::"WhatsAppTemplateStatus"`,
      rejectedReason: "text YES",
      submittedAt: "timestamp YES",
      statusAt: "timestamp YES",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
      updatedAt: "timestamp NO",
    });
    // Sin cuerpo: ni texto, ni teléfono en claro (hash + máscara).
    expect(await columns(db, "WhatsAppMessage")).toEqual({
      id: "text NO",
      tenantId: "text NO",
      accountId: "text NO",
      kind: "WhatsAppMessageKind NO",
      trigger: "WhatsAppMessageTrigger NO",
      status: `WhatsAppMessageStatus NO 'QUEUED'::"WhatsAppMessageStatus"`,
      idempotencyKey: "text NO",
      patientId: "text YES",
      bookingId: "text YES",
      bookingScheduledFor: "timestamp YES",
      documentId: "text YES",
      seriesCount: "int4 YES",
      templateName: "text YES",
      toHash: "text NO",
      toMasked: "text NO",
      attempts: "int4 NO 0",
      nextAttemptAt: "timestamp YES",
      lockedUntil: "timestamp YES",
      expiresAt: "timestamp NO",
      wamid: "text YES",
      errorCode: "text YES",
      skipReason: "text YES",
      createdByUserId: "text YES",
      sentAt: "timestamp YES",
      deliveredAt: "timestamp YES",
      readAt: "timestamp YES",
      failedAt: "timestamp YES",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
      updatedAt: "timestamp NO",
    });
    expect(await columns(db, "WhatsAppInbound")).toEqual({
      id: "text NO",
      tenantId: "text NO",
      accountId: "text NO",
      wamid: "text NO",
      kind: "WhatsAppInboundKind NO",
      fromHash: "text NO",
      contextWamid: "text YES",
      messageId: "text YES",
      bookingId: "text YES",
      outcome: "text NO",
      receivedAt: "timestamp NO",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
    });
    expect(
      await columns(db, "Patient", ["waConsent", "waConsentAt", "waConsentSource", "waConsentByUserId", "waConsentVersion", "waPhoneE164"])
    ).toEqual({
      waConsent: "WhatsAppConsentStatus YES",
      waConsentAt: "timestamp YES",
      waConsentSource: "WhatsAppConsentSource YES",
      waConsentByUserId: "text YES",
      waConsentVersion: "text YES",
      waPhoneE164: "text YES",
    });
    expect(await columns(db, "Booking", ["patientConfirmedAt", "patientCancelRequestedAt", "patientReplyFor"])).toEqual({
      patientConfirmedAt: "timestamp YES",
      patientCancelRequestedAt: "timestamp YES",
      patientReplyFor: "timestamp YES",
    });
  });

  it("[WA-M] parciales con su predicado, únicos, FKs exactas y CHECKs por nombre (catálogo)", async () => {
    expect(await partialIndexes(db, [...WA_TABLES, "Patient"])).toEqual({
      Patient_tenantId_waPhoneE164_idx: `("tenantId", "waPhoneE164") WHERE ("waPhoneE164" IS NOT NULL)`,
      WhatsAppAccount_phone_live_key: `("phoneNumberId") WHERE (status <> 'DISCONNECTED'::"WhatsAppAccountStatus")`,
      WhatsAppAccount_tenant_live_key: `("tenantId") WHERE (status <> 'DISCONNECTED'::"WhatsAppAccountStatus")`,
      WhatsAppAccount_waba_live_key: `("wabaId") WHERE (status <> 'DISCONNECTED'::"WhatsAppAccountStatus")`,
      WhatsAppMessage_due_idx: `("nextAttemptAt") WHERE (status = ANY (ARRAY['QUEUED'::"WhatsAppMessageStatus", 'SENDING'::"WhatsAppMessageStatus"]))`,
    });
    const idx = await db.$queryRaw<{ indexname: string; u: boolean }[]>`
      SELECT indexname, indexdef LIKE 'CREATE UNIQUE%' AS u FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ANY(${WA_TABLES}) AND indexdef NOT LIKE '% WHERE %' ORDER BY indexname`;
    expect(idx.map((i) => `${i.u ? "U" : "-"} ${i.indexname}`)).toEqual([
      "U WhatsAppAccount_id_tenantId_key",
      "U WhatsAppAccount_pkey",
      "- WhatsAppAccount_tenantId_status_idx",
      "U WhatsAppCredential_accountId_key",
      "U WhatsAppCredential_pkey",
      "- WhatsAppCredential_tenantId_idx",
      "- WhatsAppInbound_accountId_idx",
      "- WhatsAppInbound_messageId_idx",
      "U WhatsAppInbound_pkey",
      "- WhatsAppInbound_tenantId_bookingId_receivedAt_idx",
      "- WhatsAppInbound_tenantId_createdAt_idx",
      "U WhatsAppInbound_wamid_key",
      "- WhatsAppMessage_accountId_createdAt_idx",
      "- WhatsAppMessage_bookingId_idx",
      "- WhatsAppMessage_patientId_idx",
      "U WhatsAppMessage_pkey",
      "- WhatsAppMessage_tenantId_bookingId_createdAt_idx",
      "- WhatsAppMessage_tenantId_createdAt_idx",
      "U WhatsAppMessage_tenantId_idempotencyKey_key",
      "U WhatsAppMessage_wamid_key",
      "U WhatsAppTemplate_accountId_key_key",
      "U WhatsAppTemplate_pkey",
      "- WhatsAppTemplate_tenantId_idx",
    ]);

    expect(await constraintDefs(db, WA_TABLES, "f")).toEqual({
      WhatsAppAccount_tenantId_fkey: `FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE RESTRICT`,
      WhatsAppCredential_account_tenant_fkey: `FOREIGN KEY ("accountId", "tenantId") REFERENCES "WhatsAppAccount"(id, "tenantId") ON DELETE CASCADE`,
      WhatsAppCredential_tenantId_fkey: `FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE RESTRICT`,
      WhatsAppInbound_account_tenant_fkey: `FOREIGN KEY ("accountId", "tenantId") REFERENCES "WhatsAppAccount"(id, "tenantId") ON DELETE RESTRICT`,
      WhatsAppInbound_messageId_fkey: `FOREIGN KEY ("messageId") REFERENCES "WhatsAppMessage"(id) ON DELETE SET NULL`,
      WhatsAppInbound_tenantId_fkey: `FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE RESTRICT`,
      WhatsAppMessage_account_tenant_fkey: `FOREIGN KEY ("accountId", "tenantId") REFERENCES "WhatsAppAccount"(id, "tenantId") ON DELETE RESTRICT`,
      WhatsAppMessage_bookingId_fkey: `FOREIGN KEY ("bookingId") REFERENCES "Booking"(id) ON DELETE SET NULL`,
      WhatsAppMessage_patient_tenant_fkey: `FOREIGN KEY ("patientId", "tenantId") REFERENCES "Patient"(id, "tenantId") ON DELETE RESTRICT`,
      WhatsAppMessage_tenantId_fkey: `FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE RESTRICT`,
      WhatsAppTemplate_account_tenant_fkey: `FOREIGN KEY ("accountId", "tenantId") REFERENCES "WhatsAppAccount"(id, "tenantId") ON DELETE CASCADE`,
      WhatsAppTemplate_tenantId_fkey: `FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE RESTRICT`,
    });
    expect(Object.keys(await constraintDefs(db, WA_TABLES, "c"))).toEqual([
      "WhatsAppAccount_ids_check",
      "WhatsAppAccount_mode_check",
      "WhatsAppAccount_status_check",
      "WhatsAppAccount_text_check",
      "WhatsAppCredential_box_check",
      "WhatsAppInbound_check",
      "WhatsAppMessage_key_check",
      "WhatsAppMessage_refs_check",
      "WhatsAppMessage_state_check",
      "WhatsAppMessage_to_check",
      "WhatsAppTemplate_check",
    ]);
    const hot = await db.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conname IN ('Patient_wa_consent_check', 'Booking_patient_reply_check') ORDER BY conname`;
    expect(hot.map((c) => c.conname)).toEqual(["Booking_patient_reply_check", "Patient_wa_consent_check"]);
    // Sin triggers nuevos: la cola tiene un escritor único (outbox-internal), no un guard en la base.
    const [{ n }] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal
        AND tgrelid::regclass::text = ANY(${WA_TABLES.map((t) => `"${t}"`)})`;
    expect(n).toBe(0);
  });

  it("[WA-M] RLS: 4 TENANT_READONLY (una policy SELECT por tenant) y la credencial SERVICE_ONLY (cero policies)", async () => {
    const { rel, pol, grants } = await rlsState(db, WA_TABLES);
    expect(rel).toEqual([...WA_TABLES].sort().map((relname) => ({ relname, rls: true, force: true })));
    expect(pol).toEqual(
      READONLY.map((t) => ({ tablename: t, policyname: `${t}_tenant_read`, cmd: "SELECT", qual: TENANT_QUAL, with_check: null }))
    );
    expect(grants).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 2-5. Comportamiento (todo en txs con ROLLBACK)
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M15 whatsapp_messaging · comportamiento", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let pA: string;
  let pB: string;
  let bA: string;

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    pA = await addPatient(db, A);
    pB = await addPatient(db, B);
    bA = await addBooking(db, A, pA);
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db.$disconnect();
  });

  it("[WA-M] CHECKs de cuenta: modo, ids de Meta numéricos, textos de Meta con tope, estado coherente", async () => {
    await inTx(db, async (tx) => {
      const acc = (o: AccountOpts) => attempt(tx, () => account(tx, A.tenantId, o));
      expect((await acc({ mode: "prod" })).code).toBe("23514");
      expect((await acc({ mode: "off" })).code).toBe("23514"); // off = nunca hay cuenta
      expect((await acc({ wabaId: "abc123" })).code).toBe("23514");
      expect((await acc({ phoneNumberId: "1234" })).code).toBe("23514"); // < 5 dígitos
      expect((await acc({ businessId: "x".repeat(6) })).code).toBe("23514");
      expect((await acc({ lastErrorCode: "Token Inválido" })).code).toBe("23514");
      expect((await acc({ displayPhone: "9".repeat(33) })).code).toBe("23514");
      expect((await acc({ status: "ACTIVE", setupStep: "TEMPLATES" })).code).toBe("23514"); // ACTIVE sin terminar
      // REAUTH sin fecha / DISCONNECTED sin fecha / SETUP desconectada: SQL directo.
      const raw = (status: string, extra = "", vals = "") =>
        attempt(tx, () =>
          tx.$executeRawUnsafe(
            `INSERT INTO "WhatsAppAccount" (id, "tenantId", mode, "wabaId", "phoneNumberId", status, "connectedByUserId", "connectedAt", "updatedAt"${extra})
             VALUES ('wam-raw-' || md5(random()::text), $1, 'fake', $2, $3, '${status}', 'u', now(), now()${vals})`,
            A.tenantId,
            metaId(),
            metaId()
          )
        );
      expect((await raw("REAUTH_REQUIRED")).code).toBe("23514");
      expect((await raw("DISCONNECTED")).code).toBe("23514");
      expect((await raw("SETUP", `, "disconnectedAt"`, `, now()`)).code).toBe("23514");
      expect((await acc({ lastErrorCode: "graph_timeout:131026", businessId: metaId() })).code).toBe("OK");
    });
  });

  it("[WA-M] únicos parciales: una cuenta viva por consultorio, número y WABA vivos en un solo consultorio", async () => {
    await inTx(db, async (tx) => {
      const phone = metaId();
      const waba = metaId();
      const live = await account(tx, A.tenantId, { phoneNumberId: phone, wabaId: waba });
      expect((await attempt(tx, () => account(tx, A.tenantId, { status: "SETUP" }))).code).toBe("23505"); // 2.ª viva en A
      expect((await attempt(tx, () => account(tx, B.tenantId, { phoneNumberId: phone }))).code).toBe("23505"); // número de A
      expect((await attempt(tx, () => account(tx, B.tenantId, { wabaId: waba }))).code).toBe("23505"); // WABA de A
      // Desconectada (historial) libera las tres: A reconecta y B toma el número.
      await tx.$executeRaw`
        UPDATE "WhatsAppAccount" SET status = 'DISCONNECTED', "disconnectedAt" = now(), "disconnectedByUserId" = 'u' WHERE id = ${live}`;
      expect((await attempt(tx, () => account(tx, B.tenantId, { phoneNumberId: phone, wabaId: waba }))).code).toBe("OK");
      expect((await attempt(tx, () => account(tx, A.tenantId, {}))).code).toBe("OK");
      // El historial no choca: varias desconectadas conviven con la viva.
      expect((await attempt(tx, () => account(tx, A.tenantId, { status: "DISCONNECTED" }))).code).toBe("OK");
    });
  });

  it("[WA-M] credencial: solo sobres de secret-box con el MISMO kid que keyId; un token en claro → 23514", async () => {
    await inTx(db, async (tx) => {
      const acc = await account(tx, A.tenantId);
      const cred = (o: Parameters<typeof credential>[3]) => attempt(tx, () => credential(tx, A.tenantId, acc, o));
      expect((await cred({ token: "EAAGm0PX4ZCpsBAExampleTokenEnClaro" })).code).toBe("23514");
      expect((await cred({ pin: "123456" })).code).toBe("23514"); // PIN en claro
      expect((await cred({ token: fakeBox("k2") })).code).toBe("23514"); // kid ≠ keyId
      expect((await cred({ pin: fakeBox("k2") })).code).toBe("23514");
      expect((await cred({ token: fakeBox("k1").replace(/^v1/, "v2") })).code).toBe("23514");
      expect((await cred({ keyId: "K1" })).code).toBe("23514");
      const big = ["v1", "k1", randomBytes(12).toString("base64url"), "a".repeat(4096), randomBytes(16).toString("base64url")].join(".");
      expect((await cred({ token: big })).code).toBe("23514"); // > 4096
      // Un sobre REAL de lib/secret-box.ts (clave dev, propósito reservado "wa-credential") pasa el CHECK.
      const token = sealSecret("EAAG-token-de-prueba", { purpose: "wa-credential", recordId: acc, field: "token" });
      const pin = sealSecret("482913", { purpose: "wa-credential", recordId: acc, field: "pin" });
      expect((await cred({ token, pin, keyId: sealedKid(token)! })).code).toBe("OK");
      expect((await attempt(tx, () => tx.$executeRaw`UPDATE "WhatsAppCredential" SET version = 0 WHERE "accountId" = ${acc}`)).code).toBe("23514");
      // 1:1 con la cuenta.
      expect((await cred({})).code).toBe("23505");
    });
  });

  it("[WA-M] plantilla y entrante: nombre/idioma de Meta, una por clave; hash del remitente y outcome", async () => {
    await inTx(db, async (tx) => {
      const acc = await account(tx, A.tenantId);
      const tpl = (o: Parameters<typeof template>[3]) => attempt(tx, () => template(tx, A.tenantId, acc, o));
      expect((await tpl({ name: "Recordatorio Turno" })).code).toBe("23514");
      expect((await tpl({ language: "es-AR" })).code).toBe("23514");
      expect((await tpl({})).code).toBe("OK");
      expect((await tpl({ name: "cs_recordatorio_turno_v2" })).code).toBe("23505"); // misma clave en la cuenta
      expect((await tpl({ key: "BOOKING_CREATED", name: "cs_turno_agendado_v1", language: "es" })).code).toBe("OK");
      const inb = (o: Parameters<typeof inbound>[3]) => attempt(tx, () => inbound(tx, A.tenantId, acc, o));
      expect((await inb({ fromHash: "+5491100000000" })).code).toBe("23514"); // teléfono en claro
      expect((await inb({ outcome: "Confirmó!" })).code).toBe("23514");
      expect((await inb({})).code).toBe("OK");
    });
  });

  it("[WA-M] cola sin cuerpo: clave con prefijo, hash del teléfono, refs por tipo y estados coherentes", async () => {
    await inTx(db, async (tx) => {
      const acc = await account(tx, A.tenantId);
      const m = (o: MessageOpts) => attempt(tx, () => message(tx, A.tenantId, acc, { patientId: pA, bookingId: bA, ...o }));
      expect((await m({ idempotencyKey: "sin-prefijo" })).code).toBe("23514");
      expect((await m({ idempotencyKey: "BC:x" })).code).toBe("23514");
      expect((await m({ toHash: "+5491100000000" })).code).toBe("23514"); // teléfono en claro
      expect((await m({ toMasked: "123" })).code).toBe("23514");
      expect((await m({ patientId: null })).code).toBe("23514"); // aviso de turno sin paciente
      expect((await m({ scheduled: false })).code).toBe("23514"); // sin bookingScheduledFor
      expect((await m({ kind: "DOCUMENT_SHARED", idempotencyKey: `doc:${randomUUID()}` })).code).toBe("23514"); // sin documentId
      expect((await m({ kind: "BOOKINGS_UPDATED", seriesCount: 1 })).code).toBe("23514");
      expect((await m({ kind: "BOOKINGS_UPDATED", seriesCount: 501 })).code).toBe("23514");
      // Hallazgo MIG: `NULL BETWEEN 2 AND 500` es NULL y un CHECK NULL PASA; el SQL exige el conteo explícito.
      expect((await m({ kind: "BOOKINGS_UPDATED", seriesCount: null })).code).toBe("23514");
      expect((await m({ kind: "REPLY", templateName: "cs_turno_agendado_v1" })).code).toBe("23514");
      expect((await m({ kind: "TEST", templateName: null })).code).toBe("23514");
      expect((await m({ status: "SENT" })).code).toBe("23514"); // SENT sin wamid
      expect((await m({ status: "FAILED", failed: true })).code).toBe("23514"); // FAILED sin errorCode
      expect((await m({ status: "FAILED", errorCode: "meta:131026" })).code).toBe("23514"); // sin failedAt
      expect((await m({ status: "SKIPPED" })).code).toBe("23514"); // sin skipReason
      expect((await m({ errorCode: "Error de Meta" })).code).toBe("23514");
      expect((await m({ skipReason: "no-consent" })).code).toBe("23514");
      expect((await m({ attempts: 21 })).code).toBe("23514");
      // Válidos.
      expect((await m({})).code).toBe("OK");
      expect((await m({ status: "SENT", wamid: `wamid.${randomUUID()}` })).code).toBe("OK");
      expect((await m({ status: "FAILED", failed: true, errorCode: "meta:131026" })).code).toBe("OK");
      expect((await m({ status: "SKIPPED", skipReason: "no_consent" })).code).toBe("OK");
      expect((await m({ kind: "BOOKINGS_UPDATED", seriesCount: 8, idempotencyKey: `bs:serie:${Date.now()}` })).code).toBe("OK");
      expect((await m({ kind: "DOCUMENT_SHARED", documentId: "doc-1", bookingId: null, scheduled: false, idempotencyKey: `doc:doc-1:${randomUUID()}` })).code).toBe("OK");
      expect((await m({ kind: "TEST", patientId: null, bookingId: null, scheduled: false, templateName: "hello_world", idempotencyKey: `test:${randomUUID()}` })).code).toBe("OK");
      expect((await m({ kind: "REPLY", patientId: null, bookingId: null, scheduled: false, idempotencyKey: `reply:${randomUUID()}` })).code).toBe("OK");
      // Idempotencia por consultorio y wamid global.
      const key = `br:${bA}:${Date.now()}`;
      expect((await m({ idempotencyKey: key })).code).toBe("OK");
      expect((await m({ idempotencyKey: key })).code).toBe("23505");
    });
  });

  it("[WA-M] consentimiento anclado al número (Patient_wa_consent_check) y respuesta con patientReplyFor (Booking)", async () => {
    await inTx(db, async (tx) => {
      const set = (sql: string) => attempt(tx, () => tx.$executeRawUnsafe(`UPDATE "Patient" SET ${sql} WHERE id = $1`, pA));
      expect((await set(`"waPhoneE164" = '+5491155550000'`)).code).toBe("23514"); // número sin consentimiento
      expect((await set(`"waConsent" = 'GRANTED', "waConsentAt" = now(), "waConsentSource" = 'STAFF', "waConsentVersion" = 'wa-2026-10-v1'`)).code).toBe("23514"); // sin número
      expect((await set(`"waConsent" = 'GRANTED', "waConsentAt" = now(), "waConsentSource" = 'STAFF', "waPhoneE164" = '+5491155550000'`)).code).toBe("23514"); // sin versión
      expect((await set(`"waConsent" = 'GRANTED', "waConsentAt" = now(), "waConsentSource" = 'STAFF', "waConsentVersion" = 'WA 2026', "waPhoneE164" = '+5491155550000'`)).code).toBe("23514");
      expect((await set(`"waConsent" = 'GRANTED', "waConsentAt" = now(), "waConsentSource" = 'STAFF', "waConsentVersion" = 'wa-2026-10-v1', "waPhoneE164" = '011 5555-0000'`)).code).toBe("23514");
      expect((await set(`"waConsent" = 'GRANTED', "waConsentSource" = 'STAFF', "waConsentVersion" = 'wa-2026-10-v1', "waPhoneE164" = '+5491155550000'`)).code).toBe("23514"); // sin fecha
      expect((await set(`"waConsent" = 'REVOKED', "waConsentAt" = now()`)).code).toBe("23514"); // sin origen
      expect((await set(`"waConsent" = 'GRANTED', "waConsentAt" = now(), "waConsentSource" = 'STAFF', "waConsentByUserId" = 'u', "waConsentVersion" = 'wa-2026-10-v1', "waPhoneE164" = '+5491155550000'`)).code).toBe("OK");
      expect((await set(`"waConsent" = 'REVOKED', "waConsentSource" = 'WHATSAPP'`)).code).toBe("OK"); // BAJA conserva el número
      // Turno: la respuesta siempre dice a qué horario respondió (WA-D22).
      const b = (sql: string) => attempt(tx, () => tx.$executeRawUnsafe(`UPDATE "Booking" SET ${sql} WHERE id = $1`, bA));
      expect((await b(`"patientConfirmedAt" = now()`)).code).toBe("23514");
      expect((await b(`"patientCancelRequestedAt" = now()`)).code).toBe("23514");
      expect((await b(`"patientConfirmedAt" = now(), "patientReplyFor" = "scheduledFor"`)).code).toBe("OK");
    });
  });

  it("[WA-M] FKs compuestas cross-tenant → 23503 (credencial, plantilla, mensaje, entrante y paciente ajenos)", async () => {
    await inTx(db, async (tx) => {
      const accA = await account(tx, A.tenantId);
      const accB = await account(tx, B.tenantId);
      // Cuenta de A con el tenantId de B (el atacante conoce el id de la cuenta ajena).
      expect((await attempt(tx, () => credential(tx, B.tenantId, accA))).code).toBe("23503");
      expect((await attempt(tx, () => template(tx, B.tenantId, accA))).code).toBe("23503");
      expect((await attempt(tx, () => message(tx, B.tenantId, accA, { patientId: pB }))).code).toBe("23503");
      expect((await attempt(tx, () => inbound(tx, B.tenantId, accA))).code).toBe("23503");
      // Paciente de B en un mensaje de A: la FK compuesta (patientId, tenantId) es la ÚNICA hacia Patient.
      expect((await attempt(tx, () => message(tx, A.tenantId, accA, { patientId: pB }))).code).toBe("23503");
      expect((await attempt(tx, () => message(tx, B.tenantId, accB, { patientId: pB }))).code).toBe("OK");
      expect((await attempt(tx, () => message(tx, A.tenantId, accA, { patientId: pA, bookingId: bA }))).code).toBe("OK");
      // Mudar una plantilla al otro consultorio sin mudar la cuenta rompe la compuesta.
      const tpl = await template(tx, A.tenantId, accA);
      expect((await attempt(tx, () => tx.$executeRaw`UPDATE "WhatsAppTemplate" SET "tenantId" = ${B.tenantId} WHERE id = ${tpl}`)).code).toBe("23503");
    });
  });

  it("[WA-M] borrados: el turno borrado deja el rastro (SET NULL); la cuenta con mensajes no se borra; credencial/plantillas cascadean", async () => {
    await inTx(db, async (tx) => {
      const acc = await account(tx, A.tenantId);
      await credential(tx, A.tenantId, acc);
      await template(tx, A.tenantId, acc);
      const b = await addBooking(tx, A, pA);
      const msg = await message(tx, A.tenantId, acc, { patientId: pA, bookingId: b });
      const inb = await inbound(tx, A.tenantId, acc, { messageId: msg });
      await tx.$executeRaw`DELETE FROM "Booking" WHERE id = ${b}`;
      expect(await tx.$queryRaw`SELECT "bookingId" IS NULL AS gone, "bookingScheduledFor" IS NOT NULL AS kept FROM "WhatsAppMessage" WHERE id = ${msg}`).toEqual([
        { gone: true, kept: true },
      ]);
      // Paciente SIN turnos pero con historial de WhatsApp: RESTRICT por la FK compuesta (la única hacia Patient).
      const lone = (await tx.patient.create({ data: { tenantId: A.tenantId, firstName: "Solo", lastName: `WA ${uniqueSuffix()}` } })).id;
      const loneMsg = await message(tx, A.tenantId, acc, { patientId: lone });
      expect((await attempt(tx, () => tx.$executeRaw`DELETE FROM "Patient" WHERE id = ${lone}`)).code).toBe("23503");
      // La cuenta con mensajes/entrantes: RESTRICT (rastro). Sin ellos, credencial y plantillas cascadean.
      expect((await attempt(tx, () => tx.$executeRaw`DELETE FROM "WhatsAppAccount" WHERE id = ${acc}`)).code).toBe("23503");
      await tx.$executeRaw`DELETE FROM "WhatsAppMessage" WHERE id IN (${msg}, ${loneMsg})`;
      expect(await tx.$queryRaw`SELECT "messageId" FROM "WhatsAppInbound" WHERE id = ${inb}`).toEqual([{ messageId: null }]);
      await tx.$executeRaw`DELETE FROM "WhatsAppInbound" WHERE id = ${inb}`;
      await tx.$executeRaw`DELETE FROM "WhatsAppAccount" WHERE id = ${acc}`;
      const left = await tx.$queryRaw<{ n: number }[]>`
        SELECT (SELECT count(*) FROM "WhatsAppCredential" WHERE "accountId" = ${acc})::int
             + (SELECT count(*) FROM "WhatsAppTemplate" WHERE "accountId" = ${acc})::int AS n`;
      expect(left).toEqual([{ n: 0 }]);
    });
  });

  it("[WA-M] RLS con kinesoft_app: lee solo lo suyo; no escribe en ninguna TENANT_READONLY; la credencial es invisible", async () => {
    await inTx(db, async (tx) => {
      const accA = await account(tx, A.tenantId);
      const accB = await account(tx, B.tenantId);
      await credential(tx, A.tenantId, accA);
      await credential(tx, B.tenantId, accB);
      const tA = await template(tx, A.tenantId, accA);
      const tB = await template(tx, B.tenantId, accB);
      const mA = await message(tx, A.tenantId, accA, { patientId: pA, bookingId: bA });
      const mB = await message(tx, B.tenantId, accB, { patientId: pB });
      const iA = await inbound(tx, A.tenantId, accA, { messageId: mA });
      const iB = await inbound(tx, B.tenantId, accB, { messageId: mB });

      await asApp(tx, A.tenantId);
      const [{ u }] = await tx.$queryRaw<{ u: string }[]>`SELECT current_user AS u`;
      expect(u).toBe("kinesoft_app");
      const seen = await tx.$queryRaw<{ t: string; id: string }[]>`
        SELECT 'acc' AS t, id FROM "WhatsAppAccount" WHERE id IN (${accA}, ${accB})
        UNION ALL SELECT 'tpl', id FROM "WhatsAppTemplate" WHERE id IN (${tA}, ${tB})
        UNION ALL SELECT 'msg', id FROM "WhatsAppMessage" WHERE id IN (${mA}, ${mB})
        UNION ALL SELECT 'in', id FROM "WhatsAppInbound" WHERE id IN (${iA}, ${iB})
        UNION ALL SELECT 'cred', id FROM "WhatsAppCredential"
        ORDER BY 1`;
      expect(seen).toEqual([
        { t: "acc", id: accA },
        { t: "in", id: iA },
        { t: "msg", id: mA },
        { t: "tpl", id: tA },
      ]);
      // TENANT_READONLY: ni INSERT (42501), ni UPDATE/DELETE (0 filas), aun lo propio.
      expect((await attempt(tx, () => account(tx, A.tenantId, { status: "DISCONNECTED" }))).code).toBe("42501");
      expect((await attempt(tx, () => template(tx, A.tenantId, accA, { key: "BOOKING_MOVED", name: "cs_turno_reprogramado_v1" }))).code).toBe("42501");
      expect((await attempt(tx, () => message(tx, A.tenantId, accA, { patientId: pA }))).code).toBe("42501");
      expect((await attempt(tx, () => inbound(tx, A.tenantId, accA))).code).toBe("42501");
      expect(await tx.$executeRaw`UPDATE "WhatsAppAccount" SET "autoReminder" = false WHERE id = ${accA}`).toBe(0);
      expect(await tx.$executeRaw`UPDATE "WhatsAppTemplate" SET status = 'APPROVED' WHERE id = ${tA}`).toBe(0);
      expect(await tx.$executeRaw`UPDATE "WhatsAppMessage" SET status = 'CANCELLED' WHERE id = ${mA}`).toBe(0);
      expect(await tx.$executeRaw`DELETE FROM "WhatsAppInbound" WHERE id = ${iA}`).toBe(0);
      expect(await tx.$executeRaw`DELETE FROM "WhatsAppAccount" WHERE id = ${accA}`).toBe(0);
      expect(await tx.$queryRaw`SELECT id FROM "WhatsAppAccount" WHERE id = ${accA} FOR UPDATE`).toEqual([]);
      // SERVICE_ONLY: la credencial ni se ve ni se escribe con el GUC propio.
      expect((await attempt(tx, () => credential(tx, A.tenantId, accA))).code).toBe("42501");
      expect(await tx.$executeRaw`UPDATE "WhatsAppCredential" SET version = version + 1`).toBe(0);
      // Con el GUC de B: lo de B, nunca la credencial; sin GUC: nada.
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${B.tenantId}, true)`;
      expect(await tx.$queryRaw`SELECT count(*)::int AS n FROM "WhatsAppCredential"`).toEqual([{ n: 0 }]);
      expect(await tx.$queryRaw`SELECT id FROM "WhatsAppAccount" WHERE id IN (${accA}, ${accB})`).toEqual([{ id: accB }]);
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', '', true)`;
      const none = await tx.$queryRaw<{ n: number }[]>`
        SELECT (SELECT count(*) FROM "WhatsAppAccount" WHERE id IN (${accA}, ${accB}))::int
             + (SELECT count(*) FROM "WhatsAppTemplate" WHERE id IN (${tA}, ${tB}))::int
             + (SELECT count(*) FROM "WhatsAppMessage" WHERE id IN (${mA}, ${mB}))::int
             + (SELECT count(*) FROM "WhatsAppInbound" WHERE id IN (${iA}, ${iB}))::int
             + (SELECT count(*) FROM "WhatsAppCredential")::int AS n`;
      expect(none).toEqual([{ n: 0 }]);
    });
  });

  it("[WA-M] la app SÍ escribe el consentimiento y la respuesta en Patient/Booking (policy ALL de esas tablas)", async () => {
    await inTx(db, async (tx) => {
      await asApp(tx, A.tenantId);
      expect(
        await tx.$executeRaw`
          UPDATE "Patient" SET "waConsent" = 'GRANTED', "waConsentAt" = now(), "waConsentSource" = 'STAFF',
            "waConsentVersion" = 'wa-2026-10-v1', "waPhoneE164" = '+5491155550000' WHERE id = ${pA}`
      ).toBe(1);
      expect(await tx.$executeRaw`UPDATE "Patient" SET "waConsent" = 'REVOKED' WHERE id = ${pB}`).toBe(0);
      expect(await tx.$executeRaw`UPDATE "Booking" SET "patientConfirmedAt" = now(), "patientReplyFor" = "scheduledFor" WHERE id = ${bA}`).toBe(1);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════
// 6. deleteTenantDeep
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M15 whatsapp_messaging · deleteTenantDeep", () => {
  it("[WA-M] tenant-factory limpia un consultorio con cuenta, credencial, plantillas, mensajes y entrantes", async () => {
    const db = ownerClient();
    try {
      const D = await createEphemeralTenant(db);
      const p = await addPatient(db, D);
      const b = await addBooking(db, D, p);
      const old = await account(db, D.tenantId, { status: "DISCONNECTED" });
      const acc = await account(db, D.tenantId);
      await credential(db, D.tenantId, acc);
      await template(db, D.tenantId, acc);
      const m = await message(db, D.tenantId, acc, { patientId: p, bookingId: b });
      await message(db, D.tenantId, old, { patientId: p });
      await inbound(db, D.tenantId, acc, { messageId: m });
      await D.cleanup();
      const left = await db.$queryRaw<{ t: string; n: number }[]>`
        SELECT 'acc' AS t, count(*)::int AS n FROM "WhatsAppAccount" WHERE "tenantId" = ${D.tenantId}
        UNION ALL SELECT 'cred', count(*)::int FROM "WhatsAppCredential" WHERE "tenantId" = ${D.tenantId}
        UNION ALL SELECT 'tpl', count(*)::int FROM "WhatsAppTemplate" WHERE "tenantId" = ${D.tenantId}
        UNION ALL SELECT 'msg', count(*)::int FROM "WhatsAppMessage" WHERE "tenantId" = ${D.tenantId}
        UNION ALL SELECT 'in', count(*)::int FROM "WhatsAppInbound" WHERE "tenantId" = ${D.tenantId}
        UNION ALL SELECT 'patient', count(*)::int FROM "Patient" WHERE "tenantId" = ${D.tenantId}
        UNION ALL SELECT 'tenant', count(*)::int FROM "Tenant" WHERE id = ${D.tenantId}`;
      expect(Object.fromEntries(left.map((r) => [r.t, r.n]))).toEqual({ acc: 0, cred: 0, tpl: 0, msg: 0, in: 0, patient: 0, tenant: 0 });
    } finally {
      await db.$disconnect();
    }
  });
});

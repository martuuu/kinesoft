/**
 * Export completo del consultorio (BO5-C, plan §19.5; BO-D4): las queries y el stream.
 *
 * `server-only` y SIN `"use server"`: la ÚNICA puerta es `app/api/consultorio/export/route.ts` (OWNER, rate limit,
 * 403 a soporte). Como export de un archivo de actions sería un RPC que saltea todo eso (mismo hallazgo que
 * `exportPatientsCsv` en la revisión A2).
 *
 * Aislamiento (prod corre con BYPASSRLS: el `where` a mano es la ÚNICA barrera):
 *  - cada query lleva el `tenantId` explícito — directo (`where: { tenantId }`) o por la relación dueña cuando la
 *    tabla no tiene la columna (`Coverage` → `patient.tenantId`, `Session` → `program.tenantId`, `Payment` →
 *    `booking.tenantId`, `Diagnosis` → `case.tenantId`, `SessionExercise` → `session.program.tenantId`), que es
 *    la misma regla que las policies RLS de esas tablas (20260725120000_rls_policies);
 *  - y además corre dentro de `runWithRls(tenantId)`, así bajo `kinesoft_app` la policy también filtra.
 *  - Solo columnas propias de cada fila (allowlist `EXPORT_FIELDS`), nunca `include` de relaciones: un FK roto que
 *    apunte a otro consultorio (las FK saltean RLS) dejaría a lo sumo un id ajeno, nunca sus datos.
 *  Lo prueba tests/integration/tenant-export.test.ts en los dos roles, escaneando el JSON entero.
 *
 * Memoria: se arma en streaming, por entidad y en páginas de `TENANT_EXPORT_PAGE_SIZE` con cursor por id; nunca
 * hay más de una página en memoria. Cada página es una tx corta propia (ver `TENANT_EXPORT_PAGE_SIZE`). Costo:
 * el archivo no es una foto atómica (un turno cargado mientras se arma puede entrar o no); para llevarse los datos
 * alcanza, y el manifest cuenta lo que efectivamente salió.
 */
import "server-only";
import type { Prisma } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import {
  EXPORT_ENTITIES,
  EXPORT_EXCLUDES_COPY,
  TENANT_EXPORT_PAGE_SIZE,
  TENANT_EXPORT_VERSION,
  auditSince,
  exportChunks,
  selectOf,
  type ExportEntity,
  type TenantExportManifest,
} from "@/lib/tenant-export-logic";

type Tx = Prisma.TransactionClient;
type Row = { id: string } & Record<string, unknown>;
/** Argumentos de página comunes: orden estable por id + cursor. */
type PageArgs = { orderBy: { id: "asc" }; take: number; cursor?: { id: string }; skip?: number };
/** El tipo que infiere Prisma con un `select` armado en runtime no sirve; todas las filas tienen `id` (allowlist). */
const asRows = (rows: unknown): Row[] => rows as Row[];

/**
 * Una página de cada entidad. Cada función escribe su `where` con el tenant EXPLÍCITO (nada genérico que pueda
 * perder el filtro). `sel` es la allowlist (`selectOf`); team y practitioners suman nombre y email de UserProfile.
 */
const PAGE: Record<ExportEntity, (tx: Tx, tenantId: string, args: PageArgs, since: Date) => Promise<Row[]>> = {
  tenant: (tx, tenantId, a) => tx.tenant.findMany({ where: { id: tenantId }, select: selectOf("tenant"), ...a }).then(asRows),
  locations: (tx, tenantId, a) =>
    tx.location.findMany({ where: { tenantId }, select: selectOf("locations"), ...a }).then(asRows),
  rooms: (tx, tenantId, a) => tx.room.findMany({ where: { tenantId }, select: selectOf("rooms"), ...a }).then(asRows),
  services: (tx, tenantId, a) =>
    tx.service.findMany({ where: { tenantId }, select: selectOf("services"), ...a }).then(asRows),
  insurers: (tx, tenantId, a) =>
    tx.insurer.findMany({ where: { tenantId }, select: selectOf("insurers"), ...a }).then(asRows),
  // Solo los planes PROPIOS del consultorio (los globales del catálogo son de todos: `tenantId` null).
  payerPlans: (tx, tenantId, a) =>
    tx.payerPlan.findMany({ where: { tenantId }, select: selectOf("payerPlans"), ...a }).then(asRows),
  team: async (tx, tenantId, a) => {
    const rows = await tx.membership.findMany({
      where: { tenantId },
      select: { ...selectOf("team"), user: { select: { fullName: true, email: true } } },
      ...a,
    });
    return rows.map(({ user, ...m }) => ({ ...(m as Row), fullName: user.fullName, email: user.email }));
  },
  practitioners: async (tx, tenantId, a) => {
    const rows = await tx.practitioner.findMany({
      where: { tenantId },
      select: { ...selectOf("practitioners"), user: { select: { fullName: true, email: true } } },
      ...a,
    });
    return rows.map(({ user, ...p }) => ({ ...(p as Row), fullName: user.fullName, email: user.email }));
  },
  practitionerSchedules: (tx, tenantId, a) =>
    tx.practitionerSchedule.findMany({ where: { tenantId }, select: selectOf("practitionerSchedules"), ...a }).then(asRows),
  scheduleExceptions: (tx, tenantId, a) =>
    tx.scheduleException.findMany({ where: { tenantId }, select: selectOf("scheduleExceptions"), ...a }).then(asRows),
  timeBlocks: (tx, tenantId, a) =>
    tx.timeBlock.findMany({ where: { tenantId }, select: selectOf("timeBlocks"), ...a }).then(asRows),
  practitionerServices: (tx, tenantId, a) =>
    tx.practitionerService.findMany({ where: { tenantId }, select: selectOf("practitionerServices"), ...a }).then(asRows),
  practitionerPayers: (tx, tenantId, a) =>
    tx.practitionerPayer.findMany({ where: { tenantId }, select: selectOf("practitionerPayers"), ...a }).then(asRows),
  practitionerSpecialties: (tx, tenantId, a) =>
    tx.practitionerSpecialty.findMany({ where: { tenantId }, select: selectOf("practitionerSpecialties"), ...a }).then(asRows),
  // Todos: activos y archivados (es el export completo, no el directorio).
  patients: (tx, tenantId, a) =>
    tx.patient.findMany({ where: { tenantId }, select: selectOf("patients"), ...a }).then(asRows),
  coverages: (tx, tenantId, a) =>
    tx.coverage.findMany({ where: { patient: { tenantId } }, select: selectOf("coverages"), ...a }).then(asRows),
  emergencyContacts: (tx, tenantId, a) =>
    tx.emergencyContact.findMany({ where: { patient: { tenantId } }, select: selectOf("emergencyContacts"), ...a }).then(asRows),
  patientShares: (tx, tenantId, a) =>
    tx.patientShare.findMany({ where: { tenantId }, select: selectOf("patientShares"), ...a }).then(asRows),
  patientChangeRequests: (tx, tenantId, a) =>
    tx.patientChangeRequest.findMany({ where: { tenantId }, select: selectOf("patientChangeRequests"), ...a }).then(asRows),
  bookings: (tx, tenantId, a) =>
    tx.booking.findMany({ where: { tenantId }, select: selectOf("bookings"), ...a }).then(asRows),
  payments: (tx, tenantId, a) =>
    tx.payment.findMany({ where: { booking: { tenantId } }, select: selectOf("payments"), ...a }).then(asRows),
  clinicalCases: (tx, tenantId, a) =>
    tx.clinicalCase.findMany({ where: { tenantId }, select: selectOf("clinicalCases"), ...a }).then(asRows),
  diagnoses: (tx, tenantId, a) =>
    tx.diagnosis.findMany({ where: { case: { tenantId } }, select: selectOf("diagnoses"), ...a }).then(asRows),
  treatmentPrograms: (tx, tenantId, a) =>
    tx.treatmentProgram.findMany({ where: { tenantId }, select: selectOf("treatmentPrograms"), ...a }).then(asRows),
  programAuthorizations: (tx, tenantId, a) =>
    tx.programAuthorization.findMany({ where: { tenantId }, select: selectOf("programAuthorizations"), ...a }).then(asRows),
  sessions: (tx, tenantId, a) =>
    tx.session.findMany({ where: { program: { tenantId } }, select: selectOf("sessions"), ...a }).then(asRows),
  sessionExercises: (tx, tenantId, a) =>
    tx.sessionExercise.findMany({
      where: { session: { program: { tenantId } } },
      select: selectOf("sessionExercises"),
      ...a,
    }).then(asRows),
  evaScores: (tx, tenantId, a) =>
    tx.evaScore.findMany({ where: { patient: { tenantId } }, select: selectOf("evaScores"), ...a }).then(asRows),
  planTemplates: (tx, tenantId, a) =>
    tx.planTemplate.findMany({ where: { tenantId }, select: selectOf("planTemplates"), ...a }).then(asRows),
  // Solo los PROPIOS (`tenantId` = este): los del catálogo global no son datos del consultorio.
  customExercises: (tx, tenantId, a) =>
    tx.exercise.findMany({ where: { tenantId }, select: selectOf("customExercises"), ...a }).then(asRows),
  customConditions: (tx, tenantId, a) =>
    tx.condition.findMany({ where: { tenantId }, select: selectOf("customConditions"), ...a }).then(asRows),
  patientFiles: (tx, tenantId, a) =>
    tx.patientFile.findMany({ where: { tenantId }, select: selectOf("patientFiles"), ...a }).then(asRows),
  supportSessions: (tx, tenantId, a) =>
    tx.supportSession.findMany({ where: { tenantId }, select: selectOf("supportSessions"), ...a }).then(asRows),
  auditEvents: (tx, tenantId, a, since) =>
    tx.auditEvent.findMany({
      where: { tenantId, createdAt: { gte: since } },
      select: selectOf("auditEvents"),
      ...a,
    }).then(asRows),
};

export type ExportTenantMeta = { id: string; slug: string; name: string };

/** Nombre y slug para el archivo y el manifest (null si el consultorio no existe). */
export async function loadExportTenant(tenantId: string): Promise<ExportTenantMeta | null> {
  return runWithRls(tenantId, (tx) =>
    tx.tenant.findFirst({ where: { id: tenantId }, select: { id: true, slug: true, name: true } })
  );
}

function emptyCounts(): Record<ExportEntity, number> {
  return Object.fromEntries(EXPORT_ENTITIES.map((e) => [e, 0])) as Record<ExportEntity, number>;
}

/**
 * Los pedazos del JSON, en orden. `counts` se va llenando (el caller lo lee al terminar o al cortarse).
 * `pageSize` solo lo baja un test para forzar varias páginas.
 */
export async function* tenantExportChunks(p: {
  tenant: ExportTenantMeta;
  now: Date;
  counts: Record<ExportEntity, number>;
  pageSize?: number;
}): AsyncGenerator<string> {
  const take = p.pageSize ?? TENANT_EXPORT_PAGE_SIZE;
  const since = auditSince(p.now);
  yield exportChunks.open();
  for (const [i, entity] of EXPORT_ENTITIES.entries()) {
    yield exportChunks.entityOpen(entity, i === 0);
    let after: string | null = null;
    for (;;) {
      const args: PageArgs = after
        ? { orderBy: { id: "asc" }, take, cursor: { id: after }, skip: 1 }
        : { orderBy: { id: "asc" }, take };
      const rows: Row[] = await runWithRls(p.tenant.id, (tx) => PAGE[entity](tx, p.tenant.id, args, since));
      let out = "";
      for (const row of rows) {
        out += exportChunks.row(row, p.counts[entity] === 0);
        p.counts[entity] += 1;
      }
      if (out) yield out;
      if (rows.length < take) break;
      after = rows[rows.length - 1].id;
    }
    yield exportChunks.entityClose();
  }
  const manifest: TenantExportManifest = {
    version: TENANT_EXPORT_VERSION,
    generatedAt: p.now.toISOString(),
    completedAt: new Date().toISOString(),
    tenant: p.tenant,
    counts: p.counts,
    excludes: EXPORT_EXCLUDES_COPY,
    auditSince: since.toISOString(),
  };
  yield exportChunks.close(manifest);
}

/**
 * El stream de la respuesta, con la auditoría:
 *  - `tenant.export.started` ANTES del primer byte: si Vercel corta la función por tiempo, igual queda el rastro
 *    de que alguien empezó a bajar la PHI del consultorio;
 *  - `tenant.export` al final con los conteos por entidad y `completed` (true / false si se cortó o falló).
 * Payload sin PHI: solo conteos y la versión.
 */
export function streamTenantExport(p: {
  tenant: ExportTenantMeta;
  actorUserId: string;
  now: Date;
  pageSize?: number;
}): ReadableStream<Uint8Array> {
  const counts = emptyCounts();
  const enc = new TextEncoder();
  let gen: AsyncGenerator<string> | null = null;
  let finished = false;

  const finish = async (completed: boolean, error?: string) => {
    if (finished) return;
    finished = true;
    await audit({
      tenantId: p.tenant.id,
      actorId: p.actorUserId,
      action: "tenant.export",
      entity: "Tenant",
      entityId: p.tenant.id,
      payload: { completed, counts, version: TENANT_EXPORT_VERSION, ...(error ? { error } : {}) },
    });
  };

  return new ReadableStream<Uint8Array>({
    async start() {
      await audit({
        tenantId: p.tenant.id,
        actorId: p.actorUserId,
        action: "tenant.export.started",
        entity: "Tenant",
        entityId: p.tenant.id,
        payload: { version: TENANT_EXPORT_VERSION },
      });
      gen = tenantExportChunks({ tenant: p.tenant, now: p.now, counts, pageSize: p.pageSize });
    },
    async pull(controller) {
      try {
        const next = await gen!.next();
        if (next.done) {
          await finish(true);
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(next.value));
      } catch (err) {
        const name = err instanceof Error ? err.name : "unknown";
        logger.error("tenant.export.failed", { tenantId: p.tenant.id, error: name });
        await finish(false, name);
        controller.error(err);
      }
    },
    async cancel() {
      await gen?.return(undefined);
      await finish(false, "cancelled");
    },
  });
}

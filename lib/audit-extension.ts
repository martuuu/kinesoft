/**
 * Prisma extension that auto-records reads against PHI tables.
 *
 * Manual `audit({...})` calls in server actions are kept for *writes*
 * (richer payload, explicit semantics). This extension exists so that
 * any read of patient data — direct or via include — leaves a footprint
 * in `AuditEvent`, even when the developer forgot to add `audit()`
 * manually.
 *
 * Recording happens after the query resolves, so a failing query is
 * not audited. Errors in the audit write are swallowed (never block
 * the caller).
 */
import { prisma } from "@/lib/db";
import { getRequestContext } from "@/lib/request-context";
import { logger } from "@/lib/logger";
import { captureException } from "@/lib/observability";

const PHI_MODELS = new Set<string>([
  "Patient",
  "Coverage",
  "EmergencyContact",
  "ClinicalCase",
  "Diagnosis",
  "TreatmentProgram",
  "Session",
  "SessionExercise",
  "EvaScore",
  "Booking",
  "Payment",
  "PatientFile",
]);

const READ_OPERATIONS = new Set<string>([
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "findMany",
]);

export const auditExtension = {
  name: "phi-audit",
  query: {
    $allModels: {
      async $allOperations({
        model,
        operation,
        args,
        query,
      }: {
        model: string;
        operation: string;
        args: unknown;
        query: (a: unknown) => Promise<unknown>;
      }) {
        const result = await query(args);
        if (!PHI_MODELS.has(model) || !READ_OPERATIONS.has(operation)) {
          return result;
        }
        const ctx = getRequestContext();
        if (!ctx) return result;
        const whereId =
          typeof args === "object" && args !== null && "where" in args
            ? ((args as { where?: { id?: unknown } }).where?.id ?? undefined)
            : undefined;
        recordReadAudit({
          tenantId: ctx.tenantId,
          actorId: ctx.userId,
          model,
          operation,
          entityId: typeof whereId === "string" ? whereId : undefined,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          rowCount: Array.isArray(result) ? result.length : result ? 1 : 0,
        }).catch(() => {});
        return result;
      },
    },
  },
};

async function recordReadAudit(p: {
  tenantId: string;
  actorId: string | null;
  model: string;
  operation: string;
  entityId?: string;
  ip?: string;
  userAgent?: string;
  rowCount: number;
}) {
  try {
    await prisma.auditEvent.create({
      data: {
        tenantId: p.tenantId,
        actorId: p.actorId ?? undefined,
        action: `${p.model.toLowerCase()}.${operationToVerb(p.operation)}`,
        entity: p.model,
        entityId: p.entityId,
        ip: p.ip,
        userAgent: p.userAgent,
        payload: { operation: p.operation, rowCount: p.rowCount },
      },
    });
  } catch (err) {
    // Fire-and-forget: the read already succeeded and returned; the audit
    // write must never block or fail the caller — but leave a trace.
    logger.warn("audit-extension: read audit insert failed", {
      tenantId: p.tenantId,
      model: p.model,
      operation: p.operation,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err, { scope: "audit-extension", model: p.model, operation: p.operation });
  }
}

function operationToVerb(op: string): string {
  if (op === "findMany") return "list";
  if (op === "findUnique" || op === "findFirst" || op === "findUniqueOrThrow" || op === "findFirstOrThrow")
    return "read";
  return op;
}

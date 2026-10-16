"use client";

/**
 * ES4 S24r · banner del perfil con el pedido de cambio de «Mis datos» que el paciente mandó desde el portal.
 *
 * Se monta en los dos heroes (`full` y `admin`): PD-13, la Secretaria aprueba contacto y cobertura. Muestra nombres de
 * campo y valores ADMINISTRATIVOS (teléfono, email, contacto de emergencia, obra social), nunca clínicos (§6).
 *
 * Se carga solo (server action al montar) en vez de viajar en las props del perfil: así no toca `PatientHeroProps` ni la
 * page, y un paciente sin pedido no paga nada más que una lectura. La action revalida `/pacientes/<id>`, así que al
 * aprobar los datos del hero se refrescan sin `router.refresh()`.
 *
 * Aprobar un cambio de obra social pide confirmación con `useConfirm` cuando hay turnos impagos cuyo copago sale de la
 * cobertura («Cambia el copago de N turnos impagos») o un copago propio cargado que se borra (ES4-Z M2: antes, sin
 * turnos impagos, el copago propio se borraba sin preguntar). Los datos salen de `previewPortalRequestImpact` en el
 * momento del clic, no del listado (puede haber cambiado mientras la ficha estaba abierta).
 */
import { useCallback, useEffect, useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { formatARS } from "@/lib/format";
import {
  decidePatientPortalRequest,
  listPatientPortalRequests,
  previewPortalRequestImpact,
} from "@/lib/patient-portal-requests";
import type { PortalRequestRow } from "@/lib/patient-portal-requests-internal";
import type { PortalPendingChangeField } from "@/lib/portal-pending-changes";

const FIELD_LABEL: Record<PortalPendingChangeField, string> = {
  phone: "Teléfono",
  email: "Email",
  emergencyContact: "Contacto de emergencia",
  coverage: "Cobertura",
};

const AR_DATE: Intl.DateTimeFormatOptions = {
  timeZone: "America/Argentina/Buenos_Aires",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
};

type Contact = { name: string; relation?: string | null; phone: string } | null | undefined;
type Coverage = { insurerName: string; planName?: string | null; memberId?: string | null } | null | undefined;

function contactText(c: Contact): string {
  if (!c) return "Sin contacto";
  return `${c.name}${c.relation ? ` (${c.relation})` : ""} · ${c.phone}`;
}

function coverageText(c: Coverage): string {
  if (!c) return "Particular";
  return `${c.insurerName}${c.planName ? ` ${c.planName}` : ""}${c.memberId ? ` · Afiliado ${c.memberId}` : ""}`;
}

/** [valor actual, valor pedido] de un campo, como texto. */
function diffOf(row: PortalRequestRow, field: PortalPendingChangeField): [string, string] {
  const c = row.changes!;
  switch (field) {
    case "phone":
      return [row.current.phone ?? "(sin dato)", c.phone ?? "Borrar"];
    case "email":
      return [row.current.email ?? "(sin dato)", c.email ?? "Borrar"];
    case "emergencyContact":
      return [contactText(row.current.emergencyContact), c.emergencyContact ? contactText(c.emergencyContact) : "Borrar"];
    case "coverage":
      return [coverageText(row.current.coverage), coverageText(c.coverage)];
  }
}

export function PortalRequestBanner({ patientId }: { patientId: string }) {
  const [rows, setRows] = useState<PortalRequestRow[]>([]);
  // Vive acá y no en la tarjeta: si el pedido ya se resolvió en otra sesión, la tarjeta desaparece al recargar y el
  // aviso tiene que quedar.
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await listPatientPortalRequests({ patientId });
    // Sin acceso (o error de lectura): el banner no se muestra; el resto del perfil sigue.
    setRows(r.ok ? r.data : []);
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  // La tarjeta (y su `useConfirm`) solo se monta con un pedido: el perfil sin pedido no depende del ConfirmProvider.
  const row = rows[0];
  if (row) return <PortalRequestCard key={row.id} row={row} reload={load} error={error} setError={setError} />;
  return error ? (
    <p role="alert" style={{ margin: 0, fontSize: 13, color: "var(--danger-fg)" }}>
      {error}
    </p>
  ) : null;
}

function PortalRequestCard({
  row,
  reload,
  error,
  setError,
}: {
  row: PortalRequestRow;
  reload: () => Promise<void>;
  error: string | null;
  setError: (e: string | null) => void;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, start] = useTransition();
  // El preview es una ida al server: los botones quedan deshabilitados desde el clic (antes un doble clic disparaba
  // dos previews y dos confirmaciones).
  const [previewing, setPreviewing] = useState(false);
  const busy = pending || previewing;

  const approve = async () => {
    setError(null);
    if (row.changes?.coverage) {
      setPreviewing(true);
      const impact = await previewPortalRequestImpact({ id: row.id }).finally(() => setPreviewing(false));
      if (!impact.ok) {
        setError(impact.error);
        return;
      }
      const n = impact.data.unpaidCopagoBookings;
      const own = impact.data.ownCopagoCents;
      if (impact.data.osChanges && (n > 0 || own != null)) {
        const parts: string[] = [];
        if (n > 0) {
          parts.push(
            `Cambia el copago de ${n} ${n === 1 ? "turno impago" : "turnos impagos"}: se van a cobrar con la cobertura nueva.`
          );
        }
        if (own != null) {
          parts.push(`${n > 0 ? "También se borra" : "Se borra"} el copago propio de ${formatARS(own)} que tenía cargado.`);
        }
        const ok = await confirm({
          title: "Cambiar la obra social",
          message: parts.join(" "),
          confirmLabel: "Aprobar y cambiar",
          tone: "danger",
        });
        if (!ok) return;
      }
    }
    decide("APPROVE");
  };

  const reject = async () => {
    setError(null);
    const ok = await confirm({
      title: "Rechazar el pedido",
      message: "La ficha queda como está. El paciente puede mandar un pedido nuevo desde el portal.",
      confirmLabel: "Rechazar",
      tone: "danger",
    });
    if (ok) decide("REJECT");
  };

  const decide = (decision: "APPROVE" | "REJECT") =>
    start(async () => {
      const r = await decidePatientPortalRequest({ id: row.id, expectedUpdatedAt: row.updatedAt, decision });
      if (!r.ok) {
        setError(r.error);
        // Stale o ya resuelto: se recarga para mostrar la versión actual (o nada).
        await reload();
        return;
      }
      toast.success(decision === "APPROVE" ? "Datos actualizados" : "Pedido rechazado");
      await reload();
    });

  return (
    <Card
      role="region"
      aria-label="Pedido de cambio de datos del portal"
      style={{ padding: 16, borderLeft: "4px solid var(--sky-500)", display: "grid", gap: 12 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Tag tone="sky">Portal del paciente</Tag>
        <strong style={{ fontSize: 14 }}>Pidió actualizar sus datos</strong>
        <span style={{ fontSize: 12, color: "var(--navy-500)" }}>
          {new Date(row.createdAt).toLocaleString("es-AR", AR_DATE)}
        </span>
      </div>

      {row.changes ? (
        <dl style={{ display: "grid", gridTemplateColumns: "minmax(140px, max-content) 1fr", gap: "6px 16px", margin: 0, fontSize: 13 }}>
          {row.fields.map((f) => {
            const [now, next] = diffOf(row, f);
            return (
              <div key={f} style={{ display: "contents" }}>
                <dt style={{ color: "var(--navy-500)" }}>{FIELD_LABEL[f]}</dt>
                <dd style={{ margin: 0 }}>
                  <span style={{ color: "var(--navy-500)", textDecoration: "line-through" }}>{now}</span>
                  {" → "}
                  <strong>{next}</strong>
                  {f === "email" && !row.emailApplies && (
                    <span style={{ display: "block", fontSize: 12, color: "var(--navy-500)" }}>
                      No se va a aplicar: la ficha ya no está vinculada a la cuenta que lo pidió.
                    </span>
                  )}
                  {f === "coverage" && row.osChanges && (
                    <span style={{ display: "block", fontSize: 12, color: "var(--navy-500)" }}>
                      Cambia la obra social: puede cambiar el copago de los turnos sin cobrar.
                    </span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <p style={{ margin: 0, fontSize: 13 }}>
          El pedido tiene datos que ya no son válidos. Rechazalo y pedile al paciente que lo vuelva a enviar.
        </p>
      )}

      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: "var(--danger-fg)" }}>
          {error}
        </p>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {row.changes && (
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void approve()}>
            Aprobar y aplicar
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void reject()}>
          Rechazar
        </Button>
      </div>
    </Card>
  );
}

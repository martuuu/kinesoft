"use client";

/**
 * Tablero de /plataforma/salud (BO3-D): una Card por detector de `getPlatformHealth()`, con conteo, la muestra
 * (≤10) y la acción de cada fila. Cada reparación pasa por `useConfirm` → action de `lib/platform-users.ts` →
 * Toast → `router.refresh()` (el reporte se vuelve a calcular en el server; acá no se parchea a mano).
 *
 * Un detector con `available: false` (Auth no se pudo listar) dice «No disponible»: nunca «Sin problemas», porque
 * eso sería un falso verde.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { repairCreatePractitioner, repairDeleteAuthOrphan } from "@/lib/platform-users";
import type { HealthDetector, PlatformHealthReport } from "@/lib/platform-health-logic";
import { useSyncEmail } from "@/components/plataforma/users/user-actions";
import {
  HEALTH_DETECTORS,
  UNAVAILABLE_COPY,
  detectorCountLabel,
  detectorState,
  healthRows,
  sampleNote,
  type HealthDetectorCopy,
  type HealthRowAction,
  type HealthRowView,
} from "@/components/plataforma/health/health-logic";

const GENERIC_ERROR = "Probá de nuevo en unos minutos.";

function RowAction({ action }: { action: HealthRowAction }) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const syncEmail = useSyncEmail();
  const [busy, setBusy] = useState(false);

  async function guarded(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  switch (action.kind) {
    case "link":
      return (
        <Link href={action.href} style={{ fontSize: 13, fontWeight: 600, color: "var(--sky-700)", whiteSpace: "nowrap" }}>
          {action.label} →
        </Link>
      );
    case "none":
      return <span style={{ fontSize: 12, color: "var(--navy-500)", maxWidth: 240, lineHeight: 1.4 }}>{action.note}</span>;
    case "syncEmail":
      return (
        <Button variant="ghost" disabled={busy} onClick={() => guarded(() => syncEmail(action))}>
          Sincronizar email
        </Button>
      );
    case "createPractitioner":
      return (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            guarded(async () => {
              const ok = await confirm({
                title: "¿Crear el profesional?",
                message: "Se crea su profesional con la agenda por defecto del consultorio. Después puede ajustar sus horarios.",
                confirmLabel: "Crear",
              });
              if (!ok) return;
              try {
                const r = await repairCreatePractitioner({ tenantId: action.tenantId, userId: action.userId });
                if (!r.ok) {
                  toast.error("No se pudo crear", { description: r.error });
                  return;
                }
                toast.success(r.data.created ? "Profesional creado" : "Ya tenía profesional");
                router.refresh();
              } catch {
                toast.error("No se pudo crear", { description: GENERIC_ERROR });
              }
            })
          }
        >
          Crear profesional
        </Button>
      );
    case "deleteAuthOrphan":
      return (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            guarded(async () => {
              const ok = await confirm({
                title: "¿Borrar esta cuenta?",
                message: `Se borra la cuenta de ${action.email ?? "este usuario"} del servicio de acceso y el email queda libre. No se puede deshacer.`,
                confirmLabel: "Borrar",
                tone: "danger",
              });
              if (!ok) return;
              try {
                const r = await repairDeleteAuthOrphan({ authUserId: action.authUserId });
                if (!r.ok) {
                  toast.error("No se pudo borrar", { description: r.error });
                  return;
                }
                toast.success("Cuenta borrada");
                router.refresh();
              } catch {
                toast.error("No se pudo borrar", { description: GENERIC_ERROR });
              }
            })
          }
        >
          Borrar
        </Button>
      );
  }
}

function Row({ row }: { row: HealthRowView }) {
  return (
    <li
      style={{
        display: "flex",
        gap: 12,
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        padding: "10px 0",
        borderTop: "1px solid rgba(15,30,51,0.06)",
      }}
    >
      <div style={{ minWidth: 0, flex: "1 1 200px" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-900)", overflowWrap: "anywhere" }}>{row.primary}</div>
        <div style={{ fontSize: 12, color: "var(--navy-500)", overflowWrap: "anywhere" }}>{row.secondary}</div>
      </div>
      <RowAction action={row.action} />
    </li>
  );
}

export function DetectorCard({ copy, report }: { copy: HealthDetectorCopy; report: PlatformHealthReport }) {
  const d = report[copy.key] as HealthDetector<unknown>;
  const state = detectorState(d);
  const rows = state === "problem" ? healthRows(copy.key, report) : [];
  const note = sampleNote(d);
  return (
    <Card style={{ padding: 18 }} data-detector={copy.key} data-state={state}>
      <div style={{ display: "flex", gap: 10, justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 220px" }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, color: "var(--navy-900)" }}>{copy.title}</h2>
          <p style={{ fontSize: 12.5, color: "var(--navy-500)", margin: "4px 0 0", lineHeight: 1.45 }}>{copy.description}</p>
        </div>
        <Tag tone={state === "problem" ? "sky" : state === "ok" ? "lime" : "soft"}>{detectorCountLabel(d)}</Tag>
      </div>
      {state === "unavailable" && <p style={{ fontSize: 12.5, color: "#9A5B00", margin: "10px 0 0", lineHeight: 1.45 }}>{UNAVAILABLE_COPY}</p>}
      {state === "ok" && <p style={{ fontSize: 12.5, color: "var(--navy-500)", margin: "10px 0 0" }}>{copy.emptyText}</p>}
      {rows.length > 0 && (
        <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
          {rows.map((r) => (
            <Row key={r.id} row={r} />
          ))}
        </ul>
      )}
      {note && <p style={{ fontSize: 12, color: "var(--navy-300)", margin: "8px 0 0" }}>{note}</p>}
    </Card>
  );
}

export function HealthBoard({ report }: { report: PlatformHealthReport }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(420px, 100%), 1fr))", gap: 14, alignItems: "start" }}>
      {HEALTH_DETECTORS.map((c) => (
        <DetectorCard key={c.key} copy={c} report={report} />
      ))}
    </div>
  );
}

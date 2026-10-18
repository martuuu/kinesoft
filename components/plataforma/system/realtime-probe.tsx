"use client";

/**
 * HF-1a (H-RT1, plan §22.4) · «Probar desde el servidor» en `/plataforma/sistema`. Llama a `probeRealtimeFromServer`
 * (que firma un token para un consultorio sintético y se une al canal privado desde ESTE deploy) y muestra SUBSCRIBED
 * o el motivo que dio Supabase. Nunca recibe el token: la action no lo devuelve.
 *
 * Por `usePlatformAction` como las demás acciones de Plataforma (re-verificación / rate limit con su copy).
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import { probeRealtimeFromServer } from "@/lib/platform-realtime-probe";
import type { RealtimeProbeReport } from "@/lib/platform-realtime-probe-internal";

export function RealtimeProbe() {
  const run = usePlatformAction();
  const [pending, setPending] = useState(false);
  const [report, setReport] = useState<RealtimeProbeReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function probe() {
    setPending(true);
    setError(null);
    try {
      const r = await run(() => probeRealtimeFromServer());
      if (r.ok) setReport(r.data);
      else setError(r.error);
    } catch {
      setError("No se pudo probar. Volvé a intentar en unos segundos.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 8 }} data-testid="realtime-probe">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button type="button" variant="ghost" size="sm" onClick={probe} disabled={pending} aria-busy={pending}>
          {pending ? "Probando…" : "Probar desde el servidor"}
        </Button>
        {report ? <ProbeBadge r={report} /> : null}
      </div>
      <p aria-live="polite" style={{ fontSize: 12, color: "var(--navy-500)", margin: 0, lineHeight: 1.4, overflowWrap: "anywhere" }}>
        {error
          ? error
          : report
            ? describe(report)
            : "Se une al canal privado con un consultorio de prueba, usando el secreto y la clave de este deploy."}
      </p>
    </div>
  );
}

function ProbeBadge({ r }: { r: RealtimeProbeReport }) {
  if (r.ok) return <Tag tone="lime">{r.ms !== null ? `${r.status} · ${r.ms} ms` : r.status}</Tag>;
  const neutral = r.status === "UNAVAILABLE";
  return (
    <span
      className="k-tag"
      style={{
        background: neutral ? "var(--warn-bg)" : "var(--danger-bg)",
        color: neutral ? "var(--warn-fg)" : "var(--danger-fg)",
      }}
    >
      {r.status}
    </span>
  );
}

function describe(r: RealtimeProbeReport): string {
  const fp = r.fingerprint ? ` Huella ${r.fingerprint}${r.kid ? " · con kid" : " · sin kid"}.` : "";
  if (r.ok) return `El canal privado se suscribió: el secreto y la configuración de este deploy están bien.${fp}`;
  return `${r.reason ?? "Sin motivo."}${fp}`;
}

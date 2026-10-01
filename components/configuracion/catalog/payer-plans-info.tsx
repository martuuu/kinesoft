"use client";

import { useEffect, useState } from "react";
import { Tag } from "@/components/ui/tag";
import { listPayerPlans } from "@/lib/catalog";
import type { PayerPlanOption } from "@/lib/catalog-schemas";

/**
 * Planes de la prestadora vinculada, solo como información (B1.4): el
 * copago/arancel sigue siendo del Insurer (precio por plan = bloque D). Se
 * muestran los globales y los que propuso este consultorio (marcados), que
 * Plataforma todavía no promovió.
 */
export function PayerPlansInfo({ payerId }: { payerId: string }) {
  const [plans, setPlans] = useState<PayerPlanOption[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setPlans(null);
    setFailed(false);
    listPayerPlans(payerId)
      .then((rows) => alive && setPlans(rows))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [payerId]);

  return (
    <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Planes de la prestadora</div>
      {failed ? (
        <span>No pudimos cargar los planes.</span>
      ) : plans === null ? (
        <span style={{ color: "var(--navy-300)" }}>Cargando…</span>
      ) : plans.length === 0 ? (
        <span style={{ color: "var(--navy-300)" }}>El catálogo no tiene planes cargados para esta prestadora.</span>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {plans.map((p) => (
            <Tag key={p.id} tone={p.proposed ? "soft" : "sky"}>
              {p.name}
              {p.proposed ? " · propuesto" : ""}
            </Tag>
          ))}
        </div>
      )}
      <div style={{ marginTop: 6, color: "var(--navy-300)" }}>
        El copago y el monto fijo se cargan acá abajo y valen para todos los planes.
      </div>
    </div>
  );
}

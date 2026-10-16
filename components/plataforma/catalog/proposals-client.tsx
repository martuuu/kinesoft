"use client";

/**
 * Plataforma → Catálogo → Propuestas: planes de prestadora que cargó un
 * consultorio (PayerPlan con tenantId) y todavía no son globales. "Promover"
 * los pasa al catálogo; si ya hay un plan global con el mismo nombre normalizado
 * (slug), se fusiona en ese y se repuntan las coberturas del consultorio.
 */
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { promotePayerPlan } from "@/lib/catalog-admin";
import type { PayerPlanProposal } from "@/lib/catalog-admin-types";
import { formatARDate } from "@/components/plataforma/catalog/catalog-copy";

const COLS = "minmax(180px,1.6fr) minmax(160px,1.3fr) minmax(150px,1.2fr) 96px minmax(170px,1.3fr)";

export function ProposalsClient({ proposals }: { proposals: PayerPlanProposal[] }) {
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 820 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: COLS,
              gap: 12,
              padding: "10px 16px",
              borderBottom: "1px solid rgba(15,30,51,0.07)",
              background: "rgba(246,249,253,0.6)",
            }}
          >
            <Head>Plan propuesto</Head>
            <Head>Prestadora</Head>
            <Head>Consultorio</Head>
            <Head>Coberturas</Head>
            <Head align="right">Acción</Head>
          </div>
          {proposals.length === 0 ? (
            <div style={{ padding: "44px 20px", textAlign: "center" }}>
              <div style={{ fontSize: 13.5, color: "var(--navy-700)", fontWeight: 600 }}>No hay propuestas pendientes.</div>
              <div style={{ fontSize: 12, color: "var(--navy-300)", marginTop: 4 }}>
                Cuando un consultorio cargue un plan que no está en el catálogo, aparece acá.
              </div>
            </div>
          ) : (
            proposals.map((p) => <ProposalRow key={p.id} p={p} />)
          )}
        </div>
      </div>
    </Card>
  );
}

function ProposalRow({ p }: { p: PayerPlanProposal }) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, start] = useTransition();

  const promote = async () => {
    const ok = await confirm({
      title: p.globalMatch ? `Fusionar en «${p.globalMatch.name}»` : `Promover «${p.name}»`,
      message: p.globalMatch
        ? `Ya existe el plan global «${p.globalMatch.name}» de ${p.payerName}. Las ${p.coverages} cobertura(s) de ${p.tenantName} pasan a ese plan y la propuesta queda archivada.`
        : `«${p.name}» pasa al catálogo global de ${p.payerName}: lo van a ver todos los consultorios.`,
      confirmLabel: p.globalMatch ? "Fusionar" : "Promover",
    });
    if (!ok) return;
    start(async () => {
      const r = await promotePayerPlan({ planId: p.id });
      if (!r.ok) {
        toast.error("No se pudo promover", { description: r.error });
        return;
      }
      toast.success(r.data.merged ? "Fusionado con el plan global" : "Plan promovido al catálogo");
    });
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: COLS,
        gap: 12,
        padding: "11px 16px",
        alignItems: "center",
        borderBottom: "1px solid rgba(15,30,51,0.045)",
        opacity: pending ? 0.55 : 1,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>{p.name}</div>
        <div style={{ fontSize: 11, color: "var(--navy-400)", marginTop: 2 }}>
          <span className="k-mono">{p.slug}</span> · {formatARDate(p.createdAt)}
        </div>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--navy-700)", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        {p.payerName}
        {p.payerArchived && <Tag tone="soft">archivada</Tag>}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--navy-700)" }}>{p.tenantName}</div>
      <div className="k-mono" style={{ fontSize: 12, color: "var(--navy-700)" }}>
        {p.coverages}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
        {p.globalMatch && <Tag tone="sky">Ya existe global</Tag>}
        <Button type="button" variant="ghost" onClick={promote} disabled={pending || p.payerArchived}>
          {p.globalMatch ? "Fusionar" : "Promover"}
        </Button>
      </div>
    </div>
  );
}

function Head({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--navy-500)", whiteSpace: "nowrap",
        textAlign: align,
      }}
    >
      {children}
    </span>
  );
}

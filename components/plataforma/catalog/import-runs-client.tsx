"use client";

/**
 * Plataforma → Catálogo → Importaciones: bitácora de `scripts/catalog-import.ts
 * --apply` (CatalogImportRun). Solo lectura: el import lo corre Martin desde la
 * terminal (dry-run por defecto); acá se ve qué entró, cuándo y con cuántos
 * conflictos. Cliente para formatear fechas en hora AR de forma uniforme y para
 * el botón "Refrescar catálogo": el script corre fuera de Next y no invalida el
 * cache de los consultorios (`tags.catalog()`); sin el botón, lo importado
 * aparece en los pickers recién cuando vence el ttl (1 h).
 */
import { useTransition } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { refreshCatalogCache } from "@/lib/catalog-admin";
import type { CatalogImportRunRow } from "@/lib/catalog-admin-types";
import { formatARDateTime } from "@/components/plataforma/catalog/catalog-copy";

const COLS = "150px minmax(180px,1.6fr) 110px 70px 70px 70px 90px minmax(110px,1fr)";

export function ImportRunsClient({ runs }: { runs: CatalogImportRunRow[] }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <RefreshCatalogBar />
      <RunsTable runs={runs} />
    </div>
  );
}

function RefreshCatalogBar() {
  const toast = useToast();
  const [pending, start] = useTransition();
  const refresh = () =>
    start(async () => {
      const r = await refreshCatalogCache();
      if (!r.ok) {
        toast.error("No se pudo refrescar el catálogo", { description: r.error });
        return;
      }
      toast.success("Catálogo refrescado", {
        description: "Los consultorios ya ven lo último que se importó.",
      });
    });
  return (
    <Card style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
      <div style={{ fontSize: 12.5, color: "var(--navy-700)", maxWidth: 560 }}>
        Después de correr el import con <span className="k-mono">--apply</span>, refrescá el catálogo para que los
        consultorios vean los cambios ya (si no, tardan hasta una hora).
      </div>
      <Button type="button" variant="ghost" onClick={refresh} disabled={pending}>
        {pending ? "Refrescando…" : "Refrescar catálogo"}
      </Button>
    </Card>
  );
}

function RunsTable({ runs }: { runs: CatalogImportRunRow[] }) {
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 880 }}>
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
            {["Fecha", "Archivo", "Tipo", "Nuevas", "Act.", "Omit.", "Conflictos", "Corrió"].map((h) => (
              <span key={h} style={headStyle}>
                {h}
              </span>
            ))}
          </div>
          {runs.length === 0 ? (
            <div style={{ padding: "44px 20px", textAlign: "center", fontSize: 13.5, color: "var(--navy-700)", fontWeight: 600 }}>
              Todavía no se corrió ningún import con --apply.
            </div>
          ) : (
            runs.map((r) => (
              <div
                key={r.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: COLS,
                  gap: 12,
                  padding: "10px 16px",
                  alignItems: "center",
                  borderBottom: "1px solid rgba(15,30,51,0.045)",
                  fontSize: 12.5,
                  color: "var(--navy-700)",
                }}
              >
                <span className="k-mono" style={{ fontSize: 11.5 }}>
                  {formatARDateTime(r.ranAt)}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ fontWeight: 600, color: "var(--navy-900)" }}>{r.file}</span>
                  <span
                    className="k-mono"
                    title={r.sha256}
                    style={{ display: "block", fontSize: 10.5, color: "var(--navy-300)" }}
                  >
                    {r.sha256.slice(0, 12)}
                  </span>
                </span>
                <span>{r.kind}</span>
                <span className="k-mono">{r.created}</span>
                <span className="k-mono">{r.updated}</span>
                <span className="k-mono">{r.skipped}</span>
                <span className="k-mono" style={{ color: r.conflictCount ? "#9F1F1F" : "var(--navy-300)", fontWeight: r.conflictCount ? 700 : 400 }}>
                  {r.conflictCount}
                </span>
                <span style={{ fontSize: 12, color: "var(--navy-500)" }}>{r.ranBy ?? "—"}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </Card>
  );
}

const headStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--navy-300)",
};

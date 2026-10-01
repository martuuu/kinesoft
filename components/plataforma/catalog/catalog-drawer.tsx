"use client";

/**
 * Drawer de curado de una fila del catálogo global (B1.3): editar (marca
 * `curatedAt`, así el import no lo pisa), archivar/restaurar y fusionar con
 * otra fila (prestadoras y prácticas). Mismo patrón que `exercise-drawer.tsx`:
 * carga lazy del detalle, form no controlado + `useFormDirty` para el
 * dirty-guard del `Drawer`, `useConfirm` para lo destructivo, Toast al terminar.
 */
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { FormField } from "@/components/ui/form-field";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useFormDirty } from "@/components/ui/use-form-dirty";
import {
  getCatalogDetail,
  mergePayer,
  mergePractice,
  searchMergeTargets,
  setCatalogArchived,
  updatePayer,
  updatePractice,
  updateSpecialty,
} from "@/lib/catalog-admin";
import type { CatalogDetail, CatalogEntityKind } from "@/lib/catalog-admin-types";
import { ENTITY_COPY, PAYER_KIND_OPTIONS, SOURCE_LABEL, formatARDate } from "@/components/plataforma/catalog/catalog-copy";

const TITLE: Record<CatalogEntityKind, string> = {
  payer: "Editar prestadora",
  practice: "Editar práctica",
  specialty: "Editar especialidad",
};

/** Un alias por renglón: más fácil de revisar y pegar que una lista con comas (hay nombres con comas). */
const parseAliases = (s: string) =>
  s
    .split("\n")
    .map((a) => a.trim())
    .filter(Boolean);

export function CatalogDrawer({
  entity,
  id,
  onClose,
}: {
  entity: CatalogEntityKind;
  id: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<CatalogDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getCatalogDetail(entity, id).then((d) => {
      if (!alive) return;
      setDetail(d);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [entity, id]);

  if (loading || !detail) {
    return (
      <Drawer open onClose={onClose} title={TITLE[entity]} width={560}>
        <div style={{ padding: 20, color: "var(--navy-500)", fontSize: 13 }}>
          {loading ? "Cargando…" : "No encontramos esa fila del catálogo."}
        </div>
      </Drawer>
    );
  }
  return <CatalogDrawerBody detail={detail} onClose={onClose} />;
}

function CatalogDrawerBody({ detail, onClose }: { detail: CatalogDetail; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const { dirty, onFormInput } = useFormDirty(formRef);
  const entity = detail.kind;
  const archived = detail.archivedAt != null;

  const submit = (fd: FormData) => {
    setError(null);
    setFieldErrors({});
    const str = (k: string) => String(fd.get(k) ?? "");
    const aliases = parseAliases(str("aliases"));
    start(async () => {
      const r =
        detail.kind === "payer"
          ? await updatePayer({
              id: detail.id,
              name: str("name"),
              legalName: str("legalName"),
              kind: str("kind"),
              registryCode: str("registryCode"),
              cuit: str("cuit"),
              province: str("province"),
              aliases,
            })
          : detail.kind === "practice"
            ? await updatePractice({
                id: detail.id,
                name: str("name"),
                code: str("code"),
                nomenclador: str("nomenclador"),
                defaultDurationMin: str("defaultDurationMin") ? Number(str("defaultDurationMin")) : null,
                aliases,
              })
            : await updateSpecialty({ id: detail.id, name: str("name"), aliases });
      if (!r.ok) {
        setError(r.error);
        setFieldErrors(r.fieldErrors ?? {});
        toast.error("No se pudo guardar", { description: r.error });
        return;
      }
      toast.success("Guardado", { description: "Quedó marcada como curada: el próximo import no la pisa." });
      router.refresh();
      onClose();
    });
  };

  const toggleArchive = async () => {
    if (!archived) {
      const ok = await confirm({
        title: `Archivar ${ENTITY_COPY[entity].singular}`,
        message:
          "Deja de aparecer en los buscadores de los consultorios. Lo que ya está vinculado no se toca y se puede restaurar.",
        confirmLabel: "Archivar",
      });
      if (!ok) return;
    }
    start(async () => {
      const r = await setCatalogArchived({ entity, id: detail.id, archived: !archived });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(archived ? "Restaurada" : "Archivada");
      router.refresh();
      onClose();
    });
  };

  const fe = (k: string) => fieldErrors[k]?.[0];

  return (
    <Drawer open onClose={onClose} title={TITLE[entity]} width={600} dirty={dirty}>
      <div style={{ display: "grid", gap: 18 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 11.5, color: "var(--navy-500)" }}>
          <span className="k-mono">{detail.slug}</span>
          <span>·</span>
          <span>{SOURCE_LABEL[detail.source]}</span>
          {detail.sourceRef && (
            <>
              <span>·</span>
              <span>{detail.sourceRef}</span>
            </>
          )}
          {detail.curatedAt && (
            <>
              <span>·</span>
              <span style={{ color: "var(--sky-700)", fontWeight: 600 }}>Curada {formatARDate(detail.curatedAt)}</span>
            </>
          )}
          {archived && (
            <>
              <span>·</span>
              <span style={{ fontWeight: 700 }}>Archivada</span>
            </>
          )}
        </div>

        <form ref={formRef} action={submit} onInput={onFormInput} onChange={onFormInput} style={{ display: "grid", gap: 12 }}>
          <FormField label="Nombre" name="name" required defaultValue={detail.name} error={fe("name")} />

          {detail.kind === "payer" && (
            <>
              <FormField label="Razón social" name="legalName" defaultValue={detail.legalName ?? ""} hint="opcional" />
              <div style={grid2}>
                <FormField
                  as="select"
                  label="Tipo"
                  name="kind"
                  defaultValue={detail.payerKind}
                  options={PAYER_KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                />
                <FormField label="Provincia" name="province" defaultValue={detail.province ?? ""} hint="vacío = nacional" />
              </div>
              <div style={grid2}>
                <FormField
                  label="Código RNOS / RNEMP"
                  name="registryCode"
                  defaultValue={detail.registryCode ?? ""}
                  error={fe("registryCode")}
                />
                <FormField label="CUIT" name="cuit" defaultValue={detail.cuit ?? ""} error={fe("cuit")} />
              </div>
            </>
          )}

          {detail.kind === "practice" && (
            <>
              <div style={grid2}>
                <FormField label="Código" name="code" defaultValue={detail.code ?? ""} error={fe("code")} />
                <FormField label="Nomenclador" name="nomenclador" defaultValue={detail.nomenclador ?? ""} hint="Nacional, IOMA…" />
              </div>
              <FormField
                label="Duración sugerida (min)"
                name="defaultDurationMin"
                type="number"
                min={5}
                max={480}
                defaultValue={detail.defaultDurationMin != null ? String(detail.defaultDurationMin) : ""}
                error={fe("defaultDurationMin")}
                hint="opcional"
              />
            </>
          )}

          <FormField
            as="textarea"
            label="Alias"
            name="aliases"
            rows={4}
            defaultValue={detail.aliases.join("\n")}
            hint="Uno por renglón. Los consultorios encuentran la fila buscando cualquiera de estos nombres."
            error={fe("aliases")}
          />

          {error && <ErrorBox>{error}</ErrorBox>}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              Guardar
            </Button>
          </div>
        </form>

        {detail.kind === "payer" && (
          <section style={{ display: "grid", gap: 8 }}>
            <h3 style={sectionH}>
              Uso · {detail.insurerCount} consultorio{detail.insurerCount === 1 ? "" : "s"} vinculado
              {detail.insurerCount === 1 ? "" : "s"} · {detail.plans.length} plan{detail.plans.length === 1 ? "" : "es"}
            </h3>
            {detail.plans.length > 0 && (
              <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4 }}>
                {detail.plans.map((p) => (
                  <li key={p.id} style={{ fontSize: 12.5, color: "var(--navy-700)", opacity: p.archived ? 0.6 : 1 }}>
                    <strong>{p.name}</strong>{" "}
                    <span style={{ color: "var(--navy-400)" }}>
                      · {p.tenantName ? `propuesto por ${p.tenantName}` : "global"} · {p.coverages} cobertura
                      {p.coverages === 1 ? "" : "s"}
                      {p.archived ? " · archivado" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {detail.kind === "practice" && (
          <section style={{ display: "grid", gap: 6 }}>
            <h3 style={sectionH}>
              Uso · {detail.serviceCount} servicio{detail.serviceCount === 1 ? "" : "s"} de consultorios
            </h3>
            <div style={{ fontSize: 12.5, color: "var(--navy-700)" }}>
              {detail.specialties.length
                ? detail.specialties.map((s) => s.name).join(" · ")
                : <span style={{ color: "var(--navy-300)" }}>Sin especialidades vinculadas</span>}
            </div>
          </section>
        )}
        {detail.kind === "specialty" && (
          <section>
            <h3 style={sectionH}>
              Uso · {detail.practiceCount} práctica{detail.practiceCount === 1 ? "" : "s"}
            </h3>
          </section>
        )}

        {(detail.kind === "payer" || detail.kind === "practice") && !archived && (
          <MergeSection entity={detail.kind} fromId={detail.id} fromName={detail.name} onDone={onClose} disabled={pending} />
        )}

        <section style={{ borderTop: "1px solid rgba(15,30,51,0.08)", paddingTop: 14 }}>
          <Button type="button" variant="ghost" onClick={toggleArchive} disabled={pending}>
            {archived ? "Restaurar" : "Archivar"}
          </Button>
        </section>
      </div>
    </Drawer>
  );
}

/**
 * Fusionar esta fila (origen) en otra (destino). Todo lo que apunta al origen
 * en cualquier consultorio pasa al destino y el origen queda archivado.
 */
function MergeSection({
  entity,
  fromId,
  fromName,
  onDone,
  disabled,
}: {
  entity: "payer" | "practice";
  fromId: string;
  fromName: string;
  onDone: () => void;
  disabled: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; name: string; slug: string }[]>([]);
  const noun = ENTITY_COPY[entity].singular;

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      searchMergeTargets(entity, term, fromId).then((r) => {
        if (alive) setResults(r);
      });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, entity, fromId]);

  const doMerge = async (target: { id: string; name: string }) => {
    const ok = await confirm({
      title: `Fusionar en «${target.name}»`,
      message:
        entity === "payer"
          ? `Los consultorios vinculados a «${fromName}», sus planes y las coberturas de esos planes pasan a «${target.name}». «${fromName}» queda archivada y su nombre se suma como alias. No se deshace con un click.`
          : `Los servicios de los consultorios vinculados a «${fromName}» y sus especialidades pasan a «${target.name}». «${fromName}» queda archivada y su nombre se suma como alias. No se deshace con un click.`,
      confirmLabel: "Fusionar",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      const r =
        entity === "payer"
          ? await mergePayer({ fromId, intoId: target.id })
          : await mergePractice({ fromId, intoId: target.id });
      if (!r.ok) {
        toast.error("No se pudo fusionar", { description: r.error });
        return;
      }
      const m = r.data.moved;
      toast.success("Fusionadas", {
        description:
          entity === "payer"
            ? `${m.insurers ?? 0} consultorio(s), ${(m.plans ?? 0) + (m.plansMerged ?? 0)} plan(es) y ${m.coverages ?? 0} cobertura(s) repuntados.`
            : `${m.services ?? 0} servicio(s) y ${m.specialties ?? 0} especialidad(es) repuntados.`,
      });
      router.refresh();
      onDone();
    });
  };

  return (
    <section style={{ display: "grid", gap: 8 }}>
      <h3 style={sectionH}>Fusionar con otra {noun}</h3>
      <p style={{ margin: 0, fontSize: 12, color: "var(--navy-500)", lineHeight: 1.45 }}>
        Para duplicados (p. ej. la misma obra social cargada con dos nombres). Elegí la {noun} que queda.
      </p>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Buscar la ${noun} destino…`}
        aria-label={`Buscar la ${noun} destino`}
        autoComplete="off"
        spellCheck={false}
        data-1p-ignore
        style={{
          padding: "9px 12px",
          borderRadius: 10,
          border: "1px solid rgba(15,30,51,0.1)",
          background: "rgba(255,255,255,0.95)",
          fontSize: 13,
          color: "var(--navy-900)",
          outline: "none",
        }}
      />
      {results.length > 0 && (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4 }}>
          {results.map((t) => (
            <li
              key={t.id}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 12.5 }}
            >
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <strong style={{ color: "var(--navy-900)" }}>{t.name}</strong>{" "}
                <span className="k-mono" style={{ color: "var(--navy-300)", fontSize: 11 }}>
                  {t.slug}
                </span>
              </span>
              <Button type="button" variant="ghost" onClick={() => doMerge(t)} disabled={pending || disabled}>
                Fusionar acá
              </Button>
            </li>
          ))}
        </ul>
      )}
      {q.trim().length >= 2 && results.length === 0 && (
        <span style={{ fontSize: 12, color: "var(--navy-300)" }}>Sin coincidencias activas.</span>
      )}
    </section>
  );
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      style={{ padding: 10, borderRadius: 10, background: "rgba(228,70,70,0.1)", color: "#9F1F1F", fontSize: 12 }}
    >
      {children}
    </div>
  );
}

const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 };

const sectionH: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--navy-300)",
  margin: 0,
};

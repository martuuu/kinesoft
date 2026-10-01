"use client";

/**
 * Pasos Servicios y Obras sociales del alta (A3c-S-signup). Reusan las
 * actions de Configuración (`createService`, `createInsurer`, …): el OWNER ya
 * tiene Actor desde el paso Consultorio. La lista sale de la DB (re-entrar
 * muestra lo cargado, nunca lo vuelve a crear).
 *
 * B5.5 ONB: catálogo global en los dos pasos.
 *   • Servicios: picker de práctica (`PracticePicker` de Configuración); al
 *     elegir una, sugiere nombre y duración (`defaultDurationMin`).
 *   • Obras sociales: el campo busca en el catálogo de prestadoras mientras
 *     se escribe; elegir una agrega con `addInsurerFromCatalog` (queda
 *     vinculada) y el copago se guarda después con `updateInsurer`. Sin
 *     elegir, se crea a mano como siempre (el catálogo puede estar vacío en
 *     un entorno sin import: entonces se sugieren los nombres comunes).
 */
import { useState, useTransition } from "react";
import { FormField } from "@/components/ui/form-field";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/ui/money-input";
import { Tag } from "@/components/ui/tag";
import { IconPlus, IconX } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { PracticePicker, type PickedPractice } from "@/components/configuracion/catalog/practice-picker";
import { useCatalogSearch } from "@/components/configuracion/catalog/use-catalog-search";
import { createService, deleteService } from "@/lib/services";
import { addInsurerFromCatalog, createInsurer, deleteInsurer, linkInsurerToPayer, updateInsurer } from "@/lib/insurers";
import { searchPayers } from "@/lib/catalog";
import { PAYER_KIND_LABEL, type PayerOption } from "@/lib/catalog-schemas";
import { STEP } from "@/lib/onboarding-logic";
import { formatARS } from "@/lib/format";
import type { OnboardingInsurer, OnboardingService } from "@/lib/onboarding-internal";
import { StepHeader } from "./onboarding-shell";
import { InlineError, ItemRow, StepFooter, useStepNav } from "./step-nav";

const DURATIONS = [30, 40, 45, 50, 60, 90];

// ── Servicios ────────────────────────────────────────────────────────────

export function StepServices({ services }: { services: OnboardingService[] }) {
  const { go, refresh } = useStepNav();
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [duration, setDuration] = useState("45");
  const [priceCents, setPriceCents] = useState<number | null>(null);
  const [priceInvalid, setPriceInvalid] = useState(false);
  const [cupo, setCupo] = useState("");
  const [practice, setPractice] = useState<PickedPractice | null>(null);
  // La duración sugerida por la práctica puede no estar en la lista corta.
  const durations = DURATIONS.includes(Number(duration))
    ? DURATIONS
    : [...DURATIONS, Number(duration)].sort((a, b) => a - b);

  const pickPractice = (p: PickedPractice | null) => {
    // Se sugiere, no se pisa: el nombre solo si estaba vacío o era el de la
    // práctica anterior; la duración, si la práctica trae una.
    setName((n) => (!n.trim() || n === practice?.name ? p?.name ?? "" : n));
    if (p?.defaultDurationMin) setDuration(String(p.defaultDurationMin));
    setPractice(p);
  };

  const add = () => {
    setError(null);
    if (!name.trim()) {
      setError("Poné un nombre al servicio.");
      return;
    }
    start(async () => {
      const r = await createService({
        name,
        durationMin: Number(duration),
        priceCents: priceCents ?? 0,
        maxConcurrent: cupo === "" ? null : Number(cupo),
        practiceId: practice?.id ?? null,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setName("");
      setPriceCents(null);
      setCupo("");
      setPractice(null);
      refresh();
    });
  };

  const remove = async (s: OnboardingService) => {
    if (!(await confirm({ title: `¿Quitar «${s.name}»?`, tone: "danger", confirmLabel: "Quitar" }))) return;
    start(async () => {
      const r = await deleteService(s.id);
      if (!r.ok) toast.error(r.error);
      refresh();
    });
  };

  return (
    <>
      <StepHeader
        eyebrow={`Paso ${STEP.services} · Servicios`}
        title="¿Qué servicios ofrecés?"
        blurb="Cada turno se da para un servicio: define la duración, el precio particular y cuántos pacientes atendés a la vez en ese horario. Si lo elegís del catálogo de prácticas, te sugerimos el nombre y la duración."
      />
      {services.length > 0 && (
        <div style={{ display: "grid", gap: 8, marginBottom: 18 }}>
          {services.map((s) => (
            <ItemRow
              key={s.id}
              title={s.name}
              meta={`${s.practiceName ? `${s.practiceName} · ` : ""}${s.durationMin} min · ${formatARS(s.priceCents)} · ${
                s.maxConcurrent == null ? "sin límite de cupo" : `${s.maxConcurrent} a la vez`
              }`}
              action={
                <Button type="button" variant="ghost" onClick={() => remove(s)} disabled={pending} aria-label={`Quitar ${s.name}`} style={{ padding: 8 }}>
                  <IconX size={14} />
                </Button>
              }
            />
          ))}
        </div>
      )}

      <div
        style={{
          display: "grid", gap: 12, padding: 16, borderRadius: 16,
          background: "rgba(255,255,255,0.55)", border: "1px dashed rgba(15,30,51,0.12)",
        }}
      >
        <PracticePicker value={practice} onChange={pickPractice} />
        <FormField label="Nombre del servicio" value={name} onChange={setName} placeholder="Sesión de kinesiología" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
          <FormField
            as="select"
            label="Duración"
            value={duration}
            onChange={setDuration}
            options={durations.map((d) => ({ value: String(d), label: `${d} min` }))}
          />
          <MoneyInput
            label="Precio particular"
            value={priceCents}
            onChange={setPriceCents}
            onInvalidChange={setPriceInvalid}
            hint="Lo que paga un paciente sin obra social."
          />
          <FormField
            as="select"
            label="Pacientes a la vez"
            tooltip="Kinesiología suele atender varios en paralelo; osteopatía, uno por turno."
            value={cupo}
            onChange={setCupo}
            options={[
              { value: "", label: "Sin límite" },
              ...[1, 2, 3, 4, 5, 6, 8, 10].map((n) => ({ value: String(n), label: n === 1 ? "1 (uno por turno)" : String(n) })),
            ]}
          />
        </div>
        <div>
          <Button type="button" variant="ghost" onClick={add} disabled={pending || priceInvalid}>
            <IconPlus size={14} /> Agregar servicio
          </Button>
        </div>
      </div>
      {error && <InlineError>{error}</InlineError>}
      {services.length === 0 && (
        <p style={{ fontSize: 12, color: "var(--navy-500)", margin: "12px 0 0" }}>
          Cargá al menos uno para seguir: la agenda y el turnero lo necesitan.
        </p>
      )}
      <StepFooter
        back={STEP.myHours}
        primaryLabel="Seguir"
        onPrimary={() => go(STEP.insurers)}
        pending={pending}
        disabled={services.length === 0}
      />
    </>
  );
}

// ── Obras sociales ────────────────────────────────────────────────────────────

/** Fallback si el catálogo no devuelve nada (entorno sin import): solo completan el nombre. */
const COMMON_INSURERS = ["OSDE", "Swiss Medical", "Galeno", "Medifé", "Omint", "Sancor Salud", "IOMA", "PAMI", "OSECAC", "Accord Salud"];
const SUGGEST_MAX = 6;

export function StepInsurers({ insurers }: { insurers: OnboardingInsurer[] }) {
  const { go, refresh } = useStepNav();
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  /** Prestadora del catálogo elegida para lo que está en el campo (null = a mano). */
  const [payer, setPayer] = useState<PayerOption | null>(null);
  const [copago, setCopago] = useState<number | null>(null);
  const [invalid, setInvalid] = useState(false);
  const particular = insurers.find((i) => i.isParticular) ?? null;
  const [particularPrice, setParticularPrice] = useState<number | null>(particular?.copagoCents || null);
  const others = insurers.filter((i) => !i.isParticular);

  const q = name.trim();
  const searching = q.length >= 2 && !payer;
  const { results, loading } = useCatalogSearch(searchPayers, q, searching);
  const already = (n: string) => others.some((o) => o.name.toLowerCase() === n.toLowerCase());
  const catalogHits = searching ? results.filter((p) => !already(p.name)).slice(0, SUGGEST_MAX) : [];
  const fallbackHits =
    searching && !loading && catalogHits.length === 0 && results.length === 0
      ? COMMON_INSURERS.filter((n) => n.toLowerCase().includes(q.toLowerCase()) && n.toLowerCase() !== q.toLowerCase() && !already(n)).slice(0, SUGGEST_MAX)
      : [];

  const resetForm = () => {
    setName("");
    setPayer(null);
    setCopago(null);
  };

  const add = () => {
    setError(null);
    if (!q) {
      setError("Escribí el nombre de la obra social.");
      return;
    }
    start(async () => {
      if (!payer) {
        const r = await createInsurer({ name, copagoCents: copago ?? 0, fixedFeeCents: 0 });
        if (!r.ok) {
          setError(r.error);
          return;
        }
        resetForm();
        refresh();
        return;
      }
      const r = await addInsurerFromCatalog(payer.id);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      if (r.data.status === "exists") {
        // Ya estaba cargada a mano con el mismo nombre: se vincula (si no lo
        // estaba) y NO se pisa su copago sin que el usuario lo vea.
        if (!r.data.linkedPayerId) await linkInsurerToPayer(r.data.insurerId, payer.id);
        toast.info(`«${payer.name}» ya estaba en tu lista`, { description: "No cambiamos su copago." });
      } else if ((copago ?? 0) > 0) {
        // Del catálogo nace con copago 0 (lib/insurers.ts): se completa acá.
        const u = await updateInsurer(r.data.insurerId, { copagoCents: copago ?? 0 });
        if (!u.ok) toast.error("La agregamos, pero no pudimos guardar el copago", { description: u.error });
      }
      resetForm();
      refresh();
    });
  };

  const remove = async (i: OnboardingInsurer) => {
    if (!(await confirm({ title: `¿Quitar «${i.name}»?`, tone: "danger", confirmLabel: "Quitar" }))) return;
    start(async () => {
      const r = await deleteInsurer(i.id);
      if (!r.ok) toast.error(r.error);
      refresh();
    });
  };

  const next = () => {
    setError(null);
    // El precio de "Particular" se guarda al seguir (solo si cambió).
    if (particular && (particularPrice ?? 0) !== particular.copagoCents) {
      start(async () => {
        const r = await updateInsurer(particular.id, { copagoCents: particularPrice ?? 0 });
        if (!r.ok) {
          setError(r.error);
          return;
        }
        go(STEP.team);
      });
      return;
    }
    go(STEP.team);
  };

  return (
    <>
      <StepHeader
        eyebrow={`Paso ${STEP.insurers} · Obras sociales`}
        title="¿Con qué obras sociales trabajás?"
        blurb="«Particular» ya está creada para los pacientes sin cobertura. Buscá las obras sociales y prepagas en el catálogo y cargá su copago; el resto de los valores se ajusta en Configuración."
      />
      <div style={{ display: "grid", gap: 8, marginBottom: 18 }}>
        {particular && (
          <ItemRow
            title="Particular"
            meta="Pacientes sin obra social"
            action={
              <MoneyInput
                variant="compact"
                ariaLabel="Precio particular"
                width={140}
                value={particularPrice}
                onChange={setParticularPrice}
                onInvalidChange={setInvalid}
              />
            }
          />
        )}
        {others.map((i) => (
          <ItemRow
            key={i.id}
            title={i.name}
            meta={i.copagoCents > 0 ? `Copago ${formatARS(i.copagoCents)}` : "Sin copago"}
            action={
              <Button type="button" variant="ghost" onClick={() => remove(i)} disabled={pending} aria-label={`Quitar ${i.name}`} style={{ padding: 8 }}>
                <IconX size={14} />
              </Button>
            }
          />
        ))}
      </div>

      <div
        style={{
          display: "grid", gap: 12, padding: 16, borderRadius: 16,
          background: "rgba(255,255,255,0.55)", border: "1px dashed rgba(15,30,51,0.12)",
        }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <label style={{ display: "block", fontSize: 12, minWidth: 0 }}>
              <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>Obra social o prepaga</span>
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  // Editar el texto suelta la prestadora elegida: lo que se
                  // crea tiene que ser lo que se ve en el campo.
                  if (payer) setPayer(null);
                }}
                placeholder="Buscá: OSDE, IOMA, Unión Personal…"
                autoComplete="off"
                aria-describedby="onb-insurer-hint"
                style={{
                  marginTop: 6, padding: "10px 12px", borderRadius: 12, background: "rgba(255,255,255,0.96)",
                  border: "1px solid rgba(15,30,51,0.08)", width: "100%", fontSize: 16, color: "var(--navy-900)", outline: "none",
                }}
              />
            </label>
            <div id="onb-insurer-hint" style={{ fontSize: 12, color: "var(--navy-500)", marginTop: 6 }}>
              {payer ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <Tag tone="lime">Del catálogo</Tag>
                  {PAYER_KIND_LABEL[payer.kind]}
                  {payer.province ? ` · ${payer.province}` : ""}
                </span>
              ) : searching && loading ? (
                "Buscando en el catálogo…"
              ) : q.length >= 2 && catalogHits.length === 0 ? (
                "No está en el catálogo: se carga con el nombre que escribiste."
              ) : (
                "Elegila de la lista para que quede vinculada al catálogo."
              )}
            </div>
            {(catalogHits.length > 0 || fallbackHits.length > 0) && (
              <div role="listbox" aria-label="Sugerencias" style={{ display: "grid", gap: 4, marginTop: 8 }}>
                {catalogHits.map((p) => (
                  <SuggestionButton
                    key={p.id}
                    onClick={() => {
                      setPayer(p);
                      setName(p.name);
                    }}
                    title={p.name}
                    meta={`${PAYER_KIND_LABEL[p.kind]}${p.province ? ` · ${p.province}` : ""}`}
                  />
                ))}
                {fallbackHits.map((n) => (
                  <SuggestionButton key={n} onClick={() => setName(n)} title={n} />
                ))}
              </div>
            )}
          </div>
          <MoneyInput label="Copago" value={copago} onChange={setCopago} onInvalidChange={setInvalid} hint="Lo que paga el paciente por sesión." />
        </div>
        <div>
          <Button type="button" variant="ghost" onClick={add} disabled={pending || invalid}>
            <IconPlus size={14} /> Agregar obra social
          </Button>
        </div>
      </div>
      {error && <InlineError>{error}</InlineError>}
      <StepFooter back={STEP.services} primaryLabel={others.length ? "Seguir" : "Seguir solo con Particular"} onPrimary={next} pending={pending} disabled={invalid} />
    </>
  );
}

/** Fila de sugerencia: alto táctil de 44 px, el nombre primero. */
function SuggestionButton({ title, meta, onClick }: { title: string; meta?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={false}
      onClick={onClick}
      style={{
        textAlign: "left", minHeight: 44, padding: "8px 12px", borderRadius: 12,
        border: "1px solid rgba(31,79,190,0.15)", background: "rgba(31,79,190,0.04)", cursor: "pointer",
        display: "flex", alignItems: "center", gap: 8,
      }}
    >
      <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: "var(--navy-900)" }}>{title}</span>
      {meta && <span style={{ fontSize: 11.5, color: "var(--navy-500)", flexShrink: 0 }}>{meta}</span>}
    </button>
  );
}

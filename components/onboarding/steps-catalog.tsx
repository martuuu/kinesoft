"use client";

/**
 * Pasos 4 (servicios) y 5 (obras sociales) del alta (A3c-S-signup). Reusan
 * las actions de Configuración (`createService`, `createInsurer`, …): el
 * OWNER ya tiene Actor desde el paso 2. La lista sale de la DB (re-entrar
 * muestra lo cargado, nunca lo vuelve a crear).
 */
import { useState, useTransition } from "react";
import { FormField } from "@/components/ui/form-field";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/ui/money-input";
import { IconPlus, IconX } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { createService, deleteService } from "@/lib/services";
import { createInsurer, deleteInsurer, updateInsurer } from "@/lib/insurers";
import { formatARS } from "@/lib/format";
import type { OnboardingInsurer, OnboardingService } from "@/lib/onboarding-internal";
import { StepHeader } from "./onboarding-shell";
import { InlineError, ItemRow, StepFooter, useStepNav } from "./step-nav";

const DURATIONS = [30, 40, 45, 50, 60, 90];

// ── Paso 4 ────────────────────────────────────────────────────────────

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
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setName("");
      setPriceCents(null);
      setCupo("");
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
        eyebrow="Paso 4 · Servicios"
        title="¿Qué servicios ofrecés?"
        blurb="Cada turno se da para un servicio: define la duración, el precio particular y cuántos pacientes atendés a la vez en ese horario."
      />
      {services.length > 0 && (
        <div style={{ display: "grid", gap: 8, marginBottom: 18 }}>
          {services.map((s) => (
            <ItemRow
              key={s.id}
              title={s.name}
              meta={`${s.durationMin} min · ${formatARS(s.priceCents)} · ${
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
        <FormField label="Servicio" value={name} onChange={setName} placeholder="Sesión de kinesiología" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
          <FormField
            as="select"
            label="Duración"
            value={duration}
            onChange={setDuration}
            options={DURATIONS.map((d) => ({ value: String(d), label: `${d} min` }))}
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
        back={3}
        primaryLabel="Seguir"
        onPrimary={() => go(5)}
        pending={pending}
        disabled={services.length === 0}
      />
    </>
  );
}

// ── Paso 5 ────────────────────────────────────────────────────────────

/** Sugerencias para tipear rápido (datalist): no se crean solas. */
const COMMON_INSURERS = ["OSDE", "Swiss Medical", "Galeno", "Medifé", "Omint", "Sancor Salud", "IOMA", "PAMI", "OSECAC", "Accord Salud"];

export function StepInsurers({ insurers }: { insurers: OnboardingInsurer[] }) {
  const { go, refresh } = useStepNav();
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [copago, setCopago] = useState<number | null>(null);
  const [invalid, setInvalid] = useState(false);
  const particular = insurers.find((i) => i.isParticular) ?? null;
  const [particularPrice, setParticularPrice] = useState<number | null>(particular?.copagoCents || null);
  const others = insurers.filter((i) => !i.isParticular);

  const add = () => {
    setError(null);
    if (!name.trim()) {
      setError("Escribí el nombre de la obra social.");
      return;
    }
    start(async () => {
      const r = await createInsurer({ name, copagoCents: copago ?? 0, fixedFeeCents: 0 });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setName("");
      setCopago(null);
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
        go(6);
      });
      return;
    }
    go(6);
  };

  return (
    <>
      <StepHeader
        eyebrow="Paso 5 · Obras sociales"
        title="¿Con qué obras sociales trabajás?"
        blurb="«Particular» ya está creada para los pacientes sin cobertura. Sumá las obras sociales con su copago; el resto de los valores se ajusta en Configuración."
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
          <label style={{ display: "block", fontSize: 12, minWidth: 0 }}>
            <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>Obra social</span>
            <input
              list="onb-insurers"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="OSDE"
              style={{
                marginTop: 6, padding: "10px 12px", borderRadius: 12, background: "rgba(255,255,255,0.96)",
                border: "1px solid rgba(15,30,51,0.08)", width: "100%", fontSize: 14, color: "var(--navy-900)", outline: "none",
              }}
            />
            <datalist id="onb-insurers">
              {COMMON_INSURERS.filter((n) => !others.some((o) => o.name.toLowerCase() === n.toLowerCase())).map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </label>
          <MoneyInput label="Copago" value={copago} onChange={setCopago} onInvalidChange={setInvalid} hint="Lo que paga el paciente por sesión." />
        </div>
        <div>
          <Button type="button" variant="ghost" onClick={add} disabled={pending || invalid}>
            <IconPlus size={14} /> Agregar obra social
          </Button>
        </div>
      </div>
      {error && <InlineError>{error}</InlineError>}
      <StepFooter back={4} primaryLabel={others.length ? "Seguir" : "Seguir solo con Particular"} onPrimary={next} pending={pending} disabled={invalid} />
    </>
  );
}

"use client";

/**
 * Public booking wizard — what a stranger sees at `/c/<slug>/booking`.
 *
 * Steps:
 *   1. Profesional (skip if only one) — con filtros opcionales de sede y
 *      cobertura y la opción "Primer turno disponible" (B5.6)
 *   2. Servicio (los que ofrece el profesional: `practitionerIds`)
 *   3. Fecha + hora: grilla de `listPublicSlots`, o en modo "cualquiera" el
 *      primer horario libre de `findFirstPublicSlot`
 *   4. Tus datos — Google sign-in or HC form
 *   5. Confirmación + redirección a Mercado Pago
 *
 * The component is responsive: on desktop the steps run as a 2-column
 * layout (form left + summary right); on mobile they're a stack. State
 * is fully client-side; submission goes through the `submitPublicBooking`
 * server action which creates Patient + Booking + MP preference.
 * La lógica pura (filtros, rotación de la key, selección "cualquiera") está
 * en `lib/public-wizard-state.ts` con sus unit tests.
 */
import { useMemo, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { KineLogo } from "@/components/ui/kine-logo";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { IconArrow, IconCheck, IconChevL, IconChevR, IconClock } from "@/components/ui/icons";
import { listPublicSlots, submitPublicBooking } from "@/lib/public-booking";
import { toARDateKey } from "@/lib/datetime-ar";
import type { PublicClinic, PublicLocation, PublicSlot, PrefillPatient } from "@/lib/public-booking-types";
import type { TenantVertical } from "@prisma/client";
import {
  attemptSignature,
  coverageInsurerPrefill,
  durationFor,
  filterPractitioners,
  findLocation,
  formatLocationAddress,
  locationsForPractitioner,
  nextAttempt,
  reconcileSelection,
  servicesForAny,
  servicesForPractitioner,
  type Attempt,
  type WizardFilters,
  type WizardSelection,
} from "@/lib/public-wizard-state";
import { PractitionerStep } from "./wizard/practitioner-step";
import { FirstSlotStep } from "./wizard/first-slot-step";
import { EmptyBox, StepHeader, choiceStyle, formatWhenAR } from "./wizard/shared";

type PatientHC = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  documentId: string;
  dateOfBirth: string;
  coverageInsurer: string;
  coveragePlan: string;
  emergencyName: string;
  emergencyPhone: string;
  notes: string;
  title: string;
  description: string;
};

const EMPTY_HC: PatientHC = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  documentId: "",
  dateOfBirth: "",
  coverageInsurer: "",
  coveragePlan: "",
  emergencyName: "",
  emergencyPhone: "",
  notes: "",
  title: "",
  description: "",
};

const STEPS = ["Profesional", "Servicio", "Fecha y hora", "Tus datos"] as const;
type Step = 0 | 1 | 2 | 3;

/**
 * Ajustes mobile-first propios del wizard. `app/globals.css` (≤1024 px)
 * pone `flex-direction: column` a `.booking-body`, pero el body es un GRID
 * de 2 columnas (form + resumen de 360 px): a 375 px desbordaba en
 * horizontal. Acá se apila; el resto achica márgenes y pasa a 1 columna las
 * grillas de tarjetas/campos en pantallas angostas.
 */
const RESPONSIVE_CSS = `
@media (max-width: 1024px) {
  .booking-body { grid-template-columns: minmax(0, 1fr) !important; }
}
@media (max-width: 560px) {
  .booking-nav { margin: 12px 12px 0 !important; padding: 10px 14px !important; }
  .booking-head { padding: 20px 16px 14px !important; }
  .booking-head h1 { font-size: 26px !important; }
  .booking-card { padding: 16px !important; }
  .booking-grid-2 { grid-template-columns: minmax(0, 1fr) !important; }
}
`;

/**
 * EV1-C2: la vertical del consultorio, para el copy (Clínica general no es
 * kinesiología). Opcional: sin ella (o antes de que `getPublicClinic` la sume
 * a `PublicClinic`) el wizard muestra el copy de Kinesiología de siempre.
 */
type WizardClinic = PublicClinic & { vertical?: TenantVertical | null };

export function PublicBookingWizard({
  clinic,
  session,
  prefill,
}: {
  clinic: WizardClinic;
  session: { email: string; fullName: string | null } | null;
  prefill: PrefillPatient | null;
}) {
  const singlePractitioner = clinic.practitioners.length === 1;
  const firstStep: Step = singlePractitioner ? 1 : 0;
  const [step, setStep] = useState<Step>(firstStep);
  // "pick" = eligió profesional; "any" = primer turno disponible con
  // cualquiera (el profesional lo resuelve `findFirstPublicSlot` en el paso 3).
  const [mode, setMode] = useState<"pick" | "any">("pick");
  const [filters, setFilters] = useState<WizardFilters>({ insurerId: null, locationId: null });
  const [practitionerId, setPractitionerId] = useState<string | null>(
    singlePractitioner ? clinic.practitioners[0].id : null
  );
  const [serviceId, setServiceId] = useState<string | null>(null);
  // Hoy en calendario AR: `toISOString().slice(0,10)` pasadas las 21:00 AR
  // (00:00 UTC) arrancaba el wizard en mañana.
  const [dateISO, setDateISO] = useState<string>(() => toARDateKey(new Date()));
  const [slotISO, setSlotISO] = useState<string | null>(null);
  // Sede del horario elegido (cada slot la trae; el submit la asigna sola en
  // el server: es solo para mostrar la dirección).
  const [slotLocationId, setSlotLocationId] = useState<string | null>(null);
  const [hc, setHc] = useState<PatientHC>(() => {
    if (prefill) return { ...EMPTY_HC, ...prefill };
    if (session) {
      const [first, ...rest] = (session.fullName ?? "").split(" ");
      return {
        ...EMPTY_HC,
        email: session.email,
        firstName: first ?? "",
        lastName: rest.join(" ") ?? "",
      };
    }
    return EMPTY_HC;
  });

  // Key de idempotencia POR INTENTO de este wizard (A2b-S-pub): un doble
  // click o un reintento tras un error de Mercado Pago reencuentran el mismo
  // turno; si el paciente cambia profesional/servicio/horario es otro intento
  // → key nueva (el server rechaza una key reusada con otros datos).
  // También aplica a "cualquier profesional": la firma usa el profesional que
  // devolvió `findFirstPublicSlot`.
  const attemptRef = useRef<Attempt | null>(null);
  const keyFor = (sig: string) => {
    attemptRef.current = nextAttempt(attemptRef.current, sig, newIdempotencyKey);
    return attemptRef.current.key;
  };

  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const practitioner = clinic.practitioners.find((p) => p.id === practitionerId) ?? null;
  const service = clinic.services.find((s) => s.id === serviceId) ?? null;

  // Servicios del profesional elegido (`practitionerIds`, B3.2). En modo
  // "cualquiera": los que ofrece al menos un profesional que pasa los filtros.
  const visibleServices = useMemo(() => {
    if (mode === "any") return servicesForAny(clinic, filters);
    if (!practitionerId) return clinic.services;
    return servicesForPractitioner(clinic, practitionerId);
  }, [mode, practitionerId, filters, clinic]);

  const setSlot = (iso: string | null, locationId: string | null) => {
    setSlotISO(iso);
    setSlotLocationId(iso ? locationId : null);
  };

  const changeFilters = (next: WizardFilters) => {
    setFilters(next);
    // "Cualquiera" solo se ofrece con 2+ profesionales filtrados: si el
    // filtro deja uno o ninguno, la opción desaparece y no puede quedar
    // elegida sin verse.
    if (mode === "any" && filterPractitioners(clinic, next).length <= 1) setMode("pick");
    const kept = reconcileSelection(clinic, next, {
      practitionerId: mode === "pick" ? practitionerId : null,
      serviceId,
    });
    if (mode === "pick") setPractitionerId(kept.practitionerId);
    setServiceId(kept.serviceId);
    setSlot(null, null);
  };

  const pickPractitioner = (id: string) => {
    setMode("pick");
    setPractitionerId(id);
    if (serviceId && !servicesForPractitioner(clinic, id).some((s) => s.id === serviceId)) {
      setServiceId(null);
    }
    setSlot(null, null);
  };

  const pickAny = () => {
    setMode("any");
    setPractitionerId(null);
    if (serviceId && !servicesForAny(clinic, filters).some((s) => s.id === serviceId)) {
      setServiceId(null);
    }
    setSlot(null, null);
  };

  const applyFirstSlot = (sel: WizardSelection) => {
    setPractitionerId(sel.practitionerId);
    setDateISO(sel.dateISO);
    setSlot(sel.slotISO, sel.slotLocationId);
  };

  const canAdvance =
    (step === 0 && (mode === "any" || !!practitionerId)) ||
    (step === 1 && !!serviceId) ||
    (step === 2 && !!slotISO && !!practitionerId) ||
    (step === 3 && isHcValid(hc));

  const next = () => {
    if (!canAdvance) return;
    if (step === 3) {
      submit();
      return;
    }
    if (step === 2) {
      // Si filtró por una obra social, la precargamos en "Tus datos" (sin
      // pisar lo que ya haya: prefill o lo que escribió).
      setHc((h) => ({ ...h, coverageInsurer: coverageInsurerPrefill(h.coverageInsurer, clinic, filters.insurerId) }));
    }
    setStep((s) => (Math.min(3, s + 1) as Step));
  };
  const back = () => setStep((s) => Math.max(firstStep, s - 1) as Step);

  const submit = () => {
    setError(null);
    if (!practitionerId || !serviceId || !slotISO) {
      setError("Faltan datos para confirmar.");
      return;
    }
    start(async () => {
      const r = await submitPublicBooking({
        tenantSlug: clinic.slug,
        idempotencyKey: keyFor(attemptSignature({ practitionerId, serviceId, slotISO })),
        practitionerId,
        serviceId,
        scheduledFor: slotISO,
        patient: {
          ...hc,
          email: hc.email.trim().toLowerCase(),
        },
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Redirect to Mercado Pago.
      window.location.href = r.data.initPoint;
    });
  };

  return (
    <div
      className="k-app booking-root"
      style={{
        minHeight: "100vh",
        background: "var(--bg-app)",
        position: "relative",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <style>{RESPONSIVE_CSS}</style>
      <Ambient />
      <Nav clinic={clinic} session={session} />
      <Header clinic={clinic} step={step} />

      <main
        className="booking-body"
        style={{
          flex: 1,
          padding: "0 24px 36px",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 360px",
          gap: 20,
          maxWidth: 1280,
          width: "100%",
          margin: "0 auto",
          alignSelf: "center",
          minHeight: 0,
        }}
      >
        <Card
          glass
          className="booking-card"
          style={{
            padding: 24,
            display: "flex",
            flexDirection: "column",
            gap: 18,
            minHeight: 0,
            minWidth: 0,
          }}
        >
          {step === 0 && (
            <PractitionerStep
              clinic={clinic}
              filters={filters}
              onFiltersChange={changeFilters}
              mode={mode}
              value={practitionerId}
              onPick={pickPractitioner}
              onAny={pickAny}
            />
          )}
          {step === 1 && (
            <ServiceStep
              services={visibleServices}
              practitionerId={mode === "pick" ? practitionerId : null}
              value={serviceId}
              onChange={(id) => {
                setServiceId(id);
                // changing service might invalidate the slot
                setSlot(null, null);
                // En modo "cualquiera" el profesional sale del servicio.
                if (mode === "any") setPractitionerId(null);
              }}
            />
          )}
          {step === 2 && mode === "pick" && practitionerId && serviceId && (
            <SlotStep
              tenantSlug={clinic.slug}
              practitionerId={practitionerId}
              serviceId={serviceId}
              locations={locationsForPractitioner(clinic, practitionerId)}
              locationId={filters.locationId}
              onLocationChange={(locationId) => {
                // La sede de la grilla ES el filtro del paso 1: un solo estado.
                setFilters((f) => ({ ...f, locationId }));
                setSlot(null, null);
              }}
              dateISO={dateISO}
              setDateISO={setDateISO}
              slotISO={slotISO}
              setSlot={setSlot}
            />
          )}
          {step === 2 && mode === "any" && serviceId && (
            <FirstSlotStep
              clinic={clinic}
              serviceId={serviceId}
              filters={filters}
              onFound={applyFirstSlot}
              onClear={() => {
                setPractitionerId(null);
                setSlot(null, null);
              }}
              onPickPractitioner={() => {
                setMode("pick");
                setPractitionerId(null);
                setSlot(null, null);
                setStep(firstStep);
              }}
              onMoreTimes={() => {
                // Queda el profesional, el día y el horario encontrados; la
                // grilla los muestra y permite cambiar.
                setMode("pick");
              }}
            />
          )}
          {step === 3 && (
            <DataStep
              clinic={clinic}
              session={session}
              hc={hc}
              setHc={setHc}
              error={error}
            />
          )}

          <footer
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              marginTop: "auto",
              paddingTop: 6,
            }}
          >
            {step > firstStep ? (
              <Button variant="ghost" onClick={back} disabled={pending}>
                <IconChevL size={12} /> Atrás
              </Button>
            ) : (
              <span />
            )}
            <Button
              variant="primary"
              onClick={next}
              disabled={!canAdvance || pending}
              style={{ padding: "12px 20px", fontSize: 14 }}
            >
              {step === 3
                ? pending
                  ? "Redirigiendo…"
                  : "Pagar y reservar"
                : "Continuar"}{" "}
              <IconArrow size={14} />
            </Button>
          </footer>
        </Card>

        <SummaryAside
          clinic={clinic}
          practitioner={practitioner}
          anyPractitioner={mode === "any"}
          service={service}
          slotISO={slotISO}
          location={findLocation(clinic, slotLocationId)}
        />
      </main>
    </div>
  );
}

/** UUID v4 (el server lo valida). `randomUUID` exige contexto seguro; fallback a `getRandomValues`. */
function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function isHcValid(hc: PatientHC) {
  return (
    hc.firstName.trim().length > 0 &&
    hc.lastName.trim().length > 0 &&
    hc.email.includes("@") &&
    hc.phone.trim().length >= 6 &&
    hc.documentId.trim().length >= 4 &&
    hc.dateOfBirth.length === 10
  );
}

function Ambient() {
  return (
    <>
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: -100,
          right: -60,
          width: 380,
          height: 380,
          borderRadius: "50%",
          background: "radial-gradient(circle, var(--sky-300), transparent 70%)",
          opacity: 0.5,
          filter: "blur(10px)",
          pointerEvents: "none",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          bottom: -120,
          left: -80,
          width: 360,
          height: 360,
          borderRadius: "50%",
          background: "radial-gradient(circle, var(--lime-300), transparent 65%)",
          opacity: 0.35,
          filter: "blur(20px)",
          pointerEvents: "none",
        }}
      />
    </>
  );
}

function Nav({ clinic, session }: { clinic: PublicClinic; session: { email: string } | null }) {
  return (
    <header
      className="k-glass booking-nav"
      style={{
        margin: "18px 24px 0",
        padding: "12px 20px",
        borderRadius: 999,
        display: "flex",
        alignItems: "center",
        gap: 16,
        position: "relative",
        zIndex: 5,
        flexWrap: "wrap",
      }}
    >
      <KineLogo size={24} />
      <span style={{ fontSize: 12, color: "var(--navy-300)" }}>· {clinic.name}</span>
      <div style={{ flex: 1 }} />
      <span
        style={{
          fontSize: 12.5,
          color: "var(--navy-500)",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <IconClock size={13} /> lun-sáb 8 a 19hs
      </span>
      {session ? (
        <Link
          href="/portal"
          style={{ fontSize: 12.5, color: "var(--sky-700)", fontWeight: 600, textDecoration: "none" }}
        >
          Mis turnos
        </Link>
      ) : (
        // A3b-S-auth: /api/auth/google solo acepta POST (un <Link> GET daba 405).
        <form
          action={`/api/auth/google?next=${encodeURIComponent(`/c/${clinic.slug}/booking`)}`}
          method="post"
          style={{ margin: 0 }}
        >
          <button
            type="submit"
            style={{
              padding: "7px 14px",
              borderRadius: 999,
              background: "rgba(255,255,255,0.7)",
              border: "1px solid rgba(15,30,51,0.08)",
              fontSize: 12,
              color: "var(--navy-900)",
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Iniciar sesión
          </button>
        </form>
      )}
    </header>
  );
}

function Header({ clinic, step }: { clinic: PublicClinic; step: Step }) {
  return (
    <div className="booking-head" style={{ padding: "28px 24px 18px", position: "relative", zIndex: 4 }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--sky-700)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {clinic.name}
      </div>
      <h1
        className="k-display"
        style={{ fontSize: 32, margin: "4px 0 18px", letterSpacing: "-0.03em" }}
      >
        Reservá tu turno en 30 segundos
      </h1>
      <Steps step={step} hidePractitioner={clinic.practitioners.length === 1} />
    </div>
  );
}

function Steps({ step, hidePractitioner }: { step: Step; hidePractitioner: boolean }) {
  const items = STEPS.filter((_, i) => !(hidePractitioner && i === 0));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      {items.map((label, idx) => {
        const i = hidePractitioner ? idx + 1 : idx;
        const done = step > i;
        const active = step === i;
        return (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                width: 26,
                height: 26,
                borderRadius: "50%",
                background: active
                  ? "var(--sky-700)"
                  : done
                    ? "var(--lime-300)"
                    : "rgba(255,255,255,0.5)",
                color: active ? "#fff" : "var(--navy-900)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                fontWeight: 700,
                border: active ? "none" : "1px solid rgba(15,30,51,0.08)",
              }}
            >
              {done ? <IconCheck size={12} stroke={3} /> : i + 1}
            </span>
            <span
              style={{
                fontSize: 12,
                fontWeight: active ? 700 : 500,
                color: active ? "var(--navy-900)" : done ? "var(--navy-700)" : "var(--navy-300)",
              }}
            >
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Step 0 ─ Practitioner: components/booking/wizard/practitioner-step.tsx

// ─── Step 1 ─ Service ──────────────────────────────────────────────────
function ServiceStep({
  services,
  practitionerId,
  value,
  onChange,
}: {
  services: PublicClinic["services"];
  /** Para la duración por profesional; null = modo "cualquiera". */
  practitionerId: string | null;
  value: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <>
      <StepHeader title="¿Qué servicio necesitás?" subtitle="Cada servicio tiene su duración + precio." />
      {services.length === 0 ? (
        <EmptyBox>No hay servicios para reservar online con esta elección. Volvé y probá otra.</EmptyBox>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {services.map((s) => {
            const on = s.id === value;
            return (
              <button
                key={s.id}
                type="button"
                aria-pressed={on}
                onClick={() => onChange(s.id)}
                style={{
                  ...choiceStyle(on),
                  padding: "14px 16px",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{s.name}</div>
                  {s.description && (
                    <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>{s.description}</div>
                  )}
                  <div className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)", marginTop: 4 }}>
                    {durationFor(s, practitionerId)} min
                  </div>
                </div>
                <div className="k-display" style={{ fontSize: 18, fontWeight: 700, whiteSpace: "nowrap" }}>
                  {fmtArs(s.priceCents)}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

// ─── Step 2 ─ Slot ─────────────────────────────────────────────────────
function SlotStep({
  tenantSlug,
  practitionerId,
  serviceId,
  locations,
  locationId,
  onLocationChange,
  dateISO,
  setDateISO,
  slotISO,
  setSlot,
}: {
  tenantSlug: string;
  practitionerId: string;
  serviceId: string;
  /** Sedes donde atiende el profesional (orden del consultorio). */
  locations: PublicLocation[];
  /** Sede elegida (null = todas). */
  locationId: string | null;
  onLocationChange: (id: string | null) => void;
  dateISO: string;
  setDateISO: (v: string) => void;
  slotISO: string | null;
  setSlot: (iso: string | null, locationId: string | null) => void;
}) {
  const [slots, setSlots] = useState<PublicSlot[]>([]);
  const [loading, setLoading] = useState(false);
  // null = ok; "rate" = throttled ("esperá"), distinct from an empty day.
  const [slotError, setSlotError] = useState<"rate" | null>(null);
  // Sede filtrada que el profesional no tiene (filtro viejo): no se manda.
  const effectiveLocationId = locationId && locations.some((l) => l.id === locationId) ? locationId : null;
  const multiLoc = locations.length > 1;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSlotError(null);
    listPublicSlots({
      tenantSlug,
      practitionerId,
      serviceId,
      date: dateISO,
      ...(effectiveLocationId ? { locationId: effectiveLocationId } : {}),
    })
      .then((rows) => {
        if (cancelled) return;
        setSlots(rows);
        const still = slotISO ? rows.find((r) => r.iso === slotISO && r.available) : null;
        if (slotISO && !still) setSlot(null, null);
        else if (still) setSlot(still.iso, still.locationId ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setSlots([]);
        setSlotError("rate");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantSlug, practitionerId, serviceId, dateISO, effectiveLocationId]);

  const shiftDate = (delta: number) => {
    // Date-only arithmetic anchored at noon UTC so ±1 day never crosses a
    // date boundary because of the browser's timezone.
    const d = new Date(`${dateISO}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + delta);
    setDateISO(d.toISOString().slice(0, 10));
    setSlot(null, null);
  };

  // "Today" in AR calendar terms — a late-night browser must not roll to
  // tomorrow (toISOString would, once past 21:00 AR = 00:00 UTC).
  const todayKey = toARDateKey(new Date());
  const selected = new Date(`${dateISO}T12:00:00Z`);
  const locName = (id: string | null | undefined) => locations.find((l) => l.id === id)?.name ?? null;
  return (
    <>
      <StepHeader title="Elegí día y horario" subtitle="Mostramos sólo los slots disponibles." />
      {multiLoc && (
        <div role="group" aria-label="Sede" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[{ id: null as string | null, name: "Todas las sedes" }, ...locations].map((l) => {
            const on = effectiveLocationId === l.id;
            return (
              <button
                key={l.id ?? "all"}
                type="button"
                aria-pressed={on}
                onClick={() => onLocationChange(l.id)}
                style={{
                  ...choiceStyle(on),
                  padding: "8px 14px",
                  borderRadius: 999,
                  fontSize: 12.5,
                  fontWeight: 600,
                  minHeight: 36,
                }}
              >
                {l.name}
              </button>
            );
          })}
        </div>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "10px 14px",
          borderRadius: 999,
          background: "rgba(255,255,255,0.6)",
          border: "1px solid rgba(15,30,51,0.06)",
        }}
      >
        <button
          type="button"
          onClick={() => shiftDate(-1)}
          aria-label="Día anterior"
          disabled={dateISO <= todayKey}
          style={navBtn}
        >
          <IconChevL size={14} />
        </button>
        <div style={{ textAlign: "center" }}>
          <div className="k-display" style={{ fontSize: 16, fontWeight: 700 }}>
            {selected.toLocaleDateString("es-AR", {
              weekday: "long",
              day: "2-digit",
              month: "long",
              timeZone: "America/Argentina/Buenos_Aires",
            })}
          </div>
          <input
            type="date"
            value={dateISO}
            min={todayKey}
            onChange={(e) => {
              setDateISO(e.target.value);
              setSlot(null, null);
            }}
            style={{
              border: "none",
              background: "transparent",
              fontSize: 11.5,
              color: "var(--navy-500)",
              textAlign: "center",
              outline: "none",
            }}
          />
        </div>
        <button
          type="button"
          onClick={() => shiftDate(1)}
          aria-label="Día siguiente"
          style={navBtn}
        >
          <IconChevR size={14} />
        </button>
      </div>

      {loading ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--navy-300)", fontSize: 13 }}>
          Buscando horarios…
        </div>
      ) : slotError === "rate" ? (
        <EmptyBox>Demasiadas consultas seguidas. Esperá unos segundos y reintentá.</EmptyBox>
      ) : slots.length === 0 ? (
        <EmptyBox>
          {effectiveLocationId
            ? "No hay horarios en esta sede este día. Probá otro día u otra sede."
            : "El centro no atiende este día. Probá otro."}
        </EmptyBox>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(78px, 1fr))",
            gap: 8,
          }}
        >
          {slots.map((s) => {
            const on = s.iso === slotISO;
            // Con varias sedes y sin filtrar, cada horario dice dónde es.
            const where = multiLoc && !effectiveLocationId ? locName(s.locationId) : null;
            return (
              <button
                key={s.iso}
                type="button"
                onClick={() => s.available && setSlot(s.iso, s.locationId ?? null)}
                disabled={!s.available}
                aria-pressed={on}
                style={{
                  padding: "12px 8px",
                  borderRadius: 12,
                  border: "1px solid " +
                    (on
                      ? "transparent"
                      : s.available
                        ? "rgba(15,30,51,0.06)"
                        : "transparent"),
                  background: on
                    ? "var(--sky-700)"
                    : s.available
                      ? "rgba(255,255,255,0.7)"
                      : "rgba(15,30,51,0.04)",
                  color: on ? "#fff" : s.available ? "var(--navy-900)" : "var(--navy-200)",
                  boxShadow: on ? "0 8px 18px rgba(31,79,190,0.28)" : "none",
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: "JetBrains Mono, ui-monospace, monospace",
                  textDecoration: s.available ? "none" : "line-through",
                  cursor: s.available ? "pointer" : "not-allowed",
                  minHeight: 44,
                }}
              >
                {s.time}
                {where && (
                  <span
                    style={{
                      display: "block",
                      fontFamily: "inherit",
                      fontSize: 10,
                      fontWeight: 500,
                      marginTop: 2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {where}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

// ─── Step 3 ─ Patient HC ──────────────────────────────────────────────
function DataStep({
  clinic,
  session,
  hc,
  setHc,
  error,
}: {
  clinic: WizardClinic;
  session: { email: string; fullName: string | null } | null;
  hc: PatientHC;
  setHc: (next: PatientHC) => void;
  error: string | null;
}) {
  const upd = <K extends keyof PatientHC>(k: K, v: PatientHC[K]) => setHc({ ...hc, [k]: v });
  const isGeneral = clinic.vertical === "GENERAL";
  return (
    <>
      <StepHeader
        title="Completá tus datos clínicos"
        subtitle="Necesitamos esta información para tu historia clínica y la facturación."
      />

      {!session && (
        <Card
          style={{
            padding: 14,
            background: "rgba(31,79,190,0.04)",
            border: "1px solid rgba(31,79,190,0.18)",
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>¿Ya sos paciente?</div>
            <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>
              Iniciá sesión con Google y precargamos tus datos.
            </div>
          </div>
          {/* A3b-S-auth: form POST (el GET daba 405). */}
          <form
            action={`/api/auth/google?next=${encodeURIComponent(`/c/${clinic.slug}/booking`)}`}
            method="post"
            style={{ margin: 0 }}
          >
            <button
              type="submit"
              style={{
                padding: "8px 14px",
                borderRadius: 999,
                background: "#fff",
                border: "1px solid rgba(15,30,51,0.08)",
                fontSize: 12.5,
                color: "var(--navy-900)",
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              <span style={{ fontWeight: 700, color: "#4285F4", marginRight: 4 }}>G</span> Ingresar con
              Google
            </button>
          </form>
        </Card>
      )}

      <div className="booking-grid-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="Nombre" required value={hc.firstName} onChange={(v) => upd("firstName", v)} />
        <Field label="Apellido" required value={hc.lastName} onChange={(v) => upd("lastName", v)} />
        <Field
          label="Email"
          required
          type="email"
          value={hc.email}
          onChange={(v) => upd("email", v)}
        />
        <Field label="Teléfono" required value={hc.phone} onChange={(v) => upd("phone", v)} />
        <Field
          label="DNI"
          required
          value={hc.documentId}
          onChange={(v) => upd("documentId", v)}
        />
        <Field
          label="Fecha de nacimiento"
          required
          type="date"
          value={hc.dateOfBirth}
          onChange={(v) => upd("dateOfBirth", v)}
        />
        <Field
          label="Obra social"
          value={hc.coverageInsurer}
          onChange={(v) => upd("coverageInsurer", v)}
          placeholder="OSDE, Swiss…"
        />
        <Field
          label="Plan / N° afiliado"
          value={hc.coveragePlan}
          onChange={(v) => upd("coveragePlan", v)}
        />
        <Field
          label="Contacto de emergencia"
          value={hc.emergencyName}
          onChange={(v) => upd("emergencyName", v)}
          placeholder="Nombre y vínculo"
        />
        <Field
          label="Tel. contacto emergencia"
          value={hc.emergencyPhone}
          onChange={(v) => upd("emergencyPhone", v)}
        />
      </div>

      <Field
        label="Motivo de consulta"
        value={hc.notes}
        onChange={(v) => upd("notes", v)}
        textarea
        placeholder={
          isGeneral
            ? "Contanos brevemente qué te trae y desde cuándo."
            : "Contanos brevemente qué te trae (zona, desde cuándo, qué actividad sentís limitada)."
        }
      />

      {/* EV1-C2: en Clínica general no hay diagnóstico de kinesiología, y «Motivo de consulta» ya es el campo
          de arriba: el título (`hc.title` → `diagnosisTitle`) no se pide. La descripción queda: es texto libre. */}
      {!isGeneral && (
        <Field
          label="Diagnóstico (opcional)"
          value={hc.title}
          onChange={(v) => upd("title", v)}
          placeholder="Ej. Lumbalgia, esguince de tobillo…"
        />
      )}

      <Field
        label="Descripción (opcional)"
        value={hc.description}
        onChange={(v) => upd("description", v)}
        textarea
        placeholder="Detalles adicionales que quieras que el profesional conozca."
      />

      {error && (
        <div
          style={{
            padding: 10,
            borderRadius: 10,
            background: "var(--danger-bg)",
            color: "var(--danger-fg)",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}
      <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
        {/* PL-F1c: sin «Cancelás gratis hasta 6 hs antes»: el paciente no tiene cómo cancelar y no hay regla de
            6 hs. Si VX2 rehace el turnero, que no la reintroduzca. */}
        Al continuar aceptás que la clínica use estos datos para tu atención.
      </div>
    </>
  );
}

function Field({
  label,
  required,
  type = "text",
  value,
  onChange,
  textarea,
  placeholder,
}: {
  label: string;
  required?: boolean;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  textarea?: boolean;
  placeholder?: string;
}) {
  return (
    <label style={{ display: "block", fontSize: 12 }}>
      <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>
        {label}
        {required && <span style={{ color: "var(--sky-700)" }}> *</span>}
      </span>
      {textarea ? (
        <textarea
          value={value}
          rows={3}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={inputStyle}
        />
      ) : (
        <input
          type={type}
          value={value}
          required={required}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          style={inputStyle}
        />
      )}
    </label>
  );
}


function SummaryAside({
  clinic,
  practitioner,
  anyPractitioner,
  service,
  slotISO,
  location,
}: {
  clinic: PublicClinic;
  practitioner: PublicClinic["practitioners"][number] | null;
  /** Modo "Primer turno disponible": antes de resolverlo no hay nombre. */
  anyPractitioner: boolean;
  service: PublicClinic["services"][number] | null;
  slotISO: string | null;
  /** Sede del horario elegido (cada slot trae la suya). */
  location: PublicLocation | null;
}) {
  const when = slotISO ? formatWhenAR(slotISO) : null;
  const address = location ? formatLocationAddress(location) : "";
  return (
    <aside className="booking-summary" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card glass style={{ padding: 18 }}>
        <div className="k-display" style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>
          Tu turno
        </div>
        <Row label="Centro" value={clinic.name} />
        <Row
          label="Profesional"
          value={practitioner?.name ?? (anyPractitioner ? "Primer disponible" : "—")}
        />
        <Row
          label="Servicio"
          value={service ? service.name : "—"}
          sub={service ? `${durationFor(service, practitioner?.id ?? null)} min` : undefined}
        />
        <Row label="Fecha y hora" value={when ?? "—"} />
        {location && <Row label="Dónde" value={location.name} sub={address || undefined} />}
        <div
          style={{
            marginTop: 16,
            padding: "14px 16px",
            borderRadius: 14,
            background: "rgba(246,249,253,0.7)",
            border: "1px dashed rgba(15,30,51,0.1)",
          }}
        >
          <div
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13 }}
          >
            <span style={{ color: "var(--navy-500)" }}>Total a pagar</span>
            <span className="k-display" style={{ fontWeight: 700 }}>
              {service ? fmtArs(service.priceCents) : "—"}
            </span>
          </div>
          <div style={{ fontSize: 11, color: "var(--navy-300)", marginTop: 6 }}>
            Pago seguro vía Mercado Pago.
          </div>
        </div>
      </Card>

      <Card style={{ padding: 14, background: "rgba(31,79,190,0.04)" }}>
        <div style={{ fontSize: 11.5, color: "var(--navy-700)", lineHeight: 1.55 }}>
          <Tag tone="lime">100% seguro</Tag>
          <p style={{ margin: "8px 0 0" }}>
            Tu información clínica está cifrada. Sólo el centro puede verla.
          </p>
        </div>
      </Card>
    </aside>
  );
}

function Row({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: "10px 0",
        borderBottom: "1px solid rgba(15,30,51,0.05)",
      }}
    >
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontSize: 10.5,
            color: "var(--navy-300)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            fontWeight: 600,
          }}
        >
          {label}
        </div>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--navy-900)", marginTop: 1 }}>
          {value}
        </div>
        {sub && (
          <div style={{ fontSize: 11, color: "var(--navy-500)", marginTop: 1 }}>{sub}</div>
        )}
      </div>
    </div>
  );
}

function fmtArs(cents: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

const navBtn: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 10,
  background: "rgba(255,255,255,0.7)",
  border: "1px solid rgba(15,30,51,0.06)",
  cursor: "pointer",
  color: "var(--navy-700)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

const inputStyle: React.CSSProperties = {
  marginTop: 6,
  padding: "10px 12px",
  borderRadius: 12,
  background: "rgba(255,255,255,0.7)",
  border: "1px solid rgba(15,30,51,0.08)",
  width: "100%",
  fontSize: 14,
  color: "var(--navy-900)",
  outline: "none",
};

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
 * layout (form left + summary right); on mobile they're a stack (VX2-d1:
 * todo en `public-booking.module.css`, sin `<style>` embebido ni reglas
 * `.booking-*` globales). State
 * is fully client-side; submission goes through the `submitPublicBooking`
 * server action which creates Patient + Booking + MP preference.
 * La lógica pura (filtros, rotación de la key, selección "cualquiera") está
 * en `lib/public-wizard-state.ts` con sus unit tests.
 */
import { useMemo, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { KineLogo } from "@/components/ui/kine-logo";
import { BRAND_NAME } from "@/lib/brand";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { GoogleIcon } from "@/components/ui/brand-icons";
import { IconAlert, IconArrow, IconCheck, IconChevL, IconChevR, IconClock } from "@/components/ui/icons";
import { formatARS } from "@/lib/format";
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
import { EmptyBox, StepHeader, focusStepHeading, formatWhenAR } from "./wizard/shared";
import { clinicInitials } from "./booking-unavailable";
import s from "./public-booking.module.css";

export type PatientHC = {
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
 * EV1-C2: la vertical del consultorio, para el copy (Clínica general no es
 * kinesiología). Opcional: sin ella (o antes de que `getPublicClinic` la sume
 * a `PublicClinic`) el wizard muestra el copy de Kinesiología de siempre.
 */
type WizardClinic = PublicClinic & { vertical?: TenantVertical | null };

export function PublicBookingWizard({
  clinic,
  session,
  prefill,
  googleEnabled = true,
}: {
  clinic: WizardClinic;
  session: { email: string; fullName: string | null } | null;
  prefill: PrefillPatient | null;
  /**
   * [VX-Z · D-VX16] Google apagado en Supabase (`visibleOAuthProviders`) → no se ofrece: el botón llevaba a
   * `/login?error=provider_disabled`, un callejón para un paciente. Default `true` (el render test y la duda
   * —Supabase caído— lo muestran, igual que el login).
   */
  googleEnabled?: boolean;
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

  // VX-Z: foco al título del paso nuevo al avanzar/retroceder (también «Elegir profesional» desde el primer turno).
  // No en el primer render: robarle el foco a quien recién llega rompe el recorrido normal de la página.
  const cardRef = useRef<HTMLDivElement>(null);
  const prevStep = useRef(step);
  useEffect(() => {
    if (prevStep.current === step) return;
    prevStep.current = step;
    focusStepHeading(cardRef.current);
  }, [step]);

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
    <div className={`k-app ${s.root}`}>
      <Nav clinic={clinic} session={session} />
      <Header clinic={clinic} step={step} />

      <main className={s.body}>
        <Card glass className={s.card}>
          <div ref={cardRef} className={s.stepBody}>
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
              googleEnabled={googleEnabled}
              hc={hc}
              setHc={setHc}
              error={error}
            />
          )}
          </div>

          <footer className={s.actions}>
            {step > firstStep ? (
              <Button variant="ghost" size="md" onClick={back} disabled={pending}>
                <IconChevL size={12} /> Atrás
              </Button>
            ) : (
              <span />
            )}
            <Button variant="primary" size="md" onClick={next} disabled={!canAdvance || pending}>
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

      {/* VX-Z: como `BookingFrame` (booking-unavailable.tsx): adelante la marca del consultorio, KineSoft chico acá. */}
      <footer className={s.foot}>
        <span>Turnos online con</span>
        <Link href="/" className="k-link" aria-label={`${BRAND_NAME}, inicio`}>
          <KineLogo size={18} />
        </Link>
      </footer>
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

/**
 * OAuth de Google del turnero (paso «Tus datos»): form POST a la ruta canónica `/api/auth/oauth/google` (PL-2e; el
 * alias viejo `/api/auth/google` sigue vivo para otros llamadores). POST porque un `<Link>` GET daba 405 (A3b-S-auth).
 */
function googleAction(slug: string) {
  return `/api/auth/oauth/google?next=${encodeURIComponent(`/c/${slug}/booking`)}`;
}

function Nav({ clinic, session }: { clinic: PublicClinic; session: { email: string } | null }) {
  const initials = clinicInitials(clinic.name);
  return (
    <header className={`k-glass ${s.nav}`}>
      {/* VX-Z: la marca es la DEL CONSULTORIO (monograma + nombre, como `BookingFrame`): el paciente llegó por su link
          y no sabe qué es KineSoft. KineSoft queda chico en el pie. El nombre es un `<p>`: la única h1 es la del head. */}
      <div className={s.navBrand}>
        {initials && (
          <span className={s.navMono} aria-hidden="true">
            {initials}
          </span>
        )}
        <p className={s.navClinic}>{clinic.name}</p>
      </div>
      <div className={s.navSpacer} />
      {/* VX2-d1 (AUDIT `turnero-texto-fijo-lun-sab`): antes «lun-sáb 8 a 19hs» fijo para todos. Ahora el resumen de
          las franjas reales (`summarizeOpeningHours`); sin franjas vigentes no se muestra nada. */}
      {clinic.openingSummary && (
        <span className={s.navHours}>
          <IconClock size={14} />
          <span className="k-sr-only">Horario de atención: </span>
          {clinic.openingSummary}
        </span>
      )}
      {/* VX-Z: «Iniciar sesión» lleva SIEMPRE al portal (ingreso por email o Google, con su propio criterio). Antes,
          con Google prendido, era un form POST directo a Google: quien no tiene Google se quedaba sin entrar, y el
          mismo texto hacía dos cosas distintas según la config. Google sigue ofrecido en «Tus datos» (`DataStep`). */}
      <Link href="/portal" className={s.navLink}>
        {session ? "Mis turnos" : "Iniciar sesión"}
      </Link>
    </header>
  );
}

function Header({ clinic, step }: { clinic: PublicClinic; step: Step }) {
  return (
    <div className={s.head}>
      <p className={s.eyebrow}>{clinic.name}</p>
      {/* VX2-d1: sin «en 30 segundos» (§3: solo claims con evidencia; nadie lo midió). */}
      <h1 className={`k-display ${s.title}`}>Reservá tu turno</h1>
      <Steps step={step} hidePractitioner={clinic.practitioners.length === 1} />
    </div>
  );
}

function Steps({ step, hidePractitioner }: { step: Step; hidePractitioner: boolean }) {
  const items = STEPS.filter((_, i) => !(hidePractitioner && i === 0));
  return (
    <ol className={s.steps} aria-label="Pasos de la reserva">
      {items.map((label, idx) => {
        const i = hidePractitioner ? idx + 1 : idx;
        const done = step > i;
        const active = step === i;
        return (
          <li
            key={label}
            className={`${s.step} ${active ? s.stepActive : done ? s.stepDone : ""}`}
            aria-current={active ? "step" : undefined}
          >
            <span className={s.stepDot} aria-hidden>
              {done ? <IconCheck size={12} stroke={3} /> : idx + 1}
            </span>
            {label}
            {done && <span className="k-sr-only"> (listo)</span>}
          </li>
        );
      })}
    </ol>
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
      <StepHeader title="¿Qué servicio necesitás?" subtitle="Cada servicio tiene su duración y su precio." />
      {services.length === 0 ? (
        <EmptyBox>No hay servicios para reservar online con esta elección. Volvé y probá otra.</EmptyBox>
      ) : (
        <div className={s.list}>
          {services.map((sv) => (
            <button
              key={sv.id}
              type="button"
              aria-pressed={sv.id === value}
              onClick={() => onChange(sv.id)}
              className={`${s.choice} ${s.choiceRow}`}
            >
              <div className={s.choiceMain}>
                <div className={s.choiceTitle}>{sv.name}</div>
                {sv.description && <div className={s.choiceSub}>{sv.description}</div>}
                <div className={s.choiceMeta}>{durationFor(sv, practitionerId)} min</div>
              </div>
              <div className={`k-display ${s.price}`}>{formatARS(sv.priceCents)}</div>
            </button>
          ))}
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
      <StepHeader title="Elegí día y horario" subtitle="Te mostramos solo los horarios disponibles." />
      {multiLoc && (
        <div role="group" aria-label="Sede" className={s.chips}>
          {[{ id: null as string | null, name: "Todas las sedes" }, ...locations].map((l) => (
            <button
              key={l.id ?? "all"}
              type="button"
              aria-pressed={effectiveLocationId === l.id}
              onClick={() => onLocationChange(l.id)}
              className={`${s.choice} ${s.chip}`}
            >
              {l.name}
            </button>
          ))}
        </div>
      )}
      <div className={s.dateBar}>
        <button
          type="button"
          onClick={() => shiftDate(-1)}
          aria-label="Día anterior"
          disabled={dateISO <= todayKey}
          className={s.navBtn}
        >
          <IconChevL size={14} />
        </button>
        <div className={s.dateCenter}>
          <div className={`k-display ${s.dateLabel}`} aria-live="polite">
            {selected.toLocaleDateString("es-AR", {
              weekday: "long",
              day: "2-digit",
              month: "long",
              timeZone: "America/Argentina/Buenos_Aires",
            })}
          </div>
          {/* `<input type="date">` va en fecha local por definición (excepción de AGENTS §4). */}
          <input
            type="date"
            aria-label="Elegir fecha"
            value={dateISO}
            min={todayKey}
            onChange={(e) => {
              setDateISO(e.target.value);
              setSlot(null, null);
            }}
            className={s.dateInput}
          />
        </div>
        <button type="button" onClick={() => shiftDate(1)} aria-label="Día siguiente" className={s.navBtn}>
          <IconChevR size={14} />
        </button>
      </div>

      {loading ? (
        <div className={s.loading} role="status">
          Buscando horarios…
        </div>
      ) : slotError === "rate" ? (
        <EmptyBox>Demasiadas consultas seguidas. Esperá unos segundos y reintentá.</EmptyBox>
      ) : slots.length === 0 ? (
        <EmptyBox>
          {effectiveLocationId
            ? "No hay horarios en esta sede este día. Probá otro día u otra sede."
            : "No hay horarios este día. Probá otro."}
        </EmptyBox>
      ) : (
        <div className={s.slots} role="group" aria-label="Horarios">
          {slots.map((sl) => {
            // Con varias sedes y sin filtrar, cada horario dice dónde es.
            const where = multiLoc && !effectiveLocationId ? locName(sl.locationId) : null;
            return (
              <button
                key={sl.iso}
                type="button"
                onClick={() => sl.available && setSlot(sl.iso, sl.locationId ?? null)}
                disabled={!sl.available}
                aria-pressed={sl.iso === slotISO}
                className={s.slot}
              >
                {sl.time}
                {!sl.available && <span className="k-sr-only"> (ocupado)</span>}
                {where && <span className={s.slotWhere}>{where}</span>}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

// ─── Step 3 ─ Patient HC ──────────────────────────────────────────────
// Exportado solo para el render test (VX2-d1): el paso 4 no se alcanza con un render estático del wizard.
export function DataStep({
  clinic,
  session,
  googleEnabled = true,
  hc,
  setHc,
  error,
}: {
  clinic: WizardClinic;
  session: { email: string; fullName: string | null } | null;
  googleEnabled?: boolean;
  hc: PatientHC;
  setHc: (next: PatientHC) => void;
  error: string | null;
}) {
  const upd = <K extends keyof PatientHC>(k: K, v: PatientHC[K]) => setHc({ ...hc, [k]: v });
  const isGeneral = clinic.vertical === "GENERAL";
  // VX2-d1: `Field` del design system (label real + ids estables) y `autoComplete` en lo que el navegador sabe
  // completar del propio paciente. El contacto de emergencia es OTRA persona: `off`, para que no se autocomplete
  // con el nombre y el teléfono del paciente.
  const text = (k: keyof PatientHC, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input
      className="k-input"
      type="text"
      name={k}
      value={hc[k]}
      onChange={(e) => upd(k, e.target.value)}
      {...extra}
    />
  );
  return (
    <>
      <StepHeader
        title="Completá tus datos"
        subtitle="Los necesitamos para tu historia clínica y para el pago del turno."
      />

      {!session && googleEnabled && (
        <div className={s.signIn}>
          <div className={s.signInText}>
            <p className={s.signInTitle}>¿Ya sos paciente?</p>
            <p className={s.help}>Iniciá sesión con Google y precargamos tus datos.</p>
          </div>
          {/* A3b-S-auth: form POST (el GET daba 405). */}
          <form action={googleAction(clinic.slug)} method="post" className={s.navForm}>
            <button type="submit" className={s.pillButton}>
              <GoogleIcon size={18} /> Ingresar con Google
            </button>
          </form>
        </div>
      )}

      <div className={s.grid2}>
        <Field id="booking-firstName" label="Nombre">
          {text("firstName", { autoComplete: "given-name", required: true })}
        </Field>
        <Field id="booking-lastName" label="Apellido">
          {text("lastName", { autoComplete: "family-name", required: true })}
        </Field>
        <Field id="booking-email" label="Email">
          {text("email", { type: "email", autoComplete: "email", inputMode: "email", required: true })}
        </Field>
        <Field id="booking-phone" label="Teléfono">
          {text("phone", { type: "tel", autoComplete: "tel", inputMode: "tel", required: true })}
        </Field>
        <Field id="booking-documentId" label="DNI">
          {text("documentId", { inputMode: "numeric", autoComplete: "off", required: true })}
        </Field>
        <Field id="booking-dateOfBirth" label="Fecha de nacimiento">
          {text("dateOfBirth", { type: "date", autoComplete: "bday", required: true })}
        </Field>
        <Field id="booking-coverageInsurer" label="Obra social" optional>
          {text("coverageInsurer", { placeholder: "OSDE, Swiss…", autoComplete: "off" })}
        </Field>
        <Field id="booking-coveragePlan" label="Plan / N° de afiliado" optional>
          {text("coveragePlan", { autoComplete: "off" })}
        </Field>
        <Field id="booking-emergencyName" label="Contacto de emergencia" optional>
          {text("emergencyName", { placeholder: "Nombre y vínculo", autoComplete: "off" })}
        </Field>
        <Field id="booking-emergencyPhone" label="Teléfono de emergencia" optional>
          {text("emergencyPhone", { type: "tel", inputMode: "tel", autoComplete: "off" })}
        </Field>
      </div>

      <Field id="booking-notes" label="Motivo de consulta" optional>
        <textarea
          className="k-input"
          name="notes"
          rows={3}
          value={hc.notes}
          onChange={(e) => upd("notes", e.target.value)}
          placeholder={
            isGeneral
              ? "Contanos brevemente qué te trae y desde cuándo."
              : "Contanos brevemente qué te trae (zona, desde cuándo, qué actividad sentís limitada)."
          }
        />
      </Field>

      {/* EV1-C2: en Clínica general no hay diagnóstico de kinesiología, y «Motivo de consulta» ya es el campo
          de arriba: el título (`hc.title` → `diagnosisTitle`) no se pide. La descripción queda: es texto libre. */}
      {!isGeneral && (
        <Field id="booking-title" label="Diagnóstico" optional>
          {text("title", { placeholder: "Ej. Lumbalgia, esguince de tobillo…", autoComplete: "off" })}
        </Field>
      )}

      <Field id="booking-description" label="Descripción" optional>
        <textarea
          className="k-input"
          name="description"
          rows={3}
          value={hc.description}
          onChange={(e) => upd("description", e.target.value)}
          placeholder="Detalles que quieras que el profesional conozca."
        />
      </Field>

      {error && (
        <div className="k-alert" role="alert">
          <IconAlert size={18} />
          <span>{error}</span>
        </div>
      )}
      <p className={s.consent}>
        {/* PL-F1c: sin «Cancelás gratis hasta 6 hs antes»: el paciente no tiene cómo cancelar y no hay regla de
            6 hs. VX2-d1 lo mantiene afuera. */}
        Al continuar aceptás que el consultorio use estos datos para tu atención.
      </p>
    </>
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
  // VX2-d1 (handoff 12): fuera la tarjeta «100% seguro» + «Tu información clínica está cifrada»: sin evidencia
  // (guard `tests/unit/public-claims.test.ts`).
  return (
    <aside className={s.summary} aria-label="Resumen del turno">
      <Card glass className={s.summaryCard}>
        <h2 className={`k-display ${s.summaryTitle}`}>Tu turno</h2>
        <dl className={s.rows}>
          <Row label="Consultorio" value={clinic.name} />
          <Row label="Profesional" value={practitioner?.name ?? (anyPractitioner ? "Primer disponible" : "—")} />
          <Row
            label="Servicio"
            value={service ? service.name : "—"}
            sub={service ? `${durationFor(service, practitioner?.id ?? null)} min` : undefined}
          />
          <Row label="Fecha y hora" value={when ?? "—"} />
          {location && <Row label="Dónde" value={location.name} sub={address || undefined} />}
        </dl>
        <div className={s.total}>
          <div className={s.totalRow}>
            <span className={s.totalLabel}>Total a pagar</span>
            <span className={`k-display ${s.totalValue}`}>{service ? formatARS(service.priceCents) : "—"}</span>
          </div>
          <p className={s.totalNote}>El pago se hace en Mercado Pago.</p>
        </div>
      </Card>
    </aside>
  );
}

function Row({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={s.row}>
      <dt className={s.rowLabel}>{label}</dt>
      <dd className={s.rowValue}>
        {value}
        {sub && <span className={s.rowSub}>{sub}</span>}
      </dd>
    </div>
  );
}

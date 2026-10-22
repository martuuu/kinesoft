"use client";

/**
 * Public booking wizard — what a stranger sees at `/c/<slug>/booking`.
 *
 * Steps:
 *   1. Profesional (skip if only one) — con filtros opcionales de sede y
 *      cobertura y la opción "Primer turno disponible" (B5.6)
 *   2. Servicio (los que ofrece el profesional: `practitionerIds`)
 *   3. Fecha + hora: ventana de 5 días hábiles de `listPublicSlotWindow` (TP-1, `wizard/slot-window-step.tsx`), o en
 *      modo "cualquiera" el primer horario libre de `findFirstPublicSlot`
 *   4. Tus datos — Google sign-in or HC form
 *   5. Confirmación: reserva sin cobro («Confirmar turno» → `/booking/<id>/ok`) o, si el consultorio cobra online
 *      (T5, C-TP8 `onlinePayment`), Mercado Pago con la cuenta del profesional: REQUIRED siempre; OPTIONAL según la
 *      elección del paciente, sin preselección (`wizard/payment-choice.tsx`). Adónde ir lo decide el `next` del server.
 *
 * The component is responsive: on desktop the steps run as a 2-column
 * layout (form left + summary right); on mobile they're a stack (VX2-d1:
 * todo en `public-booking.module.css`, sin `<style>` embebido ni reglas
 * `.booking-*` globales). State
 * is fully client-side; submission goes through the `submitPublicBooking`
 * server action which creates Patient + Booking (+ MP preference only when it charges online).
 * La lógica pura (filtros, rotación de la key, selección "cualquiera") está
 * en `lib/public-wizard-state.ts` con sus unit tests.
 */
import { useMemo, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { KineLogo } from "@/components/ui/kine-logo";
import { BRAND_NAME } from "@/lib/brand";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { IconAlert, IconArrow, IconCheck, IconChevL, IconClock } from "@/components/ui/icons";
import { formatARS } from "@/lib/format";
import { submitPublicBooking } from "@/lib/public-booking";
import { toARDateKey } from "@/lib/datetime-ar";
import type { PublicClinic, PublicLocation, PrefillPatient } from "@/lib/public-booking-types";
import type { TenantVertical } from "@prisma/client";
import {
  amountDiffers,
  attemptSignature,
  canConfirmPayment,
  checkoutCopyFor,
  clinicInitials,
  coverageInsurerPrefill,
  destinationAfterSubmit,
  durationFor,
  filterPractitioners,
  findLocation,
  formatLocationAddress,
  initialWindowNav,
  initialWizardSelection,
  locationsForPractitioner,
  nextAttempt,
  payNowFor,
  reconcileSelection,
  servicesForAny,
  servicesForPractitioner,
  windowNavAt,
  wizardOnlinePaymentFor,
  type Attempt,
  type CheckoutCopy,
  type PayChoice,
  type WindowNav,
  type WizardFilters,
  type WizardSelection,
} from "@/lib/public-wizard-state";
import { PractitionerStep } from "./wizard/practitioner-step";
import { FirstSlotStep } from "./wizard/first-slot-step";
import { SlotWindowStep } from "./wizard/slot-window-step";
import { EmptyBox, StepHeader, focusStepHeadingWhenReady, formatWhenAR } from "./wizard/shared";
import s from "./public-booking.module.css";

// TP-3h: «Tus datos» + cobro online en un chunk diferido (ver cabecera de `wizard/data-step.tsx`). Un solo loader para
// los tres = un solo chunk; se precarga al llegar a «Fecha y hora» (`useEffect` de abajo) para que el paso 4 no espere.
const loadDataStep = () => import("./wizard/data-step");
const DataStep = dynamic(() => loadDataStep().then((m) => m.DataStep), { loading: () => <p className={s.loading}>Cargando…</p> });
const PaymentChoice = dynamic(() => loadDataStep().then((m) => m.PaymentChoice));
const PaymentInterstitial = dynamic(() => loadDataStep().then((m) => m.PaymentInterstitial));

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
  initialPractitionerId = null,
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
  /** DIR-2d: `?pro=` del deep link del directorio. No reservable acá = se ignora (`initialWizardSelection`). */
  initialPractitionerId?: string | null;
}) {
  const singlePractitioner = clinic.practitioners.length === 1;
  // Piso del «Volver»: con el deep link se arranca en el paso 1 pero se puede volver a elegir profesional.
  const firstStep: Step = singlePractitioner ? 1 : 0;
  // Estado inicial en lógica pura (testeada): deep link válido o un solo profesional → paso 1 con él; si no, paso 0.
  const [initial] = useState(() => initialWizardSelection(clinic, initialPractitionerId));
  const [step, setStep] = useState<Step>(initial.step);
  // "pick" = eligió profesional; "any" = primer turno disponible con
  // cualquiera (el profesional lo resuelve `findFirstPublicSlot` en el paso 3).
  const [mode, setMode] = useState<"pick" | "any">(initial.mode);
  const [filters, setFilters] = useState<WizardFilters>({ insurerId: null, locationId: null });
  const [practitionerId, setPractitionerId] = useState<string | null>(initial.practitionerId);
  const [serviceId, setServiceId] = useState<string | null>(null);
  // TP-1: desde qué día pide la ventana de 5 días hábiles (+ pila de «Anteriores»). Antes era `dateISO`, un solo día.
  // Hoy en calendario AR: `toISOString().slice(0,10)` pasadas las 21:00 AR (00:00 UTC) arrancaba el wizard en mañana.
  const [windowNav, setWindowNav] = useState<WindowNav>(() => initialWindowNav(toARDateKey(new Date())));
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
  // T3 (AS-D9 / C-AS3): el horario elegido dejó de ser reservable (paso nuevo, tope lleno, se ocupó).
  const [slotGone, setSlotGone] = useState<string | null>(null);

  const practitioner = clinic.practitioners.find((p) => p.id === practitionerId) ?? null;
  const service = clinic.services.find((s) => s.id === serviceId) ?? null;
  // TP-3h: cobro online de ESTE turno (profesional con cuenta usable + política) cotizado con el precio del servicio,
  // y la elección del paciente en OPTIONAL (null = no eligió; sin preselección, TP-UI-D5). Botón y resumen son copy:
  // adónde ir lo decide el `next` del server.
  const payment = wizardOnlinePaymentFor(clinic, practitionerId, service?.priceCents ?? 0);
  const [payChoice, setPayChoice] = useState<PayChoice>(null);
  const checkout = checkoutCopyFor({ payment, choice: payChoice, priceCents: service?.priceCents ?? 0 });
  // Interstitial antes de navegar (TP-UI-D6 monto distinto; MP caído en OPTIONAL). `href` = adónde sigue.
  const [interstitial, setInterstitial] = useState<{ kind: "amount" | "unavailable" | "reserved"; amountCents: number | null; href: string } | null>(null);

  // Servicios del profesional elegido (`practitionerIds`, B3.2). En modo
  // "cualquiera": los que ofrece al menos un profesional que pasa los filtros.
  const visibleServices = useMemo(() => {
    if (mode === "any") return servicesForAny(clinic, filters);
    if (!practitionerId) return clinic.services;
    return servicesForPractitioner(clinic, practitionerId);
  }, [mode, practitionerId, filters, clinic]);

  const setSlot = (iso: string | null, locationId: string | null) => {
    if (iso) setSlotGone(null);
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
    // La ventana arranca en el día encontrado: «Ver más horarios de X» muestra ese día y los 4 hábiles siguientes.
    setWindowNav(windowNavAt(sel.dateISO, toARDateKey(new Date())));
    setSlot(sel.slotISO, sel.slotLocationId);
  };

  const canAdvance =
    (step === 0 && (mode === "any" || !!practitionerId)) ||
    (step === 1 && !!serviceId) ||
    (step === 2 && !!slotISO && !!practitionerId) ||
    (step === 3 && isHcValid(hc) && canConfirmPayment(payment, payChoice));

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
  useEffect(() => {
    if (step >= 2) void loadDataStep();
  }, [step]);
  const cardRef = useRef<HTMLDivElement>(null);
  const prevStep = useRef(step);
  useEffect(() => {
    if (prevStep.current === step) return;
    prevStep.current = step;
    return focusStepHeadingWhenReady(cardRef.current);
  }, [step]);
  // ZB-2: el interstitial desmonta el paso «Tus datos» y el foco caía al body; va a su título (con scroll arriba: en
  // 390 px el botón que lo abrió quedaba al pie). `WhenReady`: el interstitial es `dynamic` y su primer render suspende,
  // así que el título no está todavía cuando corre este efecto (hallazgo de TP-E, ver `wizard/shared.tsx`).
  useEffect(() => {
    if (!interstitial) return;
    window.scrollTo({ top: 0 });
    return focusStepHeadingWhenReady(cardRef.current);
  }, [interstitial]);

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
        payNow: payNowFor(payment, payChoice),
      });
      if (!r.ok) {
        // T3: el server marca `fieldErrors.scheduledFor` cuando el horario ya no se puede reservar: volver a la ventana
        // (se recarga al montar) sin el horario elegido, en vez de dejar al paciente trabado en «Tus datos».
        if (r.fieldErrors?.scheduledFor) {
          setSlot(null, null);
          setSlotGone(r.error);
          setStep(2);
          return;
        }
        setError(r.error);
        return;
      }
      // `reserved` → resultado (/ok); `checkout` → Mercado Pago. Navegación dura (`location.assign`, TP-UI-D3: sin
      // tocar la CSP) a propósito: el resultado consulta el estado real y no hay nada del wizard que conservar.
      // Antes de irse, el interstitial si el server cobra otro monto (TP-UI-D6) o si Mercado Pago no respondió en
      // OPTIONAL (el turno quedó reservado). REQUIRED con MP caído llega como error y el reintento usa la misma key,
      // o sea el mismo cobro (TP-D29).
      if (r.data.notice === "payment-unavailable") {
        setInterstitial({ kind: "unavailable", amountCents: null, href: destinationAfterSubmit(r.data) });
      } else if (amountDiffers(r.data, checkout.online && payment ? payment.quote.amountCents : null)) {
        // TP-ZF2: `reserved` acá = el wizard cotizó un cobro y el server no cobró (copago $ 0): se avisa en vez de ir
        // directo a `/ok` después de prometer «Pagar y reservar».
        setInterstitial({
          kind: r.data.next === "reserved" ? "reserved" : "amount",
          amountCents: r.data.amountCents,
          href: destinationAfterSubmit(r.data),
        });
      } else {
        window.location.assign(destinationAfterSubmit(r.data));
      }
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
          {step === 2 && slotGone && (
            <div className="k-alert" role="alert">
              <IconAlert size={18} />
              <span>{slotGone}</span>
            </div>
          )}
          {step === 2 && mode === "pick" && practitionerId && serviceId && (
            <SlotWindowStep
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
              nav={windowNav}
              setNav={setWindowNav}
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
          {step === 3 && !interstitial && (
            <DataStep
              clinic={clinic}
              session={session}
              googleEnabled={googleEnabled}
              hc={hc}
              setHc={setHc}
              error={error}
              payment={payment && <PaymentChoice payment={payment} choice={payChoice} onChange={setPayChoice} />}
            />
          )}
          {interstitial && (
            <PaymentInterstitial
              kind={interstitial.kind}
              amountCents={interstitial.amountCents}
              onContinue={() => window.location.assign(interstitial.href)}
            />
          )}
          </div>

          {!interstitial && <footer className={s.actions}>
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
                  ? checkout.ctaPending
                  : checkout.cta
                : "Continuar"}{" "}
              <IconArrow size={14} />
            </Button>
          </footer>}
        </Card>

        <SummaryAside
          clinic={clinic}
          practitioner={practitioner}
          anyPractitioner={mode === "any"}
          service={service}
          slotISO={slotISO}
          location={findLocation(clinic, slotLocationId)}
          checkout={checkout}
          cancellationNote={payment?.cancellationNote ?? null}
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
              {/* TP-1: con precio 0 no hay monto (antes «$ 0», que se leía como un error o como «gratis» sin serlo). */}
              {sv.priceCents > 0 && <div className={`k-display ${s.price}`}>{formatARS(sv.priceCents)}</div>}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ─── Step 2 ─ Slot: components/booking/wizard/slot-window-step.tsx (TP-1: ventana de 5 días hábiles)

// ─── Step 3 ─ Patient HC: components/booking/wizard/data-step.tsx (TP-3h: diferido junto con el cobro online)

/** Exportado para el render test (TP-0): con un servicio elegido no se llega por render estático del wizard. */
export function SummaryAside({
  clinic,
  practitioner,
  anyPractitioner,
  service,
  slotISO,
  location,
  checkout,
  cancellationNote = null,
}: {
  clinic: PublicClinic;
  practitioner: PublicClinic["practitioners"][number] | null;
  /** Modo "Primer turno disponible": antes de resolverlo no hay nombre. */
  anyPractitioner: boolean;
  service: PublicClinic["services"][number] | null;
  slotISO: string | null;
  /** Sede del horario elegido (cada slot trae la suya). */
  location: PublicLocation | null;
  checkout: CheckoutCopy;
  /** Nota de cancelación de la política (≤280), en texto plano: React la escapa, nunca HTML. */
  cancellationNote?: string | null;
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
          {/* Sin servicio elegido: «—». Elegido, sin cobro y con precio 0: sin fila (antes «$ 0», H-TP2). */}
          {(!service || checkout.showTotal) && (
            <div className={s.totalRow}>
              <span className={s.totalLabel}>{checkout.totalLabel}</span>
              <span className={`k-display ${s.totalValue}`}>{service ? formatARS(service.priceCents) : "—"}</span>
            </div>
          )}
          {checkout.split && (
            <>
              <div className={s.totalRow}>
                <span className={s.totalLabel}>{"Seña a pagar ahora"}</span>
                <span className={s.splitValue}>{formatARS(checkout.split.nowCents)}</span>
              </div>
              <div className={s.totalRow}>
                <span className={s.totalLabel}>{"Resto en el consultorio"}</span>
                <span className={s.splitValue}>{formatARS(checkout.split.restCents)}</span>
              </div>
            </>
          )}
          <p className={s.totalNote}>{checkout.note}</p>
          {cancellationNote && <p className={s.cancelNote}>{cancellationNote}</p>}
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

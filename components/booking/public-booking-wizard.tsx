"use client";

/**
 * Public booking wizard — what a stranger sees at `/c/<slug>/booking`.
 *
 * Steps:
 *   1. Profesional (skip if only one)
 *   2. Servicio
 *   3. Fecha + hora (calendar + slots backed by `listPublicSlots`)
 *   4. Tus datos — Google sign-in or HC form
 *   5. Confirmación + redirección a Mercado Pago
 *
 * The component is responsive: on desktop the steps run as a 2-column
 * layout (form left + summary right); on mobile they're a stack. State
 * is fully client-side; submission goes through the `submitPublicBooking`
 * server action which creates Patient + Booking + MP preference.
 */
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { KineLogo } from "@/components/ui/kine-logo";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { IconArrow, IconCheck, IconChevL, IconChevR, IconClock } from "@/components/ui/icons";
import { listPublicSlots, submitPublicBooking } from "@/lib/public-booking";
import type { PublicClinic, PublicSlot } from "@/lib/public-booking-types";

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
};

const STEPS = ["Profesional", "Servicio", "Fecha y hora", "Tus datos"] as const;
type Step = 0 | 1 | 2 | 3;

export function PublicBookingWizard({
  clinic,
  session,
  prefill,
}: {
  clinic: PublicClinic;
  session: { email: string; fullName: string | null } | null;
  prefill: PatientHC | null;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(clinic.practitioners.length === 1 ? 1 : 0);
  const [practitionerId, setPractitionerId] = useState<string | null>(
    clinic.practitioners.length === 1 ? clinic.practitioners[0].id : null
  );
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [dateISO, setDateISO] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [slotISO, setSlotISO] = useState<string | null>(null);
  const [hc, setHc] = useState<PatientHC>(() => {
    if (prefill) return prefill;
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

  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const practitioner = clinic.practitioners.find((p) => p.id === practitionerId) ?? null;
  const service = clinic.services.find((s) => s.id === serviceId) ?? null;

  // Filter services to this practitioner (or the general pool when set
  // to null at the service level).
  const visibleServices = useMemo(() => {
    if (!practitionerId) return clinic.services;
    return clinic.services.filter(
      (s) => s.practitionerId === practitionerId || s.practitionerId === null
    );
  }, [practitionerId, clinic.services]);

  const canAdvance =
    (step === 0 && !!practitionerId) ||
    (step === 1 && !!serviceId) ||
    (step === 2 && !!slotISO) ||
    (step === 3 && isHcValid(hc));

  const next = () => {
    if (!canAdvance) return;
    if (step === 3) {
      submit();
      return;
    }
    setStep((s) => (Math.min(3, s + 1) as Step));
  };
  const back = () =>
    setStep((s) =>
      Math.max(clinic.practitioners.length === 1 ? 1 : 0, s - 1) as Step
    );

  const submit = () => {
    setError(null);
    if (!practitionerId || !serviceId || !slotISO) {
      setError("Faltan datos para confirmar.");
      return;
    }
    start(async () => {
      const r = await submitPublicBooking({
        tenantSlug: clinic.slug,
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
          style={{
            padding: 24,
            display: "flex",
            flexDirection: "column",
            gap: 18,
            minHeight: 0,
          }}
        >
          {step === 0 && (
            <PractitionerStep
              clinic={clinic}
              value={practitionerId}
              onChange={setPractitionerId}
            />
          )}
          {step === 1 && (
            <ServiceStep
              services={visibleServices}
              value={serviceId}
              onChange={(id) => {
                setServiceId(id);
                // changing service might invalidate the slot
                setSlotISO(null);
              }}
            />
          )}
          {step === 2 && practitionerId && serviceId && (
            <SlotStep
              tenantSlug={clinic.slug}
              practitionerId={practitionerId}
              serviceId={serviceId}
              dateISO={dateISO}
              setDateISO={setDateISO}
              slotISO={slotISO}
              setSlotISO={setSlotISO}
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
              marginTop: "auto",
              paddingTop: 6,
            }}
          >
            {step > (clinic.practitioners.length === 1 ? 1 : 0) ? (
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
          service={service}
          slotISO={slotISO}
        />
      </main>
    </div>
  );
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
      className="k-glass"
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
        <Link
          href={`/api/auth/google?next=${encodeURIComponent(`/c/${clinic.slug}/booking`)}`}
          style={{
            padding: "7px 14px",
            borderRadius: 999,
            background: "rgba(255,255,255,0.7)",
            border: "1px solid rgba(15,30,51,0.08)",
            fontSize: 12,
            color: "var(--navy-900)",
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Iniciar sesión
        </Link>
      )}
    </header>
  );
}

function Header({ clinic, step }: { clinic: PublicClinic; step: Step }) {
  return (
    <div style={{ padding: "28px 24px 18px", position: "relative", zIndex: 4 }}>
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

// ─── Step 0 ─ Practitioner ─────────────────────────────────────────────
function PractitionerStep({
  clinic,
  value,
  onChange,
}: {
  clinic: PublicClinic;
  value: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <>
      <StepHeader title="¿Con quién querés atenderte?" subtitle="Elegí un profesional." />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {clinic.practitioners.map((p) => {
          const on = p.id === value;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onChange(p.id)}
              style={{
                textAlign: "left",
                padding: 14,
                borderRadius: 14,
                border: on
                  ? "1px solid var(--sky-700)"
                  : "1px solid rgba(15,30,51,0.06)",
                background: on ? "rgba(31,79,190,0.06)" : "rgba(255,255,255,0.7)",
                cursor: "pointer",
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 700 }}>{p.name}</div>
              <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>
                {p.specialty ?? "Kinesiología"}
                {p.licenseNumber ? ` · MN ${p.licenseNumber}` : ""}
              </div>
              {p.yearsExp != null && (
                <div className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)", marginTop: 4 }}>
                  {p.yearsExp} años de experiencia
                </div>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}

// ─── Step 1 ─ Service ──────────────────────────────────────────────────
function ServiceStep({
  services,
  value,
  onChange,
}: {
  services: PublicClinic["services"];
  value: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <>
      <StepHeader title="¿Qué servicio necesitás?" subtitle="Cada servicio tiene su duración + precio." />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {services.map((s) => {
          const on = s.id === value;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onChange(s.id)}
              style={{
                textAlign: "left",
                padding: "14px 16px",
                borderRadius: 14,
                border: on
                  ? "1px solid var(--sky-700)"
                  : "1px solid rgba(15,30,51,0.06)",
                background: on ? "rgba(31,79,190,0.06)" : "rgba(255,255,255,0.7)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{s.name}</div>
                {s.description && (
                  <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>{s.description}</div>
                )}
                <div className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)", marginTop: 4 }}>
                  {s.durationMin} min
                </div>
              </div>
              <div className="k-display" style={{ fontSize: 18, fontWeight: 700 }}>
                {fmtArs(s.priceCents)}
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}

// ─── Step 2 ─ Slot ─────────────────────────────────────────────────────
function SlotStep({
  tenantSlug,
  practitionerId,
  serviceId,
  dateISO,
  setDateISO,
  slotISO,
  setSlotISO,
}: {
  tenantSlug: string;
  practitionerId: string;
  serviceId: string;
  dateISO: string;
  setDateISO: (v: string) => void;
  slotISO: string | null;
  setSlotISO: (v: string | null) => void;
}) {
  const [slots, setSlots] = useState<PublicSlot[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listPublicSlots({ tenantSlug, practitionerId, serviceId, date: dateISO })
      .then((rows) => {
        if (cancelled) return;
        setSlots(rows);
        if (slotISO && !rows.find((r) => r.iso === slotISO && r.available)) {
          setSlotISO(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantSlug, practitionerId, serviceId, dateISO]);

  const shiftDate = (delta: number) => {
    const d = new Date(dateISO + "T00:00:00");
    d.setDate(d.getDate() + delta);
    setDateISO(d.toISOString().slice(0, 10));
    setSlotISO(null);
  };

  const today = new Date();
  const todayKey = today.toISOString().slice(0, 10);
  const selected = new Date(dateISO + "T00:00:00");
  return (
    <>
      <StepHeader title="Elegí día y horario" subtitle="Mostramos sólo los slots disponibles." />
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
            })}
          </div>
          <input
            type="date"
            value={dateISO}
            min={todayKey}
            onChange={(e) => {
              setDateISO(e.target.value);
              setSlotISO(null);
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
      ) : slots.length === 0 ? (
        <div
          style={{
            padding: 24,
            textAlign: "center",
            color: "var(--navy-500)",
            fontSize: 13,
            border: "1px dashed rgba(15,30,51,0.12)",
            borderRadius: 14,
          }}
        >
          El centro no atiende este día. Probá otro.
        </div>
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
            return (
              <button
                key={s.iso}
                type="button"
                onClick={() => s.available && setSlotISO(s.iso)}
                disabled={!s.available}
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
                }}
              >
                {s.time}
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
  clinic: PublicClinic;
  session: { email: string; fullName: string | null } | null;
  hc: PatientHC;
  setHc: (next: PatientHC) => void;
  error: string | null;
}) {
  const upd = <K extends keyof PatientHC>(k: K, v: PatientHC[K]) => setHc({ ...hc, [k]: v });
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
          <a
            href={`/api/auth/google?next=${encodeURIComponent(`/c/${clinic.slug}/booking`)}`}
            style={{
              padding: "8px 14px",
              borderRadius: 999,
              background: "#fff",
              border: "1px solid rgba(15,30,51,0.08)",
              fontSize: 12.5,
              color: "var(--navy-900)",
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            <span style={{ fontWeight: 700, color: "#4285F4", marginRight: 4 }}>G</span> Ingresar con
            Google
          </a>
        </Card>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
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
        placeholder="Contanos brevemente qué te trae (zona, desde cuándo, qué actividad sentís limitada)."
      />

      {error && (
        <div
          style={{
            padding: 10,
            borderRadius: 10,
            background: "rgba(228,70,70,0.1)",
            color: "#9F1F1F",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}
      <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
        Al continuar aceptás que la clínica use estos datos para tu atención. Cancelás gratis hasta
        6 hs antes.
      </div>
    </>
  );
}

// ─── Layout helpers ───────────────────────────────────────────────────
function StepHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header>
      <h2
        className="k-display"
        style={{ fontSize: 20, margin: 0, fontWeight: 700, letterSpacing: "-0.01em" }}
      >
        {title}
      </h2>
      <p style={{ fontSize: 12.5, color: "var(--navy-500)", margin: "4px 0 0" }}>{subtitle}</p>
    </header>
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
  service,
  slotISO,
}: {
  clinic: PublicClinic;
  practitioner: PublicClinic["practitioners"][number] | null;
  service: PublicClinic["services"][number] | null;
  slotISO: string | null;
}) {
  const when = slotISO
    ? new Date(slotISO).toLocaleString("es-AR", {
        weekday: "long",
        day: "2-digit",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Argentina/Buenos_Aires",
      })
    : null;
  return (
    <aside className="booking-summary" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card glass style={{ padding: 18 }}>
        <div className="k-display" style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>
          Tu turno
        </div>
        <Row label="Centro" value={clinic.name} />
        <Row label="Profesional" value={practitioner?.name ?? "—"} />
        <Row
          label="Servicio"
          value={service ? service.name : "—"}
          sub={service ? `${service.durationMin} min` : undefined}
        />
        <Row label="Fecha y hora" value={when ?? "—"} />
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
            Pago seguro vía Mercado Pago. Cancelás gratis hasta 6 hs antes.
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

import { KineLogo } from "@/components/ui/kine-logo";
import { Card, PhotoSlot } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import {
  IconArrow,
  IconActivity,
  IconCal,
  IconClock,
  IconHome,
  IconStar,
  IconCheck,
  IconChevL,
  IconChevR,
} from "@/components/ui/icons";
import type { ComponentType } from "react";

type Props = { tenantSlug?: string };

export function BookingScreen({ tenantSlug = "movare" }: Props) {
  return (
    <div
      className="k-app"
      data-screen-label="Booking público"
      style={{
        minHeight: "100vh",
        background: "var(--bg-app)",
        overflow: "hidden",
        position: "relative",
        display: "flex",
        flexDirection: "column",
      }}
    >
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
        }}
      />
      <BookingNav tenantSlug={tenantSlug} />
      <BookingHeader />
      <BookingBody />
    </div>
  );
}

function BookingNav({ tenantSlug }: { tenantSlug: string }) {
  return (
    <header
      className="k-glass"
      style={{
        margin: "18px 24px 0",
        padding: "12px 20px",
        borderRadius: 999,
        display: "flex",
        alignItems: "center",
        gap: 24,
        position: "relative",
        zIndex: 5,
        flexWrap: "wrap",
      }}
    >
      <KineLogo size={24} />
      <span style={{ fontSize: 12, color: "var(--navy-300)", marginLeft: -8 }}>
        · {tenantSlug}
      </span>
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
        <IconClock size={13} /> Atención: lun-vie 8 a 20hs
      </span>
      <span style={{ fontSize: 12.5, color: "var(--sky-700)", fontWeight: 600 }}>Mis turnos</span>
      <Button variant="ghost" style={{ fontSize: 12, padding: "7px 14px" }}>
        Iniciar sesión
      </Button>
    </header>
  );
}

function BookingHeader() {
  const steps = [
    { n: 1, label: "Profesional", done: true },
    { n: 2, label: "Servicio", done: true },
    { n: 3, label: "Fecha y hora", active: true },
    { n: 4, label: "Tus datos" },
  ];
  return (
    <div className="booking-header" style={{ padding: "32px 60px 24px", position: "relative", zIndex: 4 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 28,
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--sky-700)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            Centro KineMovare · Rosario
          </div>
          <h1
            className="k-display"
            style={{ fontSize: 36, margin: "4px 0 0", letterSpacing: "-0.03em" }}
          >
            Reservá tu turno en 30 segundos
          </h1>
        </div>
        <Tag tone="soft">
          <span style={{ width: 8, height: 8, borderRadius: 4, background: "var(--lime-400)" }} />
          1.842 turnos confirmados este mes
        </Tag>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        {steps.map((s, i) => (
          <div key={s.n} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  background: s.active
                    ? "var(--sky-700)"
                    : s.done
                      ? "var(--lime-300)"
                      : "rgba(255,255,255,0.5)",
                  color: s.active ? "#fff" : "var(--navy-900)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  fontWeight: 700,
                  border: s.active ? "none" : "1px solid rgba(15,30,51,0.08)",
                }}
              >
                {s.done ? <IconCheck size={13} stroke={3} /> : s.n}
              </span>
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: s.active ? 700 : 500,
                  color: s.active ? "var(--navy-900)" : s.done ? "var(--navy-700)" : "var(--navy-300)",
                }}
              >
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                style={{
                  width: 80,
                  height: 2,
                  background: "rgba(15,30,51,0.08)",
                  backgroundImage:
                    i < 1 ? "linear-gradient(90deg, var(--lime-400), var(--lime-400))" : undefined,
                }}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function BookingBody() {
  return (
    <main
      className="booking-body"
      style={{
        flex: 1,
        padding: "0 60px 36px",
        display: "flex",
        gap: 20,
        position: "relative",
        zIndex: 3,
        minHeight: 0,
      }}
    >
      <CalendarPanel />
      <BookingSummary />
    </main>
  );
}

function CalendarPanel() {
  return (
    <div
      className="k-glass-strong"
      style={{
        flex: 1,
        padding: 28,
        borderRadius: "var(--r-2xl)",
        display: "flex",
        flexDirection: "column",
        gap: 20,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h2 className="k-display" style={{ fontSize: 22, margin: 0, letterSpacing: "-0.02em" }}>
            Elegí un día
          </h2>
          <p style={{ fontSize: 13, color: "var(--navy-500)", margin: "4px 0 0" }}>
            Mayo 2026 · todos los horarios son de Argentina (GMT-3)
          </p>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button style={navBtnStyle}>
            <IconChevL size={14} />
          </button>
          <button style={navBtnStyle}>
            <IconChevR size={14} />
          </button>
        </div>
      </div>

      <BookingCalendar />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <div>
          <h3 className="k-display" style={{ fontSize: 18, margin: 0, fontWeight: 600 }}>
            Horarios para el{" "}
            <span style={{ color: "var(--sky-700)" }}>sábado 17 de mayo</span>
          </h3>
          <p style={{ fontSize: 12.5, color: "var(--navy-500)", margin: "2px 0 0" }}>
            Consultorio A · Av. Pellegrini 1234, Rosario
          </p>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <Tag tone="soft">
            <span style={{ width: 8, height: 8, borderRadius: 4, background: "var(--lime-400)" }} />{" "}
            Disponible
          </Tag>
          <Tag tone="soft">
            <span style={{ width: 8, height: 8, borderRadius: 4, background: "var(--navy-100)" }} />{" "}
            Ocupado
          </Tag>
        </div>
      </div>

      <SlotsGrid />
    </div>
  );
}

const navBtnStyle = {
  width: 32,
  height: 32,
  borderRadius: 10,
  background: "rgba(255,255,255,0.7)",
  border: "1px solid rgba(15,30,51,0.06)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--navy-700)",
  cursor: "pointer",
} as const;

function BookingCalendar() {
  const days = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
  const grid: (number | null)[][] = [
    [null, null, null, null, 1, 2, 3],
    [4, 5, 6, 7, 8, 9, 10],
    [11, 12, 13, 14, 15, 16, 17],
    [18, 19, 20, 21, 22, 23, 24],
    [25, 26, 27, 28, 29, 30, 31],
  ];
  const selected = 17;
  const today = 14;
  const avail: Record<number, number> = {
    14: 0,
    15: 6,
    16: 3,
    17: 8,
    18: 0,
    19: 4,
    20: 5,
    21: 7,
    22: 2,
    23: 5,
    24: 0,
    25: 6,
    26: 4,
    28: 3,
    29: 6,
    30: 4,
  };
  const past = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

  return (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gap: 4,
          marginBottom: 8,
        }}
      >
        {days.map((d) => (
          <div
            key={d}
            style={{
              textAlign: "center",
              fontSize: 10,
              color: "var(--navy-300)",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              padding: "6px 0",
            }}
          >
            {d}
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
        {grid.flat().map((n, i) => {
          if (n == null) return <div key={i} />;
          const isSelected = n === selected;
          const isToday = n === today;
          const isPast = past.has(n);
          const a = avail[n] || 0;
          const hasSlots = a > 0 && !isPast;
          return (
            <div
              key={i}
              style={{
                padding: "10px 6px",
                borderRadius: 14,
                textAlign: "center",
                position: "relative",
                background: isSelected
                  ? "linear-gradient(135deg, var(--sky-700), var(--sky-500))"
                  : hasSlots
                    ? "rgba(255,255,255,0.7)"
                    : "rgba(255,255,255,0.3)",
                border:
                  "1px solid " +
                  (isSelected
                    ? "transparent"
                    : isToday
                      ? "var(--lime-400)"
                      : "rgba(15,30,51,0.04)"),
                color: isSelected ? "#fff" : isPast ? "var(--navy-200)" : "var(--navy-700)",
                opacity: isPast ? 0.5 : 1,
                boxShadow: isSelected ? "0 10px 22px rgba(31,79,190,0.28)" : "none",
                minHeight: 56,
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: 4,
              }}
            >
              <div className="k-display" style={{ fontSize: 16, fontWeight: isSelected ? 700 : 600 }}>
                {n}
              </div>
              {hasSlots && !isSelected && (
                <div style={{ fontSize: 9.5, color: "var(--sky-700)", fontWeight: 600 }}>
                  {a} libres
                </div>
              )}
              {isSelected && (
                <div style={{ fontSize: 9.5, opacity: 0.85, fontWeight: 600 }}>{a} libres</div>
              )}
              {!hasSlots && !isPast && !isSelected && (
                <div style={{ fontSize: 9.5, color: "var(--navy-200)" }}>cerrado</div>
              )}
              {isToday && !isSelected && (
                <span
                  style={{
                    position: "absolute",
                    top: 4,
                    right: 4,
                    padding: "0 4px",
                    fontSize: 8,
                    borderRadius: 4,
                    background: "var(--lime-300)",
                    color: "var(--navy-900)",
                    fontWeight: 700,
                  }}
                >
                  HOY
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SlotsGrid() {
  const slots: { t: string; avail: boolean; selected?: boolean }[] = [
    { t: "08:00", avail: false },
    { t: "08:45", avail: true },
    { t: "09:30", avail: true },
    { t: "10:15", avail: true, selected: true },
    { t: "11:00", avail: true },
    { t: "11:45", avail: false },
    { t: "12:30", avail: false },
    { t: "14:00", avail: true },
    { t: "14:45", avail: true },
    { t: "15:30", avail: false },
    { t: "16:15", avail: true },
    { t: "17:00", avail: true },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8 }}>
      {slots.map((s) => {
        const on = !!s.selected;
        return (
          <div
            key={s.t}
            style={{
              padding: "12px 8px",
              borderRadius: 12,
              textAlign: "center",
              background: on
                ? "var(--sky-700)"
                : s.avail
                  ? "rgba(255,255,255,0.7)"
                  : "rgba(15,30,51,0.04)",
              color: on ? "#fff" : s.avail ? "var(--navy-900)" : "var(--navy-200)",
              border:
                "1px solid " +
                (on ? "transparent" : s.avail ? "rgba(15,30,51,0.06)" : "transparent"),
              boxShadow: on ? "0 8px 18px rgba(31,79,190,0.28)" : "none",
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "JetBrains Mono, ui-monospace, monospace",
              textDecoration: s.avail ? "none" : "line-through",
              position: "relative",
              cursor: s.avail ? "pointer" : "not-allowed",
            }}
          >
            {s.t}
            {on && (
              <span
                style={{
                  position: "absolute",
                  top: 4,
                  right: 4,
                  padding: "0 5px",
                  fontSize: 8,
                  borderRadius: 4,
                  background: "var(--lime-300)",
                  color: "var(--navy-900)",
                  fontWeight: 700,
                }}
              >
                ELEGIDO
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BookingSummary() {
  return (
    <aside
      className="booking-summary"
      style={{ width: 360, display: "flex", flexDirection: "column", gap: 14 }}
    >
      <Card glass style={{ padding: 18, display: "flex", alignItems: "center", gap: 14 }}>
        <PhotoSlot
          label="kine · foto"
          style={{ width: 64, height: 64, borderRadius: 18, flexShrink: 0 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 11,
              color: "var(--sky-700)",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            Tu kinesióloga
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2, letterSpacing: "-0.01em" }}>
            Lic. Lucía Méndez
          </div>
          <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>
            MN 5.412 · 12 años de experiencia
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4 }}>
            {[1, 2, 3, 4, 5].map((i) => (
              <IconStar
                key={i}
                size={11}
                fill="var(--lime-400)"
                style={{ color: "var(--lime-400)" }}
              />
            ))}
            <span
              className="k-mono"
              style={{ fontSize: 10, color: "var(--navy-500)", marginLeft: 4 }}
            >
              4.9 · 248 opiniones
            </span>
          </div>
        </div>
      </Card>

      <Card glass style={{ padding: 20, flex: 1, display: "flex", flexDirection: "column" }}>
        <div className="k-display" style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>
          Tu turno
        </div>

        <SumRow icon={IconActivity} label="Servicio" value="Sesión kinésica" sub="45 minutos · presencial" />
        <SumRow icon={IconCal} label="Fecha" value="Sábado 17 de mayo" sub="2026" />
        <SumRow icon={IconClock} label="Hora" value="10:15 hs" sub="Llegá 10 min antes" />
        <SumRow
          icon={IconHome}
          label="Lugar"
          value="Consultorio A"
          sub="Av. Pellegrini 1234, Rosario"
          last
        />

        <div style={{ flex: 1 }} />

        <div
          style={{
            padding: "14px 16px",
            borderRadius: 14,
            background: "rgba(246,249,253,0.7)",
            border: "1px dashed rgba(15,30,51,0.1)",
            marginBottom: 14,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 13,
            }}
          >
            <span style={{ color: "var(--navy-500)" }}>Particular</span>
            <span className="k-display" style={{ fontWeight: 700 }}>$ 18.500</span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 12,
              color: "var(--navy-300)",
              marginTop: 6,
            }}
          >
            <span>O abonás con OSDE / Swiss Medical / Particular</span>
          </div>
        </div>

        <form action="/api/booking/checkout" method="post">
          <input type="hidden" name="serviceId" value="default" />
          <input type="hidden" name="practitionerId" value="default" />
          <input type="hidden" name="scheduledFor" value="2026-05-17T10:15:00-03:00" />
          <Button
            variant="primary"
            type="submit"
            style={{ width: "100%", justifyContent: "center", padding: "14px", fontSize: 14 }}
          >
            Continuar a tus datos <IconArrow size={15} />
          </Button>
        </form>
        <div style={{ fontSize: 11, color: "var(--navy-300)", textAlign: "center", marginTop: 10 }}>
          Cancelás gratis hasta 6hs antes
        </div>
      </Card>
    </aside>
  );
}

function SumRow({
  icon: I,
  label,
  value,
  sub,
  last,
}: {
  icon: ComponentType<{ size?: number }>;
  label: string;
  value: string;
  sub: string;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: "10px 0",
        borderBottom: last ? "none" : "1px solid rgba(15,30,51,0.05)",
      }}
    >
      <span
        style={{
          width: 32,
          height: 32,
          borderRadius: 10,
          flexShrink: 0,
          background: "var(--sky-100)",
          color: "var(--sky-700)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <I size={14} />
      </span>
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
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            color: "var(--navy-900)",
            marginTop: 1,
          }}
        >
          {value}
        </div>
        <div style={{ fontSize: 11, color: "var(--navy-500)", marginTop: 1 }}>{sub}</div>
      </div>
    </div>
  );
}

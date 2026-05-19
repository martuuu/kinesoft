"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { Card, PhotoSlot } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import {
  IconActivity,
  IconArrow,
  IconArrowUp,
  IconBookmark,
  IconCal,
  IconSearch,
  IconUsers,
  IconChart,
  IconHeart,
} from "@/components/ui/icons";
import { useTweaks } from "@/components/layout/tweaks-context";
import type { DashboardData } from "@/lib/dashboard";
import { dismissReminder } from "@/lib/notifications";
import type { KpiKey, Preferences } from "@/lib/preferences";
import { NotificationsBell } from "@/components/dashboard/notifications-bell";
import { MiniCalendar } from "@/components/dashboard/mini-calendar";
import { SessionsChart } from "@/components/dashboard/sessions-chart";
import { RecentPatients } from "@/components/dashboard/recent-patients";
import { PinKpiButton } from "@/components/dashboard/pin-kpi-button";
import { ProfileMenu } from "@/components/global/profile-menu";

function fmtARS(cents: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export function DashboardScreen({
  data,
  preferences,
  initialBookingDays,
}: {
  data: DashboardData;
  preferences: Preferences;
  initialBookingDays: number[];
}) {
  const { t, set } = useTweaks();
  const useSidebar = t.dashChrome === "sidebar";

  // Sync server-persisted palette into the live Tweaks context once on
  // mount. The provider initialises from localStorage; the server-side
  // preference takes precedence when present.
  useEffect(() => {
    if (preferences.palette && preferences.palette !== t.palette) {
      set("palette", preferences.palette);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ display: "flex", gap: 18, minHeight: 0 }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
        {useSidebar && <DashTopRow name={data.greetingName} todayCount={data.todayCount} />}
        {!data.reminderDismissed && (
          <HeroReminder
            nearingDischarge={data.pinned.nearingDischarge}
            reminderKey={data.reminderKey}
          />
        )}
        <PinnedRow pinned={data.pinned} pinnedKpis={data.pinnedKpis} todayCount={data.todayCount} monthCents={data.monthRevenueCents} />
        <BottomRow bars={data.weeklyBars} recent={data.recent} />
      </div>

      <aside className="dash-aside" style={{ width: 320, display: "flex", flexDirection: "column", gap: 14 }}>
        {useSidebar && (
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12 }}>
            <NotificationsBell />
            <ProfileMenu name={data.greetingName} preferences={preferences} />
          </div>
        )}
        <MiniCalendar initialBookingDays={initialBookingDays} />
        <NextAppts items={data.next} />
        <RevenueCard
          cents={data.monthRevenueCents}
          prev={data.revenuePrevMonthCents}
          privateShare={data.privateShare}
          insurerShare={data.insurerShare}
        />
      </aside>
    </div>
  );
}

function DashTopRow({ name, todayCount }: { name: string; todayCount: number }) {
  // Dispatch the same ⌘K keyboard event so the global palette opens.
  const openPalette = () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })
    );
  };
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
      <div>
        <div style={{ fontSize: 13, color: "var(--navy-300)", fontWeight: 500 }}>Hola, Lic. {name} 👋</div>
        <h1 className="k-display" style={{ fontSize: 34, margin: "2px 0 0", lineHeight: 1.05 }}>
          Hoy tenés{" "}
          <span style={{ color: "var(--sky-700)" }}>
            {todayCount} {todayCount === 1 ? "sesión" : "sesiones"}
          </span>{" "}
          agendadas
        </h1>
      </div>
      <button
        type="button"
        onClick={openPalette}
        aria-label="Abrir búsqueda rápida"
        className="k-glass"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 14px",
          borderRadius: 999,
          minWidth: 280,
          fontSize: 13,
          color: "var(--navy-300)",
          border: "none",
          cursor: "pointer",
        }}
      >
        <IconSearch size={15} /> Buscar paciente, ejercicio…
        <span style={{ flex: 1 }} />
        <span
          className="k-mono"
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: "2px 7px",
            borderRadius: 5,
            border: "1px solid rgba(15,30,51,0.1)",
            color: "var(--navy-500)",
          }}
        >
          ⌘K
        </span>
      </button>
    </div>
  );
}

function HeroReminder({
  nearingDischarge,
  reminderKey,
}: {
  nearingDischarge: number;
  reminderKey: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const dismiss = () => {
    start(async () => {
      await dismissReminder({ key: reminderKey, hours: 24 * 7 });
      router.refresh();
    });
  };
  return (
    <div
      style={{
        borderRadius: "var(--r-xl)",
        overflow: "hidden",
        position: "relative",
        background:
          "linear-gradient(115deg, var(--sky-700) 0%, var(--sky-500) 60%, var(--sky-400) 100%)",
        color: "#fff",
        padding: "28px 32px",
        display: "flex",
        alignItems: "center",
        gap: 24,
        minHeight: 180,
        boxShadow: "0 12px 36px rgba(31, 79, 190, 0.28)",
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: -60,
          right: 180,
          width: 240,
          height: 240,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(255,255,255,0.15), transparent 70%)",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 30,
          right: -40,
          width: 180,
          height: 180,
          borderRadius: "50%",
          background: "radial-gradient(circle, var(--lime-300), transparent 60%)",
          opacity: 0.35,
        }}
      />
      <div style={{ flex: 1, position: "relative", zIndex: 2 }}>
        <span
          className="k-tag"
          style={{
            background: "rgba(255,255,255,0.18)",
            color: "#fff",
            backdropFilter: "blur(8px)",
          }}
        >
          Recordatorio
        </span>
        <h2
          className="k-display"
          style={{ fontSize: 28, margin: "14px 0 8px", lineHeight: 1.1, fontWeight: 600 }}
        >
          {nearingDischarge} {nearingDischarge === 1 ? "paciente termina" : "pacientes terminan"} su plan
          <br />
          esta semana
        </h2>
        <p style={{ fontSize: 13.5, color: "rgba(255,255,255,0.85)", maxWidth: 380, margin: 0, lineHeight: 1.5 }}>
          Revisá su evolución y dejá programada el alta o la continuidad.
        </p>
        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
          <Link
            href="/pacientes?filter=active"
            className="k-btn"
            style={{ background: "#fff", color: "var(--navy-900)", textDecoration: "none" }}
          >
            Revisar pacientes <IconArrow size={14} />
          </Link>
          <button
            type="button"
            onClick={dismiss}
            disabled={pending}
            className="k-btn"
            style={{
              background: "rgba(255,255,255,0.15)",
              color: "#fff",
              border: "1px solid rgba(255,255,255,0.25)",
              cursor: pending ? "wait" : "pointer",
            }}
          >
            {pending ? "Ocultando…" : "Más tarde"}
          </button>
        </div>
      </div>
      <PhotoSlot
        label="kine c/paciente"
        style={{
          width: 220,
          height: 160,
          borderRadius: 20,
          flexShrink: 0,
          background: "rgba(255,255,255,0.18)",
          border: "1px solid rgba(255,255,255,0.3)",
        }}
      />
    </div>
  );
}

function PinnedRow({
  pinned,
  pinnedKpis,
  todayCount,
  monthCents,
}: {
  pinned: DashboardData["pinned"];
  pinnedKpis: KpiKey[];
  todayCount: number;
  monthCents: number;
}) {
  const all: Record<KpiKey, { ic: typeof IconUsers; n: string; l: string; delta: string; tone: "sky" | "lime" | "soft" }> = {
    activePatients: {
      ic: IconUsers,
      n: pinned.activePatients.toString(),
      l: "Pacientes activos",
      delta: `+${pinned.newPatientsMonth} este mes`,
      tone: "sky",
    },
    weekSessions: {
      ic: IconCal,
      n: pinned.weekSessions.toString(),
      l: "Sesiones esta semana",
      delta: `${pinned.adherencePct}% adherencia`,
      tone: "lime",
    },
    activePrograms: {
      ic: IconActivity,
      n: pinned.activePrograms.toString(),
      l: "Planes en curso",
      delta: `${pinned.nearingDischarge} cerca del alta`,
      tone: "soft",
    },
    todayCount: {
      ic: IconCal,
      n: todayCount.toString(),
      l: "Turnos hoy",
      delta: "Sin cancelados",
      tone: "sky",
    },
    monthRevenue: {
      ic: IconChart,
      n: new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(monthCents / 100),
      l: "Ingresos del mes",
      delta: "Sólo pagos PAID",
      tone: "lime",
    },
    adherence: {
      ic: IconActivity,
      n: `${pinned.adherencePct}%`,
      l: "Adherencia semanal",
      delta: `${pinned.weekSessions} sesiones`,
      tone: "lime",
    },
    nearingDischarge: {
      ic: IconHeart,
      n: pinned.nearingDischarge.toString(),
      l: "Cerca del alta",
      delta: "Planes a revisar",
      tone: "soft",
    },
    newPatientsMonth: {
      ic: IconUsers,
      n: pinned.newPatientsMonth.toString(),
      l: "Pacientes nuevos",
      delta: "Este mes",
      tone: "sky",
    },
  };
  const items = pinnedKpis.map((k) => all[k]).filter(Boolean).slice(0, 6);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--navy-700)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <IconBookmark size={14} /> Indicadores fijados
        </div>
        <PinKpiButton currentPinned={pinnedKpis} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        {items.map((it, i) => {
          const I = it.ic;
          return (
            <div
              key={i}
              className="k-glass"
              style={{
                padding: "16px 18px",
                borderRadius: "var(--r-lg)",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background:
                      it.tone === "lime"
                        ? "var(--lime-300)"
                        : it.tone === "sky"
                          ? "var(--sky-100)"
                          : "rgba(255,255,255,0.6)",
                    color: it.tone === "lime" ? "var(--navy-900)" : "var(--sky-700)",
                  }}
                >
                  <I size={16} />
                </span>
                <span style={{ fontSize: 11, color: "var(--sky-700)", fontWeight: 600 }}>{it.delta}</span>
              </div>
              <div
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  letterSpacing: "-0.02em",
                  color: "var(--navy-900)",
                }}
              >
                {it.n}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--navy-500)" }}>{it.l}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BottomRow({
  bars,
  recent,
}: {
  bars: DashboardData["weeklyBars"];
  recent: DashboardData["recent"];
}) {
  // Adapt the legacy `weeklyBars` shape ({d,c,a}) to the new `ChartBar`
  // shape ({label,done,missed}) for the imported SessionsChart.
  const initialBars = bars.map((b) => ({ label: b.d, done: b.c, missed: b.a }));
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12, flex: 1, minHeight: 0 }}>
      <SessionsChart initialBars={initialBars} />
      <RecentPatients items={recent} />
    </div>
  );
}

function NextAppts({ items }: { items: DashboardData["next"] }) {
  return (
    <Card style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div className="k-display" style={{ fontSize: 15, fontWeight: 600 }}>
            Próximos turnos
          </div>
          <div style={{ fontSize: 11, color: "var(--navy-300)" }}>Hoy</div>
        </div>
        <Tag tone="lime">{items.length} turnos</Tag>
      </div>
      {items.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--navy-300)", padding: 8 }}>Sin turnos próximos.</div>
      )}
      {items.map((a, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 4px" }}>
          <div
            className="k-mono"
            style={{ fontSize: 12, color: "var(--sky-700)", fontWeight: 600, width: 40 }}
          >
            {a.time}
          </div>
          <Avatar name={a.name} size={30} tone="sky" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy-900)" }}>{a.name}</div>
            <div style={{ fontSize: 11, color: "var(--navy-500)" }}>{a.tag}</div>
          </div>
        </div>
      ))}
      <Link href="/agenda" style={{ textDecoration: "none" }}>
        <Button variant="ghost" style={{ width: "100%", justifyContent: "center", fontSize: 12.5, padding: 10, marginTop: 4 }}>
          Ver agenda completa →
        </Button>
      </Link>
    </Card>
  );
}

function RevenueCard({
  cents,
  prev,
  privateShare,
  insurerShare,
}: {
  cents: number;
  prev: number;
  privateShare: number;
  insurerShare: number;
}) {
  const delta = prev ? Math.round(((cents - prev) / prev) * 100) : null;
  const upward = (delta ?? 0) >= 0;
  return (
    <Card
      style={{
        padding: 18,
        background: "linear-gradient(160deg, var(--navy-900), var(--navy-700))",
        color: "#fff",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          marginBottom: 14,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              color: "rgba(255,255,255,0.6)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              fontWeight: 600,
            }}
          >
            Ingresos del mes
          </div>
          <div className="k-display" style={{ fontSize: 28, marginTop: 4, fontWeight: 600 }}>
            {fmtARS(cents)}
          </div>
        </div>
        {delta != null && (
          <span
            style={{
              padding: "4px 8px",
              borderRadius: 8,
              background: upward ? "rgba(180,233,74,0.2)" : "rgba(228,70,70,0.2)",
              color: upward ? "var(--lime-300)" : "#FFC0C0",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {upward ? "+" : ""}{delta}%{" "}
            {upward && <IconArrowUp size={10} style={{ display: "inline-block", verticalAlign: -2 }} />}
          </span>
        )}
      </div>
      <div
        style={{
          display: "flex",
          height: 6,
          borderRadius: 3,
          overflow: "hidden",
          background: "rgba(255,255,255,0.1)",
        }}
      >
        <div style={{ width: `${privateShare}%`, background: "var(--lime-400)" }} />
        <div style={{ width: `${insurerShare}%`, background: "var(--sky-500)" }} />
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 10,
          fontSize: 11,
          color: "rgba(255,255,255,0.7)",
        }}
      >
        <span>Consultas privadas · {privateShare}%</span>
        <span>Obras sociales · {insurerShare}%</span>
      </div>
    </Card>
  );
}

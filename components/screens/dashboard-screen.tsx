"use client";

import { USER_NO_NAME } from "@/lib/display-name";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { Variants } from "framer-motion";
import { DUR, EASE_OUT, springSoft } from "@/lib/motion";
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
import { dismissReminder, restoreReminder } from "@/lib/notifications";
import {
  effectivePinnedKpis,
  GENERAL_KPI_COPY,
  type KpiKey,
  type Preferences,
} from "@/lib/preferences-constants";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { NotificationsBell } from "@/components/dashboard/notifications-bell";
import { MiniCalendar } from "@/components/dashboard/mini-calendar";
import { SessionsChart } from "@/components/dashboard/sessions-chart";
import { RecentPatients } from "@/components/dashboard/recent-patients";
import { PinKpiButton } from "@/components/dashboard/pin-kpi-button";
import { RevenueCard } from "@/components/dashboard/revenue-card";
import { formatARS } from "@/lib/format";
import { ProfileMenu } from "@/components/global/profile-menu";

/**
 * [PF-0c] Entrada de los indicadores fijados, recortada. Con `staggerList`/`staggerItem` (35 ms entre tarjetas,
 * 220 ms cada una, subida de 8 px) las 6 tarjetas tardaban ~415 ms en asentarse: se sumaba a la carga y el tablero
 * se sentía lento aunque los datos ya estuvieran. Ahora: ≤ 6 ítems × 15 ms + 120 ms = ≤ 195 ms en total, solo
 * opacidad (sin desplazamiento, así el `whileHover` no compite con la entrada). Con reduce motion, `MotionConfig`
 * lo deja estático.
 */
const KPI_ENTER_LIST: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.015 } },
};
const KPI_ENTER_ITEM: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.12, ease: EASE_OUT } },
};

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
  // EV1-A: el dashboard se arma por módulos (`useTenantModules`, lo publica el
  // AppShell). Sin `planes` (consultorio General) no hay recordatorio de altas
  // ni KPIs de planes; sin `sesiones`, lo que decía "sesiones" son "turnos" y
  // la tarjeta "Últimas sesiones registradas" (siempre vacía ahí) no se monta.
  // Fuera del provider el default es Kine PRO: lo de siempre.
  const modules = useTenantModules();
  const hasPlans = modules.has("planes");
  const hasSessions = modules.has("sesiones");

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
        {useSidebar && (
          <DashTopRow name={data.greetingName} todayCount={data.todayCount} kine={hasSessions} />
        )}
        {hasPlans && (
          <ReminderSlot
            initiallyDismissed={data.reminderDismissed}
            nearingDischarge={data.pinned.nearingDischarge}
            reminderKey={data.reminderKey}
          />
        )}
        <PinnedRow
          pinned={data.pinned}
          pinnedKpis={effectivePinnedKpis(data.pinnedKpis, data.revenueScope, modules)}
          todayCount={data.todayCount}
          monthRevenue={data.monthRevenue}
          revenueScope={data.revenueScope}
          hasPlans={hasPlans}
          hasSessions={hasSessions}
        />
        <BottomRow bars={data.weeklyBars} recent={hasSessions ? data.recent : null} />
      </div>

      <aside className="dash-aside" style={{ width: 320, display: "flex", flexDirection: "column", gap: 14 }}>
        {useSidebar && (
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12 }}>
            <NotificationsBell />
            <ProfileMenu name={data.greetingName || USER_NO_NAME} preferences={preferences} revenueScope={data.revenueScope} ownPublicBooking={data.ownPublicBooking} />
          </div>
        )}
        <MiniCalendar initialBookingDays={initialBookingDays} />
        <NextAppts items={data.next} />
        {/* SR-D5I: `revenue` null = el rol no ve ingresos (Secretaria): sin widget. */}
        {data.revenue && data.revenueScope !== "none" && (
          <RevenueCard initial={data.revenue} month={data.monthRevenue ?? undefined} scope={data.revenueScope} />
        )}
      </aside>
    </div>
  );
}

/**
 * `kine` = el consultorio tiene `sesiones` (Kinesiología). El "Lic." y las
 * "sesiones" son de Kine; en General el profesional no es necesariamente
 * licenciado y lo que se agenda son turnos.
 */
function DashTopRow({ name, todayCount, kine }: { name: string; todayCount: number; kine: boolean }) {
  // Dispatch the same ⌘K keyboard event so the global palette opens.
  const openPalette = () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })
    );
  };
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
      <div>
        {/* DIR-0: sin nombre cargado el saludo va sin nombre (`greetingName` = ""), nunca con el email. */}
        <div style={{ fontSize: 13, color: "var(--navy-300)", fontWeight: 500 }}>
          {name ? `Hola, ${kine ? "Lic. " : ""}${name}` : "Hola"} 👋
        </div>
        <h1 className="k-display" style={{ fontSize: 34, margin: "2px 0 0", lineHeight: 1.05 }}>
          Hoy tenés{" "}
          <span style={{ color: "var(--sky-700)" }}>
            {todayCount}{" "}
            {kine ? (todayCount === 1 ? "sesión" : "sesiones") : todayCount === 1 ? "turno" : "turnos"}
          </span>{" "}
          {kine ? "agendadas" : todayCount === 1 ? "agendado" : "agendados"}
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
        <IconSearch size={15} /> {kine ? "Buscar paciente, ejercicio…" : "Buscar paciente…"}
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

/**
 * Owns the local "dismissed" flag so the banner hides instantly when the
 * user clicks "Más tarde" — the server write is fire-and-forget. While
 * hidden, a small pill renders in place so the user can bring it back.
 */
function ReminderSlot({
  initiallyDismissed,
  nearingDischarge,
  reminderKey,
}: {
  initiallyDismissed: boolean;
  nearingDischarge: number;
  reminderKey: string;
}) {
  const [hidden, setHidden] = useState(initiallyDismissed);

  if (hidden) {
    return (
      <RestoreReminderPill
        nearingDischarge={nearingDischarge}
        reminderKey={reminderKey}
        onRestore={() => setHidden(false)}
      />
    );
  }
  return (
    <HeroReminder
      nearingDischarge={nearingDischarge}
      reminderKey={reminderKey}
      onDismiss={() => setHidden(true)}
    />
  );
}

function RestoreReminderPill({
  nearingDischarge,
  reminderKey,
  onRestore,
}: {
  nearingDischarge: number;
  reminderKey: string;
  onRestore: () => void;
}) {
  const [pending, start] = useTransition();
  const restore = () => {
    onRestore();
    start(async () => {
      await restoreReminder(reminderKey);
    });
  };
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "10px 14px",
        borderRadius: 999,
        background: "rgba(255,255,255,0.55)",
        border: "1px dashed rgba(15,30,51,0.12)",
        fontSize: 12.5,
        color: "var(--navy-500)",
      }}
    >
      <span>
        Recordatorio oculto · {nearingDischarge}{" "}
        {nearingDischarge === 1 ? "paciente" : "pacientes"} cerca del alta
      </span>
      <button
        type="button"
        onClick={restore}
        disabled={pending}
        style={{
          padding: "5px 12px",
          borderRadius: 999,
          border: "none",
          background: "var(--sky-700)",
          color: "#fff",
          fontSize: 11.5,
          fontWeight: 700,
          cursor: pending ? "wait" : "pointer",
        }}
      >
        {pending ? "Restaurando…" : "Mostrar"}
      </button>
    </div>
  );
}

function HeroReminder({
  nearingDischarge,
  reminderKey,
  onDismiss,
}: {
  nearingDischarge: number;
  reminderKey: string;
  onDismiss: () => void;
}) {
  const [pending, start] = useTransition();
  const dismiss = () => {
    // Optimistic — hide immediately, persist in the background.
    onDismiss();
    start(async () => {
      await dismissReminder({ key: reminderKey, hours: 24 * 7 });
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
  monthRevenue,
  revenueScope,
  hasPlans,
  hasSessions,
}: {
  pinned: DashboardData["pinned"];
  pinnedKpis: KpiKey[];
  todayCount: number;
  monthRevenue: DashboardData["monthRevenue"];
  revenueScope: DashboardData["revenueScope"];
  hasPlans: boolean;
  hasSessions: boolean;
}) {
  type Kpi = { ic: typeof IconUsers; n: string; l: string; delta: string; tone: "sky" | "lime" | "soft" };
  // SR-D5I: sin ingresos para este rol (Secretaria) la KPI fijada no se
  // muestra: ni un "$0" que parezca dato. La preferencia guardada no se toca.
  // EV1-A: en General `pinnedKpis` ya llega sin las de planes
  // (`effectivePinnedKpis`); acá solo cambia el rótulo de las que se quedan
  // (mismo texto que el picker, `GENERAL_KPI_COPY`).
  const all: Record<KpiKey, Kpi | null> = {
    activePatients: {
      ic: IconUsers,
      n: pinned.activePatients.toString(),
      l: hasPlans ? "Pacientes activos" : GENERAL_KPI_COPY.activePatients.label,
      delta: hasPlans ? `+${pinned.newPatientsMonth} este mes` : "Últimos 30 días",
      tone: "sky",
    },
    weekSessions: {
      ic: IconCal,
      n: pinned.weekSessions.toString(),
      l: hasSessions ? "Sesiones esta semana" : GENERAL_KPI_COPY.weekSessions.label,
      delta: `${pinned.adherencePct}% ${hasSessions ? "adherencia" : "asistencia"}`,
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
    monthRevenue: monthRevenue
      ? {
          ic: IconChart,
          // S14r: MP + copagos cobrados a mano (antes "Sólo pagos PAID" de MP). La
          // obra social va aparte, como en el widget.
          n: formatARS(monthRevenue.totalCents),
          l: revenueScope === "own" ? "Tus ingresos del mes" : "Ingresos del mes",
          delta: monthRevenue.insurerCents
            ? `+ ${formatARS(monthRevenue.insurerCents)} de obras sociales`
            : "MP + copagos",
          tone: "lime",
        }
      : null,
    adherence: {
      ic: IconActivity,
      n: `${pinned.adherencePct}%`,
      l: hasSessions ? "Adherencia semanal" : GENERAL_KPI_COPY.adherence.label,
      // EV1: concordancia de número («1 sesión», no «1 sesiones»).
      delta: `${pinned.weekSessions} ${
        hasSessions
          ? pinned.weekSessions === 1 ? "sesión" : "sesiones"
          : pinned.weekSessions === 1 ? "turno" : "turnos"
      }`,
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
  const items = pinnedKpis.map((k) => all[k]).filter((x): x is Kpi => !!x).slice(0, 6);
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
        <PinKpiButton currentPinned={pinnedKpis} revenueScope={revenueScope} />
      </div>
      <motion.div
        variants={KPI_ENTER_LIST}
        initial="initial"
        animate="animate"
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}
      >
        {items.map((it, i) => (
          <KpiCard key={i} it={it} />
        ))}
      </motion.div>
    </div>
  );
}

/**
 * Smoothly counts a plain integer up from 0 on mount. Anything that isn't a
 * bare integer string (currency, "85%", etc.) is returned verbatim so the
 * formatters are never touched. Honours `prefers-reduced-motion`.
 */
function useCountUp(value: string): string {
  const reduce = useReducedMotion();
  const isPlainInt = /^\d+$/.test(value);
  const target = isPlainInt ? parseInt(value, 10) : 0;
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (!isPlainInt) return;
    if (reduce || target === 0) {
      setDisplay(target);
      return;
    }
    let raf = 0;
    const duration = 600;
    const startedAt = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      setDisplay(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, isPlainInt, reduce]);

  return isPlainInt ? String(display) : value;
}

function KpiCard({
  it,
}: {
  it: { ic: typeof IconUsers; n: string; l: string; delta: string; tone: "sky" | "lime" | "soft" };
}) {
  const I = it.ic;
  const shownNumber = useCountUp(it.n);
  return (
    <motion.div
      variants={KPI_ENTER_ITEM}
      whileHover={{ y: -3, scale: 1.015 }}
      transition={springSoft}
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
        {shownNumber}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--navy-500)" }}>{it.l}</div>
    </motion.div>
  );
}

function BottomRow({
  bars,
  recent,
}: {
  bars: DashboardData["weeklyBars"];
  /** `null` = sin `sesiones` (General): no hay "Últimas sesiones registradas" y el gráfico ocupa la fila. */
  recent: DashboardData["recent"] | null;
}) {
  // Adapt the legacy `weeklyBars` shape ({d,c,a}) to the new `ChartBar`
  // shape ({label,done,missed}) for the imported SessionsChart.
  const initialBars = bars.map((b) => ({ label: b.d, done: b.c, missed: b.a }));
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: recent ? "1.4fr 1fr" : "1fr",
        gap: 12,
        flex: 1,
        minHeight: 0,
      }}
    >
      <SessionsChart initialBars={initialBars} unit={recent ? "sessions" : "bookings"} />
      {recent && <RecentPatients items={recent} />}
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
        <Tag tone="lime">{items.length} {items.length === 1 ? "turno" : "turnos"}</Tag>
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

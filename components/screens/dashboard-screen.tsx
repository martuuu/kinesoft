"use client";

import { USER_NO_NAME } from "@/lib/display-name";
import { useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/tag";
import { Button, ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import {
  IconActivity,
  IconArrow,
  IconBookmark,
  IconCal,
  IconSearch,
  IconUsers,
  IconChart,
  IconHeart,
  IconSettings,
} from "@/components/ui/icons";
import { useTweaks } from "@/components/layout/tweaks-context";
import { openCommandPalette, preloadCommandPalette } from "@/components/layout/command-palette-launcher";
import type { DashboardData } from "@/lib/dashboard";
import { dismissReminder, restoreReminder } from "@/lib/notifications";
import { effectivePinnedKpis, type KpiKey, type Preferences } from "@/lib/preferences-constants";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { NotificationsBell } from "@/components/dashboard/notifications-bell";
import { MiniCalendar } from "@/components/dashboard/mini-calendar";
import { SessionsChart } from "@/components/dashboard/sessions-chart";
import { RecentPatients } from "@/components/dashboard/recent-patients";
import { PinKpiButton } from "@/components/dashboard/pin-kpi-button";
import { RevenueCard } from "@/components/dashboard/revenue-card";
import { KPI_STAGGER_MS, dashboardKpis, type KpiIcon, type KpiView } from "@/components/dashboard/kpi-view";
import styles from "@/components/dashboard/dashboard.module.css";
import { ProfileMenu, SettingsModalLazy, preloadSettingsModal } from "@/components/global/profile-menu";

/**
 * PF1.1-dashboard (C-PF1/C-PF2/C-PF5): sin framer en el primer render (las entradas de KPIs, barras e ingresos son CSS
 * de `dashboard.module.css`), «Ajustes», el «+ Agregar» y el menú «⋯» de recientes se bajan al abrirlos, y el layout
 * es un CSS Module con una columna bajo 768 (D1) y container queries para 1024×768 con el sidebar abierto.
 *
 * Gráfico y calendario quedan ESTÁTICOS (no `next/dynamic`): el calendario está arriba del pliegue a 1366×768 (primero
 * del aside) y el gráfico asoma en el borde; con `ssr: false` dejarían un hueco en el primer pintado (C-PF2 lo prohíbe)
 * y ninguno trae dependencias pesadas (sin framer desde esta sesión).
 *
 * El contador animado de los KPIs (`useCountUp`, 600 ms desde 0) se fue: el SSR pintaba «0» y el número real recién
 * llegaba con JS (C-PF1.2: lo visible en el primer render no depende de JS; con reduce motion igual arrancaba en 0
 * hasta hidratar).
 */
const KPI_ICONS: Record<KpiIcon, typeof IconUsers> = {
  users: IconUsers,
  cal: IconCal,
  activity: IconActivity,
  chart: IconChart,
  heart: IconHeart,
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
  const { t } = useTweaks();
  const useSidebar = t.dashChrome === "sidebar";
  // EV1-A: el dashboard se arma por módulos (`useTenantModules`, lo publica el
  // AppShell). Sin `planes` (consultorio General) no hay recordatorio de altas
  // ni KPIs de planes; sin `sesiones`, lo que decía "sesiones" son "turnos" y
  // la tarjeta "Últimas sesiones registradas" (siempre vacía ahí) no se monta.
  // Fuera del provider el default es Kine PRO: lo de siempre.
  const modules = useTenantModules();
  const hasPlans = modules.has("planes");
  const hasSessions = modules.has("sesiones");
  const pinnedKpis = effectivePinnedKpis(data.pinnedKpis, data.revenueScope, modules);

  // PL-F1c: acá había un efecto que, al montar, pisaba la paleta de Tweaks con `preferences.palette`: elegías otra
  // en Tweaks (que solo iba a localStorage) y al pasar por Inicio volvía la anterior. Ahora la paleta del server la
  // siembra el layout `(app)` en `TweaksProvider` y Tweaks la guarda en el server: no hay nada que sincronizar acá.

  return (
    <div className={styles.root}>
      <div className={styles.main}>
        <DashHeader
          name={data.greetingName}
          todayCount={data.todayCount}
          kine={hasSessions}
          withSearch={useSidebar}
        />
        {hasPlans && (
          <ReminderSlot
            initiallyDismissed={data.reminderDismissed}
            nearingDischarge={data.pinned.nearingDischarge}
            reminderKey={data.reminderKey}
          />
        )}
        <PinnedRow
          kpis={dashboardKpis({
            pinned: data.pinned,
            pinnedKpis,
            weeklyBars: data.weeklyBars,
            todayCount: data.todayCount,
            monthRevenue: data.monthRevenue,
            revenueScope: data.revenueScope,
            hasPlans,
            hasSessions,
          })}
          pinnedKpis={pinnedKpis}
          revenueScope={data.revenueScope}
        />
        <BottomRow bars={data.weeklyBars} recent={hasSessions ? data.recent : null} />
      </div>

      <aside className={styles.aside} aria-label="Resumen del día">
        {useSidebar ? (
          <div className={`${styles.accountRow} ${styles.oAccount}`}>
            <NotificationsBell />
            <ProfileMenu name={data.greetingName || USER_NO_NAME} preferences={preferences} revenueScope={data.revenueScope} ownPublicBooking={data.ownPublicBooking} />
          </div>
        ) : (
          // PL-F (handoff 8): con la barra superior el `ProfileMenu` no se monta (lo reemplaza el menú de cuenta del
          // topbar), y «Ajustes» (paleta y KPIs fijadas) quedaba sin entrada. Este botón abre el mismo modal.
          <div className={`${styles.accountRow} ${styles.oAccount}`}>
            <DashSettingsButton preferences={preferences} revenueScope={data.revenueScope} />
          </div>
        )}
        <MiniCalendar initialBookingDays={initialBookingDays} className={styles.oCalendar} />
        <NextAppts items={data.next} />
        {/* SR-D5I: `revenue` null = el rol no ve ingresos (Secretaria): sin widget. */}
        {data.revenue && data.revenueScope !== "none" && (
          <RevenueCard
            initial={data.revenue}
            month={data.monthRevenue ?? undefined}
            scope={data.revenueScope}
            className={styles.oRevenue}
          />
        )}
      </aside>
    </div>
  );
}

function DashSettingsButton({
  preferences,
  revenueScope,
}: {
  preferences: Preferences;
  revenueScope: DashboardData["revenueScope"];
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        type="button"
        aria-haspopup="dialog"
        onPointerEnter={preloadSettingsModal}
        onFocus={preloadSettingsModal}
        onClick={() => {
          setMounted(true);
          setOpen(true);
        }}
      >
        <IconSettings size={14} /> Ajustes
      </Button>
      {mounted && (
        <SettingsModalLazy
          open={open}
          preferences={preferences}
          revenueScope={revenueScope}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * Encabezado de Inicio con `PageHeader` (C-PF5.3): eyebrow con el saludo, h1 con los turnos de hoy y el buscador ⌘K
 * como acción (solo con sidebar: el topbar y la barra mobile tienen el suyo). Antes era un `<div>` a mano con un emoji
 * en el saludo y, con la barra superior, la página no tenía `<h1>`.
 *
 * `kine` = el consultorio tiene `sesiones` (Kinesiología). El "Lic." y las "sesiones" son de Kine; en General el
 * profesional no es necesariamente licenciado y lo que se agenda son turnos.
 */
function DashHeader({
  name,
  todayCount,
  kine,
  withSearch,
}: {
  name: string;
  todayCount: number;
  kine: boolean;
  withSearch: boolean;
}) {
  const unit = kine ? (todayCount === 1 ? "sesión" : "sesiones") : todayCount === 1 ? "turno" : "turnos";
  const verb = kine ? (todayCount === 1 ? "agendada" : "agendadas") : todayCount === 1 ? "agendado" : "agendados";
  return (
    <div className={styles.oHeader}>
      <PageHeader
        // DIR-0: sin nombre cargado el saludo va sin nombre (`greetingName` = ""), nunca con el email.
        eyebrow={name ? `Hola, ${kine ? "Lic. " : ""}${name}` : "Hola"}
        title={
          <>
            Hoy tenés{" "}
            <span className={styles.titleAccent}>
              {todayCount} {unit}
            </span>{" "}
            {verb}
          </>
        }
        actions={
          withSearch ? (
            <button
              type="button"
              onClick={openCommandPalette}
              onPointerEnter={preloadCommandPalette}
              onFocus={preloadCommandPalette}
              aria-label="Abrir búsqueda rápida"
              className={`k-glass ${styles.search}`}
            >
              <IconSearch size={15} /> {kine ? "Buscar paciente, ejercicio…" : "Buscar paciente…"}
              <span className={styles.searchSpacer} />
              <span className={`k-mono ${styles.kbd}`}>⌘K</span>
            </button>
          ) : undefined
        }
      />
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

  return (
    <div className={styles.oHero}>
      {hidden ? (
        <RestoreReminderPill
          nearingDischarge={nearingDischarge}
          reminderKey={reminderKey}
          onRestore={() => setHidden(false)}
        />
      ) : (
        <HeroReminder
          nearingDischarge={nearingDischarge}
          reminderKey={reminderKey}
          onDismiss={() => setHidden(true)}
        />
      )}
    </div>
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
    <div className={styles.restorePill}>
      <span>
        Recordatorio oculto · {nearingDischarge}{" "}
        {nearingDischarge === 1 ? "paciente" : "pacientes"} cerca del alta
      </span>
      <Button variant="primary" type="button" onClick={restore} disabled={pending} style={{ padding: "6px 14px" }}>
        {pending ? "Restaurando…" : "Mostrar"}
      </Button>
    </div>
  );
}

/**
 * D3 de VX0-b: fuera el `PhotoSlot` «kine c/paciente» (un placeholder gris de 220×160 con ese texto, que en prod se
 * veía como una foto que no cargó). El hero queda con el texto y las acciones; sin el alto mínimo de 180 px.
 */
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
    <section className={styles.hero} aria-labelledby="dash-reminder-title">
      <div aria-hidden className={styles.heroGlow1} />
      <div aria-hidden className={styles.heroGlow2} />
      <div className={styles.heroBody}>
        <span className={`k-tag ${styles.heroTag}`}>Recordatorio</span>
        <h2 id="dash-reminder-title" className={`k-display ${styles.heroTitle}`}>
          {nearingDischarge} {nearingDischarge === 1 ? "paciente termina" : "pacientes terminan"} su plan esta semana
        </h2>
        <p className={styles.heroText}>Revisá su evolución y dejá programada el alta o la continuidad.</p>
        <div className={styles.heroActions}>
          <ButtonLink href="/pacientes?filter=active" variant="ghost" className={styles.heroPrimary}>
            Revisar pacientes <IconArrow size={14} />
          </ButtonLink>
          <button
            type="button"
            onClick={dismiss}
            disabled={pending}
            className={`k-btn ${styles.heroSecondary}`}
          >
            {pending ? "Ocultando…" : "Más tarde"}
          </button>
        </div>
      </div>
    </section>
  );
}

function PinnedRow({
  kpis,
  pinnedKpis,
  revenueScope,
}: {
  kpis: KpiView[];
  pinnedKpis: KpiKey[];
  revenueScope: DashboardData["revenueScope"];
}) {
  return (
    <section className={styles.oKpis} aria-labelledby="dash-kpis-title">
      <div className={styles.kpiHead}>
        <h2 id="dash-kpis-title" className={styles.kpiHeadLabel} style={{ margin: 0 }}>
          <IconBookmark size={14} /> Indicadores fijados
        </h2>
        <PinKpiButton currentPinned={pinnedKpis} revenueScope={revenueScope} />
      </div>
      <div className={styles.kpiGrid}>
        {kpis.length === 0 ? (
          <div className={styles.kpiEmpty}>No tenés indicadores fijados. Sumalos con «Agregar».</div>
        ) : (
          kpis.map((it, i) => <KpiCard key={it.key} it={it} index={i} />)
        )}
      </div>
    </section>
  );
}

function KpiCard({ it, index }: { it: KpiView; index: number }) {
  const I = KPI_ICONS[it.icon];
  return (
    <div className={`k-glass ${styles.kpi}`} style={{ animationDelay: `${index * KPI_STAGGER_MS}ms` }}>
      <div className={styles.kpiTop}>
        <span className={styles.kpiIcon} data-tone={it.tone}>
          <I size={16} />
        </span>
        <span className={styles.kpiDelta}>{it.delta}</span>
      </div>
      <div className={styles.kpiValue}>{it.n}</div>
      <div className={styles.kpiLabel}>{it.l}</div>
    </div>
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
    <div className={`${styles.bottom} ${recent ? "" : styles.bottomSingle} ${styles.oBottom}`}>
      <SessionsChart initialBars={initialBars} unit={recent ? "sessions" : "bookings"} />
      {recent && <RecentPatients items={recent} className={styles.oRecent} />}
    </div>
  );
}

function NextAppts({ items }: { items: DashboardData["next"] }) {
  return (
    <Card className={styles.oNext} style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div>
          <h2 className="k-display" style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
            Próximos turnos
          </h2>
          <div style={{ fontSize: 11, color: "var(--navy-500)" }}>Hoy</div>
        </div>
        <Tag tone="lime">{items.length} {items.length === 1 ? "turno" : "turnos"}</Tag>
      </div>
      {items.length === 0 && (
        <div style={{ fontSize: 12.5, color: "var(--navy-500)", padding: 8 }}>No te quedan turnos por hoy.</div>
      )}
      {items.map((a) => (
        <div key={a.id} className={styles.nextRow}>
          <div className={`k-mono ${styles.nextTime}`}>{a.time}</div>
          <Avatar name={a.name} size={30} tone="sky" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className={styles.ellipsis} title={a.name} style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy-900)" }}>
              {a.name}
            </div>
            <div className={styles.ellipsis} title={a.tag} style={{ fontSize: 11, color: "var(--navy-500)" }}>
              {a.tag}
            </div>
          </div>
        </div>
      ))}
      {/* Antes `<Link><Button/></Link>` (un botón dentro de un link: dos paradas de tab). Ratchet linkWrappingButton. */}
      <ButtonLink
        href="/agenda"
        variant="ghost"
        block
        style={{ fontSize: 12.5, padding: 10, marginTop: 4 }}
      >
        Ver agenda completa <IconArrow size={13} />
      </ButtonLink>
    </Card>
  );
}

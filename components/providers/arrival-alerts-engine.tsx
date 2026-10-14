"use client";

/**
 * Motor de los avisos de la sala de espera (SV11b; FX3 lo separó del provider).
 *
 * Por qué en un archivo aparte: `ArrivalAlerts` va en el first-load de TODAS las
 * rutas del workspace (`(app)/layout`), y el motor con `lib/arrival-alert-state`,
 * el chime y el título de la pestaña pesaba ~6,6 kB gz que se pagaban siempre,
 * aunque en prod el canal arranca apagado y los avisos por default no suenan. El
 * provider lo trae por `import()` dinámico SOLO cuando `alertsShouldRun` (canal ≠
 * off y alguna pref efectiva ≠ off). Ver el resto del «por qué» del motor (diff
 * del refetch, sonido tras resync, `/sala`, `noteLocalReception`) en
 * `components/providers/arrival-alerts.tsx`.
 */
import type { ReactNode } from "react";
import type { ToastOptions } from "@/components/ui/toast";
import { registerLocalReceptionListener } from "@/lib/arrival-local-notes";
import {
  arrivalsToAnnounce,
  callsToAnnounce,
  effectiveMode,
  effectivePrefs,
  formatArrival,
  formatCall,
  formatGroupDescription,
  formatGroupTitle,
  groupAnnouncements,
  patientInitials,
  todayRangeAR,
  batchIsRelevant,
  arrivalKey,
  callKey,
  type AlertPrefs,
  type AlertRow,
  type AlertViewer,
  type Announcement,
} from "@/lib/arrival-alert-state";
import { installChimeUnlock, playChime } from "@/lib/arrival-chime";
import { createDocumentTabTitle } from "@/lib/tab-title";
import { SOUND_BLOCKED_NOTE } from "@/components/providers/arrival-alerts-constants";
// Las server actions (`lib/bookings`, `lib/rooms`) entran por `import()` dentro
// de los fetchers: los render tests que cargan este módulo no tienen por qué
// mockear `lib/rooms` (su import estático arrastra `lib/authz` → `react.cache`).
import type { AgendaBookingRow } from "@/lib/bookings-types";
import type { RealtimeAgendaMessage } from "@/lib/realtime-events";

// ── Motor (sin React) ─────────────────────────────────────────────────

export type AlertNames = { rooms: Map<string, string>; practitioners: Map<string, string> };

export type ArrivalAlertsEngineDeps = {
  viewer: AlertViewer;
  /** Se lee en cada aviso: cambiar la pref no reinicia el motor. */
  getPrefs: () => AlertPrefs;
  /** Turnos de hoy (día AR). `null` = falló: se conserva lo anterior. */
  fetchToday: (range: { day: string; from: Date; to: Date }) => Promise<AlertRow[] | null>;
  /** Nombres de salas y profesionales para el «Pase …» (solo llamados). */
  fetchNames: () => Promise<AlertNames | null>;
  show: (title: string, opts: ToastOptions) => void;
  chime: () => boolean;
  announceTitle: (text: string) => void;
  openSala: () => void;
  /** true = no mostrar el toast de llamado (la pestaña está en `/sala`). Se lee en cada aviso. */
  suppressCallToast?: () => boolean;
  leading: (text: string) => ReactNode;
  now: () => Date;
};

export type ArrivalAlertsEngine = {
  /** Semilla: el primer fetch no avisa nada. */
  seed(): Promise<void>;
  onBatch(batch: ReadonlyArray<RealtimeAgendaMessage>): void;
  onResync(): void;
  /** La pestaña que hizo la acción ya sabe: no se auto-avisa. */
  noteLocal(bookingId: string, stamps: { arrivedAt?: string | Date | null; calledAt?: string | Date | null }): void;
  /** Para tests: espera a que termine el refetch en curso (y el pendiente). */
  idle(): Promise<void>;
  dispose(): void;
};

export function createArrivalAlertsEngine(deps: ArrivalAlertsEngineDeps): ArrivalAlertsEngine {
  const { viewer } = deps;
  let prev: AlertRow[] | null = null;
  let prevDay: string | null = null;
  const seen = new Set<string>();
  let running: Promise<void> | null = null;
  // Coalescido: mientras hay un refetch en vuelo, los lotes que llegan se
  // juntan en UNO más (no N). `viaResync` es pegajoso: si cualquiera de los
  // disparos fue un resync, el lote sale sin sonido (SV-D16, conservador).
  let pending: { viaResync: boolean } | null = null;
  let names: AlertNames | null = null;
  let disposed = false;

  const active = () => {
    const eff = effectivePrefs(viewer, deps.getPrefs());
    return eff.arrival !== "off" || eff.call !== "off";
  };

  const resolveNames = async (calls: Announcement[]): Promise<AlertNames | null> => {
    const missing = (n: AlertNames | null) =>
      !n || calls.some((c) => !n.practitioners.has(c.practitionerId) || (c.roomId && !n.rooms.has(c.roomId)));
    // Una sala o un profesional nuevo desde la última vez: se re-pide una vez.
    if (missing(names)) names = (await deps.fetchNames().catch(() => null)) ?? names;
    return names;
  };

  const announce = async (next: AlertRow[], viaResync: boolean) => {
    const eff = effectivePrefs(viewer, deps.getPrefs());
    const arrivals = eff.arrival === "off" ? [] : arrivalsToAnnounce(prev, next, viewer, seen);
    const calls = eff.call === "off" ? [] : callsToAnnounce(prev, next, viewer, seen);
    for (const a of [...arrivals, ...calls]) seen.add(a.key);
    if (arrivals.length + calls.length === 0) return;

    const modeOf = (t: "arrival" | "call") =>
      effectiveMode(t === "arrival" ? eff.arrival : eff.call, { viaResync });
    const wantsSound = (arrivals.length > 0 && modeOf("arrival") === "sound") || (calls.length > 0 && modeOf("call") === "sound");
    const n = calls.length > 0 ? await resolveNames(calls) : null;
    if (disposed) return;
    // Un solo chime por lote aunque haya varios toasts.
    const soundOk = wantsSound ? deps.chime() : true;

    const action = { label: "Ver sala", onClick: () => deps.openSala() };
    for (const g of groupAnnouncements([...arrivals, ...calls])) {
      const type = g.kind === "single" ? g.item.type : g.type;
      const note = modeOf(type) === "sound" && !soundOk ? SOUND_BLOCKED_NOTE : undefined;
      // M2: en `/sala` el llamado lo anuncia la banda; queda el título (y el
      // chime de arriba, que ya sonó si correspondía).
      const quiet = type === "call" && (deps.suppressCallToast?.() ?? false);
      if (g.kind === "single") {
        const a = g.item;
        const title =
          a.type === "arrival"
            ? formatArrival(a)
            : formatCall(a, {
                roomName: a.roomId ? n?.rooms.get(a.roomId) ?? null : null,
                practitionerName: n?.practitioners.get(a.practitionerId) ?? null,
              });
        if (!quiet) {
          deps.show(title, { id: a.key, leading: deps.leading(patientInitials(a.patientName)), action, description: note });
        }
        deps.announceTitle(title);
      } else {
        const title = formatGroupTitle(g.type, g.items.length);
        const description = [formatGroupDescription(g.items), note].filter(Boolean).join(" · ");
        if (!quiet) {
          deps.show(title, {
            id: `${g.type === "arrival" ? "arr" : "call"}:group:${g.items[0].key}`,
            leading: deps.leading(String(g.items.length)),
            action,
            description,
          });
        }
        deps.announceTitle(title);
      }
    }
  };

  const runOnce = async (viaResync: boolean) => {
    const range = todayRangeAR(deps.now());
    const rows = await deps.fetchToday(range).catch(() => null);
    if (disposed || !rows) return;
    // Primer fetch, o cambió el día AR: es semilla, no evento (a medianoche no
    // se anuncian «llegadas» de mañana).
    if (prev === null || prevDay !== range.day) {
      prev = rows;
      prevDay = range.day;
      return;
    }
    await announce(rows, viaResync);
    prev = rows;
  };

  const request = (viaResync: boolean) => {
    if (disposed || !active()) return;
    if (running) {
      pending = { viaResync: (pending?.viaResync ?? false) || viaResync };
      return;
    }
    running = (async () => {
      let v = viaResync;
      for (;;) {
        await runOnce(v);
        if (!pending || disposed) break;
        v = pending.viaResync;
        pending = null;
      }
      running = null;
    })();
  };

  return {
    async seed() {
      if (disposed || !active()) return;
      // El seed es un refetch más (si llega un lote durante el seed, se encola).
      request(false);
      await running;
    },
    onBatch(batch) {
      const eff = effectivePrefs(viewer, deps.getPrefs());
      if (!batchIsRelevant(batch, todayRangeAR(deps.now()).day, viewer, eff)) return;
      request(false);
    },
    onResync() {
      request(true);
    },
    noteLocal(bookingId, stamps) {
      if (stamps.arrivedAt) seen.add(arrivalKey(bookingId, stamps.arrivedAt));
      if (stamps.calledAt) seen.add(callKey(bookingId, stamps.calledAt));
    },
    async idle() {
      while (running) await running;
    },
    dispose() {
      disposed = true;
    },
  };
}

// ── Arranque desde el provider ────────────────────────────────────────

function PatientBadge({ text }: { text: string }) {
  return (
    <span
      aria-hidden
      style={{
        width: 28,
        height: 28,
        borderRadius: 999,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--rc-insala-bg)",
        color: "var(--rc-insala-fg)",
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: "0.02em",
      }}
    >
      {text}
    </span>
  );
}

const toAlertRows = (rows: ReadonlyArray<AgendaBookingRow>): AlertRow[] =>
  rows.map((r) => ({
    id: r.id,
    practitionerId: r.practitionerId,
    patientName: r.patientName,
    scheduledFor: r.scheduledFor,
    status: r.status,
    roomId: r.roomId,
    arrivedAt: r.arrivedAt,
    calledAt: r.calledAt,
    attendingAt: r.attendingAt,
  }));

export type StartArrivalAlertsOptions = {
  viewer: AlertViewer;
  getPrefs: () => AlertPrefs;
  subscribe: (fn: (batch: RealtimeAgendaMessage[]) => void) => () => void;
  onResync: (fn: () => void) => () => void;
  show: (title: string, opts: ToastOptions) => void;
  openSala: () => void;
  suppressCallToast: () => boolean;
};

/**
 * Lo que antes era el cuerpo del effect del provider: crea el motor con los
 * fetchers reales, el chime y el título, lo siembra y lo cablea al canal.
 * Devuelve el dispose (idempotente por cómo se usa: una vez por arranque).
 */
export function startArrivalAlerts(o: StartArrivalAlertsOptions): () => void {
  const { practitionerId, canOperateAll } = o.viewer;
  installChimeUnlock();
  const tab = createDocumentTabTitle();
  const engine = createArrivalAlertsEngine({
    viewer: { practitionerId, canOperateAll },
    getPrefs: o.getPrefs,
    fetchToday: async ({ from, to }) => {
      // Sin `operateAll` solo interesan los turnos propios: menos filas.
      const { listAgendaBookings } = await import("@/lib/bookings");
      const rows = await listAgendaBookings({
        from,
        to,
        includeCancelled: false,
        ...(canOperateAll || !practitionerId ? {} : { practitionerIds: [practitionerId] }),
      });
      return toAlertRows(rows);
    },
    fetchNames: async () => {
      const [{ listPractitioners }, { listRoomOptions }] = await Promise.all([
        import("@/lib/bookings"),
        import("@/lib/rooms"),
      ]);
      const [pracs, rooms] = await Promise.all([listPractitioners(), listRoomOptions()]);
      return {
        practitioners: new Map(
          pracs.filter((p) => !!p.user.fullName).map((p) => [p.id, p.user.fullName as string]),
        ),
        rooms: new Map(rooms.map((r) => [r.id, r.name])),
      };
    },
    show: o.show,
    chime: playChime,
    announceTitle: (t) => tab.announce(t),
    openSala: o.openSala,
    suppressCallToast: o.suppressCallToast,
    leading: (text) => <PatientBadge text={text} />,
    now: () => new Date(),
  });
  const offLocal = registerLocalReceptionListener((id, r) => engine.noteLocal(id, r));
  void engine.seed();
  const offBatch = o.subscribe((b) => engine.onBatch(b));
  const offResync = o.onResync(() => engine.onResync());
  return () => {
    offBatch();
    offResync();
    engine.dispose();
    offLocal();
    tab.dispose();
  };
}

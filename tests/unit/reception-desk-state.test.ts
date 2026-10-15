/**
 * [RX-0] C-RX3 · `lib/reception-desk-state.ts`: lógica pura del escritorio de Recepción de /sala (caras A «Lista y
 * panel» y B «Flujo»). Horas AR explícitas (`-03:00`) y `now` fijo: corre igual con `TZ=UTC` (`npm test`) y con
 * `TZ=America/Argentina/Buenos_Aires` (`npm run test:tz-ar`). Se testean los símbolos reales; no hay nada que mockear.
 */
import { describe, expect, it } from "vitest";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import { formatARS } from "@/lib/format";
import { dayKeyOf } from "@/lib/availability/day";
import { salaEntries, type SalaPractitioner } from "@/lib/sala-board-state";
import {
  DESK_DELAY_BAD_MIN,
  DESK_DELAY_OK_MAX,
  DESK_SOON_MIN,
  DESK_WAIT_FULL_MIN,
  attendingEntries,
  cashEntries,
  chronological,
  deskEntries,
  deskFilters,
  deskKpis,
  deskMenuItems,
  deskPrimary,
  deskShortcut,
  deskViewer,
  matchesDeskFilter,
  minutesUntil,
  nowLineIndex,
  owesCopago,
  pastScheduled,
  practitionerPulse,
  scrollAnchorIndex,
  soonEntries,
  waitFill,
  waitingEntries,
  type DeskEntry,
  type DeskFilter,
} from "@/lib/reception-desk-state";

const DAY = "2026-10-15";
const at = (h: string, day = DAY) => new Date(`${day}T${h}:00-03:00`).toISOString();
/** 10:42 AR = 13:42Z (brief RX §4.3). */
const NOW = new Date("2026-10-15T13:42:00Z");

function dto(id: string, h: string, over: Partial<BookingDTO> = {}): BookingDTO {
  return {
    id,
    scheduledFor: at(h),
    durationMin: 45,
    status: "CONFIRMED",
    serviceId: "s",
    serviceName: "Kinesiología",
    serviceColor: "#3d74b5",
    practitionerId: "p1",
    patientId: `pat-${id}`,
    patientName: `Paciente ${id}`,
    patientCondition: null,
    obraSocial: "Particular",
    copagoCents: 0,
    updatedAt: at("08:00"),
    notes: null,
    title: null,
    description: null,
    patientAccess: "full",
    isOverbooked: false,
    arrivedAt: null,
    attendingAt: null,
    calledAt: null,
    roomId: null,
    canOperate: true,
    ...over,
  };
}

const OWNER = deskViewer("p1", ["agenda.reception", "agenda.operateAll", "billing.manage"]);
const SECRETARIA = deskViewer(null, ["agenda.reception", "agenda.operateAll"]);
const KINE = deskViewer("p1", ["agenda.reception", "clinical.read"]);

/** Un turno de cada estado (a las 10:42 AR). */
const ROWS = {
  porLlegar: dto("porLlegar", "10:50"),
  demorado: dto("demorado", "10:20"),
  enSala: dto("enSala", "10:30", { arrivedAt: at("10:25") }),
  llamado: dto("llamado", "10:15", { arrivedAt: at("10:05"), calledAt: at("10:40") }),
  enAtencion: dto("enAtencion", "10:00", { arrivedAt: at("09:55"), attendingAt: at("10:02") }),
  atendido: dto("atendido", "09:00", { status: "COMPLETED", copagoCents: 600_000, paymentStatus: "UNPAID" }),
  ausente: dto("ausente", "09:30", { status: "NO_SHOW", copagoCents: 600_000 }),
  cancelado: dto("cancelado", "11:00", { status: "CANCELLED", copagoCents: 600_000 }),
};
const ALL = Object.values(ROWS);
const byId = (es: ReadonlyArray<{ row: BookingDTO }>) => es.map((e) => e.row.id);
const entryOf = (es: DeskEntry[], id: string) => es.find((e) => e.row.id === id)!;

describe("[RX-0] deskViewer", () => {
  it("canCollect = billing.manage; el resto es el viewer del Tablero", () => {
    expect(OWNER).toEqual({ practitionerId: "p1", canReception: true, canOperateAll: true, canCollect: true });
    expect(SECRETARIA.canCollect).toBe(false);
    expect(KINE).toEqual({ practitionerId: "p1", canReception: true, canOperateAll: false, canCollect: false });
  });

  it("acepta un iterable de un solo uso (Set.values())", () => {
    const v = deskViewer(null, new Set(["agenda.reception", "billing.manage"]).values());
    expect(v.canReception).toBe(true);
    expect(v.canCollect).toBe(true);
  });
});

describe("[RX-0] deskEntries y chronological", () => {
  it("incluye atendidos, ausentes y cancelados, con acciones por rol", () => {
    const es = deskEntries(ALL, NOW, SECRETARIA);
    expect(es).toHaveLength(ALL.length);
    expect(entryOf(es, "enSala").salaActions).toEqual(["llamar", "en-atencion", "atendido", "deshacer"]);
    expect(entryOf(es, "atendido").state).toBe("atendido");
  });

  it("un profesional no opera filas ajenas (salaActions del Tablero)", () => {
    const es = deskEntries([dto("x", "10:50", { practitionerId: "p2" })], NOW, KINE);
    expect(es[0].salaActions).toEqual([]);
  });

  it("orden cronológico (no el de sortForReception): hora, profesional, id", () => {
    const es = deskEntries(
      [dto("b", "10:00", { practitionerId: "p2" }), dto("a", "10:00", { practitionerId: "p1" }), ROWS.enAtencion, dto("c", "09:00")],
      NOW,
      OWNER
    );
    expect(byId(chronological(es))).toEqual(["c", "a", "enAtencion", "b"]);
  });
});

describe("[RX-0] filtros", () => {
  it("sin canCollect no existe «Por cobrar»; con, en el orden del prototipo", () => {
    expect(deskFilters(true).map((f) => f.id)).toEqual(["todos", "por-llegar", "en-sala", "demorados", "por-cobrar", "atendidos"]);
    expect(deskFilters(false).map((f) => f.id)).toEqual(["todos", "por-llegar", "en-sala", "demorados", "atendidos"]);
    expect(deskFilters(true).map((f) => f.label)).toEqual(["Todos", "Por llegar", "En sala", "Demorados", "Por cobrar", "Atendidos"]);
  });

  it.each<[DeskFilter, string[]]>([
    ["todos", ["porLlegar", "demorado", "enSala", "llamado", "enAtencion", "atendido", "ausente"]],
    ["por-llegar", ["porLlegar", "demorado"]],
    ["en-sala", ["enSala", "llamado"]],
    ["demorados", ["demorado"]],
    ["por-cobrar", ["atendido"]],
    ["atendidos", ["atendido", "ausente"]],
  ])("%s", (f, ids) => {
    const es = deskEntries(ALL, NOW, OWNER);
    expect(es.filter((e) => matchesDeskFilter(e, f)).map((e) => e.row.id).sort()).toEqual([...ids].sort());
  });
});

describe("[RX-0] owesCopago", () => {
  const e = (over: Partial<BookingDTO>, state: DeskEntry["state"] = "atendido") => ({
    state,
    row: dto("x", "09:00", { status: "COMPLETED", copagoCents: 600_000, ...over }),
  });
  it("atendido con copago y sin cobro → debe (UNPAID, FAILED o sin paymentStatus)", () => {
    expect(owesCopago(e({ paymentStatus: "UNPAID" }))).toBe(true);
    expect(owesCopago(e({ paymentStatus: "FAILED" }))).toBe(true);
    expect(owesCopago(e({ paymentStatus: undefined }))).toBe(true);
  });
  it("PAID, AUTHORIZED y REFUNDED no deben", () => {
    for (const p of ["PAID", "AUTHORIZED", "REFUNDED"] as const) expect(owesCopago(e({ paymentStatus: p })), p).toBe(false);
  });
  it("0 centavos no debe", () => {
    expect(owesCopago(e({ copagoCents: 0, paymentStatus: "UNPAID" }))).toBe(false);
  });
  it("no atendido no debe (todavía)", () => {
    for (const s of ["por-llegar", "en-sala", "en-atencion", "ausente", "cancelado"] as const) {
      expect(owesCopago(e({ paymentStatus: "UNPAID" }, s)), s).toBe(false);
    }
  });
});

describe("[RX-0] deskKpis", () => {
  it("llamados dentro de En sala; terminados = atendidos + ausentes; cancelados fuera del total", () => {
    expect(deskKpis(deskEntries(ALL, NOW, OWNER))).toEqual({ enSala: 2, enAtencion: 1, demorados: 1, terminados: 2, total: 7 });
  });
  it("vacío → ceros", () => {
    expect(deskKpis([])).toEqual({ enSala: 0, enAtencion: 0, demorados: 0, terminados: 0, total: 0 });
  });
});

describe("[RX-0] listas del panel y carriles", () => {
  it("sala de espera: llamados primero (por calledAt), después por llegada (no por hora del turno)", () => {
    const es = deskEntries(
      [
        dto("w-tarde", "10:00", { arrivedAt: at("10:30") }),
        dto("w-temprano", "10:40", { arrivedAt: at("10:10") }),
        dto("c2", "10:00", { arrivedAt: at("09:50"), calledAt: at("10:41") }),
        dto("c1", "10:30", { arrivedAt: at("10:20"), calledAt: at("10:35") }),
        ROWS.enAtencion,
        ROWS.porLlegar,
      ],
      NOW,
      OWNER
    );
    expect(byId(waitingEntries(es, NOW))).toEqual(["c1", "c2", "w-temprano", "w-tarde"]);
  });

  it(`próximos: demorados + por llegar en ≤ ${DESK_SOON_MIN}' (borde incluido), cronológico`, () => {
    const es = deskEntries(
      [
        dto("en30", "11:12"), // 30' justos
        dto("en31", "11:13"),
        dto("yaEmpezo", "10:35"), // 7' tarde: todavía «por llegar» (tolerancia 10')
        ROWS.demorado,
        ROWS.enSala,
      ],
      NOW,
      OWNER
    );
    expect(byId(soonEntries(es, NOW))).toEqual(["demorado", "yaEmpezo", "en30"]);
  });

  it("en atención: por attendingAt", () => {
    const es = deskEntries(
      [
        dto("a2", "09:30", { arrivedAt: at("09:30"), attendingAt: at("10:10") }),
        dto("a1", "10:00", { arrivedAt: at("09:50"), attendingAt: at("10:01") }),
        ROWS.enSala,
      ],
      NOW,
      OWNER
    );
    expect(byId(attendingEntries(es, NOW))).toEqual(["a1", "a2"]);
  });

  it("por cobrar: solo los que deben, cronológico, total en centavos", () => {
    const es = deskEntries(
      [
        ROWS.atendido,
        dto("t2", "08:00", { status: "COMPLETED", copagoCents: 450_050 }),
        dto("pagado", "08:30", { status: "COMPLETED", copagoCents: 600_000, paymentStatus: "PAID" }),
        ROWS.ausente,
        ROWS.cancelado,
      ],
      NOW,
      OWNER
    );
    const cash = cashEntries(es);
    expect(byId(cash.entries)).toEqual(["t2", "atendido"]);
    expect(cash.totalCents).toBe(1_050_050);
  });

  it("waitFill: 0..1, lleno a los 30'", () => {
    expect(DESK_WAIT_FULL_MIN).toBe(30);
    expect([waitFill(null), waitFill(-3), waitFill(0), waitFill(15), waitFill(30), waitFill(90)]).toEqual([0, 0, 0, 0.5, 1, 1]);
  });

  it("pastScheduled: en sala o llamado y ya pasó la hora", () => {
    const es = deskEntries(ALL, NOW, OWNER);
    expect(pastScheduled(entryOf(es, "enSala"), NOW)).toBe(true); // 10:30 < 10:42
    expect(pastScheduled(entryOf(es, "llamado"), NOW)).toBe(true);
    expect(pastScheduled(deskEntries([dto("t", "10:50", { arrivedAt: at("10:40") })], NOW, OWNER)[0], NOW)).toBe(false);
    expect(pastScheduled(entryOf(es, "demorado"), NOW)).toBe(false); // no está en la sala
  });

  it("minutesUntil: «en N'» redondeando hacia arriba; negativo si ya pasó", () => {
    expect(minutesUntil(ROWS.porLlegar, NOW)).toBe(8);
    expect(minutesUntil({ scheduledFor: "2026-10-15T13:42:30Z" }, NOW)).toBe(1);
    expect(minutesUntil(ROWS.demorado, NOW)).toBe(-22);
  });
});

describe("[RX-0] practitionerPulse", () => {
  const PROS: SalaPractitioner[] = [
    { id: "p1", name: "Lic. Ana Pérez", initials: "AP" },
    { id: "p2", name: "Lic. Bruno Díaz", initials: "BD" },
    { id: "p3", name: "Lic. Carla Ruiz", initials: "CR" },
  ];
  const ROOMS = { r1: { name: "Consultorio 1" }, r2: { name: "Consultorio 2" } };
  const pulse = (rows: BookingDTO[], pros: SalaPractitioner[] = PROS) => practitionerPulse(rows, pros, NOW, ROOMS);

  it("solo profesionales con turnos no cancelados, en el orden del catálogo; el desconocido al final", () => {
    const out = pulse([
      dto("a", "11:00", { practitionerId: "p3" }),
      dto("b", "11:00", { practitionerId: "p1" }),
      dto("c", "11:00", { practitionerId: "p2", status: "CANCELLED" }),
      dto("d", "11:00", { practitionerId: "baja" }),
    ]);
    expect(out.map((p) => p.id)).toEqual(["p1", "p3", "baja"]);
    expect(out[2]).toMatchObject({ name: "Profesional", initials: "?" });
  });

  it(`estado: libre, al día (≤ ${DESK_DELAY_OK_MAX}' justo), ámbar (≤ ${DESK_DELAY_BAD_MIN}' justo), rojo (> ${DESK_DELAY_BAD_MIN}')`, () => {
    // Nadie adentro ni llamado → libre, aunque alguien espere tarde en la sala.
    expect(pulse([dto("w", "10:00", { arrivedAt: at("10:00") })])[0]).toMatchObject({ status: "free", delayMin: 42 });
    // Empezó 5' tarde y no se pasó del fin → 5 → al día.
    const ok = pulse([dto("x", "10:00", { durationMin: 60, arrivedAt: at("09:55"), attendingAt: at("10:05") })])[0];
    expect(ok).toMatchObject({ status: "on-time", delayMin: 5 });
    // 6' tarde → ámbar.
    expect(pulse([dto("x", "10:00", { durationMin: 60, arrivedAt: at("09:55"), attendingAt: at("10:06") })])[0]).toMatchObject({
      status: "late",
      delayMin: 6,
    });
    // Llamado de un turno de las 10:27 → 15' justos → ámbar; de las 10:26 → 16' → rojo.
    expect(pulse([dto("x", "10:27", { arrivedAt: at("10:20"), calledAt: at("10:41") })])[0]).toMatchObject({
      status: "late",
      delayMin: 15,
    });
    expect(pulse([dto("x", "10:26", { arrivedAt: at("10:20"), calledAt: at("10:41") })])[0]).toMatchObject({
      status: "very-late",
      delayMin: 16,
    });
    // En atención que se pasó del fin: 09:30 + 45' = 10:15 → 27' → rojo.
    expect(pulse([dto("x", "09:30", { arrivedAt: at("09:25"), attendingAt: at("09:30") })])[0]).toMatchObject({
      status: "very-late",
      delayMin: 27,
    });
  });

  it("empezar antes de hora no da demora negativa", () => {
    expect(pulse([dto("x", "10:30", { durationMin: 60, arrivedAt: at("10:00"), attendingAt: at("10:20") })])[0]).toMatchObject({
      status: "on-time",
      delayMin: 0,
    });
  });

  it("segunda línea: Con (nombre corto y minutos) > Llamó a > Espera a (primer demorado) > sala del próximo > nada", () => {
    const withLine = pulse([
      dto("x", "10:00", { patientName: "Martín Sosa", arrivedAt: at("09:55"), attendingAt: at("10:24") }),
      dto("y", "10:30", { patientName: "Laura Paz", arrivedAt: at("10:20"), calledAt: at("10:41") }),
    ])[0];
    expect(withLine.line).toEqual({ kind: "with", patient: "Martín S.", minutes: 18 });

    expect(pulse([dto("y", "10:30", { patientName: "Laura Paz", arrivedAt: at("10:20"), calledAt: at("10:41") })])[0].line).toEqual({
      kind: "called",
      patient: "Laura P.",
    });

    expect(
      pulse([
        dto("d2", "10:25", { patientName: "Otro Demorado" }),
        dto("d1", "10:10", { patientName: "Facundo de la Mora" }),
        dto("n", "11:00", { roomId: "r1" }),
      ])[0].line
    ).toEqual({ kind: "waiting-for", patient: "Facundo M." });

    expect(
      pulse([
        dto("hecho", "09:00", { status: "COMPLETED", roomId: "r1" }),
        dto("n", "11:00", { roomId: "r2" }),
        dto("n2", "11:30", { roomId: "r1" }),
      ])[0].line
    ).toEqual({ kind: "room", room: "Consultorio 2" });

    // Sala archivada (no está en el catálogo) o sin sala → nada.
    expect(pulse([dto("n", "11:00", { roomId: "archivada" })])[0].line).toEqual({ kind: "idle" });
    expect(practitionerPulse([dto("n", "11:00", { roomId: "r1" })], PROS, NOW, null)[0].line).toEqual({ kind: "idle" });
  });

  it("progreso: atendidos + ausentes sobre no cancelados", () => {
    const p = pulse([ROWS.atendido, ROWS.ausente, ROWS.porLlegar, ROWS.cancelado])[0];
    expect([p.done, p.total]).toEqual([2, 3]);
  });
});

describe("[RX-0] botón primario y menú ⋯", () => {
  const es = deskEntries(ALL, NOW, OWNER);

  it("primaria por estado (la del Tablero) y Cobrar para un atendido que debe, solo con canCollect", () => {
    expect(deskPrimary(entryOf(es, "porLlegar"), OWNER)).toEqual({ kind: "action", action: "llego", label: "Llegó" });
    expect(deskPrimary(entryOf(es, "demorado"), OWNER)).toMatchObject({ action: "llego" });
    expect(deskPrimary(entryOf(es, "enSala"), OWNER)).toEqual({ kind: "action", action: "llamar", label: "Llamar" });
    expect(deskPrimary(entryOf(es, "llamado"), OWNER)).toMatchObject({ action: "en-atencion", label: "En atención" });
    expect(deskPrimary(entryOf(es, "enAtencion"), OWNER)).toMatchObject({ action: "atendido", label: "Atendido" });
    expect(deskPrimary(entryOf(es, "atendido"), OWNER)).toEqual({ kind: "collect", label: "Cobrar" });
    expect(deskPrimary(entryOf(deskEntries(ALL, NOW, SECRETARIA), "atendido"), SECRETARIA)).toBeNull();
    expect(deskPrimary(entryOf(es, "ausente"), OWNER)).toBeNull();
    expect(deskPrimary(entryOf(es, "cancelado"), OWNER)).toBeNull();
  });

  it("sin permiso sobre la fila no hay primaria (profesional en fila ajena)", () => {
    const e = deskEntries([dto("x", "10:50", { practitionerId: "p2" })], NOW, KINE)[0];
    expect(deskPrimary(e, KINE)).toBeNull();
  });

  it("menú: acciones sin la primaria + link a la agenda con el día y el profesional", () => {
    const items = deskMenuItems(entryOf(es, "enSala"), OWNER, DAY);
    expect(items).toEqual([
      { kind: "action", action: "en-atencion", label: "En atención" },
      { kind: "action", action: "atendido", label: "Atendido" },
      { kind: "action", action: "deshacer", label: "Deshacer" },
      { kind: "agenda", href: "/agenda?date=2026-10-15&view=timeline&pros=p1", label: "Ver turno en la agenda" },
    ]);
  });

  it("«Cobrar ahora ($ …)» solo con canCollect, con copago pendiente y si el turno no terminó", () => {
    const rows = [
      dto("debe", "10:50", { copagoCents: 600_000 }),
      dto("pagado", "10:50", { copagoCents: 600_000, paymentStatus: "PAID" }),
      dto("gratis", "10:50"),
    ];
    const own = deskEntries(rows, NOW, OWNER);
    const collect = deskMenuItems(entryOf(own, "debe"), OWNER, DAY).find((i) => i.kind === "collect");
    expect(collect).toEqual({ kind: "collect", label: `Cobrar ahora (${formatARS(600_000)})` });
    expect(collect?.label).toContain("6.000");
    expect(deskMenuItems(entryOf(own, "pagado"), OWNER, DAY).some((i) => i.kind === "collect")).toBe(false);
    expect(deskMenuItems(entryOf(own, "gratis"), OWNER, DAY).some((i) => i.kind === "collect")).toBe(false);
    // Atendido: Cobrar es la primaria, no va en el menú. Ausente: no se cobra.
    expect(deskMenuItems(entryOf(es, "atendido"), OWNER, DAY).some((i) => i.kind === "collect")).toBe(false);
    expect(deskMenuItems(entryOf(es, "ausente"), OWNER, DAY).some((i) => i.kind === "collect")).toBe(false);
    // La Secretaria no cobra (RX-D4).
    const sec = deskEntries(rows, NOW, SECRETARIA);
    expect(deskMenuItems(entryOf(sec, "debe"), SECRETARIA, DAY).some((i) => i.kind === "collect")).toBe(false);
  });

  it("acepta un SalaEntry del Tablero", () => {
    const [e] = salaEntries([ROWS.enSala], NOW, OWNER);
    expect(deskMenuItems(e, OWNER, DAY).map((i) => i.kind)).toEqual(["action", "action", "action", "agenda"]);
  });
});

describe("[RX-0] línea de «ahora» y auto-scroll", () => {
  const sorted = chronological(deskEntries([dto("a", "09:00"), dto("b", "10:00"), dto("c", "10:42"), dto("d", "11:00")], NOW, OWNER));
  it("primera fila que empieza ahora o después; −1 sin futuros; 0 si todo es futuro", () => {
    expect(nowLineIndex(sorted, NOW)).toBe(2);
    expect(nowLineIndex(sorted, new Date(`${DAY}T10:43:00-03:00`))).toBe(3);
    expect(nowLineIndex(sorted, new Date(`${DAY}T12:00:00-03:00`))).toBe(-1);
    expect(nowLineIndex(sorted, new Date(`${DAY}T07:00:00-03:00`))).toBe(0);
    expect(nowLineIndex([], NOW)).toBe(-1);
  });
  it("ancla: 3 turnos de contexto antes de la línea, con piso 0; −1 → −1", () => {
    expect(scrollAnchorIndex(10)).toBe(7);
    expect(scrollAnchorIndex(2)).toBe(0);
    expect(scrollAnchorIndex(5, 1)).toBe(4);
    expect(scrollAnchorIndex(-1)).toBe(-1);
  });
});

describe("[RX-0] atajos", () => {
  const free = { typing: false, modifier: false, overlayOpen: false };
  it("/ busca, N o n nuevo turno, Esc limpia solo escribiendo", () => {
    expect(deskShortcut("/", free)).toBe("search");
    expect(deskShortcut("n", free)).toBe("new-booking");
    expect(deskShortcut("N", free)).toBe("new-booking");
    expect(deskShortcut("Escape", free)).toBeNull();
    expect(deskShortcut("Escape", { ...free, typing: true })).toBe("clear");
    expect(deskShortcut("x", free)).toBeNull();
  });
  it("escribiendo, / y n son texto; con modificador u overlay abierto, nada", () => {
    expect(deskShortcut("/", { ...free, typing: true })).toBeNull();
    expect(deskShortcut("n", { ...free, typing: true })).toBeNull();
    for (const ctx of [{ ...free, modifier: true }, { ...free, overlayOpen: true }, { typing: true, modifier: false, overlayOpen: true }]) {
      for (const k of ["/", "n", "N", "Escape"]) expect(deskShortcut(k, ctx), `${k} ${JSON.stringify(ctx)}`).toBeNull();
    }
  });
});

describe("[RX-0] día AR: un turno a las 23:30 AR no se corre al día siguiente en UTC", () => {
  // 23:00 AR del 15 = 02:00Z del 16: con `toISOString().slice(0,10)` el día sería el 16.
  const LATE_NOW = new Date(`${DAY}T23:00:00-03:00`);
  const late = dto("noche", "23:30");
  it("es del día AR del reloj y se puede marcar «Llegó» (solo hoy)", () => {
    expect(LATE_NOW.toISOString().slice(0, 10)).toBe("2026-10-16");
    expect(dayKeyOf(LATE_NOW)).toBe(DAY);
    const [e] = deskEntries([late], LATE_NOW, SECRETARIA);
    expect(e.salaActions).toContain("llego");
    expect(deskPrimary(e, SECRETARIA)).toMatchObject({ action: "llego" });
    expect(byId(soonEntries([e], LATE_NOW))).toEqual(["noche"]); // 30' justos
    const agenda = deskMenuItems(e, SECRETARIA, dayKeyOf(LATE_NOW)).find((i) => i.kind === "agenda");
    expect(agenda).toMatchObject({ href: "/agenda?date=2026-10-15&view=timeline&pros=p1" });
  });
  it("un turno de mañana AR (00:10 del 16) no se marca hoy", () => {
    const [e] = deskEntries([dto("manana", "00:10", { scheduledFor: at("00:10", "2026-10-16") })], LATE_NOW, SECRETARIA);
    expect(e.salaActions).not.toContain("llego");
  });
});

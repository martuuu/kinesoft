/**
 * Lógica pura del turnero público (B5.6). Vive fuera del componente
 * (`components/booking/public-booking-wizard.tsx`, "use client") para poder
 * testearla sin DOM (tests/unit/public-wizard-state.test.ts).
 *
 * Fuente de verdad: `getPublicClinic` (B3.2). Los campos de B3.2 son
 * opcionales en el tipo (`practitionerIds`, `durationByPractitioner`,
 * `locationIds`, `acceptedInsurerIds`, `locations`, `insurers`): si faltan,
 * caemos al comportamiento previo (filtro por `practitionerId`, sin filtros
 * de sede/cobertura) en vez de esconder todo.
 */
import { addDays, dowOfDayKey, isDayKey } from "@/lib/availability/day";
import type {
  PublicClinic,
  PublicFirstSlot,
  PublicLocation,
  PublicSlot,
  PublicSlotWindow,
  PublicWindowDay,
} from "@/lib/public-booking-types";

type Practitioner = PublicClinic["practitioners"][number];
type Service = PublicClinic["services"][number];

/** Filtros opcionales del paso 1. null = sin filtro ("todas"). */
export type WizardFilters = {
  insurerId: string | null;
  locationId: string | null;
};

// ─── Servicios por profesional ─────────────────────────────────────────

/** Quiénes ofrecen el servicio online. Sin `practitionerIds` (payload viejo)
 *  devuelve null = "no sabemos" y el llamador usa el filtro legacy. */
function offeredBy(s: Service): string[] | null {
  return s.practitionerIds ?? null;
}

/** ¿El profesional ofrece este servicio online? */
export function serviceOfferedBy(s: Service, practitionerId: string): boolean {
  const ids = offeredBy(s);
  // Compat: antes de B3.2 el filtro era `practitionerId === elegido || null`.
  if (!ids) return s.practitionerId === practitionerId || s.practitionerId === null;
  return ids.includes(practitionerId);
}

/** Servicios que ofrece ese profesional. Reemplaza el filtro por
 *  `s.practitionerId`, que con 3+ profesionales mostraba a un tercero un
 *  servicio que no da (horarios vacíos y submit rechazado). */
export function servicesForPractitioner(clinic: PublicClinic, practitionerId: string): Service[] {
  return clinic.services.filter((s) => serviceOfferedBy(s, practitionerId));
}

/** Servicios para "cualquier profesional": los que ofrece al menos uno de
 *  los profesionales que pasan los filtros. */
export function servicesForAny(clinic: PublicClinic, filters: WizardFilters): Service[] {
  const pros = filterPractitioners(clinic, filters);
  return clinic.services.filter((s) => pros.some((p) => serviceOfferedBy(s, p.id)));
}

/** Duración efectiva: override del profesional (`PractitionerService`) o la
 *  del servicio. Sin profesional (modo "cualquiera") = la del servicio. */
export function durationFor(s: Service, practitionerId: string | null): number {
  if (practitionerId) {
    const d = s.durationByPractitioner?.[practitionerId];
    if (typeof d === "number" && d > 0) return d;
  }
  return s.durationMin;
}

// ─── Filtros de cobertura y sede ───────────────────────────────────────

/** Sin cobertura elegida, o sin dato (payload viejo) = acepta. */
export function practitionerAcceptsInsurer(p: Practitioner, insurerId: string | null): boolean {
  if (!insurerId || !p.acceptedInsurerIds) return true;
  return p.acceptedInsurerIds.includes(insurerId);
}

/** Sin sede elegida, o sin dato = atiende. */
export function practitionerAtLocation(p: Practitioner, locationId: string | null): boolean {
  if (!locationId || !p.locationIds) return true;
  return p.locationIds.includes(locationId);
}

export function filterPractitioners(clinic: PublicClinic, filters: WizardFilters): Practitioner[] {
  return clinic.practitioners.filter(
    (p) => practitionerAcceptsInsurer(p, filters.insurerId) && practitionerAtLocation(p, filters.locationId)
  );
}

/** Sedes activas (la principal primero, como las manda el server). */
export function clinicLocations(clinic: PublicClinic): PublicLocation[] {
  return clinic.locations ?? [];
}

/** Elegir sede solo tiene sentido con más de una. */
export function hasMultipleLocations(clinic: PublicClinic): boolean {
  return clinicLocations(clinic).length > 1;
}

/** Opciones de "¿Con qué cobertura venís?": Particular primero y después
 *  las obras sociales por nombre. Vacío si el consultorio solo atiende
 *  particular (no hay nada que filtrar). Nunca lleva montos. */
export function coverageOptions(clinic: PublicClinic): { id: string; name: string; isParticular: boolean }[] {
  const all = clinic.insurers ?? [];
  if (!all.some((i) => !i.isParticular)) return [];
  const particular = all.filter((i) => i.isParticular);
  const rest = all.filter((i) => !i.isParticular).sort((a, b) => a.name.localeCompare(b.name, "es"));
  return [...particular, ...rest];
}

/** Sedes donde atiende un profesional, en el orden del consultorio. */
export function locationsForPractitioner(clinic: PublicClinic, practitionerId: string): PublicLocation[] {
  const p = clinic.practitioners.find((x) => x.id === practitionerId);
  const locs = clinicLocations(clinic);
  if (!p?.locationIds) return locs;
  return locs.filter((l) => p.locationIds!.includes(l.id));
}

/** "Av. Siempre Viva 742, Piso 2 · Rosario" (lo que haya). */
export function formatLocationAddress(l: PublicLocation): string {
  const street = [l.address, l.addressLine2].filter(Boolean).join(", ");
  const place = [l.city, l.province].filter(Boolean).join(", ");
  return [street, place].filter(Boolean).join(" · ");
}

export function findLocation(clinic: PublicClinic, locationId: string | null | undefined): PublicLocation | null {
  if (!locationId) return null;
  return clinicLocations(clinic).find((l) => l.id === locationId) ?? null;
}

/**
 * Qué selección sobrevive a un cambio de filtros: si el profesional elegido
 * ya no pasa los filtros se limpia (y con él servicio y horario, que
 * dependen de él); si el servicio dejó de ofrecerse, se limpia el servicio.
 */
export function reconcileSelection(
  clinic: PublicClinic,
  filters: WizardFilters,
  sel: { practitionerId: string | null; serviceId: string | null }
): { practitionerId: string | null; serviceId: string | null } {
  let { practitionerId, serviceId } = sel;
  if (practitionerId && !filterPractitioners(clinic, filters).some((p) => p.id === practitionerId)) {
    practitionerId = null;
  }
  if (serviceId) {
    const pool = practitionerId
      ? servicesForPractitioner(clinic, practitionerId)
      : servicesForAny(clinic, filters);
    if (!pool.some((s) => s.id === serviceId)) serviceId = null;
  }
  return { practitionerId, serviceId };
}

// ─── Estado inicial y deep link (DIR-2d, C-DIR7) ──────────────────────

/** Pasos del wizard: 0 Profesional · 1 Servicio · 2 Fecha y hora · 3 Tus datos. */
export type WizardStep = 0 | 1 | 2 | 3;

/**
 * Con qué arranca el wizard. `pro` es el `?pro=` del deep link del directorio: input de un anónimo. Si es uno de
 * `clinic.practitioners` (= reservable hoy: switch prendido, membresía usable, ≥ 1 servicio PUBLIC) se entra al paso 1
 * con él elegido. Si no (apagado, de otro consultorio, basura) se ignora EN SILENCIO y queda el default de siempre
 * (un solo profesional = paso 1 con él; si no, paso 0): un aviso revelaría si el id existe.
 */
export function initialWizardSelection(
  clinic: PublicClinic,
  pro: string | null | undefined
): { step: WizardStep; practitionerId: string | null; mode: "pick" } {
  if (pro && clinic.practitioners.some((p) => p.id === pro)) return { step: 1, practitionerId: pro, mode: "pick" };
  if (clinic.practitioners.length === 1) return { step: 1, practitionerId: clinic.practitioners[0].id, mode: "pick" };
  return { step: 0, practitionerId: null, mode: "pick" };
}

// ─── Idempotencia por instancia (AUDIT §5, A2b-S-pub) ──────────────────

/** Firma de un intento: si cambia profesional, servicio u horario es OTRO
 *  turno y lleva key nueva (el server rechaza una key reusada con otros
 *  datos). Un doble click o reintento tras error de MP reusan la misma. */
export function attemptSignature(sel: {
  practitionerId: string;
  serviceId: string;
  slotISO: string;
}): string {
  return `${sel.practitionerId}|${sel.serviceId}|${sel.slotISO}`;
}

export type Attempt = { sig: string; key: string };

/** Devuelve el intento vigente para `sig`: el mismo si la firma no cambió,
 *  o uno nuevo con `mintKey()` si cambió. */
export function nextAttempt(prev: Attempt | null, sig: string, mintKey: () => string): Attempt {
  if (prev && prev.sig === sig) return prev;
  return { sig, key: mintKey() };
}

// ─── "Cualquier profesional" ───────────────────────────────────────────

/** Input de `findFirstPublicSlot` desde el estado del wizard (sin claves
 *  undefined: el schema las acepta, pero así el payload queda limpio). */
export function firstSlotQuery(args: {
  tenantSlug: string;
  serviceId: string;
  filters: WizardFilters;
  fromDate?: string;
}): { tenantSlug: string; serviceId: string; insurerId?: string; locationId?: string; fromDate?: string } {
  const q: { tenantSlug: string; serviceId: string; insurerId?: string; locationId?: string; fromDate?: string } = {
    tenantSlug: args.tenantSlug,
    serviceId: args.serviceId,
  };
  if (args.filters.insurerId) q.insurerId = args.filters.insurerId;
  if (args.filters.locationId) q.locationId = args.filters.locationId;
  if (args.fromDate) q.fromDate = args.fromDate;
  return q;
}

export type WizardSelection = {
  practitionerId: string;
  /** Día AR del horario. TP-1: el wizard posiciona ahí la ventana de 5 días (`windowNavAt`). */
  dateISO: string;
  slotISO: string;
  slotLocationId: string | null;
};

/** El primer turno libre se convierte en una selección concreta: a partir
 *  de acá se reserva igual que eligiendo profesional y horario a mano. */
export function selectionFromFirstSlot(first: PublicFirstSlot): WizardSelection {
  return {
    practitionerId: first.practitionerId,
    dateISO: first.date,
    slotISO: first.iso,
    slotLocationId: first.locationId ?? null,
  };
}

/**
 * Al pasar a "Tus datos": si eligió una obra social y el campo está vacío,
 * lo precargamos con su nombre (Particular no se precarga). Nunca pisa lo
 * que ya escribió el paciente o vino del prefill.
 */
export function coverageInsurerPrefill(
  current: string,
  clinic: PublicClinic,
  insurerId: string | null
): string {
  if (current.trim() || !insurerId) return current;
  const ins = (clinic.insurers ?? []).find((i) => i.id === insurerId);
  if (!ins || ins.isParticular) return current;
  return ins.name;
}

/** Día siguiente a una clave AR "YYYY-MM-DD" (aritmética de calendario del
 *  motor: no depende del huso del navegador). Tira si la clave es inválida. */
export function nextDayKey(dayKey: string): string {
  return addDays(dayKey, 1);
}

// ─── Cobro online o reserva sin cobro (TP-0) ───────────────────────────

/**
 * Piso del cobro online, el mismo de `decidePublicCheckout` (TP-0a, `MIN_ONLINE_CHARGE_CENTS = 100`): bajo $1 el server
 * no arma preferencia aunque el consultorio cobre online. Va repetido acá y no importado porque este módulo entra al
 * bundle del turnero (presupuesto ≤135 kB gz) y no tiene que arrastrar nada del lado server (hoy es puro, mañana puede
 * leer env); la paridad la fija el test `[TP-0] checkoutCopyFor · mismo piso que el server`.
 */
const MIN_ONLINE_CHARGE_CENTS = 100;

export type CheckoutCopy = {
  /** Si el submit va a terminar en Mercado Pago. */
  online: boolean;
  cta: string;
  ctaPending: string;
  totalLabel: string;
  /** Sin cobro y con precio 0 no hay fila de total: antes se leía «$ 0» como si el turno fuera gratis (H-TP2). */
  showTotal: boolean;
  note: string;
};

/**
 * Copy del cierre del wizard. Hasta TP-0 era siempre «Pagar y reservar» + «El pago se hace en Mercado Pago», pero hoy
 * el turnero no cobra (H-TP1: la única cuenta MP es la de la plataforma, `TURNERO_CHECKOUT` en `off`): el paciente
 * reserva y paga en el consultorio. `onlineCheckout` ausente (payload viejo) = sin cobro, que es lo que hace el server.
 */
export function checkoutCopyFor(args: { onlineCheckout?: boolean; priceCents: number }): CheckoutCopy {
  const online = args.onlineCheckout === true && args.priceCents >= MIN_ONLINE_CHARGE_CENTS;
  if (online) {
    return {
      online: true,
      cta: "Pagar y reservar",
      ctaPending: "Redirigiendo…",
      totalLabel: "Total a pagar",
      showTotal: true,
      note: "El pago se hace en Mercado Pago.",
    };
  }
  return {
    online: false,
    cta: "Confirmar turno",
    ctaPending: "Reservando…",
    totalLabel: "Valor del turno",
    showTotal: args.priceCents > 0,
    note: "Lo pagás en el consultorio.",
  };
}

/**
 * Adónde va el navegador después de `submitPublicBooking`. Manda `next` (la decisión es del server, que puede degradar
 * a reservado si la preferencia de MP falla): `reserved` → la pantalla de resultado, aunque viniera un `initPoint`;
 * `checkout` → Mercado Pago. Un `checkout` sin `initPoint` no debería pasar: cae a `/pending`, cuyo poller muestra el
 * estado real en vez de dejar al paciente con el botón trabado.
 */
export function destinationAfterSubmit(r: {
  bookingId: string;
  next: "checkout" | "reserved";
  initPoint: string | null;
}): string {
  const id = encodeURIComponent(r.bookingId);
  if (r.next === "reserved") return `/booking/${id}/ok`;
  return r.initPoint ?? `/booking/${id}/pending`;
}

// ─── Ventana de 5 días hábiles (TP-1) ──────────────────────────────────

/**
 * Navegación de la ventana del paso «Fecha y hora». `from` es lo que se le pide a `listPublicSlotWindow` (el server
 * arranca en el primer día hábil desde ahí); `history` es la pila de «‹ Anteriores»: la ventana no se puede calcular
 * hacia atrás sin otra búsqueda (los días hábiles dependen de franjas, excepciones y bloqueos), así que se vuelve a
 * arranques ya vistos.
 */
export type WindowNav = { from: string; history: string[] };

export function initialWindowNav(today: string): WindowNav {
  return { from: today, history: [] };
}

/** Deshabilitado en hoy: no hay turnos antes. */
export function canGoPrevWindow(nav: WindowNav, today: string): boolean {
  return nav.from > today;
}

/**
 * «Siguientes ›». Se apila el primer día MOSTRADO, no el `from` pedido: si el server salteó una semana completa
 * (`skippedFrom`), volver a pedir desde el `from` viejo la saltearía otra vez y «Anteriores» quedaría clavado.
 */
export function nextWindow(nav: WindowNav, window: PublicSlotWindow): WindowNav {
  if (!window.nextFrom) return nav;
  const shown = window.days[0]?.date ?? nav.from;
  return { from: window.nextFrom, history: [...nav.history, shown] };
}

/** «‹ Anteriores»: desapila; sin pila (llegó por fecha o por el primer turno), vuelve a hoy. */
export function prevWindow(nav: WindowNav, today: string): WindowNav {
  if (!canGoPrevWindow(nav, today)) return nav;
  if (nav.history.length === 0) return initialWindowNav(today);
  return { from: nav.history[nav.history.length - 1], history: nav.history.slice(0, -1) };
}

/**
 * Ventana posicionada en `date` (piso en hoy) con hoy en el fondo de la pila: «Anteriores» siempre lleva a algo
 * anterior. La usan «Ir a una fecha», el primer turno de «cualquier profesional» y «Ver más horarios de X».
 */
export function windowNavAt(date: string, today: string, earlier: string[] = []): WindowNav {
  if (date <= today) return initialWindowNav(today);
  const history = [today, ...earlier.filter((h) => h > today && h < date)];
  return { from: date, history: history.filter((h, i) => history.indexOf(h) === i) };
}

/** «Ir a una fecha». Basura (el input se puede tipear) = no se mueve; pasada = hoy. Conserva los arranques previos. */
export function jumpToDate(nav: WindowNav, date: string, today: string): WindowNav {
  if (!isDayKey(date)) return nav;
  return windowNavAt(date, today, nav.history);
}

/** El primer horario libre de la ventana (los días «Completo» no tienen slots). */
export function firstAvailable(window: PublicSlotWindow): { date: string; slot: PublicSlot } | null {
  for (const d of window.days) {
    const sl = d.slots.find((x) => x.available);
    if (sl) return { date: d.date, slot: sl };
  }
  return null;
}

/** El horario elegido sigue en la ventana recién cargada (con su sede) o se suelta. */
export function keepSelectionInWindow(window: PublicSlotWindow, slotISO: string | null): PublicSlot | null {
  if (!slotISO) return null;
  for (const d of window.days) {
    const sl = d.slots.find((x) => x.iso === slotISO && x.available);
    if (sl) return sl;
  }
  return null;
}

/**
 * Sin libres en 6 semanas la action devuelve la PRIMERA tanda toda «Completo» (`skippedFrom` null, `nextFrom`
 * normal), no una ventana vacía: si todos los días están completos y no hubo salto, no queda nada en el horizonte.
 * Una ventana vacía (payload defensivo) cuenta igual.
 */
export function windowHasNoFreeSlots(window: PublicSlotWindow): boolean {
  if (window.skippedFrom) return false;
  return window.days.every((d) => d.status === "full" || !d.slots.some((x) => x.available));
}

/**
 * «Buscar más adelante» con la ventana sin libres: 6 semanas (el horizonte de la búsqueda) después del `from`.
 * null pasado el tope de 90 días del server: más allá no hay nada que buscar.
 */
export function laterFrom(nav: WindowNav, window: PublicSlotWindow, today: string): string | null {
  // `nextFrom` de una tanda toda «Completo» cae DENTRO de las 6 semanas ya buscadas (sería repetir la búsqueda): se
  // salta al horizonte, salvo que el server ya indique algo más lejos.
  const horizon = addDays(nav.from, 42);
  const cand = window.nextFrom && window.nextFrom > horizon ? window.nextFrom : horizon;
  return cand <= addDays(today, 90) ? cand : null;
}

// Nombres a mano (no `Intl`): las claves ya son días de calendario AR y así el texto es idéntico en cualquier huso y
// en cualquier ICU (es-AR abrevia «lun.» con punto en unos runtimes y sin punto en otros).
const DOW_LONG = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const DOW_SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre",
  "diciembre",
];
const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function parts(dayKey: string) {
  return { dow: dowOfDayKey(dayKey), day: Number(dayKey.slice(8, 10)), month: Number(dayKey.slice(5, 7)) - 1 };
}
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** «jueves 22». */
export function dayLabel(dayKey: string): string {
  const p = parts(dayKey);
  return `${DOW_LONG[p.dow]} ${p.day}`;
}

/** «lun 19 al vie 23 de octubre»; con cambio de mes, los dos meses; un solo día, «lun 19 de octubre». */
export function windowRangeLabel(dates: string[]): string {
  if (dates.length === 0) return "";
  const a = parts(dates[0]);
  const b = parts(dates[dates.length - 1]);
  const head = `${DOW_SHORT[a.dow]} ${a.day}`;
  if (dates.length === 1) return `${head} de ${MONTHS[a.month]}`;
  const tail = `${DOW_SHORT[b.dow]} ${b.day} de ${MONTHS[b.month]}`;
  return a.month === b.month ? `${head} al ${tail}` : `${head} de ${MONTHS[a.month]} al ${tail}`;
}

/** h3 de cada día: «Lunes 19 de oct · 8 horarios» o «… · Completo». */
export function dayHeading(day: PublicWindowDay): string {
  const p = parts(day.date);
  const base = `${cap(DOW_LONG[p.dow])} ${p.day} de ${MONTHS_SHORT[p.month]}`;
  const n = day.slots.filter((x) => x.available).length;
  if (day.status === "full" || n === 0) return `${base} · Completo`;
  return `${base} · ${n} ${n === 1 ? "horario" : "horarios"}`;
}

/** Nombre accesible del botón: la hora sola («09:00») no dice de qué día es al recorrer con lector. */
export function slotAccessibleName(dayKey: string, time: string, locationName?: string | null): string {
  const p = parts(dayKey);
  const base = `${cap(DOW_LONG[p.dow])} ${p.day} de ${MONTHS[p.month]} a las ${time}`;
  return locationName ? `${base}, en ${locationName}` : base;
}

/**
 * Aviso arriba de la ventana. Salto del server (los 5 hábiles completos) gana; si no, «Ir a una fecha» a un día que
 * no es hábil. Navegar con los botones no avisa: ahí no se pidió un día puntual.
 */
export function windowNotice(args: { requestedFrom: string; jumped: boolean; window: PublicSlotWindow }): string | null {
  const first = args.window.days[0]?.date;
  if (!first) return null;
  // `skippedFrom` es el `from` PEDIDO (contrato de TP-1s), no el primer hábil salteado: el aviso nombra el día anterior
  // al primero mostrado («hasta el domingo 25»), que es lo que el paciente puede comprobar.
  if (args.window.skippedFrom) {
    return `No había turnos libres hasta el ${dayLabel(addDays(first, -1))}; te mostramos desde el ${dayLabel(first)}.`;
  }
  if (args.jumped && first > args.requestedFrom) {
    return `El ${dayLabel(args.requestedFrom)} no tiene horarios. Te mostramos los siguientes.`;
  }
  return null;
}

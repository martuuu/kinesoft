import { describe, it, expect } from "vitest";
import { expandPlanFields, serviceDisciplineMap, toBookingDTO } from "@/components/agenda/agenda-utils";
import type { AgendaBookingRow } from "@/lib/bookings-types";
import { decodeAgendaWire, encodeAgendaWire, type AgendaWireCatalog } from "@/lib/agenda-wire";

/**
 * [PF2-c] Cable de la semana de `/agenda` (C-PF8, ≤ 400 kB): ida y vuelta EXACTA. Lo que el cliente ve sale de
 * `decodeAgendaWire(encodeAgendaWire(dtos))`; tiene que ser el mismo DTO que `toBookingDTO` (mismo JSON, mismo orden
 * de claves), con todos los neutros y con valores que no son los de por defecto.
 */

const catalog: AgendaWireCatalog = {
  services: [
    { id: "svc_kine", name: "Kinesiología", color: "#3d74b5" },
    { id: "svc_libre", name: "Libre", color: null },
  ],
  locations: [
    { id: "loc_main", name: "Principal", isPrimary: true },
    { id: "loc_norte", name: "Norte", isPrimary: false },
  ],
};

function row(over: Partial<AgendaBookingRow> = {}): AgendaBookingRow {
  return {
    id: "ckbooking000000000000001",
    scheduledFor: new Date("2026-10-05T12:00:00.000Z"),
    durationMin: 45,
    status: "CONFIRMED",
    serviceId: "svc_kine",
    serviceName: "Kinesiología",
    serviceColor: "#3d74b5",
    practitionerId: "pr1",
    patientId: "pt1",
    patientName: "Juana Gómez",
    patientCondition: null,
    obraSocial: "OSDE",
    copagoCents: 150000,
    updatedAt: new Date("2026-10-05T11:00:00.000Z"),
    notes: null,
    title: null,
    description: null,
    patientAccess: "full",
    paymentStatus: "UNPAID",
    createdAt: new Date("2026-10-01T11:00:00.000Z"),
    publicReservation: false,
    isOverbooked: false,
    locationId: null,
    locationName: "Principal",
    isTelemedicine: false,
    telemedicineUrl: null,
    arrivedAt: null,
    calledAt: null,
    attendingAt: null,
    clinicalHidden: false,
    canOperate: true,
    clinicalWritable: true,
    roomId: null,
    programId: null,
    sessionId: null,
    pricedByPlan: false,
    plan: null,
    serviceDiscipline: "KINESIOLOGY",
    patientActiveLinkedPlanDisciplines: [],
    ...over,
  } as AgendaBookingRow;
}

const ROWS: Record<string, AgendaBookingRow> = {
  neutro: row(),
  todoDistinto: row({
    status: "COMPLETED",
    patientCondition: "Lumbalgia",
    notes: "trae estudios",
    title: "Control",
    description: "Dolor lumbar",
    patientAccess: "basic",
    paymentStatus: "PAID",
    publicReservation: true,
    isOverbooked: true,
    locationId: "loc_norte",
    locationName: "Norte",
    isTelemedicine: true,
    telemedicineUrl: "https://meet.example/abc",
    arrivedAt: new Date("2026-10-05T11:55:00.000Z"),
    attendingAt: new Date("2026-10-05T12:01:00.000Z"),
    calledAt: new Date("2026-10-05T12:00:30.000Z"),
    clinicalHidden: true,
    canOperate: false,
    clinicalWritable: false,
    roomId: "room_1",
    programId: "prog_1",
    sessionId: "ses_1",
    pricedByPlan: true,
    plan: { discipline: "KINESIOLOGY", ordinal: 3, totalLive: 10, title: "Plan rodilla" },
    patientActiveLinkedPlanDisciplines: ["KINESIOLOGY"],
  }),
  guest: row({ patientId: null, patientName: "Invitado", patientAccess: "none", obraSocial: "Particular" }),
  // Fuera del catálogo: el nombre/color del servicio y el nombre de la sede viajan explícitos (incluido null).
  servicioArchivado: row({ serviceId: "svc_viejo", serviceName: "Masaje (archivado)", serviceColor: null }),
  colorDistinto: row({ serviceColor: "#000000" }),
  sedeArchivada: row({ locationId: "loc_vieja", locationName: "Sur (archivada)" }),
  sinNombreDeSede: row({ locationId: "loc_vieja", locationName: null }),
  principalSinNombre: row({ locationName: null }),
  servicioLibre: row({ serviceId: "svc_libre", serviceName: "Libre", serviceColor: null }),
  // T3 (C-AS2): cobrado con medio.
  pagadoConMedio: row({ status: "COMPLETED", paymentStatus: "PAID", copagoPaymentMethod: "TRANSFER" }),
};

describe("[PF2-c] cable de la agenda", () => {
  for (const [name, r] of Object.entries(ROWS)) {
    it(`ida y vuelta exacta (${name})`, () => {
      const dto = toBookingDTO(r);
      const [w] = encodeAgendaWire([dto], catalog);
      const [back] = decodeAgendaWire([w], catalog);
      expect(JSON.stringify(back)).toBe(JSON.stringify(dto));
      // Y lo que ven las vistas (expandido) también.
      const disc = serviceDisciplineMap([{ id: "svc_kine", discipline: "KINESIOLOGY" }]);
      expect(expandPlanFields(back, disc)).toEqual(expandPlanFields(dto, disc));
    });
  }

  it("un turno neutro pesa menos de la mitad que el DTO", () => {
    const dto = toBookingDTO(ROWS.neutro);
    const [w] = encodeAgendaWire([dto], catalog);
    expect(JSON.stringify(w).length).toBeLessThan(JSON.stringify(dto).length / 2);
    // Neutros y catálogo afuera.
    expect(Object.keys(w)).not.toContain("sn");
    expect(Object.keys(w)).not.toContain("ln");
    expect(Object.keys(w)).not.toContain("ob");
  });

  it("[AS-1c] el medio del cobro viaja como `pm` y solo en las filas pagadas (default null)", () => {
    const paid = toBookingDTO(ROWS.pagadoConMedio);
    expect(paid.copagoPaymentMethod).toBe("TRANSFER");
    const [wPaid, wOpen] = encodeAgendaWire([paid, toBookingDTO(ROWS.neutro)], catalog);
    expect(wPaid.pm).toBe("TRANSFER");
    expect(Object.keys(wPaid)).not.toContain("copagoPaymentMethod");
    // Sin cobrar: la clave no viaja (la semana es casi toda sin cobrar) y al decodificar vuelve en null.
    expect(Object.keys(wOpen)).not.toContain("pm");
    const [, back] = decodeAgendaWire([wPaid, wOpen], catalog);
    expect(back.copagoPaymentMethod).toBeNull();
  });

  it("un campo nuevo del DTO viaja con su nombre completo (no se pierde)", () => {
    const dto = { ...toBookingDTO(ROWS.neutro), campoNuevo: 7 } as ReturnType<typeof toBookingDTO>;
    const [w] = encodeAgendaWire([dto], catalog);
    expect(w.campoNuevo).toBe(7);
    expect(decodeAgendaWire([w], catalog)[0]).toEqual(dto);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [AS-2o] T3e-2o (plan §23.9): `insurerKey` en el cable como `oi`, sin que el payload crezca: se DERIVA de lo que
// ya viaja (el nombre de la obra social contra el catálogo de obras sociales que la página manda igual, el acceso y
// `canOperate`) y solo viaja cuando la derivación no lo reproduce (índice en el catálogo, -1 = particular, null o el
// id explícito de una OS fuera del catálogo).
// ─────────────────────────────────────────────────────────────────────────────
import { agendaRowToDTO } from "@/lib/agenda-wire";

describe("[AS-2o] obra social en el cable (`oi`)", () => {
  const withInsurers: AgendaWireCatalog = {
    ...catalog,
    insurers: [
      { id: "ins_osde", name: "OSDE" },
      { id: "ins_swiss", name: "Swiss Medical" },
      { id: "ins_dup1", name: "Duplicada" },
      { id: "ins_dup2", name: "Duplicada" },
    ],
  };
  const OS: Record<string, AgendaBookingRow> = {
    osde: row({ obraSocial: "OSDE", insurerKey: "ins_osde" }),
    swiss: row({ obraSocial: "Swiss Medical", insurerKey: "ins_swiss" }),
    particular: row({ obraSocial: "Particular", insurerKey: "particular" }),
    guest: row({ patientId: null, patientName: "Invitado", patientAccess: "none", obraSocial: "Particular", insurerKey: "particular" }),
    // Acceso basic de un profesional sin `operateAll`: no ve la cobertura.
    sinAcceso: row({ patientAccess: "basic", canOperate: false, clinicalHidden: true, obraSocial: "Particular", insurerKey: null }),
    // Secretaria (nivel admin → viaja como basic, opera): ve la cobertura.
    secretariaParticular: row({ patientAccess: "basic", clinicalHidden: true, obraSocial: "Particular", insurerKey: "particular" }),
    secretariaOsde: row({ patientAccess: "basic", clinicalHidden: true, obraSocial: "OSDE", insurerKey: "ins_osde" }),
    // Texto libre sin vincular que coincide con un nombre del catálogo: es particular igual.
    textoLibre: row({ obraSocial: "OSDE", insurerKey: "particular" }),
    // Obra social inactiva (fuera del catálogo de la página): viaja su id.
    inactiva: row({ obraSocial: "IOMA (baja)", insurerKey: "ins_ioma" }),
    // Nombre repetido en el catálogo: no se puede derivar, viaja el índice.
    duplicada: row({ obraSocial: "Duplicada", insurerKey: "ins_dup2" }),
    // Basic sin operar pero con la clave sabida (caso raro): viaja explícito.
    basicConClave: row({ patientAccess: "basic", canOperate: false, obraSocial: "Particular", insurerKey: "particular" }),
  };

  for (const [name, r] of Object.entries(OS)) {
    it(`[AS-2o] ida y vuelta exacta con el catálogo de obras sociales (${name})`, () => {
      const dto = agendaRowToDTO(r);
      expect(dto.insurerKey).toBe(r.insurerKey);
      const [w] = encodeAgendaWire([dto], withInsurers);
      expect(Object.keys(w)).not.toContain("insurerKey");
      const [back] = decodeAgendaWire([w], withInsurers);
      expect(JSON.stringify(back)).toBe(JSON.stringify(dto));
    });
  }

  it("[AS-2o] los casos comunes no suman bytes; los raros, lo mínimo", () => {
    const enc = (r: AgendaBookingRow) => encodeAgendaWire([agendaRowToDTO(r)], withInsurers)[0];
    const plain = (r: AgendaBookingRow) => {
      const { insurerKey: _drop, ...rest } = r;
      return encodeAgendaWire([toBookingDTO(rest as AgendaBookingRow)], catalog)[0];
    };
    for (const k of ["osde", "swiss", "particular", "guest", "sinAcceso", "secretariaParticular", "secretariaOsde"]) {
      expect(JSON.stringify(enc(OS[k])), k).toBe(JSON.stringify(plain(OS[k])));
    }
    expect(enc(OS.textoLibre).oi).toBe(-1);
    expect(enc(OS.inactiva).oi).toBe("ins_ioma");
    expect(enc(OS.duplicada).oi).toBe(3);
    expect(enc(OS.basicConClave).oi).toBe(-1);
  });

  it("[AS-2o] sin el catálogo de obras sociales al decodificar: la clave queda AUSENTE (nunca se esconde), sin basura", () => {
    const wire = encodeAgendaWire(Object.values(OS).map(agendaRowToDTO), withInsurers);
    for (const back of decodeAgendaWire(wire, catalog)) {
      expect("insurerKey" in back).toBe(false);
      expect("oi" in back).toBe(false);
    }
  });

  it("[AS-2o] sin el catálogo al codificar: la clave viaja con su nombre completo (no se pierde)", () => {
    const dto = agendaRowToDTO(OS.osde);
    const [w] = encodeAgendaWire([dto], catalog);
    expect(w.insurerKey).toBe("ins_osde");
    expect(JSON.stringify(decodeAgendaWire([w], catalog)[0])).toBe(JSON.stringify(dto));
  });

  it("[AS-2o] agendaRowToDTO = toBookingDTO + insurerKey al final (ausente si la fila no la trae)", () => {
    const dto = agendaRowToDTO(OS.sinAcceso);
    expect(Object.keys(dto).at(-1)).toBe("insurerKey");
    expect(dto.insurerKey).toBeNull();
    const { insurerKey: _drop, ...rest } = OS.osde;
    expect(agendaRowToDTO(rest as AgendaBookingRow)).toEqual(toBookingDTO(rest as AgendaBookingRow));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [TP-2e] T5 (C-TP10, §25.8 «Agenda»): la plata online del turno viaja al final de `FIELDS` como `od` (seña, Σ PAID) y
// `po` (pagado entero online), AUSENTES cuando son neutras: un turno sin plata online da el mismo DTO y el mismo cable
// que antes de T5 (el fixture de volumen de `pf2-agenda-budget` no tiene cobros online → mismo payload).
// ─────────────────────────────────────────────────────────────────────────────
describe("[TP-2e] plata online en el cable (`od`/`po`)", () => {
  const withInsurers: AgendaWireCatalog = { ...catalog, insurers: [{ id: "ins_osde", name: "OSDE" }] };
  const MONEY: Record<string, AgendaBookingRow> = {
    sena: row({ onlineDepositCents: 6_000_00, paidOnline: false }),
    pagadoOnline: row({ status: "COMPLETED", paymentStatus: "PAID", copagoPaymentMethod: "MERCADO_PAGO", paidOnline: true }),
    senaYPagado: row({ onlineDepositCents: 2_000_00, paidOnline: true, paymentStatus: "PAID", copagoPaymentMethod: "MERCADO_PAGO" }),
    conObraSocial: row({ onlineDepositCents: 1_500_00, insurerKey: "ins_osde" }),
    todoDistinto: { ...ROWS.todoDistinto, onlineDepositCents: 1, paidOnline: true },
  };

  for (const [name, r] of Object.entries(MONEY)) {
    it(`[TP-2e] Wire \`od\`/\`po\` ida y vuelta; el fixture de \`pf2-agenda-budget\` no cambia. (${name})`, () => {
      const dto = agendaRowToDTO(r);
      // Con el catálogo de obras sociales el DTO tiene que traer `insurerKey` (si no, el decodificador la deriva:
      // contrato de AS-2o, no de T5): ese catálogo solo para las filas que la traen.
      for (const cat of r.insurerKey === undefined ? [catalog] : [catalog, withInsurers]) {
        const [w] = encodeAgendaWire([dto], cat);
        expect(Object.keys(w)).not.toContain("onlineDepositCents");
        expect(Object.keys(w)).not.toContain("paidOnline");
        const [back] = decodeAgendaWire([w], cat);
        // Mismo JSON y mismo orden de claves, con y sin catálogo de obras sociales (sin él, `insurerKey` viaja con su
        // nombre completo y vuelve igual: contrato de AS-2o).
        expect(JSON.stringify(back)).toBe(JSON.stringify(dto));
        expect((back as { onlineDepositCents?: number }).onlineDepositCents).toBe(r.onlineDepositCents && r.onlineDepositCents > 0 ? r.onlineDepositCents : undefined);
        expect((back as { paidOnline?: boolean }).paidOnline).toBe(r.paidOnline ? true : undefined);
      }
    });
  }

  it("[TP-2e] `od` y `po` van al final del turno, después de las claves de siempre, y solo en las filas afectadas", () => {
    const [w] = encodeAgendaWire([agendaRowToDTO(MONEY.senaYPagado)], catalog);
    expect(Object.keys(w).slice(-2)).toEqual(["od", "po"]);
    expect(w.od).toBe(2_000_00);
    expect(w.po).toBe(true);
    // Con `insurerKey` el orden del DTO es: … od, po, insurerKey (como lo rearma el decodificador).
    expect(Object.keys(agendaRowToDTO(MONEY.conObraSocial)).slice(-2)).toEqual(["onlineDepositCents", "insurerKey"]);
  });

  it("[TP-2e] sin plata online (0 / false / ausente) el DTO y el cable son los de antes de T5, byte a byte", () => {
    for (const r of [ROWS.neutro, row({ onlineDepositCents: 0, paidOnline: false }), ROWS.todoDistinto]) {
      const dto = agendaRowToDTO(r);
      expect("onlineDepositCents" in dto).toBe(false);
      expect("paidOnline" in dto).toBe(false);
      const { onlineDepositCents: _a, paidOnline: _b, ...before } = r;
      expect(JSON.stringify(encodeAgendaWire([dto], catalog))).toBe(
        JSON.stringify(encodeAgendaWire([toBookingDTO(before as AgendaBookingRow)], catalog))
      );
    }
  });

  it("[TP-2e] una seña inválida (negativa o no entera) no viaja: no es una seña", () => {
    for (const bad of [-100, 1.5, Number.NaN]) {
      const dto = agendaRowToDTO(row({ onlineDepositCents: bad }));
      expect("onlineDepositCents" in dto).toBe(false);
    }
  });
});

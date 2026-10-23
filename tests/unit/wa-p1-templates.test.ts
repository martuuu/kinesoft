/**
 * [WA-P1] C-WA2 · plantillas de WhatsApp (`lib/whatsapp/templates.ts`) y copy (`lib/whatsapp/copy.ts`).
 *
 * Lo central es WA-D16/WA-D20: `buildTemplateParams` es la ÚNICA entrada de parámetros y solo saca nombre, consultorio,
 * fecha/hora AR y conteo. Aunque el caller le pase el turno entero (servicio, notas, título/diagnóstico, profesional),
 * nada de eso puede llegar a Meta. Correr con TZ=UTC y TZ=AR.
 */
import { describe, expect, it } from "vitest";
import { WA_TEMPLATE_KEYS, WA_CHANNEL_BLOCK_REASONS, WA_ERROR_CLASSES, WA_SKIP_REASONS } from "@/lib/whatsapp/types";
import {
  TEMPLATE_FOOTER,
  TEMPLATE_SPECS,
  TEST_TEMPLATE,
  buildTemplateParams,
  formatWaDateAR,
  formatWaTimeAR,
  renderTemplatePreview,
} from "@/lib/whatsapp/templates";
import {
  WA_CHANNEL_BLOCK_LABEL,
  WA_ERROR_CLASS_LABEL,
  WA_MESSAGE_STATUS_LABEL,
  WA_SKIP_REASON_LABEL,
  WA_REPLY_BADGE,
} from "@/lib/whatsapp/copy";
import { WA_MESSAGE_STATUSES } from "@/lib/whatsapp/types";

// Viernes 23-oct-2026 09:30 AR = 12:30 UTC. En UTC el host diría 12:30; en AR, 09:30.
const AT = new Date("2026-10-23T12:30:00.000Z");

describe("[WA-P1] TEMPLATE_SPECS", () => {
  it("[WA-P1] las 5 plantillas: nombres del contrato, es_AR, UTILITY y el pie de baja", () => {
    expect(Object.keys(TEMPLATE_SPECS).sort()).toEqual([...WA_TEMPLATE_KEYS].sort());
    expect(Object.fromEntries(WA_TEMPLATE_KEYS.map((k) => [k, TEMPLATE_SPECS[k].name]))).toEqual({
      BOOKING_CREATED: "cs_turno_agendado_v1",
      BOOKING_MOVED: "cs_turno_reprogramado_v1",
      BOOKINGS_UPDATED: "cs_turnos_actualizados_v1",
      BOOKING_REMINDER: "cs_recordatorio_turno_v1",
      DOCUMENT_SHARED: "cs_documento_v1",
    });
    expect(TEMPLATE_FOOTER).toBe("Respondé BAJA para no recibir más avisos.");
    for (const k of WA_TEMPLATE_KEYS) {
      const s = TEMPLATE_SPECS[k];
      expect(s.language).toBe("es_AR");
      expect(s.category).toBe("UTILITY");
      expect(s.footer).toBe(TEMPLATE_FOOTER);
      // CHECK de M15 sobre WhatsAppTemplate.name.
      expect(s.name).toMatch(/^[a-z0-9_]{1,100}$/);
      // Meta: el cuerpo no puede empezar ni terminar con una variable, y las variables van {{1}}..{{n}} seguidas.
      expect(s.body).not.toMatch(/^\{\{|\}\}$/);
      const vars = [...s.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      expect(vars).toEqual(s.params.map((_, i) => i + 1));
      expect(s.example).toHaveLength(s.params.length);
    }
  });

  it("[WA-P1] el recordatorio lleva los botones «Confirmo» / «No puedo ir»; el documento, header DOCUMENT", () => {
    expect(TEMPLATE_SPECS.BOOKING_REMINDER.buttons).toEqual(["Confirmo", "No puedo ir"]);
    expect(TEMPLATE_SPECS.DOCUMENT_SHARED.header).toBe("DOCUMENT");
    for (const k of WA_TEMPLATE_KEYS.filter((k) => k !== "BOOKING_REMINDER")) expect(TEMPLATE_SPECS[k].buttons).toEqual([]);
    for (const k of WA_TEMPLATE_KEYS.filter((k) => k !== "DOCUMENT_SHARED")) expect(TEMPLATE_SPECS[k].header).toBeNull();
  });

  it("[WA-P1] la prueba usa hello_world", () => {
    expect(TEST_TEMPLATE).toEqual({ name: "hello_world", language: "en_US" });
  });
});

describe("[WA-P1] buildTemplateParams", () => {
  it("[WA-P1] fecha y hora en AR, no en la del host", () => {
    expect(formatWaDateAR(AT)).toBe("viernes 23/10");
    expect(formatWaTimeAR(AT)).toBe("09:30");
    const p = buildTemplateParams("BOOKING_CREATED", { firstName: "Martina", clinicName: "Kine Sur", scheduledFor: AT });
    expect(p).toEqual({
      key: "BOOKING_CREATED",
      name: "cs_turno_agendado_v1",
      language: "es_AR",
      bodyParams: ["Martina", "Kine Sur", "viernes 23/10", "09:30"],
      header: null,
      buttons: [],
    });
  });

  it("[WA-P1] PHI ausente aunque el turno tenga servicio, notas, título y profesional", () => {
    const booking = {
      firstName: "Martina",
      clinicName: "Kine Sur",
      scheduledFor: AT,
      count: 4,
      serviceName: "Rehabilitación de LCA",
      notes: "Dolor lumbar crónico, hernia L4-L5",
      title: "Post-quirúrgico rodilla",
      description: "Diagnóstico: esguince grado II",
      practitionerName: "Lic. Pérez",
      phone: "+5491123456789",
    };
    const forbidden = [
      "Rehabilitación",
      "LCA",
      "lumbar",
      "hernia",
      "Post-quirúrgico",
      "rodilla",
      "esguince",
      "Diagnóstico",
      "Pérez",
      "549112",
    ];
    for (const key of WA_TEMPLATE_KEYS) {
      const out = JSON.stringify(buildTemplateParams(key, booking as Parameters<typeof buildTemplateParams>[1]));
      const preview = renderTemplatePreview(key, booking as Parameters<typeof buildTemplateParams>[1]);
      for (const f of forbidden) {
        expect(out).not.toContain(f);
        expect(preview).not.toContain(f);
      }
    }
  });

  it("[WA-P1] serie → un mensaje con el conteo y el primer horario", () => {
    const p = buildTemplateParams("BOOKINGS_UPDATED", {
      firstName: "Martina",
      clinicName: "Kine Sur",
      scheduledFor: AT,
      count: 6,
    });
    expect(p.name).toBe("cs_turnos_actualizados_v1");
    expect(p.bodyParams).toEqual(["Martina", "Kine Sur", "6", "viernes 23/10", "09:30"]);
  });

  it("[WA-P1] parámetros saneados para Meta: sin saltos ni tabs, espacios colapsados, con tope y fallback", () => {
    const p = buildTemplateParams("DOCUMENT_SHARED", {
      firstName: "  Ana\n\tMaría   ",
      clinicName: "Kine    Sur\n",
    });
    expect(p.bodyParams).toEqual(["Ana María", "Kine Sur"]);
    expect(p.header).toBe("DOCUMENT");
    const empty = buildTemplateParams("DOCUMENT_SHARED", { firstName: "   ", clinicName: "x".repeat(200) });
    expect(empty.bodyParams[0]).toBe("paciente");
    expect(empty.bodyParams[1].length).toBeLessThanOrEqual(60);
  });

  it("[WA-P1] falta el horario (o el conteo) en una plantilla que lo pide → tira", () => {
    expect(() => buildTemplateParams("BOOKING_REMINDER", { firstName: "A", clinicName: "B" })).toThrow();
    expect(() =>
      buildTemplateParams("BOOKINGS_UPDATED", { firstName: "A", clinicName: "B", scheduledFor: AT })
    ).toThrow();
  });

  it("[WA-P1] la vista previa termina con el pie de baja", () => {
    const s = renderTemplatePreview("BOOKING_REMINDER", { firstName: "Martina", clinicName: "Kine Sur", scheduledFor: AT });
    expect(s).toContain("Martina");
    expect(s).toContain("09:30");
    expect(s.endsWith(TEMPLATE_FOOTER)).toBe(true);
  });
});

describe("[WA-P1] copy", () => {
  it("[WA-P1] una etiqueta por estado, motivo y clase de error", () => {
    for (const s of WA_MESSAGE_STATUSES) expect(WA_MESSAGE_STATUS_LABEL[s]).toBeTruthy();
    for (const r of WA_CHANNEL_BLOCK_REASONS) expect(WA_CHANNEL_BLOCK_LABEL[r]).toBeTruthy();
    for (const r of WA_SKIP_REASONS) expect(WA_SKIP_REASON_LABEL[r]).toBeTruthy();
    for (const c of WA_ERROR_CLASSES) expect(WA_ERROR_CLASS_LABEL[c]).toBeTruthy();
    expect(WA_REPLY_BADGE.confirmed.text).toBe("Confirmó");
    expect(WA_REPLY_BADGE.cancelRequested.text).toBe("Pidió cancelar");
  });
});

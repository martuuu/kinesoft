/**
 * PV-K (§27, ola Q1): contratos PUROS de tickets que consumen Q2-Q4. Sin DB.
 * La paridad contra el enum de Prisma y el CHECK de M19 existe porque `lib/support-ticket-sources.ts` NO puede importar
 * `@prisma/client` (va al bundle público de /contacto): si alguien suma un origen en el schema y se olvida de la lista,
 * esto falla acá y no con un 23514 en prod.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SupportTicketSource } from "@prisma/client";
import {
  LEAD_TICKET_SOURCES,
  SUPPORT_TICKET_SOURCES,
  TENANT_TICKET_SOURCES,
  TICKET_MOTIVO,
  TICKET_SOURCE_LABEL,
  isTicketSourceAllowed,
  motivoOfSource,
  ticketSourceFromMotivo,
  ticketSourceOf,
} from "@/lib/support-ticket-sources";
import {
  SUPPORT_SESSION_COPY,
  SUPPORT_TEAM_NAME,
  TICKET_NOTE_MAX,
  TICKET_STAGE_LABEL,
  ticketStageOf,
} from "@/lib/support-threads-types";
import {
  SESSION_TICKET_LIMIT,
  TICKET_ERROR_COPY,
  TICKET_PAGE_COPY,
  sessionTicketMailFallback,
  sessionTicketReceived,
  sessionTicketSub,
} from "@/lib/tickets-types";
import { BRAND_NAME } from "@/lib/brand";

const ROOT = join(__dirname, "..", "..");

describe("[TK-1] ticketStageOf", () => {
  it("[TK-1] Nuevo = OPEN sin tomar; En curso = OPEN tomado; Resuelto = CLOSED (tomado o no)", () => {
    const at = new Date("2026-10-27T12:00:00Z");
    expect(ticketStageOf({ status: "OPEN", platformTakenAt: null })).toBe("NEW");
    expect(ticketStageOf({ status: "OPEN", platformTakenAt: undefined })).toBe("NEW");
    expect(ticketStageOf({ status: "OPEN", platformTakenAt: at })).toBe("IN_PROGRESS");
    expect(ticketStageOf({ status: "OPEN", platformTakenAt: at.toISOString() })).toBe("IN_PROGRESS");
    expect(ticketStageOf({ status: "CLOSED", platformTakenAt: null })).toBe("CLOSED");
    expect(ticketStageOf({ status: "CLOSED", platformTakenAt: at })).toBe("CLOSED");
    expect(TICKET_STAGE_LABEL).toEqual({ NEW: "Nuevo", IN_PROGRESS: "En curso", CLOSED: "Resuelto" });
    expect(TICKET_NOTE_MAX).toBe(2000);
  });
});

describe("[TK-2] motivo ↔ source", () => {
  it("[TK-2] ida y vuelta para los 10 slugs; desconocido → LANDING", () => {
    const expected: Record<string, string> = {
      contacto: "LANDING",
      precio: "PRICING",
      "plan-libre": "PLAN_LIBRE",
      alta: "SIGNUP_ASSISTED",
      onboarding: "ONBOARDING",
      soporte: "TENANT_SUPPORT",
      plan: "PLAN_CHANGE",
      suspendido: "TENANT_SUSPENDED",
      cuenta: "ACCOUNT_DISABLED",
      privacidad: "PRIVACY",
    };
    expect(TICKET_MOTIVO).toEqual(expected);
    for (const [slug, source] of Object.entries(expected)) {
      expect(ticketSourceFromMotivo(slug)).toBe(source);
      expect(motivoOfSource(source as never)).toBe(slug);
    }
    for (const s of SUPPORT_TICKET_SOURCES) expect(ticketSourceFromMotivo(motivoOfSource(s))).toBe(s);
    for (const junk of [null, undefined, "", "nada", "PRICING", "__proto__", "constructor", "toString", 42, ["precio"]]) {
      expect(ticketSourceFromMotivo(junk)).toBe("LANDING");
    }
    // Tolera mayúsculas y espacios de un link armado a mano.
    expect(ticketSourceFromMotivo("  Precio ")).toBe("PRICING");
  });

  it("[TK-2] labels literales del brief", () => {
    expect(TICKET_SOURCE_LABEL).toEqual({
      LANDING: "Web · contacto",
      PRICING: "Web · precios",
      PLAN_LIBRE: "Plan Libre",
      SIGNUP_ASSISTED: "Alta asistida",
      ONBOARDING: "Alta en curso",
      TENANT_SUPPORT: "Soporte del consultorio",
      PLAN_CHANGE: "Elegir plan",
      TENANT_SUSPENDED: "Consultorio suspendido",
      ACCOUNT_DISABLED: "Cuenta desactivada",
      PRIVACY: "Privacidad",
    });
  });
});

describe("[TK-3] ticketSourceOf con NULL legado", () => {
  it("[TK-3] NULL → TENANT_SUPPORT / LANDING; con valor, el valor", () => {
    expect(ticketSourceOf("TENANT", null)).toBe("TENANT_SUPPORT");
    expect(ticketSourceOf("LEAD", null)).toBe("LANDING");
    expect(ticketSourceOf("TENANT", undefined)).toBe("TENANT_SUPPORT");
    expect(ticketSourceOf("LEAD", undefined)).toBe("LANDING");
    expect(ticketSourceOf("TENANT", "PLAN_CHANGE")).toBe("PLAN_CHANGE");
    expect(ticketSourceOf("LEAD", "PRICING")).toBe("PRICING");
    // Un valor que no es del catálogo (código más nuevo que este) cae al default del kind en vez de romper la UI.
    expect(ticketSourceOf("LEAD", "OTRO")).toBe("LANDING");
  });

  it("[TK-3] isTicketSourceAllowed refleja el CHECK por kind", () => {
    expect(isTicketSourceAllowed("TENANT", "PLAN_CHANGE")).toBe(true);
    expect(isTicketSourceAllowed("TENANT", "LANDING")).toBe(false);
    expect(isTicketSourceAllowed("LEAD", "LANDING")).toBe(true);
    expect(isTicketSourceAllowed("LEAD", "TENANT_SUPPORT")).toBe(false);
    expect(isTicketSourceAllowed("LEAD", "PRIVACY")).toBe(true);
    expect(isTicketSourceAllowed("TENANT", "PRIVACY")).toBe(true);
  });
});

describe("[TK] paridad con Prisma y con el CHECK de M19", () => {
  it("los 10 valores == enum SupportTicketSource de Prisma", () => {
    expect([...SUPPORT_TICKET_SOURCES].sort()).toEqual(Object.values(SupportTicketSource).sort());
    expect(SUPPORT_TICKET_SOURCES).toHaveLength(10);
  });

  it("TENANT/LEAD == listas del CHECK SupportThread_source_check", () => {
    const sql = readFileSync(join(ROOT, "prisma/migrations/20261027120000_support_tickets/migration.sql"), "utf8");
    const list = (kind: string) => {
      const m = sql.match(new RegExp(`"kind" = '${kind}'\\s+AND "source" IN \\(([^)]*)\\)`));
      expect(m, `CHECK de ${kind}`).not.toBeNull();
      return m![1].split(",").map((s) => s.trim().replace(/'/g, "")).sort();
    };
    expect([...TENANT_TICKET_SOURCES].sort()).toEqual(list("TENANT"));
    expect([...LEAD_TICKET_SOURCES].sort()).toEqual(list("LEAD"));
  });
});

describe("[TK] copy de tickets", () => {
  it("SUPPORT_TEAM_NAME sale de BRAND_NAME y la sesión de soporte apunta a Tickets", () => {
    expect(SUPPORT_TEAM_NAME).toBe(`Equipo de ${BRAND_NAME}`);
    expect(SUPPORT_SESSION_COPY).toContain("/plataforma → Tickets");
    expect(SUPPORT_SESSION_COPY).not.toContain("→ Mensajes");
  });

  it("títulos de /contacto, sub/éxito/segunda opción y tope", () => {
    expect(TICKET_PAGE_COPY.LANDING.title).toBe("Escribinos");
    expect(TICKET_PAGE_COPY.PRICING.title).toBe("Pedinos el precio");
    expect(TICKET_PAGE_COPY.PLAN_LIBRE.title).toBe("Armemos tu plan Libre");
    expect(TICKET_PAGE_COPY.SIGNUP_ASSISTED.title).toBe("Sumá tu consultorio");
    expect(TICKET_PAGE_COPY.TENANT_SUSPENDED.title).toBe("Escribinos por tu consultorio");
    expect(TICKET_PAGE_COPY.ACCOUNT_DISABLED.title).toBe("Escribinos por tu cuenta");
    expect(TICKET_PAGE_COPY.PRIVACY.title).toBe("Tus datos personales");
    expect(TICKET_PAGE_COPY.ONBOARDING.title).toBe("¿Necesitás ayuda con el alta?");
    for (const s of SUPPORT_TICKET_SOURCES) {
      expect(TICKET_PAGE_COPY[s].title.length).toBeGreaterThan(0);
      expect(TICKET_PAGE_COPY[s].sub.length).toBeGreaterThan(0);
    }
    expect(sessionTicketSub("ana@x.com")).toBe("Te respondemos a ana@x.com.");
    expect(sessionTicketReceived("ana@x.com")).toBe("Recibimos tu mensaje. Te respondemos a ana@x.com.");
    expect(sessionTicketMailFallback("soporte@x.com")).toBe("¿Preferís el mail? Escribinos a soporte@x.com.");
    expect(TICKET_ERROR_COPY.notAdmin.startsWith("Avisale al titular")).toBe(true);
    expect(TICKET_ERROR_COPY.usableTenant).toBe("Escribinos desde Configuración → Soporte.");
    expect(TICKET_ERROR_COPY.dailyCap.length).toBeGreaterThan(0);
    expect(TICKET_ERROR_COPY.noSession.length).toBeGreaterThan(0);
    expect(SESSION_TICKET_LIMIT).toEqual({ limit: 5, windowMs: 24 * 60 * 60_000 });
  });
});

describe("[TK] apto para bundle público", () => {
  it("lib/support-ticket-sources.ts, lib/legal.ts y lib/idle-logout.ts no tienen import", () => {
    for (const f of ["lib/support-ticket-sources.ts", "lib/legal.ts", "lib/idle-logout.ts"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(src, f).not.toMatch(/^\s*import\s/m);
      expect(src, f).not.toMatch(/\brequire\(/);
      expect(src, f).not.toMatch(/\bimport\(/);
    }
  });
});

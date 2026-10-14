/**
 * [IAM-0c] Fragmento Prisma de «profesional reservable» (C-IAM2). Lo
 * consumen en IAM-2e los 8 lugares que hoy listan cualquier Practitioner
 * (agenda, turnero, disponibilidad): la Secretaria tiene Practitioner por
 * `acceptInvite` y aparece como reservable (§19.1 punto 1, §19.2 decisión 2).
 */
import { describe, it, expect } from "vitest";
import { bookablePractitionerWhere } from "@/lib/practitioner-scope";

describe("[IAM-0c] bookablePractitionerWhere", () => {
  it("por defecto: tenant + membresía aceptada EN ESE tenant con rol clínico, sin filtro de disabledAt", () => {
    expect(bookablePractitionerWhere("t1")).toEqual({
      tenantId: "t1",
      user: {
        memberships: {
          some: {
            tenantId: "t1",
            acceptedAt: { not: null },
            role: { in: ["OWNER", "ADMIN", "PRACTITIONER"] },
          },
        },
      },
    });
  });

  it("no incluye Secretario/a ni Facturación", () => {
    const w = bookablePractitionerWhere("t1") as {
      user: { memberships: { some: { role: { in: string[] } } } };
    };
    expect(w.user.memberships.some.role.in).not.toContain("ASSISTANT");
    expect(w.user.memberships.some.role.in).not.toContain("BILLING");
  });

  it("disabledAt solo con includeDisabledFilter (la columna llega con M6)", () => {
    const off = bookablePractitionerWhere("t1", { includeDisabledFilter: false }) as {
      user: { memberships: { some: Record<string, unknown> } };
    };
    expect(off.user.memberships.some).not.toHaveProperty("disabledAt");

    const on = bookablePractitionerWhere("t1", { includeDisabledFilter: true }) as {
      user: { memberships: { some: Record<string, unknown> } };
    };
    expect(on.user.memberships.some.disabledAt).toBeNull();
    expect(on.user.memberships.some.tenantId).toBe("t1");
  });

  it("devuelve un objeto nuevo cada vez (el caller puede mezclarlo sin pisar a otro)", () => {
    const a = bookablePractitionerWhere("t1");
    const b = bookablePractitionerWhere("t1");
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("[IAM-0c] ACTIVE_TENANT_COOKIE", () => {
  it("nombre y opciones de la cookie del consultorio activo", async () => {
    const { ACTIVE_TENANT_COOKIE, ACTIVE_TENANT_COOKIE_OPTIONS } = await import("@/lib/active-tenant-cookie");
    expect(ACTIVE_TENANT_COOKIE).toBe("kine_tenant");
    expect(ACTIVE_TENANT_COOKIE_OPTIONS).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(ACTIVE_TENANT_COOKIE_OPTIONS.maxAge).toBeGreaterThan(0);
    // En test NODE_ENV no es production → secure false (como SUPABASE_COOKIE_OPTIONS).
    expect(ACTIVE_TENANT_COOKIE_OPTIONS.secure).toBe(process.env.NODE_ENV === "production");
  });
});

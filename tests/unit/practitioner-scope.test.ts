/**
 * [IAM-0c] Fragmento Prisma de «profesional reservable» (C-IAM2). Lo
 * consumen en IAM-2e los 8 lugares que hoy listan cualquier Practitioner
 * (agenda, turnero, disponibilidad): la Secretaria tiene Practitioner por
 * `acceptInvite` y aparece como reservable (§19.1 punto 1, §19.2 decisión 2).
 */
import { describe, it, expect } from "vitest";
import type { Prisma, Role } from "@prisma/client";
import { bookablePractitionerWhere, clinicalMembershipWhere } from "@/lib/practitioner-scope";
import { isClinicalMember } from "@/lib/roles";

/**
 * Evaluador mínimo del fragmento (solo las formas que usa `clinicalMembershipWhere`: `role` igual o `in`,
 * `clinical` igual y `OR`). Sirve para cruzar el espejo SQL con `isClinicalMember` sin base.
 */
function matches(w: Prisma.MembershipWhereInput, m: { role: Role; clinical: boolean }): boolean {
  if (typeof w.role === "string" && w.role !== m.role) return false;
  if (w.role && typeof w.role === "object" && "in" in w.role && !(w.role.in as Role[]).includes(m.role)) return false;
  if (typeof w.clinical === "boolean" && w.clinical !== m.clinical) return false;
  if (Array.isArray(w.OR) && !w.OR.some((o) => matches(o, m))) return false;
  return true;
}

describe("[PL-1b] clinicalMembershipWhere = espejo SQL de isClinicalMember", () => {
  const ROLES: Role[] = ["OWNER", "ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"];
  for (const role of ROLES) {
    for (const clinical of [true, false]) {
      it(`${role} clinical=${clinical} → ${isClinicalMember({ role, clinical })}`, () => {
        expect(matches(clinicalMembershipWhere("t1"), { role, clinical })).toBe(isClinicalMember({ role, clinical }));
      });
    }
  }

  it("membresía aceptada y del tenant pedido", () => {
    expect(clinicalMembershipWhere("t9")).toMatchObject({ tenantId: "t9", acceptedAt: { not: null } });
  });
});

describe("[IAM-0c] bookablePractitionerWhere", () => {
  it("por defecto: tenant + membresía aceptada EN ESE tenant de alguien que atiende, sin filtro de disabledAt", () => {
    expect(bookablePractitionerWhere("t1")).toEqual({
      tenantId: "t1",
      user: {
        memberships: {
          some: {
            tenantId: "t1",
            acceptedAt: { not: null },
            // PL-1b (C-PL5): el OWNER solo si atiende; PL-Z M1: el ADMIN nunca.
            OR: [{ role: "PRACTITIONER" }, { role: "OWNER", clinical: true }],
          },
        },
      },
    });
  });

  it("no incluye Secretario/a ni Facturación (ni con clinical = true)", () => {
    const w = bookablePractitionerWhere("t1") as { user: { memberships: { some: Prisma.MembershipWhereInput } } };
    for (const role of ["ASSISTANT", "BILLING"] as Role[]) {
      expect(matches(w.user.memberships.some, { role, clinical: true })).toBe(false);
    }
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

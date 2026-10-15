/**
 * IAM-2a · invitaciones del lado del server sin Supabase, mail por `sendEmail` (hallazgo del 14-oct, §19.1 puntos 3
 * y 4 + cuentas muertas).
 *
 * Antes: `sendInvitationEmail` llamaba a `supabase.auth.admin.inviteUserByEmail` (flujo implícito, link a la Site
 * URL = localhost, plantilla genérica, y CREABA el usuario de Auth antes de que el invitado hiciera nada), y
 * reenviar rotaba el token (el link del primer mail daba 404).
 *
 * Acá se fija:
 *  - invitar no toca Auth (fake de GoTrue inyectado: cero llamadas) y manda UN mail `staff_invite` con el link
 *    `${APP_URL}/invite/<token>`, remitente del consultorio y una fila en `EmailLog`;
 *  - el resultado dice la verdad (`emailSent`, `transport`) y la URL solo vuelve al OWNER;
 *  - «Reenviar» deja vivo el link anterior; «Generar link nuevo» anula todos los anteriores;
 *  - «Anular» deja la fila con `revokedAt`/`revokedById` y el link deja de valer;
 *  - la lista de pendientes trae estado, `lastSentAt`, `sendCount` y el último resultado de `EmailLog`.
 *
 * Actions REALES contra Postgres; se reemplaza solo el despacho del mail (`__setEmailTransportForTests`: la
 * validación, el sink a EmailLog y el log siguen corriendo) y el puerto de Auth (para contar llamadas).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";
import {
  createInvitation,
  resendInvitation,
  regenerateInvitationUrl,
  revokeInvitation,
  listPendingInvitations,
} from "@/lib/invitations";
import { findInvitationByRawToken } from "@/lib/invitations-internal";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __setAuthAdminForTests } from "@/lib/identity/auth-admin";
import { env } from "@/lib/env";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { GotrueFake } from "@/tests/helpers/gotrue-fake";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

/** Registro a mano (no `vi.fn`: vitest 2.1.9 rompe con un fn que tira a través de un mock). */
const mail = {
  sent: [] as SendEmailInput[],
  next: null as SendEmailResult | null,
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    const r = mail.next ?? { ok: true as const, transport: "resend" as const, providerId: `re_${mail.sent.length}` };
    mail.next = null;
    return r;
  },
};

const tokenOf = (url: string | null) => {
  const m = /\/invite\/([A-Za-z0-9_-]+)$/.exec(url ?? "");
  if (!m) throw new Error(`url sin token: ${url}`);
  return m[1];
};

/**
 * [BO-Z] C4: con el mail enviado, el resultado ya no trae la URL (es una credencial que ya está en la casilla del
 * invitado). Los tests sacan el link del mail que salió, que es lo que recibe la persona.
 */
const urlFromMail = (i: number) => {
  const m = /https?:\/\/\S+\/invite\/[A-Za-z0-9_-]+/.exec(mail.sent[i]?.text ?? "");
  if (!m) throw new Error(`mail #${i} sin link de invitación`);
  return m[0];
};

describe.skipIf(!RUN)("IAM-2a · invitaciones sin Supabase, mail propio", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let gotrue: GotrueFake;
  const email = () => `inv-${uniqueSuffix()}@test.local`;

  beforeAll(async () => {
    db = ownerClient();
    // BO2-B (BO-D7): PRO = 10 lugares. Estos casos invitan / ascienden / reactivan profesionales; el cupo se prueba en seats.test.ts.
    A = await createEphemeralTenant(db, { plan: "PRO", saasPlan: "CLINICA" });
    await db.tenant.update({ where: { id: A.tenantId }, data: { publicEmail: "turnos@consultorio.test" } });
  });
  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => {
    __rateLimitInternals.reset();
    mail.sent.length = 0;
    mail.next = null;
    gotrue = new GotrueFake();
    __setAuthAdminForTests(gotrue);
    __setEmailTransportForTests(mail.transport);
    asUser(A.userId);
  });
  afterEach(() => {
    __setAuthAdminForTests(null);
    __setEmailTransportForTests(null);
  });

  it("invitar no llama a Supabase: 1 mail staff_invite con el link propio y una fila en EmailLog", async () => {
    const to = email();
    const r = await createInvitation({ email: to, firstName: "Ana", lastName: "Pérez", role: "ASSISTANT" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ emailSent: true, transport: "resend", emailStatus: "sent" });
    // [BO-Z] C4: mail enviado → sin URL en el resultado.
    expect(r.data.url).toBeNull();
    const url = urlFromMail(0);
    expect(url).toMatch(new RegExp(`^${env.NEXT_PUBLIC_APP_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/invite/[A-Za-z0-9_-]+$`));

    expect(gotrue.calls).toHaveLength(0);
    expect(mail.sent).toHaveLength(1);
    const m = mail.sent[0];
    expect(m.kind).toBe("staff_invite");
    expect(m.to).toBe(to);
    expect(m.tenantId).toBe(A.tenantId);
    expect(m.entity).toBe("Invitation");
    expect(m.entityId).toBe(r.data.id);
    expect(m.replyTo).toBe("turnos@consultorio.test");
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId }, select: { name: true } });
    expect(m.fromName).toBe(tenant.name);
    expect(m.html).toContain(url);
    expect(m.text).toContain("Secretario/a");

    const row = await db.invitation.findUniqueOrThrow({ where: { id: r.data.id } });
    expect(row.token).toBe(hashInviteToken(tokenOf(url)));
    expect(row.sendCount).toBe(1);
    expect(row.lastSentAt).not.toBeNull();

    const logs = await db.emailLog.findMany({ where: { entity: "Invitation", entityId: r.data.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ tenantId: A.tenantId, kind: "staff_invite", status: "sent", transport: "resend" });
    expect(logs[0].linkHost).toBe(new URL(env.NEXT_PUBLIC_APP_URL).hostname);
  });

  it("el resultado dice la verdad cuando el mail no sale (y EmailLog lo registra)", async () => {
    mail.next = { ok: false, transport: "log", skipped: true, reason: "no_api_key" };
    const r = await createInvitation({ email: email(), firstName: "Bea", lastName: "Gómez" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ emailSent: false, transport: "log", emailStatus: "skipped", emailReason: "no_api_key" });
    expect(r.data.url).not.toBeNull();
    const log = await db.emailLog.findFirstOrThrow({ where: { entity: "Invitation", entityId: r.data.id } });
    expect(log).toMatchObject({ status: "skipped", reason: "no_api_key" });
  });

  it("Reenviar: token nuevo, el link anterior sigue valiendo, lastSentAt y sendCount+1, audita", async () => {
    const r1 = await createInvitation({ email: email(), firstName: "Caro", lastName: "Díaz" });
    if (!r1.ok) throw new Error(r1.error);
    const t1 = tokenOf(urlFromMail(0));
    const before = await db.invitation.findUniqueOrThrow({ where: { id: r1.data.id } });
    __rateLimitInternals.reset();

    const r2 = await resendInvitation(r1.data.id);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data.url).toBeNull();
    expect(mail.sent).toHaveLength(2);
    const t2 = tokenOf(urlFromMail(1));
    expect(t2).not.toBe(t1);

    const row = await db.invitation.findUniqueOrThrow({ where: { id: r1.data.id } });
    expect(row.token).toBe(hashInviteToken(t2));
    expect(row.priorTokens).toContain(hashInviteToken(t1));
    expect(row.sendCount).toBe(2);
    expect(row.lastSentAt!.getTime()).toBeGreaterThanOrEqual(before.lastSentAt!.getTime());

    expect((await findInvitationByRawToken(t1))?.id).toBe(r1.data.id);
    expect((await findInvitationByRawToken(t2))?.id).toBe(r1.data.id);
    expect(gotrue.calls).toHaveLength(0);
    expect(
      await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "invitation.resend", entityId: r1.data.id } })
    ).toBe(1);
  });

  it("Generar link nuevo anula los anteriores (vigente y reenviados) y audita", async () => {
    const r1 = await createInvitation({ email: email(), firstName: "Dani", lastName: "Ruiz" });
    if (!r1.ok) throw new Error(r1.error);
    __rateLimitInternals.reset();
    const r2 = await resendInvitation(r1.data.id);
    if (!r2.ok) throw new Error(r2.error);
    __rateLimitInternals.reset();

    const r3 = await regenerateInvitationUrl(r1.data.id);
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    const t3 = tokenOf(urlFromMail(2));

    expect(await findInvitationByRawToken(tokenOf(urlFromMail(0)))).toBeNull();
    expect(await findInvitationByRawToken(tokenOf(urlFromMail(1)))).toBeNull();
    expect((await findInvitationByRawToken(t3))?.status).toBe("pending");
    const row = await db.invitation.findUniqueOrThrow({ where: { id: r1.data.id } });
    expect(row.priorTokens).toEqual([]);
    expect(row.sendCount).toBe(3);
    expect(
      await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "invitation.regenerate", entityId: r1.data.id } })
    ).toBe(1);
  });

  it("Anular deja la fila con revokedAt/revokedById y el link deja de valer", async () => {
    const r1 = await createInvitation({ email: email(), firstName: "Eli", lastName: "Sosa" });
    if (!r1.ok) throw new Error(r1.error);
    const t1 = tokenOf(urlFromMail(0));

    const r = await revokeInvitation(r1.data.id);
    expect(r.ok).toBe(true);
    const row = await db.invitation.findUniqueOrThrow({ where: { id: r1.data.id } });
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedById).toBe(A.userId);
    expect((await findInvitationByRawToken(t1))?.status).toBe("revoked");

    // Ni Reenviar ni Generar link nuevo la resucitan.
    __rateLimitInternals.reset();
    expect((await resendInvitation(r1.data.id)).ok).toBe(false);
    expect((await regenerateInvitationUrl(r1.data.id)).ok).toBe(false);
    // Y no aparece entre las pendientes.
    expect((await listPendingInvitations()).map((i) => i.id)).not.toContain(r1.data.id);
    // Re-invitar el mismo email crea una invitación NUEVA (la anulada queda como historia).
    __rateLimitInternals.reset();
    const again = await createInvitation({ email: row.email, firstName: "Eli", lastName: "Sosa" });
    expect(again.ok && again.data.id).not.toBe(r1.data.id);
  });

  it("pendientes: estado, lastSentAt, sendCount y el último resultado de EmailLog", async () => {
    mail.next = { ok: false, transport: "resend", skipped: false, reason: "provider_error", status: 500 };
    const r1 = await createInvitation({ email: email(), firstName: "Fede", lastName: "Paz" });
    if (!r1.ok) throw new Error(r1.error);
    __rateLimitInternals.reset();
    await resendInvitation(r1.data.id); // este sale

    const row = (await listPendingInvitations()).find((i) => i.id === r1.data.id);
    expect(row).toBeDefined();
    expect(row).toMatchObject({ status: "pending", sendCount: 2, url: null });
    expect(row!.lastSentAt).toBeInstanceOf(Date);
    expect(row!.lastEmail).toMatchObject({ status: "sent", transport: "resend", reason: null });

    // Vencida: sigue en la lista (para reenviarla) con su estado.
    await db.invitation.update({ where: { id: r1.data.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await listPendingInvitations()).find((i) => i.id === r1.data.id)?.status).toBe("expired");
  });

  it("ADMIN gestiona el equipo pero no recibe la URL (solo el OWNER la ve)", async () => {
    const admin = await addPractitioner(db, A, "ADMIN");
    asUser(admin.userId);
    const r = await createInvitation({ email: email(), firstName: "Gabi", lastName: "Luna" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.url).toBeNull();
    expect(r.data.emailSent).toBe(true);
    __rateLimitInternals.reset();
    const re = await resendInvitation(r.data.id);
    expect(re.ok && re.data.url).toBeNull();
    __rateLimitInternals.reset();
    const rg = await regenerateInvitationUrl(r.data.id);
    expect(rg.ok && rg.data.url).toBeNull();
  });

  // BO2-B: los mails salen de los núcleos compartidos (`lib/team-internal.ts`), que es quien registra el sink de
  // EmailLog; las dos puertas (Configuración y Plataforma) siguen sin Supabase admin.
  it("guard estático: invitaciones (Configuración, Plataforma y núcleos) no usan Supabase admin ni inviteUserByEmail", () => {
    for (const f of ["lib/invitations.ts", "lib/team-internal.ts", "lib/platform-team.ts"]) {
      const src = readFileSync(resolve(process.cwd(), f), "utf8");
      expect(src, f).not.toMatch(/inviteUserByEmail\s*\(/);
      expect(src, f).not.toMatch(/from\s+["']@\/lib\/supabase\/admin["']/);
    }
    const core = readFileSync(resolve(process.cwd(), "lib/team-internal.ts"), "utf8");
    expect(core).toMatch(/import\s+["']@\/lib\/email\/log["']/);
  });
});

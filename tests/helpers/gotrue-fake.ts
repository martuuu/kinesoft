/**
 * Fake de GoTrue admin en memoria (IAM-0d, contrato C-IAM3): implementa
 * `AuthAdminPort` para que los flujos de identidad (invitaciones, activación,
 * reset, magic link del portal) corran enteros en unit sin Supabase.
 *
 * Uso: `const fake = new GotrueFake(); __setAuthAdminForTests(fake);` y en el
 * `afterEach`, `__setAuthAdminForTests(null)`.
 *
 * Registro a mano (`calls`, `users`, `links`, `failNext`), no `vi.fn`: con vitest
 * 2.1.9 un `vi.fn` que tira a través de un mock rompe el test (fetch-fake.ts).
 *
 * Comportamiento modelado sobre GoTrue (`adminGenerateLink` / `adminUserCreate`).
 * Cada SUPUESTO está marcado [S#] y `scripts/diagnose-auth.ts` lo verifica contra
 * Supabase real; si un supuesto cae, se corrige ACÁ y en el puerto, no en el test:
 *  [S1] createUser con un email ya registrado (sin distinguir mayúsculas) → email_exists.
 *  [S2] GoTrue guarda el email normalizado (minúsculas).
 *  [S3] recovery sobre un email sin cuenta → not_found, y no crea a nadie.
 *  [S4] magiclink sobre un email sin cuenta → GoTrue CREA la cuenta sin confirmar y
 *       emite un token de confirmación con verification_type "signup" (el d.ts de
 *       auth-js: «generateLink() handles the creation of the user for signup, invite
 *       and magiclink»). Se modela lo que obliga al caller a hacerse cargo de la
 *       cuenta creada (lo conservador): un caller que creyera «sin cuenta → error»
 *       dejaría usuarios fantasma sin enterarse.
 *  [S5] magiclink / recovery sobre una cuenta existente → su mismo type.
 *  [S6] signup: sin cuenta exige password (sin él → error de validación); sobre una
 *       cuenta SIN confirmar re-emite sin password; sobre una confirmada → email_exists.
 *  [S7] invite: sin cuenta la crea; sin confirmar re-emite; confirmada → email_exists.
 *  [S8] password de menos de 6 caracteres → weak_password (mínimo por defecto de
 *       Supabase; el proyecto puede exigir más).
 *  [S9] getUser / updateUserById / deleteUser de un id inexistente → not_found.
 *  [S10] ban_duration "none" desbanea; "<n>h|m|s" banea hasta now + n.
 *  [S11] updateUserById con emailConfirm:false NO des-confirma (GoTrue solo
 *        confirma con true).
 */
import { randomBytes, randomUUID } from "node:crypto";
import type {
  AuthAdminErrorCode,
  AuthAdminPort,
  AuthAdminResult,
  AuthUserLite,
} from "@/lib/identity/auth-admin";

export type GotrueFakeMethod = keyof AuthAdminPort;
export type GotrueFakeCall = { method: GotrueFakeMethod; args: unknown[] };
export type GotrueFakeUser = AuthUserLite & { password: string | null; fullName: string | null };
export type GotrueFakeLink = {
  type: "signup" | "magiclink" | "recovery" | "invite";
  verificationType: "signup" | "magiclink" | "recovery" | "invite" | "email";
  email: string;
  hashedToken: string;
  userId: string;
  redirectTo: string | undefined;
};

type VerificationType = GotrueFakeLink["verificationType"];

export class GotrueFake implements AuthAdminPort {
  readonly calls: GotrueFakeCall[] = [];
  /** Usuarios por id. Se puede sembrar a mano o con `createUser`. */
  readonly users = new Map<string, GotrueFakeUser>();
  /** Links emitidos por `generateLink`, en orden (el test lee el `hashedToken`). */
  readonly links: GotrueFakeLink[] = [];
  /** Si se setea, el próximo `generateLink` OK devuelve este verification_type (y se limpia). */
  forceVerificationTypeNext: VerificationType | null = null;

  private readonly now: () => Date;
  private readonly minPasswordLength: number;
  private failures: Array<{ code: AuthAdminErrorCode; method?: GotrueFakeMethod }> = [];

  constructor(opts: { now?: () => Date; minPasswordLength?: number } = {}) {
    this.now = opts.now ?? (() => new Date());
    this.minPasswordLength = opts.minPasswordLength ?? 6;
  }

  /** La próxima llamada (o la próxima a `method`) falla con `code`. Se pueden encolar varias. */
  failNext(code: AuthAdminErrorCode, method?: GotrueFakeMethod): void {
    this.failures.push({ code, method });
  }

  private record(method: GotrueFakeMethod, args: unknown[]): AuthAdminResult<never> | null {
    this.calls.push({ method, args });
    const i = this.failures.findIndex((f) => !f.method || f.method === method);
    if (i === -1) return null;
    const [f] = this.failures.splice(i, 1);
    return { ok: false, code: f.code, message: `fake: ${f.code}` };
  }

  private err(code: AuthAdminErrorCode, message: string): AuthAdminResult<never> {
    return { ok: false, code, message };
  }

  private lite(u: GotrueFakeUser): AuthUserLite {
    return {
      id: u.id,
      email: u.email,
      emailConfirmedAt: u.emailConfirmedAt,
      lastSignInAt: u.lastSignInAt,
      createdAt: u.createdAt,
      bannedUntil: u.bannedUntil,
    };
  }

  private byEmail(email: string): GotrueFakeUser | undefined {
    const target = email.trim().toLowerCase();
    for (const u of this.users.values()) if (u.email === target) return u;
    return undefined;
  }

  private insert(email: string, p: { password: string | null; confirmed: boolean; fullName: string | null }) {
    const now = this.now().toISOString();
    const u: GotrueFakeUser = {
      id: randomUUID(),
      email: email.trim().toLowerCase(),
      emailConfirmedAt: p.confirmed ? now : null,
      lastSignInAt: null,
      createdAt: now,
      bannedUntil: null,
      password: p.password,
      fullName: p.fullName,
    };
    this.users.set(u.id, u);
    return u;
  }

  private weak(password: string | undefined): boolean {
    return password !== undefined && password.length < this.minPasswordLength;
  }

  async createUser(p: { email: string; password?: string; emailConfirm: boolean; fullName?: string | null }) {
    const injected = this.record("createUser", [p]);
    if (injected) return injected;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email.trim())) return this.err("error", "email inválido");
    if (this.byEmail(p.email)) return this.err("email_exists", "A user with this email address has already been registered");
    if (this.weak(p.password)) return this.err("weak_password", "Password should be at least 6 characters");
    const u = this.insert(p.email, {
      password: p.password ?? null,
      confirmed: p.emailConfirm,
      fullName: p.fullName?.trim() || null,
    });
    return { ok: true as const, data: this.lite(u) };
  }

  async deleteUser(id: string): Promise<AuthAdminResult<null>> {
    const injected = this.record("deleteUser", [id]);
    if (injected) return injected;
    if (!this.users.delete(id)) return this.err("not_found", "User not found");
    return { ok: true, data: null };
  }

  async updateUserById(
    id: string,
    p: { password?: string; emailConfirm?: boolean; fullName?: string | null; banDuration?: string | "none" }
  ) {
    const injected = this.record("updateUserById", [id, p]);
    if (injected) return injected;
    const u = this.users.get(id);
    if (!u) return this.err("not_found", "User not found");
    if (this.weak(p.password)) return this.err("weak_password", "Password should be at least 6 characters");
    let bannedUntil = u.bannedUntil;
    if (p.banDuration !== undefined) {
      if (p.banDuration === "none") bannedUntil = null;
      else {
        const m = /^(\d+)(h|m|s)$/.exec(p.banDuration);
        if (!m) return this.err("error", "invalid ban_duration");
        const ms = Number(m[1]) * (m[2] === "h" ? 3_600_000 : m[2] === "m" ? 60_000 : 1000);
        bannedUntil = new Date(this.now().getTime() + ms).toISOString();
      }
    }
    if (p.password !== undefined) u.password = p.password;
    if (p.emailConfirm === true && !u.emailConfirmedAt) u.emailConfirmedAt = this.now().toISOString();
    if (p.fullName !== undefined) u.fullName = p.fullName?.trim() || null;
    u.bannedUntil = bannedUntil;
    return { ok: true as const, data: this.lite(u) };
  }

  async getUser(id: string) {
    const injected = this.record("getUser", [id]);
    if (injected) return injected;
    const u = this.users.get(id);
    if (!u) return this.err("not_found", "User not found");
    return { ok: true as const, data: this.lite(u) };
  }

  async findUserByEmail(email: string): Promise<AuthAdminResult<AuthUserLite | null>> {
    const injected = this.record("findUserByEmail", [email]);
    if (injected) return injected;
    if (!email.trim()) return { ok: true, data: null };
    const u = this.byEmail(email);
    return { ok: true, data: u ? this.lite(u) : null };
  }

  async generateLink(p: {
    type: "signup" | "magiclink" | "recovery" | "invite";
    email: string;
    password?: string;
    redirectTo?: string;
  }) {
    const injected = this.record("generateLink", [p]);
    if (injected) return injected;
    let u = this.byEmail(p.email);
    let verificationType: VerificationType = p.type;
    switch (p.type) {
      case "recovery":
        if (!u) return this.err("not_found", "User with this email not found");
        break;
      case "magiclink":
        if (!u) {
          u = this.insert(p.email, { password: null, confirmed: false, fullName: null });
          verificationType = "signup";
        }
        break;
      case "signup":
        if (u) {
          if (u.emailConfirmedAt) return this.err("email_exists", "A user with this email address has already been registered");
        } else {
          if (!p.password) return this.err("error", "Signup requires a valid password");
          if (this.weak(p.password)) return this.err("weak_password", "Password should be at least 6 characters");
          u = this.insert(p.email, { password: p.password, confirmed: false, fullName: null });
        }
        break;
      case "invite":
        if (u) {
          if (u.emailConfirmedAt) return this.err("email_exists", "A user with this email address has already been registered");
        } else {
          u = this.insert(p.email, { password: null, confirmed: false, fullName: null });
        }
        break;
    }
    if (this.forceVerificationTypeNext) {
      verificationType = this.forceVerificationTypeNext;
      this.forceVerificationTypeNext = null;
    }
    // GoTrue guarda sha224(email+otp) en hex: 56 caracteres.
    const hashedToken = randomBytes(28).toString("hex");
    this.links.push({
      type: p.type,
      verificationType,
      email: u.email ?? p.email,
      hashedToken,
      userId: u.id,
      redirectTo: p.redirectTo,
    });
    return { ok: true as const, data: { hashedToken, verificationType, userId: u.id as string | null } };
  }
}

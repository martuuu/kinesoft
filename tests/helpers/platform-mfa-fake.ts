/**
 * Fake del puerto MFA de Plataforma (BO4, `lib/platform-mfa.ts`). Modela lo mínimo de GoTrue que usan
 * `requirePlatformAdmin` y `lib/platform-mfa-actions.ts`, con los supuestos [M1]…[M6] del puerto:
 *  - `getAssurance`: currentLevel = nivel de la sesión; nextLevel = aal2 si hay un factor verificado, si no el actual.
 *  - `enrollTotp`: crea un factor `unverified` (QR + secreto); `verify` con el código bueno lo pasa a `verified` y
 *    sube la sesión a aal2; con otro código → `mfa_verification_failed`.
 *  - `challenge` sobre un factor inexistente → `mfa_factor_not_found`.
 * Registro a mano (`calls`), no `vi.fn` (misma razón que gotrue-fake.ts).
 */
import type { MfaFactorLite, MfaResult, PlatformMfaPort, TotpEnrollment } from "@/lib/platform-mfa";
import type { AalLevel, MfaAssurance } from "@/lib/platform-mfa-logic";

export class PlatformMfaFake implements PlatformMfaPort {
  readonly calls: { method: keyof PlatformMfaPort; args: unknown[] }[] = [];
  factors: MfaFactorLite[] = [];
  level: AalLevel | null = "aal1";
  /** El código que GoTrue aceptaría. */
  goodCode = "123456";
  /** Próximo `getAssurance` falla (GoTrue caído). */
  failAssurance = false;
  private seq = 0;
  private challenges = new Set<string>();

  static withVerifiedFactor(level: AalLevel): PlatformMfaFake {
    const f = new PlatformMfaFake();
    f.factors.push({ id: "factor-ok", type: "totp", status: "verified", friendlyName: "KineSoft Plataforma", createdAt: new Date(0).toISOString() });
    f.level = level;
    return f;
  }

  async getAssurance(): Promise<MfaResult<MfaAssurance>> {
    this.calls.push({ method: "getAssurance", args: [] });
    if (this.failAssurance) return { ok: false, code: "AuthRetryableFetchError" };
    const hasVerified = this.factors.some((f) => f.status === "verified");
    return { ok: true, data: { currentLevel: this.level, nextLevel: hasVerified ? "aal2" : this.level } };
  }

  async listFactors(): Promise<MfaResult<MfaFactorLite[]>> {
    this.calls.push({ method: "listFactors", args: [] });
    return { ok: true, data: this.factors.map((f) => ({ ...f })) };
  }

  async enrollTotp(friendlyName: string): Promise<MfaResult<TotpEnrollment>> {
    this.calls.push({ method: "enrollTotp", args: [friendlyName] });
    if (this.factors.some((f) => f.friendlyName === friendlyName)) return { ok: false, code: "mfa_factor_name_conflict" };
    const id = `factor-${++this.seq}`;
    this.factors.push({ id, type: "totp", status: "unverified", friendlyName, createdAt: new Date().toISOString() });
    return { ok: true, data: { factorId: id, qrCode: "data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E", secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/x" } };
  }

  async challenge(factorId: string): Promise<MfaResult<{ challengeId: string }>> {
    this.calls.push({ method: "challenge", args: [factorId] });
    if (!this.factors.some((f) => f.id === factorId)) return { ok: false, code: "mfa_factor_not_found" };
    const id = `ch-${++this.seq}`;
    this.challenges.add(id);
    return { ok: true, data: { challengeId: id } };
  }

  async verify(factorId: string, challengeId: string, code: string): Promise<MfaResult<void>> {
    this.calls.push({ method: "verify", args: [factorId, challengeId, code] });
    if (!this.challenges.delete(challengeId)) return { ok: false, code: "mfa_challenge_expired" };
    if (code !== this.goodCode) return { ok: false, code: "mfa_verification_failed" };
    const f = this.factors.find((x) => x.id === factorId);
    if (!f) return { ok: false, code: "mfa_factor_not_found" };
    f.status = "verified";
    this.level = "aal2";
    return { ok: true, data: undefined };
  }

  async unenroll(factorId: string): Promise<MfaResult<void>> {
    this.calls.push({ method: "unenroll", args: [factorId] });
    this.factors = this.factors.filter((f) => f.id !== factorId);
    return { ok: true, data: undefined };
  }
}

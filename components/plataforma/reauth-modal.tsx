"use client";

/**
 * Re-verificación de las acciones de riesgo `high` de Plataforma (BO4, plan §19.5).
 *
 * Con `PLATFORM_MFA_ENFORCEMENT=enforce`, `requirePlatformAdmin(<acción high>)` tira `PlatformReauthRequiredError` si
 * el último código TOTP tiene más de 10 minutos. Las actions de `lib/platform-*` llaman al guard ANTES de su
 * try/catch, así que el error llega al cliente como excepción; en prod Next le borra el mensaje y deja solo el
 * `digest` (`KINE_PLATFORM_REAUTH`, ver `classifyPlatformActionError`).
 *
 * Uso en un componente de Plataforma:
 *
 *     const runPlatform = usePlatformAction();
 *     const res = await runPlatform(() => suspendPlatformTenant(input));   // mismo ActionResult de siempre
 *
 * `runPlatform` corre la action; si pide re-verificación abre este modal, llama a `verifyPlatformReauth(code)` (que
 * deja la cookie firmada de 10 min) y la reintenta UNA vez. Cancelar devuelve `{ ok: false, error }` sin tocar nada.
 * También traduce el rate limit a «Demasiados intentos. Probá de nuevo en N s.» (antes, en prod, se veía «Revisá la
 * conexión») y la falta de segundo paso (sesión vieja) a un copy + refresh (el layout redirige a /plataforma-mfa).
 * Cualquier otro error se re-tira tal cual: el catch del componente sigue funcionando como antes.
 *
 * El provider lo monta `app/(platform)/layout.tsx` alrededor del shell; recibe la action por prop (como
 * `endSupportAction` del shell) para que este módulo de cliente no arrastre el árbol de imports del server.
 *
 * PL-Z (a2#4): con `PLATFORM_MFA_ENFORCEMENT` distinto de `enforce`, las acciones `high` piden en cambio el step-up
 * de la 2FA por usuario (`requireStepUp`, digest `KINE_STEP_UP_REQUIRED` / `KINE_2FA_SETUP_REQUIRED`). El provider
 * monta adentro el mismo `StepUpProvider` de la cuenta (components/account/step-up-modal.tsx) y `runPlatform` corre
 * la action dentro de `runStepUp`: el error de step-up atraviesa la capa de Plataforma (no es suyo), el modal de
 * step-up pide el código (o explica que hay que activar la 2FA) y reintenta todo una vez. Nunca se piden los dos:
 * el server usa uno u otro según el flag.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import {
  PLATFORM_MFA_COPY,
  classifyPlatformActionError,
  normalizeTotpCode,
  platformRateLimitedCopy,
} from "@/lib/platform-mfa-logic";
import type { ActionResult } from "@/lib/validation";
import { StepUpProvider, stepUpFailureOf, useStepUpAction, type RunStepUpAction } from "@/components/account/step-up-modal";

// `fieldErrors?` opcional (siempre ausente acá): así el fallo tiene la misma forma que la rama de error de
// `ActionResult` y los componentes que leen `res.fieldErrors ?? {}` no necesitan anotar el tipo (integrador BO4/BO5).
export type PlatformActionFailure = { ok: false; error: string; fieldErrors?: Record<string, string[]> };
export type RunPlatformAction = <T>(fn: () => Promise<T>) => Promise<T | PlatformActionFailure>;
type VerifyReauthAction = (code: string) => Promise<ActionResult>;

export const REAUTH_CANCELLED = "Cancelaste la verificación: no se hizo ningún cambio.";
const REAUTH_DIDNT_STICK = "No pudimos confirmar la verificación. Recargá la página y probá de nuevo.";

/**
 * Traducción de los errores conocidos que no piden el modal. null = no es de Plataforma (re-tirar) o es `reauth`.
 * Exportada para el test.
 */
export function platformFailureOf(err: unknown, refresh: () => void): PlatformActionFailure | null {
  const k = classifyPlatformActionError(err);
  if (!k || k.kind === "reauth") return null;
  if (k.kind === "rate_limited") return { ok: false, error: platformRateLimitedCopy(k.seconds) };
  if (k.kind === "mfa_unavailable") return { ok: false, error: PLATFORM_MFA_COPY.unavailable };
  // Sesión sin segundo paso (p. ej. se prendió `enforce` con la pestaña abierta): el layout la manda a configurar
  // o verificar en el próximo render.
  refresh();
  return { ok: false, error: k.kind === "mfa_setup" ? PLATFORM_MFA_COPY.setup : PLATFORM_MFA_COPY.verify };
}

const Ctx = createContext<RunPlatformAction | null>(null);

/**
 * PL-Z: la capa de Plataforma (re-verificación TOTP, rate limit) por dentro y el step-up de la 2FA por usuario por
 * fuera. Pura sobre sus dos argumentos; exportada para el test.
 */
export function composePlatformRun(runStepUp: RunStepUpAction, runPlatform: RunPlatformAction): RunPlatformAction {
  return <T,>(fn: () => Promise<T>) => runStepUp(() => runPlatform(fn));
}

/**
 * Fuera del provider (un componente reusado en otro lado): sin modal, pero con las mismas traducciones. Una acción
 * `high` sin re-verificación vuelve con un error legible en vez de tirar.
 */
function useFallbackRun(): RunPlatformAction {
  const router = useRouter();
  return useCallback(
    async <T,>(fn: () => Promise<T>) => {
      try {
        return await fn();
      } catch (err) {
        const f = platformFailureOf(err, () => router.refresh()) ?? stepUpFailureOf(err);
        if (f) return f;
        if (classifyPlatformActionError(err)?.kind === "reauth") return { ok: false as const, error: PLATFORM_MFA_COPY.reauth };
        throw err;
      }
    },
    [router]
  );
}

export function usePlatformAction(): RunPlatformAction {
  const ctx = useContext(Ctx);
  const fallback = useFallbackRun();
  return ctx ?? fallback;
}

export function PlatformReauthProvider({
  verifyAction,
  children,
}: {
  verifyAction: VerifyReauthAction;
  children: ReactNode;
}) {
  return (
    <StepUpProvider>
      <PlatformReauthLayer verifyAction={verifyAction}>{children}</PlatformReauthLayer>
    </StepUpProvider>
  );
}

function PlatformReauthLayer({ verifyAction, children }: { verifyAction: VerifyReauthAction; children: ReactNode }) {
  const router = useRouter();
  const runStepUp = useStepUpAction();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Un solo pedido de código a la vez: si dos acciones piden re-verificar juntas, esperan el mismo modal.
  const waiting = useRef<{ promise: Promise<boolean>; resolve: (ok: boolean) => void } | null>(null);

  const askForCode = useCallback((): Promise<boolean> => {
    if (waiting.current) return waiting.current.promise;
    let resolve!: (ok: boolean) => void;
    const promise = new Promise<boolean>((r) => (resolve = r));
    waiting.current = { promise, resolve };
    setCode("");
    setError(null);
    setPending(false);
    setOpen(true);
    return promise;
  }, []);

  const settle = useCallback((ok: boolean) => {
    const w = waiting.current;
    waiting.current = null;
    setOpen(false);
    w?.resolve(ok);
  }, []);

  const run = useCallback<RunPlatformAction>(
    async <T,>(fn: () => Promise<T>) => {
      try {
        return await fn();
      } catch (err) {
        const f = platformFailureOf(err, () => router.refresh());
        if (f) return f;
        if (classifyPlatformActionError(err)?.kind !== "reauth") throw err;
      }
      if (!(await askForCode())) return { ok: false as const, error: REAUTH_CANCELLED };
      try {
        return await fn();
      } catch (err) {
        const f = platformFailureOf(err, () => router.refresh());
        if (f) return f;
        // Pidió el código otra vez justo después de verificarlo: la cookie no se guardó (bloqueada por el browser).
        // No se abre otro modal en loop.
        if (classifyPlatformActionError(err)?.kind === "reauth") return { ok: false as const, error: REAUTH_DIDNT_STICK };
        throw err;
      }
    },
    [askForCode, router]
  );
  const runWithStepUp = useMemo(() => composePlatformRun(runStepUp, run), [runStepUp, run]);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const normalized = normalizeTotpCode(code);
    if (!normalized) {
      setError("Ingresá los 6 números que muestra tu app de autenticación.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await verifyAction(normalized);
      if (!res.ok) {
        setError(res.error);
        setPending(false);
        return;
      }
      settle(true);
    } catch (err) {
      setError(platformFailureOf(err, () => router.refresh())?.error ?? "No se pudo verificar el código. Revisá la conexión y probá de nuevo.");
      setPending(false);
    }
  };

  return (
    <Ctx.Provider value={runWithStepUp}>
      {children}
      <Modal
        open={open}
        onClose={() => {
          if (!pending) settle(false);
        }}
        lockBackdrop
        width={420}
        title="Confirmá que sos vos"
        description="Esta acción pide el código de tu app de autenticación. Después no te lo vamos a pedir por 10 minutos."
      >
        <form onSubmit={onSubmit} style={{ display: "grid", gap: 14 }}>
          <TotpCodeInput value={code} onChange={setCode} disabled={pending} error={error} autoFocus />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
            <Button type="button" variant="ghost" onClick={() => settle(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Verificando…" : "Confirmar"}
            </Button>
          </div>
        </form>
      </Modal>
    </Ctx.Provider>
  );
}

/**
 * Campo del código TOTP. No es `FormField` porque el código necesita `inputMode="numeric"` (teclado numérico en el
 * teléfono) y `autoComplete="one-time-code"` (los gestores de contraseñas lo completan), que la primitiva no expone.
 * Mismo look que `FormField` (label 12px navy-500, input con los tokens del design system).
 */
export function TotpCodeInput({
  value,
  onChange,
  disabled,
  error,
  autoFocus,
  label = "Código de 6 números",
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  error?: string | null;
  autoFocus?: boolean;
  label?: string;
}) {
  return (
    <label style={{ display: "block", fontSize: 12, minWidth: 0 }}>
      <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>{label}</span>
      <input
        name="code"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoFocus={autoFocus}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 \-]*"
        maxLength={9}
        placeholder="123 456"
        aria-invalid={error ? true : undefined}
        style={{
          display: "block",
          marginTop: 6,
          width: "100%",
          padding: "12px 14px",
          borderRadius: 12,
          border: `1px solid ${error ? "rgba(225,75,75,0.4)" : "rgba(15,30,51,0.08)"}`,
          background: "rgba(255,255,255,0.96)",
          fontSize: 22,
          letterSpacing: "0.3em",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          color: "var(--navy-900)",
          outline: "none",
          opacity: disabled ? 0.5 : 1,
        }}
      />
      {error && (
        <span role="alert" style={{ display: "block", marginTop: 6, color: "#9F1F1F", fontSize: 12.5 }}>
          {error}
        </span>
      )}
    </label>
  );
}

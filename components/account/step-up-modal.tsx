"use client";

/**
 * Step-up de la 2FA (PL-2a, C-PL6; PL-D11): generaliza el `reauth-modal` / `usePlatformAction` de Plataforma (BO4)
 * a cualquier usuario y a los dos métodos (app y email) más el código de recuperación.
 *
 * El server corta con `requireStepUp` (lib/two-factor-step-up.ts): `KINE_STEP_UP_REQUIRED` (tiene 2FA, falta un
 * código de los últimos 10 min) o `KINE_2FA_SETUP_REQUIRED` (no tiene 2FA y la acción la exige: cambiar el plan,
 * los permisos del equipo o la titularidad del consultorio). Esos errores tiran fuera del try/catch de la action y llegan como excepción con el `digest`
 * (`classifyStepUpError`).
 *
 * Uso (PL-2b, PL-3):
 *
 *     <StepUpProvider> … </StepUpProvider>          // una vez, alrededor del panel o del shell
 *     const runStepUp = useStepUpAction();
 *     const res = await runStepUp(() => applyPlanChange(input));   // mismo ActionResult de siempre
 *
 * `runStepUp` corre la action; si pide step-up abre el modal (pide el código y deja la cookie de 10 min) y la
 * reintenta UNA vez. Si falta configurar la 2FA, el modal lo explica con el enlace a Seguridad de la cuenta y vuelve
 * `{ ok: false, error }`. Cancelar devuelve `{ ok: false, error }` sin tocar nada. Cualquier otro error se re-tira.
 * Fuera de un provider: sin modal, con las mismas traducciones a error legible.
 */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { TwoFactorChallenge } from "@/components/account/two-factor-challenge";
import { getStepUpOptions } from "@/lib/two-factor";
import { classifyStepUpError } from "@/lib/two-factor-logic";
import type { StepUpOptions } from "@/lib/two-factor-types";

export type StepUpFailure = { ok: false; error: string; fieldErrors?: Record<string, string[]> };
export type RunStepUpAction = <T>(fn: () => Promise<T>) => Promise<T | StepUpFailure>;

export const STEP_UP_CANCELLED = "Cancelaste la verificación: no se hizo ningún cambio.";
export const STEP_UP_SETUP_REQUIRED = "Activá la verificación en dos pasos para hacer este cambio. Lo hacés en Seguridad de la cuenta.";
const STEP_UP_DIDNT_STICK = "No pudimos confirmar la verificación. Recargá la página y probá de nuevo.";
const STEP_UP_NEEDED = "Esta acción pide confirmar que sos vos. Probá de nuevo desde la pantalla.";
export const SECURITY_HREF = "/cuenta/seguridad";

/**
 * PL-Z M8: «Activarla» lleva a Seguridad con `?next=` = la pantalla actual, así «Volver» regresa ahí (la página lo
 * filtra con `safeNext`). Exportada para el test.
 */
export function securityHrefWithNext(current: string | null | undefined): string {
  if (!current || current.startsWith(SECURITY_HREF)) return SECURITY_HREF;
  return `${SECURITY_HREF}?next=${encodeURIComponent(current)}`;
}

/** Traducción sin modal (fuera del provider). Exportada para el test. null = no es de step-up: re-tirar. */
export function stepUpFailureOf(err: unknown): StepUpFailure | null {
  const k = classifyStepUpError(err);
  if (!k) return null;
  return { ok: false, error: k.kind === "setup" ? STEP_UP_SETUP_REQUIRED : STEP_UP_NEEDED };
}

const Ctx = createContext<RunStepUpAction | null>(null);

function useFallbackRun(): RunStepUpAction {
  return useCallback(async <T,>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      const f = stepUpFailureOf(err);
      if (f) return f;
      throw err;
    }
  }, []);
}

export function useStepUpAction(): RunStepUpAction {
  const ctx = useContext(Ctx);
  const fallback = useFallbackRun();
  return ctx ?? fallback;
}

type Ask = { kind: "step_up" } | { kind: "setup" };

export function StepUpProvider({ children }: { children: ReactNode }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [options, setOptions] = useState<StepUpOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Un solo pedido a la vez: si dos acciones piden step-up juntas, esperan el mismo modal.
  const waiting = useRef<{ promise: Promise<boolean>; resolve: (ok: boolean) => void } | null>(null);

  const open = useCallback((a: Ask): Promise<boolean> => {
    if (waiting.current) return waiting.current.promise;
    let resolve!: (ok: boolean) => void;
    const promise = new Promise<boolean>((r) => (resolve = r));
    waiting.current = { promise, resolve };
    setAsk(a);
    setOptions(null);
    setLoadError(null);
    if (a.kind === "step_up") {
      getStepUpOptions()
        .then((r) => (r.ok ? setOptions(r.data) : setLoadError(r.error)))
        .catch(() => setLoadError("No pudimos cargar tus métodos de verificación. Revisá la conexión."));
    }
    return promise;
  }, []);

  const settle = useCallback((ok: boolean) => {
    const w = waiting.current;
    waiting.current = null;
    setAsk(null);
    w?.resolve(ok);
  }, []);

  const run = useCallback<RunStepUpAction>(
    async <T,>(fn: () => Promise<T>) => {
      let first: unknown;
      try {
        return await fn();
      } catch (err) {
        first = err;
      }
      const k = classifyStepUpError(first);
      if (!k) throw first;
      if (k.kind === "setup") {
        await open({ kind: "setup" });
        return { ok: false as const, error: STEP_UP_SETUP_REQUIRED };
      }
      if (!(await open({ kind: "step_up" }))) return { ok: false as const, error: STEP_UP_CANCELLED };
      try {
        return await fn();
      } catch (err) {
        const again = classifyStepUpError(err);
        // Pidió el código otra vez justo después de verificarlo: la cookie no se guardó. No se abre otro modal en loop.
        if (again?.kind === "step_up") return { ok: false as const, error: STEP_UP_DIDNT_STICK };
        if (again?.kind === "setup") return { ok: false as const, error: STEP_UP_SETUP_REQUIRED };
        throw err;
      }
    },
    [open]
  );

  const hasMethod = !!options && (options.methods.totp || options.methods.email);

  return (
    <Ctx.Provider value={run}>
      {children}
      <Modal
        open={ask !== null}
        onClose={() => settle(false)}
        lockBackdrop
        width={440}
        title={ask?.kind === "setup" ? "Activá la verificación en dos pasos" : "Confirmá que sos vos"}
        description={
          ask?.kind === "setup"
            ? "Para este cambio pedimos un segundo paso además de la contraseña: una app de autenticación o un código por email."
            : "Esta acción pide un código. Después no te lo vamos a pedir por 10 minutos."
        }
      >
        {ask?.kind === "setup" && (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button type="button" variant="ghost" onClick={() => settle(false)}>
              Ahora no
            </Button>
            {/* El modal solo se abre en el cliente (estado `ask`), así que leer `window.location` no desfasa la hidratación. */}
            <a
              href={securityHrefWithNext(typeof window === "undefined" ? null : window.location.pathname + window.location.search)}
              className="k-btn k-btn-primary" style={{ textDecoration: "none", padding: "10px 16px" }}>
              Activarla
            </a>
          </div>
        )}
        {ask?.kind === "step_up" && (
          <div style={{ display: "grid", gap: 12 }}>
            {loadError && (
              <p role="alert" style={{ margin: 0, color: "var(--danger-fg)", fontSize: 13 }}>
                {loadError}
              </p>
            )}
            {!options && !loadError && (
              <p role="status" style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>
                Cargando…
              </p>
            )}
            {options && hasMethod && (
              <TwoFactorChallenge
                purpose="step_up"
                methods={options.methods}
                emailMasked={options.emailMasked}
                submitLabel="Confirmar"
                onDone={() => settle(true)}
              />
            )}
            <Button type="button" variant="ghost" onClick={() => settle(false)} style={{ justifySelf: "end" }}>
              Cancelar
            </Button>
          </div>
        )}
      </Modal>
    </Ctx.Provider>
  );
}

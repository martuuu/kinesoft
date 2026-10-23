"use client";

import { useEffect, useId, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/lib/validation";
import { PAIRING_CODE_LEN, cleanPairingCodeInput, formatPairingCode } from "@/lib/reception-displays-types";

/**
 * TV-2u1 (§26.4 C-TV): pantalla de vínculo de `/tv`. La persona del consultorio genera un código de 8 caracteres en
 * Sala de espera → Pantallas (TV-D6) y lo tipea acá con el control remoto o un teclado.
 *
 * - **Funciona sin JS**: `useFormState(action)` con la server action que arma la page (envuelve `pairDisplay`); el form
 *   hace el POST igual en un navegador de Smart TV que no hidrata. Por eso `name="code"` y el valor llega crudo: el
 *   server normaliza con `normalizePairingCode` (el guion de la máscara, minúsculas, O/I/L de Crockford).
 * - Al vincular, la action setea la cookie `kine_tv`: Next re-renderiza la ruta sola (un `cookies().set` en una action
 *   invalida el router) y la page ya resuelve la sesión → `TvScreen`. Acá solo se muestra «Pantalla vinculada…».
 * - Legible a 3 m: tipografía con `clamp(..., vw, ...)`, que en una TV 1080p da ~64-96 px en el input. Tema oscuro
 *   fijo (TV-D11) con colores en hex: el layout de `/tv` no carga la paleta del workspace.
 * - Sin framer, toast, drawer ni modal (`tests/unit/public-surface-imports.test.ts`): el grupo `display` tiene 125 kB.
 */

export type PairState = ActionResult | null;
export type PairReason = "revoked" | "unavailable";

/** Puro: lo tipeado → lo que muestra el input. Mismas sustituciones que el server, cortado al largo del código. */
export function pairInputValue(raw: string): string {
  return formatPairingCode(cleanPairingCodeInput(raw).slice(0, PAIRING_CODE_LEN));
}

const REASON_MESSAGES: Record<PairReason, string> = {
  revoked: "Esta pantalla se desvinculó desde Sala de espera. Para volver a usarla, generá un código nuevo.",
  unavailable:
    "La sala de espera de este consultorio no está disponible en este momento. Cuando vuelva a estarlo, la pantalla se reconecta sola.",
};

/** Puro: por qué la pantalla volvió al vínculo (la page lo saca del `DeviceFeedResult`). */
export function pairReasonMessage(reason: PairReason | undefined): string | null {
  return reason ? REASON_MESSAGES[reason] : null;
}

/**
 * Con `unavailable` la cookie sigue siendo válida (el consultorio está suspendido o sin el módulo): cuando se
 * reactiva, la page vuelve a resolver la sesión. Se re-pide cada 60 s para que nadie tenga que tocar la tele.
 */
const UNAVAILABLE_RETRY_MS = 60_000;

const C = {
  fg: "#F2F6FB",
  muted: "#A9B8CC",
  field: "#14243B",
  border: "#2C4366",
  focus: "#B4E94A",
  error: "#FFB4A8",
  accent: "#B4E94A",
  accentFg: "#0F1E33",
};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      aria-disabled={pending || undefined}
      onClick={(e) => {
        if (pending) e.preventDefault();
      }}
      style={{
        fontSize: "clamp(24px, 2.6vw, 48px)",
        fontWeight: 700,
        padding: "0.5em 1.6em",
        borderRadius: 999,
        border: "none",
        background: C.accent,
        color: C.accentFg,
        cursor: "pointer",
        minHeight: 64,
      }}
    >
      {pending ? "Vinculando…" : "Vincular"}
    </button>
  );
}

export function TvPairScreen({
  action,
  reason,
}: {
  action: (prev: PairState, formData: FormData) => Promise<PairState>;
  reason?: PairReason;
}) {
  const [state, formAction] = useFormState(action, null);
  const [value, setValue] = useState("");
  const router = useRouter();
  const inputId = useId();
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;

  const error = state && !state.ok ? state.error : null;
  const paired = state?.ok === true;
  const reasonText = pairReasonMessage(reason);

  useEffect(() => {
    if (reason !== "unavailable") return;
    // refresh-ok: reintento periódico de una TV sin servicio; no hay action que revalide, el RSC re-evalúa la sesión.
    const t = setInterval(() => router.refresh(), UNAVAILABLE_RETRY_MS);
    return () => clearInterval(t);
  }, [reason, router]);

  // Respaldo de la re-renderización automática: si la ruta no se refrescó sola tras vincular, se pide una vez.
  useEffect(() => {
    // refresh-ok: cambió la cookie del dispositivo (auth de la TV) y `pairDisplay` no revalida rutas.
    if (paired) router.refresh();
  }, [paired, router]);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "clamp(20px, 3vh, 48px)",
        padding: "4vh 6vw",
        color: C.fg,
        textAlign: "center",
      }}
    >
      <h1 style={{ fontSize: "clamp(40px, 4.4vw, 88px)", fontWeight: 700, margin: 0, lineHeight: 1.1 }}>
        Vinculá esta pantalla
      </h1>

      {reasonText && (
        <p role="status" style={{ fontSize: "clamp(20px, 1.8vw, 36px)", color: C.muted, margin: 0, maxWidth: "32em" }}>
          {reasonText}
        </p>
      )}

      <form
        action={formAction}
        style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "clamp(16px, 2.4vh, 36px)" }}
      >
        <label htmlFor={inputId} style={{ fontSize: "clamp(22px, 2vw, 40px)", color: C.muted }}>
          Código de la pantalla
        </label>
        <input
          id={inputId}
          name="code"
          value={value}
          onChange={(e) => setValue(pairInputValue(e.target.value))}
          // 8 caracteres + el guion de la máscara.
          maxLength={PAIRING_CODE_LEN + 1}
          autoFocus
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          placeholder="ABCD-EFGH"
          required
          aria-describedby={`${helpId} ${errorId}`}
          aria-invalid={error ? true : undefined}
          style={{
            fontSize: "clamp(48px, 6vw, 120px)",
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.12em",
            textAlign: "center",
            textTransform: "uppercase",
            width: "9.5ch",
            padding: "0.15em 0.4em",
            borderRadius: 24,
            border: `4px solid ${error ? C.error : C.border}`,
            background: C.field,
            color: C.fg,
            outlineColor: C.focus,
          }}
        />
        <p id={helpId} style={{ fontSize: "clamp(20px, 1.8vw, 36px)", color: C.muted, margin: 0 }}>
          Generá el código en Sala de espera → Pantallas
        </p>
        <SubmitButton />
        {/* Siempre montada: una región viva que aparece junto con su texto no la anuncian varios lectores. */}
        <p
          id={errorId}
          role="alert"
          aria-live="assertive"
          style={{ fontSize: "clamp(22px, 2vw, 40px)", color: C.error, margin: 0, minHeight: "1.4em" }}
        >
          {error}
        </p>
      </form>

      {paired && (
        <p role="status" style={{ fontSize: "clamp(22px, 2vw, 40px)", color: C.accent, margin: 0 }}>
          Pantalla vinculada. Cargando…
        </p>
      )}
    </main>
  );
}

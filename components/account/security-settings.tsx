"use client";

/**
 * Pantalla de `/cuenta/seguridad` (PL-2a, C-PL6). Tres bloques y la actividad:
 *  - App de autenticación (TOTP de Supabase): QR + código para activarla (el QR es el SVG de Supabase como data URI);
 *  - Código por email: «Mandame un código» + el código para activarla (prueba que la casilla es tuya);
 *  - Códigos de recuperación: cuántos quedan y generar nuevos.
 * Apagar un método y regenerar códigos piden confirmación (`useConfirm`) y step-up (`StepUpProvider`): con la sesión
 * de otra persona abierta en una PC compartida no alcanza para sacarte la 2FA.
 *
 * Los códigos de recuperación se muestran UNA vez (al activar el primer método o al regenerar): el server no los
 * guarda en claro.
 */
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { TotpCodeInput } from "@/components/account/totp-code-input";
import { StepUpProvider, useStepUpAction } from "@/components/account/step-up-modal";
import {
  confirmTotpEnrollment,
  disableMethod,
  enableEmailMethod,
  regenerateRecoveryCodes,
  requestEmailCode,
  startTotpEnrollment,
} from "@/lib/two-factor";
import type { TotpEnrollmentView } from "@/lib/two-factor-types";
import type { TwoFactorOverview } from "@/lib/two-factor-internal";

const AR_TZ = "America/Argentina/Buenos_Aires";
const NETWORK = "No se pudo completar. Revisá la conexión y probá de nuevo.";

const EVENT_LABEL: Record<string, string> = {
  "two_factor.totp_enabled": "Activaste la app de autenticación",
  "two_factor.totp_disabled": "Desactivaste la app de autenticación",
  "two_factor.email_enabled": "Activaste la verificación por email",
  "two_factor.email_disabled": "Desactivaste la verificación por email",
  "two_factor.recovery_generated": "Se generaron códigos de recuperación",
  "two_factor.recovery_used": "Se usó un código de recuperación",
  "two_factor.email_code_locked": "Se bloqueó un código por email (demasiados intentos)",
  "two_factor.reset_by_platform": "El equipo de KineSoft restableció tu verificación",
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    timeZone: AR_TZ,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

export function SecuritySettings(props: { overview: TwoFactorOverview; emailMasked: string; backHref: string }) {
  return (
    <StepUpProvider>
      <SecuritySettingsInner {...props} />
    </StepUpProvider>
  );
}

function SecuritySettingsInner({
  overview,
  emailMasked,
  backHref,
}: {
  overview: TwoFactorOverview;
  emailMasked: string;
  backHref: string;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const runStepUp = useStepUpAction();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { methods } = overview;
  const anyMethod = methods.totp || methods.email;

  const onEnabled = (recoveryCodes: string[] | null, what: string) => {
    toast.success(what);
    if (recoveryCodes) setCodes(recoveryCodes);
    router.refresh(); // refresh-ok: las actions de 2FA no revalidan (página fuera de los grupos)
  };

  async function onDisable(method: "totp" | "email") {
    const last = (method === "totp" ? !methods.email : !methods.totp);
    const ok = await confirm({
      title: method === "totp" ? "¿Desactivar la app de autenticación?" : "¿Desactivar el código por email?",
      message: last
        ? "Es tu único método: tu cuenta queda sin verificación en dos pasos y se borran tus códigos de recuperación. No vas a poder cambiar el plan, los permisos ni la titularidad hasta activarla de nuevo."
        : "Vas a seguir teniendo el otro método.",
      confirmLabel: "Desactivar",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await runStepUp(() => disableMethod(method));
      if (!r.ok) {
        toast.error("No se pudo desactivar", { description: r.error });
        return;
      }
      if (r.data.signedOut) {
        toast.info("Listo. Por seguridad, volvé a entrar.");
        router.replace("/login");
        return;
      }
      toast.success("Listo, quedó desactivado");
      router.refresh(); // refresh-ok: las actions de 2FA no revalidan (página fuera de los grupos)
    } catch {
      toast.error("No se pudo desactivar", { description: NETWORK });
    } finally {
      setBusy(false);
    }
  }

  async function onRegenerate() {
    const ok = await confirm({
      title: "¿Generar códigos nuevos?",
      message: "Los códigos que tenés dejan de servir.",
      confirmLabel: "Generar",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await runStepUp(() => regenerateRecoveryCodes());
      if (!r.ok) {
        toast.error("No se pudieron generar", { description: r.error });
        return;
      }
      setCodes(r.data.recoveryCodes);
      router.refresh(); // refresh-ok: las actions de 2FA no revalidan (página fuera de los grupos)
    } catch {
      toast.error("No se pudieron generar", { description: NETWORK });
    } finally {
      setBusy(false);
    }
  }

  if (codes) return <RecoveryCodesPanel codes={codes} onDone={() => setCodes(null)} />;

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <h2 className="k-display" style={{ fontSize: 24, margin: "0 0 8px", lineHeight: 1.15 }}>
        Verificación en dos pasos
      </h2>

      <Section
        title="App de autenticación"
        status={methods.totp}
        hint="Un código de 6 números que cambia cada 30 segundos en tu teléfono (Google Authenticator, 1Password, Authy…)."
      >
        {methods.totp ? (
          <Button variant="ghost" onClick={() => onDisable("totp")} disabled={busy}>
            Desactivar
          </Button>
        ) : (
          <TotpSetup onEnabled={(c) => onEnabled(c, "Activaste la app de autenticación")} />
        )}
      </Section>

      <Section title="Código por email" status={methods.email} hint={`Te mandamos un código de 6 números${emailMasked ? ` a ${emailMasked}` : ""} cada vez que lo necesites.`}>
        {methods.email ? (
          <Button variant="ghost" onClick={() => onDisable("email")} disabled={busy}>
            Desactivar
          </Button>
        ) : (
          <EmailSetup onEnabled={(c) => onEnabled(c, "Activaste la verificación por email")} />
        )}
      </Section>

      {anyMethod && (
        <Section
          title="Códigos de recuperación"
          hint={
            overview.recoveryCodesLeft > 0
              ? `Te ${overview.recoveryCodesLeft === 1 ? "queda 1 código" : `quedan ${overview.recoveryCodesLeft} códigos`}. Sirven si perdés el teléfono o no te llega el mail; cada uno se usa una vez.`
              : "No te quedan códigos. Generá nuevos y guardalos en un lugar seguro."
          }
        >
          <Button variant="ghost" onClick={onRegenerate} disabled={busy}>
            Generar códigos nuevos
          </Button>
        </Section>
      )}

      <section aria-labelledby="sec-activity" style={{ paddingTop: 14, borderTop: "1px solid rgba(15,30,51,0.06)" }}>
        <h3 id="sec-activity" style={{ fontSize: 13.5, fontWeight: 700, color: "var(--navy-900)", margin: "0 0 8px" }}>
          Actividad reciente
        </h3>
        {overview.events.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--navy-500)" }}>Todavía no hay cambios de seguridad en tu cuenta.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {overview.events.map((e) => (
              <li key={e.id} style={{ fontSize: 12.5, color: "var(--navy-700)", display: "flex", gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
                <span>{EVENT_LABEL[e.kind] ?? "Cambio de seguridad"}</span>
                <time dateTime={e.createdAt} style={{ color: "var(--navy-500)" }}>
                  {formatWhen(e.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>

      <a href={backHref} style={{ marginTop: 18, fontSize: 13, color: "var(--sky-700)", fontWeight: 600, textAlign: "center" }}>
        Volver
      </a>
    </div>
  );
}

function Section({
  title,
  hint,
  status,
  children,
}: {
  title: string;
  hint: string;
  status?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section style={{ display: "grid", gap: 10, padding: "14px 0", borderTop: "1px solid rgba(15,30,51,0.06)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <h3 style={{ fontSize: 13.5, fontWeight: 700, color: "var(--navy-900)", margin: 0 }}>{title}</h3>
        {status !== undefined && <Tag tone={status ? "lime" : "soft"}>{status ? "Activada" : "Desactivada"}</Tag>}
      </div>
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--navy-500)", lineHeight: 1.45 }}>{hint}</p>
      <div>{children}</div>
    </section>
  );
}

function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" style={{ margin: 0, color: "#9F1F1F", fontSize: 12.5 }}>
      {children}
    </p>
  );
}

/** El secreto base32 en grupos de 4 para tipearlo sin perderse. */
function groupSecret(secret: string): string {
  return secret.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}

function TotpSetup({ onEnabled }: { onEnabled: (codes: string[] | null) => void }) {
  const [enrollment, setEnrollment] = useState<TotpEnrollmentView | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // A pedido (botón) y no al montar: un prefetch o un doble render no crea factores sueltos en Supabase.
  const start = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const r = await startTotpEnrollment();
      if (!r.ok) setError(r.error);
      else {
        setEnrollment(r.data);
        setCode("");
      }
    } catch {
      setError(NETWORK);
    } finally {
      setPending(false);
    }
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending || !enrollment) return;
    setPending(true);
    setError(null);
    try {
      const r = await confirmTotpEnrollment(enrollment.factorId, code);
      if (!r.ok) {
        setError(r.error);
        setPending(false);
        return;
      }
      onEnabled(r.data.recoveryCodes);
    } catch {
      setError(NETWORK);
      setPending(false);
    }
  };

  if (!enrollment) {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        {error && <ErrorText>{error}</ErrorText>}
        <Button variant="primary" onClick={start} disabled={pending}>
          {pending ? "Generando…" : "Activar con una app"}
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
      {enrollment.existing ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--navy-700)", lineHeight: 1.5 }}>
          Ya tenés KineSoft cargado en tu app de autenticación. Escribí el código que muestra para activarla.
        </p>
      ) : (
        <div style={{ display: "grid", justifyItems: "center", gap: 10 }}>
          <p style={{ margin: 0, fontSize: 13, color: "var(--navy-700)", lineHeight: 1.5 }}>
            Escaneá el código QR con tu app de autenticación y escribí el código de 6 números que te muestra.
          </p>
          {enrollment.qrCode && (
            // SVG de Supabase como data URI (CSP: img-src data:). Fondo blanco: las apps no leen el QR sobre vidrio.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={enrollment.qrCode}
              alt="Código QR para tu app de autenticación"
              width={196}
              height={196}
              style={{ background: "#fff", padding: 10, borderRadius: 16 }}
            />
          )}
          {enrollment.secret && (
            <div style={{ fontSize: 12.5, color: "var(--navy-500)", textAlign: "center" }}>
              ¿No podés escanearlo? Cargá este código a mano:
              <code
                style={{
                  display: "block",
                  marginTop: 6,
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  fontSize: 13,
                  color: "var(--navy-900)",
                  overflowWrap: "anywhere",
                  userSelect: "all",
                }}
              >
                {groupSecret(enrollment.secret)}
              </code>
            </div>
          )}
        </div>
      )}
      <TotpCodeInput value={code} onChange={setCode} disabled={pending} error={error} autoFocus />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Verificando…" : "Activar"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setEnrollment(null)} disabled={pending}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function EmailSetup({ onEnabled }: { onEnabled: (codes: string[] | null) => void }) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const send = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const r = await requestEmailCode("enroll_email");
      if (!r.ok) setError(r.error);
      else setSentTo(r.data.sentTo);
    } catch {
      setError(NETWORK);
    } finally {
      setPending(false);
    }
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const r = await enableEmailMethod(code);
      if (!r.ok) {
        setError(r.error);
        setPending(false);
        return;
      }
      onEnabled(r.data.recoveryCodes);
    } catch {
      setError(NETWORK);
      setPending(false);
    }
  };

  if (!sentTo) {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        {error && <ErrorText>{error}</ErrorText>}
        <Button variant="primary" onClick={send} disabled={pending}>
          {pending ? "Mandando…" : "Activar por email"}
        </Button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
      <p role="status" style={{ margin: 0, fontSize: 13, color: "var(--navy-700)" }}>
        Te mandamos un código a {sentTo}. Vence en 10 minutos.
      </p>
      <TotpCodeInput value={code} onChange={setCode} disabled={pending} error={error} autoFocus label="Código del email" />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Verificando…" : "Activar"}
        </Button>
        <Button type="button" variant="ghost" onClick={send} disabled={pending}>
          Mandame otro código
        </Button>
      </div>
    </form>
  );
}

/** Los códigos en claro, una sola vez. Exportado para el render test. */
export function RecoveryCodesPanel({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const toast = useToast();
  const text = codes.join("\n");
  return (
    <div role="region" aria-label="Códigos de recuperación" style={{ display: "grid", gap: 14 }}>
      <h2 className="k-display" style={{ fontSize: 22, margin: 0, lineHeight: 1.2 }}>
        Guardá tus códigos de recuperación
      </h2>
      <p style={{ margin: 0, fontSize: 13.5, color: "var(--navy-700)", lineHeight: 1.55 }}>
        Si perdés el teléfono o no te llega el mail, entrás con uno de estos códigos. Cada uno sirve una sola vez. No
        los vas a volver a ver: guardalos en tu gestor de contraseñas o imprimilos.
      </p>
      <ol
        style={{
          margin: 0,
          padding: "12px 16px 12px 36px",
          background: "#fff",
          borderRadius: 12,
          border: "1px solid rgba(15,30,51,0.08)",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
          gap: "6px 18px",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 14,
          color: "var(--navy-900)",
        }}
      >
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button
          type="button"
          variant="ghost"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              toast.success("Códigos copiados");
            } catch {
              toast.error("No se pudieron copiar", { description: "Seleccionalos y copialos a mano." });
            }
          }}
        >
          Copiar
        </Button>
        <Button type="button" variant="primary" onClick={onDone}>
          Listo, los guardé
        </Button>
      </div>
    </div>
  );
}

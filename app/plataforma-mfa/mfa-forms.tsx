"use client";

/**
 * Formularios de `/plataforma-mfa` (BO4): configurar el TOTP (QR + código manual) e ingresar el código del inicio de
 * sesión. Las actions llegan por prop desde la página (server) para que este módulo de cliente no importe el server.
 *
 * Después de un código bien puesto la sesión ya es AAL2 (GoTrue reescribió las cookies en la action): `router.replace`
 * al `next` + `refresh`, para que el layout de `(platform)` relea el nivel y no use el árbol cacheado.
 */
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { TotpCodeInput } from "@/components/plataforma/reauth-modal";
import { normalizeTotpCode, type PlatformMfaEnrollment } from "@/lib/platform-mfa-logic";
import type { ActionResult } from "@/lib/validation";

const INVALID = "Ingresá los 6 números que muestra tu app de autenticación.";
const NETWORK = "No se pudo completar. Revisá la conexión y probá de nuevo.";

/** El secreto base32 en grupos de 4 para tipearlo sin perderse. */
function groupSecret(secret: string): string {
  return secret.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}

export function MfaSetupForm({
  next,
  startAction,
  confirmAction,
}: {
  next: string;
  startAction: () => Promise<ActionResult<PlatformMfaEnrollment>>;
  confirmAction: (factorId: string, code: string) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [enrollment, setEnrollment] = useState<PlatformMfaEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // A pedido (botón) y no al montar: un prefetch o un doble render no crea factores sueltos en GoTrue.
  const generate = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await startAction();
      if (!res.ok) setError(res.error);
      else {
        setEnrollment(res.data);
        setCode("");
      }
    } catch {
      setError(NETWORK);
    } finally {
      setPending(false);
    }
  };

  const confirm = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending || !enrollment) return;
    const normalized = normalizeTotpCode(code);
    if (!normalized) {
      setError(INVALID);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await confirmAction(enrollment.factorId, normalized);
      if (!res.ok) {
        setError(res.error);
        setPending(false);
        return;
      }
      // Sin setPending(false): la navegación desmonta el form; así no se manda dos veces.
      router.replace(next);
      router.refresh();
    } catch {
      setError(NETWORK);
      setPending(false);
    }
  };

  if (!enrollment) {
    return (
      <div style={{ display: "grid", gap: 14 }}>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 14, color: "var(--navy-700)", lineHeight: 1.6 }}>
          <li>Instalá una app de autenticación en tu teléfono (Google Authenticator, 1Password, Authy…).</li>
          <li>Generá el código QR y escanealo con la app.</li>
          <li>Ingresá el código de 6 números que te muestra para activarla.</li>
        </ol>
        {error && <ErrorText>{error}</ErrorText>}
        <Button
          type="button"
          variant="primary"
          onClick={generate}
          disabled={pending}
          style={{ width: "100%", justifyContent: "center", padding: "12px 18px" }}
        >
          {pending ? "Generando…" : "Generar código QR"}
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={confirm} style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", justifyItems: "center", gap: 10 }}>
        {/* SVG de Supabase como data URI (CSP: img-src data:). Fondo blanco: las apps no leen el QR sobre vidrio. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={enrollment.qrCode}
          alt="Código QR para tu app de autenticación"
          width={196}
          height={196}
          style={{ background: "#fff", padding: 10, borderRadius: 16 }}
        />
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
      </div>
      <TotpCodeInput value={code} onChange={setCode} disabled={pending} error={error} autoFocus />
      <Button
        type="submit"
        variant="primary"
        disabled={pending}
        style={{ width: "100%", justifyContent: "center", padding: "12px 18px" }}
      >
        {pending ? "Verificando…" : "Activar verificación en dos pasos"}
      </Button>
      <Button type="button" variant="ghost" onClick={generate} disabled={pending} style={{ justifySelf: "center" }}>
        Generar otro código QR
      </Button>
    </form>
  );
}

export function MfaVerifyForm({ next, verifyAction }: { next: string; verifyAction: (code: string) => Promise<ActionResult> }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const normalized = normalizeTotpCode(code);
    if (!normalized) {
      setError(INVALID);
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
      router.replace(next);
      router.refresh();
    } catch {
      setError(NETWORK);
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 16 }}>
      <TotpCodeInput value={code} onChange={setCode} disabled={pending} error={error} autoFocus />
      <Button
        type="submit"
        variant="primary"
        disabled={pending}
        style={{ width: "100%", justifyContent: "center", padding: "12px 18px" }}
      >
        {pending ? "Verificando…" : "Entrar a Plataforma"}
      </Button>
    </form>
  );
}

function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" style={{ margin: 0, color: "#9F1F1F", fontSize: 13 }}>
      {children}
    </p>
  );
}

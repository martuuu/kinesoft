"use client";

/**
 * Formulario de `/verificar-acceso` (PL-2a). Después del segundo paso la cookie `kine_2fa` (email/recuperación) o la
 * sesión AAL2 (TOTP, GoTrue reescribió las cookies en la action) ya están: `router.replace(next)` + `refresh`, para
 * que el layout relea la foto y no use el árbol cacheado. Un código de recuperación que deja pocos avisa antes de
 * seguir.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { TwoFactorChallenge } from "@/components/account/two-factor-challenge";
import type { TwoFactorMethods } from "@/lib/two-factor-logic";

export function VerifyAccessForm({
  next,
  methods,
  emailMasked,
}: {
  next: string;
  methods: TwoFactorMethods;
  emailMasked: string;
}) {
  const router = useRouter();
  const [lowCodes, setLowCodes] = useState<number | null>(null);

  const go = () => {
    router.replace(next);
    router.refresh(); // refresh-ok: cambió la autenticación (cookie kine_2fa / sesión AAL2); el layout relee la foto
  };

  if (lowCodes !== null) {
    return (
      <div role="status" style={{ display: "grid", gap: 14 }}>
        <p style={{ margin: 0, fontSize: 14, color: "var(--navy-700)", lineHeight: 1.55 }}>
          {lowCodes === 0
            ? "Usaste tu último código de recuperación. Generá códigos nuevos en Seguridad de la cuenta."
            : `Te ${lowCodes === 1 ? "queda 1 código" : `quedan ${lowCodes} códigos`} de recuperación. Si perdiste el teléfono, revisá tu verificación en Seguridad de la cuenta.`}
        </p>
        <Button type="button" variant="primary" onClick={() => router.replace("/cuenta/seguridad")} style={{ width: "100%", justifyContent: "center", padding: "12px 18px" }}>
          Ir a Seguridad de la cuenta
        </Button>
        <Button type="button" variant="ghost" onClick={go} style={{ width: "100%", justifyContent: "center", padding: "10px 18px" }}>
          Seguir
        </Button>
      </div>
    );
  }

  return (
    <TwoFactorChallenge
      purpose="login"
      methods={methods}
      emailMasked={emailMasked}
      submitLabel="Entrar"
      onDone={({ recoveryRemaining }) => {
        if (recoveryRemaining !== undefined && recoveryRemaining <= 3) setLowCodes(recoveryRemaining);
        else go();
      }}
    />
  );
}

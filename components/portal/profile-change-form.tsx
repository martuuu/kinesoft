"use client";

/**
 * ES4 S24d · forms de «Mis datos» del portal.
 *
 * ES4-D8: inline en la `Card` de la página, sin Drawer/Modal/Toast/Confirm (importan motion: prohibidos en superficies
 * públicas por C-F3 y el presupuesto de 125 kB del portal). El «abrir» y el segundo paso de confirmación son
 * `<details>`: andan sin JS y sin animación (`reducedMotion` no tiene nada que apagar).
 * Los dos forms usan `useFormState` con la action directa: sin JS hacen un POST normal y la página vuelve con el estado
 * (mismo criterio que `portal-email-form.tsx`, VX-Z FX-portal). Con error, los inputs arrancan de lo que se tipeó.
 */
import { useEffect, useRef } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { signOutPortalEverywhere, submitPortalProfileChange } from "@/lib/portal-profile";
import {
  PORTAL_PROFILE_FIELD_LABELS,
  type PortalProfileFormState,
  type PortalSignOutState,
} from "@/lib/portal-profile-types";

const summaryStyle: React.CSSProperties = {
  minHeight: 44,
  display: "flex",
  alignItems: "center",
  cursor: "pointer",
  fontSize: 14,
  fontWeight: 600,
  color: "var(--sky-700)",
};

const groupTitle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--navy-500)",
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  margin: "4px 0 0",
};

function Submit({ idle, busy, variant = "primary" }: { idle: string; busy: string; variant?: "primary" | "ghost" }) {
  const { pending } = useFormStatus();
  return (
    <Button
      variant={variant}
      size="md"
      block
      type="submit"
      aria-disabled={pending || undefined}
      onClick={(e) => {
        // `aria-disabled` y no `disabled` (como PortalLinkSubmit): el foco no salta y el doble clic no manda dos POST.
        if (pending) e.preventDefault();
      }}
    >
      {pending ? busy : idle}
    </Button>
  );
}

/** «Pedir un cambio de datos» para UN consultorio. Los campos vacíos no se piden. */
export function ProfileChangeForm({ slug, tenantName }: { slug: string; tenantName: string }) {
  const [state, formAction] = useFormState<PortalProfileFormState, FormData>(submitPortalProfileChange, null);
  const sentRef = useRef<HTMLParagraphElement>(null);
  const sent = state?.status === "sent" ? state : null;
  const failed = state?.status === "error" ? state : null;
  const v = failed?.values ?? {};
  const fe = (k: string) => failed?.fieldErrors?.[k]?.[0];
  const id = (k: string) => `profile-${slug}-${k}`;

  useEffect(() => {
    if (sent) sentRef.current?.focus();
  }, [sent]);

  return (
    // Abierto también después de enviar: si se cerraba, el «Listo» quedaba adentro de un `<details>` cerrado.
    <details open={!!failed || !!sent || undefined}>
      <summary style={summaryStyle}>Pedir un cambio de datos</summary>
      {sent && (
        <p ref={sentRef} tabIndex={-1} role="status" style={{ fontSize: 14, margin: "4px 0 10px", lineHeight: 1.5 }}>
          Listo: le mandamos tu pedido a {tenantName} (
          {sent.fields.map((f) => PORTAL_PROFILE_FIELD_LABELS[f] ?? f).join(", ")}). Lo vas a ver actualizado cuando lo
          aprueben.
        </p>
      )}
      <form
        // Remontar después de un envío exitoso deja el form vacío; con error conserva lo tipeado.
        key={sent ? `sent-${sent.at}` : "form"}
        action={formAction}
        noValidate
        style={{ display: "grid", gap: 10, marginTop: 6 }}
      >
        <input type="hidden" name="slug" value={slug} />
        <p style={{ fontSize: 13, color: "var(--navy-500)", margin: 0, lineHeight: 1.5 }}>
          Completá solo lo que quieras cambiar. El consultorio lo revisa antes de actualizar tu ficha.
        </p>

        <h3 style={groupTitle}>Contacto</h3>
        <Field id={id("phone")} label="Teléfono nuevo" optional error={fe("phone")}>
          <input className="k-input" name="phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={30} defaultValue={v.phone} />
        </Field>
        <Field id={id("email")} label="Email nuevo" optional error={fe("email")}>
          <input className="k-input" name="email" type="email" inputMode="email" autoComplete="email" maxLength={120} defaultValue={v.email} />
        </Field>

        <h3 style={groupTitle}>Contacto de emergencia</h3>
        <Field id={id("ecName")} label="Nombre y apellido" optional>
          <input className="k-input" name="ecName" autoComplete="off" maxLength={80} defaultValue={v.ecName} />
        </Field>
        <Field id={id("ecRelation")} label="Vínculo" hint="Por ejemplo: madre, pareja, amigo." optional>
          <input className="k-input" name="ecRelation" autoComplete="off" maxLength={40} defaultValue={v.ecRelation} />
        </Field>
        <Field id={id("ecPhone")} label="Teléfono" optional error={fe("emergencyContact")}>
          <input className="k-input" name="ecPhone" type="tel" inputMode="tel" autoComplete="off" maxLength={30} defaultValue={v.ecPhone} />
        </Field>

        <h3 style={groupTitle}>Obra social o prepaga</h3>
        <Field id={id("insurerName")} label="Obra social o prepaga" optional error={fe("coverage")}>
          <input className="k-input" name="insurerName" autoComplete="off" maxLength={80} defaultValue={v.insurerName} />
        </Field>
        <Field id={id("planName")} label="Plan" optional>
          <input className="k-input" name="planName" autoComplete="off" maxLength={80} defaultValue={v.planName} />
        </Field>
        <Field id={id("memberId")} label="Número de afiliado" optional>
          <input className="k-input" name="memberId" autoComplete="off" maxLength={40} defaultValue={v.memberId} />
        </Field>

        {failed && (
          <div role="alert" className="k-alert">
            {failed.error}
          </div>
        )}
        <Submit idle="Enviar pedido" busy="Enviando…" />
      </form>
    </details>
  );
}

/**
 * «Cerrar sesión en todos lados». Segundo paso inline (ES4-D8): el `<details>` explica qué pasa y recién ahí está el
 * botón que confirma. Si GoTrue falla, el error se muestra y la sesión sigue como estaba.
 */
export function SignOutEverywhereForm() {
  const [state, formAction] = useFormState<PortalSignOutState, FormData>(signOutPortalEverywhere, null);
  return (
    <details open={state?.status === "error" || undefined}>
      <summary style={{ ...summaryStyle, justifyContent: "center" }}>Cerrar sesión en todos lados</summary>
      <form action={formAction} style={{ display: "grid", gap: 10, marginTop: 6 }}>
        <p style={{ fontSize: 13, color: "var(--navy-500)", margin: 0, lineHeight: 1.5 }}>
          Se cierra tu sesión en este y en todos los dispositivos donde entraste (celular, otra computadora). Para volver
          a entrar vas a tener que pedir un link nuevo o entrar con Google.
        </p>
        {state?.status === "error" && (
          <div role="alert" className="k-alert">
            {state.error}
          </div>
        )}
        <Submit idle="Sí, cerrar en todos lados" busy="Cerrando…" variant="ghost" />
      </form>
    </details>
  );
}

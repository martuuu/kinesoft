import { supportEmail, supportMailto, SUPPORT_FALLBACK_TEXT } from "@/lib/support-contact";

/**
 * [BO-Z B4] «escribinos a <soporte@…>» con `mailto:`, o «escribile al equipo de KineSoft» sin link si
 * `NEXT_PUBLIC_SUPPORT_EMAIL` no está (porqué en lib/support-contact.ts). Es un fragmento de oración: el que lo usa
 * pone lo de antes y lo de después («…: <SupportContact /> para elegir un plan.»).
 *
 * Sin "use client" ni hooks: sirve en server components (pantallas de bloqueo) y en client components. `email` se
 * puede pasar para el render test; si no, sale de la variable pública.
 */
export function SupportContact({
  capital = false,
  subject,
  email = supportEmail(),
}: {
  /** Inicio de oración: «Escribinos…» / «Escribile…». */
  capital?: boolean;
  subject?: string;
  email?: string | null;
}) {
  const href = supportMailto(email, subject);
  if (!href || !email) {
    const s = SUPPORT_FALLBACK_TEXT;
    return <>{capital ? s.charAt(0).toUpperCase() + s.slice(1) : s}</>;
  }
  return (
    <>
      {capital ? "Escribinos a " : "escribinos a "}
      <a
        href={href}
        data-support-mailto
        style={{ color: "inherit", fontWeight: 700, textDecoration: "underline", overflowWrap: "anywhere" }}
      >
        {email}
      </a>
    </>
  );
}

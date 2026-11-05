"use client";

/**
 * CF3 (D-CF3-5): la parte interactiva del bloque de cobertura del resumen, para un paciente que declaró obra social.
 * Con el opt-in del profesional (`checkout.insured.contactAvailable`) ofrece «Consultar por WhatsApp con {Nombre}»;
 * el número NO viene en el HTML: lo trae `getInsuredContact` (rate limit 20 / 10 min por IP) recién al tocar el botón,
 * no al render, para que la página no sirva de cosecha de números. Sin opt-in, o si la action responde `none` /
 * `rate_limited`, cae a «Consultá tu cobertura con el consultorio» con el teléfono público del consultorio.
 *
 * CF3 ZF3: el texto del bloque lo pinta el wizard (afuera de este chunk diferido, para que esté en el SSR). Cuando la
 * action dice que no, `onFallback` le avisa y el wizard cambia ese texto (`insuredCoverageTextAfterContact`); esta
 * vista ya no suma su propio «Consultá tu cobertura con el consultorio» debajo (eran dos textos contradictorios).
 *
 * Diferido (`next/dynamic` desde el wizard): solo aparece con obra social declarada y el turnero tiene el first load
 * contado (≈115 de 135 kB); así el ícono y la llamada a la action no entran al first load.
 */
import { useState } from "react";
import { getInsuredContact } from "@/lib/public-booking";
import type { PublicInsuredContact } from "@/lib/public-booking-types";
import { insuredCoverageTextAfterContact } from "@/lib/public-wizard-state";
import { WhatsAppIcon as ChatIcon } from "@/components/ui/brand-icons"; // claim-ok: lib/public-booking.ts:671
import s from "../public-booking.module.css";

export type InsuredContactState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; name: string; waUrl: string; telUrl: string }
  | { kind: "fallback" };

/** Respuesta de la action → estado. Cualquier «no» (`none`, `rate_limited`) es el mismo fallback: no dice cuál. */
export function insuredStateFrom(r: PublicInsuredContact): InsuredContactState {
  return r.ok ? { kind: "ok", name: r.name, waUrl: r.waUrl, telUrl: r.telUrl } : { kind: "fallback" };
}

/**
 * CF3 ZF3: el «tocar el botón» sin React, para testearlo sin DOM. Cualquier «no» (o la action que tira) termina en
 * `fallback` y avisa con `onFallback`; `ok` intenta abrir el chat directo.
 */
export async function askInsuredContact(args: {
  slug: string;
  practitionerId: string;
  fetchContact: (slug: string, practitionerId: string) => Promise<PublicInsuredContact>;
  setState: (state: InsuredContactState) => void;
  onFallback?: () => void;
  openChat?: (url: string) => void;
}): Promise<InsuredContactState> {
  args.setState({ kind: "loading" });
  let next: InsuredContactState;
  try {
    next = insuredStateFrom(await args.fetchContact(args.slug, args.practitionerId));
  } catch {
    next = { kind: "fallback" };
  }
  args.setState(next);
  if (next.kind === "fallback") args.onFallback?.();
  // Se intenta abrir el chat directo; si el navegador bloquea la ventana (en iOS, después de un `await`), quedan los
  // links «Abrir WhatsApp» / «Llamar» que pinta el estado `ok`.
  else if (next.kind === "ok") args.openChat?.(next.waUrl);
  return next;
}

/** `tel:` del teléfono público del consultorio (texto libre de Configuración): solo dígitos y un `+` inicial. */
function clinicTelHref(phone: string | null): string | null {
  const t = phone?.trim() ?? "";
  const digits = t.replace(/\D/g, "");
  if (digits.length < 6) return null;
  return `tel:${t.startsWith("+") ? "+" : ""}${digits}`;
}

/** Vista pura (testeable con render estático): el wizard le pasa el estado y el handler. */
export function InsuredContactView({
  state,
  text,
  contactAvailable,
  practitionerName,
  clinicPhone,
  onAsk,
}: {
  state: InsuredContactState;
  /**
   * CF3 ZF2: el texto del bloque (`checkout.insured.text`). Con él, la vista lo pinta y lo reemplaza cuando la action
   * falla (`insuredCoverageTextAfterContact`): antes el wizard lo pintaba afuera y, en el fallback, quedaban los dos
   * («Consultá con {Nombre}…» + «Consultá tu cobertura con el consultorio»). Sin él, el comportamiento viejo.
   */
  text?: string;
  contactAvailable: boolean;
  practitionerName: string | null;
  clinicPhone: string | null;
  onAsk: () => void;
}) {
  const failed = state.kind === "fallback";
  const lead =
    text === undefined ? null : (
      <p className={s.insuredText}>
        {contactAvailable && failed ? insuredCoverageTextAfterContact(practitionerName, contactAvailable, true) : text}
      </p>
    );
  // El contacto del profesional existe solo con su opt-in y lo arma el server (`getInsuredContact`, D-CF3-5).
  const openLabel = state.kind === "ok" ? `Abrir WhatsApp con ${state.name}` : ""; // claim-ok: lib/public-booking.ts:671
  const askLabel = `Consultar por WhatsApp con ${practitionerName ?? ""}`; // claim-ok: lib/public-booking.ts:671
  if (contactAvailable && practitionerName && state.kind === "ok") {
    return (
      <>
        {lead}
        <div className={s.insuredActions}>
          <a className={s.insuredButton} href={state.waUrl} target="_blank" rel="noopener noreferrer">
            <ChatIcon size={18} /> {openLabel}
          </a>
          <a className="k-link" href={state.telUrl}>
            Llamar a {state.name}
          </a>
        </div>
      </>
    );
  }
  if (contactAvailable && practitionerName && state.kind !== "fallback") {
    return (
      <>
        {lead}
        <div className={s.insuredActions}>
          <button type="button" className={s.insuredButton} onClick={onAsk} disabled={state.kind === "loading"} aria-busy={state.kind === "loading"}>
            <ChatIcon size={18} /> {askLabel}
          </button>
        </div>
      </>
    );
  }
  const tel = clinicTelHref(clinicPhone);
  return (
    <>
      {lead}
      <div className={s.insuredActions}>
        {/* Sin `text`, el texto lo pinta el wizard y lo cambia con `onFallback` (CF3 ZF3): acá no se repite. Con `text`,
            `lead` ya lo reemplazó. */}
        {tel && (
          <a className="k-link" href={tel}>
            Llamar al consultorio: {clinicPhone}
          </a>
        )}
      </div>
    </>
  );
}

export function InsuredContact({
  slug,
  practitionerId,
  text,
  contactAvailable,
  practitionerName,
  clinicPhone,
  onFallback,
}: {
  slug: string;
  text?: string;
  /** CF3 ZF3: la action respondió que no (`none` / `rate_limited` / error): el wizard cambia su texto. */
  onFallback?: () => void;
  practitionerId: string | null;
  contactAvailable: boolean;
  practitionerName: string | null;
  clinicPhone: string | null;
}) {
  // Un estado por profesional: cambiar de profesional en el wizard no reusa el contacto del anterior.
  const [byPro, setByPro] = useState<{ pid: string | null; state: InsuredContactState }>({ pid: practitionerId, state: { kind: "idle" } });
  const state = byPro.pid === practitionerId ? byPro.state : { kind: "idle" as const };

  const ask = async () => {
    if (!practitionerId) return;
    const pid = practitionerId;
    await askInsuredContact({
      slug,
      practitionerId: pid,
      fetchContact: getInsuredContact,
      setState: (state) => setByPro({ pid, state }),
      onFallback,
      openChat: (url) => window.open(url, "_blank", "noopener,noreferrer"),
    });
  };

  return (
    <InsuredContactView
      state={state}
      text={text}
      contactAvailable={contactAvailable}
      practitionerName={practitionerName}
      clinicPhone={clinicPhone}
      onAsk={() => void ask()}
    />
  );
}

"use client";

/**
 * CF3 (D-CF3-8, sesión SH-U) · panel del menú del teléfono del perfil y «Compartir» por fila de Turnos. DIFERIDO: el
 * hero pinta solo el botón (`PatientPhoneAction`, `profile/hero.tsx`) y este módulo baja con `import()` al primer
 * click (o al pasar el mouse / enfocar el botón). `/pacientes/[id]` tiene techo de 180 kB y estaba en ≈169,5: el
 * panel, la lectura y el `PaymentLinkDrawer` no van al first load (lo fija `cf3-contact-actions-guard.test.ts`).
 *
 * Datos: `getPatientShareBundle` (SH-S) al abrir, cada vez (los próximos turnos cambian mientras la ficha está
 * abierta; son 3 sentencias). Es la barrera de acceso: `full`/`admin` ven contacto y turnos, el resto `hidden`. Lo
 * que se pinta y los textos salen de `contact-actions-logic.ts` (puro, sin nada clínico).
 *
 * Por qué los ítems se pintan recién con el bundle cargado: «Abrir chat», «Llamar» y «Copiar» corren SINCRÓNICOS
 * dentro del click. Una ventana abierta después de un `await` la bloquea el navegador, y Safari rechaza el
 * portapapeles fuera del gesto.
 *
 * Teclado (patrón WAI-ARIA «menu button», el de `FichaMenu`): foco al primer ítem cuando aparecen; ↑/↓ en ronda,
 * Inicio/Fin; Esc cierra y devuelve el foco al botón; Tab cierra. Click afuera cierra.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { getPatientShareBundle } from "@/lib/booking-share-actions";
import type { PatientShareBundle } from "@/lib/patient-share-types";
import { useToast } from "@/components/ui/toast";
import { menuKeyStep } from "@/components/fichas/ficha-menu";
import {
  CONTACT_MENU_COPY as C,
  contactMenuModel,
  paymentLinkTargets,
  rowReminder,
  type ContactMenuItem,
  type ContactPaymentLinkInput,
  type ContactMenuModel,
  type RowShareBooking,
} from "./contact-actions-logic";
import styles from "./contact-actions.module.css";

// El MISMO `import()` que Facturación y la sección de plata del drawer: webpack reusa su chunk (no suma uno nuevo).
const PaymentLinkDrawer = dynamic(
  () => import("@/components/payments/payment-link-drawer").then((m) => m.PaymentLinkDrawer),
  { ssr: false }
);

// ── Lectura (con caché corta para las filas de Turnos) ─────────────────────────────────────────────────────────────

/**
 * Las filas de Turnos piden el bundle al abrir su menú; varias filas del mismo paciente seguidas no lo vuelven a pedir
 * (30 s). El menú del teléfono no usa la caché: lee siempre al abrir. Un error (sesión vencida, red) → `hidden`, como
 * el drawer del turno: el recordatorio sale igual, sin destinatario.
 */
const ROW_CACHE_MS = 30_000;
const rowCache = new Map<string, { at: number; value: Promise<PatientShareBundle> }>();
const HIDDEN: PatientShareBundle = { contact: { status: "hidden" } };

function readBundle(patientId: string): Promise<PatientShareBundle> {
  return getPatientShareBundle(patientId).catch((e) => {
    console.error("getPatientShareBundle failed", e);
    return HIDDEN;
  });
}

export function loadRowShareBundle(patientId: string, now = Date.now()): Promise<PatientShareBundle> {
  const hit = rowCache.get(patientId);
  if (hit && now - hit.at < ROW_CACHE_MS) return hit.value;
  const value = readBundle(patientId);
  rowCache.set(patientId, { at: now, value });
  return value;
}

/** Recordatorio de una fila con el bundle ya cargado (puro; la fila lo usa dentro del click, sin `await`). */
export function rowShareFor(bundle: PatientShareBundle | null, b: RowShareBooking, firstName: string) {
  return rowReminder(bundle, b, firstName);
}

// ── Vista (presentacional; la prueba el render test) ───────────────────────────────────────────────────────────────

export type ContactMenuState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; model: ContactMenuModel };

export function ContactMenuView({
  id,
  state,
  onItem,
  onCopy,
  onClose,
  triggerRef,
}: {
  id: string;
  state: ContactMenuState;
  onItem: (it: ContactMenuItem) => void;
  onCopy: (it: ContactMenuItem) => void;
  onClose: (restoreFocus: boolean) => void;
  triggerRef?: { readonly current: HTMLElement | null };
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const ready = state.status === "ready";

  useEffect(() => {
    if (ready) panelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [ready]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef?.current?.contains(t)) return;
      onClose(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose, triggerRef]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const step = menuKeyStep(e.key, all.indexOf(document.activeElement as HTMLButtonElement), all.length);
    if (step === "close") {
      e.preventDefault();
      onClose(true);
    } else if (step === "tab") {
      onClose(false);
    } else if (typeof step === "number") {
      e.preventDefault();
      all[step]?.focus();
    }
  };

  return (
    <div
      ref={panelRef}
      id={id}
      role="menu"
      aria-label={C.menuLabel}
      aria-busy={state.status === "loading" || undefined}
      className={`k-glass-strong ${styles.panel}`}
      onKeyDown={onKeyDown}
      data-testid="contact-menu"
    >
      {state.status === "loading" && (
        <div role="none" className={styles.status}>
          {C.loading}
        </div>
      )}
      {state.status === "error" && (
        <div role="none" className={styles.status}>
          {C.loadError}
        </div>
      )}
      {ready && state.model.notice && (
        <div role="none" className={styles.notice}>
          <strong>{state.model.notice.title}</strong>
          <span>{state.model.notice.detail}</span>
        </div>
      )}
      {ready &&
        state.model.items.map((it) => (
          <div key={it.id} role="none" className={`${styles.row} ${it.separatorBefore ? styles.sep : ""}`}>
            <button type="button" role="menuitem" tabIndex={-1} data-item={it.id} className={styles.item} onClick={() => onItem(it)}>
              {it.label}
            </button>
            {/* El «Copiar» del mensaje (no de «Copiar número», que ya copia). */}
            {it.href && it.copyText && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                data-item={`${it.id}-copy`}
                aria-label={`${C.copy}: ${it.label.replace(/^Mandar /, "")}`}
                className={styles.copy}
                onClick={() => onCopy(it)}
              >
                {C.copy}
              </button>
            )}
          </div>
        ))}
    </div>
  );
}

// ── Panel con estado (lo monta el botón del teléfono) ──────────────────────────────────────────────────────────────

export type ContactActionsPanelProps = {
  open: boolean;
  onClose: (restoreFocus: boolean) => void;
  menuId: string;
  triggerRef: { readonly current: HTMLElement | null };
  patientId: string;
  /** Solo para el `PaymentLinkDrawer` (staff): nunca viaja al link ni a un mensaje. */
  patientName: string;
  displayedPhone: string | null;
  /** Para el link sin turno: profesionales candidatos y el permiso del miembro. null = sin link de pago. */
  paymentLink: ContactPaymentLinkInput | null;
  /** El flujo de «Enviar al portal» del hero completo; ausente en el modo admin. */
  onPortalInvite?: () => void;
  portalLinked?: boolean;
};

export function ContactActionsPanel(p: ContactActionsPanelProps) {
  const toast = useToast();
  const [state, setState] = useState<ContactMenuState>({ status: "loading" });
  const [drawerKey, setDrawerKey] = useState<number | null>(null);
  const targets = p.paymentLink ? paymentLinkTargets(p.paymentLink) : { options: [], defaultId: null };
  const opts = {
    displayedPhone: p.displayedPhone,
    paymentLinkAvailable: targets.options.length > 0,
    portalInviteAvailable: !!p.onPortalInvite,
    portalLinked: p.portalLinked,
  };
  const optsKey = JSON.stringify(opts);

  useEffect(() => {
    if (!p.open) return;
    let alive = true;
    setState({ status: "loading" });
    getPatientShareBundle(p.patientId)
      .then((b) => alive && setState({ status: "ready", model: contactMenuModel(b, JSON.parse(optsKey)) }))
      .catch((e) => {
        console.error("getPatientShareBundle failed", e);
        if (alive) setState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, [p.open, p.patientId, optsKey]);

  const copy = (text: string, what: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(what))
      .catch(() => toast.error(C.copyFailed, { description: C.copyFailedDetail }));
  };

  const onItem = (it: ContactMenuItem) => {
    p.onClose(true);
    if (it.id === "paymentLink") return setDrawerKey(Date.now());
    if (it.id === "portalInvite") return p.onPortalInvite?.();
    if (it.href?.startsWith("tel:")) {
      window.location.href = it.href;
      return;
    }
    if (it.href) {
      window.open(it.href, "_blank", "noopener");
      return;
    }
    if (it.copyText) copy(it.copyText, it.id === "copyPhone" ? "Número copiado" : "Mensaje copiado");
  };

  return (
    <>
      {p.open && (
        <ContactMenuView
          id={p.menuId}
          state={state}
          onItem={onItem}
          onCopy={(it) => {
            p.onClose(true);
            if (it.copyText) copy(it.copyText, "Mensaje copiado");
          }}
          onClose={p.onClose}
          triggerRef={p.triggerRef}
        />
      )}
      {/* Portal a `body`: el botón vive dentro del Card glass del hero y su `backdrop-filter` atrapa el
          `position: fixed` del Drawer (mismo motivo por el que el hero monta sus modales fuera del Card). */}
      {drawerKey != null &&
        typeof document !== "undefined" &&
        createPortal(
          <PaymentLinkDrawer
            key={drawerKey}
            open
            onClose={() => setDrawerKey(null)}
            surface="facturacion"
            patient={{ id: p.patientId, name: p.patientName }}
            booking={null}
            practitioners={targets.options}
            defaultPractitionerId={targets.defaultId}
          />,
          document.body
        )}
    </>
  );
}

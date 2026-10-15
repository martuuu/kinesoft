"use client";

/**
 * [BO3-B] Pestaña «Ciclo de vida» del detalle de un consultorio (plan §19.5 fila BO3-B; server de BO2-D en
 * `lib/platform-tenant-lifecycle.ts`):
 *   - suspender (ACTIVE → SUSPENDED) y dar de baja (ACTIVE|SUSPENDED → CLOSED) con motivo (código + nota corta, sin
 *     PHI) y **confirmación tipeada del slug**; reactivar (SUSPENDED|CLOSED → ACTIVE) con `useConfirm`;
 *   - cambiar el slug, también con el slug actual tipeado y la explicación del redirect (BO-D9);
 *   - forzar el fin del alta;
 *   - pedirle el export al titular (BO5-C): Plataforma solo PIDE, el superadmin nunca baja PHI (plan §19.5).
 *
 * BO4: todas las llamadas pasan por `usePlatformAction()`; suspender, dar de baja, cambiar el slug y pedir el export
 * son riesgo high y, con MFA en enforce, pueden pedir el código otra vez (modal del provider de `(platform)`).
 *
 * Por qué tipear el slug: suspender o dar de baja deja afuera a todo un equipo con pacientes del día, y cambiar el
 * slug rompe los links que circulan (aunque redirijan). Un clic equivocado en la pestaña de otro consultorio no
 * puede bastar; escribir el slug obliga a mirar CUÁL es.
 *
 * Todas mandan la versión que se vio (`expectedUpdatedAt`): si otro superadmin o el OWNER cambiaron algo en el
 * medio, la action devuelve «Otro cambio se guardó antes» y el `router.refresh()` trae la foto nueva.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import {
  changePlatformTenantSlug,
  closePlatformTenant,
  forcePlatformTenantOnboardingComplete,
  reactivatePlatformTenant,
  suspendPlatformTenant,
} from "@/lib/platform-tenant-lifecycle";
import { requestTenantExport } from "@/lib/platform-export-request";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import {
  STATUS_REASON_CODES,
  STATUS_REASON_NOTE_MAX,
  type StatusReasonCode,
} from "@/lib/platform-tenants-schemas";
import type { PlatformTenantDetail } from "@/lib/platform-tenants-types";
import type { ActionResult } from "@/lib/validation";
import { formatDateAR } from "@/lib/format";
import {
  STATUS_REASON_LABEL,
  TENANT_STATUS_LABEL,
  statusReasonText,
  typedSlugMatches,
} from "@/components/plataforma/tenants/labels";
import { ErrorBox, Facts, Section, WarnBox, muted } from "@/components/plataforma/tenants/detail-ui";

type StatusKind = "suspend" | "close";

export type StatusChangeState = { reasonCode: StatusReasonCode | ""; note: string; typedSlug: string };
export const emptyStatusChange = (): StatusChangeState => ({ reasonCode: "", note: "", typedSlug: "" });

const STATUS_COPY: Record<StatusKind, { title: string; button: string; pending: string; effect: string }> = {
  suspend: {
    title: "Suspender el consultorio",
    button: "Suspender",
    pending: "Suspendiendo…",
    effect:
      "Nadie del equipo va a poder entrar (ven la pantalla de consultorio suspendido) y los turnos online y el check-in se cierran. No se borra nada y se puede reactivar.",
  },
  close: {
    title: "Dar de baja el consultorio",
    button: "Dar de baja",
    pending: "Dando de baja…",
    effect:
      "Es la baja definitiva del servicio: nadie del equipo entra y los turnos online se cierran. No se borra nada (la historia clínica se conserva por ley) y, si hiciera falta, se puede reactivar.",
  },
};

/** El submit se habilita con motivo elegido y el slug tipeado tal cual. */
export function canSubmitStatusChange(s: StatusChangeState, slug: string): boolean {
  return s.reasonCode !== "" && typedSlugMatches(s.typedSlug, slug) && s.note.length <= STATUS_REASON_NOTE_MAX;
}

const reasonOptions = [
  { value: "", label: "Elegí un motivo" },
  ...STATUS_REASON_CODES.map((c) => ({ value: c, label: STATUS_REASON_LABEL[c] })),
];

function TypedSlugField({
  slug,
  value,
  onChange,
  disabled,
}: {
  slug: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const ok = typedSlugMatches(value, slug);
  return (
    <FormField
      label={`Para confirmar, escribí el slug actual: ${slug}`}
      value={value}
      onChange={onChange}
      placeholder={slug}
      hint={value && !ok ? "No coincide con el slug del consultorio." : undefined}
      disabled={disabled}
    />
  );
}

export function StatusChangeForm({
  kind,
  slug,
  state,
  pending,
  error,
  fieldErrors,
  onChange,
  onSubmit,
  onCancel,
}: {
  kind: StatusKind;
  slug: string;
  state: StatusChangeState;
  pending: boolean;
  error: string | null;
  fieldErrors: Record<string, string[]>;
  onChange: <K extends keyof StatusChangeState>(k: K, v: StatusChangeState[K]) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const copy = STATUS_COPY[kind];
  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 14 }}>
      <WarnBox>{copy.effect}</WarnBox>
      <FormField
        as="select"
        label="Motivo"
        required
        value={state.reasonCode}
        options={reasonOptions}
        onChange={(v) => onChange("reasonCode", v as StatusReasonCode | "")}
        error={fieldErrors.reasonCode?.[0]}
        disabled={pending}
      />
      <FormField
        label="Nota (opcional)"
        value={state.note}
        onChange={(v) => onChange("note", v.replace(/[\r\n]+/g, " "))}
        hint={`Para el próximo superadmin que mire el consultorio. Una línea, sin datos de pacientes. ${state.note.length}/${STATUS_REASON_NOTE_MAX}`}
        error={fieldErrors.note?.[0]}
        disabled={pending}
      />
      <TypedSlugField slug={slug} value={state.typedSlug} onChange={(v) => onChange("typedSlug", v)} disabled={pending} />
      {error && <ErrorBox>{error}</ErrorBox>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={pending || !canSubmitStatusChange(state, slug)}>
          {pending ? copy.pending : copy.button}
        </Button>
      </div>
    </form>
  );
}

export type SlugChangeState = { newSlug: string; typedSlug: string };

export function canSubmitSlugChange(s: SlugChangeState, slug: string): boolean {
  const next = s.newSlug.trim().toLowerCase();
  return next !== "" && next !== slug && typedSlugMatches(s.typedSlug, slug);
}

export function SlugChangeForm({
  slug,
  state,
  pending,
  error,
  fieldErrors,
  onChange,
  onSubmit,
  onCancel,
}: {
  slug: string;
  state: SlugChangeState;
  pending: boolean;
  error: string | null;
  fieldErrors: Record<string, string[]>;
  onChange: <K extends keyof SlugChangeState>(k: K, v: SlugChangeState[K]) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const next = state.newSlug.trim().toLowerCase();
  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 14 }}>
      <WarnBox>
        La dirección de los turnos online pasa a <span style={{ fontFamily: "var(--font-mono)" }}>/c/{next || "…"}/booking</span>.
        La vieja (<span style={{ fontFamily: "var(--font-mono)" }}>/c/{slug}/booking</span>) sigue funcionando y redirige a la
        nueva para siempre, y ese slug no lo puede usar otro consultorio.
      </WarnBox>
      <FormField
        label="Slug nuevo"
        required
        value={state.newSlug}
        onChange={(v) => onChange("newSlug", v)}
        hint="De 3 a 40 letras minúsculas, números o guiones."
        error={fieldErrors.slug?.[0]}
        disabled={pending}
      />
      <TypedSlugField slug={slug} value={state.typedSlug} onChange={(v) => onChange("typedSlug", v)} disabled={pending} />
      {error && <ErrorBox>{error}</ErrorBox>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={pending || !canSubmitSlugChange(state, slug)}>
          {pending ? "Cambiando…" : "Cambiar el slug"}
        </Button>
      </div>
    </form>
  );
}

type Dialog = { kind: "status"; which: StatusKind } | { kind: "slug" } | null;

export function TenantLifecyclePanel({ detail: d }: { detail: PlatformTenantDetail }) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const runPlatform = usePlatformAction();

  const [version, setVersion] = useState(d.updatedAt);
  useEffect(() => setVersion(d.updatedAt), [d.updatedAt]);

  const [dialog, setDialog] = useState<Dialog>(null);
  const [statusState, setStatusState] = useState<StatusChangeState>(emptyStatusChange);
  const [slugState, setSlugState] = useState<SlugChangeState>({ newSlug: "", typedSlug: "" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const openDialog = (next: Exclude<Dialog, null>) => {
    setStatusState(emptyStatusChange());
    setSlugState({ newSlug: "", typedSlug: "" });
    setError(null);
    setFieldErrors({});
    setDialog(next);
  };
  const closeDialog = () => {
    if (!pending) setDialog(null);
  };

  /** Corre una action del ciclo de vida. true = salió bien. */
  const run = async (
    call: () => Promise<ActionResult<{ updatedAt: string }>>,
    success: string,
    inDialog: boolean
  ): Promise<boolean> => {
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      // El fallo de `runPlatform` ({ ok:false, error }) es un ActionResult sin fieldErrors: entra en la misma rama.
      const res: ActionResult<{ updatedAt: string }> = await runPlatform(call);
      if (!res.ok) {
        if (inDialog) {
          setError(res.error);
          setFieldErrors(res.fieldErrors ?? {});
        } else {
          toast.error(res.error);
        }
        router.refresh();
        return false;
      }
      setVersion(res.data.updatedAt);
      toast.success(success);
      router.refresh();
      return true;
    } catch {
      const msg = "No se pudo guardar el cambio. Revisá la conexión y probá de nuevo.";
      if (inDialog) setError(msg);
      else toast.error(msg);
      return false;
    } finally {
      setPending(false);
    }
  };

  const submitStatus = async (e: FormEvent<HTMLFormElement>, which: StatusKind) => {
    e.preventDefault();
    if (pending || !canSubmitStatusChange(statusState, d.slug) || statusState.reasonCode === "") return;
    const input = {
      tenantId: d.id,
      expectedUpdatedAt: version,
      reasonCode: statusState.reasonCode,
      ...(statusState.note.trim() ? { note: statusState.note.trim() } : {}),
    };
    const ok = await run(
      () => (which === "suspend" ? suspendPlatformTenant(input) : closePlatformTenant(input)),
      which === "suspend" ? "Consultorio suspendido" : "Consultorio dado de baja",
      true
    );
    if (ok) setDialog(null);
  };

  const submitSlug = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending || !canSubmitSlugChange(slugState, d.slug)) return;
    const ok = await run(
      () =>
        changePlatformTenantSlug({ tenantId: d.id, expectedUpdatedAt: version, slug: slugState.newSlug.trim().toLowerCase() }),
      "Slug cambiado. El viejo redirige al nuevo.",
      true
    );
    if (ok) setDialog(null);
  };

  const reactivate = async () => {
    const ok = await confirm({
      title: `¿Reactivar ${d.name}?`,
      message:
        "El equipo vuelve a entrar y los turnos online se abren si estaban prendidos. El motivo de la suspensión o baja se limpia (queda en Actividad).",
      confirmLabel: "Reactivar",
      cancelLabel: "Dejar como está",
    });
    if (!ok) return;
    await run(() => reactivatePlatformTenant({ tenantId: d.id, expectedUpdatedAt: version }), "Consultorio reactivado", false);
  };

  const forceOnboarding = async () => {
    const ok = await confirm({
      title: "¿Dar el alta por terminada?",
      message:
        "El titular deja de ver los pasos de bienvenida y entra directo al panel. Lo que no haya cargado (sede, horarios, servicios) lo completa después desde Configuración.",
      confirmLabel: "Darla por terminada",
      cancelLabel: "Cancelar",
    });
    if (!ok) return;
    await run(
      () => forcePlatformTenantOnboardingComplete({ tenantId: d.id, expectedUpdatedAt: version }),
      "Alta marcada como terminada",
      false
    );
  };

  /** BO5-C: un mail a cada OWNER activo para que descargue él el export. Vale en cualquier estado (BO-D4). */
  const askExport = async () => {
    const ok = await confirm({
      title: `¿Pedirle el export al titular de ${d.name}?`,
      message: "Le mandamos un mail al titular para que descargue sus datos. Vos no recibís nada.",
      confirmLabel: "Mandar el pedido",
      cancelLabel: "Cancelar",
    });
    if (!ok) return;
    setPending(true);
    try {
      const r = await runPlatform(() => requestTenantExport({ tenantId: d.id }));
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const { sent, owners } = r.data;
      if (sent === owners) toast.success(owners === 1 ? "Le mandamos el pedido al titular" : `Les mandamos el pedido a los ${owners} titulares`);
      else toast.warning(`El mail salió a ${sent} de ${owners} titulares. Revisá el registro de mails.`);
    } catch {
      toast.error("No se pudo mandar el pedido. Revisá la conexión y probá de nuevo.");
    } finally {
      setPending(false);
    }
  };

  const reason = statusReasonText(d.statusReason);
  const which = dialog?.kind === "status" ? dialog.which : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Section
        title="Estado del consultorio"
        description="Suspender o dar de baja no borra nada. El titular de un consultorio suspendido puede exportar sus datos."
        action={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {d.status !== "ACTIVE" && (
              <Button type="button" variant="primary" onClick={() => void reactivate()} disabled={pending}>
                Reactivar
              </Button>
            )}
            {d.status === "ACTIVE" && (
              <Button type="button" variant="ghost" onClick={() => openDialog({ kind: "status", which: "suspend" })} disabled={pending}>
                Suspender
              </Button>
            )}
            {d.status !== "CLOSED" && (
              <Button type="button" variant="ghost" onClick={() => openDialog({ kind: "status", which: "close" })} disabled={pending}>
                Dar de baja
              </Button>
            )}
          </div>
        }
      >
        <Facts
          items={[
            ["Estado", TENANT_STATUS_LABEL[d.status]],
            ["Motivo", reason ?? muted("—")],
            ["Desde", d.statusChangedAt ? formatDateAR(d.statusChangedAt, "compact") : muted("Siempre estuvo activo")],
          ]}
        />
      </Section>

      <Section
        title="Slug"
        description="Es la parte de la dirección de los turnos online. Al cambiarlo, el viejo sigue redirigiendo al nuevo."
        action={
          <Button type="button" variant="ghost" onClick={() => openDialog({ kind: "slug" })} disabled={pending}>
            Cambiar el slug
          </Button>
        }
      >
        <Facts
          items={[
            ["Actual", <span key="s" style={{ fontFamily: "var(--font-mono)" }}>{d.slug}</span>],
            [
              "Anteriores",
              d.slugAliases.length ? (
                <span key="a" style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>
                  {d.slugAliases.join(", ")}
                </span>
              ) : (
                muted("Ninguno")
              ),
            ],
          ]}
        />
      </Section>

      <Section
        title="Alta"
        description="Si el titular quedó trabado en los pasos de bienvenida, se puede dar por terminada desde acá."
        action={
          !d.onboardingCompleted ? (
            <Button type="button" variant="ghost" onClick={() => void forceOnboarding()} disabled={pending}>
              Dar por terminada
            </Button>
          ) : undefined
        }
      >
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--navy-900)" }}>
          {d.onboardingCompleted ? "Terminada." : "Sin terminar."}
        </p>
      </Section>

      <Section
        title="Export de datos"
        description="Le pedimos al titular que descargue él todos los datos del consultorio. El equipo de KineSoft no los ve."
        action={
          <Button type="button" variant="ghost" onClick={() => void askExport()} disabled={pending}>
            Pedir export al titular
          </Button>
        }
      >
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--navy-900)" }}>
          Sale un mail a cada titular activo con el link a Configuración → Exportar datos (o al botón de la pantalla de
          suspendido).
        </p>
      </Section>

      <Modal
        open={dialog?.kind === "status"}
        onClose={closeDialog}
        title={which ? STATUS_COPY[which].title : undefined}
        lockBackdrop
      >
        {which && (
          <StatusChangeForm
            kind={which}
            slug={d.slug}
            state={statusState}
            pending={pending}
            error={error}
            fieldErrors={fieldErrors}
            onChange={(k, v) => setStatusState((s) => ({ ...s, [k]: v }))}
            onSubmit={(e) => void submitStatus(e, which)}
            onCancel={closeDialog}
          />
        )}
      </Modal>

      <Modal open={dialog?.kind === "slug"} onClose={closeDialog} title="Cambiar el slug" lockBackdrop>
        <SlugChangeForm
          slug={d.slug}
          state={slugState}
          pending={pending}
          error={error}
          fieldErrors={fieldErrors}
          onChange={(k, v) => setSlugState((s) => ({ ...s, [k]: v }))}
          onSubmit={(e) => void submitSlug(e)}
          onCancel={closeDialog}
        />
      </Modal>
    </div>
  );
}

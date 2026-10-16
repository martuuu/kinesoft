"use client";

/**
 * «Mi perfil público» (`/cuenta/perfil-publico`, DIR-3d; contratos C-DIR8/C-DIR9, decisiones DIR-D11/D20/D21).
 *
 * El perfil es POR PERSONA (Ley 25.326: el consentimiento es de quien aparece, no del consultorio) y cruza todos los
 * consultorios donde atiende. Lo escriben las actions de `lib/public-profile.ts` (DIR-2b), que sacan el `userId` de la
 * sesión: acá no viaja ningún id.
 *
 * Consentimiento:
 *  - la casilla muestra el texto LITERAL de `DIRECTORY_CONSENT_TEXT` y arranca SIEMPRE sin tildar (también al volver a
 *    publicar después de un retiro, o cuando cambió la versión del texto): una casilla pre-tildada no es un
 *    consentimiento expreso;
 *  - «Publicar» manda `consentAccepted: true` + `DIRECTORY_CONSENT_VERSION`; si la página quedó abierta con un texto
 *    viejo, el server rechaza la versión y la persona tiene que recargar y leer el nuevo;
 *  - «Dejar de publicar» es un click + `useConfirm` (nunca `window.confirm`): el retiro se ve en el próximo request
 *    del directorio (la action invalida el tag después del commit).
 *
 * «Verificada» (DIR-D10/D21): solo si Plataforma verificó la matrícula Y la persona no la cambió en el formulario
 * (al guardar otra matrícula, el trigger de M11 borra la verificación; la vista previa no promete lo que se va a perder).
 *
 * Sin `router.refresh()` (ratchet PF-0d): las actions hacen `revalidatePath` y el estado que importa (status, matrícula
 * guardada) se actualiza con lo que devuelven.
 */
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { FormField } from "@/components/ui/form-field";
import { useConfirm, type ConfirmOptions } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { publishPublicProfile, savePublicProfile, withdrawPublicProfile } from "@/lib/public-profile";
import type { MyPublicProfile } from "@/lib/public-profile-types";
import {
  DIRECTORY_CONSENT_TEXT,
  DIRECTORY_CONSENT_VERSION,
  HONORIFIC_OPTIONS,
  LICENSE_NUMBER_MAX,
  PUBLIC_BIO_MAX,
} from "@/lib/directory-constants";
import { checkConsent, parsePublicProfileFields, type FieldErrors, type PublicProfileStatus } from "@/lib/public-profile-logic";
import { AR_PROVINCES, provinceName } from "@/lib/ar-provinces";
import { honorificLabel, initials } from "@/lib/directory-logic";
import type { ActionResult } from "@/lib/validation";
import s from "./public-profile-form.module.css";

const AR_TZ = "America/Argentina/Buenos_Aires";
const NETWORK = "No se pudo completar. Revisá la conexión y probá de nuevo.";

/** Campos del formulario tal como se tipean (strings; `""` = vacío). La normalización es de `parsePublicProfileFields`. */
export type PublicProfileFormFields = {
  publicName: string;
  honorific: string;
  licenseKind: string;
  licenseNumber: string;
  licenseJurisdiction: string;
  bio: string;
};

type StatusResult = ActionResult<{ status: PublicProfileStatus }>;
type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

/** Valida en el cliente con la MISMA lógica pura que el server (copy por campo) antes de gastar un viaje. */
function clientCheck(fields: PublicProfileFormFields): { ok: true } | { ok: false; error: string; fieldErrors: FieldErrors } {
  const parsed = parsePublicProfileFields(fields);
  return parsed.ok ? { ok: true } : parsed;
}

/**
 * «Publicar»: sin la casilla tildada (o con un campo inválido) NO llama a la action. Con la casilla, manda la versión
 * vigente del texto. Exportada para el test (sin jsdom no hay click); la action es la red, no se mockea esto.
 */
export async function publishWithConsent(fields: PublicProfileFormFields, accepted: boolean): Promise<StatusResult> {
  const consent = checkConsent({ accepted, version: DIRECTORY_CONSENT_VERSION });
  if (!consent.ok) return consent;
  const check = clientCheck(fields);
  if (!check.ok) return check;
  return publishPublicProfile({ ...fields, consentAccepted: true, consentVersion: DIRECTORY_CONSENT_VERSION });
}

/** «Guardar» sin tocar la publicación (si estaba publicado, sigue publicado con los datos nuevos). */
export async function saveFields(fields: PublicProfileFormFields): Promise<StatusResult> {
  const check = clientCheck(fields);
  if (!check.ok) return check;
  return savePublicProfile(fields);
}

/** Copy del confirm de retiro (uno solo para el formulario y la vista de retiro). */
const WITHDRAW_CONFIRM: ConfirmOptions = {
  title: "¿Dejar de publicar tu perfil?",
  message:
    "Tu perfil deja de verse en el directorio en este momento. Tus datos quedan guardados por si querés volver a publicarlo más adelante.",
  confirmLabel: "Dejar de publicar",
  tone: "danger",
};

/** «Dejar de publicar»: un click + confirm. Cancelar → `null` (no se llama a la action). */
export async function confirmAndWithdraw(confirm: ConfirmFn): Promise<StatusResult | null> {
  const ok = await confirm(WITHDRAW_CONFIRM);
  if (!ok) return null;
  return withdrawPublicProfile();
}

function fieldsFrom(data: MyPublicProfile): PublicProfileFormFields {
  const p = data.profile;
  return {
    publicName: p?.publicName ?? data.defaultPublicName,
    honorific: p?.honorific ?? "",
    licenseKind: p?.licenseKind ?? "",
    licenseNumber: p?.licenseNumber ?? "",
    licenseJurisdiction: p?.licenseJurisdiction ?? "",
    bio: p?.bio ?? "",
  };
}

/** Clave comparable de la matrícula (MN no lleva provincia: la base exige NULL y el server la descarta). */
function licenseKey(f: Pick<PublicProfileFormFields, "licenseKind" | "licenseNumber" | "licenseJurisdiction">): string {
  const kind = f.licenseKind.trim();
  if (!kind) return "";
  const num = f.licenseNumber.trim().replace(/\s+/g, " ");
  return `${kind}|${num}|${kind === "MP" ? f.licenseJurisdiction.trim().toUpperCase() : ""}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-AR", { timeZone: AR_TZ, day: "numeric", month: "short", year: "numeric" });
}

/** Largo como lo cuenta Postgres (`char_length`, code points): un emoji es 1, igual que en `parsePublicProfileFields`. */
const chars = (v: string) => [...v].length;

const STATUS_TAG: Record<PublicProfileStatus, { label: string; tone: "lime" | "soft" }> = {
  none: { label: "Sin publicar", tone: "soft" },
  draft: { label: "Guardado, sin publicar", tone: "soft" },
  published: { label: "Publicado", tone: "lime" },
  withdrawn: { label: "No publicado", tone: "soft" },
  hidden: { label: "Oculto por Plataforma", tone: "soft" },
};

export function PublicProfileForm({
  data,
  backHref,
  directoryOpen,
}: {
  data: MyPublicProfile;
  backHref: string;
  /** `DIRECTORY_MODE === "public"`: si no, se avisa que todavía no se ve (el formulario funciona igual). */
  directoryOpen: boolean;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const consentId = useId();
  const [fields, setFields] = useState<PublicProfileFormFields>(() => fieldsFrom(data));
  const [status, setStatus] = useState<PublicProfileStatus>(data.status);
  const [consentVersion, setConsentVersion] = useState<string | null>(data.profile?.consentVersion ?? null);
  const [consentAt, setConsentAt] = useState<string | null>(data.profile?.consentAt ?? null);
  // Matrícula guardada y su verificación: si se guarda otra, el trigger de M11 borra la verificación.
  const [saved, setSaved] = useState(() => ({
    license: licenseKey(fieldsFrom(data)),
    verified: data.profile?.licenseVerified ?? false,
  }));
  // Siempre sin tildar al montar (ver cabecera).
  const [accepted, setAccepted] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pending, setPending] = useState<null | "publish" | "save" | "withdraw">(null);

  const set = (k: keyof PublicProfileFormFields) => (v: string) => {
    setFields((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const listed = status === "published" || status === "hidden";
  const consentCurrent = consentVersion === DIRECTORY_CONSENT_VERSION;
  const needsConsent = status === "none" || status === "draft" || status === "withdrawn" || (status === "published" && !consentCurrent);
  const verifiedNow = saved.verified && licenseKey(fields) === saved.license && saved.license !== "";

  function onResult(r: StatusResult, okMsg: (st: PublicProfileStatus) => string): boolean {
    if (!r.ok) {
      setErrors((r.fieldErrors as FieldErrors | undefined) ?? {});
      toast.error("No se pudo guardar", { description: r.error });
      return false;
    }
    setErrors({});
    setStatus(r.data.status);
    toast.success(okMsg(r.data.status));
    return true;
  }

  async function onPublish() {
    if (pending) return;
    setPending("publish");
    try {
      const r = await publishWithConsent(fields, accepted);
      if (
        onResult(r, (st) =>
          st === "hidden"
            ? "Guardamos tu perfil y tu consentimiento, pero Plataforma lo tiene oculto."
            : "Listo, tu perfil quedó publicado."
        )
      ) {
        setAccepted(false);
        setConsentVersion(DIRECTORY_CONSENT_VERSION);
        setConsentAt(new Date().toISOString());
        setSaved((sv) => ({ license: licenseKey(fields), verified: licenseKey(fields) === sv.license && sv.verified }));
      }
    } catch {
      toast.error("No se pudo publicar", { description: NETWORK });
    } finally {
      setPending(null);
    }
  }

  async function onSave() {
    if (pending) return;
    setPending("save");
    try {
      const r = await saveFields(fields);
      if (onResult(r, () => "Guardamos tus cambios.")) {
        setSaved((sv) => ({ license: licenseKey(fields), verified: licenseKey(fields) === sv.license && sv.verified }));
      }
    } catch {
      toast.error("No se pudo guardar", { description: NETWORK });
    } finally {
      setPending(null);
    }
  }

  async function onWithdraw() {
    if (pending) return;
    setPending("withdraw");
    try {
      const r = await confirmAndWithdraw(confirm);
      if (r) onResult(r, () => "Listo, tu perfil dejó de verse en el directorio.");
    } catch {
      toast.error("No se pudo dejar de publicar", { description: NETWORK });
    } finally {
      setPending(null);
    }
  }

  // Enter en un campo = la acción principal: «Publicar» si falta el consentimiento, «Guardar cambios» si ya está.
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void (needsConsent ? onPublish() : onSave());
  }

  const tag = STATUS_TAG[status];
  const err = (k: keyof FieldErrors) => errors[k]?.[0];
  const previewName = fields.publicName.trim().replace(/\s+/g, " ");
  const hon = honorificLabel(fields.honorific);
  const kind = fields.licenseKind;
  const jur = kind === "MP" ? provinceName(fields.licenseJurisdiction) : null;
  const licenseLine = kind && fields.licenseNumber.trim() ? `${kind} ${fields.licenseNumber.trim()}${jur ? ` · ${jur}` : ""}` : null;
  const busy = pending !== null;

  return (
    <form className={s.root} onSubmit={onSubmit} noValidate>
      <div className={s.statusRow}>
        <Tag tone={tag.tone}>{tag.label}</Tag>
        {status === "published" && consentAt && (
          <span className={s.muted}>
            Aceptaste el consentimiento el {formatDate(consentAt)}
            {consentVersion ? ` (versión ${consentVersion})` : ""}.
          </span>
        )}
      </div>

      {status === "hidden" && (
        <p className={s.band} role="status">
          Plataforma ocultó tu perfil{data.profile?.hiddenReason ? `: ${data.profile.hiddenReason}` : ""}
          <br />
          Mientras siga oculto no se ve en el directorio. Si creés que es un error, escribinos desde Ayuda y soporte.
        </p>
      )}
      {status === "withdrawn" && (
        <p className={s.muted}>Retiraste el consentimiento. Para volver a aparecer, leé el texto y aceptalo de nuevo.</p>
      )}
      {!directoryOpen && (
        <p className={`${s.band} ${s.bandInfo}`}>
          El directorio todavía no está abierto al público. Podés dejar tu perfil listo: se va a ver cuando abra.
        </p>
      )}

      <section className={s.section} aria-labelledby={`${consentId}-datos`}>
        <h2 id={`${consentId}-datos`} className={s.sectionTitle}>
          Tus datos públicos
        </h2>
        <FormField
          label="Nombre público"
          required
          value={fields.publicName}
          onChange={set("publicName")}
          autoComplete="name"
          hint="Así te van a ver los pacientes. No uses tu email."
          error={err("publicName")}
          disabled={busy}
        />
        <div className={s.row2}>
          <FormField
            as="select"
            label="Título"
            value={fields.honorific}
            onChange={set("honorific")}
            options={[{ value: "", label: "Sin título" }, ...HONORIFIC_OPTIONS.map((o) => ({ value: o.value, label: o.label }))]}
            error={err("honorific")}
            disabled={busy}
          />
          <FormField
            as="select"
            label="Matrícula"
            value={fields.licenseKind}
            onChange={set("licenseKind")}
            options={[
              { value: "", label: "Sin matrícula" },
              { value: "MN", label: "Nacional (MN)" },
              { value: "MP", label: "Provincial (MP)" },
            ]}
            error={err("licenseKind")}
            disabled={busy}
          />
        </div>
        {kind && (
          <div className={s.row2}>
            <FormField
              label="Número de matrícula"
              required
              value={fields.licenseNumber}
              onChange={set("licenseNumber")}
              hint={`Hasta ${LICENSE_NUMBER_MAX} caracteres.`}
              error={err("licenseNumber")}
              disabled={busy}
            />
            {kind === "MP" && (
              <FormField
                as="select"
                label="Provincia que la otorgó"
                required
                value={fields.licenseJurisdiction}
                onChange={set("licenseJurisdiction")}
                options={[{ value: "", label: "Elegí la provincia" }, ...AR_PROVINCES.map((p) => ({ value: p.code, label: p.name }))]}
                error={err("licenseJurisdiction")}
                disabled={busy}
              />
            )}
          </div>
        )}
        {kind && (
          <p className={s.muted}>
            La matrícula se muestra en tu perfil. «Verificada» aparece recién cuando el equipo de la plataforma la revisa; si
            la cambiás, se vuelve a revisar.
          </p>
        )}
        <FormField
          as="textarea"
          label="Presentación"
          rows={5}
          value={fields.bio}
          onChange={set("bio")}
          placeholder="Contá en pocas líneas cómo trabajás y qué tratás."
          hint={`${chars(fields.bio)}/${PUBLIC_BIO_MAX}`}
          error={err("bio")}
          disabled={busy}
        />
        <p className={s.muted}>
          Las especialidades, las coberturas y los consultorios salen de cada consultorio donde atendés: se cargan en
          Configuración → Profesionales.
        </p>
      </section>

      <section className={s.section} aria-labelledby={`${consentId}-preview`}>
        <h2 id={`${consentId}-preview`} className={s.sectionTitle}>
          Vista previa
        </h2>
        <div className={s.preview}>
          <span className={s.previewAvatar} aria-hidden="true">
            {initials(previewName)}
          </span>
          <div className={s.previewBody}>
            <p className={s.previewName}>{[hon, previewName || "Tu nombre"].filter(Boolean).join(" ")}</p>
            {licenseLine && (
              <p className={s.previewLicense}>
                <span>{licenseLine}</span>
                {verifiedNow && <Tag tone="lime">Verificada</Tag>}
              </p>
            )}
            {fields.bio.trim() && <p className={s.previewBio}>{fields.bio.trim()}</p>}
          </div>
        </div>
      </section>

      {needsConsent && (
        <section className={s.section} aria-labelledby={`${consentId}-consent-title`}>
          <h2 id={`${consentId}-consent-title`} className={s.sectionTitle}>
            Consentimiento
          </h2>
          {status === "published" && !consentCurrent && (
            <p className={s.band} role="status">
              El texto del consentimiento cambió. Para seguir publicado, leelo y aceptalo de nuevo.
            </p>
          )}
          <label className={s.consent}>
            <input
              type="checkbox"
              className={s.consentBox}
              checked={accepted}
              onChange={(e) => {
                setAccepted(e.target.checked);
                if (errors.consent) setErrors((x) => ({ ...x, consent: undefined }));
              }}
              disabled={busy}
              aria-describedby={`${consentId}-consent-text`}
              aria-invalid={errors.consent ? true : undefined}
            />
            <span id={`${consentId}-consent-text`} className={s.consentText}>
              {DIRECTORY_CONSENT_TEXT}
            </span>
          </label>
          {errors.consent?.[0] && (
            <p className={s.consentError} role="alert">
              {errors.consent[0]}
            </p>
          )}
        </section>
      )}

      <div className={s.actions}>
        {needsConsent && (
          <Button type="submit" variant="primary" size="md" disabled={busy}>
            {pending === "publish" ? "Publicando…" : "Publicar"}
          </Button>
        )}
        <Button
          type={needsConsent ? "button" : "submit"}
          variant={needsConsent ? "ghost" : "primary"}
          size="md"
          onClick={needsConsent ? onSave : undefined}
          disabled={busy}
        >
          {pending === "save" ? "Guardando…" : listed ? "Guardar cambios" : "Guardar sin publicar"}
        </Button>
        {listed && (
          <Button type="button" variant="ghost" size="md" className={s.danger} onClick={onWithdraw} disabled={busy}>
            {pending === "withdraw" ? "Retirando…" : "Dejar de publicar"}
          </Button>
        )}
      </div>

      <a href={backHref} className={s.back}>
        Volver
      </a>
    </form>
  );
}

/**
 * Vista para quien ya no atiende en ningún consultorio pero tiene el perfil publicado: el formulario no aplica (el
 * perfil es «para quienes atienden»), pero retirar el consentimiento tiene que poder hacerse siempre (Ley 25.326:
 * revocable en cualquier momento). `withdrawPublicProfile` no exige atender.
 */
export function PublicProfileWithdrawOnly({ backHref }: { backHref: string }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function onWithdraw() {
    if (pending) return;
    setPending(true);
    try {
      const r = await confirmAndWithdraw(confirm);
      if (!r) return;
      if (!r.ok) {
        toast.error("No se pudo dejar de publicar", { description: r.error });
        return;
      }
      setDone(true);
      toast.success("Listo, tu perfil dejó de verse en el directorio.");
    } catch {
      toast.error("No se pudo dejar de publicar", { description: NETWORK });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={s.root}>
      {done ? (
        <p className={s.muted} role="status">
          Tu perfil ya no está publicado.
        </p>
      ) : (
        <>
          <p className={s.muted}>
            Hoy no atendés en ningún consultorio, así que tu perfil no se ve en el directorio. Igual podés retirar tu
            consentimiento para que no vuelva a aparecer si te suman a un consultorio.
          </p>
          <div className={s.actions}>
            <Button type="button" variant="ghost" size="md" className={s.danger} onClick={onWithdraw} disabled={pending}>
              {pending ? "Retirando…" : "Dejar de publicar"}
            </Button>
          </div>
        </>
      )}
      <a href={backHref} className={s.back}>
        Volver
      </a>
    </div>
  );
}

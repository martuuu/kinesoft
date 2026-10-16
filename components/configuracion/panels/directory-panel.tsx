"use client";

/**
 * Configuración → Directorio (DIR-3c, contrato C-DIR9; DIR-D9, DIR-D25).
 *
 * Qué hace el consultorio acá:
 *   • prende/apaga «Mostrar el consultorio en el directorio» (`setDirectoryListed`) y carga la descripción pública
 *     (`setPublicDescription`, ≤ 800 con contador). Las dos son de `tenant.admin`; **soporte las ve y no las cambia**
 *     (la action lo rechaza con su copy; acá ni se ofrece);
 *   • ve si de verdad aparece: el directorio pide lo mismo que el turnero (C-DIR4: turnero del consultorio prendido y
 *     al menos un profesional reservable) y que Plataforma no lo haya ocultado. Cada condición se muestra con su
 *     estado en vez de un «no aparece» sin explicación;
 *   • ve el estado del perfil público de cada profesional (publicado / sin perfil publicado / oculto por Plataforma)
 *     SIN poder editarlo: el perfil es de la persona (consentimiento propio, Ley 25.326) y se edita en
 *     «Mi perfil público» de su cuenta;
 *   • link a la vista pública según el modo (`preview`: «vista previa», no indexada; `public`: la página).
 *
 * Los datos llegan del loader de `/configuracion` (misma tx de PF2 + una lectura de estados por el canal service):
 * nada se pide al abrir la pestaña. Las actions revalidan `/configuracion` y su respuesta trae el árbol nuevo (sin
 * `router.refresh()`, PF-0d).
 *
 * Formularios: el switch guarda al toque (como el del turnero en General); la descripción es un formulario en línea
 * con aviso de cambios sin guardar, «Descartar» con `useConfirm`, `beforeunload` y `onDirtyChange` (el shell frena el
 * cambio de pestaña).
 */
import { useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { Tag } from "@/components/ui/tag";
import { IconAlert, IconCheck, IconX } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { setDirectoryListed, setPublicDescription } from "@/lib/directory-settings";
import { DIRECTORY_SUPPORT_DENIED, PUBLIC_DESCRIPTION_MAX } from "@/lib/directory-constants";
import { BRAND_NAME } from "@/lib/brand";
import type {
  ConfiguracionDirectoryData,
  DirectoryPractitionerRow,
  DirectoryProfileStatus,
} from "@/lib/configuracion-page-loader";
import { Switch, ErrorBox } from "../controls";

/** `char_length` de Postgres cuenta code points (como la action): un emoji es 1, no 2. */
export function descriptionLength(s: string): number {
  return [...s.trim()].length;
}

export type DirectoryCheck = { key: string; ok: boolean; label: string; hint?: string };

/**
 * Puro: las condiciones para aparecer (C-DIR4), en el orden en que se resuelven. «Profesional en el turnero» es lo
 * que el consultorio controla desde acá; que además tenga un servicio online lo dice el hint (lo exige el turnero).
 */
export function directoryChecks(d: Pick<ConfiguracionDirectoryData, "listed" | "turneroOn" | "hidden" | "practitioners">): DirectoryCheck[] {
  const inTurnero = d.practitioners.filter((p) => p.inTurnero).length;
  return [
    { key: "listed", ok: d.listed, label: "Elegiste mostrar el consultorio" },
    {
      key: "turnero",
      ok: d.turneroOn,
      label: "El turnero online está prendido",
      hint: d.turneroOn ? undefined : "El directorio necesita el turnero prendido. Prendelo en General.",
    },
    {
      key: "pros",
      ok: inTurnero > 0,
      label: "Hay al menos un profesional en el turnero",
      hint:
        inTurnero > 0
          ? undefined
          : "Prendé «Aparece en el turnero online» en Profesionales, con al menos un servicio online.",
    },
    {
      key: "moderation",
      ok: d.hidden === null,
      label: "Sin observaciones de Plataforma",
    },
  ];
}

const STATUS_LABEL: Record<DirectoryProfileStatus, string> = {
  published: "Perfil publicado",
  hidden: "Oculto por Plataforma",
  none: "Sin perfil publicado",
};

/** Puro: el texto de la fila de un profesional (exportado para el test). */
export function practitionerDirectoryNote(p: Pick<DirectoryPractitionerRow, "status" | "inTurnero">): string {
  if (!p.inTurnero) return "No está en el turnero: no aparece en el directorio aunque publique su perfil.";
  if (p.status === "published") return "Aparece en el directorio con su perfil.";
  if (p.status === "hidden") return "Plataforma ocultó su perfil. Si es un error, escribinos desde Soporte.";
  return "No aparece con perfil propio: los pacientes lo ven al sacar turno. Puede publicar su perfil desde «Mi perfil público».";
}

export function DirectoryPanel({
  directory,
  support = false,
  onDirtyChange,
}: {
  directory: ConfiguracionDirectoryData;
  /** Sesión de soporte: todo en solo lectura (DIR-D9). */
  support?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const d = directory;
  const checks = directoryChecks(d);
  const visible = checks.every((c) => c.ok);
  const publicPath = `/consultorios/${encodeURIComponent(d.slug)}`;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {d.hidden && (
        <div
          role="alert"
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            padding: "12px 14px",
            borderRadius: "var(--r-sm)",
            background: "var(--danger-bg)",
            border: "1px solid var(--danger-border)",
            color: "var(--danger-fg)",
            fontSize: 13,
            lineHeight: 1.45,
          }}
        >
          <IconAlert size={16} />
          <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            <strong>Plataforma ocultó el consultorio: {d.hidden.reason}</strong>
            <div style={{ marginTop: 2 }}>Mientras siga oculto no aparece en el directorio. Si querés revisarlo, escribinos desde Soporte.</div>
          </div>
        </div>
      )}

      {support && (
        <div
          role="note"
          style={{
            padding: "10px 12px",
            borderRadius: "var(--r-sm)",
            background: "var(--warn-bg)",
            border: "1px solid var(--warn-border)",
            color: "var(--warn-fg)",
            fontSize: 12.5,
          }}
        >
          {DIRECTORY_SUPPORT_DENIED} Ves todo en solo lectura.
        </div>
      )}

      <ListedCard directory={d} support={support} checks={checks} visible={visible} publicPath={publicPath} />
      <DescriptionCard initial={d.description} support={support} onDirtyChange={onDirtyChange} />
      <PractitionersCard practitioners={d.practitioners} />
    </div>
  );
}

function ListedCard({
  directory: d,
  support,
  checks,
  visible,
  publicPath,
}: {
  directory: ConfiguracionDirectoryData;
  support: boolean;
  checks: DirectoryCheck[];
  visible: boolean;
  publicPath: string;
}) {
  const toast = useToast();
  const [on, setOn] = useState(d.listed);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => setOn(d.listed), [d.listed]);

  const toggle = () => {
    if (support || pending) return;
    const next = !on;
    setOn(next);
    setError(null);
    start(async () => {
      const r = await setDirectoryListed(next);
      if (!r.ok) {
        setOn(!next);
        setError(r.error);
        return;
      }
      toast.success(next ? "El consultorio se va a mostrar en el directorio" : "El consultorio ya no se muestra en el directorio");
    });
  };

  // Lo que el server devolvió manda; mientras tanto, el switch optimista.
  const shown = checks.map((c) => (c.key === "listed" ? { ...c, ok: on } : c));

  return (
    <Card style={{ padding: 18, display: "grid", gap: 14 }}>
      <div>
        <EyebrowLabel>Directorio de profesionales</EyebrowLabel>
        <p style={{ fontSize: 13, color: "var(--navy-500)", margin: "4px 0 0", lineHeight: 1.5 }}>
          Los pacientes buscan en {BRAND_NAME} por especialidad, cobertura y zona. Se muestran el nombre del consultorio,
          la descripción, las sedes, el teléfono y los profesionales que publicaron su perfil. Nunca precios ni datos de
          pacientes.
        </p>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Switch
          on={on}
          onChange={toggle}
          disabled={support || pending}
          aria-label="Mostrar el consultorio en el directorio"
        />
        <span style={{ fontSize: 14, fontWeight: 700, color: "var(--navy-900)" }}>
          Mostrar el consultorio en el directorio
        </span>
      </div>
      {error && (
        <div role="alert">
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}

      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-900)", marginBottom: 6 }} aria-live="polite">
          {visible && on ? "Hoy aparece en el directorio." : "Hoy no aparece en el directorio."}
        </div>
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
          {shown.map((c) => (
            <li key={c.key} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
              <span
                aria-hidden="true"
                style={{
                  flexShrink: 0,
                  marginTop: 1,
                  width: 18,
                  height: 18,
                  borderRadius: 999,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: c.ok ? "var(--success-bg)" : "var(--warn-bg)",
                  color: c.ok ? "var(--success-fg)" : "var(--warn-fg)",
                }}
              >
                {c.ok ? <IconCheck size={11} /> : <IconX size={10} />}
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ color: "var(--navy-900)" }}>
                  {c.label}
                  <span className="k-sr-only">{c.ok ? " (listo)" : " (falta)"}</span>
                </span>
                {c.hint && !c.ok && (
                  <span style={{ display: "block", fontSize: 12, color: "var(--navy-500)", marginTop: 2 }}>{c.hint}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {visible && on && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
          <a href={publicPath} target="_blank" rel="noopener noreferrer" style={{ fontWeight: 700, color: "var(--sky-700)" }}>
            {d.mode === "preview" ? "Ver la vista previa" : "Ver la página pública"}
          </a>
          {d.mode === "preview" && (
            <span style={{ fontSize: 12, color: "var(--navy-500)" }}>
              El directorio está en vista previa: se ve con el link, pero todavía no aparece en buscadores.
            </span>
          )}
          <span style={{ fontSize: 12, color: "var(--navy-300)" }}>Los cambios pueden tardar unos minutos en verse.</span>
        </div>
      )}
    </Card>
  );
}

function DescriptionCard({
  initial,
  support,
  onDirtyChange,
}: {
  initial: string | null;
  support: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [baseline, setBaseline] = useState(initial ?? "");
  const [value, setValue] = useState(initial ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const fieldId = useId();
  const counterId = `${fieldId}-count`;
  const errorId = `${fieldId}-error`;

  const dirty = value.trim() !== baseline.trim();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // Cuando llega el árbol nuevo manda el server, salvo que haya algo sin guardar.
  useEffect(() => {
    if (dirtyRef.current) return;
    setBaseline(initial ?? "");
    setValue(initial ?? "");
  }, [initial]);

  const onDirtyRef = useRef(onDirtyChange);
  onDirtyRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyRef.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => onDirtyRef.current?.(false), []);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const len = descriptionLength(value);
  const over = len > PUBLIC_DESCRIPTION_MAX;

  const save = () => {
    if (support || over) return;
    setError(null);
    start(async () => {
      const r = await setPublicDescription(value);
      if (!r.ok) {
        setError(r.fieldErrors?.publicDescription?.[0] ?? r.error);
        return;
      }
      const saved = r.data.description ?? "";
      setBaseline(saved);
      setValue(saved);
      toast.success("Descripción guardada");
    });
  };

  const discard = useCallback(async () => {
    const ok = await confirm({
      title: "¿Descartar los cambios?",
      message: "La descripción vuelve a como estaba guardada.",
      confirmLabel: "Descartar",
      tone: "danger",
    });
    if (ok) {
      setValue(baseline);
      setError(null);
    }
  }, [confirm, baseline]);

  return (
    <Card style={{ padding: 18, display: "grid", gap: 10 }}>
      <div>
        <label htmlFor={fieldId} className="k-label" style={{ display: "block" }}>
          Descripción pública
        </label>
        <p style={{ fontSize: 12.5, color: "var(--navy-500)", margin: "2px 0 0", lineHeight: 1.45 }}>
          Contá en pocas líneas qué atienden y cómo trabajan. Se muestra en la página del consultorio en el directorio.
        </p>
      </div>
      <textarea
        id={fieldId}
        className="k-input"
        rows={5}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        readOnly={support}
        aria-readonly={support || undefined}
        aria-invalid={over || !!error || undefined}
        aria-describedby={error ? `${errorId} ${counterId}` : counterId}
        placeholder="Ej.: Kinesiología deportiva y rehabilitación postquirúrgica. Atendemos con turno, de lunes a sábado."
        style={{ resize: "vertical", minHeight: 110, width: "100%" }}
      />
      <div
        id={counterId}
        aria-live="polite"
        style={{ fontSize: 12, textAlign: "right", color: over ? "var(--danger-fg)" : "var(--navy-500)", fontWeight: over ? 700 : 400 }}
      >
        {len} / {PUBLIC_DESCRIPTION_MAX}
        {over ? ` · Sacá ${len - PUBLIC_DESCRIPTION_MAX} para poder guardar` : ""}
      </div>
      {error && (
        <div id={errorId} role="alert">
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}
      {!support && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            flexWrap: "wrap",
            paddingTop: 6,
            borderTop: "1px solid rgba(15,30,51,0.06)",
          }}
        >
          <span
            role="status"
            style={{ fontSize: 12, color: dirty ? "var(--warn-fg)" : "var(--navy-300)", fontWeight: dirty ? 600 : 400 }}
          >
            {dirty ? "Tenés cambios sin guardar" : "Sin cambios"}
          </span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {dirty && (
              <Button variant="ghost" type="button" onClick={discard} disabled={pending}>
                Descartar
              </Button>
            )}
            <Button variant="primary" type="button" onClick={save} disabled={!dirty || over || pending}>
              {pending ? "Guardando…" : "Guardar descripción"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function PractitionersCard({ practitioners }: { practitioners: DirectoryPractitionerRow[] }) {
  return (
    <Card style={{ padding: 18, display: "grid", gap: 10 }}>
      <div>
        <EyebrowLabel>Profesionales</EyebrowLabel>
        <p style={{ fontSize: 13, color: "var(--navy-500)", margin: "4px 0 0", lineHeight: 1.5 }}>
          Cada profesional decide si publica su perfil (nombre, matrícula, presentación) desde «Mi perfil público», en
          el menú de su cuenta. Es un dato personal: el consultorio lo ve, pero no lo puede editar. Sus especialidades
          se cargan en Profesionales.
        </p>
      </div>
      {practitioners.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--navy-500)" }}>
          Todavía no hay profesionales con la invitación aceptada.
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {practitioners.map((p) => (
            <li
              key={p.practitionerId}
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "6px 12px",
                padding: "10px 12px",
                borderRadius: "var(--r-sm)",
                border: "1px solid rgba(15,30,51,0.08)",
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--navy-900)", minWidth: 0, overflowWrap: "anywhere" }}>
                {p.name}
              </span>
              <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                <Tag tone={p.status === "published" ? "lime" : "soft"}>{STATUS_LABEL[p.status]}</Tag>
                {!p.inTurnero && <Tag tone="soft">No está en el turnero</Tag>}
              </span>
              <span style={{ flexBasis: "100%", fontSize: 12, color: "var(--navy-500)" }}>{practitionerDirectoryNote(p)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

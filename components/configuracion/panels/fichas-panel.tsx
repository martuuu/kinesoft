"use client";

/**
 * [FC-3i] Configuración → «Mis fichas» (FC-UI-D3): lo PERSONAL de cada profesional para sus fichas. La ve todo miembro
 * clínico (atiende y tiene `Practitioner`), con o sin «Configuración» delegada:
 *   - Cómo firmás: honorífico (LIC/KLGO/KLGA/DR/DRA, FC-D23) y matrícula (`updateOwnSignatureInfo`). Se imprime el
 *     vigente al crear o enmendar cada ficha.
 *   - Firma escaneada propia (≤512 KB, PNG/JPEG; `uploadOwnSignature`). Nadie carga la firma de otro, ni el Titular.
 *   - Carpeta de respaldo (`BackupSetup` de FC-3g, por `next/dynamic` sin SSR: usa IndexedDB y File System Access).
 *     Mismo `import()` que el menú «⋯» de la HC: webpack lo resuelve al MISMO chunk (sin chunk nuevo).
 *   - Diagnósticos propios del consultorio: lista, renombrar y archivar según FC-D22 (`canManage` lo calcula el
 *     server: quien lo creó o `tenant.sensitive`). Se piden al abrir la pestaña (`listTenantDiagnoses`), no en el SSR:
 *     /configuracion no suma una lectura para todos por algo que se mira poco.
 *
 * El honorífico y la matrícula se editan en línea (dos campos): el dirty sube a `ConfiguracionClient` para que el
 * cambio de pestaña pida confirmación, como en Profesionales. Renombrar va en Drawer con dirty-guard.
 */
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { FormField } from "@/components/ui/form-field";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { Tag } from "@/components/ui/tag";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { FICHAS_SETTINGS_COPY as COPY } from "./fichas-settings-copy";
import type { FichaBackupScope } from "@/components/fichas/fichas-ui-types";
import { HONORIFIC_OPTIONS, type Honorific } from "@/lib/directory-constants";
import { PRACTICE_ASSET_COPY } from "@/lib/file-sniff";
import { updateOwnSignatureInfo } from "@/lib/practice-assets";
import { archiveTenantDiagnosis, listTenantDiagnoses, updateTenantDiagnosis } from "@/lib/diagnoses";
import type { TenantDiagnosisRow } from "@/lib/diagnoses-types";
import { PracticeAssetField, type PracticeAssetState } from "./practice-asset-field";
import { applyDiagnosisChange, normalizeLicenseInput, splitTenantDiagnoses } from "./mis-fichas-logic";
import { ErrorBox } from "../controls";

const BackupSetup = dynamic(() => import("@/components/fichas/backup-setup").then((m) => m.BackupSetup), {
  ssr: false,
  loading: () => null,
});

/**
 * Logo del consultorio para General (`tenant.sensitive`). Vive en este módulo para que General lo baje por
 * `next/dynamic` del MISMO chunk que «Mis fichas» (ver `practice-asset-field.tsx`): sin chunk compartido nuevo.
 */
export function LogoAssetField({ initial, disabled }: { initial: PracticeAssetState; disabled?: boolean }) {
  return (
    <>
      <EyebrowLabel>{COPY.logo}</EyebrowLabel>
      <div style={{ marginTop: 10 }}>
        <PracticeAssetField
          kind="logo"
          initial={initial}
          label={COPY.logo}
          hint={COPY.logoHint}
          formatHint={PRACTICE_ASSET_COPY.logoFormat}
          disabled={disabled}
        />
      </div>
    </>
  );
}

export type FichasPanelMe = {
  honorific: Honorific | null;
  licenseNumber: string | null;
  signature: PracticeAssetState;
};

type Msg = { tone: "ok" | "err"; text: string } | null;

export function FichasPanel({
  me,
  backupScope,
  readOnly = false,
  onDirtyChange,
}: {
  me: FichasPanelMe;
  backupScope: FichaBackupScope;
  /** Consultorio en modo lectura: se ve todo, no se guarda (las actions lo rechazan igual). */
  readOnly?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14 }}>
      <Card style={{ padding: 20 }}>
        <EyebrowLabel>{COPY.honorific}</EyebrowLabel>
        <p style={{ fontSize: 13, color: "var(--navy-500)", margin: "6px 0 0", lineHeight: 1.45, maxWidth: 640 }}>
          {COPY.signatureIntro}
        </p>
        <SignatureInfoForm me={me} readOnly={readOnly} onDirtyChange={onDirtyChange} />
      </Card>

      <Card style={{ padding: 20 }}>
        <EyebrowLabel>{COPY.signature}</EyebrowLabel>
        <div style={{ marginTop: 10 }}>
          <PracticeAssetField
            kind="signature"
            initial={me.signature}
            label={COPY.signature}
            hint={COPY.signatureHint}
            formatHint={PRACTICE_ASSET_COPY.signatureFormat}
            disabled={readOnly}
          />
        </div>
      </Card>

      <Card style={{ padding: 20 }}>
        <BackupSetup scope={backupScope} variant="panel" />
      </Card>

      <OwnDiagnosesCard readOnly={readOnly} />
    </div>
  );
}

function SignatureInfoForm({
  me,
  readOnly,
  onDirtyChange,
}: {
  me: FichasPanelMe;
  readOnly: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [saved, setSaved] = useState({ honorific: me.honorific, licenseNumber: me.licenseNumber });
  const [honorific, setHonorific] = useState<Honorific | "">(me.honorific ?? "");
  const [license, setLicense] = useState(me.licenseNumber ?? "");
  const [msg, setMsg] = useState<Msg>(null);
  const [pending, start] = useTransition();
  const dirty = (honorific || null) !== saved.honorific || normalizeLicenseInput(license) !== saved.licenseNumber;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  // Al desmontar (cambio de pestaña confirmado) no queda un dirty colgado en el padre.
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const save = () => {
    setMsg(null);
    const next = { honorific: (honorific || null) as Honorific | null, licenseNumber: normalizeLicenseInput(license) };
    start(async () => {
      try {
        const r = await updateOwnSignatureInfo(next);
        if (!r.ok) {
          setMsg({ tone: "err", text: r.error });
          return;
        }
        setSaved(next);
        setLicense(next.licenseNumber ?? "");
        setMsg({ tone: "ok", text: COPY.savedInfo });
      } catch {
        setMsg({ tone: "err", text: COPY.network });
      }
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !pending && !readOnly) save();
      }}
      style={{ display: "grid", gap: 12, marginTop: 12 }}
    >
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <FormField
          as="select"
          label={COPY.honorific}
          name="honorific"
          value={honorific}
          onChange={(v) => setHonorific(v as Honorific | "")}
          options={[{ value: "", label: COPY.honorificNone }, ...HONORIFIC_OPTIONS.map((o) => ({ value: o.value, label: o.label }))]}
          disabled={readOnly}
        />
        <FormField
          label={COPY.license}
          name="licenseNumber"
          value={license}
          onChange={setLicense}
          hint={COPY.licenseHint}
          disabled={readOnly}
          autoComplete="off"
        />
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        {msg && (
          <span
            role={msg.tone === "err" ? "alert" : "status"}
            style={{ fontSize: 12.5, fontWeight: 600, color: msg.tone === "ok" ? "var(--navy-900)" : "var(--danger-fg)" }}
          >
            {msg.text}
          </span>
        )}
        <Button type="submit" variant="primary" disabled={!dirty || pending || readOnly}>
          {pending ? COPY.saving : COPY.saveInfo}
        </Button>
      </div>
    </form>
  );
}

type ListState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; rows: TenantDiagnosisRow[] };

function OwnDiagnosesCard({ readOnly }: { readOnly: boolean }) {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [editing, setEditing] = useState<TenantDiagnosisRow | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const confirm = useConfirm();

  const load = useCallback(() => {
    setList({ status: "loading" });
    listTenantDiagnoses()
      .then((rows) => setList({ status: "ready", rows }))
      .catch(() => setList({ status: "error" }));
  }, []);
  useEffect(load, [load]);

  const { live, archived } = useMemo(() => splitTenantDiagnoses(list.status === "ready" ? list.rows : []), [list]);

  const archive = async (row: TenantDiagnosisRow) => {
    const ok = await confirm({
      title: COPY.archiveTitle(row.title),
      message: COPY.archiveMessage,
      confirmLabel: COPY.archive,
      cancelLabel: COPY.cancel,
      tone: "danger",
    });
    if (!ok) return;
    setMsg(null);
    setPendingId(row.id);
    try {
      const r = await archiveTenantDiagnosis({ id: row.id });
      if (!r.ok) {
        setMsg({ tone: "err", text: r.error });
        return;
      }
      setList((l) => (l.status === "ready" ? { status: "ready", rows: applyDiagnosisChange(l.rows, { kind: "archived", id: row.id }) } : l));
      setMsg({ tone: "ok", text: COPY.archivedDone });
    } catch {
      setMsg({ tone: "err", text: COPY.network });
    } finally {
      setPendingId(null);
    }
  };

  return (
    <Card style={{ padding: 20 }}>
      <EyebrowLabel>{COPY.ownDiagnoses}</EyebrowLabel>
      <p style={{ fontSize: 13, color: "var(--navy-500)", margin: "6px 0 12px", lineHeight: 1.45, maxWidth: 640 }}>
        {COPY.ownDiagnosesHint}
      </p>
      {list.status === "loading" && (
        <div aria-busy="true" style={{ fontSize: 13, color: "var(--navy-500)" }}>
          {COPY.ownDiagnosesLoading}
        </div>
      )}
      {list.status === "error" && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <ErrorBox>{COPY.ownDiagnosesFailed}</ErrorBox>
          <Button type="button" variant="ghost" onClick={load}>
            Reintentar
          </Button>
        </div>
      )}
      {list.status === "ready" && live.length === 0 && archived.length === 0 && (
        <div style={{ fontSize: 13, color: "var(--navy-500)" }}>{COPY.ownDiagnosesEmpty}</div>
      )}
      {live.length > 0 && (
        <ul data-own-diagnoses style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
          {live.map((row) => (
            <DiagnosisRowItem
              key={row.id}
              row={row}
              busy={pendingId === row.id}
              readOnly={readOnly}
              onRename={() => setEditing(row)}
              onArchive={() => void archive(row)}
            />
          ))}
        </ul>
      )}
      {archived.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ fontSize: 13, color: "var(--navy-700)", cursor: "pointer", minHeight: 32 }}>
            {COPY.archivedCount(archived.length)}
          </summary>
          <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 6 }}>
            {archived.map((row) => (
              <DiagnosisRowItem key={row.id} row={row} busy={false} readOnly />
            ))}
          </ul>
        </details>
      )}
      {msg && (
        <div
          role={msg.tone === "err" ? "alert" : "status"}
          style={{ marginTop: 10, fontSize: 12.5, fontWeight: 600, color: msg.tone === "ok" ? "var(--success-fg)" : "var(--danger-fg)" }}
        >
          {msg.text}
        </div>
      )}
      {editing && (
        <RenameDiagnosisDrawer
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={(row) => {
            setEditing(null);
            setList((l) => (l.status === "ready" ? { status: "ready", rows: applyDiagnosisChange(l.rows, { kind: "renamed", row }) } : l));
            setMsg({ tone: "ok", text: COPY.renamedDone });
          }}
        />
      )}
    </Card>
  );
}

/** Exportado para el test: los botones dependen solo de `canManage` (FC-D22, del server) y del modo lectura. */
export function DiagnosisRowItem({
  row,
  busy,
  readOnly,
  onRename,
  onArchive,
}: {
  row: TenantDiagnosisRow;
  busy: boolean;
  readOnly: boolean;
  onRename?: () => void;
  onArchive?: () => void;
}) {
  const manage = row.canManage && !row.archived && !readOnly;
  return (
    <li
      data-diagnosis-row={row.id}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        padding: "8px 12px",
        borderRadius: 10,
        border: "1px solid var(--navy-100)",
      }}
    >
      <div style={{ flex: "1 1 220px", minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--navy-900)", overflowWrap: "anywhere" }}>
          {row.code && (
            <span className="k-mono" style={{ fontSize: 12, color: "var(--navy-500)", marginRight: 6 }}>
              {row.code}
            </span>
          )}
          {row.title}
        </div>
        {(row.createdByMe || row.archived) && (
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            {row.createdByMe && <Tag tone="sky">{COPY.createdByMe}</Tag>}
            {row.archived && <Tag tone="soft">{COPY.archived}</Tag>}
          </div>
        )}
      </div>
      {manage && (
        <div style={{ display: "flex", gap: 8 }}>
          <Button type="button" variant="ghost" size="sm" onClick={onRename} disabled={busy}>
            {COPY.rename}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onArchive} disabled={busy}>
            {COPY.archive}
          </Button>
        </div>
      )}
    </li>
  );
}

function RenameDiagnosisDrawer({
  row,
  onClose,
  onSaved,
}: {
  row: TenantDiagnosisRow;
  onClose: () => void;
  onSaved: (row: TenantDiagnosisRow) => void;
}) {
  const [title, setTitle] = useState(row.title);
  const [code, setCode] = useState(row.code ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const confirm = useConfirm();
  const dirty = title.trim() !== row.title.trim() || code.trim() !== (row.code ?? "").trim();
  // «Cancelar» pasa por el mismo aviso que Esc, el fondo y la X (el Drawer solo guarda esos tres).
  const cancel = async () => {
    if (dirty && !(await confirm({ title: COPY.discardTitle, message: COPY.dirty, confirmLabel: COPY.discard, cancelLabel: COPY.keepEditing, tone: "danger" }))) return;
    onClose();
  };

  const submit = () => {
    setError(null);
    start(async () => {
      try {
        const r = await updateTenantDiagnosis({
          id: row.id,
          title: title.trim(),
          code: code.trim() || null,
          expectedUpdatedAt: row.updatedAt,
        });
        if (!r.ok) {
          setError(r.error);
          return;
        }
        onSaved(r.data.row);
      } catch {
        setError(COPY.network);
      }
    });
  };

  return (
    <Drawer open onClose={onClose} title={COPY.renameTitle} dirty={dirty && !pending} dirtyMessage={COPY.dirty}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && !pending) submit();
        }}
        style={{ display: "grid", gap: 12 }}
      >
        <FormField label={COPY.diagnosisTitle} name="title" value={title} onChange={setTitle} required autoFocus />
        <FormField label={COPY.diagnosisCode} name="code" value={code} onChange={setCode} autoComplete="off" />
        {error && (
          <div role="alert">
            <ErrorBox>{error}</ErrorBox>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button type="button" variant="ghost" onClick={() => void cancel()} disabled={pending}>
            {COPY.cancel}
          </Button>
          <Button type="submit" variant="primary" disabled={!dirty || pending}>
            {pending ? COPY.saving : COPY.saveRename}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

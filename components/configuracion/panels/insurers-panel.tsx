"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { Modal } from "@/components/ui/modal";
import { FormField } from "@/components/ui/form-field";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { IconPlus } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { MoneyInput } from "@/components/ui/money-input";
import { formatARS } from "@/lib/format";
import type { InsurerRow } from "@/lib/insurers-types";
import type { PayerOption } from "@/lib/catalog-schemas";
import {
  createInsurer,
  updateInsurer,
  deleteInsurer,
  addInsurerFromCatalog,
  linkInsurerToPayer,
} from "@/lib/insurers";
import { listInsurerPayerSuggestions } from "@/lib/catalog";
import { ErrorBox } from "../controls";
import { PayerPickerModal } from "../catalog/payer-picker";
import { PayerPlansInfo } from "../catalog/payer-plans-info";
import { useTenantModules } from "@/components/layout/tenant-modules-context";

/**
 * EV1-C2: en Kinesiología la prestadora paga «al kine por sesión»; en Clínica
 * general la unidad es el turno y quien cobra es «el profesional». Vertical
 * real del contexto (EV1, antes se deducía de `has("sesiones")`).
 */
function usePayeeCopy() {
  const isKine = useTenantModules().vertical === "KINESIOLOGY";
  return isKine
    ? { payee: "al kine", unit: "por sesión" }
    : { payee: "al profesional", unit: "por turno" };
}

export function InsurersPanel({ insurers }: { insurers: InsurerRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<InsurerRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [pickingFromCatalog, setPickingFromCatalog] = useState(false);
  const [busy, startBusy] = useTransition();
  // Alta desde el catálogo: al volver el refresh con la OS nueva, se abre su
  // editor para cargar copago y monto fijo (nacen en 0).
  const [openAfterRefresh, setOpenAfterRefresh] = useState<string | null>(null);
  const payeeCopy = usePayeeCopy();
  // Sugerencias "Vincular a <Payer>" por matchKey para las OS sin vincular.
  // Nunca se vinculan solas (sin auto-link): el usuario confirma por fila.
  const [suggestions, setSuggestions] = useState<Record<string, PayerOption>>({});

  useEffect(() => {
    if (!openAfterRefresh) return;
    const row = insurers.find((i) => i.id === openAfterRefresh);
    if (row) {
      setEditing(row);
      setOpenAfterRefresh(null);
    }
  }, [insurers, openAfterRefresh]);

  useEffect(() => {
    let alive = true;
    listInsurerPayerSuggestions()
      .then((s) => alive && setSuggestions(s))
      .catch(() => alive && setSuggestions({}));
    return () => {
      alive = false;
    };
  }, [insurers]);

  const linkedPayerIds = useMemo(
    () => new Set(insurers.map((i) => i.payerId).filter((x): x is string => !!x)),
    [insurers]
  );

  const link = (insurer: Pick<InsurerRow, "id" | "name">, payer: PayerOption) =>
    startBusy(async () => {
      const r = await linkInsurerToPayer(insurer.id, payer.id);
      if (!r.ok) toast.error("No pudimos vincular", { description: r.error });
      else {
        toast.success(`«${insurer.name}» quedó vinculada a ${payer.name}`);
        router.refresh();
      }
    });

  const addFromCatalog = (payer: PayerOption) =>
    startBusy(async () => {
      const r = await addInsurerFromCatalog(payer.id);
      if (!r.ok) {
        toast.error("No pudimos agregarla", { description: r.error });
        return;
      }
      setPickingFromCatalog(false);
      if (r.data.status === "created") {
        toast.success(`Agregaste ${payer.name}`, { description: "Cargá el copago y el monto fijo." });
        setOpenAfterRefresh(r.data.insurerId);
        router.refresh();
        return;
      }
      // Ya hay una OS con ese nombre (único por consultorio): no se duplica.
      if (r.data.linkedPayerId === payer.id) {
        toast.info(`«${payer.name}» ya está cargada y vinculada al catálogo.`);
        return;
      }
      const ok = await confirm({
        title: `Ya tenés «${payer.name}» cargada`,
        message: r.data.linkedPayerId
          ? "Está vinculada a otra prestadora del catálogo. ¿Querés vincularla a esta? El copago y el monto fijo no cambian."
          : "¿Querés vincularla a la prestadora del catálogo? El copago y el monto fijo no cambian.",
        confirmLabel: "Vincular",
      });
      if (ok) link({ id: r.data.insurerId, name: payer.name }, payer);
    });

  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <header
        style={{
          padding: "16px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          borderBottom: "1px solid rgba(15,30,51,0.06)",
        }}
      >
        <div style={{ flex: "1 1 280px", minWidth: 0 }}>
          <EyebrowLabel>Obras Sociales y Prepagas</EyebrowLabel>
          <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 4 }}>
            {`Cada paciente puede tener una cobertura. El copago lo paga el paciente; el monto fijo es lo que le abona la prestadora ${payeeCopy.payee} ${payeeCopy.unit}.`}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button variant="ghost" onClick={() => setPickingFromCatalog(true)}>
            Agregar del catálogo
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <IconPlus size={14} /> Nueva obra social
          </Button>
        </div>
      </header>
      {insurers.length === 0 ? (
        <div style={{ padding: 28, textAlign: "center", color: "var(--navy-500)" }}>
          No hay obras sociales cargadas.
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {insurers.map((i) => {
            const suggestion = !i.payerId && !i.isParticular ? suggestions[i.id] : undefined;
            return (
              <li
                key={i.id}
                onClick={() => setEditing(i)}
                style={{
                  padding: "14px 20px",
                  display: "grid",
                  gridTemplateColumns: "1.4fr 110px 110px 80px 80px",
                  gap: 14,
                  alignItems: "center",
                  borderBottom: "1px solid rgba(15,30,51,0.04)",
                  cursor: "pointer",
                  opacity: i.active ? 1 : 0.55,
                }}
              >
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {i.name}
                    {i.isParticular && <Tag tone="soft">Por defecto</Tag>}
                    {i.payerName && (
                      <span title="Vinculada al catálogo de prestadoras">
                        <Tag tone="sky">Catálogo{i.payerName !== i.name ? `: ${i.payerName}` : ""}</Tag>
                      </span>
                    )}
                  </div>
                  {i.isParticular ? (
                    <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
                      Pacientes sin obra social. Ajustá el copago = precio particular.
                    </div>
                  ) : (
                    i.notes && <div style={{ fontSize: 12, color: "var(--navy-500)" }}>{i.notes}</div>
                  )}
                  {suggestion && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        link(i, suggestion);
                      }}
                      style={{
                        marginTop: 4,
                        background: "transparent",
                        border: "none",
                        color: "var(--sky-700)",
                        cursor: busy ? "wait" : "pointer",
                        fontSize: 12,
                        fontWeight: 700,
                        padding: 0,
                      }}
                    >
                      Vincular a {suggestion.name}
                    </button>
                  )}
                </div>
                <Money label="Copago" amount={i.copagoCents} />
                <Money label="Monto fijo" amount={i.fixedFeeCents} />
                <div style={{ fontSize: 11, color: "var(--navy-300)", textAlign: "right" }}>
                  {i.patientsCount} pac.
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  {i.active ? <Tag tone="lime">Activa</Tag> : <Tag tone="soft">Inactiva</Tag>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {pickingFromCatalog && (
        <PayerPickerModal
          title="Agregar del catálogo"
          description="Elegí la prestadora: la agregamos con su nombre y después cargás el copago y el monto fijo."
          linkedPayerIds={linkedPayerIds}
          busy={busy}
          onPick={addFromCatalog}
          onClose={() => setPickingFromCatalog(false)}
        />
      )}
      {creating && <InsurerModal onClose={() => setCreating(false)} />}
      {editing && (
        <InsurerModal
          insurer={editing}
          suggestion={suggestions[editing.id]}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function Money({ label, amount }: { label: string; amount: number }) {
  return (
    <div style={{ textAlign: "right" }}>
      <div style={{ fontSize: 10, color: "var(--navy-300)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {label}
      </div>
      <div className="k-mono" style={{ fontSize: 13, fontWeight: 700 }}>
        {amount > 0 ? formatARS(amount) : "—"}
      </div>
    </div>
  );
}

function InsurerModal({
  insurer,
  suggestion,
  onClose,
}: {
  insurer?: InsurerRow;
  suggestion?: PayerOption;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(insurer?.active ?? true);
  const payeeCopy = usePayeeCopy();
  // Montos controlados en centavos (MoneyInput, A2b-S-cfg). Antes eran
  // `type=number step=50` + `parseARS`, con el error ×100 del punto decimal.
  const [copagoCents, setCopagoCents] = useState<number | null>(insurer?.copagoCents ?? 0);
  const [fixedFeeCents, setFixedFeeCents] = useState<number | null>(insurer?.fixedFeeCents ?? 0);
  const [invalid, setInvalid] = useState({ copago: false, fixedFee: false });
  const copagoChanged = !!insurer && (copagoCents ?? 0) !== insurer.copagoCents;

  const submit = (formData: FormData) => {
    setError(null);
    if (invalid.copago || invalid.fixedFee) {
      setError("Revisá los montos: hay uno que no es válido.");
      return;
    }
    start(async () => {
      const payload = {
        name: String(formData.get("name") ?? ""),
        copagoCents: copagoCents ?? 0,
        fixedFeeCents: fixedFeeCents ?? 0,
        active,
        notes: String(formData.get("notes") ?? ""),
      };
      const r = insurer
        ? await updateInsurer(insurer.id, payload)
        : await createInsurer(payload);
      if (!r.ok) setError(r.error);
      else {
        onClose();
        router.refresh();
      }
    });
  };

  const confirm = useConfirm();
  const onDelete = async () => {
    if (!insurer) return;
    const ok = await confirm({
      title: `¿Eliminar "${insurer.name}"?`,
      message: "Si tiene pacientes asociados, se desactiva en su lugar.",
      confirmLabel: "Eliminar",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      const r = await deleteInsurer(insurer.id);
      if (!r.ok) setError(r.error);
      else {
        onClose();
        router.refresh();
      }
    });
  };

  return (
    <Modal
      onClose={onClose}
      title={insurer ? "Editar obra social" : "Nueva obra social"}
      width={520}
    >
      <form action={submit} style={{ display: "grid", gap: 12 }}>
        <FormField label="Nombre" name="name" required defaultValue={insurer?.name ?? ""} placeholder="OSDE, Swiss Medical…" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <MoneyInput
            label="Copago (paciente, ARS)"
            value={copagoCents}
            onChange={setCopagoCents}
            onInvalidChange={(v) => setInvalid((p) => ({ ...p, copago: v }))}
            hint={
              copagoChanged
                ? "Afecta los turnos no cobrados sin copago propio."
                : `Lo que paga el paciente ${payeeCopy.unit}`
            }
          />
          <MoneyInput
            label="Monto fijo (prestadora, ARS)"
            value={fixedFeeCents}
            onChange={setFixedFeeCents}
            onInvalidChange={(v) => setInvalid((p) => ({ ...p, fixedFee: v }))}
            hint={`Lo que abona la prestadora ${payeeCopy.payee}`}
          />
        </div>
        {insurer && !insurer.isParticular && (
          <CatalogLinkSection insurer={insurer} suggestion={suggestion} onLinked={onClose} />
        )}
        <FormField as="textarea" label="Notas internas" name="notes" defaultValue={insurer?.notes ?? ""} />

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          Activa (aparece en el selector de cobertura)
        </label>

        {error && <ErrorBox>{error}</ErrorBox>}

        <div
          style={{
            display: "flex",
            justifyContent: insurer && !insurer.isParticular ? "space-between" : "flex-end",
            alignItems: "center",
            marginTop: 6,
          }}
        >
          {insurer && !insurer.isParticular && (
            <button
              type="button"
              onClick={onDelete}
              disabled={pending}
              style={{
                background: "transparent",
                border: "none",
                color: "#9F1F1F",
                cursor: "pointer",
                fontSize: 12.5,
                fontWeight: 700,
              }}
            >
              Eliminar
            </button>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Guardando…" : "Guardar"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Vínculo de la OS con el catálogo global (B1.4): vincular / cambiar /
 * desvincular, más los planes de la prestadora como información. Acción
 * propia (no viaja con el submit del form): no toca nombre ni montos.
 */
function CatalogLinkSection({
  insurer,
  suggestion,
  onLinked,
}: {
  insurer: InsurerRow;
  suggestion?: PayerOption;
  onLinked: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [picking, setPicking] = useState(false);
  const [pending, start] = useTransition();

  const setPayer = (payer: PayerOption | null) =>
    start(async () => {
      const r = await linkInsurerToPayer(insurer.id, payer?.id ?? null);
      if (!r.ok) {
        toast.error(payer ? "No pudimos vincular" : "No pudimos desvincular", { description: r.error });
        return;
      }
      toast.success(payer ? `Vinculada a ${payer.name}` : "Desvinculada del catálogo");
      setPicking(false);
      onLinked();
      router.refresh();
    });

  const unlink = async () => {
    const ok = await confirm({
      title: "¿Desvincular del catálogo?",
      message: "La obra social, sus pacientes, el copago y el monto fijo quedan igual.",
      confirmLabel: "Desvincular",
    });
    if (ok) setPayer(null);
  };

  const linkStyle = {
    background: "transparent",
    border: "none",
    color: "var(--sky-700)",
    cursor: pending ? "wait" : "pointer",
    fontSize: 12.5,
    fontWeight: 700,
    padding: 0,
  } as const;

  return (
    <div
      style={{
        display: "grid",
        gap: 8,
        padding: "10px 12px",
        borderRadius: 12,
        border: "1px solid rgba(15,30,51,0.08)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
        <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>Prestadora del catálogo:</span>
        {insurer.payerId ? (
          <>
            <Tag tone="sky">{insurer.payerName}</Tag>
            <button type="button" disabled={pending} onClick={() => setPicking(true)} style={linkStyle}>
              Cambiar
            </button>
            <button type="button" disabled={pending} onClick={unlink} style={{ ...linkStyle, color: "#9F1F1F" }}>
              Desvincular
            </button>
          </>
        ) : (
          <>
            <span style={{ color: "var(--navy-300)" }}>sin vincular</span>
            {suggestion && (
              <button type="button" disabled={pending} onClick={() => setPayer(suggestion)} style={linkStyle}>
                Vincular a {suggestion.name}
              </button>
            )}
            <button type="button" disabled={pending} onClick={() => setPicking(true)} style={linkStyle}>
              {suggestion ? "Elegir otra" : "Vincular"}
            </button>
          </>
        )}
      </div>
      {insurer.payerId && <PayerPlansInfo payerId={insurer.payerId} />}
      {picking && (
        <PayerPickerModal
          title={`Vincular «${insurer.name}» al catálogo`}
          busy={pending}
          onPick={(p) => setPayer(p)}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

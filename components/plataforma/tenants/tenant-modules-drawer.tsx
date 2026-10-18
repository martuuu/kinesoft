"use client";

/**
 * T3c-1p (plan §23.6) · Drawer «Editar módulos» de Plataforma → consultorio → Suscripción.
 *
 * Cada módulo que se puede tocar elige «Según el plan», «Habilitado a mano» o «Deshabilitado a mano» (por qué tres y
 * no un switch: `module-overrides-form.ts`); al lado, el estado que va a ver el consultorio, recalculado sobre el
 * borrador. Lo básico y lo que no existe en la vertical no aparecen (en la tabla de la pestaña van con candado).
 *
 * Dependencias (regla 4 del brief, `lib/tenant-module-deps.ts`): si el borrador deja Sesiones sin Planes (o
 * Favoritos sin Ejercicios), se avisa con el mismo copy del server y un botón que los saca juntos; guardar queda
 * deshabilitado mientras tanto. El server lo rechaza igual (el Drawer es UX, la barrera es el escritor).
 *
 * `usePlatformAction`: la clave `tenant.modules.update` es high, así que la action pide el step-up de la 2FA (o la
 * re-verificación TOTP con `enforce`) y el wrapper muestra el modal y reintenta. CAS como `TenantEditDrawer`: la
 * versión sale del detalle y, después de guardar, de la respuesta (el refresh puede llegar tarde).
 */
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { setTenantModuleOverrides } from "@/lib/platform-tenant-modules";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import { ErrorBox, WarnBox } from "@/components/plataforma/tenants/detail-ui";
import { moduleName } from "@/components/plataforma/tenants/labels";
import { VERTICAL_LABEL, type TenantModule } from "@/lib/tenant-modules";
import { moduleDependencyCopy } from "@/lib/tenant-module-deps";
import type { PlatformTenantDetail } from "@/lib/platform-tenants-types";
import {
  MODULE_STATE_TONE,
  TURNERO_ROW_HINT,
  buildModuleOverridesPayload,
  choiceOf,
  choiceOptions,
  draftEntitlements,
  draftViolations,
  formFromLists,
  includedByPlan,
  isOverridesDirty,
  moduleTableRows,
  setChoice,
  withDependentsOff,
  type ModuleChoice,
  type ModuleOverridesForm,
  type ModuleTenantBase,
} from "@/components/plataforma/tenants/module-overrides-form";

/** Módulos que el borrador apaga y hoy están prendidos: lo que el equipo deja de ver al guardar. */
export function newlyDisabled(base: ModuleTenantBase, saved: ModuleOverridesForm, draft: ModuleOverridesForm): TenantModule[] {
  const before = moduleTableRows(draftEntitlements(base, saved));
  const after = new Map(moduleTableRows(draftEntitlements(base, draft)).map((r) => [r.module, r.state]));
  return before
    .filter((r) => (r.state === "plan" || r.state === "granted") && (after.get(r.module) === "revoked" || after.get(r.module) === "absent"))
    .map((r) => r.module);
}

/** Cuerpo del Drawer, controlado y sin efectos (render test). */
export function TenantModulesForm({
  base,
  form,
  dirty,
  pending,
  error,
  onChoice,
  onFixDependents,
  onSubmit,
  onCancel,
}: {
  base: ModuleTenantBase;
  form: ModuleOverridesForm;
  dirty: boolean;
  pending: boolean;
  error: string | null;
  onChoice: (m: TenantModule, c: ModuleChoice) => void;
  onFixDependents: (index: number) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const rows = moduleTableRows(draftEntitlements(base, form)).filter((r) => !r.locked);
  const violations = draftViolations(base, form);
  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 14 }}>
      <ul aria-label="Módulos que se pueden cambiar" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
        {rows.map((r) => {
          const current = choiceOf(form, r.module);
          const id = `module-choice-${r.module}`;
          return (
            <li key={r.module} style={{ display: "grid", gap: 6, paddingBottom: 10, borderBottom: "1px solid rgba(15,30,51,0.06)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <label htmlFor={id} style={{ fontSize: 13.5, fontWeight: 600, color: "var(--navy-900)" }}>
                  {r.name}
                </label>
                <Tag tone={MODULE_STATE_TONE[r.state]} variant={r.state === "absent" ? "outline" : "fill"}>
                  {r.stateLabel}
                </Tag>
              </div>
              <select
                id={id}
                className="k-input"
                value={current}
                disabled={pending}
                onChange={(e) => onChoice(r.module, e.target.value as ModuleChoice)}
              >
                {choiceOptions(includedByPlan(base, r.module), current).map((o) => (
                  // Fondo sólido como `FormField`: sin `#fff` algunos modos de color pintan el popup nativo transparente.
                  <option key={o.value} value={o.value} style={{ background: "#fff", color: "var(--navy-900)" }}>
                    {o.label}
                  </option>
                ))}
              </select>
            </li>
          );
        })}
      </ul>
      <p style={{ margin: 0, fontSize: 12, color: "var(--navy-300)", lineHeight: 1.45 }}>
        Lo básico (agenda, pacientes, facturación, obras sociales y evoluciones) y lo que no existe para{" "}
        {VERTICAL_LABEL[base.vertical]} no se toca. Turnos online: {TURNERO_ROW_HINT.charAt(0).toLowerCase() + TURNERO_ROW_HINT.slice(1)}
      </p>

      {violations.map((v, i) => (
        <WarnBox key={v.module}>
          <span style={{ display: "grid", gap: 8 }}>
            <span>{moduleDependencyCopy(v, moduleName)}</span>
            <span>
              <Button type="button" variant="ghost" onClick={() => onFixDependents(i)} disabled={pending}>
                Deshabilitar también {v.dependents.map(moduleName).join(" y ")}
              </Button>
            </span>
          </span>
        </WarnBox>
      ))}

      {error && <ErrorBox>{error}</ErrorBox>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={!dirty || pending || violations.length > 0}>
          {pending ? "Guardando…" : "Guardar cambios"}
        </Button>
      </div>
    </form>
  );
}

export function TenantModulesDrawer({ detail }: { detail: PlatformTenantDetail }) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const runPlatform = usePlatformAction();

  const base: ModuleTenantBase = { vertical: detail.vertical, plan: detail.saasPlan, publicBookingEnabled: detail.publicBookingEnabled };
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(detail.updatedAt);
  const [baseline, setBaseline] = useState<ModuleOverridesForm>(() => formFromLists(detail.moduleGrants, detail.moduleRevokes));
  const [form, setForm] = useState<ModuleOverridesForm>(baseline);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Otra versión del server (otro guardado o el propio refresh): se resincroniza la baseline. Con el Drawer abierto
  // no se pisa lo que eligió el superadmin; el CAS del próximo guardado decide (stale → recargá y revisá).
  useEffect(() => {
    setVersion(detail.updatedAt);
    setBaseline(formFromLists(detail.moduleGrants, detail.moduleRevokes));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.updatedAt]);

  const dirty = isOverridesDirty(baseline, form);

  const openDrawer = () => {
    setForm(baseline);
    setError(null);
    setOpen(true);
  };

  const onFixDependents = (index: number) => {
    const v = draftViolations(base, form)[index];
    if (v) setForm((f) => withDependentsOff(base, f, v));
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!dirty || pending || draftViolations(base, form).length > 0) return;
    const off = newlyDisabled(base, baseline, form);
    if (off.length > 0) {
      const ok = await confirm({
        title: off.length === 1 ? `¿Deshabilitar ${moduleName(off[0])}?` : "¿Deshabilitar estos módulos?",
        message: `${off.map(moduleName).join(", ")}: el equipo de ${detail.name} deja de ${off.length === 1 ? "verlo" : "verlos"} en el acto. No se borra nada; si ${off.length === 1 ? "lo" : "los"} volvés a habilitar, está todo como estaba.`,
        confirmLabel: "Deshabilitar",
        cancelLabel: "Volver",
        tone: "danger",
      });
      if (!ok) return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await runPlatform(() => setTenantModuleOverrides(buildModuleOverridesPayload(detail.id, version, form)));
      if (!res.ok) {
        setError(res.error);
        // refresh-ok: la action falló y no revalida; trae la versión actual para el próximo intento (mismo porqué que
        // `TenantEditDrawer`).
        router.refresh();
        return;
      }
      setVersion(res.data.updatedAt);
      setBaseline(form);
      setOpen(false);
      toast.success(res.data.changed ? "Módulos actualizados" : "No había cambios");
    } catch {
      setError("No se pudo guardar el cambio. Revisá la conexión y probá de nuevo.");
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Button type="button" variant="ghost" onClick={openDrawer}>
        Editar módulos
      </Button>
      <Drawer open={open} onClose={() => setOpen(false)} title="Editar módulos" dirty={dirty} width={480}>
        <p style={{ marginTop: 0, marginBottom: 16, fontSize: 13, color: "var(--navy-500)", lineHeight: 1.45 }}>
          {detail.name} · <span style={{ fontFamily: "var(--font-mono)" }}>{detail.slug}</span>
        </p>
        <TenantModulesForm
          base={base}
          form={form}
          dirty={dirty}
          pending={pending}
          error={error}
          onChoice={(m, c) => setForm((f) => setChoice(f, m, c))}
          onFixDependents={onFixDependents}
          onSubmit={(e) => void onSubmit(e)}
          onCancel={() => setOpen(false)}
        />
      </Drawer>
    </>
  );
}

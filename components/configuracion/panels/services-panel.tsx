"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { FormField } from "@/components/ui/form-field";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { IconPlus } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { MoneyInput } from "@/components/ui/money-input";
import { formatARS } from "@/lib/format";
import { SERVICE_COLORS } from "@/lib/service-colors";
import { DISCIPLINES, type Discipline } from "@/lib/plans-constants";
import { disciplineLabel } from "@/lib/plan-display";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import type { ServiceRow } from "@/lib/services-types";
import {
  createService,
  updateService,
  deleteService,
} from "@/lib/services";
import { ErrorBox } from "../controls";
import styles from "../configuracion.module.css";
import { PracticePicker, type PickedPractice } from "../catalog/practice-picker";

// [PF1.1-config · C-PF4] Sin `router.refresh()` después de las actions de este archivo: todas revalidan `/configuracion`
// y la respuesta de la action ya trae el árbol nuevo (un refresh era un segundo render entero, PF-0d).

export function ServicesPanel({
  services,
  practitioners,
}: {
  services: ServiceRow[];
  practitioners: { id: string; name: string }[];
}) {
  const [editing, setEditing] = useState<ServiceRow | null>(null);
  const [creating, setCreating] = useState(false);
  // Enmienda EV0 de S13: la disciplina solo existe con `planes`. Esconderla es
  // UX; la barrera es `createService`/`updateService`.
  const hasPlanes = useTenantModules().has("planes");
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <header
        style={{
          padding: "16px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid rgba(15,30,51,0.06)",
        }}
      >
        <div>
          <EyebrowLabel>Servicios del consultorio</EyebrowLabel>
          <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 4 }}>
            Aparecen en el modal de nuevo turno y en el turnero público.
          </div>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <IconPlus size={14} /> Nuevo servicio
        </Button>
      </header>
      {services.length === 0 ? (
        <div style={{ padding: 28, textAlign: "center", color: "var(--navy-500)" }}>
          Todavía no cargaste servicios. Creá el primero arriba.
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {services.map((s) => (
            // [PF1.1-config · C6] La fila es un <button> (antes un <li onClick>: sin teclado ni foco) con columnas de
            // ancho fijo (antes «Profesional» flotaba al centro) y el conteo en gris AA (antes --navy-300, ilegible).
            // < 768 se apila (configuracion.module.css): a 390 la grilla de 5 columnas desbordaba.
            <li key={s.id}>
              <button type="button" className={styles.serviceRow} onClick={() => setEditing(s)} aria-label={`Editar ${s.name}`}>
                <span className={styles.serviceMain}>
                  <span style={{ fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 8, color: "var(--navy-900)" }}>
                    <span
                      aria-hidden
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: 999,
                        background: s.color ?? "rgba(15,30,51,0.12)",
                        // El color del servicio es pastel (es la barra de la agenda): el borde lo separa del blanco.
                        boxShadow: "inset 0 0 0 1px rgba(15,30,51,0.18)",
                        flexShrink: 0,
                      }}
                    />
                    <span className={styles.ellipsis} title={s.name}>{s.name}</span>
                  </span>
                  {s.description && (
                    <span className={styles.ellipsis} style={{ fontSize: 12, color: "var(--navy-500)" }} title={s.description}>
                      {s.description}
                    </span>
                  )}
                  {s.practiceName && (
                    <span style={{ display: "block", fontSize: 11, color: "var(--navy-500)" }}>Práctica: {s.practiceName}</span>
                  )}
                  {hasPlanes && s.discipline && (
                    <span style={{ display: "block", fontSize: 11, color: "var(--navy-500)" }}>
                      Disciplina: {disciplineLabel(s.discipline)}
                    </span>
                  )}
                </span>
                <span className={styles.ellipsis} style={{ fontSize: 13, color: "var(--navy-500)" }} title={s.practitionerName ?? undefined}>
                  {s.practitionerName ?? "Todos los profesionales"}
                </span>
                <span className={`k-mono ${styles.num}`} style={{ fontSize: 12, color: "var(--navy-500)" }}>
                  {s.durationMin} min
                  {s.maxConcurrent != null && (
                    <span style={{ display: "block", fontSize: 11, color: "var(--navy-500)" }}>{s.maxConcurrent}/horario</span>
                  )}
                </span>
                <span className={`k-mono ${styles.num}`} style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-900)" }}>
                  {s.priceCents > 0 ? formatARS(s.priceCents) : "—"}
                </span>
                <span className={styles.num} style={{ fontSize: 12, color: "var(--navy-500)" }}>
                  {s.bookingsCount} {s.bookingsCount === 1 ? "turno" : "turnos"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <ServiceModal
          practitioners={practitioners}
          hasPlanes={hasPlanes}
          onClose={() => setCreating(false)}
        />
      )}
      {editing && (
        <ServiceModal
          practitioners={practitioners}
          hasPlanes={hasPlanes}
          service={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function ServiceModal({
  practitioners,
  hasPlanes,
  service,
  onClose,
}: {
  practitioners: { id: string; name: string }[];
  hasPlanes: boolean;
  service?: ServiceRow;
  onClose: () => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [color, setColor] = useState<string | null>(service?.color ?? null);
  // Precio controlado en centavos (MoneyInput). Antes era `type=number
  // step=50` leído con `parseARS`: "1500.5" del input numérico se leía como
  // miles → ×100 (A2b-S-cfg).
  const [priceCents, setPriceCents] = useState<number | null>(service?.priceCents ?? 0);
  const [priceInvalid, setPriceInvalid] = useState(false);
  const priceChanged = !!service && (priceCents ?? 0) !== service.priceCents;
  // Práctica del catálogo (B1.4) y duración controlada: al CREAR, elegir una
  // práctica con `defaultDurationMin` la aplica si el usuario todavía no tocó
  // la duración; si la tocó (o al editar), solo se ofrece como sugerencia.
  const [practice, setPractice] = useState<PickedPractice | null>(
    service?.practiceId ? { id: service.practiceId, name: service.practiceName ?? "Práctica" } : null
  );
  const [durationMin, setDurationMin] = useState<string>(String(service?.durationMin ?? 45));
  const [durationTouched, setDurationTouched] = useState(false);
  const suggestedDuration = practice?.defaultDurationMin ?? null;
  const showDurationSuggestion =
    suggestedDuration != null && String(suggestedDuration) !== durationMin;
  // S13 · PQ-11: disciplina sugerida por el catálogo, igual que la duración:
  // se ofrece y el admin la confirma; nunca se aplica sola. Solo se conoce la
  // de la práctica GUARDADA (viene en la fila): si se elige otra práctica en
  // el drawer, no hay sugerencia hasta guardar.
  const [discipline, setDiscipline] = useState<Discipline | "">(service?.discipline ?? "");
  const suggestedDiscipline =
    service?.suggestedDiscipline && practice?.id === service.practiceId
      ? service.suggestedDiscipline
      : null;
  const showDisciplineSuggestion =
    hasPlanes && suggestedDiscipline != null && suggestedDiscipline !== discipline;

  const submit = (formData: FormData) => {
    setError(null);
    if (priceInvalid) {
      setError("Revisá el precio: el monto no es válido.");
      return;
    }
    start(async () => {
      const payload = {
        name: String(formData.get("name") ?? ""),
        description: String(formData.get("description") ?? ""),
        durationMin: Number(formData.get("durationMin") ?? 45),
        practiceId: String(formData.get("practiceId") ?? ""),
        priceCents: priceCents ?? 0,
        practitionerId: String(formData.get("practitionerId") ?? ""),
        maxConcurrent: String(formData.get("maxConcurrent") ?? ""),
        color: String(formData.get("color") ?? ""),
        // Sin `planes` el campo no existe y NO se manda: ausente = la action no
        // toca la disciplina (mandar "" la borraría).
        ...(hasPlanes ? { discipline } : {}),
      };
      const r = service
        ? await updateService(service.id, payload)
        : await createService(payload);
      if (!r.ok) setError(r.error);
      else {
        onClose();
      }
    });
  };

  const confirm = useConfirm();
  const onDelete = async () => {
    if (!service) return;
    const ok = await confirm({
      title: `¿Eliminar el servicio "${service.name}"?`,
      confirmLabel: "Eliminar",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      const r = await deleteService(service.id);
      if (!r.ok) setError(r.error);
      else {
        onClose();
      }
    });
  };

  return (
    <Drawer open onClose={onClose} title={service ? "Editar servicio" : "Nuevo servicio"} width={480}>
      <form action={submit} style={{ display: "grid", gap: 12 }}>
        <FormField label="Nombre" name="name" required defaultValue={service?.name ?? ""} />
        <FormField
          as="textarea"
          label="Descripción"
          name="description"
          defaultValue={service?.description ?? ""}
        />
        <div className={styles.twoCol}>
          <FormField
            label="Duración (min)"
            name="durationMin"
            type="number"
            min={5}
            max={480}
            value={durationMin}
            onChange={(v) => {
              setDurationMin(v);
              setDurationTouched(true);
            }}
            required
          />
          <MoneyInput
            label="Precio (ARS)"
            value={priceCents}
            onChange={setPriceCents}
            onInvalidChange={setPriceInvalid}
            hint={
              priceChanged
                ? "Solo cambia lo que se cobra en turnos sin cobrar que no tengan copago propio, de la obra social, del precio Particular ni del plan."
                : undefined
            }
          />
        </div>
        <PracticePicker
          value={practice}
          onChange={(p) => {
            setPractice(p);
            if (!service && !durationTouched && p?.defaultDurationMin != null) {
              setDurationMin(String(p.defaultDurationMin));
            }
          }}
        />
        {showDurationSuggestion && (
          <div style={{ fontSize: 12, color: "var(--navy-500)", marginTop: -4 }}>
            Duración sugerida para esta práctica: {suggestedDuration} min.{" "}
            <button
              type="button"
              onClick={() => setDurationMin(String(suggestedDuration))}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--sky-700)",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 700,
                padding: 0,
              }}
            >
              Usar {suggestedDuration} min
            </button>
          </div>
        )}
        {hasPlanes && (
          <FormField
            as="select"
            label="Disciplina"
            name="discipline"
            value={discipline}
            onChange={(v) => setDiscipline(v as Discipline | "")}
            options={[
              { value: "", label: "Sin disciplina" },
              ...DISCIPLINES.map((d) => ({ value: d, label: disciplineLabel(d) })),
            ]}
            hint="Los planes de esa disciplina ofrecen este servicio. Sin disciplina, lo ofrecen todos."
          />
        )}
        {showDisciplineSuggestion && suggestedDiscipline && (
          <div style={{ fontSize: 12, color: "var(--navy-500)", marginTop: -4 }}>
            Por la práctica, sugerimos {disciplineLabel(suggestedDiscipline)}.{" "}
            <button
              type="button"
              onClick={() => setDiscipline(suggestedDiscipline)}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--sky-700)",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 700,
                padding: 0,
              }}
            >
              Usar {disciplineLabel(suggestedDiscipline)}
            </button>
          </div>
        )}
        <FormField
          label="Cupos simultáneos por horario"
          name="maxConcurrent"
          type="number"
          min={1}
          max={50}
          placeholder="Ilimitado"
          defaultValue={service?.maxConcurrent ?? ""}
          // EV1-C2: el ejemplo de kinesiología/osteopatía solo tiene sentido en esa vertical
          // (`hasPlanes` la distingue: Clínica general no tiene el módulo `planes`).
          hint={
            hasPlanes
              ? "Vacío = ilimitado (kinesiología: varios pacientes en paralelo). Poné 1 para osteopatía (un turno por horario)."
              : "Vacío = ilimitado (varios pacientes en paralelo). Poné 1 para un solo turno por horario."
          }
        />
        <FormField
          as="select"
          label="Profesional asignado"
          name="practitionerId"
          defaultValue={service?.practitionerId ?? ""}
          options={[
            { value: "", label: "Todos los profesionales" },
            ...practitioners.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />

        <div style={{ fontSize: 12, minWidth: 0 }}>
          <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>Color</span>
          <input type="hidden" name="color" value={color ?? ""} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            {SERVICE_COLORS.map((c) => {
              const selected = color === c;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(selected ? null : c)}
                  aria-pressed={selected}
                  aria-label={selected ? "Quitar color" : `Elegir color ${c}`}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 999,
                    background: c,
                    cursor: "pointer",
                    padding: 0,
                    border: selected
                      ? "2px solid var(--navy-900)"
                      : "1px solid rgba(15,30,51,0.12)",
                    boxShadow: selected ? "0 0 0 2px #fff inset" : undefined,
                  }}
                />
              );
            })}
          </div>
        </div>

        {error && <ErrorBox>{error}</ErrorBox>}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginTop: 6,
          }}
        >
          <Button
            type="submit"
            variant="primary"
            disabled={pending}
            style={{ width: "100%", justifyContent: "center" }}
          >
            {pending ? "Guardando…" : "Guardar"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={pending}
            style={{ width: "100%", justifyContent: "center" }}
          >
            Cancelar
          </Button>
          {service && (
            <button
              type="button"
              onClick={onDelete}
              disabled={pending}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--danger-fg)",
                cursor: "pointer",
                fontSize: 12.5,
                fontWeight: 700,
                width: "100%",
                textAlign: "center",
                padding: "6px 0",
              }}
            >
              Eliminar
            </button>
          )}
        </div>
      </form>
    </Drawer>
  );
}

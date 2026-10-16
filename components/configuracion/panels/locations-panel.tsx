"use client";

/**
 * Configuración › Sedes (B3.4 CFG-UI-1, B-pre).
 *
 * La sede define DÓNDE hay disponibilidad (franjas por sede) y dónde se
 * muestra cada turno. Reglas que vienen de `lib/locations.ts` y que la UI
 * hace visibles en vez de esconder:
 *   • siempre hay una principal (los turnos sin sede y el horario heredado del
 *     consultorio caen ahí), y no se archiva;
 *   • archivar = desactivar, nunca borrar (el historial de turnos sigue
 *     diciendo dónde fue). Si la sede todavía tiene franjas, turnos futuros o
 *     días especiales, la action devuelve los conteos y acá se muestran con
 *     el camino para resolverlo;
 *   • restaurar existe porque archivar por error no puede no tener vuelta.
 *
 * Salas (corrida SR, SR-U1): cada sede activa muestra "N salas" y un
 * disclosure que monta `RoomsSection`. Se carga con `dynamic()` recién al
 * abrirlo: `/configuracion` ya pasa el presupuesto de bundle y la mayoría de
 * los consultorios no carga salas (sin salas, todo se ve como antes salvo la
 * línea "Sin salas" y el link).
 */
import { useRef, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { FormField } from "@/components/ui/form-field";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { Tag } from "@/components/ui/tag";
import { IconPlus } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { useFormDirty } from "@/components/ui/use-form-dirty";
import type { LocationArchiveBlockers, LocationRow } from "@/lib/locations-schemas";
import type { RoomRow } from "@/lib/rooms-types";
import {
  archiveLocation,
  createLocation,
  restoreLocation,
  setPrimaryLocation,
  updateLocation,
} from "@/lib/locations";
import { ErrorBox } from "../controls";

// [PF1.1-config · C-PF4] Sin `router.refresh()` después de las actions de este archivo: todas revalidan `/configuracion`
// y la respuesta de la action ya trae el árbol nuevo (un refresh era un segundo render entero, PF-0d).

const RoomsSection = dynamic(() => import("./rooms-section").then((m) => m.RoomsSection), {
  ssr: false,
  loading: () => <div style={{ fontSize: 12, color: "var(--navy-300)", padding: "6px 0" }}>Cargando salas…</div>,
});

/**
 * "N salas" de la línea de la sede. Duplica `roomCountText` de
 * `rooms-section.tsx` a propósito: importarlo de ahí metería ese módulo en el
 * bundle inicial y anularía el `dynamic()` de arriba.
 */
function roomCountLine(n: number): string {
  return n <= 0 ? "Sin salas" : `${n} sala${n === 1 ? "" : "s"}`;
}

const linkBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--sky-700)",
  cursor: "pointer",
  fontSize: 12.5,
  fontWeight: 700,
  padding: "6px 4px",
  minHeight: 32,
};

function addressLine(l: LocationRow): string {
  const street = [l.address, l.addressLine2].filter(Boolean).join(" ");
  const place = [l.city, l.province].filter(Boolean).join(", ");
  return [street, place, l.postalCode ? `CP ${l.postalCode}` : null].filter(Boolean).join(" · ");
}

export function LocationsPanel({
  locations,
  rooms = [],
}: {
  locations: LocationRow[];
  /** Todas las salas del consultorio, archivadas incluidas (SR-U1). */
  rooms?: RoomRow[];
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<LocationRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // Sedes con el disclosure de salas abierto.
  const [openRooms, setOpenRooms] = useState<ReadonlySet<string>>(() => new Set());
  const toggleRooms = (id: string) =>
    setOpenRooms((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const activeRoomCount = (locationId: string) =>
    rooms.filter((r) => r.locationId === locationId && r.active).length;
  // Bloqueos del último intento de archivar, por sede (se muestran en su fila).
  const [blocked, setBlocked] = useState<{ id: string; error: string; blockers?: LocationArchiveBlockers } | null>(
    null
  );

  const active = locations.filter((l) => l.active);
  const archived = locations.filter((l) => !l.active);

  const onMakePrimary = async (l: LocationRow) => {
    const ok = await confirm({
      title: `¿Hacer principal "${l.name}"?`,
      message:
        "Los turnos sin sede asignada y el horario heredado del consultorio pasan a mostrarse en esta sede.",
      confirmLabel: "Hacer principal",
    });
    if (!ok) return;
    start(async () => {
      const r = await setPrimaryLocation(l.id);
      if (!r.ok) toast.error("No se pudo cambiar la principal", { description: r.error });
      else {
        toast.success(`${l.name} es ahora la sede principal`);
        setBlocked(null);
      }
    });
  };

  const onArchive = async (l: LocationRow) => {
    const ok = await confirm({
      title: `¿Archivar "${l.name}"?`,
      message:
        "Deja de ofrecerse en la agenda y en el turnero, junto con sus salas. Los turnos pasados siguen mostrando esta sede. Podés restaurarla cuando quieras.",
      confirmLabel: "Archivar",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      const r = await archiveLocation(l.id);
      if (!r.ok) {
        setBlocked({ id: l.id, error: r.error, blockers: r.blockers });
        return;
      }
      setBlocked(null);
      toast.success(`${l.name} archivada`);
    });
  };

  const onRestore = (l: LocationRow) => {
    start(async () => {
      const r = await restoreLocation(l.id);
      if (!r.ok) toast.error("No se pudo restaurar", { description: r.error });
      else {
        toast.success(`${l.name} restaurada`);
      }
    });
  };

  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <header
        style={{
          padding: "16px 20px",
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid rgba(15,30,51,0.06)",
        }}
      >
        <div style={{ minWidth: 0, flex: "1 1 240px" }}>
          <EyebrowLabel>Sedes del consultorio</EyebrowLabel>
          <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 4 }}>
            Dónde atendés. Cada franja de horario de un profesional va en una sede.
          </div>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)} disabled={pending}>
          <IconPlus size={14} /> Nueva sede
        </Button>
      </header>

      {active.length === 0 ? (
        <div style={{ padding: 28, textAlign: "center", color: "var(--navy-500)", fontSize: 13 }}>
          No hay sedes activas. Creá la primera: va a quedar como principal.
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {active.map((l) => (
            <li
              key={l.id}
              style={{
                padding: "14px 20px",
                borderBottom: "1px solid rgba(15,30,51,0.04)",
                background: l.isPrimary ? "var(--sky-50)" : undefined,
              }}
            >
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-start" }}>
                <button
                  type="button"
                  onClick={() => setEditing(l)}
                  aria-label={`Editar ${l.name}`}
                  style={{
                    flex: "1 1 220px",
                    minWidth: 0,
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: "inherit",
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 600, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                    {l.name}
                    {l.isPrimary && <Tag tone="lime">Principal</Tag>}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--navy-500)", marginTop: 2 }}>
                    {addressLine(l) || "Sin dirección cargada"}
                    {l.phone ? ` · Tel. ${l.phone}` : ""}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--navy-300)", marginTop: 2 }}>
                    {l.scheduleCount === 0
                      ? "Sin franjas de horario"
                      : `${l.scheduleCount} franja${l.scheduleCount === 1 ? "" : "s"} de horario`}
                    {` · ${roomCountLine(activeRoomCount(l.id))}`}
                  </div>
                </button>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                  <button type="button" style={linkBtn} onClick={() => setEditing(l)} disabled={pending}>
                    Editar
                  </button>
                  <button
                    type="button"
                    style={linkBtn}
                    onClick={() => toggleRooms(l.id)}
                    aria-expanded={openRooms.has(l.id)}
                    aria-controls={`rooms-of-${l.id}`}
                    aria-label={`${openRooms.has(l.id) ? "Ocultar" : "Ver"} salas de ${l.name}`}
                  >
                    {openRooms.has(l.id) ? "Ocultar salas" : "Salas"}
                  </button>
                  {!l.isPrimary && (
                    <>
                      <button type="button" style={linkBtn} onClick={() => onMakePrimary(l)} disabled={pending}>
                        Hacer principal
                      </button>
                      <button
                        type="button"
                        style={{ ...linkBtn, color: "var(--danger-fg)" }}
                        onClick={() => onArchive(l)}
                        disabled={pending}
                      >
                        Archivar
                      </button>
                    </>
                  )}
                </div>
              </div>
              {blocked?.id === l.id && (
                <div style={{ marginTop: 10 }}>
                  <ArchiveBlockers error={blocked.error} blockers={blocked.blockers} onDismiss={() => setBlocked(null)} />
                </div>
              )}
              {openRooms.has(l.id) && (
                <div
                  id={`rooms-of-${l.id}`}
                  style={{
                    marginTop: 10,
                    padding: "12px 12px 10px",
                    borderRadius: "var(--r-md)",
                    background: "rgba(15,30,51,0.03)",
                    minWidth: 0,
                  }}
                >
                  <RoomsSection locationId={l.id} locationName={l.name} rooms={rooms} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 && (
        <div style={{ padding: "10px 20px 14px" }}>
          <button
            type="button"
            style={{ ...linkBtn, color: "var(--navy-500)" }}
            onClick={() => setShowArchived((v) => !v)}
            aria-expanded={showArchived}
          >
            {showArchived ? "Ocultar" : "Ver"} archivadas ({archived.length})
          </button>
          {showArchived && (
            <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, display: "grid", gap: 6 }}>
              {archived.map((l) => (
                <li
                  key={l.id}
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 12px",
                    borderRadius: "var(--r-sm)",
                    background: "rgba(15,30,51,0.04)",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-500)" }}>{l.name}</div>
                    {addressLine(l) && (
                      <div style={{ fontSize: 11, color: "var(--navy-300)" }}>{addressLine(l)}</div>
                    )}
                  </div>
                  <button type="button" style={linkBtn} onClick={() => onRestore(l)} disabled={pending}>
                    Restaurar
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {creating && <LocationDrawer onClose={() => setCreating(false)} />}
      {editing && <LocationDrawer location={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

/** Qué impide archivar y dónde se resuelve cada cosa. */
function ArchiveBlockers({
  error,
  blockers,
  onDismiss,
}: {
  error: string;
  blockers?: LocationArchiveBlockers;
  onDismiss: () => void;
}) {
  const items = blockers
    ? [
        blockers.activeSchedules > 0 && {
          n: blockers.activeSchedules,
          what: blockers.activeSchedules === 1 ? "franja de horario" : "franjas de horario",
          how: "Movelas a otra sede en Profesionales › Horarios.",
        },
        blockers.futureBookings > 0 && {
          n: blockers.futureBookings,
          what: blockers.futureBookings === 1 ? "turno a futuro" : "turnos a futuro",
          how: "Reprogramalos o cambiales la sede desde la agenda.",
        },
        blockers.futureExceptions > 0 && {
          n: blockers.futureExceptions,
          what: blockers.futureExceptions === 1 ? "día con horario especial" : "días con horario especial",
          how: "Editalos o borralos en Profesionales › Excepciones.",
        },
      ].filter((x): x is { n: number; what: string; how: string } => !!x)
    : [];
  return (
    <ErrorBox>
      {items.length === 0 ? (
        error
      ) : (
        <>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Todavía no se puede archivar. Tiene:</div>
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }}>
            {items.map((it) => (
              <li key={it.what}>
                <strong>{it.n}</strong> {it.what}. {it.how}
              </li>
            ))}
          </ul>
        </>
      )}
      <button
        type="button"
        onClick={onDismiss}
        style={{ ...linkBtn, color: "var(--danger-fg)", padding: "4px 0 0", minHeight: 0 }}
      >
        Entendido
      </button>
    </ErrorBox>
  );
}

function LocationDrawer({ location, onClose }: { location?: LocationRow; onClose: () => void }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[] | undefined>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const { dirty, onFormInput } = useFormDirty(formRef);

  const submit = (fd: FormData) => {
    setError(null);
    setFieldErrors({});
    const str = (k: string) => String(fd.get(k) ?? "");
    // Se mandan TODOS los campos: "" = borrar (updateLocation lo guarda null).
    const payload = {
      name: str("name"),
      address: str("address"),
      addressLine2: str("addressLine2"),
      city: str("city"),
      province: str("province"),
      postalCode: str("postalCode"),
      phone: str("phone"),
    };
    start(async () => {
      const r = location ? await updateLocation(location.id, payload) : await createLocation(payload);
      if (!r.ok) {
        setError(r.error);
        setFieldErrors(r.fieldErrors ?? {});
        return;
      }
      toast.success(location ? "Sede guardada" : "Sede creada");
      onClose();
    });
  };

  const fe = (k: string) => fieldErrors[k]?.[0];

  return (
    <Drawer open onClose={onClose} dirty={dirty} title={location ? "Editar sede" : "Nueva sede"} width={480}>
      <form
        ref={formRef}
        action={submit}
        onInput={onFormInput}
        onChange={onFormInput}
        style={{ display: "grid", gap: 12 }}
      >
        <FormField
          label="Nombre"
          name="name"
          required
          autoFocus={!location}
          placeholder="Ej.: Consultorio Centro"
          defaultValue={location?.name ?? ""}
          error={fe("name")}
        />
        <FormField
          label="Dirección"
          name="address"
          placeholder="Calle y número"
          defaultValue={location?.address ?? ""}
          error={fe("address")}
        />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
          <FormField
            label="Piso / depto"
            name="addressLine2"
            defaultValue={location?.addressLine2 ?? ""}
            error={fe("addressLine2")}
          />
          <FormField
            label="Código postal"
            name="postalCode"
            defaultValue={location?.postalCode ?? ""}
            error={fe("postalCode")}
          />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
          <FormField label="Ciudad" name="city" defaultValue={location?.city ?? ""} error={fe("city")} />
          <FormField
            label="Provincia"
            name="province"
            defaultValue={location?.province ?? ""}
            error={fe("province")}
          />
        </div>
        <FormField
          label="Teléfono"
          name="phone"
          type="tel"
          defaultValue={location?.phone ?? ""}
          error={fe("phone")}
        />
        {!location && (
          <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
            Después de crearla, cargá en qué días y horarios atiende cada profesional en esta sede desde
            Profesionales › Horarios.
          </div>
        )}

        {error && <ErrorBox>{error}</ErrorBox>}

        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
          <Button type="submit" variant="primary" disabled={pending} style={{ width: "100%", justifyContent: "center" }}>
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
        </div>
      </form>
    </Drawer>
  );
}

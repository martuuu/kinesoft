"use client";

/**
 * Configuración › Sedes › Salas (corrida SR, sesión SR-U1).
 *
 * Las salas (consultorios, boxes, gimnasios) viven DENTRO de una sede: esta
 * sección se monta en el disclosure de cada sede activa de `LocationsPanel`.
 * Reglas del server (`lib/rooms.ts`, SR1b) que la UI hace visibles:
 *   • `capacity` = PROFESIONALES a la vez (SR-D1, §17.5), no pacientes: el
 *     cupo de pacientes sigue en el servicio. Por eso el campo se llama
 *     "Profesionales a la vez" y no "Pacientes a la vez" como en el relevamiento;
 *   • nombre único por sede entre las activas (SR-D9): el P2002 vuelve como
 *     `fieldErrors.name` y se muestra en el campo, no en un toast;
 *   • archivar = desactivar (SR-D8). Si la sala tiene franjas vigentes, turnos
 *     futuros o días con horario especial, la action devuelve los 3 conteos y
 *     acá se muestran con el camino para resolver cada uno (mismo patrón que
 *     `ArchiveBlockers` de sedes);
 *   • el orden ("Subir"/"Bajar") es `sortOrder` vía `updateRoom`. No hay
 *     action de reordenar: se parchean solo las filas que cambian (ver
 *     `moveRoomPatches`).
 *
 * Lo usa solo quien tiene `schedule.configure`: la página exige
 * `tenant.admin` (OWNER/ADMIN, que lo incluye) y las actions lo vuelven a
 * exigir. Bundle: `LocationsPanel` carga este módulo con `dynamic()` al abrir
 * el disclosure, así `/configuracion` no paga el form ni la lista.
 *
 * Los helpers puros (borrador, validación, orden, textos) se exportan para el
 * unit test (`tests/unit/render/rooms-section.test.tsx`).
 *
 * PL-2f (C-PL1, PL-D7): las salas son del plan Clínica / Libre (módulo `salas`). Sin el módulo la sección es solo
 * un aviso corto: ni lista ni «Nueva sala» (las actions tiran 403 y `listRooms` da `[]`). Las salas cargadas en
 * Clínica no se borran: «duermen» y vuelven al subir de plan.
 */
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { FormField } from "@/components/ui/form-field";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { IconPlus } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { useFormDirty } from "@/components/ui/use-form-dirty";
import {
  ROOM_CAPACITY_DEFAULT,
  ROOM_CAPACITY_HELP,
  ROOM_CAPACITY_LABEL,
  ROOM_CAPACITY_MAX,
  ROOM_CAPACITY_MIN,
  ROOM_KINDS,
  ROOM_KIND_LABEL,
  ROOM_NAME_MAX,
  ROOM_NAME_PLACEHOLDER,
  roomSummary,
  type RoomKind,
} from "@/lib/rooms-constants";
import type { RoomArchiveBlockers as Blockers, RoomRow } from "@/lib/rooms-types";
import { archiveRoom, createRoom, restoreRoom, updateRoom } from "@/lib/rooms";
import { ErrorBox } from "../controls";
import { useTenantModules } from "@/components/layout/tenant-modules-context";

// ─── Copy (voseo, literal del relevamiento SR-U1) ───

export const ROOMS_COPY = {
  title: "Salas",
  lead: "Consultorios, boxes y gimnasios de esta sede. Asigná una sala a cada franja para que nadie se pise.",
  upsell: "Las salas vienen con los planes Clínica y Libre. El plan se cambia en Configuración → Plan y uso.",
  add: "Nueva sala",
  empty: "Esta sede todavía no tiene salas. Cargalas si querés saber quién atiende dónde.",
  drawerNew: "Nueva sala",
  drawerEdit: "Editar sala",
  created: "Sala creada",
  saved: "Sala guardada",
  archived: (name: string) => `${name} archivada`,
  restored: (name: string) => `${name} restaurada`,
  confirmTitle: (name: string) => `¿Archivar "${name}"?`,
  confirmMessage:
    "Deja de ofrecerse en los horarios y en la agenda. Los turnos pasados siguen mostrando esta sala. Podés restaurarla cuando quieras.",
  blockedTitle: "Todavía no se puede archivar. Tiene:",
  nameRequired: "Poné un nombre.",
  nameTooLong: `Máximo ${ROOM_NAME_MAX} caracteres.`,
  capacityInvalid: `Tiene que ser un número entero entre ${ROOM_CAPACITY_MIN} y ${ROOM_CAPACITY_MAX}.`,
} as const;

// ─── Helpers puros ───

/** Activas (por `sortOrder`, nombre) y archivadas de UNA sede. */
export function roomsOfLocation(rooms: readonly RoomRow[], locationId: string): { active: RoomRow[]; archived: RoomRow[] } {
  const mine = rooms
    .filter((r) => r.locationId === locationId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "es"));
  return { active: mine.filter((r) => r.active), archived: mine.filter((r) => !r.active) };
}

export function roomScheduleText(n: number): string {
  if (n <= 0) return "Sin franjas asignadas";
  return `${n} franja${n === 1 ? "" : "s"} asignada${n === 1 ? "" : "s"}`;
}

/** Línea de la sede en `LocationsPanel` ("N salas"). */
export function roomCountText(n: number): string {
  if (n <= 0) return "Sin salas";
  return `${n} sala${n === 1 ? "" : "s"}`;
}

/**
 * Parches de `sortOrder` para mover una sala un lugar (`dir` -1 = subir,
 * +1 = bajar) dentro de las activas YA ORDENADAS. Renumera 0..n-1 y devuelve
 * solo las filas cuyo `sortOrder` cambia: con un swap simple de valores, dos
 * salas con el mismo `sortOrder` (o una archivada en el medio) no se movían
 * en pantalla. En el caso normal (0..n-1 sin huecos) son 2 llamadas.
 * Extremo o id ajeno → [].
 */
export function moveRoomPatches(
  active: readonly RoomRow[],
  id: string,
  dir: -1 | 1
): Array<{ id: string; sortOrder: number }> {
  const i = active.findIndex((r) => r.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= active.length) return [];
  const next = [...active];
  [next[i], next[j]] = [next[j], next[i]];
  return next.flatMap((r, idx) => (r.sortOrder === idx ? [] : [{ id: r.id, sortOrder: idx }]));
}

/** Renglones de los bloqueos de archivo (SR-D8), con el camino para resolver cada uno. */
export function roomArchiveBlockerItems(b: Blockers): Array<{ n: number; text: string }> {
  const out: Array<{ n: number; text: string }> = [];
  if (b.activeSchedules > 0) {
    out.push({
      n: b.activeSchedules,
      text: `${b.activeSchedules === 1 ? "franja" : "franjas"} de horario. Cambiales la sala en Profesionales › Horarios.`,
    });
  }
  if (b.futureBookings > 0) {
    out.push({
      n: b.futureBookings,
      text: `${b.futureBookings === 1 ? "turno" : "turnos"} a futuro. Cambiales la sala desde la agenda.`,
    });
  }
  if (b.futureExceptions > 0) {
    out.push({
      n: b.futureExceptions,
      text: `${b.futureExceptions === 1 ? "día" : "días"} con horario especial. Editalos en Profesionales › Excepciones.`,
    });
  }
  return out;
}

/** Borrador del form. `capacity` es string porque viene de un `<input>`. */
export type RoomDraft = { name: string; kind: RoomKind; capacity: string };
export type RoomDraftErrors = Partial<Record<"name" | "kind" | "capacity", string>>;

export function emptyRoomDraft(): RoomDraft {
  return { name: "", kind: "CONSULTORIO", capacity: String(ROOM_CAPACITY_DEFAULT) };
}

export function roomDraftFromRow(r: Pick<RoomRow, "name" | "kind" | "capacity">): RoomDraft {
  return { name: r.name, kind: r.kind, capacity: String(r.capacity) };
}

function parseCapacity(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= ROOM_CAPACITY_MIN && n <= ROOM_CAPACITY_MAX ? n : null;
}

/**
 * Mismos topes que el zod del server (`lib/rooms-schemas.ts`) y que los CHECK
 * de M4: el error se ve en el campo antes de ir a la red. El server vuelve a
 * validar (no se confía en esto).
 */
export function validateRoomDraft(d: RoomDraft): RoomDraftErrors {
  const e: RoomDraftErrors = {};
  const name = d.name.trim();
  if (!name) e.name = ROOMS_COPY.nameRequired;
  else if (name.length > ROOM_NAME_MAX) e.name = ROOMS_COPY.nameTooLong;
  if (!ROOM_KINDS.includes(d.kind)) e.kind = "Elegí un tipo.";
  if (parseCapacity(d.capacity) === null) e.capacity = ROOMS_COPY.capacityInvalid;
  return e;
}

/** Payload para `createRoom` (más `locationId`) / `updateRoom` (más `id`). Solo con un borrador válido. */
export function roomDraftToPayload(d: RoomDraft): { name: string; kind: RoomKind; capacity: number } {
  return { name: d.name.trim(), kind: d.kind, capacity: parseCapacity(d.capacity) ?? ROOM_CAPACITY_DEFAULT };
}

function draftFromForm(fd: FormData): RoomDraft {
  return {
    name: String(fd.get("name") ?? ""),
    kind: String(fd.get("kind") ?? "") as RoomKind,
    capacity: String(fd.get("capacity") ?? ""),
  };
}

// ─── UI ───

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

type RoomsSectionProps = {
  locationId: string;
  locationName: string;
  /** Todas las salas del consultorio (archivadas incluidas); se filtran por sede acá. */
  rooms: readonly RoomRow[];
};

export function RoomsSection(props: RoomsSectionProps) {
  // PL-2f: el gate va en un componente aparte para no cortar los hooks de la sección.
  if (!useTenantModules().has("salas")) {
    return (
      <section aria-label={`Salas de ${props.locationName}`} style={{ display: "grid", gap: 4, minWidth: 0 }}>
        <EyebrowLabel>{ROOMS_COPY.title}</EyebrowLabel>
        <div style={{ fontSize: 12, color: "var(--navy-500)" }}>{ROOMS_COPY.upsell}</div>
      </section>
    );
  }
  return <RoomsSectionBody {...props} />;
}

function RoomsSectionBody({ locationId, locationName, rooms }: RoomsSectionProps) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<RoomRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [blocked, setBlocked] = useState<{ id: string; error: string; blockers?: Blockers } | null>(null);

  const { active, archived } = roomsOfLocation(rooms, locationId);
  const archivedId = `rooms-archived-${locationId}`;

  const onMove = (r: RoomRow, dir: -1 | 1) => {
    const patches = moveRoomPatches(active, r.id, dir);
    if (patches.length === 0) return;
    start(async () => {
      // En serie: cada updateRoom toma el lock exclusivo de sedes; en paralelo
      // solo se harían cola. Si uno falla se corta y se refresca igual, para
      // que la lista muestre lo que quedó guardado.
      for (const p of patches) {
        const res = await updateRoom(p);
        if (!res.ok) {
          toast.error("No se pudo cambiar el orden", { description: res.error });
          break;
        }
      }
      router.refresh();
    });
  };

  const onArchive = async (r: RoomRow) => {
    const ok = await confirm({
      title: ROOMS_COPY.confirmTitle(r.name),
      message: ROOMS_COPY.confirmMessage,
      confirmLabel: "Archivar",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      const res = await archiveRoom({ id: r.id });
      if (!res.ok) {
        setBlocked({ id: r.id, error: res.error, blockers: res.blockers });
        return;
      }
      setBlocked(null);
      toast.success(ROOMS_COPY.archived(r.name));
      router.refresh();
    });
  };

  const onRestore = (r: RoomRow) => {
    start(async () => {
      const res = await restoreRoom({ id: r.id });
      // Nombre tomado por otra activa → el mensaje del server dice qué pasa;
      // hay que renombrar una de las dos (la archivada se puede editar).
      if (!res.ok) toast.error("No se pudo restaurar", { description: res.error });
      else {
        toast.success(ROOMS_COPY.restored(r.name));
        router.refresh();
      }
    });
  };

  return (
    <section aria-label={`Salas de ${locationName}`} style={{ display: "grid", gap: 10, minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ minWidth: 0, flex: "1 1 220px" }}>
          <EyebrowLabel>{ROOMS_COPY.title}</EyebrowLabel>
          <div style={{ fontSize: 12, color: "var(--navy-500)", marginTop: 2 }}>{ROOMS_COPY.lead}</div>
        </div>
        <Button variant="ghost" onClick={() => setCreating(true)} disabled={pending}>
          <IconPlus size={13} /> {ROOMS_COPY.add}
        </Button>
      </div>

      {active.length === 0 ? (
        <div style={{ fontSize: 12.5, color: "var(--navy-500)", padding: "6px 0" }}>{ROOMS_COPY.empty}</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
          {active.map((r, idx) => (
            <li
              key={r.id}
              style={{
                padding: "8px 12px",
                borderRadius: "var(--r-sm)",
                border: "1px solid rgba(15,30,51,0.06)",
                background: "#fff",
              }}
            >
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                <button
                  type="button"
                  onClick={() => setEditing(r)}
                  aria-label={`Editar ${r.name}`}
                  style={{
                    flex: "1 1 180px",
                    minWidth: 0,
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: "inherit",
                  }}
                >
                  <div style={{ fontSize: 13.5, fontWeight: 600, overflowWrap: "anywhere" }}>
                    {r.name}
                    <span style={{ fontWeight: 400, color: "var(--navy-500)" }}> · {roomSummary(r)}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--navy-300)", marginTop: 2 }}>
                    {roomScheduleText(r.scheduleCount)}
                  </div>
                </button>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 2, alignItems: "center" }}>
                  {idx > 0 && (
                    <button
                      type="button"
                      style={linkBtn}
                      onClick={() => onMove(r, -1)}
                      disabled={pending}
                      aria-label={`Subir ${r.name}`}
                    >
                      Subir
                    </button>
                  )}
                  {idx < active.length - 1 && (
                    <button
                      type="button"
                      style={linkBtn}
                      onClick={() => onMove(r, 1)}
                      disabled={pending}
                      aria-label={`Bajar ${r.name}`}
                    >
                      Bajar
                    </button>
                  )}
                  <button
                    type="button"
                    style={{ ...linkBtn, color: "#9F1F1F" }}
                    onClick={() => onArchive(r)}
                    disabled={pending}
                    aria-label={`Archivar ${r.name}`}
                  >
                    Archivar
                  </button>
                </div>
              </div>
              {blocked?.id === r.id && (
                <div style={{ marginTop: 8 }}>
                  <RoomArchiveBlockers
                    error={blocked.error}
                    blockers={blocked.blockers}
                    onDismiss={() => setBlocked(null)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 && (
        <div>
          <button
            type="button"
            style={{ ...linkBtn, color: "var(--navy-500)" }}
            onClick={() => setShowArchived((v) => !v)}
            aria-expanded={showArchived}
            aria-controls={archivedId}
          >
            {showArchived ? "Ocultar" : "Ver"} archivadas ({archived.length})
          </button>
          {showArchived && (
            <ul id={archivedId} style={{ listStyle: "none", margin: "4px 0 0", padding: 0, display: "grid", gap: 6 }}>
              {archived.map((r) => (
                <li
                  key={r.id}
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "6px 12px",
                    borderRadius: "var(--r-sm)",
                    background: "rgba(15,30,51,0.04)",
                  }}
                >
                  <div style={{ minWidth: 0, fontSize: 12.5, color: "var(--navy-500)", overflowWrap: "anywhere" }}>
                    <strong>{r.name}</strong> · {roomSummary(r)}
                  </div>
                  <div style={{ display: "flex", gap: 2 }}>
                    <button
                      type="button"
                      style={linkBtn}
                      onClick={() => setEditing(r)}
                      disabled={pending}
                      aria-label={`Editar ${r.name}`}
                    >
                      Editar
                    </button>
                    <button
                      type="button"
                      style={linkBtn}
                      onClick={() => onRestore(r)}
                      disabled={pending}
                      aria-label={`Restaurar ${r.name}`}
                    >
                      Restaurar
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {creating && <RoomDrawer locationId={locationId} onClose={() => setCreating(false)} />}
      {editing && <RoomDrawer locationId={locationId} room={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

/** Qué impide archivar la sala y dónde se resuelve cada cosa (SR-D8). */
export function RoomArchiveBlockers({
  error,
  blockers,
  onDismiss,
}: {
  error: string;
  blockers?: Blockers;
  onDismiss: () => void;
}) {
  const items = blockers ? roomArchiveBlockerItems(blockers) : [];
  return (
    <ErrorBox>
      {items.length === 0 ? (
        error
      ) : (
        <>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{ROOMS_COPY.blockedTitle}</div>
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }}>
            {items.map((it) => (
              <li key={it.text}>
                <strong>{it.n}</strong> {it.text}
              </li>
            ))}
          </ul>
        </>
      )}
      <button
        type="button"
        onClick={onDismiss}
        style={{ ...linkBtn, color: "#9F1F1F", padding: "4px 0 0", minHeight: 0 }}
      >
        Entendido
      </button>
    </ErrorBox>
  );
}

const KIND_OPTIONS = ROOM_KINDS.map((k) => ({ value: k, label: ROOM_KIND_LABEL[k] }));

/** Campos del form, en orden: Nombre, Tipo, Profesionales a la vez. No controlado (FormData). */
export function RoomForm({ draft, errors, autoFocus }: { draft: RoomDraft; errors: RoomDraftErrors; autoFocus?: boolean }) {
  return (
    <>
      <FormField
        label="Nombre"
        name="name"
        required
        autoFocus={autoFocus}
        placeholder={ROOM_NAME_PLACEHOLDER}
        defaultValue={draft.name}
        error={errors.name}
      />
      <FormField as="select" label="Tipo" name="kind" defaultValue={draft.kind} options={KIND_OPTIONS} error={errors.kind} />
      <FormField
        label={ROOM_CAPACITY_LABEL}
        name="capacity"
        type="number"
        min={ROOM_CAPACITY_MIN}
        max={ROOM_CAPACITY_MAX}
        step={1}
        required
        defaultValue={draft.capacity}
        hint={ROOM_CAPACITY_HELP}
        error={errors.capacity}
      />
    </>
  );
}

function RoomDrawer({ locationId, room, onClose }: { locationId: string; room?: RoomRow; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<RoomDraftErrors>({});
  const formRef = useRef<HTMLFormElement>(null);
  const { dirty, onFormInput } = useFormDirty(formRef);
  const [initial] = useState<RoomDraft>(() => (room ? roomDraftFromRow(room) : emptyRoomDraft()));

  const submit = (fd: FormData) => {
    setError(null);
    const draft = draftFromForm(fd);
    const local = validateRoomDraft(draft);
    setErrors(local);
    if (Object.keys(local).length > 0) return;
    const payload = roomDraftToPayload(draft);
    start(async () => {
      const r = room ? await updateRoom({ id: room.id, ...payload }) : await createRoom({ locationId, ...payload });
      if (!r.ok) {
        const fe = r.fieldErrors ?? {};
        const fieldErrs: RoomDraftErrors = {
          name: fe.name?.[0],
          kind: fe.kind?.[0],
          capacity: fe.capacity?.[0],
        };
        setErrors(fieldErrs);
        // Si el error ya se ve en un campo (p. ej. nombre tomado), no se repite abajo.
        if (!fieldErrs.name && !fieldErrs.kind && !fieldErrs.capacity) setError(r.error);
        return;
      }
      toast.success(room ? ROOMS_COPY.saved : ROOMS_COPY.created);
      onClose();
      router.refresh();
    });
  };

  return (
    <Drawer open onClose={onClose} dirty={dirty} title={room ? ROOMS_COPY.drawerEdit : ROOMS_COPY.drawerNew} width={420}>
      <form
        ref={formRef}
        action={submit}
        onInput={onFormInput}
        onChange={onFormInput}
        noValidate
        style={{ display: "grid", gap: 12 }}
      >
        <RoomForm draft={initial} errors={errors} autoFocus={!room} />
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

"use client";

import { useState, useTransition, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { Drawer } from "@/components/ui/drawer";
import { FormField } from "@/components/ui/form-field";
import { IconArrow, IconPlus, IconCheck } from "@/components/ui/icons";
import { PlanTemplateApplyButton } from "@/components/patients/plan-template-apply";
import {
  createProgram,
  deleteProgram,
  deleteSession,
  setProgramStatus,
  updateProgram,
} from "@/lib/programs";
import { addCustomSession, rescheduleSession } from "@/lib/sessions";
import { localToARIso, isoToARLocalInput } from "@/lib/datetime-ar";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { PLAN_MAX_SESSIONS } from "@/lib/plans-constants";
import {
  PLAN_FORM_DEFAULTS,
  planFormTodayKey,
  programStatusConfirm,
  type LegacyProgramStatus,
} from "@/lib/plan-form-defaults";
import type { RescheduleSessionResult } from "@/lib/sessions-types";
import type { PatientWithRelations } from "../types";

export function PlanView({
  patient,
  canUseTemplates,
  canDelete,
}: {
  patient: PatientWithRelations;
  /**
   * P0-Cs: `gatingForActor().canBuildTemplates`, resuelto en la página.
   * S02u-plan: sin plantillas, "Aplicar plantilla" queda deshabilitado con
   * aviso en vez de fallar al confirmar. Falla cerrado si no viene.
   */
  canUseTemplates?: boolean;
  /**
   * S02u-plan: OWNER/ADMIN (el `canReassign` de la página). `deleteProgram`
   * exige `requireAdminRole`: antes el botón se mostraba a todos y al
   * profesional le fallaba en silencio. Falla cerrado si no viene.
   */
  canDelete?: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  // Show ALL programs of this patient as separate cards. Pre-Sprint 13
  // only the first ACTIVE program was rendered, which made a second plan
  // look like it had "merged" into the first.
  const programs = patient.programs;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {programs.length === 0 ? (
        <Card style={{ padding: 24, textAlign: "center" }}>
          <p style={{ color: "var(--navy-500)" }}>Este paciente no tiene planes todavía.</p>
          <div style={{ display: "inline-flex", gap: 8 }}>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <IconPlus size={14} /> Crear plan
            </Button>
            <PlanTemplateApplyButton patientId={patient.id} disabled={!canUseTemplates} />
          </div>
        </Card>
      ) : (
        <>
          <header
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: "var(--navy-300)",
                fontWeight: 700,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              {programs.length} {programs.length === 1 ? "plan" : "planes"}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Button variant="ghost" onClick={() => setCreating(true)} style={{ fontSize: 12 }}>
                <IconPlus size={12} /> Plan nuevo
              </Button>
              <PlanTemplateApplyButton patientId={patient.id} disabled={!canUseTemplates} />
            </div>
          </header>
          {programs.map((prog) => (
            <ProgramCard key={prog.id} program={prog} canDelete={canDelete === true} />
          ))}
        </>
      )}
      {creating && (
        <CreateProgramModal
          patientId={patient.id}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function ProgramCard({
  program,
  canDelete,
}: {
  program: PatientWithRelations["programs"][number];
  canDelete: boolean;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pending, start] = useTransition();
  // S02u-plan: antes `changeStatus`/`confirmDelete` ignoraban `{ ok: false }`
  // y el click "no hacía nada". El error queda visible en la card.
  const [error, setError] = useState<string | null>(null);

  const done = program.sessions.filter((s) => s.completedAt).length;
  const pct = program.totalSessions
    ? Math.round((done / program.totalSessions) * 100)
    : 0;
  const status = program.status;
  const statusTag =
    status === "ACTIVE"
      ? <Tag tone="lime">Activo</Tag>
      : status === "COMPLETED"
        ? <Tag tone="soft"><IconCheck size={10} stroke={3} /> Completado</Tag>
        : status === "PAUSED"
          ? <Tag tone="soft">Pausado</Tag>
          : <Tag tone="soft">Cancelado</Tag>;

  // El `<select>` es controlado (`value={current}`): si se cancela el confirm
  // React lo vuelve a pintar con el estado real, sin estado local que limpiar.
  const changeStatus = async (next: LegacyProgramStatus) => {
    if (next === status) return;
    const ok = await confirm(programStatusConfirm(next));
    if (!ok) return;
    setError(null);
    start(async () => {
      const r = await setProgramStatus({ id: program.id, status: next });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  };

  const confirmDelete = () => {
    setError(null);
    start(async () => {
      const r = await deleteProgram(program.id);
      if (!r.ok) {
        setDeleting(false);
        setError(r.error);
        return;
      }
      setDeleting(false);
      router.refresh();
    });
  };

  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <header
        style={{
          padding: 16,
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 12,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            textAlign: "left",
            color: "inherit",
            padding: 0,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 24,
              height: 24,
              borderRadius: 8,
              background: "rgba(15,30,51,0.06)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              color: "var(--navy-500)",
              flexShrink: 0,
              transition: "transform 160ms ease",
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            }}
          >
            ›
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2, flexWrap: "wrap" }}>
              {statusTag}
              <span className="k-mono" style={{ fontSize: 11, color: "var(--navy-300)" }}>
                {done}/{program.totalSessions} · {pct}%
              </span>
            </div>
            <div className="k-display" style={{ fontSize: 16, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {program.title}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>
              Inicio {program.startDate.toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })} ·{" "}
              {program.frequency}×/semana
            </div>
          </div>
        </button>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <ProgramStatusMenu
            current={status}
            onChange={changeStatus}
            disabled={pending}
          />
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={pending}
            style={miniBtn}
          >
            Editar
          </button>
          <AddCustomSessionButton programId={program.id} />
          {canDelete && (
            <button
              type="button"
              onClick={() => setDeleting(true)}
              disabled={pending}
              style={{ ...miniBtn, color: "#9F1F1F" }}
            >
              Eliminar
            </button>
          )}
        </div>
      </header>
      {error && (
        <div
          role="alert"
          style={{
            margin: "0 16px 12px",
            padding: 10,
            borderRadius: 10,
            background: "rgba(228,70,70,0.1)",
            color: "#9F1F1F",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}
      <div
        style={{
          height: 4,
          background: "rgba(15,30,51,0.06)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: "linear-gradient(90deg, var(--sky-500), var(--lime-400))",
          }}
        />
      </div>
      {expanded && (
        <div
          style={{
            padding: 16,
            borderTop: "1px solid rgba(15,30,51,0.05)",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 10,
            background: "rgba(246,249,253,0.5)",
          }}
        >
          {program.sessions.length === 0 && (
            <div style={{ gridColumn: "1 / -1", padding: 12, color: "var(--navy-500)", fontSize: 13 }}>
              Este plan todavía no tiene sesiones cargadas.
            </div>
          )}
          {program.sessions.map((s) => (
            <SessionCardRow key={s.id} session={s} />
          ))}
        </div>
      )}
      {editing && (
        <EditProgramModal program={program} onClose={() => setEditing(false)} />
      )}
      {deleting && canDelete && (
        <ConfirmDeleteProgram
          program={program}
          pending={pending}
          onConfirm={confirmDelete}
          onClose={() => setDeleting(false)}
        />
      )}
    </Card>
  );
}

const miniBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(15,30,51,0.08)",
  borderRadius: 999,
  padding: "5px 10px",
  fontSize: 11.5,
  fontWeight: 600,
  color: "var(--navy-700)",
  cursor: "pointer",
};

function ProgramStatusMenu({
  current,
  onChange,
  disabled,
}: {
  current: "ACTIVE" | "COMPLETED" | "PAUSED" | "CANCELLED";
  onChange: (s: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED") => void;
  disabled: boolean;
}) {
  return (
    <select
      value={current}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED")}
      style={{
        padding: "5px 8px",
        borderRadius: 999,
        border: "1px solid rgba(15,30,51,0.08)",
        background: "rgba(255,255,255,0.8)",
        fontSize: 11.5,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      <option value="ACTIVE">Activo</option>
      <option value="PAUSED">Pausado</option>
      <option value="COMPLETED">Completado</option>
      <option value="CANCELLED">Cancelado</option>
    </select>
  );
}

function EditProgramModal({
  program,
  onClose,
}: {
  program: PatientWithRelations["programs"][number];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const submit = (formData: FormData) => {
    setError(null);
    start(async () => {
      const r = await updateProgram({
        id: program.id,
        title: String(formData.get("title") ?? ""),
        totalSessions: Number(formData.get("totalSessions") ?? program.totalSessions),
        frequency: Number(formData.get("frequency") ?? program.frequency),
        startDate: String(formData.get("startDate") ?? ""),
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onClose();
      router.refresh();
    });
  };
  const startDateIso = program.startDate.toISOString().slice(0, 10);
  return (
    <Drawer open onClose={onClose} title="Editar plan" width={480}>
      <form action={submit} style={{ display: "grid", gap: 12 }}>
        <FormField label="Nombre del plan" name="title" required defaultValue={program.title} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <FormField
            label="Total de sesiones"
            name="totalSessions"
            type="number"
            min={1}
            max={PLAN_MAX_SESSIONS}
            defaultValue={program.totalSessions}
          />
          <FormField
            label="Frecuencia (× semana)"
            name="frequency"
            type="number"
            min={1}
            max={7}
            defaultValue={program.frequency}
          />
        </div>
        <FormField label="Fecha de inicio" name="startDate" type="date" defaultValue={startDateIso} />
        {error && (
          <div style={{ padding: 10, borderRadius: 10, background: "rgba(228,70,70,0.1)", color: "#9F1F1F", fontSize: 12 }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
        </div>
      </form>
    </Drawer>
  );
}

function ConfirmDeleteProgram({
  program,
  pending,
  onConfirm,
  onClose,
}: {
  program: PatientWithRelations["programs"][number];
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Drawer open onClose={onClose} title="Eliminar plan" width={440}>
      <p style={{ fontSize: 13, color: "var(--navy-700)", margin: "0 0 8px" }}>
        Vas a eliminar <strong>{program.title}</strong> con sus {program.totalSessions} sesiones cargadas.
        Esta acción no se puede deshacer.
      </p>
      <p style={{ fontSize: 12, color: "var(--navy-500)", margin: "0 0 14px" }}>
        Los turnos de la agenda no se tocan: si había turnos para este plan, cancelalos desde la agenda.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Button
          type="button"
          variant="primary"
          onClick={onConfirm}
          disabled={pending}
          style={{ background: "#9F1F1F", width: "100%", justifyContent: "center" }}
        >
          {pending ? "Eliminando…" : "Eliminar definitivamente"}
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
    </Drawer>
  );
}

function SessionCardRow({
  session,
}: {
  session: PatientWithRelations["programs"][number]["sessions"][number];
}) {
  const [editing, setEditing] = useState(false);
  const done = !!session.completedAt;
  return (
    <>
      <button
        type="button"
        onClick={() => setEditing(true)}
        style={{
          textAlign: "left",
          padding: 12,
          borderRadius: 12,
          background: done ? "rgba(200,245,100,0.18)" : "rgba(246,249,253,0.7)",
          border: "1px solid rgba(15,30,51,0.06)",
          cursor: "pointer",
          display: "block",
          width: "100%",
          color: "inherit",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, color: "var(--navy-500)", fontWeight: 700 }}>
            Sesión {session.index}
          </span>
          {done && <IconCheck size={12} stroke={3} />}
        </div>
        <div className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)" }}>
          {session.scheduledFor.toLocaleString("es-AR", {
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            timeZone: "America/Argentina/Buenos_Aires",
          })}
        </div>
        <div style={{ fontSize: 11, color: "var(--navy-700)", marginTop: 6 }}>
          {session._count.exercises} ejercicio{session._count.exercises === 1 ? "" : "s"}
        </div>
      </button>
      {editing && (
        <EditSessionModal
          session={session}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}

function EditSessionModal({
  session,
  onClose,
}: {
  session: PatientWithRelations["programs"][number]["sessions"][number];
  onClose: () => void;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Tras reprogramar, si el paciente tiene un turno ese día se muestra acá
  // (con link a la agenda) en vez de cerrar el drawer: el turno NO se mueve.
  const [moved, setMoved] = useState<RescheduleSessionResult | null>(null);
  // AR wall-clock formatting via Intl — works the same on the
  // server (SSR snapshot) and the browser. The old `getFullYear` /
  // `getHours` path read the runtime's local tz, which on a UTC
  // host put sessions on the wrong day.
  const initialLocal = useMemo(
    () => isoToARLocalInput(session.scheduledFor),
    [session.scheduledFor]
  );
  const [when, setWhen] = useState(initialLocal);

  const save = () => {
    setError(null);
    start(async () => {
      const r = await rescheduleSession({
        sessionId: session.id,
        // Tag with AR offset so the server parses 14:00 as 14:00 AR,
        // not 14:00 UTC (which displays back as 11:00 AR).
        scheduledFor: localToARIso(when),
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
      if (r.data.bookingOnDay) setMoved(r.data);
      else onClose();
    });
  };

  const remove = async () => {
    const ok = await confirm({
      title: `¿Eliminar la sesión ${session.index}?`,
      message: "Se borra la sesión con sus ejercicios. Esta acción es definitiva.",
      confirmLabel: "Eliminar",
      tone: "danger",
    });
    if (!ok) return;
    setError(null);
    start(async () => {
      const r = await deleteSession(session.id);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onClose();
      router.refresh();
    });
  };

  return (
    <Drawer open onClose={onClose} title={`Sesión ${session.index}`} width={460}>
      <div style={{ display: "grid", gap: 12 }}>
        <p style={{ marginTop: 0, marginBottom: 2, fontSize: 13, color: "var(--navy-500)" }}>
          {session.completedAt
            ? "Esta sesión ya fue realizada. Solo podés revisar su detalle."
            : "Cambiá la fecha/hora si el paciente necesita reprogramar. Solo se mueve la sesión del plan: los turnos de la agenda se manejan desde la agenda."}
        </p>
        <FormField
          label="Fecha y hora"
          name="scheduledFor"
          type="datetime-local"
          value={when}
          onChange={(v) => setWhen(v)}
          disabled={!!session.completedAt || !!moved}
        />
        {moved?.bookingOnDay && (
          <div
            role="status"
            style={{
              padding: 10,
              borderRadius: 10,
              background: "rgba(246,249,253,0.9)",
              border: "1px solid rgba(15,30,51,0.08)",
              color: "var(--navy-700)",
              fontSize: 12.5,
              display: "grid",
              gap: 6,
            }}
          >
            <span>
              Sesión reprogramada. El paciente tiene un turno ese día a las{" "}
              <strong>
                {new Date(moved.bookingOnDay.scheduledFor).toLocaleTimeString("es-AR", {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                  timeZone: "America/Argentina/Buenos_Aires",
                })}
              </strong>
              : el turno no se movió. Si hace falta, ajustalo en la agenda.
            </span>
            <Link
              href={`/agenda?view=timeline&date=${moved.bookingOnDay.dateKey}`}
              style={{ color: "var(--sky-700)", fontWeight: 700, textDecoration: "none" }}
            >
              Ver ese día en la agenda →
            </Link>
          </div>
        )}
        {error && (
          <div
            style={{
              padding: 10,
              borderRadius: 10,
              background: "rgba(228,70,70,0.1)",
              color: "#9F1F1F",
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginTop: 4,
          }}
        >
          {!session.completedAt && !moved && (
            <Button
              type="button"
              variant="primary"
              onClick={save}
              disabled={pending}
              style={{ width: "100%", justifyContent: "center" }}
            >
              {pending ? "Guardando…" : "Guardar"}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={pending}
            style={{ width: "100%", justifyContent: "center" }}
          >
            {moved ? "Cerrar" : "Cancelar"}
          </Button>
          {!session.completedAt && !moved && (
            <button
              type="button"
              onClick={remove}
              disabled={pending}
              style={{
                background: "transparent",
                border: "none",
                color: "#9F1F1F",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 700,
                width: "100%",
                textAlign: "center",
                padding: "6px 0",
              }}
            >
              Eliminar
            </button>
          )}
          <Link
            href={`/seguimiento/${session.id}`}
            style={{
              fontSize: 12.5,
              color: "var(--sky-700)",
              textDecoration: "none",
              fontWeight: 700,
              textAlign: "center",
              marginTop: 4,
            }}
          >
            Abrir sesión completa →
          </Link>
        </div>
      </div>
    </Drawer>
  );
}

/**
 * "Sesión a medida". Antes usaba `prompt()`: Cancelar devolvía `null`, el
 * `?? undefined` lo convertía en "sin título" y la sesión se creaba igual
 * (A2a-S03 ítem 7). Ahora es un Drawer: Cancelar/Esc no crean nada.
 */
function AddCustomSessionButton({ programId }: { programId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (pending) return;
    setOpen(false);
    setTitle("");
    setError(null);
  };
  const add = () => {
    setError(null);
    start(async () => {
      const r = await addCustomSession({ programId, title: title.trim() || undefined });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setOpen(false);
      setTitle("");
      router.refresh();
    });
  };
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)} disabled={pending}>
        <IconPlus size={12} /> Sesión a medida
      </Button>
      {open && (
        <Drawer open onClose={close} title="Sesión a medida" width={440}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
            style={{ display: "grid", gap: 10 }}
          >
            <p style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>
              Se agrega al final del plan, con la fecha siguiente según la frecuencia. Después la podés
              reprogramar.
            </p>
            <FormField
              label="Título o nota corta (opcional)"
              name="title"
              value={title}
              onChange={(v) => setTitle(v.slice(0, 200))}
              autoFocus
            />
            {error && (
              <div
                role="alert"
                style={{
                  padding: 10,
                  borderRadius: 10,
                  background: "rgba(228,70,70,0.1)",
                  color: "#9F1F1F",
                  fontSize: 12,
                }}
              >
                {error}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Button type="submit" variant="primary" disabled={pending} style={{ width: "100%", justifyContent: "center" }}>
                {pending ? "Agregando…" : "Agregar sesión"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={close}
                disabled={pending}
                style={{ width: "100%", justifyContent: "center" }}
              >
                Cancelar
              </Button>
            </div>
          </form>
        </Drawer>
      )}
    </>
  );
}

export function CreateProgramModal({
  patientId,
  onClose,
  onCreated,
}: {
  patientId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Hoy AR, congelado al abrir el drawer (S02u-plan). Antes era el día UTC de
  // `toISOString().slice(0,10)`: de 21:00 a 23:59 AR proponía mañana.
  const [todayKey] = useState(() => planFormTodayKey());

  const submit = (formData: FormData) => {
    setError(null);
    start(async () => {
      const result = await createProgram({
        patientId,
        title: String(formData.get("title") ?? ""),
        totalSessions: Number(formData.get("totalSessions")) || PLAN_FORM_DEFAULTS.totalSessions,
        frequency: Number(formData.get("frequency")) || PLAN_FORM_DEFAULTS.frequency,
        startDate: String(formData.get("startDate") ?? ""),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onCreated();
    });
  };

  return (
    <Drawer open onClose={onClose} title="Crear plan de tratamiento" width={480}>
      <form action={submit} style={{ display: "grid", gap: 10 }}>
        <FormField label="Nombre" name="title" required defaultValue={PLAN_FORM_DEFAULTS.title} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <FormField
            label="Sesiones"
            name="totalSessions"
            type="number"
            min={1}
            max={PLAN_FORM_DEFAULTS.maxSessions}
            defaultValue={PLAN_FORM_DEFAULTS.totalSessions}
          />
          <FormField
            label="Freq/sem"
            name="frequency"
            type="number"
            min={1}
            max={PLAN_FORM_DEFAULTS.maxFrequency}
            defaultValue={PLAN_FORM_DEFAULTS.frequency}
          />
          <FormField label="Inicio" name="startDate" type="date" required defaultValue={todayKey} />
        </div>
        {error && (
          <div
            style={{
              padding: 10,
              borderRadius: 10,
              background: "rgba(228,70,70,0.1)",
              color: "#9F1F1F",
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Button
            type="submit"
            variant="primary"
            disabled={pending}
            style={{ width: "100%", justifyContent: "center" }}
          >
            {pending ? "Creando…" : "Crear plan"} <IconArrow size={12} />
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

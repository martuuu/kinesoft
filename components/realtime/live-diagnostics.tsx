"use client";

/**
 * HF-1b (§22.2 H-RT1) · «Ver detalle» del indicador «En vivo».
 *
 * Por qué existe: con H-RT1 una cuenta entera quedaba en «Sin conexión en vivo» y nadie podía decir en qué paso se
 * cortaba (el motivo moría en un `devWarn`, no-op en prod). Esto muestra los cinco pasos ✓/✗ con el motivo técnico,
 * para que Martin o el soporte lo lean por teléfono, y el botón «Reconectar» (reintenta aunque el canal esté
 * estacionado tras 3 rechazos). Con una versión vieja el botón es «Recargar»: reconectar no trae el build nuevo.
 *
 * Bundle: lo carga `LiveIndicator` con `next/dynamic` recién al abrirlo (Modal y su framer no entran al first-load).
 * Estilos en su CSS module: `app/globals.css` es de otra sesión de la tanda (HF-2a).
 */
import { Modal, ModalActions } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import type { ConnectionState, RealtimeDiag, RealtimeDiagStep } from "@/lib/realtime-client-types";
import { liveIndicatorLabel } from "@/components/realtime/live-indicator";
import { REALTIME_DIAG_COPY } from "@/components/realtime/live-indicator-diag";
import styles from "./live-diagnostics.module.css";

export const DIAG_STEPS: ReadonlyArray<{ step: RealtimeDiagStep; label: string }> = [
  { step: "bootstrap", label: "Configuración del consultorio" },
  { step: "import", label: "Código de la conexión" },
  { step: "mint", label: "Permiso del servidor (token)" },
  { step: "socket", label: "Conexión con el servidor en vivo" },
  { step: "join", label: "Canal de la agenda" },
];

export type DiagStepRow = { step: RealtimeDiagStep; label: string; status: "ok" | "fail" | "pending" };

/**
 * Pasos ✓/✗ (puro, lo usa el render test). En vivo, todos ✓. Con un fallo, ✓ hasta el paso anterior, ✗ en el que
 * falló y «pendiente» los que siguen (no se llegó a probarlos). Sin fallo y sin vivo (arrancando), todo pendiente.
 */
export function diagSteps(state: ConnectionState, diag: RealtimeDiag | null): DiagStepRow[] {
  const failAt = diag ? DIAG_STEPS.findIndex((s) => s.step === diag.step) : -1;
  return DIAG_STEPS.map((s, i) => ({
    ...s,
    status: state === "live" ? "ok" : failAt < 0 ? "pending" : i < failAt ? "ok" : i === failAt ? "fail" : "pending",
  }));
}

const MARK: Record<DiagStepRow["status"], string> = { ok: "✓", fail: "✗", pending: "·" };
const MARK_LABEL: Record<DiagStepRow["status"], string> = { ok: "Bien", fail: "Falló", pending: "Sin probar" };

function atLabel(at: number): string {
  try {
    return new Date(at).toLocaleTimeString("es-AR", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Argentina/Buenos_Aires",
    });
  } catch {
    return "";
  }
}

export function LiveDiagnostics({
  open,
  state,
  diag,
  onReconnect,
  onClose,
}: {
  open: boolean;
  state: ConnectionState;
  diag: RealtimeDiag | null;
  onReconnect: () => void;
  onClose: () => void;
}) {
  const stale = diag?.code === "stale_build";
  const rows = diagSteps(state, diag);
  return (
    <Modal open={open} onClose={onClose} title="Conexión en vivo" description={liveIndicatorLabel(state, diag)} width={440}>
      <ol className={styles.steps} aria-label="Pasos de la conexión">
        {rows.map((r) => (
          <li key={r.step} className={styles.step} data-status={r.status}>
            <span className={styles.mark} aria-label={MARK_LABEL[r.status]} role="img">
              {MARK[r.status]}
            </span>
            <span>{r.label}</span>
          </li>
        ))}
      </ol>
      {diag ? (
        <div className={styles.detail}>
          <p className={styles.reason}>{REALTIME_DIAG_COPY[diag.code]}</p>
          <dl className={styles.meta}>
            <dt>Código</dt>
            <dd>
              <code>
                {diag.step}/{diag.code}
              </code>
            </dd>
            {diag.reason ? (
              <>
                <dt>Detalle</dt>
                <dd>
                  <code>{diag.reason}</code>
                </dd>
              </>
            ) : null}
            <dt>Hora</dt>
            <dd>{atLabel(diag.at)}</dd>
          </dl>
          {diag.permanent && !stale ? (
            <p className={styles.hint}>
              Mientras tanto la agenda se actualiza cada 60 s y la conexión se reintenta sola cada 5 minutos.
            </p>
          ) : null}
        </div>
      ) : null}
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          Cerrar
        </Button>
        {stale ? (
          <Button onClick={() => window.location.reload()}>Recargar</Button>
        ) : (
          <Button
            onClick={() => {
              onReconnect();
              onClose();
            }}
          >
            Reconectar
          </Button>
        )}
      </ModalActions>
    </Modal>
  );
}

/**
 * [VX F-b1 · C-F4] Panel de producto del login (variante `product` de AuthShell, prototipo `login-c.html`).
 *
 * Server component, sin JS de cliente: el mock de agenda es CSS puro portado de `design_source/vx0/shared.js`
 * (`T.agenda`) — D-VX3: sin cifras de negocio ni nombres inventados. Mismo lenguaje visual que la agenda real
 * (AGENTS.md §5): la barra lateral es el servicio, el fondo es el estado (tokens `--st-*`/`--rc-*` de la app) y el
 * profesional va por un canal no cromático (avatar con iniciales).
 *
 * A11y: el `<aside aria-label>` lleva solo el copy; el mock y la tarjeta flotante son decorativos (`aria-hidden`).
 * El título es un `<p>`: la única h1 de la página vive en la card del form.
 */
import Link from "next/link";
import { KineLogo } from "@/components/ui/kine-logo";
import { BRAND_NAME } from "@/lib/brand";
import s from "./product-panel.module.css";


type Status = "completed" | "attending" | "confirmed" | "pending" | "insala";

/** Profesionales del mock: iniciales + color del avatar (literales del prototipo, no dependen de la paleta). */
const PROS: { initials: string; color: string }[] = [
  { initials: "AL", color: "#1f4fbe" },
  { initials: "MR", color: "#3d7010" },
  { initials: "JP", color: "#5e92cc" },
];

/** [col, inicio en medias horas, duración en medias horas, estado, color del servicio, servicio]. */
const APPTS: [number, number, number, Status, string, string][] = [
  [0, 0, 2, "completed", "#1f4fbe", "Sesión de kinesiología"],
  [0, 2, 1, "attending", "#8ecc30", "Evaluación inicial"],
  [0, 4, 2, "confirmed", "#1f4fbe", "Sesión de kinesiología"],
  [0, 7, 2, "pending", "#5e92cc", "Terapia manual"],
  [1, 1, 2, "insala", "#3d7010", "Osteopatía"],
  [1, 4, 1, "confirmed", "#8ecc30", "Evaluación inicial"],
  [1, 6, 2, "confirmed", "#3d7010", "Osteopatía"],
  [2, 0, 1, "completed", "#5e92cc", "Terapia manual"],
  [2, 2, 2, "confirmed", "#1f4fbe", "Sesión de kinesiología"],
  [2, 6, 1, "pending", "#8ecc30", "Evaluación inicial"],
];

const STATUS_LABEL: Record<Status, string> = {
  completed: "Atendido",
  attending: "En atención",
  confirmed: "Confirmado",
  pending: "Pendiente",
  insala: "En sala",
};

/** 08:00 a 12:00. La grilla de product-panel.module.css asume 3 columnas × 5 filas (valores literales). */
const ROWS = 5;

function AgendaMock() {
  const hours = Array.from({ length: ROWS }, (_, h) => `${String(8 + h).padStart(2, "0")}:00`);
  return (
    <div className={s.agenda} aria-hidden="true">
      <div className={s.agTop}>
        <strong>Agenda</strong>
        <span className={s.agSeg}>
          <span className={s.agSegOn}>Día</span>
          <span>Semana</span>
          <span>Lista</span>
        </span>
        <span className={`${s.bar} ${s.agTopBar}`} />
      </div>
      <div className={s.agGrid}>
        <div className={s.agCorner} />
        {PROS.map((p) => (
          <div key={p.initials} className={s.agHead}>
            <span className={s.avatar} style={{ background: p.color }}>
              {p.initials}
            </span>
            <span className={`${s.bar} ${s.w55}`} />
          </div>
        ))}
        <div className={s.agHours}>
          {hours.map((h) => (
            <span key={h}>{h}</span>
          ))}
        </div>
        {PROS.map((p, col) => (
          <div key={p.initials} className={s.agCol}>
            {APPTS.filter(([c, start, dur]) => c === col && start + dur <= ROWS * 2).map(
              ([, start, dur, status, svc, label]) => (
                <div
                  key={`${start}-${label}`}
                  className={`${s.appt} ${s[`st_${status}`]}${dur === 1 ? ` ${s.short}` : ""}`}
                  style={{
                    top: `calc(${(start / (ROWS * 2)) * 100}% + 2px)`,
                    height: `calc(${(dur / (ROWS * 2)) * 100}% - 4px)`,
                  }}
                >
                  <span className={s.apptSvc} style={{ background: svc }} />
                  <span className={s.apptT}>{label}</span>
                  {dur > 1 && <span className={s.apptS}>{STATUS_LABEL[status]}</span>}
                </div>
              ),
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ProductPanel() {
  return (
    <aside className={s.panel} aria-label={`Qué es ${BRAND_NAME}`}>
      <Link href="/" className={s.logo} aria-label={`${BRAND_NAME}, inicio`}>
        <KineLogo size={32} light />
      </Link>
      <div className={s.body}>
        <div className={`${s.copy} k-enter-fade`}>
          <p className={s.title}>Tu consultorio, ordenado de punta a punta.</p>
          <p className={s.sub}>
            Agenda, turnos online, historia clínica y cobros. Con herramientas propias para kinesiología.
          </p>
        </div>
        <div className={`${s.stage} k-enter k-enter-d1`}>
          <AgendaMock />
          <div className={s.float} aria-hidden="true">
            <div className={s.floatH}>
              <span>Sala de espera</span>
              <span className={s.planChip}>Clínica</span>
            </div>
            <div className={s.floatRow}>
              <span className={s.avatar} style={{ background: "#3d7010" }}>
                MR
              </span>
              <span className={`${s.bar} ${s.w55}`} />
              <span className={`${s.pill} ${s.pillCalled}`}>Llamado</span>
            </div>
            <div className={s.floatRow}>
              <span className={s.avatar} style={{ background: "#1f4fbe" }}>
                AL
              </span>
              <span className={`${s.bar} ${s.w40}`} />
              <span className={`${s.pill} ${s.pillInsala}`}>En sala</span>
            </div>
          </div>
        </div>
      </div>
      <p className={s.foot}>Para kinesiología y para cualquier consultorio de salud.</p>
    </aside>
  );
}

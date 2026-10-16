import { KineLogo } from "@/components/ui/kine-logo";
import base from "./landing.module.css";
import s from "./product-mock.module.css";

/**
 * [VX2-c1] Pantalla del producto en el hero (prototipo `landing-b.html` .frame + `shared.js` T.agenda).
 *
 * D-VX3: mock en CSS, **sin cifras de negocio ni nombres de personas**. Mismo lenguaje que la agenda real (AGENTS §5):
 * la barra lateral del turno es el servicio, el fondo es el estado (tokens `--st-*`/`--rc-*`) y el profesional va por
 * un canal no cromático (avatar con iniciales). Todo `aria-hidden`: es decorativo, el texto de la sección ya dice qué
 * hace la agenda. Server component: cero JS.
 */
type Status = "completed" | "attending" | "confirmed" | "pending" | "insala";

const STATUS_LABEL: Record<Status, string> = {
  completed: "Atendido",
  attending: "En atención",
  confirmed: "Confirmado",
  pending: "Pendiente",
  insala: "En sala",
};

/** Iniciales + color de avatar (literales del prototipo: no dependen de la paleta). */
const PROS: { initials: string; color: string }[] = [
  { initials: "AL", color: "#1f4fbe" },
  { initials: "MR", color: "#3d7010" },
  { initials: "JP", color: "#5e92cc" },
  { initials: "SG", color: "#0f3781" },
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
  [3, 1, 2, "confirmed", "#3d7010", "Osteopatía"],
  [3, 5, 2, "pending", "#1f4fbe", "Sesión de kinesiología"],
];

/** Menú del mock. Sin «Reportes»: hoy es un placeholder (EV-D3) y no se muestra lo que no está. */
const NAV = ["Inicio", "Agenda", "Pacientes", "Planes", "Biblioteca", "Sala de espera"];

/** Alto de una hora en px (el mismo de `.hours`/`.col` en el CSS). */
const ROW_PX = 56;

export function AgendaMock({ cols, rows }: { cols: number; rows: number }) {
  const hours = Array.from({ length: rows }, (_, h) => `${String(8 + h).padStart(2, "0")}:00`);
  return (
    <div className={s.agenda} aria-hidden="true">
      <div className={s.top}>
        <strong>Agenda</strong>
        <span className={s.seg}>
          <span className={s.on}>Día</span>
          <span>Semana</span>
          <span>Lista</span>
        </span>
        <span className={`${base.mockBar} ${base.w30} ${s.topBar}`} />
      </div>
      <div
        className={s.grid}
        style={{ gridTemplateColumns: `48px repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `auto ${ROW_PX * rows}px` }}
      >
        <div className={s.corner} />
        {PROS.slice(0, cols).map((p) => (
          <div key={p.initials} className={s.head}>
            <span className={base.avatar} style={{ background: p.color }}>
              {p.initials}
            </span>
            <span className={`${base.mockBar} ${base.w55}`} />
          </div>
        ))}
        <div className={s.hours}>
          {hours.map((h) => (
            <span key={h}>{h}</span>
          ))}
        </div>
        {PROS.slice(0, cols).map((p, c) => (
          <div key={p.initials} className={s.col}>
            {APPTS.filter(([col, start, dur]) => col === c && start + dur <= rows * 2).map(
              ([, start, dur, status, svc, label]) => (
                <div
                  key={`${start}-${label}`}
                  className={`${s.appt} ${s[status]}${dur === 1 ? ` ${s.short}` : ""}`}
                  style={{ top: (ROW_PX * start) / 2 + 2, height: (ROW_PX * dur) / 2 - 4 }}
                >
                  <span className={s.svc} style={{ background: svc }} />
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

export function ProductMock() {
  return (
    <div className={s.frame} aria-hidden="true" data-testid="product-mock">
      <div className={s.bar}>
        <i />
        <i />
        <i />
        <span className={s.url} />
      </div>
      <div className={s.app}>
        <div className={s.side}>
          <span className={s.sideLogo}>
            <KineLogo size={28} markOnly />
          </span>
          {NAV.map((n) => (
            <span key={n} className={`${s.navItem}${n === "Agenda" ? ` ${s.navOn}` : ""}`}>
              <i />
              {n}
            </span>
          ))}
        </div>
        <div className={s.main}>
          <div className={s.onlyLg}>
            <AgendaMock cols={4} rows={6} />
          </div>
          <div className={s.onlySm}>
            <AgendaMock cols={2} rows={5} />
          </div>
        </div>
      </div>
    </div>
  );
}

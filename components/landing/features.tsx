import type { ReactNode } from "react";
import base from "./landing.module.css";
import s from "./features.module.css";

/**
 * [VX2-c1] «Funciones» (brief VX §3.1, cada claim con su evidencia en el brief):
 * - Agenda: vistas Día/Semana/Lista (`components/agenda/agenda-toolbar.tsx:16-19`), varios profesionales.
 * - Turnos online: turnero por link con profesional/servicio/horario (`lib/public-booking.ts`).
 * - HC: evoluciones editables 24 h, después enmienda o anulación con motivo (`lib/clinical-notes-logic.ts:150`).
 * - Cobros: copago y obra social (`lib/copago.ts`). Roles: la HC queda para quien atiende (`lib/visibility.ts`).
 * - Clínica: salas y Recepción. Sin «en vivo» (D-VX26: la sala no depende de realtime para funcionar).
 *
 * [HD-18] Dos tiles con flag, que `app/page.tsx` calcula en el render ISR (env del server, no por request):
 * - `onlinePayments` (`mpConnectMode() !== "off"`): «Cobrá la seña con tu Mercado Pago». Desde T5 el cobro del
 *   turnero entra a la cuenta MP del profesional o del consultorio (`lib/mp-connect-types.ts:14`, OAuth del vendedor),
 *   ya no a la de la plataforma: la decisión de VX-Z de no nombrar MP era por eso y deja de aplicar con el flag.
 * - `tvDisplay` (`env.REALTIME_DRIVER === "supabase"`): «Pantalla para la sala de espera», plan Clínica (módulo
 *   `salaEspera`, `lib/tenant-modules.ts:80`; la pantalla lo exige en `lib/display-device-internal.ts:133`).
 * Con los dos apagados (default de prod) la landing queda como antes. WhatsApp no se nombra (`public-claims.test.ts`).
 * Los mocks son decorativos (`aria-hidden`) y sin cifras (D-VX3).
 */
const svg = (children: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const ICON = {
  agenda: svg(
    <>
      <rect x="3" y="4.5" width="18" height="16" rx="3" />
      <path d="M3 9.5h18M8 3v3M16 3v3" />
    </>,
  ),
  link: svg(
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>,
  ),
  file: svg(
    <>
      <path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9.5A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z" />
      <path d="M14 3.5V8h4M9 12.5h6M9 16h4" />
    </>,
  ),
  cash: svg(
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 9.5v5M18 9.5v5" />
    </>,
  ),
  users: svg(
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M15.5 14.2a4.5 4.5 0 0 1 5.5 4.3" />
    </>,
  ),
  card: svg(
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M2.5 9.5h19M6.5 15h4" />
    </>,
  ),
  tv: svg(
    <>
      <rect x="2.5" y="4" width="19" height="13" rx="2.5" />
      <path d="M8 21h8M12 17v4" />
    </>,
  ),
  globe: svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z" />
    </>,
  ),
};

type Slot = { svc: string; bg: string; tall?: boolean };
const SKY7 = "var(--sky-700)";
const SKY5 = "var(--sky-500)";
const LIME5 = "#8ecc30";
const LIME7 = "#3d7010";
const CONF = "var(--st-confirmed-bg)";
const DONE = "var(--st-completed-bg)";
const PEND = "var(--st-pending-bg)";

const WEEK: { day: string; slots: Slot[] }[] = [
  { day: "Lun", slots: [{ svc: SKY7, bg: CONF }, { svc: LIME5, bg: DONE }, { svc: SKY7, bg: PEND }] },
  { day: "Mar", slots: [{ svc: LIME7, bg: CONF }, { svc: SKY5, bg: CONF, tall: true }] },
  { day: "Mié", slots: [{ svc: SKY7, bg: DONE }, { svc: LIME7, bg: PEND }, { svc: LIME5, bg: CONF }, { svc: SKY7, bg: CONF }] },
  { day: "Jue", slots: [{ svc: SKY5, bg: CONF, tall: true }, { svc: SKY7, bg: PEND }] },
  { day: "Vie", slots: [{ svc: LIME7, bg: CONF }, { svc: SKY7, bg: CONF }] },
];

function Tile({ className, icon, lime, title, children }: { className: string; icon: ReactNode; lime?: boolean; title: string; children: ReactNode }) {
  return (
    <article className={`${base.card} ${s.tile} ${className}`}>
      <span className={`${base.iconTile}${lime ? ` ${base.iconTileLime}` : ""}`}>{icon}</span>
      <h3 className={base.h3}>{title}</h3>
      {children}
    </article>
  );
}

/**
 * [HD-18] Copy de los tiles con flag, en constantes para que cada claim lleve su evidencia en la misma línea
 * (`public-claims.test.ts` mira el código sin comentarios y acepta `// claim-ok: <archivo>:<línea>`).
 */
const PAY_TITLE = "Cobrá la seña con tu Mercado Pago"; // claim-ok: lib/mp-connect-types.ts:14
const PAY_BODY =
  // claim-ok: lib/public-booking-payment.ts:120
  "Si lo activás, quien reserva por el link paga la seña o el turno completo, y la plata entra a tu cuenta de Mercado Pago.";
const TV_TITLE = "Pantalla para la sala de espera"; // claim-ok: lib/display-device-internal.ts:133
const TV_BODY =
  // claim-ok: components/tv/tv-screen.tsx:70
  "Un televisor en la sala muestra a quién llaman y a qué consultorio pasa, y se actualiza solo.";

export type FeatureFlags = {
  /** `mpConnectMode() !== "off"`: el turnero cobra a la cuenta de Mercado Pago del consultorio (T5). */
  onlinePayments?: boolean;
  /** `env.REALTIME_DRIVER === "supabase"`: la pantalla de la sala de espera (T7) se actualiza sola. */
  tvDisplay?: boolean;
};

export function Features({ onlinePayments = false, tvDisplay = false }: FeatureFlags = {}) {
  // Con uno solo prendido, el tile ocupa la fila entera (sin hueco en el bento); con los dos, mitad y mitad.
  const extraSpan = onlinePayments && tvDisplay ? s.half : s.full;
  return (
    <section className={base.section} id="funciones" aria-labelledby="funciones-title">
      <div className="k-container">
        <div className={base.sectionHead}>
          <span className={base.eyebrow}>
            <span className={base.eyebrowDot} aria-hidden="true" />
            Funciones
          </span>
          <h2 className={base.h2} id="funciones-title">
            Todo lo del día a día, en un mismo lugar
          </h2>
          <p className={base.lead}>
            Lo que usa quien atiende y lo que usa quien organiza: la agenda, los pacientes y la plata del consultorio.
          </p>
        </div>
        <div className={s.bento}>
          <Tile className={s.agenda} icon={ICON.agenda} title="La agenda de cada profesional">
            <p>Día, semana y lista, con varios profesionales lado a lado.</p>
            {/* VX-Z: eran pills con borde y 32 px de alto, y se leían como tabs clickeables. Son una lista de lo que
                tiene la agenda: chips chatos, sin borde ni cursor de mano (estilo en .views). */}
            <ul className={s.views} role="list" aria-label="Vistas de la agenda">
              <li>Día</li>
              <li>Semana</li>
              <li>Lista</li>
            </ul>
            <div className={s.week} aria-hidden="true">
              {WEEK.map((d) => (
                <div key={d.day}>
                  <b>{d.day}</b>
                  {d.slots.map((x, i) => (
                    <s key={i} style={{ borderLeftColor: x.svc, background: x.bg, ...(x.tall ? { height: 36 } : null) }} />
                  ))}
                </div>
              ))}
            </div>
          </Tile>
          <Tile className={s.online} icon={ICON.link} title="Turnos online">
            <p>
              Tus pacientes reservan desde el link de tu consultorio: eligen profesional, servicio y horario.
            </p>
            <div className={s.linkPill} aria-hidden="true">
              {ICON.globe}…/c/tu-consultorio
            </div>
          </Tile>
          <Tile className={s.hc} icon={ICON.file} title="Pacientes e historia clínica">
            <p>
              La ficha de cada paciente con sus turnos, sus archivos y las fichas de cada consulta. Una ficha se
              edita durante 24 horas; después se enmienda o se anula con motivo, nunca se borra.
            </p>
          </Tile>
          <Tile className={s.cobros} icon={ICON.cash} lime title="Cobros en pesos">
            <p>Copago y obra social en cada turno. Sabés qué se cobró y qué falta.</p>
          </Tile>
          <Tile className={s.roles} icon={ICON.users} lime title="Un rol para cada persona">
            <p>
              Profesionales, secretaría y administración. Cada uno ve lo que necesita; la historia clínica queda para
              quien atiende.
            </p>
          </Tile>
          {onlinePayments && (
            <Tile className={extraSpan} icon={ICON.card} title={PAY_TITLE}>
              <p>{PAY_BODY}</p>
            </Tile>
          )}
          {tvDisplay && (
            <article className={`${base.card} ${s.tile} ${extraSpan}`}>
              <div className={s.tileHead}>
                <span className={base.iconTile}>{ICON.tv}</span>
                <span className={base.planChip}>Plan Clínica</span>
              </div>
              <h3 className={base.h3}>{TV_TITLE}</h3>
              <p>{TV_BODY}</p>
            </article>
          )}
          <article className={`${base.card} ${s.tile} ${s.sala}`}>
            <div className={s.salaCopy}>
              <span className={base.planChip}>Plan Clínica</span>
              <h3 className={`${base.h3} ${s.salaTitle}`}>Salas y sala de espera</h3>
              <p>Recepción marca quién llegó, cobra el copago y cada profesional llama al siguiente.</p>
            </div>
            <div className={s.board} aria-hidden="true">
              <div className={s.row}>
                <span className={base.avatar} style={{ background: "#3d7010" }}>
                  MR
                </span>
                <span className={`${base.mockBar} ${base.w55}`} />
                <span className={`${s.pill} ${s.called}`}>Llamado</span>
              </div>
              <div className={s.row}>
                <span className={base.avatar}>AL</span>
                <span className={`${base.mockBar} ${base.w40}`} />
                <span className={`${s.pill} ${s.insala}`}>En sala</span>
              </div>
              <div className={s.row}>
                <span className={base.avatar} style={{ background: "#5e92cc" }}>
                  JP
                </span>
                <span className={`${base.mockBar} ${base.w70}`} />
                <span className={`${s.pill} ${s.attending}`}>En atención</span>
              </div>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

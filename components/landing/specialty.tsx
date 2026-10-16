import type { ReactNode } from "react";
import { BRAND_NAME } from "@/lib/brand";
import base from "./landing.module.css";
import s from "./specialty.module.css";

/**
 * [VX2-c1] Sección de especialidad. Título literal de Martin (D-VX2): «Enfoque exclusivo para kinesiólogos y
 * osteópatas». Sin switch Kine/General (D-VX15): el título dice «exclusivo», y la línea de cierre manda a quien tiene
 * otro tipo de consultorio a lo que ofrece Clínica general.
 *
 * Solo lo que existe (brief VX §3.1):
 * - Ejercicios propios y del catálogo: el ejercicio que crea un profesional nace con el `tenantId` del consultorio
 *   (`lib/exercises.ts:429-430`), o sea que se comparte con **todo el equipo** (D-VX27; con el paciente no: eso es ES4).
 *   Catálogo, plantillas y favoritos desde Consultorio (`lib/tenant-modules.ts:69`, `lib/plan-templates.ts:270`).
 * - Terapia manual: catálogo de maniobras por sesión (`prisma/schema.prisma:1036-1062`).
 * - Diagnóstico: mapa corporal + ejercicios por fase (`lib/diagnosis-engine.ts`, `components/diagnostico/*`).
 * - Planes de kinesiología u osteopatía y curva EVA (`components/planes/plan-card.tsx`, pestaña Evolución).
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

const ITEMS: { icon: ReactNode; title: string; text: string }[] = [
  {
    icon: svg(<path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11" />),
    title: "Ejercicios propios y del catálogo",
    text: `Armá tu biblioteca: los ejercicios que creás quedan para todo tu consultorio. Desde el plan Consultorio sumás el catálogo de ${BRAND_NAME}, plantillas de plan y favoritos.`,
  },
  {
    icon: svg(
      <>
        <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12" />
        <path d="M11 11.5V4a1.5 1.5 0 0 1 3 0v7.5" />
        <path d="M14 11.5V5.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L3.3 16a1.6 1.6 0 0 1 2.4-2.1L8 16" />
      </>,
    ),
    title: "Terapia manual",
    text: "Tu catálogo de maniobras, para sumarlas a cada sesión junto con los ejercicios.",
  },
  {
    icon: svg(
      <>
        <circle cx="12" cy="4.5" r="2" />
        <path d="M12 7v7M8 9.5h8M12 14l-3 6.5M12 14l3 6.5" />
      </>,
    ),
    title: "Diagnóstico específico",
    text: "Marcás la zona en el mapa corporal, afinás el cuadro y te propone ejercicios por fase para armar el plan.",
  },
  {
    icon: svg(<path d="M4 12h3l2-5 4 10 2-5h5" />),
    title: "Planes de tratamiento",
    text: "De kinesiología u osteopatía, sesión por sesión, con los turnos atados al plan.",
  },
  {
    icon: svg(<path d="M4 19.5h16M6 16l4-5 3 3 5-7" />),
    title: "Seguimiento del dolor",
    text: "La escala EVA de cada sesión, en una curva.",
  },
];

export function Specialty() {
  return (
    <section className={`${base.section} ${s.section}`} id="kinesiologia" aria-labelledby="kinesiologia-title">
      <div className={`k-container ${s.grid}`}>
        <div>
          <div className={`${base.sectionHead} ${s.head}`}>
            <span className={base.eyebrow}>
              <span className={base.eyebrowDot} aria-hidden="true" />
              Kinesiología y osteopatía
            </span>
            <h2 className={base.h2} id="kinesiologia-title">
              Enfoque exclusivo para kinesiólogos y osteópatas
            </h2>
            <p className={base.lead}>
              Además de la agenda y la historia clínica, herramientas pensadas para tratamientos de varias sesiones.
            </p>
          </div>
          <ul className={s.list} role="list">
            {ITEMS.map((it) => (
              <li key={it.title}>
                <span className={`${base.iconTile} ${base.iconTileLime}`}>{it.icon}</span>
                <div>
                  <h3>{it.title}</h3>
                  <p>{it.text}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className={s.other}>
            ¿Otro tipo de consultorio? Con Clínica general tenés agenda, turnos e historia clínica.{" "}
            <a className="k-link" href="#funciones">
              Ver funciones
            </a>
          </p>
        </div>
        <div className={s.mock} aria-hidden="true" data-testid="plan-mock">
          <div className={s.card}>
            <div className={s.cardHead}>
              <span className={base.avatar}>AL</span>
              <span className={`${base.mockBar} ${base.w40}`} />
              <span className={s.disc}>Kine</span>
            </div>
            <strong className={s.cardTitle}>Plan de tratamiento</strong>
            <div className={s.dots}>
              {["done", "done", "done", "done", "next", "", "", ""].map((d, i) => (
                <i key={i} className={d ? s[d] : undefined} />
              ))}
            </div>
            <div className={s.row}>
              <span className={`${base.mockBar} ${base.w30}`} />
              <span className={`${base.mockBar} ${base.w55}`} />
            </div>
          </div>
          <div className={s.card}>
            <strong className={s.cardTitle}>Escala EVA</strong>
            <svg className={s.eva} viewBox="0 0 300 80" preserveAspectRatio="none">
              <path d="M0 20H300M0 40H300M0 60H300" stroke="rgba(15,30,51,.07)" strokeWidth="1" />
              <path d="M6 10 L54 16 L102 28 L150 34 L198 48 L246 56 L294 64 L294 80 L6 80 Z" fill="rgba(94,146,204,.14)" />
              <polyline
                points="6,10 54,16 102,28 150,34 198,48 246,56 294,64"
                fill="none"
                stroke="var(--sky-700)"
                strokeWidth="2.5"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </div>
        </div>
      </div>
    </section>
  );
}

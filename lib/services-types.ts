import type { Discipline } from "@/lib/plans-constants";

export type ServiceRow = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  durationMin: number;
  priceCents: number;
  practitionerId: string | null;
  practitionerName: string | null;
  /** Cupos simultáneos por horario; null = ilimitado. */
  maxConcurrent: number | null;
  bookingsCount: number;
  /** Práctica del catálogo global que representa (B1.4); null = servicio libre. */
  practiceId: string | null;
  practiceName: string | null;
  /** Planes M1 (D10): disciplina del servicio; null = sin disciplina. */
  discipline: Discipline | null;
  /**
   * S13 · PQ-11: disciplina que sugiere el catálogo por la práctica
   * (`suggestDisciplineFromSpecialties`). Solo se ofrece en la UI; nunca se
   * guarda sola. null = la práctica no la implica (o es ambigua).
   */
  suggestedDiscipline: Discipline | null;
};

/**
 * CF3 (§30, D-CF3-6): tope de servicios PROPIOS que un profesional crea por la vía propia (sin «Configuración»). El
 * catálogo del consultorio lo maneja el Titular; esto evita que una sola cuenta llene la grilla de la agenda y el
 * turnero (cada servicio es una fila más en cada carga). Quien tiene «Configuración» no tiene tope.
 * CF3b (SV, 05-nov): cuenta SOLO los propios; con el tope lleno puede seguir creando «Para todo el consultorio».
 */
export const OWN_SERVICES_MAX = 30;

export const SERVICES_COPY = {
  /** Vía propia: editar o borrar es solo de lo suyo; crear a nombre de OTRO profesional, nunca. */
  ownOnly: "Solo podés crear o editar tus propios servicios. Para los del consultorio hace falta el permiso «Configuración».",
  ownLimit: `Llegaste al máximo de ${OWN_SERVICES_MAX} servicios propios. Borrá alguno que no uses o crealo para todo el consultorio.`,
  notBookable: "Tu usuario no está habilitado para atender en este consultorio.",
  /** CF3b (SV): checkbox del alta, en «Mi agenda» y en Configuración › Servicios. */
  forClinicLabel: "Para todo el consultorio",
  /** «Mi agenda», desmarcado (el default): servicio propio. */
  forClinicSelfOff: "Queda como tuyo: aparece solo en tu agenda y en tu turnero, no en el de los demás profesionales.",
  /**
   * «Mi agenda», marcado. Condicional a propósito: el Titular (o quien tiene «Configuración») también ve esta pantalla
   * y para él los colegas quedan públicos como siempre; sin el permiso, quedan privados y el servicio deja de ser suyo.
   */
  forClinicSelfOn:
    "Todos los profesionales lo pueden dar en la agenda. Si no tenés el permiso «Configuración», en el turnero de tus colegas aparece recién cuando cada uno lo hace público, y después de crearlo no lo vas a poder editar ni borrar.",
  /** Configuración › Servicios, marcado (el default de esa pestaña, como el «Todos los profesionales» de antes). */
  forClinicConfigOn: "Lo atienden todos los profesionales y aparece en el turnero de cada uno.",
  /** Configuración › Servicios, desmarcado: de un solo profesional (el propio usuario o el elegido). */
  forClinicConfigOff: "Lo atiende solo el profesional que elijas: a los demás no les aparece.",
} as const;

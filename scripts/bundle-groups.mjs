/**
 * Presupuesto de bundle por grupo de ruta (VX F-e, contrato C-F6).
 *
 * kB gz de JS inicial (root + layouts + page). blocking = `check-bundle-budget.mjs` sale 1 si la ruta excede o crece
 * > 10 % sobre baseline.
 *
 * Por qué grupos y no un número global: hasta F-e había dos cortes (150 kB «públicas» / 180 resto) y el de 150 lo
 * cumplía todo con margen, aunque el root cargaba framer-motion (~35 kB) en superficies que no lo usan (H-BUNDLE). Los
 * números de cada grupo salen de lo medido sin framer en el root (públicas ~105-112 kB) más un margen chico: el turnero
 * suma el selector de horarios y el checkout, el portal su shell. Workspace/Plataforma/onboarding quedaron en reporte
 * hasta PF1-Z (16-oct, D-PF-B): PF1 los bajó (máx. workspace 260,6 → 175,7 en /agenda; ver `.docs/PERF.md` §PF1) y
 * desde ahí bloquean igual que el resto.
 *
 * El orden importa: `groupFor` devuelve el PRIMER match, y `workspace` (/.*\/) es el comodín final. `/plataforma-mfa`
 * cae en `plataforma` porque /^\/plataforma/ también lo matchea. `/cuenta` y `/onboarding` NO son públicas (C-F7: usan
 * modales/toast), por eso no están en `public`.
 */
export const BUNDLE_GROUPS = [
  {
    id: "public",
    budget: 120,
    blocking: true,
    match: [
      /^\/$/,
      /^\/(login|signup|forgot|reset)$/,
      /^\/auth\//,
      /^\/invite\//,
      /^\/(sin-acceso|suspendido|cuenta-desactivada|mantenimiento|verificar-acceso|elegir-consultorio)$/,
      /^\/_not-found$/,
      // DIR-3a: directorio público (mismas reglas que la landing: sin providers ni framer).
      /^\/profesionales/,
      /^\/consultorios\//,
      // TP-3i (§25.2 hallazgo 14): link de pago `/pagar/[token]`. Sin el match caía en `workspace` (180): es la página
      // que el paciente abre desde WhatsApp o el mail, server sin providers ni framer (guard de superficies públicas).
      /^\/pagar\//,
      // LG-P (PV §27): `/terminos` y `/privacidad`, `force-static` y sin JS propio. Sin el match caían en `workspace`
      // (180). Anclado con `$`: una ruta futura que empiece con «terminos» no entra acá por accidente.
      /^\/(terminos|privacidad)$/,
      // TK-U2 (PV §27): `/contacto`, la entrada única de contacto (lead o ticket de sesión). Sin el match caía en
      // `workspace` (180). Anclado con `$`, como los legales.
      /^\/contacto$/,
    ],
  },
  { id: "turnero", budget: 135, blocking: true, match: [/^\/c\/\[slug\]\/booking/, /^\/booking\//] },
  { id: "portal", budget: 125, blocking: true, match: [/^\/portal/] },
  { id: "onboarding", budget: 160, blocking: true, match: [/^\/onboarding/] },
  { id: "plataforma", budget: 180, blocking: true, match: [/^\/plataforma/] }, // incluye /plataforma-mfa
  // TV-1c (plan §26.10): pantallas de sala `/tv`. Corren en teles y sticks de gama baja todo el día, sin providers ni
  // framer (guard de superficies de display en public-surface-imports). `(\/|$)` y no un prefijo pelado: `/tvx` no es
  // una pantalla (el brief decía /^\/tv/; se acota para que una ruta futura que empiece con «tv» no caiga acá).
  { id: "display", budget: 125, blocking: true, match: [/^\/tv(\/|$)/] },
  { id: "workspace", budget: 180, blocking: true, match: [/.*/] }, // resto (incluye /cuenta)
];

/** Grupo de una ruta ya limpia (sin `/page` ni grupos `(x)`): el primer match, en orden. */
export function groupFor(route) {
  return BUNDLE_GROUPS.find((g) => g.match.some((re) => re.test(route)));
}

# CLAUDE.md

@AGENTS.md

## Específico de Claude Code

- **Workflows** para olas con varias sesiones: sub-sesiones en paralelo con dueño único por archivo → un revisor
  que mira el diff real → corrección → integrador que aplica los handoffs y deja `tsc` en 0.
  - Una tarea con más de ~3 sub-tareas o ~6 archivos se parte. Techo orientativo: ~50 tool calls por agente.
  - Los contratos del plan (un cambio de schema, un "preservar" de AUDIT §5, un `it.fails` a dar vuelta) se
    **copian literal** en el prompt del agente, sin parafrasear.
  - En auditorías, los agentes son **de solo lectura** y se les dice explícitamente.
  - La corrida completa (build + integración con los dos roles) va como fase de gate al cerrar cada ola.
- **Resume de workflows, lección del 23-sep:** reanudar con `resumeFromRunId` **re-ejecutó en vivo** los agentes
  concurrentes, porque sus claves de cache cambian con el orden. Después de una interrupción:
  1. Revisar el `journal.jsonl` y el output: qué terminó y qué no.
  2. Si lo que falta es poco, lanzar un workflow **nuevo y chico** con solo lo que falta, que lea los resultados
     previos del output.
  3. No relanzar ni reanudar a ciegas.
- Esfuerzo: medio para tareas definidas y simples; **alto** en seguridad/RLS, plata (copago, cobros, MP),
  concurrencia de turnos, timezone y migraciones.
- Antes de lanzar una ola: `git log -1` = commit de la ola anterior y `git status` limpio. Si no, frenar y pedir
  el commit.
- **Cierre de cada tanda:**
  - verificar vos mismo: `npx tsc --noEmit`, tests del área con `TZ=UTC`, `npm run guard:isolation` y
    `git status`;
  - migraciones aplicadas en local y verificadas, más el **orden para prod explicitado** (precheck → backup →
    staging → prod; qué va antes y después del deploy);
  - `.docs/` actualizado y podado;
  - memoria actualizada;
  - el comando de commit para Martin (lo ejecuta él): `git add -A` con las excepciones como `':!archivo'`, mensaje
    corto de una línea, sin co-autor (AGENTS.md §4).
- **IDs que chocan:**
  - «H1-H6» son hallazgos altos de la auditoría, no olas.
  - «A0-A3 / B-pre / B0-B4 / C0-C2» son olas de bloque. «P0-P4» = olas de Planes (= B0-B4), y se ejecutan en las
    corridas «ES1..ES4» (ES1 = P0, ES2a = P1, ES2b = P2, ES3 = P3, ES4 = P4). Las olas internas de B-pre se llamaron
    B1-B5 y no son las de Planes. «S01…S32» (y P0-Cs, P2-C1, etc.) son sesiones de Planes ([.docs/PLANES.md](.docs/PLANES.md)).
    «Ronda N» es el historial de entregas en AUDIT/QA.
  - «EV0 / EV1» son corridas de verticales, «SR» la de Salas/Consultorios y «SV» la de Sala de Espera realtime
    (13/14-oct, [.docs/VERTICALES.md](.docs/VERTICALES.md) §7); no son olas de Planes. «M1» = `plans_booking_link`,
    «M2» = `tenant_verticals` (EV0), «M3a» = `billing_paid_at` (ES3), «M4» = `rooms` (SR), «M5» =
    `reception_call_realtime` (SV; se llamó «M3» antes del 08-oct). «EV-D1..D6», «SR-D1..D9» y «SV-D1..D16» (SV-D5..D16
    en el plan §18.14) son decisiones con default (no las PD/PQ de Planes); «C-EV1..9» y «C-SV1..10» son contratos de
    EV0 y de SV (no los C1-C14 de Planes). «V1-V7» y «R1-R4» son las verificaciones y prechecks de SV en Supabase
    ([.docs/EXTERNAL-CONFIG.md](.docs/EXTERNAL-CONFIG.md) §3.1).
  - «IAM-0..4» son las olas del bloque **Identidad y acceso** (14-oct, plan §19.4; sesiones IAM-0a..4c, cierre
    IAM-Z): no tienen nada que ver con la «IA» de diagnóstico del bloque E. «C-IAM1..7» son sus contratos,
    «IAM-D1..D12» sus decisiones con default y «S1..S11» los supuestos del fake de GoTrue
    (`tests/helpers/gotrue-fake.ts`, los verifica `scripts/diagnose-auth.ts`). «M6» = `identity_access` (IAM-1).
    «BO» = back-office de Plataforma (bloque siguiente; «BO0..BO5» sus olas, «M7» = `platform_backoffice`, «BO-D*»
    sus decisiones). «VX» = cara pública y pulido visual; «DIR» = directorio público de consultorios (diferido).
  - **§20 del plan (15-oct; orden 0 → PL → EV2 → VX → ES4 → PF → DIR):**
    - «PL» = planes SaaS, cobros y cuenta: olas PL-A (recorte de auditoría), PL-0 (M8), PL-1..PL-3, cierre PL-Z;
      «PL-D*» decisiones con default, «C-PL*» contratos. «H-PL1..4» son hallazgos (no olas).
    - «EV2» = Evoluciones (HC base; olas EV2-0..3, EV2-Z; «EV2-D*» decisiones). No es la pestaña «Evolución» (curva EVA).
    - «VX0» = prototipo. «Ola F» = cimientos: F-a (tokens/fuentes), F-b1 (`AuthShell` v2), F-b2 (primitivas), F-d
      (motion fuera del root), F-e (bundle/CSP), cierre F-Z; «F-c» no se usa (cerrada en PL-F). «F2» = codemod de
      colores. «VX2» = superficies públicas en dos tandas: VX2.1 (VX2-a auth, b1 estado/invite/404, b2 muro de
      módulo, c1 landing, c2 precios/contacto) y VX2.2 (d1 turnero, d2 resultados, e onboarding, f portal); cierre
      «VX-Z». «C-F1..C-F7» = contratos de la Ola F (tokens, clases, motion, AuthShell, primitivas, bundle, superficies
      públicas) y «C-VX-L» el de landing ↔ precios/contacto. «D-VX1..12» son de Martin y «D-VX13..31» defaults del
      brief (ROADMAP «VX ✅»). No confundir F-a..F-e con los fixers «F1/F2/F3a» de P3.Z ni con «F2» de AUDIT/Planes.
    - «PF» = performance + pulido: «PF-0a..d» (diagnóstico temprano), «PF1», «PF-M» (M10), «PF2»; «D-PF*» decisiones.
      «PF0» (sin guion) es la parte de bundle de la Ola F.
    - «ES4-D*» = decisiones del portal en §20.8. Sesiones de ES4: «S24a/S24t/S24v» (identidad, token, invitación),
      «P4-C» (contratos de datos del portal), «S24/S24p/S24d/S24r/S24e/S24i/S32/S32a» (P4.1) y «S26b/S26p/S26s»
      (matriz staff, matriz portal, perf/soak). «DIR-0» = hotfix del email como nombre; «DIR-1..3» olas del directorio
      (DIR-1 = M11), «DIR-D*» decisiones.
    - «M8» = `pl_accounts_billing`, «M9» = `clinical_notes`, «M10» = `perf_fk_indexes`, «M11» = `public_directory`.
    - «H-SLOW» (lentitud general), «H-TURN» (turnero por profesional), «H-EV2», «H-LAND», «H-LOGIN», «H-BUNDLE», «H-DOC»:
      hallazgos de §20.2 ([AUDIT §Ronda 24](.docs/AUDIT.md)).
  - **§22 del plan (18-oct; orden de §22.13):**
    - «HF» = hotfixes de la Tanda A (HF-1a/1b realtime, HF-2a/2c «Llegó» y latido, HF-3 2FA del superadmin): **no**
      son los hallazgos H1-H6. «D-HF1..7» sus decisiones con default y «D-LL1» el estilo del latido (punto lima, borde
      en Apariencia).
    - «TP» = turnero público y cobro de turnos: TP-0 (sin cobro), TP-1 (ventana de 5 días; sesiones TP-1s/TP-1u), TP-M
      (= **M18** `turnero_cobros_mp`), TP-2 (server), TP-3 (UI). «TP-D*» sus decisiones. No confundir con la
      «Tanda»: TP es un bloque.
    - «MPS-D7» = cobro de la suscripción el día 4 (enmienda de MPS, §22.6).
    - «H-TP0..3», «H-RT1..3», «H-LL1..2», «H-2FA», «H-YT» son hallazgos de §22.2 (AUDIT «Ronda 30»), no olas.
    - «Tanda A» / «Tanda B» = las dos primeras tandas sin migración de §22.13; «T3..T7» las siguientes (T3 = AS M12,
      T4 = FC M14, T5 = TP M18, T6 = WA M15 + MPS M16, T7 = TV M17). Se ejecutan T3 → T4 → T5 → T7 → T6 + infra:
      el número no es el orden. «T*» no son los «S01…S32» de Planes.
  - **§23 del plan (19-oct; T3 = AS):** «T3a..T3e» son sus tandas y «T3-Z» el cierre (revisores → fixers Z-* → gate →
    docs); las sesiones se nombran «T3c-1c», «T3d-2w», etc. (IDs de test `[AS-1c]`, `[AS-2w]`…). «M12» =
    `agenda_secretaria_config`. «C-AS1» = modelo de permisos (`billing.collect`/`collectOwn`, `patients.editAdmin`,
    `tenant.sensitive`), «C-AS2» = cobros con medio de pago, «C-AS3» = tope de turnos por intervalo (clave
    `kinesoft:phour:`); no son los C1-C14 de Planes. «AS-D*» son sus decisiones con default; «Hallazgo B» (lookback 240'
    del cupo) es un hallazgo de §23.2, no el revisor B de T3-Z.
  - **§24 del plan (19-oct; T4 = FC, fichas clínicas):**
    - «T4a..T4e» (más T4c-2 y T4d0) son sus tandas y «T4-Z» el cierre. Sesiones: «FC-0» (= **M14** `fichas_clinicas`),
      «FC-1a..1e», «FC-2a..2i», «FC-3a..3k» (más 3h1/3h2, 3e1/3e2, 3i1), «FC-4a/4b», integradores «FC-2i/3i1/4i»,
      «FC-E» (E2E) y en el cierre «FC-ZA/ZB» (revisores), «FC-ZG» (gate) y «FC-ZD» (docs). «ZF1..ZF5» son los fixers de
      T4-Z: no son F1/F2 de P3.Z ni F-a..F-e de la Ola F. «T3-Y» fue la sesión suelta previa a T4.
    - «FC-D1..D32» son sus decisiones con default (§24.14: FC-D22..D32 son las nuevas de T4) y «FC-UI-D1..D11» las de UI.
      «C-FC1..C-FC11» son sus contratos (no los C1-C14 de Planes). «M-1/M-3 ★» y «B-1..B-6» son hallazgos del revisor (a)
      de T4-Z; «A1-A4» los del revisor (b), que no son las olas A0-A3. «H-FC1..15» son los hallazgos de §24.2.
    - En el portal, **«Documentos»** (lo que el profesional compartió, `PatientDocument`) no es la pestaña
      **«Archivos»** del perfil (`PatientFile`, adjuntos del equipo). **«Compartir con el paciente»** (una ficha al portal)
      no es **«Compartir con un profesional»** (dar acceso al paciente a otro kine). «Ficha» es la ficha clínica: los
      datos del paciente son «datos del paciente», no «ficha».
    - ADR-025 = fichas. ADR-026 = T5 (cobros online); ADR-027..029 en §26, abajo.
    - «T4-Y» (22-oct) = el aviso por mail al paciente cuando se anula una ficha compartida; no es una tanda de T4.
  - **§25 del plan (19/22-oct; T5 = TP, cobros online con Mercado Pago):** «T5a..T5f» sus tandas y «T5-Z» el cierre.
    Sesiones «TP-P1..P5» (piezas puras), «TP-M» (= **M18** `turnero_cobros_mp`), «TP-K1..K4» (contratos y stubs),
    «TP-2a..2i» (server), «TP-3a..3k» + «TP-3z» (UI e integrador), «TP-E» (E2E); en el cierre «TP-ZA/ZB» (revisores),
    «TP-ZF1..3» (fixers: no son F1/F2 de P3.Z ni los ZF1..ZF5 de T4), «TP-ZG» (gate) y «TP-ZD» (docs). Los `[TP-0]`/`[TP-1]`
    de los tests son de la Tanda A, no de T5. «C-TP1..C-TP14» son sus contratos (no los C1-C14 de Planes); «TP-D22..D30» y
    «TP-UI-D1..D12» sus defaults. «M1..M3», «B1..B6» y «A1» de T5-Z son hallazgos de los revisores (AUDIT «Ronda T5»), no
    migraciones ni olas. «S1..S11» de T5 son los supuestos de `scripts/diagnose-mp-connect.ts`, no los del fake de GoTrue.
    Vocabulario: «seña», «link de pago» (nunca «preferencia» ni «cupón»), «reintegro» (nunca «reembolso»), «Mercado Pago»
    completo, «Secretaría» con tilde en la UI.
  - **§26 del plan (22-oct; T7 = TV, T6 = WA + MPS):** olas «X0..X9» (X0 = migraciones solas, X9 = cierre). Sesiones
    «MIG», «ENV», «TV-1a/1k/1c», «TV-2s/2d/2u1/2u2/2p/2w1/2w2», «TV-I» (integrador de TV), «WA-P1/P3», «WA-S1..S8»,
    «WA-U1..U4/U6», «MPS-1a/1b/K», «MPS-2a/2b1/2b2/2c», «MPS-3a/3b/3c», «MPS-4a/4b», «INF-S/INF-DEV», «QA-M/QA-E»,
    «PEND-a/b», «INT» (integrador global) y los E2E «TV-E/MPS-E/WA-E». Cierre: «ZA/ZB» (revisores), «ZF1..ZF3» (fixers:
    no son los ZF1..ZF5 de T4, ni los TP-ZF de T5, ni F1/F2 de P3.Z), «ZG» (gate) y «DOC-1..3» (docs). «C-TV», «C-WA1..9»
    y «C-MPS2..12» son sus contratos (no los C1-C14 de Planes); «TV-D5..D14», «WA-D17..D30» y «MPS-D8..D24» sus defaults.
    «M17» = `reception_displays`, «M15» = `whatsapp_messaging`, «M16» = `saas_mp_subscriptions`: el número no es el
    orden, que es **M12 → M14 → M18 → M17 → M15 → M16** (timestamp). ADR-027 = MPS, ADR-028 = TV, ADR-029 = WA. «S1..S13»
    de `scripts/diagnose-whatsapp.ts` y «S1..S10» de `scripts/diagnose-mp-subscriptions.ts` no son los del fake de GoTrue
    ni los S1..S11 de T5. «Pantalla» / «TV» es `ReceptionDisplay` (`/tv`), no la vista Recepción de la agenda.
  - **§27 del plan (27-oct; «PV» = tanda antes de vender):** olas «Q0..Q5» y «Z». Bloques «TK» (tickets), «LG»
    (legales), «IN» (inactividad) y «BR» (renombre a «Consultorio Online»). Sesiones «PV-K», «W1a..W1j», «W2a», «W3a»,
    «TK-M/S1/S2/U1/U2/U3», «LG-S/P/U», «IN-S», «BR-a/b/c1/c2/d1/d2/Z», «INT-c»; cierre «ZA/ZB» (revisores) y
    «ZF1a/ZF1b/ZF2» (fixers: no son los ZF1..ZF5 de T4, ni los ZF1..ZF3 de T6/T7, ni TP-ZF). «HD-1..18» son ítems de
    endurecimiento de PV (no los H1-H6). «M19» = `support_tickets`; ADR-030 = tickets, ADR-031 = inactividad.
    Decisiones con default «D-TK*», «D-LG*», «D-IN*», «D-BR*», «D-HD*» (§27.7). «M1..M7» y «B1..B18» de ZA/ZB son
    hallazgos de los revisores (AUDIT «Ronda PV»), no migraciones. «Tickets» es la etiqueta de `/plataforma/mensajes`.
  - **§28 del plan (30-oct; «CF» = feedback del primer cliente):** olas «CF-0..CF-5» y «Z». Sesiones «CF-M» (= **M20**),
    «CF-K», «CF-L», «CF-C», «CF-X», «CF-RT», «CF-NOT», «CF-UI1», «CF-NAV», «CF-E», «CF-W1/W2», «CF-FORM», «CF-EVA1..3»,
    «CF-MAIL», «CF-LOCK», «CF-P», «CF-A», «CF-PL», «CF-U1/U1b/U2..U5», «CF-E2E» (e «INT» de integrador). Cierre: «ZA/ZB»
    (revisores) y «ZF1..ZF4» (fixers: no son los ZF1..ZF5 de T4, ni los ZF1..ZF3 de T6/T7, ni los ZF1a/ZF1b/ZF2 de PV,
    ni TP-ZF). «A1/A2», «M3..M10» y «B11..B22» de ZB son hallazgos (AUDIT «Ronda CF»), no migraciones ni olas A.
    «CF-D1..12» son decisiones con default (§28.2); **los IDs de test `[CF-D1]`/`[CF-D2]` son del formulario del
    turnero y chocan con ellos** (no son CF-D1/CF-D2). «M20» = `cf_agenda_rules`; ADR-032 = «no atiende servicios
    distintos a la vez»; lock nuevo `kinesoft:pday:` (día del profesional, enmienda C2 (1d)). `[CF-L*]` de los tests
    de EVA no son los `[CF-L1..4]` de locks.
  - **§29 del plan (02-nov; «CF2» = feedback de los clientes, 2.ª ronda):** olas «W0..W6», «INT» y «Z». Sesiones «MIG»
    (W0, = **M21**), agenda y sala «A-K/A-P/A-$/A-WS/A-MS/A-SL/A-LD/A-HD/A-MV/A-MU/A-RC/A-SB/A-SD/A-AG1/A-AG2», turnero y
    avisos «T-K/T-P/T-SE/T-S1/T-S3/T-S4/T-L/T-S2X/T-U1/T-U2/T-U3», pacientes y caja «P-K/P-PL/P-NAV/P-X/P-S1/P-S2/P-S3/
    P-U1/P-U2/P-U4/P-D», e «INT-P». Cierre: «ZA/ZB» (revisores) y «ZF1..ZF4» (fixers: **no** son los ZF1..ZF5 de T4, ni
    los ZF1..ZF3 de T6/T7, ni los ZF1a/ZF1b/ZF2 de PV, ni los ZF1..ZF4 de CF, ni TP-ZF). «ZA-1..8» y «ZB-1..13» son
    hallazgos de los revisores (AUDIT «Ronda CF2»). «D-CF2-1..20» son decisiones con default (§29.2; no son las CF-D* de
    CF). «M21» = `cf2_profesional_caja`; ADR-033 = caja y reparto, ADR-034 = avisos mail + Web Push; lock nuevo
    `kinesoft:rshare:` (reparto por tenant). IDs de test `[CF2-<sesión><n>]` (ej. `[CF2-TS1-3]`, `[CF2-ZF3-1a]`); no
    existe `[CF2-D*]`. «Caja» (`/caja`) no es «Cobros» (`/cobros`, los online de T5); «Reparto» es el % entre
    profesionales, no el arancel de la OS.
  - **§30 del plan (04-nov; «CF3» = feedback de los clientes, 3.ª ronda):** olas «W0..W5» y «Z». Bloques «PR» (precio por
    profesional), «AU» (autoconfiguración), «SH» (compartir desde el perfil) y «SD» (sede digital). Sesiones «MIG» (W0, =
    **M22**), «PR-K/PR-T/PR-C1/PR-C2/PR-P/PR-U/PR-W», «AU-S/AU-C/AU-U1/AU-U2», «SH-L/SH-S/SH-U»,
    «SD-P/SD-R/SD-K/SD-S/SD-C/SD-U/SD-M» e «INT». Cierre: «ZA/ZB» (revisores) y «ZF1..ZF3» (fixers: **no** son los ZF de T4,
    T6/T7, PV, CF ni CF2, ni TP-ZF). «M1..M3» y «B1..B6» de ZA/ZB son hallazgos (AUDIT «Ronda CF3»), no migraciones.
    «D-CF3-1..13» son decisiones con default (§30.2; no son las CF-D* ni las D-CF2-*). IDs de test `[CF3-<sesión><n>]`
    (ej. `[CF3-ZF1-3]`, `[CF3-MIG5]`, `[CF3-SDR]`). «M22» = `cf3_precios_sede`; ADR-035 = precio por profesional, ADR-036 =
    sede digital. **«Sede» / «sitio web»** en CF3 es la página pública `/<slug>` (`app/(sede)/`, `Tenant.siteEnabled`,
    Configuración → «Sitio web»): **no** es la `Location` («sede» física, Configuración → Sedes, filtro «Sede» de `/sala`).
  - **CF3b (05-nov; decisiones de Martin sobre CF3, misma §30):** sesiones «BR-L» (logo en la app), «BR-P» (paletas),
    «BR-H» (encabezado de la sede), «SV» (servicios con «Para todo el consultorio»), «MIG2» (= **M23**) y «MIG3»
    (= **M24**), «CT-K1/CT-K2/CT-U/CT-L/CT-I» (co-titular y matrícula; CT-I = integrador) y «PH-S/PH-U1/PH-U2» (foto).
    Cierre: «ZA2» (revisor) y «ZF4a/ZF4b/ZF5» (fixers: **no** son los ZF4/ZF5 de T4 ni de CF/CF2, ni los ZF1..ZF3 de
    CF3). «BR-*» de CF3b no son las «BR-a..d/Z» del renombre de PV; «SV» no es la corrida de Sala de Espera realtime;
    «CT-*» no son los C-* de ningún bloque; «D1..D3» de CT-K2 son defaults de sesión, no decisiones de Martin. IDs de
    test `[CF3-<sesión><n>]` (ej. `[CF3-ZF4a1]`, `[CF3-ZF5-7]`, `[CF3-MIG2-5]`, `[CF3-BRL…]`) o `[<sesión>-<n>]`
    (`[PH-S-11]`, `[BR-P-1]`, `[CT-K1…]`). «M23» = `cf3_co_titular`, «M24» = `cf3_practitioner_photo`; ADR-037 =
    co-titular y matrícula, ADR-038 = foto de la persona y marca del consultorio. **«Co-titular»** (`Membership.grantCoOwner`) es un PROFESIONAL
    con lo del Titular salvo la suscripción, la titularidad y el principal: «Titular principal» = la membresía OWNER.
    «Matrícula» de CF3b es la de la PERSONA (`UserProfile.license*`, dato de seguridad, no se publica): no es
    `Practitioner.licenseNumber` (por consultorio, pública) ni la del directorio. «TMP» como paleta (`Tenant.palette =
    "tmp"`, «de marca») no es el consultorio TMP en sí.
  - «Plan» choca en tres sentidos: plan de tratamiento, plan SaaS del tenant y plan de la obra social.
  - «Vertical» (`Tenant.vertical`: General / Kinesiología) es el tipo de consultorio: no es la «disciplina» de un
    servicio o plan (Kine / Osteo) ni el plan SaaS (`Tenant.plan`). «Kine PRO» = vertical Kinesiología + plan PRO.
- Las skills genéricas de `.claude/skills/` no mandan sobre `.docs/`, sobre AGENTS.md ni sobre este archivo.

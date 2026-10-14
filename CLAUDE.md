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
  - «Plan» choca en tres sentidos: plan de tratamiento, plan SaaS del tenant y plan de la obra social.
  - «Vertical» (`Tenant.vertical`: General / Kinesiología) es el tipo de consultorio: no es la «disciplina» de un
    servicio o plan (Kine / Osteo) ni el plan SaaS (`Tenant.plan`). «Kine PRO» = vertical Kinesiología + plan PRO.
- Las skills genéricas de `.claude/skills/` no mandan sobre `.docs/`, sobre AGENTS.md ni sobre este archivo.

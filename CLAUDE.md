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
  - el comando de commit para Martin (lo ejecuta él).
- **IDs que chocan:**
  - «H1-H6» son hallazgos altos de la auditoría, no olas.
  - «A0-A3 / B-pre / B0-B4 / C0-C2» son olas de bloque. «P0-P4» = olas de Planes (= B0-B4), y se ejecutan en las
    corridas «ES1..ES4» (ES1 = P0, ES2a = P1, ES2b = P2, ES3 = P3, ES4 = P4). Las olas internas de B-pre se llamaron
    B1-B5 y no son las de Planes. «S01…S32» (y P0-Cs, P2-C1, etc.) son sesiones de Planes ([.docs/PLANES.md](.docs/PLANES.md)).
    «Ronda N» es el historial de entregas en AUDIT/QA.
  - «EV0 / EV1» son corridas de verticales y «SV» la corrida de Sala de Espera realtime (07-oct,
    [.docs/VERTICALES.md](.docs/VERTICALES.md)); no son olas de Planes. «M1» = `plans_booking_link`, «M2» =
    `tenant_verticals` (EV0), «M3» = `reception_call_realtime` (SV). «EV-D1..D6» y «SV-D1..D4» son decisiones con
    default (no las PD/PQ de Planes); «C-EV1..9» son contratos de EV0 (no los C1-C14 de Planes).
  - «Plan» choca en tres sentidos: plan de tratamiento, plan SaaS del tenant y plan de la obra social.
  - «Vertical» (`Tenant.vertical`: General / Kinesiología) es el tipo de consultorio: no es la «disciplina» de un
    servicio o plan (Kine / Osteo) ni el plan SaaS (`Tenant.plan`). «Kine PRO» = vertical Kinesiología + plan PRO.
- Las skills genéricas de `.claude/skills/` no mandan sobre `.docs/`, sobre AGENTS.md ni sobre este archivo.

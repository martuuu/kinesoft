# Planes · Planning final de ejecución (olas P0-P4 = B0-B4 del plan) sobre B-pre (`3ff2e50`)

> **Firma:** tech lead. **Base:** el planning unificado, con las críticas de tres lentes (ownership, integridad, completitud/ejecución) aplicadas. Cada crítica se verificó en el código antes de aceptarla o rechazarla.
> **Criterio cuando hay conflicto:** primero la integridad de los datos del cliente vivo; después, que cada sesión sea chica, tenga un solo dueño por archivo y se pueda verificar.
> **Estado verificado:** `develop @ 3ff2e50`, working tree limpio, todo en solo lectura.

## Estado y decisiones firmadas (03-oct, actualizado 16-oct)

- **16-oct: ES4 (P4) ✅ — Planes completo (P0-P4).** Sin migración. Commits P4.0a `890f902` · P4.0b `3b61579` · P4.1 A
  `5e045bd` · P4.1 B `e28d2c4` · P4.2 `bd1faad` · P4.Z (1) `48eefb9`; P4.Z (2) sin commitear. Hechas S24a, S24t, S24v,
  S24, S24p, S24d, S24r, S24e, S24i, S32, **S32a**, S26b, S26p, S26s; **no** se hicieron S26a (E2E → roadmap) ni
  S25L/S25n/S25b (sin legacy). Hallazgos en [AUDIT «Hallazgos de ES4»](AUDIT.md), QA en [QA §ES4](QA.md), decisiones
  ES4-D* en el [ROADMAP](ROADMAP.md). Siguiente: **PF**.
- **15-oct: manda el §20 del plan vigente** (resumen en [ROADMAP.md «Plan vigente (15-oct)»](ROADMAP.md)). Orden:
  0 → PL → EV2 → VX → **ES4** → PF → DIR. B, SR y SV están en prod desde el 14-oct (migraciones incrementales, **sin
  reset**); prod tiene datos demo. **ES4 sin E2E** (S26a Playwright → roadmap), **sin legacy** (S25L/S25n/S25b no se
  hacen; precheck de solo lectura que lo confirme) y **sin reset**. Cambios a §12 en la nota de su tope.
- **SV (Sala de Espera realtime) ejecutada el 13/14-oct** en develop sobre `5811ea2` (SR), commit `d70513a`; M5 en prod desde el 14-oct.
  **1 migración:** M5 `20261013120000_reception_call_realtime` (SV0, sola). Planning: plan vigente §18. Toca Planes solo en los refs del post-commit
  (`plans-engine-internal`, `plans-lifecycle-internal`, `plans-adopt-internal`, `sessions.ts` ahora informan `roomId` y
  el profesional real del turno adoptado; AUDIT §Ronda 20). Arquitectura en
  [ARCHITECTURE.md §Sala de Espera realtime + ADR-006](ARCHITECTURE.md); QA en [QA.md §SV](QA.md).
  ES4 comparte con SV solo `authz-matrix.test.ts` y `package.json` (por handoff). EV1 ✅ (`d2092e6`).
- **SR (Salas/Consultorios)** commiteada (`5811ea2`). **1 migración:** M4 `20261009120000_rooms` (SR0, sola), aplicada y verificada **solo en el Docker local**
  (31 migraciones al día). Planning: plan vigente §17 + §17.5 (respuestas de Martin). Entraron también las decisiones
  4 y 5 del cierre de ES3 (SR-D4F Facturación, SR-D5I ingresos por rol; ver §11 «Decididas por Martin»). Locks: enmienda
  **C2 (1b)** (§4). Arquitectura en [ARCHITECTURE.md §Salas (SR)](ARCHITECTURE.md); cierres en AUDIT §Ronda 19; QA en
  [QA.md §Salas (SR)](QA.md).
- **ES3 (P3)** commiteada (`ad50059`). M3a `20261008120000_billing_paid_at` aplicada solo en el Docker local.
- **Decisiones de Martin del 08-oct** (fuente: plan vigente §16.1; también van al §9 del plan):

  | # | Tema | Decisión |
  |---|---|---|
  | 1 | Quién arma y ve planes | Los arma el profesional (`plans.manage`). Los demás profesionales los ven **como hoy**: con "Consultorio común" o si les comparten el paciente. La Secretaria solo ve el turno (sin título). "Sesión a medida" exige `plans.manage`. |
  | 2 | Saldo del plan | Lo que paga la obra social no suma en "cobrado" (se informa aparte). |
  | 3 | Alta anticipada y cancelación | Se pregunta qué hacer con los turnos futuros y por defecto se cancelan. **Cancelar no genera cargo.** Los turnos ya cobrados quedan en la agenda, el saldo los muestra "a favor" y el reintegro es manual. El **cargo por cancelación tardía** se suma al **bloque D**, junto con el cargo por ausencia: hay que modelar "cargos" en el saldo para que no aparezcan como plata a favor del paciente. |
  | 4 | Cambio de estado en la UI vieja | Mantiene los turnos. El default "cancelar" entra con la UI nueva de ES3. |
  | 5 | Payload de la agenda | El +5 % se mide sobre turnos sueltos. El DTO compacto va en ES3 (solo UI). |
  | 6 | Widget de ingresos | Se **arregla**: suma MP + copagos cobrados a mano, con la obra social aparte, y tiene un selector **Mes/Semana** recordado por usuario. |
  | 7 | Salas/Consultorios | Corrida propia **SR**, después de ES3 y antes de SV. |

- **Orden de corridas (historia):** ES3 ✅ → SR ✅ → SV ✅ → IAM ✅ → BO ✅ → EV1 ✅. El «reset de prod + deploy único» del 07-oct **no se hizo**: el go-live del 14-oct fue incremental. Lo que sigue es el orden de §20 (arriba).
- **Migraciones nuevas del bloque B después de M2:** **M3a** `billing_paid_at` (ES3, P3.0.0, sola), **M4** `rooms` (SR, sola) y **M5** `reception_call_realtime` (SV, sola).
- **Decisiones de Martin del 07-oct** (detalle y contratos en [VERTICALES.md](VERTICALES.md); fuente: plan vigente §15):
  1. **Prod se resetea antes del go-live** — *superada: el reset no se hizo; el go-live del 14-oct fue incremental y prod tiene datos demo (las sesiones de legacy igual no se hacen, §20.8 del plan).* Texto original: No hay datos de prod que preservar:
     el deploy final es `migrate deploy` desde vacío + bootstrap ([VERTICALES.md §9](VERTICALES.md)). Por eso se caen
     las sesiones y prechecks de legacy (ver §0.4 y las marcas "eliminada (reset de prod 07-oct)" en §12 y §16).
  2. **Verticales del SaaS:** Consultorio General (sin Planes, Sesiones, Diagnóstico ni Ejercicios) y Consultorio
     Kinesiología (base = ejercicios propios; PRO = + catálogo de Plataforma). Corridas nuevas **EV0** (ahora, con la
     migración M2 `tenant_verticals`) y **EV1** (barrido de General, después de ES4).
  3. **Sala de Espera realtime** para las dos verticales: corrida nueva **SV** (migración M5 `reception_call_realtime`; renombrada el 08-oct).
  4. **No se rehace el planning de P2-P4:** lo nuevo entra como **enmiendas de una línea**, copiadas al tope de §10,
     §11 y §12 (se pegan literal en los prompts).
  - Orden del 07-oct (reemplazado por el del 08-oct, arriba): suma SR entre ES3 y SV.
- **Planning firmado por Martin el 03-oct:** PD-01 a PD-16 y PQ-01 (= sí: la autorización de la OS se registra en el plan). Cambiaron PD-09 (la Secretaria opera **todos** los turnos) y PD-15 (vínculo del portal automático por email verificado). PQ-02 a PQ-15 siguen como consultas al cliente con su default (§1).
- **Las enmiendas E0-E5 del plan (§14.8) están integradas en este texto** y mandan sobre la versión del journal. Las verificó el workflow `wf_bf603f14-cb7` (3 críticos de solo lectura):
  - E0: fugas vivas (`getPatient`, firmador de media, `listBookingsInRange`) en ES1;
  - E1: Secretaria (nivel "administrativo", `agenda.operateAll`, ola nueva P0.2);
  - E2: autorización de la OS (tabla `ProgramAuthorization`);
  - E3: portal ampliado e identidad multi-consultorio (`PatientChangeRequest`, `Patient.userId` único por consultorio, ola P4.0).
- **ES1 (P0) ejecutada el 04-oct** en develop, sin migraciones: §8 con las enmiendas de abajo (§5, C2, C5, C8, S11e, P2-C1, V1-D18/V2/M13). Commit `d7ac75f`. **Pendiente:** QA de staging ([QA.md §Planes P0](QA.md)). Cierres y hallazgos en AUDIT §Ronda 14.
- **ES2a (P1) ejecutada el 04-oct** en develop: M1 `plans_booking_link` escrita, aplicada y verificada **solo en el Docker local** (§9). Commit `0edb0c8`. **C1 enmendado en P1.Z (F1):** los dos CHECK de pricing usan `IS NOT DISTINCT FROM` en vez de `=` (con `pricingMode` NULL, `=` da NULL y el CHECK dejaba pasar un precio sin modo); decisión del orquestador, avisada a Martin. El bloque SQL de §3 ya es idéntico al archivo (sha256 `7a0e2797…45cd`). Deploy: con el reset del 07-oct, M1 se aplica desde vacío dentro de la cadena completa ([MIGRACIONES-RUNBOOK §"Go-live con reset"](MIGRACIONES-RUNBOOK.md)); el down-script y la ventana sin uso de §2.4 quedaron obsoletos. Cierres y hallazgos en AUDIT §Ronda 15.
- **EV0 ejecutada el 07-oct** en develop (verticales, /plataforma de consultorios, turnero con switch, REVOKE de la Data API). Commit `ddfdff3`. M2 `tenant_verticals` aplicada solo en el Docker local. La revisión sumó enmiendas a S14, S15/S27a, S17d y S22b (copiadas abajo en §10 y §11) y a SV01 ([VERTICALES.md §5](VERTICALES.md)). Cierres en AUDIT §Ronda 16.
- **ES2b (P2) ejecutada el 07-oct** en develop sobre `ddfdff3`, **commit `58ec36f`**. **Sin migraciones nuevas.** Todo server (core de turnos, motor, sincronía, lecturas, ciclo de vida, mover/re-planificar, cantidad y precio, autorización de la OS, Diagnóstico, adopción) + P2-FX1 (buscador de la agenda). Firmas en §4 C8; decisiones y handoffs para ES3 al final de §10; cierres en AUDIT §Ronda 17; ADR-004.
- **ES3 (P3) ejecutada el 08-oct** en develop sobre `58ec36f`, **commit `ad50059`**. **1 migración:** M3a
  `billing_paid_at` (P3.0.0, sola), aplicada y verificada solo en el Docker local. Olas P3.0.0 → P3.0 (P3-C) → P3.1 (10)
  → P3.2 (10) → P3.Z.0 (retiro S27a/S27b) → P3.Z (2 revisores, 4 fixers, integrador, gate). UI completa de Planes
  (editor único y 4 puertas, agenda, drawer, Seguimiento, perfil, `/planes/[disciplina]`, plantillas) + ingresos
  reales del dashboard (S14r) + retiro de las altas viejas. Decisiones que cambiaron el contrato en §11 «Decisiones de
  ES3»; cierres en AUDIT §Ronda 18; QA en [QA.md §Planes P3](QA.md).
- **(Historia, superada por el go-live incremental del 14-oct y por §20.)** **Decisión de Martin del 04-oct: nada se despliega hasta cerrar el bloque B.** Se ejecuta wave a wave (ES1 → ES2a → EV0 → ES2b → ES3 → SR → SV → ES4 → EV1, orden del 08-oct), todo en develop, con commit de Martin entre corridas. El deploy, la migración en prod, Playwright y la suite completa van al final del bloque B (§16). Esto reemplaza los "a prod" intermedios del texto original (hotfix de ES1 y M1 expand-first).
- **Una sola migración en todo Planes:** M1 `plans_booking_link`. Ahora suma 2 tablas con RLS y la relajación de `Patient_userId_key`, una excepción a "todo aditivo" que Martin aprobó el 03-oct. Fuera de Planes, en el mismo bloque B: M2 `tenant_verticals` (EV0), M3a `billing_paid_at` (ES3), M4 `rooms` (SR) y M5 `reception_call_realtime` (SV), cada una sola en su ola.
- **Abierto para Martin** (el Paso 0 no lo resuelve):
  1. ~~Fugas E0 en prod: ¿hotfix?~~ **Resuelto por el reset (07-oct):** no hay hotfix de E0; prod se resetea y el código nuevo sale en el deploy único. **Pero** queda abierto el hallazgo de bloque A `data-api-anon-sin-rls` (la anon key de Supabase podría leer/escribir 9 tablas sin RLS si la Data API expone `public`): acción de Martin en consola **ya**, independiente del reset ([VERTICALES.md §1](VERTICALES.md), AUDIT).
  2. ~~¿Incluye a B-pre?~~ **Resuelto (04-oct):** sí. B-pre, M1 y Planes van en un solo deploy al cierre de B, con las migraciones en orden `catalog_global` → `agenda_foundations` → `plans_booking_link` (§16).
  3. ~~Datos administrativos por defecto~~ **Resuelto por PD-13:** un rol sin `clinical.read` (Secretaria, Facturación) tiene **siempre** el nivel `admin` sobre los pacientes del tenant: ni más (nunca `full`, aunque haya "Consultorio común", share o asignación) ni menos (ve los datos administrativos de todos los pacientes, sin depender de "Consultorio común"). S02p lo implementa en `patientAccessFor`, `bulkPatientAccess` y `seesAll`.

---

## 0. Contexto

### 0.1 Requisitos del dueño (contrato; se copian literal en los prompts)

- **Planes sí o sí.** Un plan genera turnos reales en la agenda, con FK Booking→Session/Program.
- **Costos:** por sesión y por paquete.
- **Disciplinas separadas:** Kinesiología y Osteopatía.
- **Puertas de creación:** Diagnóstico, Tab Planes del paciente, `/planes/[disciplina]` y "crear desde el turno".
- **Alcance funcional:** seguimiento; ciclo de vida (pausar, cancelar, completar); edición y adopción de turnos; ~~legacy de prod~~ (sin objeto desde el reset de prod del 07-oct); portal (gateado); QA + E2E.
- **No hay "Planes v1".** Se construye completo, una sola vez, sobre el motor de B-pre. El plan referencia `(practitionerId, serviceId) + locationId` (ADR-003).
- **Reglas de ejecución:**
  - una migración encabeza su ola, sola;
  - `lib/bookings.ts` siempre serial;
  - un solo dueño por archivo y por ola, con handoffs al integrador;
  - tests primero;
  - TZ=UTC y TZ=AR;
  - gate por sesión y gate de ES completo;
  - integrador, revisor de solo lectura y fixer al cierre de cada corrida;
  - se preserva AUDIT §5;
  - Martin commitea y migra prod. El agente, nunca.

### 0.2 Verificado en el código (lo nuevo respecto del unificado)

**Escrituras sin control:**
- **`updateProgram` escribe sin pasar por sesiones.** Escribe `totalSessions`, `frequency` y `startDate` sin crear, archivar ni mover sesiones (`lib/patients.ts:1462-1516`).
- **`deleteSession` borra en duro.** Además, nunca baja `totalSessions` de 1 (`:1588-1617`).

**Recepción y alta de turnos:**
- **`markReceptionAction` solo atrapa P2025** (`lib/bookings.ts:1764`). Un P2002 del nuevo único parcial terminaría en un 500.
- **El upsert de `createBooking` pisa campos.** El holder solo selecciona `tenantId` (`:1120-1124`), y la rama `update` resetea `copagoCents` y `status` (`:1186-1200`).

**Acceso y PHI:**
- **ASSISTANT queda en acceso basic** si no hay `sharedPatientView`, asignación o share (`lib/visibility.ts:140-154`).
  - `updateBooking` exige full (`bookings.ts:1365`).
  - ASSISTANT no tiene `clinical.read` (`lib/capabilities.ts:60`).
- **Fuga viva en el ICS.** Solo distingue full de basic (`lib/bookings-export-internal.ts:60-63`) y la ruta no chequea capability (`app/api/agenda/export/route.ts`). Con `sharedPatientView`, ASSISTANT exporta title, description y notes.
- **Fugas vivas de la verificación del 03-oct (E0, bloque A, alta):**
  - **`getPatient`** (`lib/patients.ts:647`) es una server action sin gate. Devuelve la HC completa por RPC a cualquier miembro y su action-id está en un chunk público. Tiene 0 callers.
  - **`resolveMediaUrl`** (`lib/exercise-media.ts:67`) es un `"use server"` que firma **cualquier** clave del bucket, sin sesión.
  - **Storage** (`lib/files.ts:147,202,255`, `lib/exercise-media.ts`) opera con el JWT del usuario, no con service role. Las policies de `storage.objects` en prod no se pudieron verificar.
  - **`listBookingsInRange`** (`lib/bookings.ts:525-640`) se puede llamar por RPC: gatea full/basic pero no `clinical.read`.
- **Secretaria (E1):**
  - **`createPatient` asigna el paciente a quien lo crea** (`lib/patients.ts:747`). Si lo crea la Secretaria, ella queda con acceso full a la HC y el kine que lo atiende queda en básico.
  - **Con `sharedPatientView`, un share o un paciente propio, ASSISTANT tiene "full".** Fuera de `listAgendaBookings`, ninguna superficie mira `clinical.read`.
  - **En el drawer, "Usar como diagnóstico" con los campos ocultos (null) borra el diagnóstico del paciente** (`setPatientDiagnosis(pid,'','')`).
- **Identidad del portal (E3):**
  - `Patient.userId` es `@unique` global (`prisma/schema.prisma:178`). Un paciente con ficha en dos consultorios no puede vincular el segundo: el callback (`app/auth/callback/route.ts:69-83`) tira un P2002 sin capturar y responde 500.
  - Hoy ningún flujo llena `userId`, y el portal matchea por email entre tenants (`lib/portal.ts:84,141`).

**Duraciones:**

| Dónde | Rango |
|---|---|
| Service (`lib/services.ts:70`) | 5..480 |
| PractitionerService (`practitioner-config-schemas.ts:23-24`) | 5..480 |
| `BookingCreate` / `BookingUpdate` (`lib/validation.ts:168,198`) | 15..240 |
| Lookback del loader (`lib/availability/types.ts:80`) | 240 |

**Firmas que limitan el diseño:**
- `BookingUpdateInput` es `z.input<typeof BookingUpdate>` (`validation.ts:213`). No trae los flags de forzado ni `expectedUpdatedAt`: viven en la intersección de `updateBooking` (`bookings.ts:1316-1325`).
- `lockCapacity` hace un `$executeRaw` por clave (`lib/booking-cap-lock.ts:41-46`).
- `searchPatientsForAssignment(q: string)` tiene 4 callers.

**Tooling y entorno:**
- `tsconfig.json` excluye `scripts`: ni tsc ni build chequean los scripts.
- **Los tests de perf regraban archivos versionados.** `loaders.perf` regraba `tests/perf/baseline.json` (`:77-78`); `pool-pressure` (`:70`) y `agenda-multi` (`:160`) escriben sus JSON. No hay presupuestos hasta C1 (`:7-8`).
- **El E2E no tiene Auth local.** `.env.local` no tiene `NEXT_PUBLIC_SUPABASE_URL`, `..._ANON_KEY` ni `SUPABASE_SERVICE_ROLE_KEY` (`grep -c` = 0). `docker-compose.yml` solo levanta `db` y `adminer`.
- `agenda-backfill.test.ts:51` matchea el marcador con `BEGIN$`.
- Los tests de carrera existentes cuentan **cualquier** advisory en espera (`time-blocks.test.ts:471-473`, `bookings-availability.test.ts:441`).
- Existe `scripts/lib/assert-safe-target.ts`.

**Tests que condicionan contratos:**
- `visibility.test.ts:79,142-145` archiva un paciente con un plan ACTIVE y espera `ok:true`.
- `toBookingDTO` deja opcionales los campos B4.1, y `bookings-reception.test.ts:380` afirma que **no están** en la proyección completa.

**Lecturas con `index` crudo:**
- `EvaScore.source = session-<index>-post` solo se escribe (`lib/sessions.ts:499`); nadie lo lee por index.
- `lib/dashboard.ts:319` usa `sessionsDone: s.index`, y `seguimiento/[sessionId]/page.tsx:13,25` titula con `s.index`.

**Fechas UTC:**
- ✅ **Cerrado en ES1** (S02u-diag, S02u-plan): las cuatro superficies (`diagnostico-wizard.tsx`, `assign-plan-modal.tsx`, `plan-template-apply.tsx`, `plan-view.tsx`) usan hoy AR (`toARDateKey` / `lib/plan-form-defaults.ts`).
- **`plan-view.tsx:346` NO es bug.** Hace slice UTC de `startDate`, y eso da el día correcto tanto con 00:00Z (legacy) como con 03:00Z (nuevo).

**Otros:**
- `ensureTag(label, kind)` es una server action con `kind` libre y `Tag` global (`lib/exercises.ts:207-221`).
- `PROGRAM_NEARING_DISCHARGE` solo se emite desde Seguimiento (`sessions.ts:541-552`). El enum tiene `SYSTEM`.
- **AUDIT:** de los 26 slugs que el unificado "cerraba", **20 no existen** en `.docs/AUDIT.md`.
  - Existen: `plan-startdate-utc-midnight`, `portal-plan-expone-notas-de-sesion`, `retroactive-copago-on-coverage-replace`, `session-index-no-unique-constraint`, `statustag-fmtmoney-duplicados` y `no-realtime-agenda-compartida`. Esta última dice "(B4)" y choca con P4.

### 0.3 Qué cambia respecto del planning unificado (lo grueso)

1. **La extracción del core de turnos (S07c) sale de ES1 y pasa a ES2b (P2.0).**
   - ES1 queda acotado: fixes vivos (incluidas las fugas E0 y la Secretaria, E1) y módulos aditivos sin callers.
   - El refactor de la superficie más crítica llega a prod con el resto del bloque B, probado por ES2b-ES4 y por staging.
   - En ES1, `lib/bookings.ts` recibe cambios acotados en dos olas seriales: S07k (keys, determinismo y `listBookingsInRange` sin PHI) y S07sb (gate de la Secretaria, P0.2).
2. **Corridas:** 4 sesiones de ejecución grandes más una **corrida corta solo para M1** (ES2a). Se declara explícitamente y lo decide Martin (PD-01).
3. **Sesiones grandes partidas** según la regla de CLAUDE.md (más de ~3 sub-tareas o ~6 archivos):

| Antes | Después |
|---|---|
| S02b | S02d · S02t · S02p (con el ICS) |
| S02u | S02u-plan · S02u-diag · S02u-perfil |
| S11 | S11e (motor) · S11v (verificador) · S11x (carreras, en P2.2) |
| S12 | S12 (sincronía) · S12p (proyección de agenda) |
| S13 | S13 · S13g · S13x |
| S18 | S18 · S18s · S18p |
| S19 | S19a · S19b · S19e · S19c · S19d |
| S21 | S21 · S21t |
| S22 | S22a · S22b · S22h · S22e · S22f |
| S24 | S24 · S24i |
| S32 | S32 · S32a |
| Retiro (P3.Z) | S27a · S27b |

4. **Huecos de integridad cerrados en contratos:**
   - `updateProgram` solo cambia título y notas.
   - Reglas de reactivación y de salida de COMPLETED.
   - `adoptableBookingWhere`.
   - CAS de precio con dos ramas.
   - "Cobro previo" de una sesión → el reemplazo se estampa en $0.
   - Sacar del plan un turno con cobro → rechazo.
   - Archivar solo planes CANCELLED/COMPLETED.
   - Legacy exento de I3/I5/I6 hasta "Completar datos".
   - Duración efectiva 15..240.
   - `lockCapacityMany` en una sentencia.
   - El holder del upsert respeta los turnos de plan.
   - La firma de `applyBookingUpdateInTx` se corrige.
5. **Huecos de completitud cerrados:**
   - UI de edición del plan (S22e).
   - Retiro de altas viejas como sesión propia (S27a/b), portando antes los tests de seguridad.
   - `restoreProgram` y `restoreSession`.
   - Deep-link con `prefill`.
   - Dueños para dashboard, Seguimiento por id, Biblioteca, `exercises.ts`, `services-types`, `patients-types` y `search.ts`.
   - El gate del ICS se adelanta a ES1.
   - Revisor y fixer en ES2a y ES4b.
   - SECURITY.md en los cierres.
   - Filas reales en AUDIT.
6. **Ejecución:**
   - `test:perf` no ensucia el árbol: `PERF_OUT_DIR` + `tests/perf/compare.ts`.
   - Helper `advisory-wait` filtrado por clave.
   - Tests "post-integración".
   - Swap atómico de archivos calientes.
   - `it.fails` solo para bugs de código existente.
   - Scripts con su lógica en `lib/` y `tsconfig.scripts.json`.
   - E2E con Auth no-prod (PD-12).
   - El dedupe se escribe en ES1, con estrategia definida.

### 0.4 Corridas y qué llega a prod

| Corrida | Olas | Qué deja | ¿Llega a prod? |
|---|---|---|---|
| **Paso 0** (orquestador, docs) | — | Precheck del RUNBOOK corregido, `.docs/PLANES.md` con las enmiendas integradas, filas de AUDIT, IDs P0-P4 | Commit de docs |
| **ES1** (~24 agentes) | **P0** | **Fugas vivas (E0):** `getPatient` borrada, firmador de media cerrado y Storage por service role, `listBookingsInRange` sin PHI. **Secretaria (E1):** opera todos los turnos, nivel "administrativo" sin HC, alta de paciente asignada al profesional. **Fixes de planes:** `createProgram` en día AR; gate full en Diagnóstico y plantillas; ejercicios asignables; dosis 3×12; portal e ICS sin PHI; plan activo determinístico; carrera de sesión a medida; StatusTag único. **Cimientos aditivos sin callers:** motor y plata puros, loader por días, locks ordenados, `auditInTx`, dedupe (dry-run) | No hasta cerrar B (04-oct); sin hotfix de E0 por el reset (07-oct) |
| **ES2a** (corta) | **P1** | M1 `plans_booking_link`, sola: vínculo turno↔plan + `ProgramAuthorization` + `PatientChangeRequest` + `Patient.userId` único por consultorio | Al cierre de B, en el deploy final (el build la aplica antes de servir el código) |
| **EV0** (07-oct) | V.0-V.2 | M2 `tenant_verticals` (sola) + verticales, matriz de módulos, guards, nav único, turnero con switch, /plataforma de consultorios, REVOKE de la Data API ([VERTICALES.md](VERTICALES.md)) | No (develop) |
| **ES2b** | **P2** | Core de turnos server-only + motor (preview y commit en una tx) + sincronía + lecturas y saldo + ciclo de vida + mover y re-planificar + cantidad y precio + autorización de la OS + Diagnóstico server + adopción + guardas | No (develop) |
| **ES3** | **P3** | Editor único y 4 puertas, agenda, drawer (incluido "Agendar próxima sesión" para la Secretaria), Seguimiento, Turnos y Facturación por plan, plantillas, `/planes/[disciplina]`, edición del plan y renovación de la autorización; retiro de las altas viejas. **08-oct:** M3a `billing_paid_at` (sola, P3.0.0) + S14r (ingresos reales del dashboard con Mes/Semana) | No |
| **SR** (08-oct) | — | M4 `rooms` (sola) + Salas/Consultorios: sala por franja y por turno, conflicto de sala, filtro y vista "Por sala" ([ROADMAP §SR](ROADMAP.md)) | No |
| **SV** ✅ (13/14-oct) | SV0-SV2 | M5 `reception_call_realtime` (sola) + Sala de Espera realtime, «Llamar» con sala, `/sala`, agenda y Recepción en vivo, avisos ([VERTICALES.md §7](VERTICALES.md)) | No |
| **ES4** | **P4** | **Portal ampliado** (identidad multi-consultorio, turnos y progreso, estado de cuenta, "Mis datos" con confirmación del consultorio, ejercicios del plan), ~~legacy (server, UI y script)~~ (eliminado por el reset del 07-oct), ICS "Sesión n/N", listado de pacientes, matriz authz completa, perf y soak, E2E | No (develop) |
| **EV1** (07-oct) | — | Barrido de la vertical General + limpieza R-LEGACY opcional | **Sí: todo el bloque B junto, una sola vez**, después del gate final: reset de prod → `migrate deploy` desde vacío → bootstrap |
| **ES4b** | condicional | Fixes del QA de staging | Junto con ES4 |

**Migraciones:** en todo Planes hay **una sola**: `plans_booking_link` (ES2a). En el bloque B se suman M2 `tenant_verticals` (EV0), M3a `billing_paid_at` (ES3), M4 `rooms` (SR) y M5 `reception_call_realtime` (SV). Todas se aplican en prod recién en el deploy final, **desde base vacía** (reset del 07-oct).

---

## 1. Decisiones

El detalle de cada una está en la lista estructurada (opciones, recomendación, motivo y qué ola bloquea). Si Martin no contesta antes de la ola que bloquea, rige el default y se asienta en el §9 del plan.

### 1.1 Ya decidido (D00; va literal en los prompts)

1. No hay "Planes v1".
2. Planes = la mitad de D25 en Etapa 3.
3. El plan referencia `(practitionerId, serviceId) + locationId`, **sin FK a PractitionerService** (ADR-003).
4. Acceso básico = solo ver.
5. No hay borrado definitivo de pacientes, solo Archivar.
6. La reserva pública impaga retiene el cupo 30 min. Por eso las keys de plan no pueden matchear `PUBLIC_KEY_RE` ni `LEGACY_PUBLIC_KEY_RE`.
7. Mensual = el mismo día del mes, ajustado al último día cuando no existe.
8. Del diseño A:
   - invariantes;
   - preview obligatorio con `stateToken`;
   - commit en una tx;
   - sincronía turno↔sesión;
   - editor único con 4 puertas;
   - precio estampado en `Booking.copagoCents` nivel 1, **sin tocar `lib/copago.ts` ni el webhook**.
9. D6 (prepago o seña con MP) va a D. **D24 queda cerrada:** 49e528c tenía 7 defectos (plan §3.3).
10. El oráculo `lib/booking-schedule.ts` no recibe callers nuevos.

### 1.2 Decisiones del dueño (firmadas por Martin el 03-oct)

Van literales en los prompts del área. "🔁" = cambió respecto de la recomendación del planning.

| ID | Tema | Decisión firmada | Bloquea |
|---|---|---|---|
| **PD-01** | Corte en corridas y deploy | ✅ 4 ES + corrida corta ES2a. Un commit por corrida. La extracción del core va a ES2b. **04-oct: nada se despliega hasta cerrar B** (ES1 ya no sale como hotfix, M1 va en el deploy final) | Paso 0 |
| **PD-02** | Gobierno | ✅ Olas P0-P4 (= B0-B4); `.docs/PLANES.md`; ratificadas dB1-dB14 (dB11 = PayerPlan); D24 cerrada | Paso 0 |
| **PD-03** | ADR-001 | ✅ ACCEPTED enmendado: 3 FKs compuestas + "Ausente libera la sesión" (predicado del único parcial) + ADR-003 | ES2a |
| **PD-04** | Modelo de M1 | ✅ `Session.priceCents`; idempotencia por tenant; keys `plan:<gen>:<i>`; columnas extra; enum Discipline de 2 valores (1 servicio por plan); responsable con backfill; 1 sede por plan; modos de precio; tags DISCIPLINE; duración 15..240; tope 60. **Más** la autorización de la OS (`ProgramAuthorization`) y los pedidos del portal (`PatientChangeRequest`), §3 | ES2a |
| **PD-05** | Prerrequisitos y prechecks de prod | ✅ Precheck del RUNBOOK corregido; prechecks (0)-(17) durante ES1 (solo lectura); bloqueantes (1)-(4) y (11); dedupe si (2) > 0; A0d (staging aislado) para M1. Con el 04-oct, B-pre llega a prod en el mismo deploy final, antes que M1 en el orden de migraciones | ES2a |
| **PD-06** | Alcance de ES1 | ✅ Fixes vivos + "take 1" determinístico + portal e ICS sin PHI + plantillas STARTER+ en el server; sin core. **Más** fugas E0 y permisos de la Secretaria (E1) | ES1 |
| **PD-07** | Motor | ✅ Precedencia y resoluciones H3-D12; bloqueado duro; fuera de horario → mover por defecto; sin anticipación (H4); el pasado queda "sin turno" (H5); tope 60; contrato de locks y tx (ADR-004, enmienda §5.28) | ES1 |
| **PD-08** | Plata | ✅ Q8 parcial; reparto en pesos; reprecio con CAS de dos ramas; P6; saldo P7; cobro previo → reemplazo en $0; sacar con cobro → rechazo | ES1 (S16p) |
| **PD-09** 🔁 | Permisos | ✅ **Cambiada (03-oct):** la Secretaria opera **todos** los turnos (Recepción, reprogramar, cancelar, crear) sin ver ni completar los campos médicos. En planes agenda una sesión, reprograma ("solo este" y "este y los siguientes") y cancela, pero **no** crea ni edita planes. `plans.manage` = OWNER, ADMIN y PRACTITIONER con full. BILLING ve el saldo. Matriz en §8 P0-Ck | ES1 / ES2b |
| **PD-10** | Ciclo de vida, edición y legacy | ✅ D7 (pausar o cancelar pregunta; por defecto cancela los futuros impagos); I5 derivado + `updateProgram` solo título y notas; archivar solo CANCELLED/COMPLETED; restaurar OWNER/ADMIN; ordinal; sincronía de Atendido; L5-L9 (L9 = archivar un paciente pausa sus planes); reactivación; legacy exento hasta "Completar datos" | ES2b |
| **PD-11** | Visual y puertas | ✅ Chip "Kine · 3/10" accesible + PHI del título; "Fuera de plan" solo con plan vinculado de la misma disciplina; link "Crealo como plan" con prefill; puerta 4 navega al perfil; una entrada "Planes" con pestañas; plantillas UI; V19. **Portal ampliado** (E3): turnos y progreso, estado de cuenta, "Mis datos", ejercicios **del plan** | ES3 (tokens en ES1) |
| **PD-12** | E2E | ✅ Playwright como devDependency + Auth no-prod (`.env.e2e.local` de staging). Si no está, E2E manual y `test:e2e` fuera del gate. Corre en el gate final del bloque B | ES4 |
| **PD-13** | Qué ve la Secretaria | ✅ **Datos administrativos:** nombre, DNI, contacto, OS y cobertura, contacto de emergencia, turnos y estado de cobro. **Nunca HC**, aunque esté "Consultorio común". Nivel `admin` en `lib/visibility.ts` (S02p) | ES1 |
| **PD-14** | Un paciente en varios consultorios | ✅ `Patient.userId` único **por consultorio**. Una cuenta (email), fichas distintas por consultorio, sin compartir nada clínico. `DROP INDEX "Patient_userId_key"` aprobado como excepción (§3) | ES2a (M1) |
| **PD-15** 🔁 | Vínculo de la cuenta del portal | ✅ **Automático por email verificado** si hay exactamente 1 ficha con ese email en ese consultorio y no tiene `userId`; si no, invitación con token (S24a) | ES4 |
| **PD-16** | Quién carga autorizaciones de OS | ✅ Profesional y Secretaria: capability `plans.authorize`, con historial de órdenes | ES2b / ES3 |

### 1.3 Consultas al cliente (las lleva Martin; mientras tanto rige el default)

| ID | Pregunta | Default | Límite |
|---|---|---|---|
| PQ-01 | ¿Autorización de la OS por orden médica? | ✅ **Respondida (03-oct): sí, se registra en el plan.** Tabla `ProgramAuthorization` en M1 (§3) | — |
| PQ-02 | ¿N fijo o tratamiento abierto? | N fijo y extensible (abierto → C2) | ES2b |
| PQ-03 | ¿Hora distinta por día? | Sí (el schedule v1 lo soporta) | ES3 |
| PQ-04 | ¿Frecuencias? | Semanal, cada 2, 3 o 4 semanas y mensual | ES3 |
| PQ-05 | ¿El ausente consume la sesión o se cobra? | Ni consume ni se cobra (el cargo va a D) | ES3 (copy) |
| PQ-06 | ¿Precio de plan con OS? | El plan fija la parte del paciente; la OS cobra aparte | ES2b |
| PQ-07 | ¿Paquete cancelado a mitad? | Se debe lo devengado; el reintegro es manual | ES3 (copy) |
| PQ-08 | ¿Cómo cobra? | Los dos modos; "Cobrar paquete" → C0 (entra en ES3 si cobra paquetes por adelantado seguido) | ES3 |
| PQ-09 | ¿Autocompletar o sugerir el alta? | Sugerir el alta | ES2b (S12b) |
| PQ-10 | ¿Nombre? | "Planes" / "Planes de tratamiento" | ES3 |
| PQ-11 | ¿Disciplina de cada servicio? | Sugerida desde `practiceId`, se confirma a mano | Antes del deploy final |
| PQ-12 | ¿Cómo prescribe ejercicios? | Plantilla = misma lista; Diagnóstico = rampa | ES2b (S17d) |
| PQ-13 | ¿La evaluación es la sesión 1? | Checkbox marcado si es una práctica de evaluación | ES3 |
| ~~PQ-14~~ | ~~¿Qué hacemos con los planes viejos?~~ | **Eliminada (reset de prod 07-oct):** no hay planes viejos en prod | — |
| PQ-15 | ¿Cómo funcionan las órdenes de la OS (renovaciones, qué cuenta como "usada", adjunto)? | Una orden vigente por plan, con historial; "usadas" = sesiones realizadas con fecha AR ≥ `startsOn` de la orden vigente; el adjunto de la orden médica → C1 | ES2b |

### 1.4 Diferidos (anotados en AUDIT con su bloque en el Paso 0)

- **D:**
  - D6 (prepago o seña con MP);
  - cargo por ausencia;
  - **cargo por cancelación tardía** (decisión 3 del 08-oct): junto con el cargo por ausencia, modelar "cargos" en el saldo para que no aparezcan como plata a favor del paciente;
  - pagar online desde el portal.
- **C0:**
  - "Cobrar paquete" (salvo PQ-08);
  - P11 (arancel de OS retroactivo, turnero que cobra `service.priceCents`). Los "ingresos del dashboard que solo cuentan MP" salen de C0: **en curso en ES3 (S14r)**;
  - **resto de AUDIT:940** (congelar el copago de impagos pasados o con `insurerPaidAt`);
  - matriz fina de cobros (la Secretaria marcando cobros o borrando turnos) y BILLING;
  - BILLING en "cualquier profesional".
  - ~~ASSISTANT que reprograma o cancela turnos de plan sin full~~: **ya no es diferido**, entra en ES1 (S07sb) y ES2b (PD-09).
- **C1:**
  - condiciones custom en Diagnóstico;
  - BK-01/03/04/05/08/09;
  - dosis por tiempo;
  - único anti-carrera del check-in de EVA;
  - perf del batch y de `createBooking`;
  - borrar `listBookingsInRange` (ES1 solo le saca la PHI);
  - zoom por usuario;
  - aviso del candado si exige tocar `time-blocks.ts`;
  - presupuesto de bundle bloqueante;
  - **duraciones de más de 240 min en Service/PS frente al lookback de 240**;
  - **ejercicios del portal fuera de un plan** (los del plan entran en ES4, S24e);
  - adjunto de la orden médica de la OS;
  - aviso "autorización por vencer" en el dashboard, si no entra en S14;
  - FKs compuestas opcionales hacia Service/Practitioner/Location;
  - sub-ramas de disciplina a otro kind.
  - ~~`portal-auth-por-email-no-userid`~~: lo cierra S24a (ES4).
- **C2:**
  - plan abierto;
  - `no-realtime-agenda-compartida` (reclasificada en el Paso 0: decía "(B4)").
- **Contract de B-pre:** después de P4 (C1). `Tenant.businessHours*` no se borra.

---

## 2. Diseño actualizado

### 2.1 Piezas del §3 del plan contra B-pre

| Pieza | Estado en `3ff2e50` | Qué hacemos |
|---|---|---|
| Motor puro | `lib/booking-schedule.ts` es el oráculo congelado (§5.27) | Módulos nuevos: `lib/availability/plan.ts` y `lib/plan-schedule.ts` (puros) + `lib/plan-pricing.ts` + `lib/plan-display.ts` (ES1) |
| Recurrencia | `expandDates`: una sola hora de ancla, tope 60 (58 en weekly con un día), `daysOfWeek` 0=Lun | `expandPlanDates` (hora por día, cada 1-4 semanas o mensual), con paridad contra `expandDates` en el caso de una sola hora |
| `classifyBatchInstant` | Colapsa bloqueado y superposición en "sobreturno" | **No se usa.** `classifyPlanRows` = `classifyInstant` + fold virtual con precedencia propia. Se corrige ROADMAP:100 |
| `isOverbooked`, `Booking.locationId`, lock de cupo, `cancelBookingsInTx`, `previewRecurrence`, Recepción | Existen | Se consumen |
| `auditInTx` | No existe | P0-Ck lo publica. Los writes de Planes auditan dentro de la tx |
| `runWithRls` | Sin opciones de tx | `opts?: {timeout, maxWait}` aditivo (P0-Ck) |
| Core de turnos | 2378 líneas en `bookings.ts` | `lib/bookings-core.ts` (S07c, **ES2b**) |
| `idempotencyKey @unique` global | Reabriría la fuga de A2 | `@@unique([tenantId, idempotencyKey])` |
| Sincronía §3.3 | Faltan Recepción, candado, webhook, `deleteBooking`, Seguimiento y la reactivación | "Sin turno" **se deriva**; tabla C4 completa |
| D22 | A2 autocompleta | Sugerir el alta (S12b) |
| "Múltiples turnos intacto" vs "puerta liviana" | Contradicción | Turnos sueltos + "Crealo como plan…" (prefill) |
| Anticipación de la práctica | Solo la usa el turnero | No aplica a Planes |

### 2.2 Modelo (M1)

**TreatmentProgram suma:**
- `discipline`;
- profesional responsable (`practitionerId`);
- `serviceId`;
- `locationId` (null = sede principal);
- `templateId`;
- `durationMin` (override);
- `schedule` (`PlanScheduleV1`);
- `pricingMode`, `pricePerSessionCents` y `totalPriceCents`;
- `notes`;
- `idempotencyKey` (única por tenant);
- `updatedAt`;
- `archivedAt`.

**Session suma:** `title`, `priceCents` (la cuota, que es la fuente de la verdad de la plata), `archivedAt` y `updatedAt`.

**Booking suma:** `programId`, `sessionId` y `pricedByPlan`.

**Otros:**
- `EvaScore`: `note` y `sessionId`.
- `Service`: `discipline`.
- `PlanTemplate`: lo necesario para prellenar el editor.

**Tablas nuevas (E2 y E3), con RLS ENABLE + FORCE + policy:**
- **`ProgramAuthorization`** (autorización de la OS, PQ-01 = sí): `code`, `authorizedSessions` 1..200, `startsOn DATE`, `expiresOn DATE`, `createdById`, `supersededAt`. Una vigente por plan (único parcial) y las anteriores como historial.
- **`PatientChangeRequest`** ("Mis datos" del portal): `changes JSONB` ≤ 4 KB, `status` PENDING | APPROVED | REJECTED, un PENDING por paciente (único parcial). Va en tabla aparte para que el portal **nunca** escriba la fila de Patient ni mueva `Patient.updatedAt`, que es el lock de `updatePatient`.

**Patient:** `userId` pasa de único global a único **por consultorio** (`Patient_tenantId_userId_key`); se suma `Patient_id_tenantId_key` como destino de FK compuesta.

**Duración efectiva** = override ?? PS ?? Service, validada en **15..240** dentro de `validatePlanRefsInTx`. Si queda fuera de rango: *"La duración supera 4 h: definí una duración para el plan"*.

**Tope:** 60 sesiones en planes, plantillas, Diagnóstico y el editor. Los legacy con más de 60 se respetan, pero no se generan turnos para el excedente.

### 2.3 Invariantes (módulo server-only; en prod la conexión es BYPASSRLS)

| Inv. | Lo garantiza la base | Lo garantizan el código y el verificador |
|---|---|---|
| I1 · turno de plan = mismo plan y paciente que su sesión | `Booking_session_program_fkey`, `Booking_plan_patient_fkey`, `Booking_plan_patient_check`, `Booking_plan_link_check` | `updateBooking` rechaza cambiar el paciente con un mensaje claro |
| I2 · como máximo 1 turno activo por sesión | `Booking_session_active_key` (excluye CANCELLED y NO_SHOW) | P2002 resuelto por los datos en el core **y en Recepción** |
| I3 · fecha de la sesión = fecha del turno activo | — | Write-through en `applyBookingUpdateInTx` + verificador |
| I4 · ids del tenant | `Booking_plan_tenant_fkey` | `validatePlanRefsInTx` en **todo** write de `TreatmentProgram.{practitionerId, serviceId, locationId, templateId}` y `PlanTemplate.serviceId` |
| I5 · `totalSessions` = sesiones vivas | `Session_programId_index_live_key` | Caché escrita en la misma tx + verificador |
| I6 · PACKAGE: Σ `Session.priceCents` vivas = total | `TreatmentProgram_pricing_check`, `Booking_priced_by_plan_check` | `Booking.copagoCents` = `Session.priceCents` si `pricedByPlan`; CAS + rollback total |
| I7 · nada vinculado se borra en duro | RESTRICT | Archivar; guardas en `deleteService`, `archiveLocation`, `removeMember`; `deleteBooking` rechaza turnos de plan |
| I8 · el único escritor de `pricedByPlan=true` es el motor | CHECK | `createBooking`, el batch, el turnero y el webhook nunca lo escriben |

**R-LEGACY del verificador.** I3, I5 e I6 se verifican **solo en planes vinculados**: `schedule` no nulo o al menos un turno con `programId`. En un legacy, el verificador corre solo I1, I2, I4, I7 e I8.

- Así, pausar, cancelar o archivar un plan viejo con `totalSessions` ≠ filas no falla.
- ~~"Completar datos" (S25L)~~ (eliminado por el reset de prod del 07-oct) reconcilia con confirmación explícita: *"Este plan dice 10 sesiones y tiene 8 cargadas: ¿agregamos 2 o queda en 8?"*.
- Desde ahí el plan pasa a ser vinculado.
- Si el verificador falla: evento a Sentry con el diff de invariantes.

### 2.4 Archivar, restaurar y editar

- **Plan:**
  - Se archiva solo en estado CANCELLED o COMPLETED. Si está ACTIVE o PAUSED, el diálogo exige la transición D7 a CANCELLED en la misma tx.
  - `liveProgramWhere = {archivedAt: null}`. Todo lector de "activo" usa `status = ACTIVE AND archivedAt IS NULL`.
- **Sesión:**
  - Se archiva solo si no está realizada y no tiene turno COMPLETED ni turno con cobro. Un turno activo impago se cancela en la misma tx.
- **Restaurar** (OWNER y ADMIN):
  - `restoreProgram` vuelve al estado que tenía.
  - `restoreSession` falla con *"Ya hay una sesión N viva"* si otra tomó su index. No renumera nunca.
- **`updateProgram`:** solo `title` y `notes`, con CAS de `updatedAt`.
  - Cantidad → `plans-edit`.
  - Horario, profesional, servicio y sede → re-planificar (L7).
  - El retiro de la rama estructural está en S27a.
- **Numeración:** `index` fijo. Se muestra el **ordinal** por fecha entre las sesiones vivas, calculado en la proyección (`planSessionOrdinal`).

### 2.5 Legacy

> **Reset de prod (07-oct):** S25n y las acciones S25L/S25b quedan **eliminadas** (no hay planes viejos que
> normalizar ni completar). Lo de abajo queda como historia. **R-LEGACY** (§2.3) se mantiene en ES2b/ES3 porque en
> `develop` conviven las altas viejas hasta S27a/b; EV1 lo limpia, opcional.

- Las sesiones a 00:00Z cuentan por **su fecha UTC**.
- `scripts/normalize-plan-session-dates.ts` (S25n):
  - excluye las sesiones con **algún** `Booking.sessionId` y los programas con `schedule`;
  - es idempotente;
  - nunca toca Booking.
- Las acciones legacy (S25L/S25b): "Completar datos", "Vincular turnos del mismo día AR" y "Adoptar serie".

### 2.6 Secretaria, autorización de la OS e identidad del portal (E1-E3)

**Secretaria (PD-09, PD-13):**
- Opera turnos por la capability positiva `agenda.operateAll` (OWNER, ADMIN, ASSISTANT), nunca por "full".
- **Un campo se escribe si y solo si se puede leer:** `bookingFieldAccess` (`lib/booking-field-access.ts`) es la única regla para la agenda, el ICS, el alta, el batch, `updateBooking` y el core.
- Ve datos administrativos (nivel `admin`), nunca HC. No tiene `plans.manage`: en planes agenda, reprograma y cancela (`plans.schedule`) y carga autorizaciones (`plans.authorize`).

**Autorización de la OS (PQ-01, PD-16, PQ-15):**
- **Fechas en `DATE`.** Se leen con `dbDateToDayKey` y se escriben con `dayKeyToDbDate`. Las flags comparan dayKeys AR, nunca instantes.
- **Renovar** = marcar la vigente con `supersededAt` + insertar la nueva, en una tx con `lockPlanPatient` y `auditInTx` (S16b `renewPlanAuthorization`, con `plans.authorize`). El historial son las filas; el audit lleva solo ids.
- **"Usadas" de la orden vigente** = sesiones realizadas con fecha AR ≥ `startsOn`.
- **Motor:** flags de **solo aviso**, `overAuthorization` y `afterAuthorizationExpiry` (C7). Nunca bloquean.
- **Quién la ve:** solo el detalle del plan, para `(full && clinical.read) || plans.authorize || billing.manage`. **Nunca** sale en la agenda (C9), el ICS, el CSV, las notificaciones ni el portal.

**Identidad del portal (PD-14, PD-15):**
- **Principio de Martin (03-oct):** una cuenta (email) se vincula a **fichas distintas en N consultorios**. Entre consultorios **nunca se comparte nada**: ni planes, ni ejercicios, ni HC, ni pagos. Solo se reusan el email y el contacto básico para precargar formularios.
- **El portal autoriza por `(tenantId, userId)`, nunca por email** (`requirePortalPatient`, S24a).
- **Vínculo automático:** al entrar al portal de un consultorio se vincula con CAS (`WHERE id AND tenantId AND (userId IS NULL OR userId = me)`) si se cumplen todas estas condiciones:
  - el email está verificado;
  - la identidad no es staff (§5.22);
  - hay **exactamente una** ficha con ese email (normalizado, case-insensitive) **en ese consultorio**;
  - esa ficha no tiene `userId`.
- **Si hay 0 o más de 1 ficha:** invitación del consultorio. `sendPatientPortalInvite` emite un token HMAC que vence a los 7 días y lleva a `/portal/vincular`. El "un solo uso" lo garantiza el CAS. El callback atrapa el P2002.
- **El estado de cuenta y los ejercicios salen solo con `userId` vinculado.**

---

## 3. Migración M1 · C1 `plans_booking_link` (ES2a · S10; copiar literal; firmado 03-oct)

```sql
-- plans_booking_link · Planes P1-S10. EXPAND (ADR-001 ACCEPTED enmendado + ADR-003), firmado por Martin el 03-oct.
-- Por qué: FK turno↔plan (D25), cuota por sesión (I6), disciplina (D10), responsable (D17), archivar (I7),
-- idempotencia por tenant (A2), autorización de la OS con historial (PQ-01 = sí, PD-16), pedidos de cambio del
-- portal sin tocar la ficha (E3) y una cuenta del portal con fichas en N consultorios (PD-14).
-- TABLAS NUEVAS: "ProgramAuthorization" y "PatientChangeRequest", cada una con RLS ENABLE + FORCE + policy
--   "<tabla>_tenant_isolation" (mismo DO-block que agenda_foundations; las verifica `npm run guard:isolation`).
-- EXCEPCIÓN a "todo aditivo", APROBADA POR MARTIN EL 03-OCT: DROP INDEX "Patient_userId_key" (UNIQUE global),
--   reemplazado por "Patient_tenantId_userId_key". Solo RELAJA la unicidad: el código vivo busca por userId con
--   findFirst (callback, accept-action, patients.ts) y lo tolera. El down-script lo recrea solo si no hay repetidos.
-- Fuera de eso: sin DROP, sin SET NOT NULL sobre datos, sin UPDATE sobre "Booking" ni "Patient"
--   (§5.30: no se toca updatedAt = optimistic lock).
-- OBJETOS QUE PRISMA NO EXPRESA (drift aceptado; NO borrar si `migrate dev` los propone; migrate dev está prohibido):
--   únicos parciales Session_programId_index_live_key, Booking_session_active_key,
--   ProgramAuthorization_programId_current_key y PatientChangeRequest_patient_pending_key;
--   FKs compuestas Booking_plan_tenant_fkey / Booking_plan_patient_fkey / Booking_session_program_fkey
--   (y las de las tablas nuevas si Prisma no las expresa igual, ver "Prisma"); todos los CHECK; las 2 policies RLS.
-- Precheck BLOQUEANTE (2): duplicados (programId,index) => el único parcial aborta. Se resuelven ANTES con
-- scripts/plans-dedupe-session-index.ts (escrito en ES1; dry-run -> backup -> --apply). Esta migración NO muta datos legacy.
BEGIN;
SET LOCAL lock_timeout = '5s';   -- si "Booking" está tomada, falla rápido (no cuelga la agenda). Ver RUNBOOK P3009.

CREATE TYPE "Discipline" AS ENUM ('KINESIOLOGY','OSTEOPATHY');
CREATE TYPE "ProgramPricingMode" AS ENUM ('PER_SESSION','PACKAGE');

ALTER TABLE "Service" ADD COLUMN "discipline" "Discipline";

ALTER TABLE "TreatmentProgram"
  ADD COLUMN "discipline" "Discipline", ADD COLUMN "practitionerId" TEXT, ADD COLUMN "serviceId" TEXT,
  ADD COLUMN "locationId" TEXT, ADD COLUMN "templateId" TEXT, ADD COLUMN "durationMin" INTEGER,
  ADD COLUMN "schedule" JSONB, ADD COLUMN "pricingMode" "ProgramPricingMode",
  ADD COLUMN "pricePerSessionCents" INTEGER, ADD COLUMN "totalPriceCents" INTEGER, ADD COLUMN "notes" TEXT,
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,   -- default constante: sin rewrite
  ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "TreatmentProgram"
  ADD CONSTRAINT "TreatmentProgram_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TreatmentProgram_serviceId_fkey"  FOREIGN KEY ("serviceId")  REFERENCES "Service"("id")  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TreatmentProgram_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE, -- null=principal; SET NULL movería el plan en silencio
  ADD CONSTRAINT "TreatmentProgram_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PlanTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "TreatmentProgram_pricing_check" CHECK (   -- IS NOT DISTINCT FROM, no "=": con modo NULL, "=" da NULL (3VL), el disyunto queda NULL y el CHECK pasaría con precio. Sin modo = sin precio.
       ("pricingMode" IS NULL AND "pricePerSessionCents" IS NULL AND "totalPriceCents" IS NULL)
    OR ("pricingMode" IS NOT DISTINCT FROM 'PER_SESSION' AND "pricePerSessionCents" IS NOT NULL AND "totalPriceCents" IS NULL)
    OR ("pricingMode" IS NOT DISTINCT FROM 'PACKAGE' AND "totalPriceCents" IS NOT NULL AND "pricePerSessionCents" IS NULL)),
  ADD CONSTRAINT "TreatmentProgram_price_nonneg_check" CHECK (COALESCE("pricePerSessionCents",0) >= 0 AND COALESCE("totalPriceCents",0) >= 0),
  ADD CONSTRAINT "TreatmentProgram_duration_check" CHECK ("durationMin" IS NULL OR "durationMin" BETWEEN 15 AND 240), -- = zod de turnos (15..240) y BOOKING_LOOKBACK_MIN
  ADD CONSTRAINT "TreatmentProgram_schedule_check" CHECK ("schedule" IS NULL OR jsonb_typeof("schedule") = 'object');
CREATE UNIQUE INDEX "TreatmentProgram_tenantId_idempotencyKey_key" ON "TreatmentProgram"("tenantId","idempotencyKey"); -- NO global (fuga A2)
CREATE UNIQUE INDEX "TreatmentProgram_id_tenantId_key"  ON "TreatmentProgram"("id","tenantId");   -- destino FK compuesta
CREATE UNIQUE INDEX "TreatmentProgram_id_patientId_key" ON "TreatmentProgram"("id","patientId");  -- destino FK compuesta
CREATE INDEX "TreatmentProgram_tenantId_discipline_status_idx" ON "TreatmentProgram"("tenantId","discipline","status");
CREATE INDEX "TreatmentProgram_practitionerId_idx" ON "TreatmentProgram"("practitionerId");
CREATE INDEX "TreatmentProgram_serviceId_idx"      ON "TreatmentProgram"("serviceId");
CREATE INDEX "TreatmentProgram_locationId_idx"     ON "TreatmentProgram"("locationId");
CREATE INDEX "TreatmentProgram_templateId_idx"     ON "TreatmentProgram"("templateId");

-- Autorización de la OS (PQ-01 = sí, PD-16, PQ-15). Tabla con historial: renovar = supersededAt + INSERT.
-- Fechas de calendario en DATE (vence 30/11 = el 30/11 AR entero; se leen con dbDateToDayKey).
CREATE TABLE "ProgramAuthorization" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "programId" TEXT NOT NULL,
  "code" TEXT, "authorizedSessions" INTEGER, "startsOn" DATE NOT NULL, "expiresOn" DATE,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supersededAt" TIMESTAMP(3),
  CONSTRAINT "ProgramAuthorization_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProgramAuthorization_sessions_check" CHECK ("authorizedSessions" IS NULL OR "authorizedSessions" BETWEEN 1 AND 200),
  CONSTRAINT "ProgramAuthorization_code_check" CHECK ("code" IS NULL OR char_length("code") BETWEEN 1 AND 64),
  CONSTRAINT "ProgramAuthorization_dates_check" CHECK ("expiresOn" IS NULL OR "expiresOn" >= "startsOn"),
  CONSTRAINT "ProgramAuthorization_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProgramAuthorization_program_tenant_fkey" FOREIGN KEY ("programId","tenantId") REFERENCES "TreatmentProgram"("id","tenantId") ON DELETE RESTRICT);
-- PARCIAL (no lo expresa Prisma; NO borrar): PQ-15 = 1 vigente por plan. "Órdenes múltiples" (C1) = relajar este índice, sin migrar datos.
CREATE UNIQUE INDEX "ProgramAuthorization_programId_current_key" ON "ProgramAuthorization"("programId") WHERE "supersededAt" IS NULL;
CREATE INDEX "ProgramAuthorization_tenantId_expiresOn_idx" ON "ProgramAuthorization"("tenantId","expiresOn");

ALTER TABLE "Session"
  ADD COLUMN "title" TEXT, ADD COLUMN "priceCents" INTEGER, ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT "Session_priceCents_check" CHECK ("priceCents" IS NULL OR "priceCents" >= 0);
CREATE UNIQUE INDEX "Session_id_programId_key" ON "Session"("id","programId");   -- destino FK compuesta
-- PARCIAL (no lo expresa Prisma; NO borrar). Index estable: archivar NO renumera.
CREATE UNIQUE INDEX "Session_programId_index_live_key" ON "Session"("programId","index") WHERE "archivedAt" IS NULL;

ALTER TABLE "Booking"
  ADD COLUMN "programId" TEXT, ADD COLUMN "sessionId" TEXT,
  ADD COLUMN "pricedByPlan" BOOLEAN NOT NULL DEFAULT false;   -- default constante: sin rewrite
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_programId_fkey" FOREIGN KEY ("programId") REFERENCES "TreatmentProgram"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Booking_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- FKs COMPUESTAS (drift aceptado): las FK saltean RLS y prod es BYPASSRLS => I1/I4 garantizados en la base
  ADD CONSTRAINT "Booking_plan_tenant_fkey"     FOREIGN KEY ("programId","tenantId")  REFERENCES "TreatmentProgram"("id","tenantId")  ON DELETE RESTRICT,
  ADD CONSTRAINT "Booking_plan_patient_fkey"    FOREIGN KEY ("programId","patientId") REFERENCES "TreatmentProgram"("id","patientId") ON DELETE RESTRICT,
  ADD CONSTRAINT "Booking_session_program_fkey" FOREIGN KEY ("sessionId","programId") REFERENCES "Session"("id","programId")           ON DELETE RESTRICT,
  ADD CONSTRAINT "Booking_plan_link_check"      CHECK (("programId" IS NULL) = ("sessionId" IS NULL)),
  ADD CONSTRAINT "Booking_plan_patient_check"   CHECK ("programId" IS NULL OR "patientId" IS NOT NULL),   -- un guest no es turno de plan
  ADD CONSTRAINT "Booking_priced_by_plan_check" CHECK (NOT "pricedByPlan" OR ("programId" IS NOT NULL AND "copagoCents" IS NOT NULL));
CREATE INDEX "Booking_tenantId_programId_idx" ON "Booking"("tenantId","programId");
CREATE INDEX "Booking_sessionId_idx" ON "Booking"("sessionId");   -- chequeo RESTRICT y "sin turno" derivado
-- I2 + D1 · PARCIAL (NO borrar). Distinto del índice paciente-instante (ese excluye solo CANCELLED y NO se toca).
CREATE UNIQUE INDEX "Booking_session_active_key" ON "Booking"("sessionId")
  WHERE "sessionId" IS NOT NULL AND "status" NOT IN ('CANCELLED','NO_SHOW');

ALTER TABLE "PlanTemplate"
  ADD COLUMN "discipline" "Discipline", ADD COLUMN "serviceId" TEXT, ADD COLUMN "durationMin" INTEGER,
  ADD COLUMN "schedule" JSONB, ADD COLUMN "pricingMode" "ProgramPricingMode", ADD COLUMN "pricePerSessionCents" INTEGER,
  ADD COLUMN "totalPriceCents" INTEGER, ADD COLUMN "notes" TEXT, ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD CONSTRAINT "PlanTemplate_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE, -- SET NULL: deleteTenantDeep borra Service antes del cascade
  ADD CONSTRAINT "PlanTemplate_pricing_check" CHECK (   -- IS NOT DISTINCT FROM, no "=": con modo NULL, "=" da NULL (3VL), el disyunto queda NULL y el CHECK pasaría con precio. Sin modo = sin precio.
       ("pricingMode" IS NULL AND "pricePerSessionCents" IS NULL AND "totalPriceCents" IS NULL)
    OR ("pricingMode" IS NOT DISTINCT FROM 'PER_SESSION' AND "pricePerSessionCents" IS NOT NULL AND "totalPriceCents" IS NULL)
    OR ("pricingMode" IS NOT DISTINCT FROM 'PACKAGE' AND "totalPriceCents" IS NOT NULL AND "pricePerSessionCents" IS NULL)),
  ADD CONSTRAINT "PlanTemplate_price_nonneg_check" CHECK (COALESCE("pricePerSessionCents",0) >= 0 AND COALESCE("totalPriceCents",0) >= 0),
  ADD CONSTRAINT "PlanTemplate_duration_check" CHECK ("durationMin" IS NULL OR "durationMin" BETWEEN 15 AND 240),
  ADD CONSTRAINT "PlanTemplate_schedule_check" CHECK ("schedule" IS NULL OR jsonb_typeof("schedule") = 'object');
CREATE INDEX "PlanTemplate_serviceId_idx" ON "PlanTemplate"("serviceId");
CREATE INDEX "PlanTemplate_tenantId_discipline_idx" ON "PlanTemplate"("tenantId","discipline");

ALTER TABLE "EvaScore" ADD COLUMN "note" TEXT, ADD COLUMN "sessionId" TEXT,
  ADD CONSTRAINT "EvaScore_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "EvaScore_sessionId_idx" ON "EvaScore"("sessionId");   -- reemplaza el string ambiguo; las escrituras nuevas llenan ambos

-- Identidad del portal (PD-14) y pedidos de cambio "Mis datos" (E3).
CREATE UNIQUE INDEX "Patient_id_tenantId_key" ON "Patient"("id","tenantId");   -- destino de FK compuesta; el CREATE toma SHARE (bloquea escrituras, no lecturas), pero el DROP INDEX de abajo toma ACCESS EXCLUSIVE sobre Patient (bloquea también lecturas) hasta el COMMIT de M1
-- EXCEPCIÓN aprobada por Martin (03-oct): relaja la unicidad global de userId a una por consultorio. Ver cabecera.
CREATE UNIQUE INDEX "Patient_tenantId_userId_key" ON "Patient"("tenantId","userId");
DROP INDEX "Patient_userId_key";

CREATE TYPE "PatientChangeRequestStatus" AS ENUM ('PENDING','APPROVED','REJECTED');
CREATE TABLE "PatientChangeRequest" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "patientId" TEXT NOT NULL,
  "changes" JSONB NOT NULL,
  "status" "PatientChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
  "requestedByUserId" TEXT, "decidedById" TEXT, "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PatientChangeRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PatientChangeRequest_changes_check" CHECK (jsonb_typeof("changes")='object' AND octet_length("changes"::text) <= 4096),
  CONSTRAINT "PatientChangeRequest_decided_check" CHECK (("status"='PENDING') = ("decidedAt" IS NULL)),
  CONSTRAINT "PatientChangeRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PatientChangeRequest_patient_tenant_fkey" FOREIGN KEY ("patientId","tenantId") REFERENCES "Patient"("id","tenantId") ON DELETE CASCADE);
-- PARCIAL (no lo expresa Prisma; NO borrar): 1 pedido pendiente por paciente.
CREATE UNIQUE INDEX "PatientChangeRequest_patient_pending_key" ON "PatientChangeRequest"("patientId") WHERE "status"='PENDING';
CREATE INDEX "PatientChangeRequest_tenantId_status_idx" ON "PatientChangeRequest"("tenantId","status");

-- ── RLS: las 2 tablas nuevas con tenantId ───────────────────────────
-- Mismo loop y mismo nombre de policy que 20260725120000_rls_policies y agenda_foundations.
-- app_current_tenant_id() devuelve NULL sin GUC → ninguna fila visible y ningún INSERT pasa el WITH CHECK
-- fuera de runWithRls. Las FKs compuestas son la red bajo BYPASSRLS (prod): el tenantId de la fila nueva es
-- el del plan o el de la ficha.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ProgramAuthorization', 'PatientChangeRequest']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("tenantId" = app_current_tenant_id()) WITH CHECK ("tenantId" = app_current_tenant_id())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

-- >>> BACKFILL plans_booking_link BEGIN
-- Idempotente y re-ejecutable. El test lee este bloque literal (mismo patrón que agenda_foundations).
-- Guarda: con row_security=off, un rol SIN BYPASSRLS falla fuerte (FORCE RLS en TreatmentProgram) en vez de backfillear 0 filas.
SET LOCAL row_security = off;
UPDATE "TreatmentProgram" p SET "practitionerId" = f."practitionerId"
FROM (SELECT DISTINCT ON (s."programId") s."programId", s."practitionerId" FROM "Session" s ORDER BY s."programId", s."index", s."id") f
WHERE f."programId" = p."id" AND p."practitionerId" IS NULL
  AND EXISTS (SELECT 1 FROM "Practitioner" pr WHERE pr."id" = f."practitionerId" AND pr."tenantId" = p."tenantId")
  AND (NULLIF(current_setting('kinesoft.backfill_tenants', true), '') IS NULL
       OR p."tenantId" = ANY (string_to_array(current_setting('kinesoft.backfill_tenants', true), ',')));
-- Catálogo global (D21): 2 tags DISCIPLINE (staging = prod sin seeds). Precheck (11): slug libre o ya DISCIPLINE.
INSERT INTO "Tag" ("id","slug","label","kind") VALUES
  ('tag_discipline_kinesiologia','kinesiologia','Kinesiología','DISCIPLINE'),
  ('tag_discipline_osteopatia','osteopatia','Osteopatía','DISCIPLINE')
ON CONFLICT ("slug") DO NOTHING;
-- <<< BACKFILL plans_booking_link END
COMMIT;
```

**Prisma:**
- `@@unique([tenantId, idempotencyKey])`, `@@unique([id, tenantId])` y `@@unique([id, patientId])` en TreatmentProgram; `@@unique([id, programId])` en Session. Todos con `map:` a los nombres del SQL.
- `@@index` con los mismos nombres.
- Relaciones simples (`Restrict` / `SetNull`).
- `updatedAt DateTime @default(now()) @updatedAt` en TreatmentProgram, Session y PatientChangeRequest.
- **Patient:** `userId String?` **sin** `@unique` + `@@unique([tenantId, userId], map: "Patient_tenantId_userId_key")` + `@@unique([id, tenantId], map: "Patient_id_tenantId_key")`. **`UserProfile.patient Patient?` pasa a `patients Patient[]` (1:n).** Ningún código de la app incluye `UserProfile.patient` (grep en 3ff2e50); si `tsc` encuentra uno, S10 lo ajusta.
- **`ProgramAuthorization`:**
  - `startsOn DateTime @db.Date`, `expiresOn DateTime? @db.Date`;
  - relación a Tenant con `map: "ProgramAuthorization_tenantId_fkey"` (Cascade);
  - relación compuesta a TreatmentProgram: `@relation(fields: [programId, tenantId], references: [id, tenantId], onDelete: Restrict, onUpdate: NoAction, map: "ProgramAuthorization_program_tenant_fkey")`;
  - `@@index([tenantId, expiresOn], map: "ProgramAuthorization_tenantId_expiresOn_idx")`.
- **`PatientChangeRequest`:**
  - enum `PatientChangeRequestStatus`;
  - relación a Tenant con `map: "PatientChangeRequest_tenantId_fkey"`;
  - relación compuesta a Patient: `@relation(fields: [patientId, tenantId], references: [id, tenantId], onDelete: Cascade, onUpdate: NoAction, map: "PatientChangeRequest_patient_tenant_fkey")`;
  - `@@index([tenantId, status], map: "PatientChangeRequest_tenantId_status_idx")`.
- Si `migrate diff` muestra diferencias en las relaciones compuestas de las tablas nuevas, P1-R las pasa a la lista de drift aceptado; **nunca** se cambia el SQL para que coincida.
- Las FKs compuestas de Booking, los CHECK, los 4 parciales y las 2 policies van en un bloque de comentario en el schema.
- **Regla `Prisma.DbNull`:** para limpiar un `Json?` se usa `Prisma.DbNull`, **nunca** `Prisma.JsonNull`. `JsonNull` guarda un JSON `null`, y `jsonb_typeof('null') = 'null'` viola el CHECK object: la action revienta con 23514 en vez de limpiar el campo. Aplica a `TreatmentProgram.schedule` y `PlanTemplate.schedule`. Precedente: `lib/practitioner-schedule.ts:423`.

**No hace:**
- ningún UPDATE sobre Booking ni Patient;
- ningún backfill de las tablas nuevas (arrancan vacías) ni de `Patient.userId`;
- no normaliza fechas (eso es S25n);
- no deduplica (eso es S02x, antes de M1);
- no toca `isOverbooked` ni el contract de B-pre;
- no pone CHECK sobre `totalSessions` (un legacy puede tener hasta 64).

**Compatibilidad con el código viejo** (el código de ES1 sobre el schema nuevo; con el deploy único del 04-oct sigue valiendo para el rollback y para la secuencia de S10):
- las columnas nuevas quedan en null o con su default;
- los CHECK se cumplen con `programId`/`sessionId` en null y `pricedByPlan=false`;
- `deleteProgram`/`deleteSession` viejos siguen funcionando porque no hay turnos vinculados;
- el cliente Prisma viejo no conoce las columnas ni las tablas nuevas;
- el código viejo busca por `Patient.userId` solo con `findFirst`, así que la relajación del índice no lo afecta. El P2002 latente del callback (segundo consultorio) desaparece con el índice nuevo.

S10 lo prueba corriendo toda la integración con el cliente viejo sobre el schema nuevo.

**Rollback:**
- El código viejo tolera M1, así que alcanza con el rollback del deploy en Vercel.
- **El down-script** está escrito en [MIGRACIONES-RUNBOOK §2.4](MIGRACIONES-RUNBOOK.md) «Rollback» (probado en el Docker local dentro de una tx con ROLLBACK) y se usa solo con backup y decisión de Martin. Orden:
  1. `DROP TABLE "PatientChangeRequest"`; `DROP TABLE "ProgramAuthorization"` (arrastran sus policies e índices);
  2. `DROP TYPE "PatientChangeRequestStatus"`;
  3. recrear `Patient_userId_key` **solo si** `SELECT count(*) FROM (SELECT "userId" FROM "Patient" WHERE "userId" IS NOT NULL GROUP BY 1 HAVING count(*)>1) x` = 0 (si hay repetidos, frenar: hay pacientes vinculados en más de un consultorio); después `DROP INDEX "Patient_tenantId_userId_key"` y `DROP INDEX "Patient_id_tenantId_key"`;
  4. el resto en orden inverso al SQL: `EvaScore`, `PlanTemplate`, `Booking` (constraints, índices y columnas), `Session`, `TreatmentProgram`, `Service`; al final `DROP TYPE "ProgramPricingMode"` y `DROP TYPE "Discipline"`. Los tags DISCIPLINE se dejan.
- Después del down-script, M1 se marca revertida en `_prisma_migrations` (`migrate resolve --rolled-back`, o el UPDATE de `rolled_back_at` si Prisma se niega; RUNBOOK §2.4).
- **P3009:** ante **cualquier** fallo de la tx (`lock_timeout`, duplicado `(programId, index)`, rol sin BYPASSRLS por la guarda del backfill, id `tag_discipline_*` usado con otro slug), Martin corre `npx dotenv -e .env.prod.local -- npx prisma migrate resolve --rolled-back 20261004120000_plans_booking_link` antes de reintentar.

**Drift aceptado.** Medido en P1.Z: `migrate diff` muestra **exactamente 3 líneas** (`DROP CONSTRAINT` de `Booking_plan_patient_fkey`, `Booking_plan_tenant_fkey` y `Booking_session_program_fkey`). Prisma 5 no ve el resto de la lista (CHECKs, predicados de los parciales, policies), que igual existe solo en el SQL y no se borra. Objetos fuera del schema:
- únicos parciales: `Session_programId_index_live_key`, `Booking_session_active_key`, `ProgramAuthorization_programId_current_key`, `PatientChangeRequest_patient_pending_key`;
- FKs compuestas: `Booking_plan_tenant_fkey`, `Booking_plan_patient_fkey`, `Booking_session_program_fkey` (y las de las tablas nuevas solo si Prisma no las expresa igual);
- todos los CHECK: `TreatmentProgram_*_check`, `Session_priceCents_check`, `Booking_plan_link_check`, `Booking_plan_patient_check`, `Booking_priced_by_plan_check`, `PlanTemplate_*_check`, `ProgramAuthorization_*_check`, `PatientChangeRequest_*_check`;
- las policies `ProgramAuthorization_tenant_isolation` y `PatientChangeRequest_tenant_isolation`.

---

## 4. Contratos literales (se copian TAL CUAL en los prompts del área)

### C2 · Orden de locks (enmienda de AUDIT §5.28; ADR-004)

> **(0)** `lockPlanPatient` (`kinesoft:plan-patient:<tenantId>:<patientId>`, `lib/plan-lock.ts`, mismo hash que `booking-cap-lock`).
> - Solo lo toman las operaciones que cambian la estructura de un plan: crear, generar, re-planificar, mover en serie, agregar o archivar sesiones, cambiar de estado, cambiar el precio, adoptar y sacar.
> - **Siempre se toma primero.**
> - Ninguna función que corra con un lock de cupo tomado lo pide. `applyBookingUpdateInTx` nunca lo pide.
>
> **(1)** Cupo: claves `(practitionerId, serviceId, dayKey AR)` **deduplicadas y ordenadas** con el mismo compare de strings que `lockCapacityScope`.
> - `lockCapacityMany(tx, keys)` toma todas las claves en **UNA sentencia**: `SELECT count(pg_advisory_xact_lock(hashtextextended(k, 0))) FROM (SELECT k FROM unnest($1::text[]) WITH ORDINALITY u(k, o) ORDER BY o) s`, con el array ya ordenado en JS.
> - Incluye el día siguiente si una fila cruza la medianoche AR.
> - Una tx puede tomar los días de N turnos **si los ordena**.
>
> **(2)** `lockTenantLocationsShared` **una vez**; después se valida la sede con `where {id, tenantId, active}`.
>
> **(3)** Filas en este orden: **Booking (`FOR UPDATE`, id asc) → Session → TreatmentProgram**.
> - El CAS del `updatedAt` del programa va al final.
> - Toda escritura multi-fila (reprecio, redistribución, desestampado, cancelar futuros) hace antes `SELECT … FOR UPDATE ORDER BY id` de las candidatas.
> - Cerrar en Seguimiento lockea primero el Booking activo vinculado.
> - **ES1 (fixer de P0.Z):** el cierre en Seguimiento (`completeSessionFromSeguimiento`, antes de contar para autocompletar) y `rescheduleSession` toman Session → `TreatmentProgram`. Sin eso, dos cierres concurrentes de las últimas sesiones nunca autocompletaban y el reschedule era check-then-write.
> - **Enmienda ES2b (P2.Z, H-a2):** ese lock del plan es **`FOR NO KEY UPDATE`**, no `FOR UPDATE` (el INSERT de un turno con FK al plan pide `FOR KEY SHARE`, que choca con `FOR UPDATE` y daba 40P01 contra re-planificar/vincular/adoptar), con `withTxConflictRetry` en cierre y reschedule.
> - **Enmienda ES2b (P2.Z, H-a1):** el motor lockea las sesiones que escribe (`lockWrittenSessionsInTx`, `FOR UPDATE ORDER BY id`) y exige que sigan abiertas (si no, stale); Seguimiento re-cuenta los turnos activos después del claim. Toda escritura de `Session` va antes de los INSERT de `Booking` con FK.
> - **Desvío de re-planificar (S16a):** si cambian las refs, el plan se escribe antes de re-clasificar (el motor lee las refs del plan), con las sesiones de la selección ya lockeadas id asc; los futuros impagos se cancelan después de re-clasificar y antes del commit. Detalle en ADR-004.
> - "Este y los siguientes" pre-lockea todos los Booking en id asc antes de llamar al core por fila (`capLocksHeld:true`).
> - `cancelBookingsInTx` no toma cupo.
>
> **Reintento:** P2034/40P01 → **un** reintento de la tx completa.
> **Comentario:** S07i corrige `lib/booking-cap-lock.ts:28-30`. El invariante es el orden global lexicográfico, no "un turno por tx".

**Enmienda C2 (1b) · Sala (SR, 08-oct; plan §17.1, ADR-004).** El orden pasa a ser **paciente → cupo → sala → sedes →
filas**:
- **(1b) Sala:** claves `kinesoft:room:<tenantId>:<roomId>:<dayKey AR>` (`roomLockKey`/`roomKeysForWindow`,
  `lib/booking-cap-lock.ts:199,206`). Cupo y sala van en **una** sentencia (`lockCapacityAndRoomsMany`,
  `lib/booking-cap-lock.ts:252`): dedupe y orden en JS, los prefijos `cap:` y `room:` no se pisan. Sin sala, el array es
  el de antes y no hay statements nuevos.
- En la edición con **sala por defecto** (`roomDefaulted`), la sala se conoce recién después de leer las franjas: va en
  una 2.ª sentencia, después del cupo y **antes** de las sedes. Solo cambio de sala: la clave sola, antes de las sedes.
- La sala se valida (`lockActiveRoomInTx`, `lib/booking-rooms-internal.ts:63`; null = `bad-room`) **después** de
  `lockTenantLocationsShared`, y se cuenta (`countRoomOverlapsInTx`, `:193`) solo con la clave tomada.
- **Configuración:** sedes compartido → `kinesoft:room-schedule:<tenantId>` (exclusivo, solo si el guardado tiene
  sala) → `schedule:<pracId>` / `schedexc:…` (`lib/practitioner-schedule.ts:184-196`). Ningún write-path de turnos
  toma `room-schedule`.
- **Bloqueo de sala:** clave de sala (`lockCapacityAndRoomsMany(tx, [], roomKeysForWindow(…))`) → sedes → validar sala
  (`lib/time-blocks.ts:189-203`). `archiveRoom`/`updateRoom`/`restoreRoom`: sedes **exclusivo**.
- **Sin clave de sala (SR-D3):** Planes, "este y los siguientes" (`capLocksHeld`) y el turnero estampan la sala sin
  chequear ocupación; no se tocan C6/C7 ni se suma riesgo de deadlock.

### C3 · Keys

- **Program:** UUID del cliente por instancia del drawer, con las reglas de `acceptClientKey`. Único **por tenant**.
- **Turno de plan:** `plan:<generationId>:<index>`, donde `generationId` = `seriesId` de esa generación.
  - Nunca termina en `:<ISO>:<patientId>`, así que `isPublicReservation(...) === false` (§5.18), con test.
- `createBooking` y el batch **rechazan** keys de cliente con `pub:` o `plan:` (S07k, ES1).
- Un CANCELLED conserva su key; regenerar usa otro `generationId`.
- **Nunca** se adopta una reserva pública PENDING impaga.
- **Turno adoptado:** si llega un reintento de alta con su key UUID, el holder del upsert ve `programId` no nulo y devuelve éxito idempotente **sin update** (S12).

### C4 · Sincronía turno↔sesión (todos los write-paths)

**"Sin turno"** = sesión viva, no completada y **sin** turno con `sessionId` y `status ∉ {CANCELLED, NO_SHOW}`. Es un predicado único (`lib/plan-predicates.ts`), no una columna.

**Escrituras de turno que propagan a la sesión:**

| Evento | Camino | Efecto | Orden de filas |
|---|---|---|---|
| Reprogramar ("solo este") | `updateBooking` → `applyBookingUpdateInTx` | `Session.scheduledFor` = turno (I3), con `where {id, program:{tenantId}}` | cupo → sedes → Booking → Session |
| Este y los siguientes / re-planificar | `lib/plans-move` | Por fila igual que arriba; `capLocksHeld:true` | paciente → cupos → sedes → Booking asc → Session |
| COMPLETED (drawer) / "Atendido" (Recepción) | core / `markReceptionAction` | `completeSessionInTx({source:'booking'})`: **solo `completedAt`** (sin ejercicios, EVA ni meta); no autocompleta. Post-commit: `PROGRAM_NEARING_DISCHARGE` si quedan ≤ 1 vivas pendientes | Booking → Session |
| Salir de COMPLETED (Deshacer Atendido, o drawer → CANCELLED/NO_SHOW/CONFIRMED) | core / `markReceptionAction` | `reopenSessionIfUntouchedInTx`. Si hay evolución, queda realizada y se avisa | Booking → Session |
| CANCELLED / NO_SHOW / Ausente (drawer, Recepción, candado, pausar o cancelar el plan, turnero, webhook MP) | cualquiera | **Nada**: queda "sin turno" con su cuota y su fecha planificada | — |

**Reactivar un turno de plan cancelado o ausente** (CANCELLED/NO_SHOW → PENDING/CONFIRMED, por drawer o `setBookingStatus`), en el core:
- exige sesión viva y no realizada, y plan ACTIVE o PAUSED;
- si no se cumple: *"La sesión N ya no está pendiente"*;
- si `pricedByPlan` y está impago, **re-estampa** `copagoCents = Session.priceCents`;
- P2002 → *"La sesión N ya tiene otro turno activo"*.

**Rechazos y errores controlados:**

| Evento | Camino | Efecto |
|---|---|---|
| "Deshacer Ausente" con otro turno activo | `markReceptionAction` | Atrapa **P2002** además de P2025 → mensaje, no 500 |
| Cambiar el paciente | core | Rechazo (la FK compuesta es la red) |
| `deleteBooking` de un turno de plan | `bookings.ts` | Rechazo: *"Este turno es de un plan: cancelalo y la sesión queda sin turno"* |
| Cancelar un turno de plan con cobro (P6) | core | Rechazo: *"Tiene un cobro registrado: reprogramalo"* |
| Ausente de un turno de plan con cobro | core / Recepción | **Se permite.** La sesión queda "sin turno, con cobro previo" y su próximo turno se estampa en **$0** (C5) |

**Escrituras de sesión que propagan al turno:**

| Evento | Camino | Efecto | Orden de filas |
|---|---|---|---|
| Cerrar sesión (Seguimiento) | `completeSessionFromSeguimiento` | Turno activo PENDING o CONFIRMED → CAS a COMPLETED en la misma tx. Si ya estaba realizada → "Cargar evolución" | Booking `FOR UPDATE` → Session |
| `rescheduleSession` | `sessions.ts` | Con turno activo: por el core. Sin turno: mueve la sesión. Nunca cambia el profesional | cupo → sedes → Booking → Session |
| Archivar sesión | `plans-edit` | Con turno activo impago: se cancela en la tx. Con cobro o COMPLETED: rechazo | paciente → Booking → Session |
| Sacar del plan | `plans-adopt` | Con cobro: rechazo. Si no: `programId`/`sessionId` null, `pricedByPlan=false` y `copagoCents=null` (CAS) | paciente → Booking → Session |

**Nunca escriben el vínculo:** `createBooking`, el batch, el turnero y el webhook nunca escriben `programId`, `sessionId` ni `pricedByPlan`.

**"Untouched"** (para reabrir una sesión) = `notes`, `rpe`, `paInPre` y `paInPost` en null, sin EvaScore con ese `sessionId` (desde P2) y sin `SessionExercise` en un estado distinto de PENDING.

### C5 · Plata

**Base:**
- Todo en centavos `Int`, con `parseARS` y `formatARS`.
- **`Session.priceCents` es la fuente; `Booking.copagoCents` es su espejo** cuando `pricedByPlan`.
- `lib/copago.ts` **no se toca** (§5.5).
- **Sin precio:** `copagoCents` null y `pricedByPlan=false`.

**Reparto (P4):** `distributePackage` en pesos enteros, con el resto en las primeras sesiones (100.000/3 = 33.334 + 33.333 + 33.333). Si el total no es redondo, en centavos. Σ = total siempre.

**Fila bloqueada** (no se re-estampa nunca): PAID, AUTHORIZED o REFUNDED; `Payment` con plata; `insurerPaidAt`; copago manual; o `scheduledFor ≤ now`. Es `bookingHasMoney` (`lib/plan-pricing.ts`, incluye AUTHORIZED y REFUNDED). **Enmienda ES1:** `paymentStatus` FAILED también bloquea el reprecio (estado de pago en curso); el "copago manual" se deduce de los datos; un turno COMPLETED bloquea su fila.

**PACKAGE:**
- El monto de una fila bloqueada queda como su `Session.priceCents` y el resto se reparte entre las libres.
- Si no hay filas libres y el total nuevo difiere de lo bloqueado → rechazo: *"No quedan sesiones sin cobrar para repartir la diferencia"*.
- Si el total nuevo es menor que lo bloqueado o devengado → rechazo.
- **Enmienda ES2b (P2.Z, B-M2) · `locked-unpriced`:** si el plan pasa a PACKAGE y alguna fila bloqueada (realizada, cobrada o pasada) no tiene cuota (`priceCents` null, plan "sin precio"), `repricePlan` (puro, `lib/plan-pricing.ts`) rechaza con `code: 'locked-unpriced'` y copy accionable, en el preview y en el commit. Antes el commit tiraba I6 → 500. Además `ProgramInvariantViolation` se mapea a error de dominio en todos los `rejection()`.

**Reprecio y estampado** (CAS por fila, con conteo esperado conjunto):
- (a) **Re-estampar:** `{id, tenantId, programId, pricedByPlan:true, copagoCents: esperado, paymentStatus:'UNPAID', status in [PENDING,CONFIRMED], scheduledFor > now, payment null|UNPAID|FAILED}`.
- (b) **Primer estampado** (plan que pasa de "sin precio" a "con precio", o legacy completado): `{… pricedByPlan:false, copagoCents:null, mismas condiciones}`.
- Antes del `updateMany`: `FOR UPDATE ORDER BY id`.
- `count` ≠ esperado → stale y **rollback total**.
- Audit antes y después, dentro de la tx.

**Cobro previo:** si una sesión tiene un turno previo (CANCELLED/NO_SHOW) **cobrado de verdad**, el turno nuevo de esa sesión se estampa con `copagoCents=0` y `pricedByPlan=true`. El preview lo marca: *"Ya pagada en el turno del dd/mm"*.
- **Enmienda ES1 (revisor (a), A1):** "cobro previo" = `bookingWasCollected` (`lib/plan-pricing.ts`): `paymentStatus` PAID, `insurerPaidAt`, o `Payment` PAID. **REFUNDED y AUTHORIZED no cuentan** (reemplazo con la cuota normal). Antes usaba `bookingHasMoney` y daba $0 con un previo REFUNDED mientras `planBalance` no lo contaba como cobrado. `bookingHasMoney` queda para la fila bloqueada.
- **Decisión S14 (ES2b):** la OS pagada (`insurerPaidAt`) **no** suma en "cobrado" (es copago vs OS); el saldo expone `insurerPaidBookings` (conteo) y el borde "cancelado con OS pagada" va a C0. Test de paridad `bookingHasMoney` ↔ `cancelBookingsInTx` ↔ `bookingHasPaymentWhere` hecho.
- **Enmienda ES2b (P2.Z, B-M3):** marcar o desmarcar Cobrado en el turno previo (CANCELLED/NO_SHOW) re-estampa en la misma tx el turno activo de la sesión (CAS + `notice`); si no es estampable, solo avisa.

**Saldo (P7):**
- **pactado** = paquete, o precio × sesiones vivas;
- **devengado** = Σ `Session.priceCents` de las realizadas;
- **cobrado** = Σ de copagos PAID del plan, incluidos cancelados y ausentes (REFUNDED no cuenta; AUTHORIZED = "en proceso");
- **pendiente** = devengado − cobrado;
- **a favor** = cobrado − devengado.

Pendiente y a favor se recortan a 0 (nunca negativos). Plan que pasa a "sin precio" → se desestampa (unstamp).

Se calcula en el server.

**Q8** (fuera de plan): al marcar "Cobrado", si `copagoCents` es null, se congela el copago resuelto. **Cierra parcialmente** AUDIT:940; el resto (impagos pasados, `insurerPaidAt`) va a C0.

**I8:** el único escritor de `pricedByPlan=true` es el motor.

### C6 · Schedule v1 y días

```
PlanScheduleV1 = { v: 1, frequency: 'weekly' | 'monthly', everyNWeeks?: 1|2|3|4 (solo weekly; default 1),
                   slots: [{ dow: 0-6 (0=Dom, como PractitionerSchedule), startMin: 0..1439 (minutos AR) }] }
```

- **weekly:** de 1 a 7 slots, con `dow` distintos.
- **monthly:** exactamente 1 slot. El día sale de `startDayKey`, ajustado al último día del mes.
- **Conversión 0=Dom ↔ 0=Lun:** vive **solo** en `lib/plan-schedule.ts` y `lib/plan-editor-state.ts`, con tests en UTC y en AR.

### C7 · Tipos del motor

Los tipos puros los publica S07p en `lib/availability/plan.ts` (ES1). `lib/plans-types.ts` (P2-C1) **los re-exporta**: hay una sola fuente.

```
PlanCreateInput = { idempotencyKey, patientId, discipline, practitionerId, serviceId, locationId|null, title?≤120, notes?,
  durationMin? (15..240), schedule: PlanScheduleV1, startDayKey:'YYYY-MM-DD', totalSessions 1..60,
  pricing: null | {mode:'PER_SESSION', pricePerSessionCents} | {mode:'PACKAGE', totalPriceCents},
  templateId?, exercises?: [{exerciseId, sets, reps}], origin?: {kind:'diagnosis'|'template'|'booking'|'manual'},
  fromBookingId?, countBookingAsSession1?: boolean,
  rows: PlanRowResolution[], stateToken }
PlanRowResolution = { index, kind:'create'|'move'|'force'|'adopt'|'none'|'mark-done', at?: ISO,
  force?: {capacity?:true, outOfHours?:true, patientOverlap?:true}, bookingId?, expectedUpdatedAt? }
PlanRowFlags = { blocked, outOfHours, capacityFull, patientOverlapIds[], past,
  duplicate?: {bookingId, updatedAt, adoptable}, priorPaid?: {bookingId, at},
  overAuthorization?: boolean, afterAuthorizationExpiry?: boolean }      // E2: SOLO AVISO, nunca bloquean
PlanAuthorizationInput = { authorizedSessions: number|null; usedBefore: number;
  startsOnDayKey: DayKey; expiresOnDayKey: DayKey|null }                 // entrada pura del clasificador
PlanPreviewRow = { index, sessionId?, at, dayKey, flags: PlanRowFlags, suggestion?: ISO,
  defaultResolution, allowedResolutions[], priceCents|null }
PlanPreview = { rows, stateToken, summary, otherActivePlans: [{programId, discipline, ordinal, total}] }
CreatePlanResult = {ok:true, programId, idempotent:boolean} | {ok:false, kind:'stale-preview', preview} | {ok:false, error, fieldErrors?}
```

- `stateToken` = hash del borrador; solo ata el commit al mismo borrador.
- **El stale por fila** se decide por **resolución faltante** o por un adoptado que cambió su `updatedAt`. Nunca por hash de disponibilidad.
- **Flags de autorización (E2), publicadas por S07p en ES1:**
  - `classifyPlanRows(…, authorization?: PlanAuthorizationInput)`. Sin autorización, las dos flags quedan en `false`/ausentes.
  - `overAuthorization`: la fila es realizada o agendada número > `authorizedSessions`, contando `usedBefore` (realizadas con fecha AR ≥ `startsOn`) más las filas previas de la misma corrida.
  - `afterAuthorizationExpiry`: `row.dayKey > expiresOnDayKey`, comparando **dayKeys AR**, nunca instantes.
  - Test en TZ=UTC: vencimiento 30/11 y sesión el 30/11 a las 23:00 AR → no vencida; el 01/12 a las 00:30 AR → vencida.
  - `PlanCreateInput` suma `authorization?: {code?: string ≤64, authorizedSessions?: 1..200, startsOnDayKey, expiresOnDayKey?}` (zod en P2-C1, persistencia en S11e).

### C8 · Firmas congeladas (la ola que publica las congela; las siguientes solo agregan)

**ES1:**
- `runWithRls(tenantId, fn, opts?: {timeout?, maxWait?})` y `auditInTx(tx, params)`, de P0-Ck.
- De P0-Ck, en `lib/capabilities.ts` (puro; lo importan server y UI):
  - `canOperateBooking(caps, access) = access === 'full' || caps.has('agenda.operateAll')`. E1 lo escribió como `access !== 'basic' || …`; con el nivel `admin` de S02p esa forma dejaría operar a BILLING en `admin` (y a `none`), así que rige la forma positiva, que es equivalente para `full`/`basic`.
  - `canWriteClinical(caps, access) = caps.has('clinical.read') && access === 'full'`.
- De P0-Ck, `lib/booking-field-access.ts`: `bookingFieldAccess({clinical, access, hasPatient}) → {title, description, notes: 'rw'|'hidden'}`. Es la misma regla que la lectura de `listAgendaBookings`. **Un campo se escribe si y solo si se puede leer.**
- `createPatient(raw, opts?: {assignTo?: string})`, de S07sp (P0.2).
- `lockCapacityMany(tx, keys[])`: una sentencia; `lockPlanPatient(tx, {tenantId, patientId})`. De S07i.
- `completeSessionInTx(tx, {tenantId, sessionId, actorId, source:'seguimiento'|'booking', meta?, now}) → {claimed, programId}`. **No gatea** (gatea el caller), no toca Booking y no autocompleta.
  - Con `'booking'` escribe **solo** `completedAt`.
  - Con `'seguimiento'` hace lo de hoy: meta, ejercicios PENDING→DONE y EVA.
- `reopenSessionIfUntouchedInTx(tx, {tenantId, sessionId, now}) → {reopened, reason?}`, en `lib/sessions-internal.ts` (S02s; S12b suma el chequeo de EVA por `sessionId`).
- `assignableExerciseWhere(gate)` y `hcAccessError(actor, patientId, tx)`.
- `loadAvailabilityInputsForDays(db, params: LoadAvailabilityForDaysParams) → LoadedAvailabilityInputForDays` (S07L), con `FOR_DAYS_MAX = 400` días por llamada y queries constantes (OR de tramos). **El input trae solo los `days` pedidos y el motor no mira `from/to`.**
- `nextFreeSlot({..., until?})` (S07p): `until` es cota **exclusiva**. `patientConflictsAt` exportado de `classify.ts` (aditivo, AUDIT §5.27).
- **Publicadas por S02s** (`lib/sessions-internal.ts`, única puerta de cierre y reapertura): `completeSessionInTx(...) → {claimed, programId}` y `reopenSessionIfUntouchedInTx(...) → {reopened, reason?}` con `reason: 'not-found' | 'not-completed' | 'touched'`. El audit `session.complete` no lleva `programCompleted`; el autocompletado se audita aparte como `program.status {auto:true}`.
- **Agregadas a `updateBooking` en ES1** (S07sb), que S07c tiene que enumerar en `BookingUpdateTxOutcome`: el outcome `clinical-relink` (re-vínculo de paciente sin `clinical.read` con datos clínicos) y `ok.written` (qué campos se escribieron después del filtrado de `bookingFieldAccess`).

**ES2b P2.0 (S07c):**
- `applyBookingUpdateInTx(tx, actor, input: { patch: z.output<typeof BookingUpdate>; expectedUpdatedAt?: string; force: ForceFlags }, opts: { now: Date; capLocksHeld?: boolean }): Promise<BookingUpdateTxOutcome>`.
  - `BookingUpdateTxOutcome` = la unión **tal como existe en `updateBooking` después de ES1**. S07c la enumera literal leyendo el cuerpo de `updateBooking` **por símbolo**, no por número de línea: ES1 (S07k y S07sb) mueve los rangos de 3ff2e50. Esperada: `notfound | stale | basic | foreign-patient | patient-slot | blocked | out-of-hours | patient-overlap | conflict | bad-location | ok`.
  - Un P2002 **aborta la tx**: lo resuelve el caller, por los datos y en una tx nueva.
  - **Contrato Secretaria (E1, literal):** el gate `canOperateBooking(caps, access)` y el filtrado de `bookingFieldAccess` viven **dentro** de `applyBookingUpdateInTx`, no solo en el wrapper `updateBooking`. Así "mover", "este y los siguientes" y la sincronía no lo saltean. Un campo no permitido se saca del patch **antes** del write y del audit. El re-vínculo de paciente sin `clinical.read` sigue la regla de S07sb. `bookings-secretaria.test.ts` entra en la prueba de paridad de S07c y tiene que pasar sin cambios.
- `validateBookingRefsInTx(tx, actor, {...})` y `buildBookingCreateData(...)`.
- S12 solo **agrega** variantes al outcome (`plan-session-not-pending`, `plan-paid-cancel`, `plan-delete`, `plan-patient-change`).

**ES2b P2.0.0 (P2-C1 publica stubs con firma congelada):**
- `assertProgramInvariantsInTx(tx, {tenantId, programId})` (lo implementa S11v).
- `loadAgendaPlanProjection(tx, actor, rows: {id, patientId, serviceId, programId, sessionId}[], caps) → Map<bookingId, C9Fields>` (lo implementa S12p).

**ES2b P2.1 publica para P2.2 (S11e):**
- `validatePlanRefsInTx` (incluye la duración efectiva 15..240, la membresía aceptada y la regla PS);
- `commitPlanRowsInTx(tx, actor, {program, rows, mode:'create'|'generate'|'replan'|'add', now})`;
- `createPlanInTx(tx, actor, input, {now, clinicalCase?: (tx)=>Promise<string>})`;
- **`previewProgramRowsInTx(db, actor, {programId, target: {sessionIds} | {newRows}, mode:'generate'|'replan'|'add', overrides?, now}) → PlanPreview`**;
- **`reclassifyOrThrowStaleInTx(tx, actor, {programId, rows, resolutions, now})`**;
- la clase `StalePlanPreview`.

S16a, S16b y S25a **solo consumen** estas primitivas. Cualquier cambio a `plans-engine-internal` o `plans-load-internal` en P2.2 va por handoff.

**ES2b publicado (07-oct; congelado para ES3, que solo agrega).** Resumen; la fuente son los archivos:
- **P2-C1:** `lib/plans-types.ts` (re-exporta `@/lib/availability/plan` + `Discipline`), `lib/plans-schemas.ts` (zod de C6/C7, `PlanIdempotencyKey` 8..64 sin `pub:`/`plan:`, `PlanPreviewInputSchema`), `lib/plan-predicates.ts` (`liveSessionWhere`, `liveProgramWhere`, `linkedProgramWhere`, `sessionWithoutActiveBookingWhere`, `bookingHasPaymentWhere`, `adoptableBookingWhere`), `lib/plan-authz-internal.ts` (`assertPlanManageInTx`/`ScheduleInTx`/`AuthorizeInTx(tx, actor, caps, patientId) → PatientAccessLevel`, `planTitleFor`, `canSeePlanAuthorization`, `PLAN_FORBIDDEN_COPY`), `lib/booking-events-internal.ts` (`BookingChangeRef`, `afterBookingsCommitted(tenantId, refs, opts?)`).
- **Core (S07c + S12, `lib/bookings-core.ts`):** `applyBookingUpdateInTx(tx, actor, {patch, expectedUpdatedAt?, force}, {now, capLocksHeld?}) → BookingUpdateTxOutcome` = `notfound | stale | basic | foreign-patient | clinical-relink | patient-slot | blocked | out-of-hours | patient-overlap | conflict | bad-location | plan-session-not-pending{ordinal} | plan-paid-cancel | plan-patient-change | ok{before, updatedAt, written, refs, plan}`; P2002 se propaga, P2025 → stale. `validateBookingRefsInTx`, `buildBookingCreateData`, `resolveBookingUpdateUniqueViolation`, `syncPlanSessionAfterBookingWriteInTx`. `UpdateBookingResult.notice?` y `ReceptionActionResult.notice?`. `AgendaBookingRow = … & AgendaPlanFields` (requeridos).
- **Motor (S11e + fixer):** `previewPlan(raw)`, `createPlan(raw) → CreatePlanResult`; `previewProgramRowsInTx`, `reclassifyOrThrowStaleInTx(tx, actor, {programId, rows, resolutions, now, mode?, stateToken?})`, `commitPlanRowsInTx(tx, actor, {program, rows, mode, now, exercises?}) → {refs, sessionIds, createdBookings, adoptedBookings, generationId}`, `createPlanInTx(tx, actor, input, {now, clinicalCase?, caps?, origin?})`, `validatePlanRefsInTx`, `StalePlanPreview{preview|null, reason:'rows'|'draft'|'write-conflict'}`, `PlanRejected`, `programStateToken`, `legacyFrequency`. `PlanEngineRow.currentAt?` (P2.Z).
- **Verificador (S11v):** `assertProgramInvariantsInTx(tx, {tenantId, programId})` tira `ProgramInvariantViolation`; `checkProgramInvariants(snapshot)` puro. I6 no exige espejo `copagoCents = priceCents` (copago manual y cobro previo $0 son legítimos).
- **Proyección (S12p):** `loadAgendaPlanProjection(tx, actor, rows, caps)`; `AgendaPlanProjectionRow.serviceDiscipline?` (aditivo del orquestador).
- **Lecturas (S14, `lib/plans-read.ts`):** `listPlans`, `getPlanDetail`, `getPatientPlans`, `getPatientPlanBalances`, `getPlanHistory`, `listSchedulablePlanSessions` → `PlanReadResult<T> = {ok:true, data} | {ok:false, error}`.
- **P2-C2 (`lib/plans-edit-types.ts`, `lib/plans-lifecycle-state.ts`):** resultados `PlanWriteResult<T>` (`ok | stale | needs-confirmation | fail`) y `PlanEngineWriteResult<T>` (+ `stale-preview{preview}`); preview por motor con `rows` default `[]` + `stateToken?`, commit con `rows` + `stateToken` obligatorios; ops del motor sin `expectedUpdatedAt` (el `stateToken` incluye `program.updatedAt`), ops sin motor con `expectedUpdatedAt`. `OpenSessionBuckets.sinTurno?/realizadasSinEvolucion?/suggestDischarge?`, `OpenSessionRow.ordinal?/totalLive?`.
- **Actions de P2.2:** `lib/plans-lifecycle.ts` (`previewPlanStatusChange`, `changePlanStatus`, `updatePlanDetails`, `archivePlan`, `restoreProgram`); `lib/plans-move.ts` (`previewMovePlanSeries`, `movePlanSeries`, `previewReplanPlan`, `replanPlan`); `lib/plans-edit.ts` (`previewAddPlanSessions`, `addPlanSessions`, `archivePlanSessions`, `restoreSession`, `previewRepricePlan`, `repricePlan`, `renewPlanAuthorization`); `lib/plans-adopt.ts` (`previewGeneratePlanBookings`, `generatePlanBookings`, `linkBookingToSession`, `adoptBookingSeries`, `removeBookingFromPlan`); `lib/diagnosis.ts` (`createPlanFromDiagnosis({plan, diagnosis})`, `getDiagnosisPlanPrefill`, `searchPatientsForAssignment(q, {requireFull?})`); `lib/sessions.ts` (`loadSessionEvolution`, `CompleteSessionResult.suggestDischarge?`); `lib/patients.ts` (`setPatientArchived`/`bulkArchivePatients({…, plansAction?: 'pause'|'cancel'})`, default `pause`); `lib/patient-search.ts` (`searchPatientsForBooking(q)`); `setBookingCopagoPaid`/`InsurerPaid` → `notice?`.

### C9 · Campos de agenda

En `AgendaBookingRow` son requeridos. En `BookingDTO` y `DrawerBooking` son **opcionales**, con el patrón B4.1: solo los trae la proyección liviana.

```
programId?: string|null; sessionId?: string|null; pricedByPlan?: boolean;
plan?: null | { discipline: 'KINESIOLOGY'|'OSTEOPATHY'|null; ordinal: number; totalLive: number; title: string|null }; // title null si !clinical.read o acceso básico
serviceDiscipline?: 'KINESIOLOGY'|'OSTEOPATHY'|null;
patientActiveLinkedPlanDisciplines?: Array<'KINESIOLOGY'|'OSTEOPATHY'|'NONE'>;   // R-LEGACY; [] = sin plan vinculado activo
```

- Salen de **queries planas** (S12p).
- Presupuesto del payload semanal: ≤ +5 %.
- **La autorización de la OS nunca va en C9** (E2): ni código, ni sesiones autorizadas, ni vencimiento.
- La proyección completa (`listBookingsInRange`) **no** los trae (`bookings-reception.test.ts:380` sigue verde sin cambios).
- **Medición ES2b (S12p) y decisión del orquestador:** un turno suelto pesa 777 B en el DTO base y el bloque C9 neutro entero le suma +133 B (los turnos de plan crecen ~200 B, es información nueva). El presupuesto de +5 % se mide **sobre turnos sueltos**. Para cumplirlo, **ES3 (P3-C, dueño de `toBookingDTO` en `components/agenda/agenda-utils.ts`) arma un DTO compacto**: omite los neutros (`programId`/`sessionId`/`plan` null, `pricedByPlan` false, `[]`) y resuelve `serviceDiscipline` en el cliente desde el catálogo de servicios. La agenda quedó en 16 statements (techo 16) con `service.discipline` en `listAgendaBookings`. Sin módulo `planes`: C9 neutro y sin queries.

### C10 · Deep-links y editor

**Rutas:**
- `?tab=planes&programa=<id>`
- `?tab=planes&nuevo=1&turno=<bookingId>`
- `?tab=planes&nuevo=1&prefill=<base64url de PlanEditorPrefill>`
- `/diagnostico?patientId=&bookingId=`

**Reglas del parser:**
- Se parsean **solo** en `lib/plans-deeplink.ts`, con zod y un tope de 2 kB para `prefill`.
- La unión `Tab` usa `'planes'`, con el alias `'plan'` (`lib/plans-deeplink.ts:33-35`, `PLANS_TAB` y
  `PROFILE_TAB_ALIASES`).
- Desde el modal, sin paciente guardado: el link queda deshabilitado con el hint *"Guardá el paciente para armar un plan"*.
- **`PlanEditorPrefill` no lleva `authorization`** (enmienda de P3.Z): el código de la autorización de la OS es texto
  libre y en la URL queda en el historial, los logs y el Referer (§2.6, "sin texto libre"). Se carga en el editor. Un
  link viejo que la traiga abre igual: la clave se descarta como cualquier desconocida
  (`lib/plans-deeplink.ts:60-87`).

**Props del editor:**

```
PlanEditorDrawerProps = {open, onClose, onSaved({programId, patientId}), patientId?, programId?,
  mode:'create'|'generate'|'replan', prefill?: PlanEditorPrefill, fromBookingId?, templateId?, diagnosis?,
  discipline?, generateForSessionIds?, replanFromSessionId?}
```

Cantidad y precio no van en el editor: tienen diálogos propios (S22e).

### C11 · Fechas

- Solo `lib/datetime-ar.ts` y `lib/availability/day.ts`.
- Nada de `getDay`, `setHours` ni `toISOString().slice(0,10)` del host para "hoy".
- Todo `toLocale*` del cliente lleva `timeZone: "America/Argentina/Buenos_Aires"`.
- ~~**Excepción documentada:** `plan-view.tsx:346`~~ (S22a reescribió `plan-view.tsx` en ES3 y el slice UTC de `startDate` ya no existe).

### C12 · Preservar AUDIT §5 (literal en cada prompt del área)

1 (rls), 4 (webhook MP intacto), 5 (copago), 6 (visibility/título), 7 (`expectedUpdatedAt`), 11 (datetime-ar), 12 (`*-internal` server-only), 14 (audit-extension), 17 (`seriesId`), 18 (`isHoldingCapacity`), 24 (exports por ruta), 27 (motor y paridad), 28 (**con la enmienda C2**), 29 (`isOverbooked` + prefijo), 30 (backfill idempotente y `updatedAt` de Booking), 31 (catálogo GLOBAL_READONLY), 33 (defaults PS), 34 (`NO_LOCATION_ID`), 35 (capabilities fallan cerrado). **Desde ES2b también** 36 (keys `plan:`), 37 ("sin turno" derivado), 38 (I8: solo el motor vincula), 39 (nada vinculado se borra) y 40 (orden de locks de Planes).

Según el área:
- **6** (visibility): S02p lo enmienda con el nivel `admin` (E1); el resto de §5.6 se preserva. La enmienda se asienta en AUDIT §5 en P0.Z.
- **8** (vínculo del auth callback) y **22** (staff ≠ paciente): S02p, S24a, S24.
- **19** (`safeNext`) y **21** (cookies de Supabase): S24a (toca el callback) y S24d (cierre de sesión global).
- **16** (scripts `prisma:*` envueltos): S26a, S02x (~~S25n~~ eliminada por el reset).

### C13 · UX literal

**Editor**, en este orden:
1. Paciente (solo si falta; `PatientPicker requireFull`).
2. Disciplina: segmentado Kinesiología / Osteopatía.
3. Servicio: los de la disciplina + los sin disciplina, con el hint *"Asigná la disciplina en Configuración → Servicios"*.
4. Profesional responsable.
5. Sede.
6. Inicio, cantidad y horario por día.
7. Precio: *"Sin precio · sigue la cobertura" / "Por sesión" / "Paquete"*.
8. Notas.

**"Revisá los turnos"**, tabla `# · lun 06/10 · 09:00 · Estado · Resolución`:
- **Estados:** "Libre", "Sobreturno", "Fuera de horario", "Bloqueado: <motivo>", "Ya tiene un turno a esa hora", "Se superpone con otro turno del paciente", "Ya pasó", "Ya pagada en el turno del dd/mm".
- **Resoluciones:** "Crear", "Mover a jue 09/10 · 10:30", "Crear como sobreturno", "Crear igual", "Usar el turno existente", "Dejar sin turno".
- **Resumen:** *"10 sesiones · 8 turnos nuevos · 1 movido · 1 sin turno · lun y jue 09:00 · 06/10 → 13/11 · Paquete $120.000"*. Botón: *"Crear plan y 9 turnos"*.
- **Stale:** *"La agenda cambió mientras armabas el plan. Revisá las filas marcadas y confirmá de nuevo."*
- **Otro plan activo:** *"Este paciente ya tiene el plan Kine (3/10) activo."*

**PlanCard:**
- Estados de sesión: Realizada ✓ / Con turno / Sin turno ("Agendar") / Vencida sin cerrar / Archivada (oculta).
- Autorización de la OS (solo para quien la puede ver, §2.6): *"Autorizadas 10 · usadas 6 · agendadas 3 · vence 30/11"*. Renovación: *"Renovar autorización"* (S22e).
- Legacy: *"Plan anterior a la agenda · Completá los datos para agendar"*.
- Diálogo D7: *"¿Qué hacemos con los 6 turnos que quedan? · Cancelarlos (recomendado) · Dejarlos en la agenda · 2 tienen un cobro registrado y no se tocan"*.
- Alta: *"Completó las 10 sesiones. ¿Le das el alta?"*.

**Edición (S22e):**
- Precio: *"Cambiar precio: de $X a $Y en N turnos · M quedan como están (cobrados o pasados)"*.
- Cantidad en paquete: *"¿Mantenemos el total ($120.000) o el precio por sesión?"*.

**Otras superficies:**
- **Seguimiento:** bucket "Sin turno", tag "Sin evolución", "Cargar evolución", "Sesión n de N" (ordinal).
- **Drawer:**
  - *"Ausente · la sesión 3 queda sin turno para reprogramar"*;
  - "Cancelalo" en lugar de "Eliminar" (solo PENDING/CONFIRMED, P3.Z);
  - "Copago (plan)";
  - "Sacar del plan" en los turnos **de plan** (no en uno cancelado: ya liberó la sesión) y "Vincular a una sesión" en
    los turnos "Fuera de plan", los dos con `plans.manage` (`components/agenda/booking-drawer/plan-row.tsx:123-127`).
    *Corregido en ES3: la redacción anterior ponía las dos acciones en "Fuera de plan", y un turno suelto no tiene plan
    del que salir.*
- **Estado COMPLETED de un plan:** *"Finalizado"* en todas las superficies (`components/planes/plan-booking-groups.ts:193`;
  antes "Completado" en Turnos/Facturación y "Finalizado" en `/planes`). Lo fijó ES3 porque C13 no lo definía.

### C13b · Display de planes (V1-D18 · V2 · M13; volcado de S16p en ES1, `lib/plan-display.ts`)

| Fila | Regla |
|---|---|
| **V1-D18 · chip** | `planChip({discipline, ordinal, totalLive})` → `Kine · 3/10` / `Osteo · 3/6`; legacy sin disciplina → `Plan · 2/8`. El aria arranca con el literal *"Sesión 3 de 10"* (`planSessionLabel`, que también usan ICS y recordatorio) y suma la disciplina (*"Sesión 3 de 10 · Kinesiología"*). Disciplina y contador los ve todo el que ve el turno; **el título del plan nunca sale del chip** (la entrada no lo lee). Color: `var(--disc-kine)` / `var(--disc-osteo)`, que solo acompaña al texto (canal no cromático primero). En "Por profesional" el chip es una pill distinta de la ocupación "2/3" |
| **V2 · Fuera de plan** | `isOutOfPlan`: turno suelto (`programId` null), no cancelado, con paciente, de un paciente con plan ACTIVE **vinculado** (R-LEGACY) de la misma disciplina que el servicio. Servicio sin disciplina → cualquier plan vinculado activo cuenta. Plan vinculado sin disciplina (`"NONE"`) cubre cualquier servicio (es un aviso, no bloquea). Sin campos C9 (proyección completa) → `false`, no adivina |
| **M13 · ordinal** | El `index` de una sesión es fijo (no se renumera; `restoreSession` falla si otro tomó su index). Lo que se muestra es el **ordinal** por fecha entre las no archivadas, con empate de instante resuelto por `index`. Las archivadas no tienen ordinal (`planSessionOrdinals`) |

### C14 · Reglas de tests (nuevo)

**`it.fails` vs `it`:**
- `it.fails("[Px-Syy] …")` es **solo** para bugs vivos de código existente.
- La funcionalidad nueva usa `it`, escrito **antes** de implementar. Si hace falta, con stub de la firma.
- Nunca se escribe `it.fails` sobre un módulo que todavía no existe.

**Tests post-integración:** los que ejecutan código de **otra** sesión de la misma ola se marcan así y se corren en la mini-integración, no en el gate por sesión.

**Carreras:**
- usan `tests/helpers/advisory-wait.ts` (`waitForAdvisoryWaiter(db, key)`): filtra `classid`/`objid` de `hashtextextended(key,0)` con `objsubid=1`;
- nunca un `count(*) … NOT granted` global.

**Perf:**
- `PERF_OUT_DIR=<scratchpad> npm run test:perf && npx tsx tests/perf/compare.ts <scratchpad>`;
- `tests/perf/*.json` versionados **no se regraban**.

**Datos de test:** `tenant-factory` y `plan-factory` (insert directo), con tenants únicos y sin sweeps globales.

---

## 5. Motor (resumen operativo)

### Capas

1. **Puro (ES1):**
   - `lib/availability/plan.ts`:
     - `expandPlanDates`;
     - `classifyPlanRows`, con fold de turnos virtuales y esta precedencia (enmienda ES1): duplicado > **pasado** > bloqueado (duro) > fuera de horario > superposición del paciente (sin sobreturno) > cupo (sobreturno) > libre. Un pasado adopta; default `move`/`none`, nunca `force`; `adopt` exige `expectedUpdatedAt`; mensual usa el día de `startDayKey`; `stateToken` = FNV-64 puro;
     - `suggestRowSlot` (mismo día AR; si no, hasta el día anterior a la próxima sesión; en la última fila, el horizonte de `nextFreeSlot` (14 días), fix A3 de P0.Z);
     - `planStateToken`.
   - `lib/plan-schedule.ts`.
   - `lib/plan-pricing.ts`: `distributePackage`, `isLockedForReprice`, `repricePlan`, `planBalance`, `priorPaidStamp`.
   - `lib/plan-display.ts`: chip, aria, `isOutOfPlan` con R-LEGACY, ordinal.
2. **Core de turnos (ES2b P2.0):** `lib/bookings-core.ts`.
3. **Motor server-only (ES2b P2.1):** `plans-load-internal` (por días), `plans-engine-internal`, `plan-invariants-internal`, `plan-pricing-internal`, `plan-predicates` y `agenda-plan-projection-internal`.
4. **Actions finas `"use server"`** (solo async): `plans.ts`, `plans-read.ts`, `plans-lifecycle.ts`, `plans-move.ts`, `plans-edit.ts`, `plans-adopt.ts`, `plans-legacy.ts`.

Todas siguen el mismo camino: `getActor` → zod → **gate según la action** → `where tenantId` a mano → `runWithRls`. Los gates viven en `lib/plan-authz-internal.ts` (P2-C1) y las actions **solo los consumen**:
- **`plans.manage`** (`assertPlanManageInTx`: `plans.manage` + acceso **full** + `clinical.read`): crear, editar título y notas, precio, cantidad, ciclo de vida, adoptar, vincular y sacar del plan, re-planificar ("Editar desde la sesión N").
- **`plans.schedule`** (`assertPlanScheduleInTx`: `plans.schedule` + (full **o** `agenda.operateAll`)): agendar una sesión (`generatePlanBookings` con `sessionIds`), mover "solo este" o "este y los siguientes", cancelar y Recepción.
- **`plans.authorize`** (`assertPlanAuthorizeInTx`: `plans.authorize` + (full **o** `agenda.operateAll`)): cargar y renovar la autorización de la OS.
- **Lecturas:** acceso full (con `clinical.read`) → DTO completo. `plans.schedule` sin `clinical.read` → solo la proyección administrativa (`listSchedulablePlanSessions`, ordinal, disciplina, "sin turno", saldo) con **título null** (`planTitleFor`) y sin notas, ejercicios, EVA ni precios por sesión. `getPlanDetail` completo pedido por ASSISTANT → Forbidden. La autorización sale solo para `(full && clinical.read) || plans.authorize || billing.manage`.
- El preview y el move redactan los títulos del plan y de la sesión para quien no tiene `clinical.read`. `priorPaid` y la cuota quedan.

### Preview (solo lectura, ≤ 30 statements)

1. Validación de refs: duración efectiva, regla PS, membresía aceptada, sede activa y coherencia de disciplina.
2. `expandPlanDates`.
3. `loadAvailabilityInputsForDays`.
4. `classifyPlanRows` + `suggestRowSlot`.
5. Cuota por fila + `priorPaid`.
6. `stateToken` + `otherActivePlans`.

### Commit (una `runWithRls(t, fn, {timeout:15000, maxWait:5000})`, ≤ 60 statements para 20 filas)

1. Validación completa dentro de la tx.
2. `lockPlanPatient`.
3. Idempotencia por `{tenantId, idempotencyKey}`.
4. `lockCapacityMany` (1 statement).
5. Sedes.
6. Re-clasificación + resoluciones → `StalePlanPreview`.
7. Hook `clinicalCase`.
8. Escrituras:
   - `treatmentProgram.create`;
   - `session.createManyAndReturn` (por `index`, con `priceCents`);
   - `sessionExercise.createMany` (dosis `?? 3/12`, `assignable`);
   - `booking.createManyAndReturn` (correlación por **key**): `plan:`, `seriesId`, `isOverbooked` + prefijo, `copagoCents`/`pricedByPlan`, CONFIRMED;
   - adopciones por CAS con `adoptableBookingWhere` y `count === 1`.
9. Caché `totalSessions`.
10. `assertProgramInvariantsInTx`.
11. `auditInTx`.

**Post-commit:**
- un `notify` resumen (`NotificationKind.SYSTEM`);
- revalidate.

**Errores:**
- **P2002:** rollback y resolución en una tx nueva (si el programa con esa key existe = éxito; si no, stale).
- **P2034/40P01:** un reintento.

---

## 6. Reglas comunes de ejecución

### Brief de cada agente (literal)

- **Reglas duras de AGENTS §4:**
  - git solo lectura;
  - nada de seeds, reset ni `migrate dev`;
  - prod nunca;
  - no leer valores de `.env*`.
- **No tocan `.docs/`:** dejan "notas para docs".
- **Contexto que recibe:**
  - su contrato literal (§4) + C12 del área + C14;
  - su lista de archivos (lo ajeno va como **handoff exacto** al integrador);
  - tests primero (C14);
  - TZ=UTC en todo el QA de fechas;
  - techo de ~50 tool calls.
- **Swap atómico:** el dueño de un archivo que otros importan en la misma ola (`bookings.ts`, `bookings-core.ts`, los stubs de P2-C1, `sessions-internal.ts`) escribe primero el módulo nuevo y reemplaza el archivo caliente en **un único Write final**, sin estados intermedios rotos.

### Esfuerzo y concurrencia

- **Esfuerzo alto** en plata, concurrencia, TZ, seguridad, migración y datos de prod (marcado en cada sesión).
- **Concurrencia por ola:** máximo 8 agentes simultáneos y máximo 5 corriendo integración. Si una ola tiene más, el orquestador la parte en tandas. Las sesiones de una ola no dependen entre sí, así que el orden de las tandas da igual.

### Gate por sesión (G)

1. `npx tsc --noEmit` sin errores en sus archivos.
2. `npm test` (UTC) y `npm run test:tz-ar` del área.
3. `npm run guard:isolation`.
4. `npm run test:integration -- <patrón>` **y** `npm run test:integration:owner -- <patrón>`, salvo los marcados post-integración.
5. Sus `it.fails` dados vuelta **en el archivo**, y sus `it` nuevos en verde.

---

## 7. Paso 0 · antes de ES1 (orquestador con OK de Martin; commit de docs) · ✅ hecho el 04-oct

1. ✅ **`MIGRACIONES-RUNBOOK.md` §2.2 corregido:** `((b."scheduledFor" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Argentina/Buenos_Aires')` y `b."scheduledFor" > (now() AT TIME ZONE 'UTC')`. Va **antes** de que Martin corra los prechecks de B-pre.
2. ✅ **Este planning persistido** en `.docs/PLANES.md` (PD-02), con §14.4 y §14.8 del plan integrados en el texto. D24 queda cerrada.
3. ✅ **Referencias corregidas:**
   - ROADMAP: IDs P0-P4; `classifyBatchInstant` no se usa; `soft-delete-wholesale` lo cubre M1; "B0-S09" → S13x;
   - ARCHITECTURE: ADR-001 → "ACCEPTED enmendado, pendiente M1", sobre ADR-003;
   - CLAUDE.md: IDs P0-P4 y ES1..ES4.
4. ✅ **AUDIT:**
   - Filas nuevas con bloque y sesión dueña:
     - del planning: `plan-creation-sin-gate-basic`, `diagnosis-ejercicios-y-condicion-sin-gate`, `apply-plan-template-null-sets-reps`, `varios-planes-activos-take1`, `session-index-race-addCustomSession`, `gating-ejercicios-incluye-archivados`, `statustag-tres-paletas`, `tokens-inexistentes`, `saveDiagnosisDraft-rpc-muerta`, `ics-ignora-clinical-read`, `plan-dates-utc-host` (wizard, modal, plantilla), `updateProgram-desincroniza-total`, `hard-delete-plan-session`, `delete-service-sin-contar-planes`, `ensureTag-kind-libre`, `reception-p2002-500`, `upsert-holder-pisa-turno-de-plan`, `dashboard-session-index-crudo`, `limites-sesiones-divergentes`, `plantillas-sin-crud`, `plan-status-sin-confirm`, `hero-plan-activo-falso`, `service-duration-mayor-lookback`, `perf-baseline-se-regraba`;
     - de E0/E1 (bloque A): `getpatient-rpc-sin-gate`, `exercise-media-firmador-abierto`, `storage-policies-sin-verificar`, `listbookingsinrange-rpc-sin-clinical`, `secretaria-autoasigna-pacientes`, `secretaria-ve-hc-con-shared`, `portal-userid-unique-500`.
   - `no-realtime-agenda-compartida` reclasificada a C2.
   - Diferidos del §1.4 anotados; podados los que dejaron de serlo (Secretaria en C0, ejercicios del portal del plan, `portal-auth-por-email-no-userid`).
5. ✅ **SECURITY** registra (como planificado para ES1) el nivel `admin` y las capabilities `agenda.operateAll`, `plans.manage`, `plans.schedule` y `plans.authorize`.
6. **Pendiente:** un revisor de solo lectura verifica que este archivo no contradiga el §14 del plan (§14.8 lo pide), Martin commitea los docs y se verifica `git log -1` = commit de docs y `git status` limpio antes de ES1.

---

## 8. ES1 · P0 (= B0): fugas E0, Secretaria, fixes de planes y cimientos aditivos · **sin migración**

> **Estado:** ✅ ejecutada el 04-oct (P0.0 → P0.1 → P0.2 → P0.Z con 2 revisores y 2 fixers). Pendiente commit de Martin y QA de staging. Evidencia en AUDIT §Ronda 14; QA en [QA.md §Planes P0](QA.md).

**Prerrequisitos:** Paso 0 commiteado (y revisado); PD-01 a PD-16 firmadas el 03-oct; `npm install` hecho.

**Orden de ES1:** P0.0 (3, serial con mini-integración) → P0.1 (17) → mini-integración → **P0.2 (4, Secretaria)** → P0.Z. Son ~24 agentes en tandas de hasta 8, con 5 corriendo integración como máximo.

### P0.0 · tres en paralelo (contratos y mecánica; sin cambio de comportamiento) → mini-integración

**P0-Cs · Movimientos mecánicos** (medio)
- **Archivos:** `lib/patient-access-internal.ts`*, `lib/programs.ts`*, `lib/patients.ts`, `components/patients/profile/views/plan-view.tsx`, `components/patients/patient-profile.tsx`, `app/(app)/pacientes/[id]/page.tsx`, `tests/integration/authz-matrix.test.ts`, `tests/perf/loaders.perf.test.ts`.
- **Objetivo:**
  - mover `hcAccessError` (`patients.ts:966`) a `patient-access-internal` (server-only);
  - mover **verbatim** a `lib/programs.ts` (`"use server"`) `createProgram`, `updateProgram`, `setProgramStatus`, `deleteProgram`, `deleteSession`, `getPatientProgramsLite` y `getPatientProgramsFull`;
  - `createProgram` pasa a recibir `startDate: 'YYYY-MM-DD'` con el parse de hoy (el bug sigue; lo arregla S02a);
  - actualizar **todos** los importers (grep);
  - prop opcional `canUseTemplates` (de `gatingForActor`) en la cadena page → PatientProfile → PlanView, sin cambio visual;
  - `loaders.perf`: import nuevo + `PERF_OUT_DIR ?? "tests/perf"`.
- **Gate:** tsc en 0, unit, `authz-matrix` en los 2 roles; el diff solo muestra movimientos.

**P0-Ck · Contratos aditivos** (medio; si supera el techo, el orquestador separa las capabilities en P0-Ckc)
- **Archivos:** `lib/plan-gating.ts` (`assignableExerciseWhere`), `lib/diagnosis-types.ts` (`AssignInput.daysOfWeek?: number[]`, 0=Lun), `lib/capabilities.ts` (matriz de abajo + `canOperateBooking` y `canWriteClinical`, sin callers), `lib/booking-field-access.ts`* (`bookingFieldAccess`, C8), `lib/plans-constants.ts`* (`PLAN_KEY_PREFIX`, `PLAN_MAX_SESSIONS=60`, `PLAN_MIN_DURATION=15`, `PLAN_MAX_DURATION=240`, slugs de los tags, tipo `Discipline`), `lib/rls.ts` (`opts` aditivo, §5.1 intacto), `lib/audit.ts` (`auditInTx`), `tests/unit/capabilities.test.ts`, `tests/unit/booking-field-access.test.ts`*, `tests/unit/plan-gating.test.ts`*, `tests/integration/authz.test.ts` (actualiza el set exacto de `:55`).
- **Capabilities (E1, literal):**

  | Capability | OWNER | ADMIN | PRACTITIONER | ASSISTANT | BILLING |
  |---|---|---|---|---|---|
  | `agenda.operateAll` (positiva, sin chequeos negativos) | ✓ | ✓ | — | ✓ | — |
  | `plans.manage` | ✓ | ✓ | ✓ (con full, en la action) | — | — |
  | `plans.schedule` | ✓ | ✓ | ✓ (con full) | ✓ | — |
  | `plans.authorize` | ✓ | ✓ | ✓ (con full) | ✓ | — |

  - La matriz es `Role → Capability[]`: "con full" **no** va en la matriz, va en las actions (P2-C1, `lib/plan-authz-internal.ts`).
  - Predicados puros `canOperateBooking` y `canWriteClinical` (C8, ES1), con su unit test. S07k, S02p, S07sb, S07u y S07sp los **usan**, no los reimplementan.
  - `bookingFieldAccess({clinical, access, hasPatient}) → {title, description, notes: 'rw'|'hidden'}`, igual a la regla de lectura de `listAgendaBookings` (`lib/bookings.ts:780-784`): con paciente, los tres se ocultan sin `clinical.read` o sin full; en un turno guest, title y description se ocultan sin `clinical.read` y las notas quedan (son administrativas).
- **Tests:** la matriz por rol (incluido que BILLING no tiene ninguna de las 4), los predicados con `full`/`basic`/`none`, y `bookingFieldAccess` caso por caso.

**P0-Ct · Infra de tests** (medio)
- **Archivos:** `tests/perf/pool-pressure.perf.test.ts`, `tests/perf/agenda-multi.perf.test.ts` (`PERF_OUT_DIR`; agenda-multi sigue comparando contra el baseline versionado), `tests/perf/compare.ts`*, `tests/helpers/advisory-wait.ts`*, `tests/integration/advisory-wait.test.ts`*.
- **`compare.ts`** compara contra `tests/perf/baseline.json`:
  - `statements` y `transactions` de `createBooking.*`, `updateBooking.*` y el batch ≤ baseline;
  - `listAgendaBookings` y `listOpenSessions` ≤ +10 % de statements;
  - `wallMs` es informativo;
  - los escenarios nuevos se reportan, no fallan.

**Mini-integración P0.0:** tsc en 0, unit y `authz-matrix` en los 2 roles.

### P0.1 · 17 en paralelo (archivos disjuntos)

Tres tandas (máximo 8 agentes y 5 con integración por tanda):
- **A:** S07k, S07i, S02a, S02d, S02t (integración) + S07p, S16p, S04a.
- **B:** S02p, S02x, S02s, S07L, S02m (integración) + S02u-plan, S02u-diag, S02u-perfil.
- **C:** S04b.

**S07k · `bookings.ts`: keys, determinismo y `listBookingsInRange` sin PHI** (alto, PHI; **único dueño de `lib/bookings.ts` en P0.1**; en P0.2 lo toma S07sb)
- **Archivos:** `lib/bookings.ts`, `tests/integration/bookings-keys.test.ts`*, `tests/integration/bookings-range-clinical.test.ts`*.
- **Objetivo:**
  - `acceptClientKey` rechaza `plan:` (con `PLAN_KEY_PREFIX`), además de `pub:`;
  - `listBookingsInRange` (`:553-557`) → `programs` con `orderBy createdAt desc`;
  - **E0:** `listBookingsInRange` aplica `bookingFieldAccess` y `patientCondition` sale **solo** con `clinical.read` + full. Alternativa válida: moverla a `lib/bookings-read-internal.ts`* (server-only); los tests la importan directo y `bookings-reception.test.ts:380` sigue sin cambios.
- **No toca** ningún test existente.
- **it.fails:**
  - `[P0-S07k] createBooking con key 'plan:g:1' se rechaza y no entra a la rama update`;
  - `[P0-S07k] listBookingsInRange con 2 ACTIVE toma el más reciente`;
  - `[P0-S07k] ASSISTANT con sharedPatientView: listBookingsInRange sin title/description/notes/patientCondition`.

**S07i · Locks** (alto)
- **Archivos:** `lib/booking-cap-lock.ts` (`lockCapacityMany` en 1 sentencia + comentario corregido), `lib/plan-lock.ts`*, `tests/integration/locks-order.test.ts`*, `tests/integration/rls-audit-in-tx.test.ts`*.
- **Contrato:** C2 literal.
- **Tests (`it`):**
  - `runWithRls {timeout}` corta con P2028;
  - `auditInTx` se revierte con la tx;
  - `lockCapacityMany` = 1 statement para N claves;
  - `lockCapacityMany` desordenado ∥ `applyDayLock` "todos" ∥ `createTimeBlock` multi-día: sin 40P01 (con `advisory-wait`).

**S02a · Programas server + `getPatient`** (alto, TZ y seguridad)
- **Archivos:** `lib/programs.ts`, `lib/patients.ts` (`listPatients:172` con `orderBy`; borra `getPatient`), `lib/validation.ts` (`ProgramCreate` 1..60, frecuencia 1..7, `ProgramUpdate`), `tests/integration/programs.test.ts`*, `tests/integration/patients-rpc-surface.test.ts`*.
- **Objetivo:**
  - `createProgram` con zod y día AR;
  - `updateProgram` y `setProgramStatus` en una tx (la conducta legacy se mantiene hasta P2);
  - **E0:** borrar `getPatient` (`lib/patients.ts:647`; grep = 0 callers). Es una server action sin gate que devuelve la HC completa por RPC.
- **it.fails:**
  - `[P0-S02a] getPatient: básico/ASSISTANT no leen HC por RPC` → pasa a `it` que afirma que el export ya no existe;
  - `[P0-S02a] TZ=UTC startDate '2026-10-06' → sesión 1 el 06/10 AR, no el 05 a las 21:00`;
  - `[P0-S02a] frequency 0 → error de validación, no 500`;
  - `[P0-S02a] totalSessions 61 → rechazo`;
  - `[P0-S02a] updateProgram inválido → zod, en una tx`;
  - `[P0-S02a] listPatients con 2 ACTIVE elige el más reciente`.

**S02d · Gates de Diagnóstico** (alto, seguridad)
- **Archivos:** `lib/diagnosis.ts`, `lib/diagnosis-types.ts`, `tests/integration/plans-doors-diagnosis-authz.test.ts`*.
- **Objetivo:**
  - gate **full** dentro de la tx en `assignDiagnosisAndCreateProgram`;
  - ejercicios `assignable`;
  - condición global o del tenant;
  - dosis `?? 3/12`;
  - se respetan los días elegidos (`expandDates` weekly, a 00:00 AR);
  - tope 60;
  - se borra `saveDiagnosisDraft` (verificando que no tiene callers);
  - `:360` y `searchPatientsForAssignment` con `orderBy createdAt desc`.
- **it.fails** (con el rol owner):
  - `[P0-S02d] acceso básico no crea plan ni ClinicalCase`;
  - `[P0-S02d] ejercicio de otro tenant / PRO en FREE / archivado → rechazo`;
  - `[P0-S02d] condición por slug de otro tenant → no encontrada`;
  - `[P0-S02d] Asignar plan lun/jue → sesiones solo lun/jue AR`.

**S02t · Gates de plantillas** (alto, seguridad)
- **Archivos:** `lib/plan-templates.ts`, `lib/plan-templates-types.ts`, `tests/integration/plan-templates-authz.test.ts`*.
- **Objetivo:**
  - `applyPlanTemplate` con gate full, `TEMPLATES_PLANS`, `assignable`, dosis 3×12, tope 60 y día AR;
  - `deletePlanTemplate` solo el autor o un admin.
- **it.fails:**
  - `[P0-S02t] básico no aplica plantilla`;
  - `[P0-S02t] FREE no aplica`;
  - `[P0-S02t] plantilla con dosis null crea 3×12 (hoy crashea)`;
  - `[P0-S02t] deletePlanTemplate ajeno sin ser admin → rechazo`.

**S02p · Portal, ICS y nivel "administrativo"** (alto, PHI; **dueño de `lib/visibility.ts` en ES1**)
- **Archivos:** `lib/visibility.ts`, `lib/portal.ts`, `lib/portal-types.ts`, `lib/bookings-export-internal.ts`, `tests/integration/portal.test.ts`, `tests/integration/ics-export.test.ts`*, `tests/integration/visibility-admin.test.ts`*.
- **Objetivo:**
  - `getPortalPlan` **sin `notes`** y con el ACTIVE más reciente;
  - ICS con detalle solo según `bookingFieldAccess` (acceso full **y** `clinical.read`);
  - **nivel `admin` (E1, PD-13):**
    - un rol **sin `clinical.read`** tiene **siempre exactamente** `admin` sobre todos los pacientes del tenant (PD-13): nunca `full` aunque haya `sharedPatientView`, share o asignación, y nunca menos que `admin`. Se aplica en `patientAccessFor`, `bulkPatientAccess` y `seesAll`;
    - `admin` ve nombre, DNI, contacto, obra social y cobertura, contacto de emergencia, turnos y estado de cobro;
    - **nunca** ve diagnóstico, notas, EVA, título de planes, archivos, actividad clínica ni Seguimiento;
    - `admin` **nunca** habilita escritura clínica ni las acciones que hoy piden full (borrar turnos, cobros): para operar turnos rige `agenda.operateAll`.
- **Regla de compatibilidad del nivel nuevo:** `AccessLevel` suma `'admin'`. Todo chequeo que habilita escritura o HC tiene que ser `=== 'full'`, nunca `!== 'basic'`. S02p corre `grep -rnE "(!==|===) ?['\"](basic|full|none)['\"]" lib components app` (69 hits en 14 archivos en 3ff2e50) y deja **handoff exacto** al integrador de P0.1 por cada `!== 'basic'` fuera de sus archivos. Los tests de ASSISTANT de otras sesiones de P0.1 son post-integración. El revisor (b) de P0.Z lo re-barre.
- **C12** incluye 6 (con la enmienda `admin`), 8, 22 y 24.
- **it.fails:**
  - `[P0-S02p] getPortalPlan sin notes y determinístico`;
  - `[P0-S02p] ICS: ASSISTANT con sharedPatientView no exporta title/description/notes`;
  - `[P0-S02p] ASSISTANT con sharedPatientView → admin, sin HC`.
- **Precheck de Martin:** (16) roles ASSISTANT/BILLING × `sharedPatientView` por tenant.

**S02x · Dedupe de (programId, index)** (alto, datos de prod)
- **Archivos:** `lib/plans-dedupe.ts`* (planificador puro), `lib/plans-dedupe-internal.ts`* (server-only; `$queryRaw`/`$executeRaw` con columnas explícitas **del schema previo a M1**; `db` y `tenantIds` inyectados; una tx con `SET LOCAL row_security=off`), `scripts/plans-dedupe-session-index.ts`* (wrapper fino), `tsconfig.scripts.json`* (extends; `include` solo los scripts de Planes y `scripts/lib`), `tests/unit/plans-dedupe.test.ts`*, `tests/integration/plans-dedupe.test.ts`*.
- **Wrapper:** dry-run por defecto, `--apply`, `scripts/lib/assert-safe-target.ts`; aborta sin BYPASSRLS; imprime el mapeo viejo→nuevo.
- **Estrategia:** en cada grupo con más de una fila se conserva el id menor; las demás pasan, en id asc, a `max(index del programa)+1`, `+2`…
  - No se borra nada.
  - No se tocan `SessionExercise`, `EvaScore`, `totalSessions` ni Booking.
  - Es idempotente.
- **Tests (`it`):**
  - el dry-run no escribe;
  - dos `--apply` dan el mismo resultado;
  - otro tenant queda intacto.
- **Gate extra:** `npx tsc --noEmit -p tsconfig.scripts.json` y un dry-run contra el Docker.

**S02s · Sesiones: internos y carreras** (alto)
- **Archivos:** `lib/sessions.ts`, `lib/sessions-internal.ts`*, `lib/sessions-schemas.ts`*, `tests/integration/sessions.test.ts`.
- **Objetivo:**
  - `completeSessionInTx` y `reopenSessionIfUntouchedInTx` según C8;
  - `completeSessionFromSeguimiento` las usa **conservando** el autocompletado (cambia en P2);
  - `arDayBounds` → `lib/availability/day`;
  - `addCustomSession` con `SELECT … FOR UPDATE` del programa;
  - ejercicios `assignable`; el bulk no toca completadas;
  - `rescheduleSession` con zod y rechazo si el plan está CANCELLED o COMPLETED.
- **it.fails:**
  - `[P0-S02s] 2 addCustomSession concurrentes no duplican index`;
  - `[P0-S02s] add/substitute/bulk rechazan ejercicios archivados`;
  - `[P0-S02s] bulk no toca completadas`;
  - `[P0-S02s] reschedule en plan CANCELLED → rechazo`.

**S07p · Motor puro** (alto, TZ)
- **Archivos:** `lib/availability/plan.ts`*, `lib/availability/classify.ts` (export aditivo `patientConflictsAt`), `lib/availability/next-free.ts` (`until?`), `lib/availability/index.ts`, `lib/plan-schedule.ts`*, `tests/unit/availability-plan.test.ts`*, `tests/unit/plan-schedule.test.ts`*.
- **Contratos:** C6, C7 (tipos puros: `PlanRowFlags`, `PlanRowClassification`, resoluciones) y PD-07 literales.
- **Tests (UTC y AR):**
  - paridad con `expandDates` (documentando el 58);
  - lun 09:00 + jue 18:00 ×10;
  - cada 3 semanas;
  - mensual 31/01 → 28/02 → 31/03;
  - 60 con un día = 60;
  - pasadas marcadas;
  - dos movidas al mismo hueco → la segunda choca;
  - bloqueado no forzable;
  - superposición ≠ sobreturno;
  - la sugerencia no cruza la próxima sesión;
  - token estable;
  - dow 0=Dom ↔ 0=Lun.
- `availability-*.test.ts` y `public-slots.test.ts` **sin cambios**.

**S07L · Loader por días** (medio)
- **Archivos:** `lib/availability-loader.ts` (`loadAvailabilityInputsForDays` aditivo), `tests/integration/availability-loader-days.test.ts`*.
- **Tests:**
  - `ForDays` ≡ ventana contigua;
  - un mensual ×20 hace N queries acotadas (query-counter).

**S16p · Plata y display puros** (alto, plata)
- **Archivos:** `lib/plan-pricing.ts`*, `lib/plan-display.ts`*, `tests/unit/plan-pricing.test.ts`*, `tests/unit/plan-display.test.ts`*.
- **Contratos:** C5, P4, P7, V1, R-LEGACY y M13 literales.
- **Tests:**
  - 33.334/33.333/33.333 con Σ = total;
  - reparto en centavos;
  - total menor que lo bloqueado → error;
  - PACKAGE sin filas libres → error;
  - saldo con un cancelado cobrado;
  - cobro previo → cuota 0 y saldo coherente;
  - medianoche AR en `scheduledFor ≤ now`;
  - chip "Kine · 3/10" con aria;
  - `isOutOfPlan` con R-LEGACY y misma disciplina;
  - ordinal con huecos.

**S02u-plan · Tab plan legacy** (medio, TZ)
- **Archivos:** `plan-view.tsx`, `components/patients/plan-template-apply.tsx`, `lib/plan-form-defaults.ts`*, `tests/unit/plan-form-defaults.test.ts`*, `tests/unit/render/plan-view.test.tsx`*.
- **Objetivo:**
  - `:816` y `plan-template-apply.tsx:40` con hoy AR (`toARDateKey`); **`:346` no se toca** (C11);
  - estado con `useConfirm` y errores visibles;
  - "Eliminar" solo para admin;
  - "Aplicar plantilla" deshabilitado con aviso si `!canUseTemplates`.
- **Test:** render en TZ=UTC con el reloj a las 22:30 AR (`it.fails` del bug).

**S02u-diag · Fechas y paciente en Diagnóstico** (medio, TZ)
- **Archivos:** `components/diagnostico/assign-plan-modal.tsx`, `components/screens/diagnostico-wizard.tsx`, `tests/unit/render/diagnostico-dates.test.tsx`*.
- **Objetivo:**
  - `:55` y `:125` con hoy AR;
  - sin preselección de paciente;
  - los días viajan al server;
  - errores visibles.

**S02u-perfil · Perfil coherente** (medio)
- **Archivos:** `components/patients/patient-profile.tsx`, `profile/hero.tsx`, `profile/views/sesiones-view.tsx`, `profile/views/resumen-view.tsx`, `tests/unit/render/patient-profile-plans.test.tsx`*.
- **Objetivo:**
  - `activeProgram` = el ACTIVE más reciente + "+N";
  - el hero no dice "Plan activo" con planes terminados;
  - badge de Sesiones coherente.

**S04a · Tokens** (medio)
- **Archivos:** `app/globals.css` (`--disc-kine` y `--disc-osteo` en hex literal con contraste AA, `--lime-700`, `--navy-400`, `--st-*`), `components/ui/tag.tsx` (solo reemplaza tokens inexistentes, sin tonos nuevos), `components/ui/icons.tsx` (`IconPlans`), `components/ui/eyebrow.tsx`, `tests/unit/design-tokens.test.ts`*.

**S04b · StatusTag único** (medio)
- **Archivos:** `components/ui/status-tag.tsx`*, `components/agenda/views/list-view.tsx`, `components/agenda/booking-drawer/status-tag.tsx`, `components/patients/profile/ui.tsx`, `components/agenda/reception/reception-row.tsx`, `components/agenda/booking-drawer/billing-rows.tsx` (`formatARS`), `components/agenda/views/week-grid-view.tsx` (solo `:109`), `tests/unit/render/status-tag.test.tsx`*.
- **Contrato:**
  - StatusTag usa `var(--st-*)` **sin** agregar tonos a Tag;
  - `BookingStatusTag({status})` conserva su firma (re-export).
- **Test:** Ausente en ámbar en Lista, drawer, perfil y Recepción.

**S02m · Storage por service role y firmador de media** (alto, seguridad; E0)
- **Archivos:** `lib/storage-internal.ts`*, `lib/exercise-media-internal.ts`*, `lib/exercise-media.ts`, `lib/files.ts`, `components/plataforma/media-manager.tsx`, `app/(app)/biblioteca/[slug]/page.tsx`, `tests/integration/storage-service-role.test.ts`*.
- **Objetivo:**
  - `lib/storage-internal.ts` (server-only): admin client (`getSupabaseAdminClient`) para upload, sign y remove, chequeando `{error}` en cada llamada;
  - `lib/exercise-media-internal.ts` (server-only): `signExerciseMedia(mediaId)` carga la fila y firma su clave. **Nada firma una clave que mande el cliente**;
  - `lib/exercise-media.ts` deja de exportar firmadores (`resolveMediaUrl` desaparece); sus callers (`media-manager.tsx`, `biblioteca/[slug]/page.tsx`) reciben URLs firmadas del server o piden por `mediaId` a una action con gate de superadmin;
  - `lib/files.ts` pasa a service role, con los gates de hoy intactos.
- **Tests (red mockeada, C14):** `lib/exercise-media.ts` no exporta ningún firmador; `signExerciseMedia` de un id inexistente → null; el admin client falla cerrado sin la env; un `{error}` de Supabase se propaga como error controlado.
- **Prechecks de Martin:** (17) `storage.buckets` privados y ninguna policy de `storage.objects` para anon o authenticated. Si hay, se sacan **en el mismo deploy** en que el código pasa a service role.

### P0.2 · Secretaria (E1) · 4 en paralelo (después de la mini-integración de P0.1)

Una tanda: S07sb, S07sp (integración) + S07u, S07v. Contratos literales en el prompt: E1 completo (matriz de P0-Ck, `canOperateBooking`, `canWriteClinical`, `bookingFieldAccess`, nivel `admin`), C12 (6, 7, 35).

**S07sb · Secretaria en turnos** (alto, seguridad; **único dueño de `lib/bookings.ts` y `lib/bookings-types.ts` en P0.2**)
- **Archivos:** `lib/bookings.ts`, `lib/bookings-types.ts` (`AgendaBookingRow.canOperate` y `clinicalWritable`, calculados en el server), `tests/integration/authz-matrix.test.ts`, `tests/integration/bookings-secretaria.test.ts`*.
- **Objetivo:**
  - gate en create, batch, update, status y cancelación: `canOperateBooking(caps, access)` = `full || agenda.operateAll` (un turno guest sigue operable);
  - `bookingFieldAccess` saca los campos no permitidos **antes** del write y del audit; `listAgendaBookings` lee con el mismo helper;
  - el `copagoCents` de un actor sin full se ignora y rige la precedencia de `lib/copago.ts`;
  - re-vínculo sin `clinical.read`: guest → paciente se permite; paciente → paciente solo si título, descripción y notas (sin `[SOBRETURNO]`) están vacíos; si no, *"Este turno tiene datos clínicos: pedile al profesional que lo cambie"*. El paciente destino se valida con el mismo gate, no con `hasFullAccess`;
  - `deleteBooking` y los toggles de cobro quedan como hoy (sin full no se puede) → matriz de cobros en C0;
  - columna ASSISTANT de `authz-matrix`.
- **it.fails / it:**
  - `[P0-S07sb] ASSISTANT con acceso básico reprograma, cambia estado y cancela`;
  - `[P0-S07sb] un guest con título oculto no se pisa`;
  - `[P0-S07sb] re-vínculo con notas → rechazo`;
  - `[P0-S07sb] copago de ASSISTANT ignorado`;
  - `[P0-S07sb] PRACTITIONER básico sigue rechazado; BILLING rechazado` (create, batch, update, status, cancel);
  - `[P0-S07sb] ASSISTANT no borra ni marca cobros`.

**S07sp · Secretaria en pacientes** (alto, seguridad; **dueño de `lib/patients.ts` y `lib/validation.ts` en P0.2**)
- **Archivos:** `lib/patients.ts` (`createPatient`, la proyección `admin` de `getPatientCore`, `setPatientDiagnosis` con `clinical.read`), `lib/validation.ts` (`PatientCreate`), `tests/integration/patients-secretaria.test.ts`*.
- **Objetivo:**
  - `createPatient(raw, opts?: {assignTo})`. Sin `clinical.read` exige `agenda.operateAll` (BILLING no crea) y `assignTo` = el profesional del turno, validado en la tx: del tenant, con membresía aceptada en un rol clínico y distinto del actor. Ignora notas y diagnóstico. **Hoy el paciente queda asignado a quien lo crea** (`:747`): la Secretaria se queda con acceso full y el kine en básico;
  - `getPatientCore` devuelve la proyección `admin` (§S02p) sin campos clínicos;
  - `setPatientDiagnosis` exige `canWriteClinical`.
- **it.fails:**
  - `[P0-S07sp] alta desde el modal por ASSISTANT → paciente a cargo del profesional del turno; ASSISTANT sigue sin HC y el diagnóstico se ignora`;
  - `[P0-S07sp] BILLING no crea pacientes`;
  - `[P0-S07sp] assignTo de otro tenant → rechazo` (rol owner);
  - `[P0-S07sp] setPatientDiagnosis por ASSISTANT → rechazo y diagnóstico intacto`.
- **Precheck de Martin:** (15) pacientes asignados a ASSISTANT/BILLING → reasignarlos con `assignPatientToPractitioner` antes del deploy.

**S07u · Drawer y modal** (medio)
- **Archivos:** `components/agenda/agenda-client.tsx` (una línea: `capabilities` al drawer), `components/agenda/agenda-utils.ts` y `components/agenda/booking-drawer/types.ts` (`canOperate`/`clinicalWritable` opcionales), `booking-drawer/index.tsx`, `booking-drawer/edit-details-form.tsx`, `booking-drawer/status-actions.tsx`, `booking-drawer/reschedule-form.tsx`, `booking-drawer/recent-bookings.tsx`, `components/agenda/booking-modal/index.tsx`, `tests/unit/render/booking-drawer-secretaria.test.tsx`*.
- **Contrato:**
  - operar (reprogramar, estado, cancelar) = `canOperate`;
  - título, descripción, notas, "Usar como diagnóstico" y "últimos turnos" = `clinicalWritable`. Hoy, con los campos ocultos, "Usar como diagnóstico" **borra** el diagnóstico;
  - eliminar y cobros = la regla de hoy (`patientAccess !== 'basic'`, que con el nivel `admin` pasa a `=== 'full'`);
  - en el modal se ocultan título y descripción sin `clinical.read`, y las notas solo cuando hay paciente elegido;
  - el `assignTo` del modal (profesional del turno) va como **handoff exacto** al integrador de P0.2: compila recién con S07sp.
- **Test:** la Secretaria ve Reprogramar, Estado y Cancelar, y no ve Eliminar, cobros ni campos clínicos; un PRACTITIONER básico no ve nada operable.
- Queda disjunto de S04b (`status-tag.tsx` y `billing-rows.tsx` no se tocan).

**S07v · Perfil administrativo** (medio)
- **Archivos:** `components/patients/patient-profile.tsx`, `components/patients/profile/hero.tsx`, `components/patients/profile/tabs-bar.tsx`, `app/(app)/pacientes/[id]/page.tsx`, `tests/unit/render/patient-profile-admin.test.tsx`*.
- **Objetivo:** para `admin`, el perfil muestra solo datos y turnos, sin pestañas clínicas (Evolución, Plan, Seguimiento, archivos, actividad clínica).

**Mini-integración P0.2:** handoffs (incluido el `assignTo` de S07u), tsc en 0, unit, `authz-matrix` y las suites de la Secretaria en los 2 roles.

### P0.Z · Cierre de ES1

1. Integrador: handoffs y tsc en 0.
2. **2 revisores de solo lectura del diff real:**
   - (a) locks, dedupe, sesiones y TZ;
   - (b) gates de seguridad, PHI de portal e ICS, plantillas y Diagnóstico, **más E0/E1**: barre **todas** las exports de `lib/patients.ts`, `bookings.ts`, `sessions.ts`, `diagnosis.ts`, `portal.ts` y `exercise-media.ts` que leen Patient, Booking o Session y verifica que cada una tenga gate; re-barre los `!== 'basic'`; gate de la Secretaria y campos clínicos en create, batch, update y la UI; Storage por service role.
3. Fixer.
4. Gate de ES (§14).
5. Docs (orquestador): AUDIT cierra los slugs de ES1 (incluidos los de E0/E1) y asienta la enmienda de §5.6 (nivel `admin`) y §5.35 (`agenda.operateAll`); SECURITY §13 pasa de "planificado" a vigente; QA "Planes P0"; ROADMAP.
6. Memoria.
7. Comando de commit (antes, verificar `git status --porcelain`):

```
git add -A && git commit -m "Planes P0 (ES1): sin migración — fugas E0 cerradas (getPatient borrada, firmador de media y Storage por service role, listBookingsInRange sin PHI); Secretaria: opera todos los turnos sin campos clínicos, nivel administrativo sin HC, alta de paciente a cargo del profesional; createProgram/Diagnóstico/plantillas en día AR y con gate full, ejercicios asignables, dosis 3x12, portal e ICS sin PHI, plan activo determinístico, carrera de sesión a medida, StatusTag único; cimientos sin callers: motor y plata puros, loader por días, locks ordenados, auditInTx, dedupe de sesiones (dry-run)"
```

**QA de staging** (TZ=UTC):
- agenda completa de QA.md §B-pre (no cambió);
- plan a las 22:30 AR → sesión 1 hoy;
- Diagnóstico lun/jue;
- plantilla sin dosis → 3×12;
- básico no crea;
- doble click en "Sesión a medida" → una sola;
- ICS de la Secretaria sin notas;
- Ausente en ámbar;
- la Secretaria reprograma, cancela y crea un turno de un paciente en básico, sin ver ni pisar los campos clínicos;
- la Secretaria da de alta un paciente desde el modal → queda a cargo del profesional del turno;
- con "Consultorio común", la Secretaria ve el perfil administrativo, sin pestañas clínicas;
- "Usar como diagnóstico" no aparece para la Secretaria.

**Deploy:** ninguno (decisión del 04-oct: nada se despliega hasta cerrar B). Ver "Abierto para Martin" (1) sobre las fugas E0. ES2a se ejecutó a continuación (04-oct, §9).

**Durante ES1**, Martin corre los prechecks (0)-(17), que son de solo lectura, y, si (2) > 0, el dedupe en dry-run. Si (15) > 0, reasigna esos pacientes antes del deploy final.

---

## 9. ES2a · P1 (= B1): M1 sola · corrida corta · **1 migración**

> **Estado (04-oct): ejecutada en develop, pendiente commit de Martin.** S10a/b/c + P1.Z hechos. M1 aplicada solo en el
> Docker local. Enmiendas: F1 (C1, CHECK de pricing con `IS NOT DISTINCT FROM`) y F2 (el dedupe ignora sesiones
> archivadas si existe `archivedAt`); el comentario del `DROP INDEX` en el SQL se corrigió (ACCESS EXCLUSIVE sobre
> Patient, también lecturas, hasta el COMMIT). Tests: `tests/helpers/plan-factory.ts`, `plans-m1-schema`,
> `plans-m1-backfill`, `plans-m1-new-tables`, bloque M1 de `rls-isolation` y `plans-dedupe` convertido. Gate y
> evidencia: AUDIT §Ronda 15. RUNBOOK §2.4 cubre el deploy.

**Prerrequisitos:**
- commit de ES1 = `git log -1`, working tree limpio;
- PD-03, PD-04, PD-05 y PD-14 firmadas (03-oct);
- prechecks (1)-(4) y (11) en verde; (2) en 0, o el dedupe planificado para staging y prod antes del deploy final (que lleva M1).

**S10 · M1 `plans_booking_link`** (alto; `migration: true`)
- **Archivos:** `prisma/migrations/<ts>_plans_booking_link/migration.sql`*, `prisma/schema.prisma`, `tests/integration/plans-m1-schema.test.ts`*, `tests/integration/plans-m1-backfill.test.ts`*, `tests/integration/plans-m1-new-tables.test.ts`*, `tests/integration/rls-isolation.test.ts`, `tests/helpers/tenant-factory.ts` (`deleteTenantDeep` borra `ProgramAuthorization` y `PatientChangeRequest` antes que TreatmentProgram/Patient), `tests/helpers/plan-factory.ts`*, `tests/integration/plans-dedupe.test.ts`.
- **plan-factory:** planes, sesiones y turnos vinculados, más un **fixture legacy** (`totalSessions` ≠ filas, 00:00Z, sin `practitionerId`), todo por insert directo.
- **Secuencia obligatoria:**
  1. Escribir `migration.sql` (C1 literal).
  2. `npx dotenv -e .env.local -- npx prisma migrate deploy`, **sin** tocar todavía `schema.prisma`.
  3. Correr **toda** la integración en los 2 roles con el **cliente Prisma viejo** (reproduce el expand-first de prod).
  4. Recién ahí: `schema.prisma` + `npx prisma generate` + los tests nuevos.
  5. Convertir `plans-dedupe.test.ts`: con M1 aplicada no puede haber duplicados vivos, así que el dry-run reporta 0 y no escribe. El apply con duplicados quedó probado en ES1 y en el unit del planificador.
- **Tests:**
  - cada objeto existe con su nombre (`pg_constraint`, `pg_indexes` con el `indexdef` literal de los 2 parciales, `information_schema`, `pg_type`);
  - cada CHECK rechaza su caso (incluida la duración 14 y 241);
  - las FKs compuestas rechazan, **con el rol owner**: sesión de otro plan, paciente distinto y plan de otro tenant;
  - 2 activos en la misma sesión → P2002; CANCELLED + NO_SHOW + 1 activo → ok;
  - con la sesión archivada se puede repetir el index;
  - RESTRICT al borrar una Session con turno;
  - la misma `idempotencyKey` en 2 tenants → ok; en el mismo tenant → P2002;
  - backfill: 2 corridas dan lo mismo, sin bypass falla fuerte, un Practitioner de otro tenant no se toma;
  - los tags existen una sola vez;
  - `Booking.updatedAt` intacto;
  - `deleteTenantDeep` sigue limpiando;
  - `relforcerowsecurity` sin cambios en las tablas viejas.
- **Tablas nuevas e identidad (E4.2):**
  - **ProgramAuthorization:** `authorizedSessions` 0 y 201 → 23514, 1 y 200 pasan; `code` vacío → 23514; `expiresOn < startsOn` → 23514; 2 vigentes del mismo plan → P2002, una vigente y otra superseded pasan; FK compuesta con el rol owner: `programId` de otro tenant → 23503; borrar un plan con autorización → RESTRICT.
  - **PatientChangeRequest:** `changes` con array, `'null'::jsonb`, escalar o más de 4 KB → 23514; 2 PENDING del mismo paciente → P2002, PENDING + APPROVED pasa; `tenantId` distinto del del paciente con el rol owner → 23503; `PatientChangeRequest_decided_check` (PENDING con `decidedAt`, o APPROVED sin `decidedAt` → 23514).
  - **RLS de las 2 tablas:** `rls-isolation.test.ts` con el rol `kinesoft_app` (B no lee ni escribe lo de A); `relrowsecurity` y `relforcerowsecurity` en true; una policy por tabla.
  - **Patient:** `Patient.updatedAt` intacto después de M1 (igual que el test de Booking); el mismo `userId` en 2 tenants pasa y en el mismo tenant da P2002; `Patient_userId_key` ya no existe.
  - **`Prisma.DbNull`:** `Prisma.JsonNull` en `TreatmentProgram.schedule` → 23514; `Prisma.DbNull` pasa.
  - Todo corre también en el paso 3 de la secuencia, con el cliente viejo sobre el schema nuevo.
- El test del backfill lee el bloque con `/^-- >>> BACKFILL plans_booking_link BEGIN$/m`.

**P1.Z · Cierre de ES2a:**
1. **Revisor de solo lectura (P1-R):**
   - SQL contra C1 literal;
   - nombres `map:` del schema;
   - `npx dotenv -e .env.local -- npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`: solo debe mostrar el drift aceptado de §3 (en la práctica, las 3 FKs compuestas de Booking);
   - `npm run guard:isolation` reconoce las 2 tablas nuevas;
   - guard del backfill, `lock_timeout`, down-script (con la recreación condicional de `Patient_userId_key`) y RUNBOOK.
2. Fixer.
3. **Gate P1 en solitario:**
   - `migrate deploy` + `migrate status`;
   - objetos uno por uno;
   - integración completa en los 2 roles;
   - unit UTC y AR;
   - tsc y `tsc -p tsconfig.scripts.json`;
   - guard;
   - **`npx next build`**;
   - perf (`PERF_OUT_DIR` + `compare.ts`, porque cambian los índices de Booking);
   - `git status --porcelain` igual a la lista esperada.
4. Docs: ADR-001 → ACCEPTED (enmendado, M1 escrita); RUNBOOK §"Deploy de M1" (prechecks, P3009, down-script y post-checks, incluidos los de RLS de las 2 tablas); AUDIT cierra `session-index-no-unique-constraint` y deja `portal-userid-unique-500` en 🟡 (índice listo; el flujo lo cierra S24a).
5. **Aviso explícito a Martin: hay 1 migración nueva.**
6. Commit 2a:

```
git add -A && git commit -m "Planes P1 (ES2a): migración plans_booking_link (sola): FK turno↔plan/sesión + FKs compuestas, únicos parciales, precio por sesión/paquete, disciplina, responsable (backfill), archivar, idempotencia por tenant, tags DISCIPLINE + autorización de la OS (ProgramAuthorization) + pedidos de cambio del portal (PatientChangeRequest), ambas con RLS + Patient.userId único por consultorio (DROP INDEX Patient_userId_key aprobado)"
```

---

## 10. ES2b · P2 (= B2): core de turnos + dominio server · sin migración nueva

### Enmiendas EV0/SV (07-oct, se copian literal en los prompts)

> Fuente: plan vigente §15.5 = [VERTICALES.md §5](VERTICALES.md). Mandan sobre el texto de las sesiones de abajo donde choquen. Cada línea va **tal cual** en el prompt de la sesión que nombra.

- **Verticales:**
  - **P2-C1**: `assertPlanManageInTx`/`assertPlanScheduleInTx`/`assertPlanAuthorizeInTx` arrancan con `assertModule(actor,'planes')`; `plan-authz.test.ts` suma "tenant GENERAL (OWNER) → Forbidden".
  - **S13**: disciplina del servicio solo con `planes` (UI y server).
  - **S13x**: `createExercise`/`ensureTag` exigen `gate.canCreate` (**ya hecho en EV0 V.Z, N2: S13x lo preserva**); claves de `unstable_cache` con `gate.catalogScope` (`lib/exercises.ts`, `lib/diagnosis.ts`).
  - **S14**: sin `planes`, `getDashboardData` no consulta planes/sesiones y devuelve 0.
  - **S12b**: cada export de `lib/sessions.ts` exige `sesiones` (`listOpenSessions` vacío sin el módulo).
  - **S17d**: `loadCatalog` (vacío), `getDiagnosisPlanPrefill`, `createPlanFromDiagnosis` exigen `diagnostico`.
  - **S17d** (revisión EV0): `searchPatientsForAssignment` (`lib/diagnosis.ts`) exige `diagnostico` (`[]` sin el módulo).
  - **S14** (revisión EV0): `getSessionsChart` sin `sesiones` devuelve 0 sin consultar. La clave de `unstable_cache` del dashboard no lleva los módulos: S14 se apoya en el tag `tenantEntitlementTags(tenantId)` (lo revalida el escritor único) para no servir un slot viejo tras un cambio de vertical.
  - **S15 / S27a** (revisión EV0): los exports de `lib/programs.ts` que sobrevivan mantienen `requireModule('planes')` (escrituras) y `[]` sin el módulo (lecturas); mover o retirar código no se lleva el gate.
  - **P2.Z(b)**: el revisor verifica que ningún export de Planes/Sesiones/Diagnóstico/Ejercicios quede sin gate de módulo.
- **Realtime (para que SV no toque archivos de planes):**
  - **P2-C1** suma `lib/booking-events-internal.ts`* (server-only, firma congelada): `BookingChangeRef = {bookingId, practitionerId, scheduledFor, prev?, kind?}` y `afterBookingsCommitted(tenantId, refs, opts?)`; hoy solo hace lo de `invalidateBookingDerivedCaches` y nunca tira; SV le suma el publish sin cambiar la firma.
  - **S07c**: `invalidateBookingDerivedCaches` → `afterBookingsCommitted(actor.tenantId, refs)` en cada write-path de `bookings.ts`, después del commit y fuera de `runWithRls`; `BookingUpdateTxOutcome.ok` suma `refs`.
  - **S12, S11e, S12b, S15, S16a, S16b, S25a, S17d**: todo write-path que crea, mueve, cambia estado/cobro, cancela o borra un `Booking` llama `afterBookingsCommitted` una vez después del commit; los `*InTx` **devuelven** refs y nunca emiten adentro.
- **Reset de prod (§15.6):** S25a **se mantiene** (adopción de turnos sueltos, útil con datos nuevos). R-LEGACY se deja como está. Se cae el dedupe en staging/prod (no hay datos que deduplicar).

**Prerrequisitos:** commit 2a = `git log -1`, working tree limpio; PD-09, PD-10 y PD-16 firmadas (03-oct); PQ-02, PQ-06, PQ-09, PQ-12 y PQ-15 con respuesta o default.

### P2.0.0 · P2-C1 · Contratos (serial, medio)

- **Archivos:** `lib/plans-types.ts`* (C7; **re-exporta** los tipos puros de `@/lib/availability/plan`, publicados por S07p en ES1: no los redefine), `lib/plans-schemas.ts`* (zod de C6 y C7, incluida la autorización: `code` `trim().max(64)`, `authorizedSessions` 1..200 espejo del CHECK, `startsOnDayKey`, `expiresOnDayKey?` ≥ inicio), `lib/plan-predicates.ts`*, `lib/plan-authz-internal.ts`* (server-only), `lib/bookings-types.ts` (C9 en `AgendaBookingRow`), `lib/agenda-plan-projection-internal.ts`* (stub con la firma congelada), `lib/plan-invariants-internal.ts`* (stub con la firma congelada), `tests/unit/plans-schemas.test.ts`*, `tests/integration/plan-authz.test.ts`*.
- **`lib/plan-authz-internal.ts` (E1, literal de §5):** `assertPlanManageInTx(tx, actor, caps, patientId)`, `assertPlanScheduleInTx(tx, actor, caps, patientId)`, `assertPlanAuthorizeInTx(tx, actor, caps, patientId)` y `planTitleFor(caps, access, title)`. S14, S11e, S12, S16a, S16b y S25a **solo consumen**. Test: matriz rol × acción × acceso con el rol owner.
- **Predicados de `plan-predicates`:** `liveSessionWhere`, `sessionWithoutActiveBookingWhere`, `linkedProgramWhere` (R-LEGACY), `liveProgramWhere`, `adoptableBookingWhere({tenantId, patientId})` = `{programId:null, sessionId:null, status in [PENDING,CONFIRMED,COMPLETED]}` sin reserva pública impaga, y `bookingHasPaymentWhere` (criterio canónico).

### P2.0 · 5 en paralelo (todas corren integración)

**S07c · Core de turnos server-only** (alto; **único dueño de `bookings.ts`, `bookings-core.ts` y `bookings-constants.ts` en P2.0**)
- **Archivos:** `lib/bookings.ts`, `lib/bookings-core.ts`*, `lib/bookings-constants.ts`*, `tests/integration/bookings-core.test.ts`*.
- **Objetivo** (se cita por **símbolo**, no por línea: ES1 movió los rangos de 3ff2e50):
  - extraer sin cambiar comportamiento los helpers puros y de tx que hoy están arriba de `createBooking` y el cuerpo de la tx de `updateBooking`;
  - `validateBookingRefsInTx` deduplica la validación de refs de `createBooking` y `createBookingsBatch`;
  - C8 con la firma corregida y el **contrato Secretaria** (el gate `canOperateBooking` y `bookingFieldAccess` viven dentro de `applyBookingUpdateInTx`);
  - **swap atómico**.
- **No modifica ningún test existente.** `bookings-*` (incluido `bookings-secretaria.test.ts` de ES1), `day-lock`, `patient-coverage` y `authz-matrix` tienen que pasar sin cambios: esa es la prueba de paridad.
- **Preservar** el gate `canOperateBooking` de ES1 dentro de `applyBookingUpdateInTx`, el helper `hasFullAccess` para borrar y cobrar, y el filtrado de campos antes del audit.
- **Test (`it`):** `applyBookingUpdateInTx` da el mismo outcome que `updateBooking` (stale, patient-slot, fuera de horario, cupo).

**S13 · Servicios: disciplina + guarda** (medio)
- **Archivos:** `lib/services.ts`, `lib/services-types.ts`, `lib/services-discipline.ts`* (puro; solo lee el catálogo, §5.31), `lib/validation.ts`, `components/configuracion/panels/services-panel.tsx` (también el copy falso de `:232`), `tests/unit/services-discipline.test.ts`*, `tests/integration/plan-refs-guards-services.test.ts`*.
- **it.fails:** `[P2-S13] deleteService con planes o plantillas → mensaje claro, no P2003`.

**S13g · Guardas de sede y miembro** (medio)
- **Archivos:** `lib/locations.ts`, `lib/invitations.ts`, `tests/integration/plan-refs-guards-members.test.ts`*.
- **Tests:** `archiveLocation` con planes ACTIVE y `removeMember` responsable de planes ACTIVE → mensaje claro.

**S13x · Ejercicios por disciplina + `ensureTag`** (medio, seguridad)
- **Archivos:** `lib/exercises.ts`, `lib/exercises-types.ts`, `tests/integration/exercises-discipline.test.ts`*.
- **Objetivo:**
  - `listExercises({disciplineSlug})` = los ejercicios con ese slug **o** sin ninguno de los dos slugs de disciplina; si el tag no existe, no filtra;
  - `ensureTag`: allowlist de kinds (los que usa la UI, **sin** DISCIPLINE) y slugs `kinesiologia`/`osteopatia` reservados;
  - lo mismo en los tags que crea `createExercise` (`:268-275`).
- **it.fails:** `[P2-S13x] ensureTag('Kinesiología','DISCIPLINE') → rechazo`.

**S14 · Lecturas de Planes + dashboard** (alto)
- **Archivos:** `lib/plans-read.ts`*, `lib/plans-read-internal.ts`*, `lib/plans-read-types.ts`*, `lib/dashboard.ts`, `tests/integration/plans-read.test.ts`*, `tests/integration/dashboard-plans.test.ts`*.
- **Lecturas nuevas:** `listPlans`, `getPlanDetail`, `getPatientPlans`, `getPatientPlanBalances`, `getPlanHistory` y **`listSchedulablePlanSessions({patientId})`**.
- **Reglas:** gate de lecturas de §5 (vía `plan-authz-internal`), "sin turno" derivado, R-LEGACY, ordinal, título oculto sin `clinical.read` (`planTitleFor`), cross-tenant con el rol owner, saldo P7 agregado en el server.
- **`listSchedulablePlanSessions`:** gate `plans.schedule` + (full **o** `agenda.operateAll`). Allowlist: `{sessionId, ordinal, totalLive, discipline, serviceId, practitionerId, locationId, sinTurno}`. **Sin** títulos, notas, ejercicios ni precios.
- **Autorización de la OS (E2):** `getPlanDetail` y `getPatientPlans` devuelven la vigente (`code`, `authorizedSessions`, `startsOn`, `expiresOn`), **usadas** (realizadas con fecha AR ≥ `startsOn`) y **agendadas**, solo para `(full && clinical.read) || plans.authorize || billing.manage`. Fechas con `dbDateToDayKey`. El aviso "autorización por vencer" en `lib/dashboard.ts` es opcional (si no entra, C1).
- **Dashboard:** `liveProgramWhere`, ordinal en lugar de `s.index`, título y condición nulos sin `clinical.read`.
- **it.fails:** `[P2-S14] dashboard muestra s.index crudo`.
- **Tests (`it`):** ASSISTANT pide `getPlanDetail` → Forbidden; ASSISTANT pide `listSchedulablePlanSessions` → sin título ni notas; la autorización no sale para un PRACTITIONER básico; vencimiento 30/11 leído en TZ=UTC → 30/11.

**Mini-integración P2.0:** tsc en 0 y la integración del área en los 2 roles.

### P2.1 · 4 en paralelo

**S11e · Motor: preview + commit** (alto)
- **Archivos:** `lib/plans-load-internal.ts`*, `lib/plans-engine-internal.ts`*, `lib/plans.ts`* (`previewPlan`, `createPlan`), `tests/integration/plans-create.test.ts`*.
- **Consume:** C2, C3, C5, C6, C7, C8 y las piezas de ES1 y P2.0.
- **Advertencia del loader por días (S07L × S07p, literal en el prompt):** `loadAvailabilityInputsForDays` trae datos **solo de los `days` pedidos** y el motor no mira `from/to`. `suggestRowSlot` busca hasta el día previo a la próxima sesión, y en la última fila hasta el horizonte de `nextFreeSlot`. Por eso S11e tiene que **cargar todos los días donde puede caer una sugerencia** (todos los días entre filas y el horizonte de la última) **o acotar `nextFreeSlot` con `until`** dentro de lo cargado. Si no, salen sugerencias "libres" falsas.
- **Requisitos de `PlanAvailabilityBooking` (literal):** requiere `updatedAt`, `programId` y `sessionId` (si faltan, el turno no es adoptable); `resolutionOk`/`staleReason` → `reclassifyOrThrowStaleInTx`; sobreturno → `isOverbooked`; el preview usa `plannedAt` y `at` = instante efectivo.
- **Publica:** C8 "P2.1 publica" (incluidas `previewProgramRowsInTx` y `reclassifyOrThrowStaleInTx`).
- **Implementa:**
  - la resolución `adopt` genérica (CAS con `adoptableBookingWhere`);
  - `priorPaid`;
  - la duración efectiva;
  - **autorización de la OS (E2):** `createPlan` persiste `authorization?` como la primera fila de `ProgramAuthorization` en la misma tx (con `assertPlanManageInTx`; la carga sola de autorización es S16b) y le pasa `PlanAuthorizationInput` al clasificador para las flags de aviso;
  - gates por `plan-authz-internal` (crear = `plans.manage`; `generate` = `plans.schedule`), y títulos redactados en el preview sin `clinical.read`.
- **Tests (`it`):**
  - 10 sesiones lun/jue en TZ=UTC → fechas AR correctas, vínculo y keys `plan:`;
  - `isPublicReservation(planKey) === false`;
  - misma key ×2 → 1 plan;
  - bloqueado nunca se fuerza;
  - stale por resolución faltante y por un adoptado que cambió;
  - PACKAGE 100.000/3 con espejo y Σ;
  - sin precio → null/false;
  - ids de otro tenant (servicio, profesional, sede, plantilla, ejercicio) → rechazo con el rol owner;
  - básico, PS deshabilitada o membresía no aceptada → rechazo; PRIVATE → ok;
  - servicio de 300 min → *"La duración supera 4 h"*;
  - pasadas → sin turno;
  - audit dentro de la tx;
  - ≤ 60 statements para 20 filas;
  - autorización: round-trip de `createPlan` con autorización; `overAuthorization` en la fila 11 de 10 autorizadas; `afterAuthorizationExpiry` comparando dayKeys AR en TZ=UTC.
- **Post-integración:** la corrida contra el verificador real (S11v) y el core con la sincronía (S12).

**S11v · Verificador** (alto)
- **Archivos:** `lib/plan-invariants-internal.ts`, `tests/integration/plan-invariants.test.ts`*.
- **Objetivo:** I1-I8 con R-LEGACY; evento a Sentry con el diff; usa el fixture legacy de `plan-factory`.

**S12 · Sincronía lado turno** (alto; **único dueño de `bookings.ts`, `bookings-core.ts`, `bookings-types.ts` y `bookings-constants.ts` en P2.1**)
- **Archivos:** `lib/bookings.ts`, `lib/bookings-core.ts`, `lib/bookings-types.ts`, `lib/bookings-constants.ts`, `tests/integration/plans-sync-bookings.test.ts`*.
- **Objetivo:**
  - todas las filas "turno" de C4: write-through I3, COMPLETED/Atendido, salir de COMPLETED, reactivación, P2002 en el core **y** en `markReceptionAction`, rechazos (paciente, borrar, cancelar con cobro, sacar);
  - Ausente con cobro;
  - holder del upsert con `programId`;
  - `PROGRAM_NEARING_DISCHARGE` post-commit;
  - Q8;
  - cableado de una línea de `loadAgendaPlanProjection` en `listAgendaBookings`.
- **Regla:** en `bookings-core` solo **agrega**; swap atómico. Preserva el contrato Secretaria de C8 (gate y `bookingFieldAccess` dentro del core) y consume `plan-authz-internal` donde hace falta.
- **Tests (`it`):** una fila de C4 por test, más:
  - "reactivar tras reprecio re-estampa";
  - "reactivar con sesión archivada → rechazo";
  - "COMPLETED→NO_SHOW reabre la sesión";
  - "deshacer Ausente con otro activo da mensaje y no 500";
  - "reintento de alta sobre un turno adoptado no lo modifica";
  - "turno suelto: paridad".

**S12p · Proyección de agenda** (medio)
- **Archivos:** `lib/agenda-plan-projection-internal.ts`, `tests/integration/agenda-plan-projection.test.ts`*.
- **Objetivo:**
  - C9 con queries planas;
  - ASSISTANT y básico reciben `plan.title` null;
  - "Fuera de plan" (V2) con R-LEGACY;
  - el payload no crece más de +5 %.

**Mini-integración P2.1:** integrador, tsc en 0, integración del área en los 2 roles + los tests post-integración de S11e.

### P2.2.0 · P2-C2 · Contratos (serial, medio)

- **Archivos:** `lib/plans-edit-types.ts`* (inputs y resultados de lifecycle, move, edit y adopt, incluidos `GeneratePlanBookingsInput.sessionIds?: string[]` y `RenewAuthorizationInput = {programId, expectedCurrentId: string|null, code?, authorizedSessions?, startsOnDayKey, expiresOnDayKey?}`), `lib/sessions-types.ts` (`OpenSessionBuckets` + `sinTurno?`, `realizadasSinEvolucion?`, `suggestDischarge?` **opcionales**), `lib/plans-lifecycle-state.ts`* (tabla pura de transiciones), `tests/unit/plans-lifecycle-state.test.ts`*.
- **Transiciones:**
  - ACTIVE → PAUSED | CANCELLED | COMPLETED;
  - PAUSED → ACTIVE | CANCELLED;
  - COMPLETED → ACTIVE (con confirmación);
  - CANCELLED es terminal.

### P2.2 · 7 en paralelo (tandas de 5 + 2 por la integración)

**S12b · Sincronía lado sesión** (alto)
- **Archivos:** `lib/sessions.ts`, `lib/sessions-internal.ts`, `lib/sessions-schemas.ts`, `tests/integration/sessions.test.ts`, `tests/integration/plans-sync-sessions.test.ts`*.
- **Objetivo:**
  - cerrar en Seguimiento: Booking `FOR UPDATE` → claim → CAS del turno a COMPLETED;
  - `rescheduleSession` vinculado por el core (L5);
  - D22: sugerir el alta, sin autocompletar (cambia la expectativa del test de A2);
  - buckets "Sin turno" (R-LEGACY) y "Realizadas sin evolución";
  - I5 sobre sesiones vivas y ordinal;
  - `EvaScore.sessionId` + `note`;
  - "Cargar evolución" sobre una sesión realizada;
  - `reopenSessionIfUntouchedInTx` con el chequeo de EVA;
  - `listAssignablePrograms` y `bulkAddSessionExercises` con `liveProgramWhere`/`liveSessionWhere`.
- `addCustomSession` **no se toca**.
- **Tests:**
  - `[P2-S12b] cerrar en Seguimiento completa el turno`;
  - `Atendido ∥ Cerrar sin deadlock`;
  - `reschedule vinculado mueve ambos`;
  - `la sesión 10/10 no completa el plan`;
  - `Sin turno excluye legacy y archivadas`;
  - `listAssignablePrograms excluye archivados`.

**S15 · Ciclo de vida** (alto)
- **Archivos:** `lib/plans-lifecycle.ts`*, `lib/plans-lifecycle-internal.ts`*, `lib/programs.ts`, `lib/patients.ts`, `tests/integration/plans-lifecycle.test.ts`*, `tests/integration/programs.test.ts`.
- **Objetivo:**
  - transiciones con `lockPlanPatient` y D7 (`cancelBookingsInTx` o "mantener") + CAS;
  - archivar el plan (solo CANCELLED/COMPLETED, o la transición en la misma tx);
  - `restoreProgram` (OWNER/ADMIN);
  - `deleteProgram` → archivar;
  - `setProgramStatus` delega;
  - `deleteSession` → error *"Archivala"*;
  - **`updateProgram` solo título y notas, con CAS**;
  - **L9:** `setPatientArchived`/`bulkArchivePatients` con `plansAction?` opcional, **default `'pause'`** (pausa sin cancelar turnos). `visibility.test.ts` sigue verde y los callers viejos no se rompen.
- **Tests:**
  - `it.fails("[P2-S15] updateProgram con totalSessions → rechazo y sesiones vivas intactas")`;
  - `it.fails("[P2-S15] deleteSession borra en duro")`;
  - cancelar → futuros impagos cancelados y cobrados intactos;
  - pausar con "mantener" → nada cambia;
  - archivar un plan con turnos → sin P2003;
  - `expectedUpdatedAt` viejo → stale;
  - pausar un legacy (fixture) no falla;
  - archivar un paciente con ACTIVE → pausa.
- Si pasa el techo, el orquestador separa L9 en una segunda tanda serial.

**S16a · Mover en serie y re-planificar** (alto)
- **Archivos:** `lib/plans-move.ts`*, `lib/plans-move-internal.ts`*, `tests/integration/plans-move.test.ts`*, `tests/integration/plans-replan.test.ts`*.
- **Objetivo:**
  - D23 con preview y apply (pre-lock de Booking en id asc; core con `capLocksHeld`), con **`plans.schedule`** (la Secretaria puede mover "este y los siguientes"); el preview redacta títulos sin `clinical.read`;
  - L7 "Editar desde la sesión N" = cancelar los futuros impagos + `commitPlanRowsInTx` modo `replan`, con **`plans.manage`**;
  - profesional, servicio o sede = cancelar y recrear;
  - todo write de refs por `validatePlanRefsInTx`.
- **Tests:**
  - +1 h en una tx;
  - un conflicto → stale entero;
  - sin deadlock contra un commit de plan;
  - cambio de profesional desde la sesión k;
  - el cobrado queda intacto;
  - servicio o sede de otro tenant → rechazo con el rol owner.

**S16b · Cantidad y precio** (alto, plata)
- **Archivos:** `lib/plans-edit.ts`*, `lib/plans-edit-internal.ts`*, `lib/plan-pricing-internal.ts`*, `tests/integration/plans-edit.test.ts`*, `tests/integration/plans-pricing.test.ts`*.
- **Objetivo:**
  - `addPlanSessions` (al final o "a medida", con título, fecha y hora opcionales; turno por el motor; reabre un COMPLETED con confirmación);
  - archivar sesiones y `restoreSession`;
  - reprecio C5 de dos ramas;
  - PACKAGE: mantener total o precio por sesión;
  - **`renewPlanAuthorization`** (E2, con `assertPlanAuthorizeInTx`): en una tx con `lockPlanPatient`, CAS sobre la vigente (`expectedCurrentId`), `UPDATE … SET "supersededAt" = now() WHERE "programId" = $1 AND "supersededAt" IS NULL` + `INSERT` de la nueva, `auditInTx` solo con ids. Cantidad y precio siguen con `plans.manage`.
- **Tests:**
  - renovar deja 1 vigente y la anterior en el historial; dos renovaciones concurrentes → una stale; ASSISTANT renueva; BILLING no;
  - 10→12 agrega 2;
  - reducir archiva las últimas sin cobro;
  - una sesión con cobro → rechazo;
  - reprecio solo en futuros impagos;
  - pasar de "sin precio" a "por sesión" estampa por primera vez;
  - reprecio ∥ "Cobrado" → el cobrado conserva su monto;
  - reprecio ∥ `applyDayLock` sin 40P01;
  - PACKAGE por debajo de lo devengado → error;
  - PACKAGE sin filas libres → error;
  - caracterización (`it`): `setPatientDefaultCopago` y `updateInsurer` no mueven turnos de plan con precio.

**S17d · Puerta Diagnóstico server** (alto, seguridad)
- **Archivos:** `lib/diagnosis.ts`, `lib/diagnosis-internal.ts`*, `lib/diagnosis-engine.ts`, `lib/diagnosis-types.ts`, `tests/integration/plans-doors-diagnosis.test.ts`*, `tests/unit/diagnosis-ramp.test.ts`*.
- **Objetivo:**
  - `createPlanFromDiagnosis` (caso + diagnóstico + plan + turnos en una tx, por el hook);
  - `getDiagnosisPlanPrefill` (rampa por fase);
  - firma **aditiva** `searchPatientsForAssignment(q: string, opts?: {requireFull?: boolean})`, con default false.
- **Tests:**
  - un stale no deja nada;
  - básico → rechazo;
  - la rampa es correcta;
  - los 4 callers de hoy siguen compilando.

**S25a · Adopción** (alto, plata)
- **Archivos:** `lib/plans-adopt.ts`*, `lib/plans-adopt-internal.ts`*, `tests/integration/plans-adopt.test.ts`*.
- **Objetivo:**
  - vincular un turno a una sesión (la sesión toma la fecha del turno);
  - adoptar una serie;
  - sacar del plan (con cobro → rechazo; si no, CAS de desestampado);
  - `generatePlanBookings` para pendientes (`previewProgramRowsInTx` + commit modo `generate`), con `sessionIds?` para agendar una sesión puntual.
- **Gates:** vincular, adoptar y sacar = `plans.manage`; `generatePlanBookings` = `plans.schedule` (la Secretaria agenda una sesión pendiente), con títulos redactados en el preview.
- **Tests:**
  - adoptar un suelto sin re-estampar lo cobrado;
  - adoptar una serie;
  - adoptar una serie que incluye un turno de otro plan → stale y el otro plan intacto;
  - no adopta una reserva pública impaga;
  - `fromBookingId` + "contar como sesión 1" (COMPLETED → la sesión 1 nace realizada);
  - sacar con cobro → rechazo;
  - generar regenera una sesión cancelada con otra key;
  - sesión con cobro previo → turno nuevo en $0;
  - ASSISTANT agenda una sesión con `sessionIds` y no puede sacar del plan.

**S11x · Carreras del motor** (alto; solo tests; todo lo que ejecuta viene de olas anteriores)
- **Archivos:** `tests/integration/plans-concurrency.test.ts`*.
- **Tests:**
  - plan ∥ `createBooking` en cupo 1 → gana uno;
  - plan ∥ `applyDayLock` "todos" ∥ `createTimeBlock` multi-día → sin deadlock;
  - 2 commits del mismo paciente → serializados;
  - P2002 de carrera → 0 programas, sesiones y turnos.
- Todos con `advisory-wait`.

### P2.Z · Cierre de ES2b

> ✅ Ejecutado el 07-oct, commit `58ec36f`. Docs del punto 5 hechos; resultado del gate en AUDIT §Ronda 17.

1. Integrador.
2. **2 revisores de solo lectura:**
   - (a) concurrencia, locks C2, sincronía C4, RLS/tenant y extracción del core;
   - (b) plata C5, I6/I8, PHI del título, gates de `plan-authz-internal` (ninguna action reimplementa el gate), quién lee la autorización de la OS, y los contratos C7/C9 que va a consumir ES3.
3. Fixer.
4. Gate de ES con la migración **re-aplicada** (no-op) + `migrate status`.
5. Docs:
   - ADR-004;
   - AUDIT §5.36-40 (keys `plan:`, "sin turno" derivado, I8, nada vinculado se borra, orden C2) y enmienda de §5.28;
   - **SECURITY.md** (FKs compuestas como barrera bajo BYPASSRLS, `plans.manage` / `plans.schedule` / `plans.authorize`, PHI del título, quién lee la autorización de la OS);
   - QA "Planes P2";
   - AUDIT cierra `updateProgram-desincroniza-total`, `hard-delete-plan-session`, `delete-service-sin-contar-planes`, `ensureTag-kind-libre`, `reception-p2002-500`, `upsert-holder-pisa-turno-de-plan` y `dashboard-session-index-crudo`; `retroactive-copago-on-coverage-replace` queda **parcial → C0**.
6. Memoria.
7. Comando de commit:

```
git add -A && git commit -m "Planes P2 (ES2b): core de turnos server-only (con el gate de la Secretaria adentro), motor de planes (preview + commit en una tx, locks ordenados, keys plan:), sincronía turno↔sesión, lecturas y saldo, ciclo de vida, mover en serie y re-planificar, cantidad y precio con CAS, autorización de la OS (alta, lecturas y renovación), Diagnóstico por el motor, adopción, guardas; copago congelado al cobrar (sin migraciones nuevas)"
```

**No se mergea a main.**

### Decisiones de ES2b (07-oct; Martin las puede revisar)

- **P2-C2:** D1 ACTIVE → COMPLETED (el alta) también pregunta qué hacer con los futuros (D7 de PD-10, default
  cancelar); D3 las operaciones del motor no llevan `expectedUpdatedAt` (el `stateToken` ya incluye
  `program.updatedAt`); D4 "mover en serie" recibe un **instante absoluto**; D5 `addPlanSessions` no recibe la cuota
  del cliente (la calcula el server); D6 el título del plan es NOT NULL (default "<Disciplina> · N sesiones"). (D2 no
  quedó asentada en los handoffs.) Transiciones: PAUSED → ACTIVE y COMPLETED → ACTIVE (con confirmación) revalidan
  sede activa y responsable con `plans.manage`; CANCELLED es terminal; solo título y notas son editables sin motor.
- **Responsable del plan** = miembro aceptado con `plans.manage` (nunca Secretaria ni BILLING);
  `PROGRAM_NEARING_DISCHARGE` le llega a él (D17), con el actor como fallback.
- **Sincronía turno↔sesión sin gate de módulo** (es consistencia de datos); el verificador corre solo en el motor, no
  en los write-paths de turnos sueltos.
- **Seguimiento:** cerrar la última sesión **no** completa el plan (D22): devuelve `suggestDischarge`.
  `rescheduleSession` nunca cambia el profesional.
- **`addCustomSession`** (UI vieja) delega en el motor (`addSessionsInTx`, `plans.manage`): la Secretaria ya no agrega
  sesiones a medida; en PACKAGE sin `packagePricing` y en COMPLETED rechaza con copy.
- **Legacy de `lib/programs.ts`** hasta ES3: `updateProgram` solo título; `setProgramStatus` delega con D7 = mantener
  (el diálogo viejo dice "Los turnos no se tocan"); `deleteProgram` archiva solo CANCELLED/COMPLETED; `deleteSession`
  rechaza.
- **Adopción (S25a):** al sacar del plan, `copagoCents = null` solo si `pricedByPlan`; un turno COMPLETED no se saca
  (deshacer primero); vincular/adoptar en planes ACTIVE o PAUSED, generar solo en ACTIVE; disciplina distinta →
  rechazo; un PACKAGE no crece por adopción; sin aviso de alta al adoptar la última (ES3/C).
- **Saldo:** la OS pagada no suma en "cobrado" (C5; borde → C0). **L9:** archivar un paciente pausa sus planes por
  default.

### Handoffs para ES3 (literal para los prompts de P3)

> ✅ Consumidos en ES3 (08-oct). Quedó afuera `bulkAddSessionExercises` con rango por ordinal (S20 → C1, AUDIT
> §Ronda 18).

- **`plan-view.tsx` (S22a/S22e):** pasar a `changePlanStatus` + diálogo D7, `updatePlanDetails`, `archivePlan`,
  `restoreProgram`; sacar total/frecuencia/inicio del drawer y "Eliminar sesión"; `plan-form-defaults.ts`
  `programStatusConfirm` sin "reactivar CANCELLED". "Agregar sesión" → `previewAddPlanSessions`/`addPlanSessions` (o
  mandar `packagePricing`). Reprogramar: `bookingOnDay` null cuando hay turno; mostrar los rechazos del core y reenviar
  con `force`.
- **S20 Seguimiento:** bucket "Sin turno", "Sin evolución" → "Cargar evolución" (`loadSessionEvolution`), banner de
  alta (`suggestDischarge`), "Sesión n de N" (ordinal/totalLive), `Session.title`. La página
  `seguimiento/[sessionId]` todavía muestra el índice crudo (`dashboard-session-index-crudo`).
- **S23 Diagnóstico:** el editor previsualiza con `previewPlan(plan)` y commitea con
  `createPlanFromDiagnosis({plan, diagnosis})`; rampa en el cliente con `diagnosisRamp`/`diagnosisRampSteps`.
  `assignDiagnosisAndCreateProgram` legacy la retira S27b.
- **Notices:** `UpdateBookingResult.notice`, `ReceptionActionResult.notice` y `setBookingCopagoPaid`/`InsurerPaid`
  `notice` se muestran como toast en drawer, Recepción y facturación.
- **L9:** diálogo en hero / `patient-row-actions` / bulk-select (S22h/S32a) que pasa `plansAction` ('pause' |
  'cancel').
- **P3-C `toBookingDTO` compacto** (C9): omitir neutros y resolver `serviceDiscipline` en el cliente.
- **S18s:** `components/ui/exercise-search-picker.tsx` (~:69) pasa `disciplineSlug` a `listExercises`.
- **S27a:** retirar o migrar a `assertPlan*InTx` los gates reimplementados de `rescheduleSession`, `createProgram` y
  `applyPlanTemplate`; los sobrevivientes de `programs.ts` mantienen `requireModule('planes')`.
- **Opcionales del motor** (sin dueño todavía): `skipTotalSessionsCache?` en modo `add` (S25a commitea en `replan` por
  eso), `exercisesForIndex?` en `commitPlanRowsInTx`, `LocationArchiveBlockers.activePlans`.
- ✅ **Verificado en el gate de ES2b:** "cierre ∥ generar" cubierto en los dos órdenes (`plans-engine-fixes.test.ts`,
  cierre primero; `plans-sync-sessions.test.ts`, turno primero).

---

## 11. ES3 · P3 (= B3): UI y puertas · 1 migración (M3a, sola)

> ✅ **Ejecutada el 08-oct** en develop sobre `58ec36f`, pendiente commit de Martin. Todas las sesiones hechas (✅ en las
> tablas, más P3.0.0 M3a, P3-C, S14r, S27a y S27b). M3a aplicada solo en el Docker local. Las decisiones que cambiaron
> el contrato están al final de esta sección («Decisiones de ES3»); cierres y gate en AUDIT §Ronda 18.

### Enmiendas EV0/SV (07-oct) y del 08-oct (plan §16.2), se copian literal en los prompts

**08-oct (plan §16.2; el resto de ES3 queda como está):**

- **P3.0.0 (nueva, sola): migración M3a `billing_paid_at`.** Aditiva; prod se resetea.
  - `Booking.copagoPaidAt TIMESTAMP(3) NULL`: la fecha en que se marcó cobrado el copago a mano.
  - `UserPreferences.dashboardPrefs JSONB NULL`: preferencias del dashboard, por ahora `{revenueRange: 'month'|'week'}`, validadas al leer como `agendaPrefs`.
  - Se prueba con `migrate deploy` en local, verificando objeto por objeto, y con un test.
- **Sesión nueva S14r (P3.1): ingresos reales + Mes/Semana + pactado de plan cancelado.**
  - **Archivos:** `lib/dashboard.ts` (solo los ingresos), `components/screens/dashboard-screen.tsx` (RevenueCard y la KPI `monthRevenue`), `components/dashboard/revenue-card.tsx`* (si conviene extraerla), `lib/preferences.ts` y `lib/preferences-constants.ts` (blob `dashboardPrefs`), `lib/bookings.ts` (**solo** `toggleBilling`/`setBookingCopagoPaid` para escribir y limpiar `copagoPaidAt`; nadie más toca `bookings.ts` en ES3), `lib/plan-pricing.ts` (**solo** `planBalance`) y tests.
  - **Ingresos del período** (semana lunes→domingo AR, o mes AR, con `lib/datetime-ar.ts` y `startOfWeek` de `lib/dashboard.ts`):
    - `Payment` PAID de MP;
    - copagos con `paymentStatus PAID` y `copagoPaidAt` dentro del período, sin duplicar los que ya tienen un `Payment` de MP;
    - **obra social aparte**: `insurerPaidAt` dentro del período, con el arancel resuelto.
  - El "vs período anterior" se compara contra la semana o el mes anterior. El título pasa a "Ingresos de la semana" o "Ingresos del mes".
  - El selector usa el mismo patrón que `components/dashboard/sessions-chart.tsx:16-23`, con un server action `getRevenue(range)`, y persiste en `dashboardPrefs`.
  - El cache del dashboard sigue con el tag `dashboard` (el MP webhook no emite: entra por TTL, igual que hoy).
  - **Pactado de un plan CANCELLED:** pasa a ser = devengado, para que no cuente las sesiones canceladas.
  - **Tests:** semana y mes con TZ=UTC (borde de domingo 23:30 AR); copago manual marcado y desmarcado (desmarcar limpia `copagoPaidAt`); MP no duplica; OS separada; vertical General sin planes.
  - **Cierra en AUDIT:** "ingresos del dashboard que solo cuentan MP" (P11, que estaba en C0).
- **S22f:** el saldo de un plan cancelado usa el pactado nuevo (lo consume, no lo reimplementa).
- **S19b:** el modelo de filtros de la agenda tiene que ser **extensible**: un objeto de filtros con profesionales, sede y, en el futuro, sala. SR le va a sumar la sala sin rehacerlo.
- **Orden de ES3:** P3.0.0 M3a → P3.0 P3-C → P3.1 (con S14r) → P3.2 → P3.Z.0 → cierre (2 revisores, fixer, gate, docs, commit).
- **Verificación extra (§16.5):** `migrate deploy` de M3a con verificación objeto por objeto y `migrate status`; tests de S14r con TZ=UTC y TZ=AR. QA manual del widget: cobrar un copago a mano hoy → aparece en "Semana" y en "Mes"; desmarcarlo → desaparece; un pago de MP no se duplica; el monto de la obra social se ve aparte; el selector se recuerda al recargar.

**07-oct (EV0/SV):**

> Fuente: plan vigente §15.5 = [VERTICALES.md §5](VERTICALES.md). Mandan sobre el texto de las sesiones de abajo donde choquen. Cada línea va **tal cual** en el prompt de la sesión que nombra.

- **S17t / S21t**: plantillas solo por `gatingForActor(tx).canBuildTemplates` / `has('plantillas')`.
- **S20 / S23**: el guard de módulo vive en el `layout.tsx` de EV0; no se duplica ni se borra.
- **S21**: `app/(app)/planes/layout.tsx` = `guardModuleSegment('planes')`; la entrada de nav y el atajo van **solo** en `lib/nav.ts`; `sidebar.tsx`, `topbar.tsx` y `lib/search.ts` salen de su lista.
- **S22b**: pestañas con `isProfileTabAllowed` + rol; sin `planes` no carga planes ni saldos; los mocks de `getActor` suman `entitlements`.
- **S22b** (revisión EV0): `recordEvaScore` (tira) y `getPatientEvaScores` (`[]`) de `lib/patients.ts` exigen `evaluaciones`.
- **S15 / S27a** (revisión EV0): los exports de `lib/programs.ts` que sobrevivan mantienen `requireModule('planes')` (escrituras) y `[]` sin el módulo (lecturas); mover o retirar código no se lleva el gate.
- **S19b / S19c / S18b**: leyenda/filtro de plan, puerta 4, "Agendar próxima sesión", "Vincular", "Crealo como plan…" solo con `has('planes')`.
- **Reset de prod (§15.6):** R-LEGACY se deja como está en ES3; S27a/S27b se mantienen.

**Prerrequisitos:**
- commit 2b;
- PD-11 firmada;
- PQ-03, 04, 05, 07, 08, 10 y 13 con respuesta o default;
- Martin carga `Service.discipline` del cliente en staging.

### P3.0 · P3-C · Contratos y mecánica de agenda (serial, medio; si supera el techo, P3-Cc → P3-Cr)

- **Archivos:**
  - contratos: `lib/plans-deeplink.ts`* + `tests/unit/plans-deeplink.test.ts`* (C10 con `prefill`), `lib/agenda-highlight.ts`* + `tests/unit/agenda-highlight.test.ts`*;
  - DTOs: `components/agenda/agenda-utils.ts` (C9 opcional), `components/agenda/booking-drawer/types.ts` (C9 opcional en `DrawerBooking`);
  - componentes y props: `components/planes/discipline-chip.tsx`*, `components/planes/plan-editor-types.ts`* (C10, `PlanEditorPrefill` ~~con la autorización opcional~~ sin la autorización desde P3.Z, `PlanViewProps`, `ScheduleSlotsEditorProps`, `PlanPreviewTableProps` y las props de Hero/SesionesView/ResumenView);
  - stubs con props congeladas: `components/planes/plan-edit-dialogs.tsx`* (incluye el diálogo `RenewAuthorizationDialog`) y `components/planes/plan-session-actions.tsx`*;
  - rename mecánico `highlightedServiceId` → `highlight` en `agenda-client.tsx`, `views/week-grid-view.tsx`, `views/list-view.tsx`, `views/timeline-view.tsx`, `grid/booking-card.tsx` y `grid/slot-cell.tsx`.
- **Gate:** tsc, unit y `render/agenda-client` verdes **sin cambiar asserts**; los 4 fixtures de `BookingDTO` compilan sin cambios.
- **Contrato P3.x (literal en todos los prompts de ES3):** preservar `canOperateBooking` y `canWriteClinical` y el gating de S07u (operar = `canOperate`; campos clínicos y "Usar como diagnóstico" = `clinicalWritable`; Eliminar y cobros con la regla vigente). La autorización de la OS se muestra solo a quien la puede ver (§2.6), nunca en la agenda.

### P3.1 · 10 en paralelo (8 de UI + 1 server + S14r; S14r está arriba, en las enmiendas del 08-oct)

| Sesión | Archivos | Objetivo |
|---|---|---|
| ✅ **S18** Editor (alto) | `components/planes/plan-editor-drawer.tsx`*, `plan-form.tsx`*, `lib/plan-editor-state.ts`*, `tests/unit/plan-editor-state.test.ts`*, `tests/unit/render/plan-editor.test.tsx`* | C13 literal; debounce + secuencia; dirty-guard; Drawer de 600 px; `MoneyInput`; bloque opcional "Autorización de la OS" (código, sesiones autorizadas, desde/vence con `<input type="date">` → dayKey) |
| ✅ **S18s** Horario y pickers (medio) | `components/planes/schedule-slots-editor.tsx`*, `components/patients/patient-picker.tsx` (`requireFull?`, default false), `components/ui/exercise-search-picker.tsx` (`disciplineSlug`), `tests/unit/render/schedule-slots.test.tsx`* | dow 0=Dom; el modal y el drawer siguen eligiendo pacientes básicos |
| ✅ **S18p** Tabla de preview (alto) | `components/planes/plan-preview-table.tsx`*, `tests/unit/render/plan-preview-table.test.tsx`* | Estados, resoluciones, "Ya pagada", stale |
| ✅ **S19a** Chip en cards (medio) | `grid/booking-card.tsx`, `views/list-view.tsx` (+ código muerto `:79`), `views/week-grid-view.tsx`, `reception/reception-row.tsx`, `tests/unit/render/agenda-plan.test.tsx`* | Chip, "Fuera de plan"; en Por profesional, pill distinta a "2/3" |
| ✅ **S19b** Leyenda y filtro (medio) | `agenda-client.tsx`, `plan-legend.tsx`*, `view-options-menu.tsx`, `lib/agenda-filters.ts`, `lib/agenda-client-state.ts`, `tests/unit/agenda-filters.test.ts`, `tests/unit/agenda-client-state.test.ts`, `tests/unit/render/agenda-client.test.tsx` | Plan/suelto por resaltado |
| ✅ **S19e** Vistas densas (medio) | `grid/slot-cell.tsx`, `views/practitioner-day-view.tsx`, `views/timeline-view.tsx`, `tests/unit/render/practitioner-day-view.test.tsx` | Resaltado y chip en Día y Por profesional |
| ✅ **S20** Seguimiento (medio) | `app/(app)/seguimiento/page.tsx`, `app/(app)/seguimiento/[sessionId]/page.tsx`, `components/seguimiento/session-detail.tsx`, `components/biblioteca/bulk-assign-modal.tsx`, `tests/unit/render/seguimiento.test.tsx`* | "Sin turno", "Sin evolución", "Cargar evolución", ordinal (no `s.index`), banner de alta |
| ✅ **S22f** Turnos y Facturación (alto, plata) | `turnos-view.tsx`, `facturacion-view.tsx`, `components/planes/plan-balance.tsx`*, `tests/unit/render/facturacion-plan.test.tsx`* | Agrupada por plan con el saldo del server, cancelados con cobro visibles (desde SR, **siempre**, agrupada o no: SR-D4F), sin "Eliminar" en turnos de plan |
| ✅ **S17t** Plantillas server (medio) | `lib/plan-templates.ts`, `lib/plan-templates-types.ts`, `tests/integration/plan-templates.test.ts`* | CRUD con disciplina, servicio, schedule, precio y archivedAt; autor o admin; STARTER+; `getTemplatePrefill`; `serviceId` por `validatePlanRefsInTx`; `it` cross-tenant con el rol owner |

**Mini-integración P3.1.**

### P3.2 · 10 en paralelo (2 tandas)

| Sesión | Archivos | Objetivo |
|---|---|---|
| ✅ **S19c** Drawer: fila Plan (alto) | `booking-drawer/index.tsx`, `booking-drawer/plan-row.tsx`*, `booking-drawer/patient-header.tsx` (código muerto `:27-29`), `booking-drawer/status-actions.tsx`, `tests/unit/render/booking-drawer-plan.test.tsx`* | Puerta 4 (navega con C10), "Cancelalo", copy de Ausente, paciente bloqueado. **"Agendar próxima sesión"** en un turno de plan con `plans.schedule` (la Secretaria; usa `listSchedulablePlanSessions` + `generatePlanBookings({sessionIds})`, sin título). **"Sacar del plan" y "Vincular a una sesión"** solo con `plans.manage`. "Renovar autorización" (diálogo de S22e) con `plans.authorize` |
| ✅ **S19d** Drawer: mover y plata (alto) | `booking-drawer/reschedule-form.tsx`, `edit-details-form.tsx`, `billing-rows.tsx`, `components/agenda/recordatorio-turno.tsx`, `tests/unit/render/booking-drawer-move.test.tsx`* | "Solo este / Este y los siguientes" (`plans-move`) con `plans.schedule`, "Copago (plan)", recordatorio "Sesión 3 de 10" |
| ✅ **S21** `/planes` + nav (medio) | `app/(app)/planes/page.tsx`*, `app/(app)/planes/[discipline]/page.tsx`*, `app/(app)/planes/layout.tsx`* (`guardModuleSegment('planes')`), `components/planes/planes-client.tsx`*, `lib/nav.ts` (solo la entrada y el atajo de Planes). ~~`components/layout/sidebar.tsx`, `components/layout/topbar.tsx`, `lib/search.ts`~~ salen (enmienda EV0: la nav vive solo en `lib/nav.ts`) | Solo disciplinas con algún servicio activo; otra disciplina → `notFound`; "Nuevo plan" con `plans.manage` y `PatientPicker requireFull`; filtro **"Sesiones sin turno"** con `plans.schedule`, sin título, con la acción Agendar |
| ✅ **S21t** Plantillas UI (medio) | `components/planes/templates/template-list.tsx`*, `template-drawer.tsx`*, `tests/unit/render/templates.test.tsx`* | Deshabilitadas en FREE con aviso |
| ✅ **S22a** Tab Planes (alto) | `plan-view.tsx`, `components/planes/plan-card.tsx`*, `plan-lifecycle-dialogs.tsx`*, `plan-history.tsx`*, `components/patients/plan-template-apply.tsx`, `tests/unit/render/plan-card.test.tsx`* | PlanCard, D7, historial, plantilla por el editor; deja de usar `addCustomSession`; línea de autorización *"Autorizadas 10 · usadas 6 · agendadas 3 · vence 30/11"* (solo si el DTO la trae) |
| ✅ **S22e** Edición del plan (alto, plata) | `components/planes/plan-edit-dialogs.tsx`, `plan-session-actions.tsx`, `tests/unit/render/plan-edit.test.tsx`* | Cantidad y precio con preview y CAS, mantener total, sesión a medida, archivar y restaurar sesión, "Editar desde la sesión N" (editor `replan`), "Generar turnos para pendientes"; **diálogo de renovación de la autorización** (`renewPlanAuthorization`, visible también para la Secretaria desde el drawer) |
| ✅ **S22b** Perfil: shell (medio) | `patient-profile.tsx`, `profile/tabs-bar.tsx`, `profile/types.ts`, `app/(app)/pacientes/[id]/page.tsx`, `components/patients/activity-view.tsx` | Tab `'planes'` + alias, deep-link, editor lazy (`next/dynamic`), carga `getPatientPlans`/`getPatientPlanBalances` (**reemplaza** `getPatientProgramsLite/Full`), labels `plan.*` |
| ✅ **S22h** Perfil: hero y vistas (medio) | `profile/hero.tsx`, `components/patients/archive-patient-dialog.tsx`*, `profile/views/sesiones-view.tsx`, `profile/views/resumen-view.tsx` | Chips por disciplina (el plan de OS sigue aparte), diálogo L9 |
| ✅ **S23** Diagnóstico UI (alto) | `app/(app)/diagnostico/page.tsx`, `components/screens/diagnostico-screen.tsx`, `diagnostico-wizard.tsx`, `components/diagnostico/assign-plan-modal.tsx`, `tests/unit/render/diagnostico-door.test.tsx`* | Deep-link; "Asignar plan" y el wizard abren el editor prellenado |
| ✅ **S18b** Puerta liviana (bajo) | `booking-modal/sessions-mode.tsx`, `booking-modal/multi-section.tsx`, `day-lock/day-lock-dialog.tsx`, `tests/unit/render/multi-plan-link.test.tsx`* | "Crealo como plan…" con `prefill` (sin paciente guardado: deshabilitado con hint); aviso L11 solo si es UI pura |

### P3.Z · Cierre de ES3

**P3.Z.0 · Retiro (2 en paralelo, alto; antes del revisor).** Cada test de ES1 se **re-afirma sobre la puerta nueva antes** de borrar el viejo.

- **S27a:**
  - **Archivos:** `lib/programs.ts`, `tests/integration/programs.test.ts`, `tests/integration/authz-matrix.test.ts`, `tests/perf/loaders.perf.test.ts`.
  - **Retira:** `createProgram`, la rama estructural de `updateProgram` (queda `updatePlanDetails`) y `getPatientProgramsLite/Full` si no tienen callers.
  - **Perf:** el escenario `createProgram.16` → `createPlan.16`.
- **S27b:**
  - **Archivos:** `lib/diagnosis.ts`, `lib/plan-templates.ts`, `lib/sessions.ts`, `tests/integration/plans-doors-diagnosis-authz.test.ts`, `tests/integration/plan-templates-authz.test.ts`, `tests/integration/sessions.test.ts`.
  - **Retira:** `assignDiagnosisAndCreateProgram`, `applyPlanTemplate` viejo y `addCustomSession`.
  - **Mapa de tests:**
    - básico, cross-tenant, condición y dosis → `createPlanFromDiagnosis` / `createPlan` con `templateId`;
    - carrera de la sesión a medida → `addPlanSessions`.
- **Gate:** `grep -rnE "\b(createProgram|assignDiagnosisAndCreateProgram|addCustomSession)\b|applyPlanTemplate\b" app components lib tests` = 0.

**Después del retiro:**
1. Integrador.
2. **2 revisores de solo lectura:**
   - (a) UI y contratos C9/C10/C13, densidad de la Secretaria, a11y y PHI;
   - (b) server de ES3 + que no queden puertas que salteen el motor.
3. Fixer.
4. Gate de ES + `npm run perf:bundle`:
   - `/agenda`, `/pacientes/[id]` y `/diagnostico` **no empeoran**;
   - `/planes` ≤ 180 kB;
   - editor lazy;
   - payload de la agenda ≤ +5 %.
5. Docs: QA "Planes P3"; AUDIT cierra `plantillas-sin-crud`, `plan-status-sin-confirm`, `hero-plan-activo-falso` y `statustag-fmtmoney-duplicados`.
6. Comando de commit:

```
git add -A && git commit -m "Planes P3 (ES3): editor único y 4 puertas (Tab Planes, /planes/[disciplina], Diagnóstico, crear desde el turno), edición del plan, agenda con chip/Fuera de plan/leyenda, drawer con plan, Seguimiento, Turnos y Facturación por plan, plantillas; ingresos reales del dashboard con Mes/Semana (S14r); retiro de las altas que salteaban el motor; migración M3a billing_paid_at (sola)"
```

**QA en staging** (TZ=UTC):
- servicios con disciplina;
- "Nuevo plan" con conflictos;
- chip en Día, Semana, Lista, Por profesional y Recepción;
- reprogramar mueve la sesión;
- Ausente → sin turno → "Agendar";
- Atendido → "Sin evolución" → cargar evolución;
- "este y los siguientes";
- crear desde una evaluación;
- Diagnóstico → plan;
- reprecio con un turno cobrado;
- sesión a medida;
- archivar y restaurar;
- saldo;
- cancelar el plan no toca lo pagado;
- archivar un paciente con plan.

El checklist manual completo, por superficie, está en [QA.md §Planes P3](QA.md).

**No se mergea a main.**

### Decisiones de ES3 (08-oct; cambian el contrato, Martin las puede revisar)

- **COMPLETED = "Finalizado"** en todas las superficies (C13, `components/planes/plan-booking-groups.ts:193`).
- **L11 (candado del día):** el aviso dice que la sesión de plan **queda sin turno** en el plan (no se pierde), cuenta
  solo los turnos que son sesión de un plan y marca cada fila con un chip no cromático "Plan", sin título.
  Lo alimenta `DayLockAffected.inPlan: boolean` (`lib/time-blocks-schemas.ts:293`, `lib/time-blocks.ts:247`;
  `components/agenda/day-lock/day-lock-dialog.tsx:74-84`). Sin ningún turno de plan, no hay aviso.
- **`authorization` fuera del prefill C10** (ver C10): texto libre en la URL.
- **Superficie RPC de `lib/diagnosis.ts` = lista blanca**: `createPlanFromDiagnosis`, `getDiagnosisPlanPrefill`,
  `loadCatalog` y `searchPatientsForAssignment`. Un export nuevo de ese `"use server"` es una RPC pública y tiene que
  pasar por el test a propósito (`tests/integration/plans-doors-diagnosis-authz.test.ts:206-215`).
- **"Sacar del plan" / "Vincular"** según C13 corregido: "Sacar del plan" en turnos de plan y "Vincular a una sesión" en
  turnos Fuera de plan.
- **Concurrencia de "a medida":** se acepta "stale-preview limpio + entra al reintentar". El preview no corre bajo el
  lock del commit (por diseño), así que dos altas concurrentes no duplican el `index`: una entra y la otra recibe stale y
  entra al reintentar. La carrera real (holder del lock + `waitForAdvisoryWaiter`) vive en
  `tests/integration/sessions.test.ts:320` («2 altas "a medida" concurrentes»). El caso **sin fecha** quedó anclado al
  día AR (`lib/plans-edit-internal.ts:370-381`): antes `now + 7d` con milisegundos cambiaba el `stateToken` y daba stale
  siempre.
- **"Agendar" en Seguimiento es un modal de una fila** (`components/seguimiento/schedule-session-modal.tsx`), no el
  editor entero: `previewGeneratePlanBookings` → `generatePlanBookings` con la misma tabla de preview (S18p). Lo reusan
  el drawer ("Agendar próxima sesión") y `/planes`.
- **Tab del perfil = `planes`**, con alias `plan` (C10).
- Otras de las sesiones (resumen; detalle en los handoffs del cierre): L9 también pregunta con planes solo PAUSED;
  "Generar turnos para pendientes" solo con más de 1 pendiente; legacy no vinculado = "Programada"; Resumen muestra
  como diagnóstico `diagnosisTitle ?? título del plan`; el wizard de Diagnóstico no tiene paso Paciente ni "Orden de
  ejercicios"; las pestañas del perfil son `nav` + `aria-current` (no `tablist`); `/planes` solo lista disciplinas con un
  servicio activo y "Sesiones sin turno" solo de planes ACTIVE; las plantillas solo con `plans.manage`.

**Decididas por Martin (08-oct, al cerrar ES3; antes "abiertas", filas en AUDIT §Ronda 18):**
1. **Bundle:** se acepta el crecimiento de ES3 (C9/S22f); el bundle bloqueante sigue en C1.
2. `setProgramStatus`/`deleteProgram`/`deleteSession` (sobrevivientes de `lib/programs.ts`, gate `planes`, sin bypass
   del motor) **se quedan**: no se retiran en EV1.
3. **R-LEGACY:** un plan sin responsable/servicio no acepta sesión "a medida" ("Plan inválido."). Se deja así.
4. **Facturación:** los turnos cancelados/ausentes con cobro se muestran **siempre** (no solo en modo agrupado) y suman
   en "percibido". ✅ **Ejecutada en SR** (SR-D4F): `isBillingVisible` sin `grouped`
   (`components/planes/plan-booking-groups.ts:242`); REFUNDED/AUTHORIZED visibles.
5. **Ingresos del dashboard restringidos:** cada profesional ve **sus** ingresos (turnos donde es el profesional);
   la vista del consultorio queda para los roles de administración/cobros. ✅ **Ejecutada en SR** (SR-D5I):
   `revenueScopeFor` (`lib/dashboard-revenue.ts:152`), `billing.manage` todo, PRACTITIONER lo suyo, Secretaria nada;
   tabla en [SECURITY.md §16](SECURITY.md).
6. "Diagnóstico" del Resumen con la condición (`diagnosisName` en `PlanDTO`) → C1 (sin cambios).
7. "Renovar autorización" en todo turno de plan con `plans.authorize` → C1 si molesta (sin cambios).

---

## 12. ES4 · P4 (= B4): portal ampliado y matriz (E2E al roadmap, sin legacy) · sin migración

> **15-oct — manda §20.8 del plan vigente** (se copia literal en los prompts de ES4; donde choque con el texto de
> abajo, gana esto):
> - **S26a (Playwright) → roadmap**; `test:e2e` fuera del gate. **S25L/S25n/S25b no se hacen** (prod demo, sin
>   reset); precheck de solo lectura que lo confirme (planes sin turnos). **Evoluciones (EV2) nunca en el portal.**
>   Copy neutral por vertical (`lib/portal-copy.ts`*).
> - **S24a reconciliado con IAM-3c:** el login del portal sigue (Google + magic link); la autorización pasa a
>   `(tenantId, userId)` en **`lib/portal-identity-internal.ts`*** (el nombre `portal-auth-internal.ts` ya existe):
>   `requirePortalPatient(slug)`, `listPortalPatients(userId)`. Invitación = magic link con
>   `next=/portal/vincular?t=<HMAC 7 días>`; `/portal/vincular` vincula con CAS. Auto-vínculo por email **solo si hay
>   exactamente una ficha libre** en ese consultorio (PD-15); si hay más → «Pedile a tu consultorio que te invite».
>   Gate: 0 `emailEqualsFilter` en `lib/portal.ts` y el módulo nuevo.
> - **Olas:** P4.0 S24a (+ P4-C) → P4.1 tanda A (S24, S24p, S24d, S24r, S24e, S32a) → tanda B (S24i, S32) → P4.2 S26b
>   (+ columnas GENERAL, SUPPORT, portal × «sin evoluciones», filas de EV2 y PL) + perf/soak → P4.Z. Sin P4.3.

### Enmiendas EV0/SV (07-oct, se copian literal en los prompts)

> Fuente: plan vigente §15.5 = [VERTICALES.md §5](VERTICALES.md). Mandan sobre el texto de las sesiones de abajo donde choquen. Cada línea va **tal cual** en el prompt de la sesión que nombra.

- **S24 / S24e / S24d**: el portal usa `getTenantModulesById` (turnos de plan con `planes`, check-in con `evaluaciones`, `/ejercicios` con `ejercicios`, "Reservar turno" con `turneroPublico`).
- **S32**: columna y chips de plan solo con `planes`.
- **S26b**: columna "tenant GENERAL (OWNER)" en la matriz + "KINE FREE no asigna globales". **S26a**: escenario General (sin nav clínico; `/diagnostico` → `/dashboard`).
- **Reset de prod (§15.6):** S25L, S25n y S25b **eliminadas**; PQ-14 y el escenario E2E "legacy" eliminados. ES4 corre después de SV: `authz-matrix.test.ts` y `package.json` se comparten con SV por handoff.

**Orden de ES4:** P4.0 (S24a ∥ P4-C) → P4.1 (8) → P4.2 (S26b) → P4.Z (gate final del bloque B). P4.3 (E2E) → roadmap (§20.8).

**Prerrequisitos:**
- commit de ES3;
- ~~prechecks (8)-(10) y (14) con sus números~~ (eliminados por el reset de prod del 07-oct: base vacía);
- PQ-13 respondida (~~PQ-14~~ eliminada por el reset);
- commit de la corrida anterior en el orden de §20 (PL, EV2 y VX ✅);
- ~~PD-12 (Playwright, `.env.e2e.local` de staging, usuarios E2E)~~: **ya no es prerrequisito** (15-oct). No hay
  staging; S26a y `test:e2e` van al roadmap (§20.8).

### P4.0 · Identidad del portal y contratos (2 en paralelo, antes del resto del portal)

**S24a · Identidad del portal** (alto, PHI y seguridad; si supera el techo, el orquestador separa el vínculo por invitación en S24v)
- **Archivos:** `lib/portal-auth-internal.ts`*, `lib/portal-link-internal.ts`*, `lib/portal.ts` (solo reemplaza los helpers privados `verifiedUser` y `authedPatientByTenant` por el import, con swap atómico), `lib/patients.ts` (solo `sendPatientPortalInvite`), `app/auth/callback/route.ts`, `app/(portal)/portal/vincular/page.tsx`*, `tests/integration/portal.test.ts` (los fixtures de `:75-88` pasan a `userId` vinculado), `tests/integration/portal-identity.test.ts`*.
- **Contrato (E3, literal de §2.6):**
  - `requirePortalPatient(slug) → {userId, tenantId, patientId}` (server-only) resuelve por `(tenantId, userId)`. S24, S24p, S24d y S24e lo usan; nadie autoriza por email.
  - Vínculo automático en `lib/portal-link-internal.ts`: las 4 condiciones de PD-15 y CAS `UPDATE "Patient" SET "userId"=$me WHERE id=$p AND "tenantId"=$t AND ("userId" IS NULL OR "userId"=$me)`, exigiendo count 1. Es el **único** lookup por email del portal.
  - Invitación: `sendPatientPortalInvite` emite un token HMAC `{patientId, tenantId, sha256(lower(email))}` que vence a los 7 días (misma técnica que `lib/recovery-cookie.ts`) y lleva a `/portal/vincular?t=`. Esa ruta exige usuario verificado, no staff (§5.22) y email igual al del token, y vincula con el mismo CAS. El "un solo uso" lo da el CAS (sin tabla nueva).
  - El callback atrapa el P2002 y loguea `portal.link.refused` con un motivo, sin PII. La rama de vínculo por `?tenant=` se retira o se envuelve con el mismo helper.
  - Las queries usan `findMany({where:{userId}})` o `{userId, tenantId}`, **nunca** `findUnique` por userId.
- **C12:** 8, 19, 21 y 22.
- **Gate:** `grep -n "email: { equals" lib/portal.ts lib/portal-auth-internal.ts` = 0.
- **Tests:** 2 consultorios con la misma cuenta → 2 vínculos (sin P2002); 2 fichas con el mismo email en un consultorio → no vincula y pide invitación; staff → no vincula; token vencido o de otro email → rechazo; sin `userId` vinculado no sale estado de cuenta ni ejercicios.
- **Cierra** `portal-auth-por-email-no-userid` y `portal-userid-unique-500`.

**P4-C · Contratos del portal** (medio)
- **Archivos:** `lib/portal-account-types.ts`*, `lib/portal-exercises-types.ts`*, `lib/portal-profile-types.ts`*, `lib/portal-pending-changes.ts`* (zod `.strict()` del `changes` de `PatientChangeRequest`, puro), `tests/unit/portal-pending-changes.test.ts`*.
- **Forma literal de `changes`:** `{ phone?: string|null; email?: string|null; emergencyContact?: { name: string; relation?: string|null; phone: string } | null; coverage?: { insurerName: string; planName?: string|null; memberId?: string|null } }`, con tope de largo por campo y ≤ 4 KB en total (espejo del CHECK).

### P4.1 · 10 en paralelo (tandas de hasta 8; como máximo 5 con integración)

Tandas sugeridas:
- **A:** S24, S24p, S24d, S24r, S24e (integración) + S32a.
- **B:** S24i, S32 (integración). ~~S25L, S25n~~ eliminadas (reset de prod 07-oct).

| Sesión | Archivos | Objetivo y tests |
|---|---|---|
| **S24** Portal: turnos del plan (alto, PHI) | `lib/portal.ts`, `lib/portal-types.ts`, `app/(portal)/portal/page.tsx`, `app/(portal)/portal/c/[slug]/page.tsx`, `components/portal/check-in-form.tsx`, `tests/integration/portal.test.ts` | Turnos del plan + "Sesión 3 de 10", sin montos ni notas, con links a `/cuenta` y `/ejercicios` (solo href); check-in en `EvaScore.note/sessionId`; plan vinculado más reciente; el DTO usa `fullName ?? 'Tu profesional'` (nunca el email del profesional). Gate H4 (A2b) y H5 (A3c) 🟢 |
| **S24p** Estado de cuenta (alto, plata) | `lib/portal-account.ts`*, `lib/portal-account-internal.ts`*, `app/(portal)/portal/c/[slug]/cuenta/page.tsx`*, `components/portal/account-statement.tsx`*, `tests/integration/portal-account.test.ts`* | Saldo P7 + turnos sueltos, acotado por `requirePortalPatient` (usa el `planBalance` puro sin editarlo). El monto sale **solo** si la fuente es explícita (estampado, override, copago de la OS o Particular). Con OS sin copago: *"A confirmar en el consultorio"*. Sin `osAmountCents`, arancel ni precio de lista crudo. Tests: `[P4-S24p] OS sin copago → sin monto`, `[P4-S24p] el DTO no tiene osAmountCents` |
| **S24d** "Mis datos" (lado portal) (alto) | `lib/portal-profile.ts`*, `lib/portal-profile-internal.ts`*, `app/(portal)/portal/me/page.tsx`, `components/portal/profile-change-form.tsx`*, `tests/integration/portal-profile.test.ts`* | El pedido va a `PatientChangeRequest` (INSERT, o UPDATE de la fila PENDING con CAS de su `updatedAt`), con rate-limit de 3 por hora y la allowlist de P4-C. **Nunca** escribe Patient (test de grep: `lib/portal*.ts` no contiene `patient.update`). Ve sus consultorios. "Cerrar sesión en todos lados": server action con `const { error } = await supabase.auth.signOut({ scope: 'global' })` que muestra el error si falla |
| **S24r** Pedidos del portal (lado consultorio) (alto) | `lib/patient-portal-requests.ts`*, `lib/patient-portal-requests-internal.ts`*, `components/patients/profile/hero.tsx` (banner), `tests/integration/patient-portal-requests.test.ts`* | Aprobar o rechazar con `{id, expectedUpdatedAt}`, CAS y gate `admin` o full. Al aprobar, en una tx: campos de contacto con `where {id, tenantId}`, `applyEmergencyContactInTx` nueva (reemplaza el contacto único), cobertura re-validada, estado APPROVED, `auditInTx` con nombres de campo (sin valores). El email se aplica solo si la cuenta está vinculada. Un cambio de OS avisa *"Cambia el copago de N turnos impagos"* con `useConfirm`. **No edita `lib/patients.ts`** (es de S32): si necesita exportar un helper de cobertura, handoff exacto |
| **S24e** Ejercicios del plan (alto, PHI) | `lib/portal-exercises.ts`*, `lib/portal-exercises-internal.ts`*, `app/(portal)/portal/c/[slug]/ejercicios/page.tsx`*, `components/portal/exercise-list.tsx`*, `tests/integration/portal-exercises.test.ts`* | Solo `kind = EXERCISE` de sesiones vivas del plan vinculado. Campos `{name, sets, reps, durationSeconds, instructions, media}`, sin `SessionExercise.notes` del kine ni `videoUrl` crudo. Media por `signExerciseMedia` (S02m) con TTL de 600 s, o YouTube nocookie. No toca `lib/exercise-media.ts`. Test: `[P4-S24e] maniobras y notas del kine no salen`; media de un ejercicio fuera de sus sesiones → null |
| **S24i** ICS "Sesión n/N" (medio) | `lib/bookings-export-internal.ts`, `tests/integration/ics-export.test.ts` | "Kine · Sesión 3/10 · <servicio>"; sin título sin `clinical.read` (el gate ya está desde ES1); la autorización de la OS nunca sale |
| ~~**S25L** Legacy server (alto)~~ — **Eliminada (reset de prod 07-oct)**: no hay planes viejos en prod. Texto original como historia: | `lib/plans-legacy.ts`*, `lib/plans-legacy-internal.ts`*, `tests/integration/plans-legacy.test.ts`* | "Completar datos" (refs por `validatePlanRefsInTx` + reconciliar `totalSessions` con confirmación); vincular el mismo día AR (00:00Z por fecha UTC); adoptar series. Tests: 00:00Z en TZ=UTC, nunca adopta una reserva pública PENDING, idempotencia, cross-tenant con el rol owner, reconciliar 10 vs 8 |
| ~~**S25n** Script de normalización (alto)~~ — **Eliminada (reset de prod 07-oct)**: no hay fechas legacy que normalizar. Texto original como historia: | `scripts/normalize-plan-session-dates.ts`*, `lib/plan-legacy-normalize.ts`* (puro), `lib/plan-legacy-normalize-internal.ts`*, `tsconfig.scripts.json`, `tests/unit/plan-legacy-normalize.test.ts`*, `tests/integration/normalize-plan-session-dates.test.ts`* | Dry-run por defecto, `--apply`, `assert-safe-target`, aborta sin BYPASSRLS. Excluye sesiones con algún `Booking.sessionId` y programas con `schedule`. Nunca toca Booking. Idempotente (2.ª corrida = 0) |
| **S32** Listado de pacientes (medio) ✅ | `lib/patients.ts`, `lib/patients-types.ts`, `components/patients/patients-list.tsx`, `app/(app)/pacientes/page.tsx`, `tests/integration/patients-list-plans.test.ts`* | Chips por disciplina con `liveProgramWhere`. No cambia las firmas de `updatePatient`, `setPatientCoverage` ni `getPatientCore`; nadie más toca `lib/patients.ts` en P4.1 |
| **S32a** Archivar desde el listado (medio) ✅ | `components/patients/patient-row-actions.tsx`, `components/patients/bulk-select.tsx`, `tests/unit/render/archive-from-list.test.tsx`* | Usan `archive-patient-dialog` (L9) |

### P4.2 · S26b (S25b eliminada)

- ~~**S25b · Legacy UI** (medio)~~ — **Eliminada (reset de prod 07-oct)**: no hay planes viejos que mostrar con banner. Texto original como historia:
  - **Archivos:** `components/planes/plan-legacy-actions.tsx`*, `components/planes/plan-card.tsx`, `components/patients/profile/views/plan-view.tsx` (monta el aviso agregado), `tests/unit/render/plan-legacy.test.tsx`*.
  - **Objetivo:** banner "Plan anterior a la agenda", acciones y aviso "N planes anteriores sin turnos → Vincular".
- **S26b · Authz, RLS, perf y soak** (alto)
  - **Archivos:** `tests/integration/authz-matrix.test.ts`, `tests/integration/rls-isolation.test.ts`, `tests/perf/plans.perf.test.ts`*, `tests/integration/plans-soak.test.ts`*.
  - **Matriz:** **todas** las actions × cross-tenant / básico / ASSISTANT / BILLING. **Columna ASSISTANT (E1, literal):** opera turnos, incluidos los de plan (crear, reprogramar, "este y los siguientes", cancelar, Recepción, agendar una sesión), y carga y renueva autorizaciones (`plans.authorize`); **no** tiene `plans.manage` (crear, editar, precio, cantidad, ciclo de vida, vincular, sacar → rechazo); nunca ve ni escribe campos clínicos; `getPlanDetail` completo → Forbidden. Las actions del portal × paciente de otro consultorio y sin vínculo.
  - **Perf:** `createPlan` de 20 filas ≤ 60 statements en 1 tx; `previewPlan` ≤ 30; `listOpenSessions` y `getPlanDetail` con presupuesto; agenda ≤ +5 %.

### P4.3 · S26a · E2E Playwright (sola, alto) — **al roadmap (15-oct, §20.8); texto como historia**

- **Archivos:** `playwright.config.ts`*, `tests/e2e/planes.spec.ts`*, `tests/e2e/fixtures.ts`*, `package.json` (solo el script `test:e2e` = `dotenv -e .env.e2e.local -- playwright test`).
- **Cómo corre:** contra `next build && next start`, con la base del Docker local (5433), el server en TZ=UTC y el browser en AR.
- **Fixtures:**
  - abortan si `E2E_TARGET` ≠ `staging` o si la base no es local;
  - arman los datos con `tenant-factory`/`plan-factory` sobre los userIds E2E;
  - **nunca** usan seeds.
- **C12:** incluye 16.
- **Escenarios:**
  - los 9 del §10 del plan;
  - la Secretaria ve el chip sin título, reprograma un turno de plan y agenda una sesión sin turno;
  - puerta 4;
  - ~~legacy: vincular el mismo día~~ (eliminado por el reset de prod del 07-oct);
  - cambio de precio con un turno cobrado.

### P4.Z · Cierre de ES4 y gate final del bloque B

> **✅ 16-oct.** Hecho en dos tandas (P4.Z (1) `48eefb9`: gate de diagnóstico/EVA, `/auth/confirm` sin 500, cuenta y
> tabs, perf S26s; P4.Z (2): hallazgos de los revisores (a) y (b), docs). Sin `test:e2e` (roadmap) ni RUNBOOK de deploy de
> Planes: no hay migración en ES4. El comando de commit de abajo es historia (formato viejo).

1. Integrador.
2. Revisor de solo lectura (PHI del portal, E2E sin prod, gates de módulo por vertical). ~~Legacy y datos de prod~~: no aplican desde el reset del 07-oct.
3. Fixer.
4. Gate completo + `npm run test:e2e` + perf + bundle.
5. Docs:
   - ROADMAP (Planes ✅ pendiente de deploy);
   - ARCHITECTURE §Planes;
   - TESTING (E2E, `.env.e2e.local`, sin CI por ahora);
   - PERF (presupuestos);
   - **SECURITY.md** (portal: identidad por `(tenantId, userId)`, vínculo automático e invitación, "Mis datos" sin escribir la ficha; ICS);
   - RUNBOOK §"Deploy de Planes" + §"Hotfix con develop congelado";
   - QA "Planes P4";
   - AUDIT cierra `limites-sesiones-divergentes`, `portal-auth-por-email-no-userid`, `portal-userid-unique-500` y `portal-plan-expone-notas-de-sesion` (si quedó abierto); `patient-tenancy-single-home-row` pasa a 🟢 (una cuenta, fichas por consultorio).
6. Memoria.
7. Comando de commit:

```
git add -A && git commit -m "Planes P4 (ES4): portal ampliado (identidad multi-consultorio por userId, vínculo automático o por invitación, turnos del plan, estado de cuenta, Mis datos con confirmación del consultorio, ejercicios del plan), ICS 'Sesión n/N' sin PHI, listado de pacientes por disciplina, matriz authz completa, perf/soak, E2E Playwright (sin migraciones)"
```

**ES4b (condicional):**
- S26c corrige los hallazgos del QA de staging, con un dueño por archivo y hallazgo.
- Después: **revisor de solo lectura**, fixer, re-gate y commit.
- Si el QA sale limpio, no corre.

---

## 13. Paralelismo: por qué es seguro

1. **Dueño único por archivo y por ola.** Las listas se cruzaron y son disjuntas. Los archivos que cambian de dueño lo hacen **entre** olas:

| Archivo | Recorrido de dueños |
|---|---|
| `lib/bookings.ts` | S07k (P0.1) → S07sb (P0.2) → S07c → S12 → S14r (ES3, solo `toggleBilling`/`setBookingCopagoPaid`) → SR |
| `lib/bookings-types.ts` | S07sb (P0.2) → P2-C1 → S12 |
| `lib/programs.ts` | P0-Cs → S02a → S15 → S27a |
| `lib/sessions.ts` | S02s → S12b → S27b |
| `lib/diagnosis.ts` | S02d → S17d → S27b |
| `lib/patients.ts` | P0-Cs → S02a (P0.1) → S07sp (P0.2) → S15 → S24a (P4.0, solo `sendPatientPortalInvite`) → S32 (P4.1) |
| `lib/validation.ts` | S02a (P0.1) → S07sp (P0.2) → S13 |
| `lib/visibility.ts` | S02p |
| `lib/portal.ts` | S02p → S24a (P4.0) → S24 (P4.1) |
| `lib/bookings-export-internal.ts` | S02p → S24i |
| `plan-view.tsx` | P0-Cs → S02u-plan → S22a (~~S25b~~ eliminada) |
| `patient-profile.tsx` | P0-Cs → S02u-perfil (P0.1) → S07v (P0.2) → S22b |
| `profile/hero.tsx` | S02u-perfil (P0.1) → S07v (P0.2) → S22h → S24r |
| `profile/tabs-bar.tsx`, `app/(app)/pacientes/[id]/page.tsx` | P0-Cs (solo la página) → S07v → S22b |
| `agenda-client.tsx` | S07u (P0.2) → P3-C → S19b |
| `agenda-utils.ts`, `booking-drawer/types.ts` | S07u → P3-C |
| `booking-drawer/index.tsx`, `status-actions.tsx` | S07u → S19c |
| `booking-drawer/reschedule-form.tsx`, `edit-details-form.tsx` | S07u → S19d |
| `authz-matrix.test.ts` | P0-Cs → S07sb → S27a → S26b |
| `tests/integration/portal.test.ts` | S02p → S24a → S24 |

2. **`lib/bookings.ts` y el core:** un dueño por ola. Nadie los toca en ES3 ni en ES4 (todo va por handoff).
3. **Sin dependencias de compilación dentro de una ola.** Los pasos seriales (P0.0, P2.0.0, P2.2.0, P3.0, P4.0) escriben antes tipos, zod, predicados, DTOs, props y **stubs con firma congelada**: `capabilities` + `booking-field-access`, `plan-authz-internal`, `plan-invariants-internal`, `agenda-plan-projection-internal`, `plan-edit-dialogs`, `plan-session-actions`, los tipos del portal. La única excepción conocida (el `assignTo` del modal en P0.2) va como handoff al integrador.
4. **Dependencias de runtime controladas:**
   - los tests arman los datos con `plan-factory`;
   - lo que ejecuta código de otra sesión de la misma ola es post-integración;
   - S11x corre en P2.2, cuando todo lo que ejecuta ya está integrado;
   - los archivos calientes se reemplazan con swap atómico;
   - los tests de carrera usan `advisory-wait` filtrado por clave;
   - la perf corre solo en el gate de ES, en solitario.
5. **Server antes que UI:** ES2b → ES3. Dentro de ES3, el kit (P3.1) va antes que las puertas (P3.2).
6. **Base de datos:**
   - M1, M2 (EV0), M3a (ES3), M4 (SR) y M5 (SV) nunca corren en paralelo con nada;
   - como máximo 5 agentes con integración a la vez;
   - tenants únicos y sin sweeps;
   - los advisory locks llevan `tenantId`.
7. **Entre corridas, todo es secuencial**, con commit de Martin en el medio.
8. **Riesgo en prod (04-oct):**
   - **no llega nada a prod hasta el cierre del bloque B**: ni el hotfix de ES1 ni M1 sola;
   - **no se mergea develop → main** hasta el gate final (después de EV1, orden del 07-oct);
   - el deploy final es reset de prod + `migrate deploy` desde vacío + bootstrap (07-oct); no hay hotfix de E0. Un fix urgente distinto sigue el procedimiento de hotfix del RUNBOOK.
9. **Lo que no se paraleliza:** M1; dos sesiones sobre el core; los pasos de contratos; el retiro (P3.Z.0) con el revisor; el E2E; los gates.

---

## 14. Gates y cierre

**Por sesión:** G (§6).

**Mini-integración entre olas de la misma ES:**
1. Integrador con los handoffs.
2. tsc en 0.
3. Unit UTC y AR.
4. Guard.
5. Integración del área en los 2 roles + los tests post-integración.

**Por ES** (en solitario sobre el Docker):
1. `npx next build` (env local, `NODE_ENV=production`).
2. `npm test` + `npm run test:tz-ar`, completos.
3. `npm run guard:isolation`.
4. `npm run test:integration` + `npm run test:integration:owner`, completos.
5. `PERF_OUT_DIR=<scratchpad> npm run test:perf && npx tsx tests/perf/compare.ts <scratchpad>`, sin regresiones fuera de umbral.
6. `npm run perf:bundle` (informativo, salvo los "no empeora" de ES3).
7. `npx tsc --noEmit -p tsconfig.scripts.json`.
8. Desde ES2a: `npx dotenv -e .env.local -- npx prisma migrate deploy` re-aplicado + `migrate status` + objetos.
9. ES4: `npm run test:e2e` (si PD-12 está lista).
10. 0 `it.fails("[Px-…")` de la ES sin dar vuelta.
11. `git status --porcelain` = la lista esperada. Si aparece algo más, **frenar**.

**Gate final del bloque B (cierre de ES4, decisión del 04-oct):** es el único que habilita el deploy. Lleva todo lo de "por ES", más `npm run test:e2e` (Playwright), la suite completa en TZ=UTC y TZ=AR, la integración completa con los 2 roles, `migrate deploy` de todas las migraciones pendientes de prod (las de B-pre si van en el mismo deploy, y M1) sobre una base local en el estado de prod y el QA completo en staging. Los gates por ES se mantienen como verificación en local, pero no habilitan ningún deploy.

**Cierre de cada corrida:**
1. Integrador.
2. Revisor(es) de solo lectura **del diff real**: 2 en ES1, ES2b y ES3; 1 en ES2a, ES4 y ES4b.
3. Fixer.
4. Gate.
5. Docs actualizados y **podados** (los hace el orquestador).
6. Memoria.
7. Aviso explícito de migraciones (solo ES2a).
8. Comando de commit exacto (lo ejecuta Martin).

**Reanudación:** nunca `resumeFromRunId` a ciegas. Se revisa `journal.jsonl` y se lanza un workflow chico con lo que falte.

---

## 15. Contratos literales en el prompt, por ola

| Antes de… | Contratos (literal) |
|---|---|
| P0.0 | C3, C8 (ES1), C11, C12, C14, nombres de tokens CSS, `ProgramCreate` (`startDate: 'YYYY-MM-DD'`) |
| P0.1 | Lo anterior + `assignableExerciseWhere`, `hcAccessError`, `plans-constants`, `canOperateBooking` / `canWriteClinical` / `bookingFieldAccess`. Además, por sesión: **C2** a S07i; **C6 + C7 puros (con las flags de autorización) + PD-07** a S07p; **C5 + P4 + P7 + V1 + R-LEGACY + M13** a S16p; estrategia de dedupe a S02x; C8 de sesiones a S02s; nivel `admin` + regla de compatibilidad a S02p; E0 a S02a, S02m y S07k |
| P0.2 | E1 completo (matriz, predicados, `bookingFieldAccess`, nivel `admin`, regla de re-vínculo, copago ignorado, `createPatient` con `assignTo`), C12 (6, 7, 35) |
| P1 | C1 literal (con las 2 tablas, la excepción del índice, la regla `Prisma.DbNull`, el down-script y el drift aceptado) + "drift aceptado, no borrar" + secuencia de 5 pasos de S10 + fixture legacy |
| P2.0.0 / P2.0 | C2-C9 (C8 con el contrato Secretaria), C12, C14, R-LEGACY, tabla de invariantes, gate de §5 (`plan-authz-internal`), §2.6 |
| P2.1 / P2.2 | Lo anterior + "P2.1 publica" + `plans-edit-types` (con `sessionIds` y `RenewAuthorizationInput`) + `plans-lifecycle-state` + C4 completa (reactivación, cobro previo) |
| P3.x | C9, C10 (`prefill`), C13, `AgendaHighlight`, props congeladas, PD-11, **preservar `canOperateBooking`, `canWriteClinical` y el gating de S07u** |
| P4.0 / P4.x | C4 (legacy: 00:00Z por fecha UTC), C5, C12 (§5.8, §5.16, §5.19, §5.21, §5.22, §5.24), §2.6 (identidad del portal, PD-14, PD-15), forma de `changes`, R-LEGACY del verificador, escenarios E2E, PD-12 |

---

## 16. Prechecks de prod (solo lectura, los corre Martin) y orden de deploy

> **Reset de prod (07-oct, plan §15.6): esta sección cambió de sentido.** Prod se resetea y la cadena completa se
> aplica desde vacío; no hay datos que chequear ni preservar. Quedan:
> - **(0)** rol con BYPASSRLS (sigue);
> - **(1)** pasa a **"base vacía"** (después del reset y antes de `migrate deploy`);
> - **(11)** y **(12)** pasan a **post-checks después del bootstrap** ([VERTICALES.md §9](VERTICALES.md));
> - **(17)** Storage privado (sigue);
> - **(2)-(10) y (13)-(16): eliminados** (eran de datos de prod). El dedupe, el ensayo de datos en staging, los backfills y
>   el down-script de M1 también se caen.
>
> El SQL de abajo queda con cada precheck marcado. El orden vigente es el bootstrap de VERTICALES.md §9 y
> MIGRACIONES-RUNBOOK §"Go-live con reset".

> Las columnas son `TIMESTAMP(3)` sin zona y guardan UTC.
> - Hora AR = `((col AT TIME ZONE 'UTC') AT TIME ZONE 'America/Argentina/Buenos_Aires')`.
> - "Ahora" comparable = `(now() AT TIME ZONE 'UTC')`.

```sql
-- (0) Rol que migra (DIRECT_URL) + B-pre aplicado y nada fallido
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at DESC NULLS FIRST LIMIT 6;
-- (1) BLOQUEANTE · desde el reset (07-oct) = BASE VACÍA, después del reset y antes de migrate deploy:
SELECT count(*) FROM pg_tables WHERE schemaname='public';   -- 0
-- (1) ORIGINAL (obsoleto por el reset): M1 no corrió (0 filas)
SELECT table_name, column_name FROM information_schema.columns WHERE
 (table_name='Booking' AND column_name IN ('programId','sessionId','pricedByPlan')) OR
 (table_name='TreatmentProgram' AND column_name IN ('discipline','practitionerId','serviceId','locationId','schedule','idempotencyKey','updatedAt','archivedAt')) OR
 (table_name='Session' AND column_name IN ('title','priceCents','archivedAt','updatedAt')) OR
 (table_name='Service' AND column_name='discipline') OR (table_name='EvaScore' AND column_name IN ('note','sessionId'));
SELECT typname FROM pg_type WHERE typname IN ('Discipline','ProgramPricingMode','PatientChangeRequestStatus');
--     además, todo NULL (M1 no creó las tablas ni los índices nuevos) y Patient_userId_key todavía presente
SELECT to_regclass('"ProgramAuthorization"'), to_regclass('"PatientChangeRequest"'),
       to_regclass('"Patient_id_tenantId_key"'), to_regclass('"Patient_tenantId_userId_key"');
SELECT to_regclass('"Patient_userId_key"');   -- NO null (lo dropea M1)
-- (2) ELIMINADO (reset de prod 07-oct) · BLOQUEANTE: duplicados (programId,index) → si >0: dedupe (ES1) dry-run → backup → --apply, en staging y en prod
SELECT "programId","index",count(*),array_agg(id) FROM "Session" GROUP BY 1,2 HAVING count(*)>1;
-- (3) ELIMINADO (reset de prod 07-oct) · BLOQUEANTE: integridad cross-tenant (0 en todas)
SELECT count(*) FROM "TreatmentProgram" p JOIN "Patient" pa ON pa.id=p."patientId" WHERE pa."tenantId"<>p."tenantId";
SELECT count(*) FROM "Session" s JOIN "TreatmentProgram" p ON p.id=s."programId" JOIN "Practitioner" pr ON pr.id=s."practitionerId" WHERE pr."tenantId"<>p."tenantId";
SELECT count(*) FROM "TreatmentProgram" p JOIN "ClinicalCase" c ON c.id=p."caseId" WHERE c."tenantId"<>p."tenantId" OR c."patientId" IS DISTINCT FROM p."patientId";
SELECT count(*) FROM "SessionExercise" se JOIN "Session" s ON s.id=se."sessionId" JOIN "TreatmentProgram" p ON p.id=s."programId"
  JOIN "Exercise" e ON e.id=se."exerciseId" WHERE e."tenantId" IS NOT NULL AND e."tenantId"<>p."tenantId";
-- (4) ELIMINADO (reset de prod 07-oct) · BLOQUEANTE: namespace de keys libre y montos sanos (0)
SELECT count(*) FROM "Booking" WHERE "idempotencyKey" LIKE 'plan:%';
SELECT count(*) FROM "Booking" WHERE "copagoCents" < 0;
-- (5) ELIMINADO (reset de prod 07-oct) · Volumen y estados (dimensiona el lock de M1)
SELECT count(*) FROM "Booking";
SELECT status,count(*) FROM "TreatmentProgram" GROUP BY 1;
SELECT count(*) total, count(*) FILTER (WHERE "completedAt" IS NULL) pendientes,
       count(*) FILTER (WHERE "completedAt" IS NULL AND "scheduledFor" < (now() AT TIME ZONE 'UTC')) vencidas FROM "Session";
SELECT count(*) FROM "TreatmentProgram" WHERE "totalSessions" > 60;
SELECT count(*) FROM "Patient";   -- dimensiona el índice nuevo y el DROP INDEX sobre Patient
-- (6) ELIMINADO (reset de prod 07-oct) · Varios ACTIVE por paciente (D9) y pacientes archivados con plan ACTIVE (L9)
SELECT "tenantId","patientId",count(*) FROM "TreatmentProgram" WHERE status='ACTIVE' GROUP BY 1,2 HAVING count(*)>1;
SELECT count(*) FROM "TreatmentProgram" p JOIN "Patient" pa ON pa.id=p."patientId" WHERE p.status='ACTIVE' AND pa."archivedAt" IS NOT NULL;
-- (7) ELIMINADO (reset de prod 07-oct) · Backfill del responsable: planes con >1 profesional y profesionales sin membresía aceptada
SELECT "programId",count(DISTINCT "practitionerId") FROM "Session" GROUP BY 1 HAVING count(DISTINCT "practitionerId")>1;
SELECT count(*) FROM "Session" s WHERE NOT EXISTS (SELECT 1 FROM "Practitioner" pr JOIN "Membership" m
  ON m."userId"=pr."userId" AND m."tenantId"=pr."tenantId" AND m."acceptedAt" IS NOT NULL WHERE pr.id=s."practitionerId");
-- (8) ELIMINADO (reset de prod 07-oct) · Legacy (ES4): convenciones de hora y contador vs filas (los que dan ≠ quedan exentos de I5 hasta "Completar datos")
SELECT to_char(s."scheduledFor",'HH24:MI') hhmm_utc,
       to_char((s."scheduledFor" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Argentina/Buenos_Aires','HH24:MI') hhmm_ar,
       s."completedAt" IS NOT NULL realizada, s."scheduledFor" >= (now() AT TIME ZONE 'UTC') futura, count(*)
FROM "Session" s GROUP BY 1,2,3,4 ORDER BY 5 DESC;
SELECT p.id,p.status,p."totalSessions",count(s.id) n,min(s.index) mn,max(s.index) mx FROM "TreatmentProgram" p
  LEFT JOIN "Session" s ON s."programId"=p.id GROUP BY p.id HAVING count(s.id)<>p."totalSessions" OR max(s.index)<>count(s.id) OR min(s.index)<>1;
-- (9) ELIMINADO (reset de prod 07-oct) · Candidatos de adopción (S25L): mismo día AR; las 00:00Z cuentan por su fecha UTC
WITH ses AS (SELECT s.id,p."tenantId",p."patientId",
   CASE WHEN to_char(s."scheduledFor",'HH24:MI:SS')='00:00:00' THEN s."scheduledFor"::date
        ELSE ((s."scheduledFor" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Argentina/Buenos_Aires')::date END dia
   FROM "Session" s JOIN "TreatmentProgram" p ON p.id=s."programId" WHERE s."completedAt" IS NULL AND p.status IN ('ACTIVE','PAUSED'))
SELECT count(DISTINCT ses.id) sesiones, count(DISTINCT b.id) turnos FROM ses JOIN "Booking" b ON b."tenantId"=ses."tenantId"
  AND b."patientId"=ses."patientId" AND b.status<>'CANCELLED'
  AND ((b."scheduledFor" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = ses.dia;
SELECT count(DISTINCT "seriesId") FROM "Booking" WHERE "seriesId" IS NOT NULL;
-- (10) ELIMINADO (reset de prod 07-oct) · Plantillas que hoy revientan + EVA por string
SELECT t.id,t.name,count(*) FILTER (WHERE e.id IS NULL) faltantes,count(*) FILTER (WHERE e."archivedAt" IS NOT NULL) archivados,
  count(*) FILTER (WHERE e."defaultSets" IS NULL OR e."defaultReps" IS NULL) sin_dosis FROM "PlanTemplate" t
  CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(t."exerciseIds")='array' THEN t."exerciseIds" ELSE '[]'::jsonb END) x(id)
  LEFT JOIN "Exercise" e ON e.id=x.id GROUP BY 1,2;
SELECT split_part(source,'-',1),count(*) FROM "EvaScore" GROUP BY 1;
-- (11) POST-CHECK después del bootstrap (07-oct; antes: BLOQUEANTE para el insert de tags): slug libre o ya DISCIPLINE; y DISCIPLINE ajenos a los 2
SELECT id,slug,kind FROM "Tag" WHERE slug IN ('kinesiologia','osteopatia') OR kind='DISCIPLINE';
-- (12) POST-CHECK después del bootstrap (07-oct) · Disciplina de servicios (PQ-11) y tier del tenant vivo (D16)
SELECT s.id,s.name,s."practiceId",pr.slug FROM "Service" s LEFT JOIN "Practice" pr ON pr.id=s."practiceId";
SELECT slug, plan FROM "Tenant";
-- (13) ELIMINADO (reset de prod 07-oct) · Duraciones fuera de 15..240 (un plan sobre ese servicio exige override)
SELECT id,name,"durationMin" FROM "Service" WHERE "durationMin" > 240 OR "durationMin" < 15;
SELECT "practitionerId","serviceId","durationMin" FROM "PractitionerService" WHERE "durationMin" > 240 OR "durationMin" < 15;
-- (14) ELIMINADO (reset de prod 07-oct) · Identidad del portal (S24a, PD-14/15): solo conteos, sin PII
SELECT count(*) FILTER (WHERE "userId" IS NOT NULL) vinculados, count(*) total FROM "Patient";
SELECT count(*) FROM (SELECT lower(email) FROM "Patient" WHERE email IS NOT NULL GROUP BY 1 HAVING count(DISTINCT "tenantId")>1) x;   -- emails en más de un consultorio
SELECT count(*) FROM (SELECT "tenantId", lower(email) FROM "Patient" WHERE email IS NOT NULL GROUP BY 1,2 HAVING count(*)>1) x;   -- fichas con el mismo email en un consultorio (no se vinculan solas)
-- (15) ELIMINADO (reset de prod 07-oct) · Pacientes asignados a ASSISTANT/BILLING (S07sp): si >0, reasignarlos con assignPatientToPractitioner antes del deploy
SELECT count(*) FROM "Patient" p
JOIN "Practitioner" pr ON pr.id = p."assignedPractitionerId"
JOIN "Membership" m ON m."userId" = pr."userId" AND m."tenantId" = p."tenantId"
WHERE m.role IN ('ASSISTANT','BILLING');
-- (16) ELIMINADO (reset de prod 07-oct) · Roles sin clinical.read × "Consultorio común" (S02p: dimensiona a quién le cambia la vista)
SELECT t.slug, t."sharedPatientView", m.role, count(*)
FROM "Membership" m JOIN "Tenant" t ON t.id = m."tenantId"
WHERE m.role IN ('ASSISTANT','BILLING')
GROUP BY 1,2,3;
-- (17) Storage (S02m): los buckets existen y son privados; ninguna policy de storage.objects para anon o authenticated
SELECT id, public FROM storage.buckets;
SELECT policyname, roles, cmd FROM pg_policies WHERE schemaname='storage' AND tablename='objects';
```

**Qué hacer con los resultados (vigente desde el reset del 07-oct):**
- (0) sin BYPASSRLS → usar el owner para `migrate deploy`.
- (1) ≠ 0 → **frenar**: el reset no quedó completo.
- (11) post-bootstrap: los 2 tags DISCIPLINE (`kinesiologia`, `osteopatia`) presentes y sin DISCIPLINE ajenos.
- (12) post-bootstrap: `Tenant.plan` y `vertical` del cliente kine como se configuraron desde /plataforma.
- (17) con algún bucket `public = true` o una policy para anon/authenticated sobre `patient-files` o `exercise-media` →
  **fuga de bloque A**: hacer privado el bucket y dropear la policy antes de abrir el consultorio.
- ~~(2) dedupe, (3)/(4) frenar, (15) reasignar, dimensionar D9/L9/D17/S25L/S25n/(14)/(16)~~: eliminados por el reset.

**Post-checks de M1** (siguen valiendo después de `migrate deploy` desde vacío, salvo los conteos que asumen datos previos):
- `pg_constraint` y `pg_indexes` con todos los nombres de C1;
- planes con sesiones y `practitionerId` null (esperado 0, salvo los que no pasaron el EXISTS);
- `SELECT count(*) FROM "Booking" WHERE "programId" IS NOT NULL OR "pricedByPlan"` = 0;
- tags DISCIPLINE = 2;
- RLS de las tablas nuevas: `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('ProgramAuthorization','PatientChangeRequest');` → `t, t` en las dos; `SELECT tablename, policyname FROM pg_policies WHERE tablename IN ('ProgramAuthorization','PatientChangeRequest');` → una policy `<tabla>_tenant_isolation` por tabla; `count(*)` = 0 en ambas;
- identidad: `to_regclass('"Patient_userId_key"')` = null y `to_regclass('"Patient_tenantId_userId_key"')` no null;
- `max(Booking.updatedAt)` es **solo informativo** (el turnero y el webhook escriben a cualquier hora). La garantía es el test de S10 "Booking.updatedAt intacto".

**Orden vigente (08-oct): un solo deploy al cierre de B, con reset de prod.** Corridas en develop: EV0 → ES2b → ES3 → SR → SV → ES4 → EV1 (commit de Martin entre corridas, nada a main). Al cierre: gate final en local (incluido Playwright) → staging desde vacío + QA → **reset de prod** → `migrate deploy` de la cadena completa (hasta M5) → bootstrap de [VERTICALES.md §9](VERTICALES.md) → post-checks (11), (12), (17) y los de M1. Comandos en [MIGRACIONES-RUNBOOK §"Go-live con reset"](MIGRACIONES-RUNBOOK.md).

<details><summary>Orden anterior (04-oct, deploy incremental sobre datos de prod) — <b>obsoleto por el reset</b></summary>

**Orden** (precheck → backup → staging → prod). Decisión del 04-oct: un solo deploy, al cierre del bloque B.

| Paso | Qué | Migración |
|---|---|---|
| 0 | Paso 0 (docs). Durante ES1, Martin corre los prechecks (0)-(17), de solo lectura, y el precheck de B-pre del RUNBOOK §2.2 ya corregido. Si (2) > 0: dedupe dry-run (en staging). Si (15) > 0: reasignar | No |
| 1 | ES1 → ES2a → ES2b → ES3 → ES4 (+ES4b) en develop, con commit de Martin entre corridas. **Nada a main.** Un hotfix urgente (por ejemplo las fugas E0, si Martin lo decide) va por el procedimiento del RUNBOOK: Martin crea `hotfix/*` desde main, el agente toca solo los archivos indicados con OK explícito, y se hace merge main → develop antes de la corrida siguiente | No |
| 2 | **Gate final del bloque B** (§14) en local, incluido Playwright | — |
| 3 | **Deploy final:** 1. re-correr los prechecks (0)-(4), (11), (13), (15) y (17); 2. si (2) > 0: dedupe según [MIGRACIONES-RUNBOOK §2.3](MIGRACIONES-RUNBOOK.md) (precheck → backup → dry-run → revisar → `--apply` → dry-run = 0, inmediatamente antes de M1 en ventana sin uso); 3. `npm run db:prod:backup`; 4. staging: `migrate deploy` de todas las migraciones pendientes, en orden (si B-pre va acá: `catalog_global` → `agenda_foundations` → `plans_booking_link`), post-checks y QA completo de B-pre y de "Planes" con TZ=UTC; 5. merge de develop a `main` en horario de poco uso. El build aplica las migraciones antes de servir el código. `plans_booking_link` tiene `lock_timeout` de 5 s; si falla: `migrate resolve --rolled-back` y reintento; 6. post-checks en prod (M1 y RLS de las 2 tablas) | **Sí: las pendientes de B, en orden; M1 una sola vez** |
| 4 | Post-deploy (Martin): confirmar `Service.discipline` del cliente → `normalize-plan-session-dates` en dry-run contra prod → decidir con los números → backup → `--apply` → recién ahí avisar al cliente de las acciones legacy (el script saltea igual lo vinculado). Import del catálogo y "Refrescar catálogo" si B-pre fue en este deploy | No |

</details>

**Rollback:** antes de abrir al cliente, re-reset y `migrate deploy` de nuevo. Después, se revierte el deploy (sin bajar migraciones). ~~El down-script de M1~~ quedó sin uso por el reset.

**Aviso explícito:** en todo Planes hay **1 migración nueva** (`plans_booking_link`, ES2a), que crea 2 tablas con RLS y **relaja** `Patient_userId_key` (excepción aprobada el 03-oct). ES1, ES2b y ES4 no traen migraciones. En el bloque B se suman **M2 `20261007120000_tenant_verticals`** (EV0), **M3a `20261008120000_billing_paid_at`** (ES3, P3.0.0; aplicada solo en local), **M4 `rooms`** (SR) y **M5 `reception_call_realtime`** (SV; antes "M3"), cada una sola en su ola.

---

## 17. Riesgos (detalle en la lista estructurada)

- M1 sobre Booking, una tabla caliente que el build auto-migra.
- ~~Duplicados que abortan M1.~~ (sin objeto: base vacía desde el reset del 07-oct)
- Deploy final grande, que incluye la extracción del core.
- Orden de locks y deadlocks.
- FKs simples bajo BYPASSRLS.
- Legacy exento del verificador (solo en develop hasta S27a/b; EV1 lo limpia).
- E2E dependiente de A0d (staging aislado) y de `.env.e2e.local`.
- ~~Consultas tardías (PQ-01 cambia el SQL)~~: PQ-01 respondida, ya está en C1.
- **Nivel "administrativo" (ES1):** toca la visibilidad de todo el sistema. Si una proyección nueva no lo respeta, la Secretaria vuelve a ver HC. Mitigación: corte central en `visibility.ts`, regla `=== 'full'`, revisor (b) que barre las exports y la columna ASSISTANT en `authz-matrix`.
- **`DROP INDEX "Patient_userId_key"` en M1:** primera migración no estrictamente aditiva, con ACCESS EXCLUSIVE breve sobre Patient. El código vivo tolera el cambio y el down-script recrea el índice solo si no hay userId repetidos.
- **Vínculo automático por email:** depende de que el email de la ficha sea correcto. Con más de una ficha con el mismo email no se vincula y se usa la invitación. Los datos financieros y de ejercicios salen solo con el vínculo.
- **Storage:** el estado de las policies en prod no se pudo verificar. Si abren `patient-files`, es una fuga de bloque A.
- **Fugas E0 vivas en prod hasta el reset + deploy final** (sin hotfix por decisión del 07-oct). **Data API** (`data-api-anon-sin-rls`): acción de consola de Martin ya, independiente del reset.
- **Un solo deploy grande al cierre de B** (B-pre + M1 + Planes, con la extracción del core): el QA de staging y el gate final son la única red antes de prod.
- Bundle y payload de la agenda.
- Tamaño de ES2b y ES3.
- PHI del título.
- Docker compartido entre agentes.
- `main` congelado varias semanas.

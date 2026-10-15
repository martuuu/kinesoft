# Verticales, /plataforma de consultorios y Sala de Espera en tiempo real

> **Fuente:** plan vigente `~/.claude/plans/necesito-que-asumas-el-piped-engelbart.md` §15 (07-oct-2026), volcado en el
> Paso 0 de la corrida EV0. **Este archivo es lo que copian los agentes de EV0, ES2b, ES3, SV, ES4 y EV1 en sus
> prompts:** los contratos C-EV1..C-EV9 y las enmiendas de §5 van **literales**, sin parafrasear.
> Planes sigue en [PLANES.md](PLANES.md); las enmiendas de §5 también están copiadas al tope de PLANES §10, §11 y §12.
>
> **Estado (14-oct):** EV0 ✅ (`ddfdff3`), ES2b ✅ (`58ec36f`), ES3 ✅ (`ad50059`), SR ✅ (`5811ea2`), SV ✅ (`d70513a`)
> y **EV1 ✅** (14-oct, en develop, sin migración). B y SV están en prod desde el go-live del 14-oct (migraciones
> incrementales, **sin reset**: §6 y §9 quedan como historia). Cierres en [AUDIT.md §Ronda 16](AUDIT.md), §Ronda 18-20 y
> §Ronda 23 (EV1); QA en [QA.md §EV0](QA.md), §Sala de Espera realtime (SV) y §EV1; diseño en
> [ARCHITECTURE.md ADR-005 y ADR-006](ARCHITECTURE.md). **Siguiente: VX** → ES4 → DIR (decisión 4 de Martin, 14-oct).

## 0. Contexto: decisiones de Martin del 07-oct

Estado al decidir: ES1 (`d7ac75f`) y ES2a (`0edb0c8`, M1) commiteadas, árbol limpio. Pendientes: ES2b → ES3 → ES4.

1. **Prod se resetea antes del go-live** (reset total, el cliente vuelve a cargar). Se pueden escribir migraciones
   libremente (igual: una migración encabeza su ola sola, nunca se edita una commiteada).
2. **Verticales del SaaS:**
   - **Consultorio General** (ej. cardiología, con Secretaria y profesionales): Dashboard, Agenda, Pacientes,
     Facturación/cobros, Obras sociales, Configuración + **Sala de Espera**. Sin Sesiones/Seguimiento, Planes,
     Diagnóstico ni Ejercicios.
   - **Consultorio Kinesiología** (lo actual, Kine + Osteo): todo. **Kine base**: ejercicios **solo propios** del
     consultorio. **Kine PRO**: se le suma automáticamente todo el catálogo cargado en Plataforma.
3. **Sala de Espera para las dos verticales**: panel de staff completo, **realtime de verdad** (acciones casi
   instantáneas; polling solo como último fallback, ~60 s). La **pantalla TV** se difiere a la fase con Mercado Pago
   (bloque D).
4. **/plataforma (superadmin)**: ver y configurar todos los consultorios (tipo, plan, turnero público, etc.). El
   consultorio, en su Configuración, habilita el turnero público y futuras opciones.
5. **No se rehace el planning de P2-P4**: se ejecuta como está; lo nuevo entra en **corridas nuevas** y como
   **enmiendas de una línea** a sesiones pendientes (§5).

**Etiqueta en la UI (BO3, 14-oct, decisión de producto §19.6 ítem 1):** la vertical `GENERAL` se muestra como
**«Clínica general»** (no «Consultorio general», que se confundía con «el consultorio» de cualquier vertical):
`VERTICAL_LABEL` en `lib/tenant-modules.ts:152`, ya aplicado en todo el copy (onboarding, Plataforma, confirmaciones). Un
PRACTITIONER de Clínica general se rotula «Profesional», no «Kinesiólogo/a» (`roleLabel` por vertical). En este doc
«General» sigue siendo el nombre corto.

**Ojo con los nombres:** "vertical" = tipo de consultorio (`Tenant.vertical`: General / Kinesiología). No es la
**disciplina** de un servicio o plan (Kine / Osteo) ni el **plan SaaS** del tenant (`Tenant.plan`: FREE / STARTER /
PRO / ENTERPRISE). "Kine PRO" = vertical KINESIOLOGY + `plan = PRO`.

**Glosario de copy (fijado en la revisión de EV0):** el turnero público se llama **"Turnos online"** en toda la UI
(switch, columna de /plataforma, link "Ver la página de turnos"; estados "Activo" / "Apagado"); el dueño del consultorio
es el **"Titular"** (no "Owner"). "Turnero" queda como palabra interna de docs y código.

**Relevamiento del 07-oct (por qué hace falta EV0):**
- no hay gating por tenant (solo `Tenant.plan` para ejercicios/plantillas/favoritos, `lib/plan-gating.ts`);
- nav estático y duplicado (`sidebar.tsx`, `topbar.tsx`);
- `/diagnostico`, `/seguimiento`, `/biblioteca`, `/terapia-manual` sin guard;
- `/plataforma` solo administra catálogos (no hay tenants);
- el turnero no tiene switch por consultorio;
- Recepción existe (`lib/reception-state.ts`, `?view=reception`) pero nada se actualiza entre usuarios;
- Realtime `postgres_changes` no entregaría nada con nuestras policies (GUC) y las cookies son httpOnly.

## 1. Hallazgo crítico de bloque A: Data API (independiente de todo)

9 tablas de `public` **no tienen RLS** (`UserProfile`, `UserPreferences`, `Favorite`, `Tag`, `ExerciseTag`,
`ConditionTag`, `ConditionExerciseLink`, `AnatomicalRegion`, `ConditionAnatomy`) y las policies no son `TO <rol>`. Si
el proyecto de Supabase tiene la **Data API (PostgREST)** exponiendo `public` con los grants por defecto, la **anon key
(pública)** podría leer emails y **escribir `UserProfile.isPlatformAdmin`**. La app nunca usa PostgREST.

- **Martin, en la consola de prod:** Settings → API → Data API: si `public` está expuesto, **desactivarla** (o quitar
  `public` de los schemas expuestos). Precheck de solo lectura:
  `SELECT relname, relrowsecurity, has_table_privilege('anon', oid, 'UPDATE') FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r';`
- **Código (EV0, M2) ✅:** bloque guardado `REVOKE ALL ON ALL TABLES/SEQUENCES/ROUTINES IN SCHEMA public FROM anon,
  authenticated` + `ALTER DEFAULT PRIVILEGES … REVOKE …`, solo si los roles existen (Docker local no los tiene: NOTICE +
  no-op; `tenant-verticals-m2.test.ts` lo ejecuta con roles temporales). Guard 3c de `guard:isolation`: falla ante un
  GRANT a `anon`/`authenticated` en migraciones o `prisma/roles.*.sql`, o si el bloque REVOKE desaparece.

AUDIT: `data-api-anon-sin-rls` (bloque A, crítico): código cerrado; **la acción de consola de Martin sigue pendiente**.

## 2. Orden de corridas

| # | Corrida | Qué | Migración |
|---|---|---|---|
| 1 | **EV0** ✅ (`ddfdff3`) | Tipo de consultorio + matriz de módulos + guards + nav único + turnero con switch + onboarding con vertical + /plataforma de consultorios + REVOKE de la Data API | **M2 `tenant_verticals`** (sola, V.0) |
| 2 | ES2b (P2) ✅ (`58ec36f`) | Como está planificada + simplificaciones del reset (§6) + enmiendas (§5) | — |
| 3 | ES3 (P3) ✅ (`ad50059`) | Ídem + S14r (ingresos reales del dashboard, Mes/Semana; decisión 6 del 08-oct, [PLANES §11](PLANES.md)) | **M3a `billing_paid_at`** (sola, P3.0.0) |
| 3b | **SR** ✅ (`5811ea2`) | Salas/Consultorios: sala por franja y por turno, conflicto y bloqueo de sala, filtro y vista "Por sala" ([ARCHITECTURE §Salas](ARCHITECTURE.md)). **Aplica a General y Kinesiología sin módulo nuevo**: la agenda existe en las dos verticales y un consultorio sin salas cargadas ve todo igual que antes | **M4 `20261009120000_rooms`** (sola) |
| 4 | **SV** ✅ (`d70513a`) | Sala de Espera realtime (transporte, "Llamar", avisos, `/sala`, agenda en vivo); el evento y "Llamar" llevan `roomId` (§7) | **M5 `20261013120000_reception_call_realtime`** (sola) |
| 5 | ES4 (P4) | Ídem, sin las sesiones de legacy; S26a/S26b cubren verticales y realtime | — |
| 6 | **EV1** ✅ (14-oct) | Barrido de la vertical General (dashboard, perfil, copy neutral —"Kinesiólogo" en users-panel, step-team, placeholder de steps-catalog y hero "Kinesiólogo asignado"; "Título (diagnóstico)" en modal/drawer de turno—, lista de pacientes, `isBasic` muerto en Plataforma —tag "Común/Pro", toggle del exercise-drawer, `validation.ts`—, link a `/biblioteca` del exercise-drawer en tenant General, canal de soporte para el "escribinos") + limpieza R-LEGACY opcional (no se hizo: R-LEGACY y los sobrevivientes de `programs.ts` se quedan, decisiones del 08-oct). Cierres en [AUDIT §Ronda 23](AUDIT.md) | — |
| 7 | ~~Deploy único de B~~ | Reemplazado por el go-live del 14-oct: migraciones incrementales sobre la base viva, sin reset ([GO-LIVE-PASO-A-PASO.md](GO-LIVE-PASO-A-PASO.md)) | — |

**Orden vigente (14-oct, decisión 4 de Martin):** ES3 ✅ → SR ✅ → SV ✅ → IAM ✅ → BO ✅ → EV1 ✅ → **VX** → ES4 → DIR. SR fue
antes de SV para que el evento y "Llamar" nacieran con la sala.

SV va entre ES3 y ES4 porque necesita `lib/bookings.ts` (S12, ES2b), `agenda-client.tsx` y `reception-row.tsx` (ES3)
ya cerrados, y así la matriz authz y el E2E de ES4 la cubren. No comparte archivos con ES4 salvo
`authz-matrix.test.ts` y `package.json` (handoff).

## 3. Modelo y contratos (EV0)

**M2 `20261007120000_tenant_verticals`** (aditiva):
```sql
CREATE TYPE "TenantVertical" AS ENUM ('GENERAL','KINESIOLOGY');
ALTER TABLE "Tenant" ADD COLUMN "vertical" "TenantVertical" NOT NULL DEFAULT 'KINESIOLOGY';
ALTER TABLE "Tenant" ADD COLUMN "publicBookingEnabled" BOOLEAN NOT NULL DEFAULT false;  -- opt-in (EV-D2)
-- + bloque guardado REVOKE anon/authenticated (§15.1)
```
"Kine PRO" sigue siendo `plan = PRO` del enum existente. Sin tabla nueva → `guard:isolation` no cambia. Sin
`features Json`: columnas explícitas.

### 3.1 Matriz de módulos (`modulesFor`, pura)

| Módulo | GENERAL | KINE FREE (sin suscripción) | KINE STARTER = "Base" | KINE PRO/ENT |
|---|---|---|---|---|
| agenda · pacientes · facturacion · obrasSociales · salaEspera | ✓ | ✓ | ✓ | ✓ |
| turneroPublico | = switch | = switch | = switch | = switch |
| reportes | ✗ | ✓ | ✓ | ✓ |
| planes · sesiones · diagnostico · evaluaciones · ejercicios (solo propios) | ✗ | ✓ | ✓ | ✓ |
| plantillas · favoritos | ✗ | ✗ | ✓ | ✓ |
| ejerciciosGlobales (catálogo de Plataforma) | ✗ | ✗ | ✗ | ✓ |

Invariantes con test: sesiones ⇔ planes; plantillas ⇒ planes; favoritos/ejerciciosGlobales ⇒ ejercicios; Kine
monótono FREE ⊆ STARTER ⊆ PRO; GENERAL sin módulos Kine. **Cambio de comportamiento:** FREE/STARTER dejan de ver los
globales `isBasic` (Biblioteca arranca vacía → empty state "Creá tu primer ejercicio · PRO suma el catálogo de la
plataforma").

**Salas (SR, 08-oct):** no son un módulo. Van con `agenda` (y Configuración › Sedes), así que aplican igual a General y
Kinesiología en cualquier plan; la barrera es la capability (`schedule.configure` para escribir salas,
`agenda.manageBlocks` para bloquearlas), no `modulesFor`. Lo único de Planes que toca la sala (estampar la sala por
defecto al generar turnos) ya está detrás del módulo `planes`.

### 3.2 Contratos literales (van tal cual a los prompts)

- **C-EV1 `lib/tenant-modules.ts`*** (puro): `TENANT_MODULES`, `TenantModule`, `TenantEntitlements = {vertical, plan, publicBookingEnabled}`, `modulesFor(e)`, `isPublicBookingOpen(e)`, `isProfileTabAllowed(tab, m)`, `MODULE_DENIED_COPY` (voseo), `VERTICAL_LABEL`, `PLAN_LABEL`.
- **C-EV2 `lib/nav.ts`*** (puro): `NAV_ITEMS` (con `module?`/`capability?`), `navFor(modules, caps)`, `shortcutsFor(modules)`. **Única fuente** de sidebar, topbar y atajos ⌘K. "Sala de espera" apunta a `/agenda?view=reception` hasta que SV cree `/sala`. **SV11a ✅: apunta a `/sala`.**
- **C-EV3 `lib/session.ts`**: `Actor.entitlements` desde la fila de tenant que `buildActor` ya lee (`:78`), sin queries extra.
- **C-EV4 `lib/authz.ts`**: `getTenantModules()`, `assertModule(actor, m)`, `requireModule(m)`, `guardModuleSegment(m)` (para `layout.tsx`, redirige a `/dashboard`). **Regla:** lecturas compartidas devuelven vacío sin el módulo; escrituras y lecturas de detalle tiran. El layout es UX; la barrera es la action.
- **C-EV5 `lib/tenant-entitlements-internal.ts`*** (server-only): `applyTenantEntitlementsInTx(tx, {tenantId, source, patch, expectedUpdatedAt?, actor})` con allowlist por `source` (`platform`: todo; `tenant-settings`: solo `publicBookingEnabled`; `onboarding`: `vertical` mientras el onboarding siga abierto; `billing`: `plan/subscriptionStatus/trialEndsAt`, para el futuro webhook de MP). FOR UPDATE + CAS + audit en el **tenant afectado**. **Único escritor** de esas columnas después de `bootstrapTenant`. `getTenantModulesById(tenantId)` para portal y turnero (sin Actor).
- **C-EV6 `lib/audit.ts`**: `auditPlatformInTx` → audita en `affectedTenantId` con `action: "platform.*"` y `payload.platform.actorHomeTenantId`.
- **C-EV7 `lib/cache-tags.ts`**: `tenantEntitlementTags(t)` revalidados después del commit.
- **C-EV8** `components/layout/tenant-modules-context.tsx`*: `useTenantModules().has(m)` (default fuera del provider = set Kine PRO, solo UI).
- **C-EV9 `lib/plan-gating.ts`** (aditivo, firmas C8 intactas): `resolveCapabilities(plan, tenantId, vertical = "KINESIOLOGY")` + `catalogScope: "none"|"own"|"full"`; `canCreate`/`canFavourite`/`canBuildTemplates`/`hasFullCatalog` salen de los módulos.

(`*` = archivo nuevo.)

## 4. Corrida EV0 (sesiones, archivos disjuntos)

| Ola | Sesión | Archivos (* nuevo) |
|---|---|---|
| V.0 (sola) | **EV-M** migración M2 | `prisma/schema.prisma`, `…/20261007120000_tenant_verticals/migration.sql`*, `tests/helpers/tenant-factory.ts` (opts `vertical/plan/publicBookingEnabled`, default de tests `true`), `tests/integration/tenant-verticals-m2.test.ts`*, guard de grants `anon/authenticated` |
| V.0b | **EV-C1** módulos + actor + guards | `lib/tenant-modules.ts`*, `lib/nav.ts`*, `lib/session.ts`, `lib/authz.ts`, `tests/unit/tenant-modules.test.ts`*, `tests/integration/module-guards.test.ts`* |
| V.0b ∥ | **EV-C2** escritor único + audit | `lib/tenant-entitlements-internal.ts`*, `lib/audit.ts`, `lib/cache-tags.ts`, `tests/integration/tenant-entitlements.test.ts`* |
| V.1 | **EV-S** shell y nav | `app/(app)/layout.tsx`, `components/layout/{app-shell,sidebar,topbar}.tsx`, `tenant-modules-context.tsx`*, render test* |
| V.1 | **EV-Gd** guards de segmento | `app/(app)/{diagnostico,seguimiento,biblioteca,terapia-manual,reportes}/layout.tsx`* (no toca `page.tsx` de S20/S23), test* |
| V.1 | **EV-G** catálogo y ejercicios | `lib/plan-gating.ts`, `tests/unit/plan-gating.test.ts`, `lib/search.ts`, `lib/conditions.ts`, `components/biblioteca/biblioteca-client.tsx`, `tests/integration/exercise-entitlements.test.ts`* |
| V.1 | **EV-T** turnero con switch | `lib/public-booking.ts`, `lib/public-booking-internal.ts`, `app/(booking)/c/[slug]/booking/page.tsx`, `components/booking/booking-unavailable.tsx`*, `tests/integration/public-booking-disabled.test.ts`* (no se toca webhook MP §5.4 ni middleware §5.3) |
| V.1 | **EV-K** Configuración | `lib/tenant-settings.ts`, `configuracion/page.tsx`, `configuracion-client.tsx`, `controls.tsx` (tab Diagnósticos solo con `diagnostico`), `panels/general-panel.tsx` ("Funciones del consultorio": switch del turnero + tipo y plan de solo lectura), test* |
| V.1 | **EV-O** onboarding | `lib/validation.ts` (un campo), `lib/onboarding.ts`, `lib/onboarding-internal.ts`, `lib/tenant-bootstrap.ts`, `components/onboarding/steps-basic.tsx` (segmentado "Kinesiología y osteopatía" / "Clínica general" desde BO3), `scripts/create-tenant.ts --vertical`, `tests/integration/onboarding.test.ts` |
| V.1 | **EV-P1** plataforma server | `lib/platform-tenants{,-schemas,-types,-read}.ts`* (todo `prismaService` + `requireSuperAdmin` por export; solo `count`/`_count` sobre modelos con PHI), tests* |
| V.1 | **EV-P2** shell de plataforma | `app/(app)/plataforma/layout.tsx` (sub-nav Resumen · Consultorios · Ejercicios · Tags · Catálogo), `components/plataforma/platform-nav.tsx`* |
| V.2 | **EV-P3** plataforma UI | `app/(app)/plataforma/page.tsx`* (resumen por vertical × plan, trials por vencer, onboarding pendiente), `consultorios/page.tsx`* (lista con filtros), `consultorios/[id]/page.tsx`* (detalle + Drawer "Editar suscripción" con `useConfirm` al cambiar de vertical y `expectedUpdatedAt`), componentes* + render test |
| V.Z | integrador → 2 revisores de solo lectura ((a) authz, entitlements, PHI, turnero, audit, grants; (b) UX, nav, copy, guards) → fixer → gate → docs → memoria → commit | |

Se mantiene la ruta **`/plataforma`** (ya existe y está guardada); "Plataforma" pasa a una sola entrada de nav. Sin
impersonación ni billing SaaS (diferidos; el webhook de MP será `source:"billing"`).

**Gate de EV0** (en solitario):
- `next build`, unit en TZ=UTC y TZ=AR, integración completa con los 2 roles, `migrate deploy` re-aplicado en local +
  `migrate status`, guard, `tsc -p tsconfig.scripts.json`, perf + `compare.ts`.
- **grep 1:** ningún write de `vertical/plan/subscriptionStatus/trialEndsAt` fuera de `tenant-entitlements-internal.ts`
  / `tenant-bootstrap.ts`. **Excepción:** los seeds (`prisma/seed.ts`, `scripts/seed-*`) escriben `plan` al crear datos
  demo; no corren en prod ni los corre el agente.
- **grep 2:** un `requireSuperAdmin` por export en `lib/platform-tenants*.ts`.
- **grep 3:** 0 `prismaService.(patient|booking|session|…).find*` en `lib/platform-tenants*`.
- **Integración clave (lo que cubre EV0):** guards de segmento (`/diagnostico`, `/seguimiento`, `/biblioteca`,
  `/terapia-manual`, `/reportes` → `/dashboard` sin el módulo); catálogo (KINE FREE no lista ni asigna globales, PRO sí;
  GENERAL rechaza alta de ejercicios, tags y favoritos; facetas sin condiciones); condiciones (escrituras tiran, lista
  `[]`, ⌘K filtrado por tenant); `lib/programs.ts` (GENERAL → Forbidden sin escribir, lecturas `[]`); turnero apagado →
  slots `[]`, submit rechazado sin escribir y sin prefill (el estado de un turno existente sigue funcionando); plataforma
  (superadmin edita el tenant B → audit en B, nada en su tenant; un OWNER no superadmin → Forbidden; CAS stale → sin
  cambios). **No en EV0:** las pestañas Plan/Sesiones del perfil, `lib/sessions.ts`, el dashboard y el diagnóstico server
  llegan con ES2b/ES3 por las enmiendas de §5 (P2-C1, S12b, S14, S17d, S22b).
- **QA manual:** [QA.md §EV0](QA.md). Ojo: después de cambiar la vertical desde /plataforma, el nav del layout **no se
  repinta en navegación suave** (los guards de segmento sí redirigen): hay que recargar. Aceptado en EV0.

**Billing futuro:** el webhook de MP de la suscripción usa `source:"billing"` y **deriva el `tenantId` del pago
verificado** contra la API de MP (nunca del body ni de la query).

## 5. Enmiendas de una línea a sesiones pendientes (se copian literal en sus prompts)

- **Verticales:**
  - **P2-C1**: `assertPlanManageInTx`/`assertPlanScheduleInTx`/`assertPlanAuthorizeInTx` arrancan con `assertModule(actor,'planes')`; `plan-authz.test.ts` suma "tenant GENERAL (OWNER) → Forbidden".
  - **S13**: disciplina del servicio solo con `planes` (UI y server).
  - **S13x**: `createExercise`/`ensureTag` exigen `gate.canCreate` (**ya hecho en EV0 V.Z, N2: S13x lo preserva**); claves de `unstable_cache` con `gate.catalogScope` (`lib/exercises.ts`, `lib/diagnosis.ts`).
  - **S14**: sin `planes`, `getDashboardData` no consulta planes/sesiones y devuelve 0.
  - **S12b**: cada export de `lib/sessions.ts` exige `sesiones` (`listOpenSessions` vacío sin el módulo).
  - **S17d**: `loadCatalog` (vacío), `getDiagnosisPlanPrefill`, `createPlanFromDiagnosis` exigen `diagnostico`.
  - **S17d** (revisión EV0): `searchPatientsForAssignment` (`lib/diagnosis.ts`) exige `diagnostico` (`[]` sin el módulo).
  - **S22b** (revisión EV0): `recordEvaScore` (tira) y `getPatientEvaScores` (`[]`) de `lib/patients.ts` exigen `evaluaciones`.
  - **S14** (revisión EV0): `getSessionsChart` sin `sesiones` devuelve 0 sin consultar. La clave de `unstable_cache` del dashboard no lleva los módulos: S14 se apoya en el tag `tenantEntitlementTags(tenantId)` (lo revalida el escritor único) para no servir un slot viejo tras un cambio de vertical.
  - **S15 / S27a** (revisión EV0): los exports de `lib/programs.ts` que sobrevivan mantienen `requireModule('planes')` (escrituras) y `[]` sin el módulo (lecturas); mover o retirar código no se lleva el gate.
  - **S17t / S21t**: plantillas solo por `gatingForActor(tx).canBuildTemplates` / `has('plantillas')`.
  - **S20 / S23**: el guard de módulo vive en el `layout.tsx` de EV0; no se duplica ni se borra.
  - **S21**: `app/(app)/planes/layout.tsx` = `guardModuleSegment('planes')`; la entrada de nav y el atajo van **solo** en `lib/nav.ts`; `sidebar.tsx`, `topbar.tsx` y `lib/search.ts` salen de su lista.
  - **S22b**: pestañas con `isProfileTabAllowed` + rol; sin `planes` no carga planes ni saldos; los mocks de `getActor` suman `entitlements`.
  - **S19b / S19c / S18b**: leyenda/filtro de plan, puerta 4, "Agendar próxima sesión", "Vincular", "Crealo como plan…" solo con `has('planes')`.
  - **S24 / S24e / S24d**: el portal usa `getTenantModulesById` (turnos de plan con `planes`, check-in con `evaluaciones`, `/ejercicios` con `ejercicios`, "Reservar turno" con `turneroPublico`).
  - **S32**: columna y chips de plan solo con `planes`.
  - **S26b**: columna "tenant GENERAL (OWNER)" en la matriz + "KINE FREE no asigna globales". **S26a**: escenario General (sin nav clínico; `/diagnostico` → `/dashboard`).
  - **P2.Z(b)**: el revisor verifica que ningún export de Planes/Sesiones/Diagnóstico/Ejercicios quede sin gate de módulo.
- **Realtime (para que SV no toque archivos de planes):**
  - **P2-C1** suma `lib/booking-events-internal.ts`* (server-only, firma congelada): `BookingChangeRef = {bookingId, practitionerId, scheduledFor, prev?, kind?}` y `afterBookingsCommitted(tenantId, refs, opts?)`; hoy solo hace lo de `invalidateBookingDerivedCaches` y nunca tira; SV le suma el publish sin cambiar la firma. **SV04a ✅: publica después de invalidar, firma intacta.**
  - **S07c**: `invalidateBookingDerivedCaches` → `afterBookingsCommitted(actor.tenantId, refs)` en cada write-path de `bookings.ts`, después del commit y fuera de `runWithRls`; `BookingUpdateTxOutcome.ok` suma `refs`.
  - **S12, S11e, S12b, S15, S16a, S16b, S25a, S17d**: todo write-path que crea, mueve, cambia estado/cobro, cancela o borra un `Booking` llama `afterBookingsCommitted` una vez después del commit; los `*InTx` **devuelven** refs y nunca emiten adentro.
  - **SV01** ✅: `kinesoft_realtime_can_read` es INVOKER, `search_path=''`, con EXECUTE a `PUBLIC` (sin GRANT a `anon`/`authenticated`: guard 3c verde, sin allowlist).

## 6. Simplificaciones por el reset de prod (sin rehacer el planning)

> **Historia:** el reset no ocurrió (go-live del 14-oct con migraciones incrementales). Se deja por las decisiones que
> sí siguen (sesiones de legacy eliminadas, R-LEGACY).

- **Se caen:** S25L (legacy server), S25n (script de fechas legacy), S25b (UI legacy), "Completar datos", PQ-14,
  escenario E2E "legacy", los prechecks de datos (2)-(10) y (13)-(16), corridas del dedupe, ensayo de datos en staging,
  backfill de `agenda_foundations` y `normalize-patient-emails`, el down-script/ventana sin uso de M1 y el hotfix de E0
  (prod se resetea; ver §1 igual).
- **Se mantienen:** S25a (adopción de turnos sueltos sigue siendo útil con datos nuevos), S27a/S27b (retiran las altas
  viejas), las invariantes I1-I8, precheck (0) rol con BYPASSRLS, (17) Storage privado, P3009 liviano, el SQL de M1 tal
  cual (commiteado).
- **R-LEGACY:** se deja como está en ES2b/ES3 (es barato y protege `develop` mientras conviven las altas viejas); EV1 lo
  limpia después de S27a/b, opcional (**EV1 no lo tocó**: se deja). **ES3:** S27a/b ya retiraron las altas viejas; efecto nuevo: un plan sin
  responsable/servicio ya no acepta sesión "a medida" ("Plan inválido."). Decisión de Martin pendiente (recomendado
  dejarlo por el reset; PLANES §11 «Decisiones de ES3»). En EV1 también se recomienda retirar los sobrevivientes de
  `lib/programs.ts` (`setProgramStatus`, `deleteProgram`, `deleteSession`).
- **Prechecks:** (1) pasa a "base vacía"; (11) y (12) pasan a post-checks después del bootstrap.

## 7. Corrida SV · Sala de Espera realtime ✅ (13/14-oct-2026, `d70513a`)

Planning en el plan vigente §18 (manda sobre el §15.7 original que vivía acá). Lo que quedó, en una línea por tema;
el detalle está en [ARCHITECTURE.md §Sala de Espera realtime + ADR-006](ARCHITECTURE.md), la seguridad en
[SECURITY.md §17](SECURITY.md), la consola en [EXTERNAL-CONFIG.md §3.1](EXTERNAL-CONFIG.md), el QA en
[QA.md §SV](QA.md) y los hallazgos en [AUDIT.md §Ronda 20](AUDIT.md).

- **Transporte:** Broadcast privado `tenant:<id>:agenda`; publica solo el server, después del commit, desde
  `afterBookingsCommitted` (1 POST, tope 1,5 s, breaker); el browser se suscribe con un token HS256 de 10 min
  (`kid` opcional). Drivers `off` (default, app idéntica a SR) · `local` (SSE, solo dev) · `supabase`.
- **Quién lo usa:** módulo `salaEspera` (General y Kinesiología) + capability `agenda.reception`. BILLING queda afuera
  aunque tenga `agenda.viewAll`, y sigue con su agenda sin canal.
- **M5 `20261013120000_reception_call_realtime`** (sola): `Booking.calledAt` + CHECK, `kinesoft_realtime_can_read`,
  policy guardada `FOR SELECT TO authenticated`. Aplicada solo en el Docker local; `migrate status` = 32.
- **Estado «Llamado»** y acción «Llamar» (profesional en sus turnos; Secretaria/OWNER/ADMIN en todos). Mover un turno
  a otro día AR limpia llegada, llamado y atención.
- **`/sala`** (nav «Sala de espera» → `/sala`; `/agenda?view=reception` sigue abriendo): tablero de hoy por
  profesional o por sala, con proyección sin PHI clínica en el server (`listSalaBookings`). Con `off` pollea cada 60 s.
- **Agenda y Recepción en vivo** (con `off`, idénticas a SR y sin polling). **Avisos** «Llegó …» (profesional del
  turno con `clinical.read`) y «Pase …» (quien opera la agenda de todos y no es ese profesional), visual por defecto,
  sonido opcional.
- **Pendiente de Martin:** R1-R4 y V1-V7 (EXTERNAL-CONFIG §3.1); deploy en escalones `off → env → staging → supabase`
  (RUNBOOK «Deploy de SV»).
- **Diferido:** pantalla TV y notificaciones persistidas en la campana (D), leader election multi-pestaña (C1),
  horarios de Configuración en vivo (EV1), presencia y perfil/facturación/dashboard en vivo (C2).

## 8. Decisiones con default (rigen si Martin no dice otra cosa)

| ID | Decisión | Default |
|---|---|---|
| EV-D1 | Plantillas de plan | Kine STARTER ("Base") y PRO; FREE = sin suscripción (sin plantillas ni favoritos) |
| EV-D2 | Turnero en un consultorio nuevo | Apagado (opt-in) desde Configuración o /plataforma |
| EV-D3 | Reportes en General | Oculto (es placeholder) |
| EV-D4 | Turnero apagado | Página "Turnos online no disponibles" con contacto, `noindex` |
| EV-D5 | Quién cambia la vertical | Solo /plataforma (y el OWNER durante el onboarding) |
| EV-D6 | Qué edita /plataforma | Vertical, plan, estado de suscripción, trial, turnero (datos y `sharedPatientView` solo lectura) |
| SV-D1 | Transporte | Broadcast privado con token acuñado por el server |
| SV-D2 | Secretaria "Llama" en nombre del profesional | Sí |
| SV-D3 | Avisos de llegada persistidos en la campana | No (toast + sonido; la campana no es en vivo) |
| SV-D4 (**enmendada** 13-oct) | Aviso por defecto | **Visual para todos**; el sonido lo prende cada usuario (Configuración → General o Agenda ⋯) |
| SV-D5..D16 | Llamar, claims, publish esperado, `/sala` solo hoy, a quién se avisa, colapso, `local` en prod, `refs: []`, agrupación, multi-pestaña, `kid`, toasts | Plan §18.14; resumen en [ARCHITECTURE.md ADR-006](ARCHITECTURE.md) |

## 9. Bootstrap después del reset (orden de prod)

> **Historia:** no se usó (go-live sin reset, 14-oct). El orden real está en [GO-LIVE-PASO-A-PASO.md](GO-LIVE-PASO-A-PASO.md).

1. `migrate deploy` desde vacío (cadena completa: … `catalog_global` → `agenda_foundations` → M1 → M2 → M3a → M4 → M5).
2. Roles SQL.
3. Import del catálogo global.
4. `create-tenant --vertical kinesiologia` (casa de la plataforma).
5. `set-platform-admin`.
6. Desde /plataforma: plan del cliente kine (PRO u otro) y **prender turnos online** por consultorio (nacen apagados; también desde Configuración → General).
7. Data API desactivada.
8. Storage privado.

Comandos y post-checks en [MIGRACIONES-RUNBOOK.md §"Go-live con reset"](MIGRACIONES-RUNBOOK.md).

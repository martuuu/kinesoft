# Fase B — Fundaciones Etapa 2 · Plan de ejecución

> Audit profundo + plan concreto de la Fase B del [ROADMAP.md](ROADMAP.md): splits → tests → RLS
> wholesale → multi-profesional → realtime. Cada ola con cut-points exactos, mapa de riesgo y qué
> necesita del dueño (migración/QA). **Ruta crítica: B2b → B2** (RLS) es el cuello de botella; B0 y
> B1 pueden arrancar ya en paralelo.

Estado confirmado por el audit: `runWithRls` (lib/rls.ts:19) es el único setter del GUC; solo lo
usan patients.ts (11 wraps / 41 calls) y bookings.ts (4 wraps / 20 calls) — **ambos con calls planas
sin envolver**. `getTenantPrisma` (lib/db.ts:76) es dead code. `Actor` no lleva `role`. Solo hay 2
tests puros. RLS está inerte en local (rol `kinesoft` = superuser del Docker) y en prod (rol Supabase
con BYPASSRLS).

---

## Ola B0 — Splits de archivos gigantes (independiente, cero-cambio conductual)

Orden recomendado (menor→mayor acople de estado): **configuración → patient-profile → agenda →
diagnóstico**. Gate de cada uno: `tsc` + `build` + QA visual de la pantalla (el comportamiento NO
cambia). Consolidar en el camino: los formateadores de dinero duplicados (`fmtMoney`/`fmtMoneyARS`/
`Money`/`billingLine`) → `formatARS` de lib/format.ts; y `DayOfWeekPicker` (duplicado en agenda:122 y
diagnostico:1496) → un control compartido.

**B0.1 `configuracion-client.tsx` (1581)** — el más fácil (estado raíz ≈ solo `tab`+`role`; cada
panel independiente). Cortar por tab: `panels/{general,services,insurers,users,diagnosticos}-panel.tsx`
+ `configuracion/controls.tsx` (TabsBar, Switch, ErrorBox, Money→formatARS).

**B0.2 `patient-profile.tsx` (2341)** — read-only en su mayoría (cada view recibe `patient` por prop).
Extraer: `profile/ui.tsx` (átomos: Section, Grid2, Detail, Summary, BookingStatusTag), `profile/
tabs-bar.tsx`, y `profile/views/*` (resumen, sesiones, plan[cluster grande 1158-1963], antecedentes,
evolucion). **Complicación:** `FacturacionView` + `TurnosView` comparten `bookingsAll`+`patchBooking`+
`dropBooking` (lazy-fetch) → extraerlas juntas o vía context. `fmtMoneyARS` (1954) → `formatARS`.

**B0.3 `agenda-client.tsx` (2179)** — extraer primero `agenda/agenda-utils.ts` **puro** (fmtHour,
osLabel, billingLine, layoutBookings, statusPill → habilita tests), luego `agenda/booking-modal.tsx`
(BookingModal 1450-2128, ~680 líneas, autocontenido = mayor reducción), luego `views/*` (week-strip,
timeline-view, week-grid-view, list-view) y controls. Borrar el `fmtMoney` local (97) — ya se importa
`formatARS` (34).

**B0.4 `diagnostico-screen.tsx` (1627)** — **mayor acople** (flujo tipo reducer: BodyMapPanel/
RefinementPanel escriben el estado raíz, RightStack lee). Extraer primero lo autocontenido:
`diagnostico/labels.ts` (puro) + `diagnostico/assign-plan-modal.tsx` (1055-1449); después los 3
paneles definiendo la interfaz state/dispatch de una vez (no romper el reducer).

---

## Ola B1 — Tests + extracción de lógica pura (precondición 4.2)

Extraer a módulos puros y testear (capa 1). Candidatos concretos:
- **Ya puros** (testeables directo): `lib/diagnosis-engine.ts` (0 prisma), `lib/plan-gating.ts`,
  `lib/validation.ts`.
- **A extraer** (cálculo atrapado entre I/O): idempotencia/filtrado de `createBookingsBatch`
  (bookings.ts:732+), progreso de sesiones (`sessions.ts` getProgramProgress ~618-690), transformación
  KPI post-query (`dashboard.ts`), decisión de acceso pura de `visibility.ts` (patientAccessFor), y
  `agenda-utils.ts` (una vez extraído en B0.3: layoutBookings/billingLine/statusPill).
- **Test de copago** (`resolveBookingCopagoCents`): hoy vive en un módulo `server-only` con import de
  prisma → extraer la función pura a un módulo sin I/O para poder testearla (esto desbloquea el test
  que quedó pendiente de la Fase A).

**Fábrica de tenant efímero (capa 3):** ni `scripts/create-tenant.ts` (CLI atado a Supabase Admin) ni
`prisma/seed.ts#seedDemoTenant` (usa su propio PrismaClient) son reutilizables. Hay que **extraer la
lógica de creación** (tenant → practitioner → membership → services default) a un helper puro-de-DB
que corra contra Postgres local sin Supabase auth, + un barredor de huérfanos. Requiere el rol app de
B2b para los tests de aislamiento con RLS real.

---

## Ola B2b — Rol de conexión sin BYPASSRLS (habilita B2) · **necesita al dueño**

RLS es inerte hoy porque la app conecta como superuser (Docker) / rol Supabase con BYPASSRLS (prod).
Para activarla:
- **Docker local:** crear `kinesoft_app` LOGIN **sin SUPERUSER/BYPASSRLS** + `GRANT USAGE ON SCHEMA
  public` + `GRANT SELECT/INSERT/UPDATE/DELETE ON ALL TABLES` + `GRANT USAGE ON ALL SEQUENCES` +
  default privileges. Migraciones/seed siguen como owner `kinesoft`; la app apunta `DATABASE_URL` a
  `kinesoft_app`.
- **Prod (dueño, bucket C):** rol equivalente en Supabase + cambiar la connection string.
- **Decisión de arquitectura:** conexión **dual** — rol app (RLS forzada) para requests con Actor, y
  un canal service-role/BYPASSRLS acotado para las superficies **sin Actor** (webhook MP, booking
  público, auditoría desde jobs). Sin esto, forzar RLS rompe esas superficies.

---

## Ola B2 — RLS wholesale (SERIAL, todo-o-nada) · **el mayor riesgo**

Envolver en `runWithRls` (o el canal service-role) TODOS los módulos que hoy usan `prisma` plano y
tocan tablas con RLS. **No forzar RLS hasta cubrir las superficies públicas/webhook.**

**Mapa de riesgo (del audit) — escrituras que ABORTAN con GUC=NULL:**

| Módulo | Riesgo | Nota |
|---|---|---|
| `public-booking.ts` | **CRÍTICO** | superficie anónima sin Actor → nunca hay GUC; `runWithRls(tenantResueltoPorSlug, …)` |
| `sessions.ts` | muy alto | 40 queries, 0 wraps; Session/SessionExercise/Program/EvaScore |
| `diagnosis.ts` | alto | creación clínica (ClinicalCase/Diagnosis/Program) |
| `portal.ts` | alto | portal del paciente (evaScore/patient.update) |
| `mercadopago.ts` | alto | webhook sin Actor (payment.upsert/booking.update) → canal service-role |
| `audit.ts` / `audit-extension.ts` | alto | AuditEvent desde webhooks/jobs sin Actor |
| `services.ts`, `tenant-settings.ts` | alto/medio | service/tenant updates |
| `bookings.ts#createBookingsBatch` | alto | confirmado sin runWithRls |

**Rompe-lecturas (devuelven vacío → decisiones erróneas, sin error):** `dashboard.ts`, `visibility.ts`
(¡el control de acceso!), `invitations.ts`, `notifications-internal.ts`, `files.ts`, `search.ts`,
`plan-templates.ts`, `public-booking-internal.ts`. **Seguros hoy** (tablas sin RLS o catálogo global):
`notifications.ts`, `favourites.ts`, `preferences.ts`, `conditions.ts`, `exercises.ts`.

**Policies faltantes (las 9 tablas con tenantId sin RLS):** PatientShare, PatientFile, Insurer,
Invitation, Favorite, PlanTemplate, Notification, DismissedReminder, UserPreferences. ⚠️
**`UserPreferences.tenantId` es nullable** (schema:914) → la policy directa rechazaría inserts con NULL
y ocultaría filas legacy; resolver con backfill + NOT NULL, o `OR tenantId IS NULL`. (Aparte:
Condition/Exercise overrides por-tenant quedan sin proteger — decisión de diseño a confirmar.)

**Migración del dueño:** 9 policies nuevas + fix UserPreferences + backfill. QA por módulo con el rol
app. Dep: B2b (rol) + B1 (tests de no-regresión por módulo).

---

## Ola B3 — Multi-profesional · **migración + backfill**

Bug confirmado: `Practitioner.userId @unique` (schema:123) + `buildActor` (session.ts:75) que lanza
`no_membership` si no hay Practitioner en el tenant elegido → **un kine invitado a un 2º consultorio
no puede loguearse ahí hoy** (accept-action:69 omite crear el Practitioner del 2º tenant).

Cambios: (1) schema: quitar `@unique` de userId, `@@unique([tenantId,userId])`, `UserProfile.
practitioner` → `Practitioner[]` (schema:88); (2) `accept-action.ts:69` → `findFirst({tenantId,userId})`
+ crear **siempre** el Practitioner del tenant (borrar el skip); (3) grepear consumidores singulares de
`userProfile.practitioner` (se vuelve lista); (4) **setter de cookie `kine_tenant`** (hoy se lee pero
nadie la escribe — el switch de tenant no está cableado); buildActor ya lo respeta. Backfill:
Practitioners faltantes para users multi-membership. Dep: B2 (las policies directas Practitioner-por-
tenant deben estar sólidas). QA: invitar un user existente a un 2º tenant, switch, login en ambos.

---

## Ola B4 — Realtime (agenda compartida en vivo) · **greenfield**

Supabase Realtime NO se usa hoy (0 matches). La invalidación es server-side only
(`invalidateBookingDerivedCaches` en bookings.ts:33 → revalidateTag) → un 2º profesional no ve el
cambio hasta refrescar. Diseño (broadcast explícito, NO `postgres_changes` — replicaría filas crudas y
fugaría cross-tenant): canal `tenant:<id>:agenda`, emitir `booking.created|updated|deleted|
status_changed` desde los puntos donde hoy se invalida cache (bookings.ts + public-booking.ts); los
clientes suscritos en agenda-client refetchean/parchean `bookingsByDay`. Requiere **policy de SELECT en
`realtime.messages`** por tenant + auth del canal con el tenant del Actor. Dep: B0 (agenda modularizada),
B3 (agenda compartida cobra sentido), B2 (autorización de canal apoyada en RLS). QA multi-cliente: 2
sesiones del mismo tenant, ver el turno aparecer en vivo.

---

## Orden y dependencias

| Ola | Depende de | Necesita del dueño |
|---|---|---|
| B0 splits | — (arranca ya) | QA visual de las 4 pantallas. Sin migración. |
| B1 tests | B0 (agenda-utils) | aprobar el estándar; DB de test = Docker. |
| B2b rol app | — (habilita B2) | **migración de rol + GRANTs**; decisión conexión dual. |
| B2 RLS | B2b + B1 | **migración** (9 policies + UserPreferences + backfill); QA por módulo. |
| B3 multi-prof | B2 | **migración schema + backfill**; QA login/switch 2 tenants. |
| B4 realtime | B0 + B3 + B2 | habilitar Realtime; policy realtime.messages; QA multi-cliente. |

**Recomendación de ejecución autónoma:** B0 y B1 son seguros y paralelizables con agentes ahora
(cero-cambio conductual + tests). **B2b/B2/B3/B4 requieren decisiones y migraciones del dueño** (rol de
DB, conexión dual, policies, backfills) y QA por módulo — se ejecutan staged, no en una corrida ciega.

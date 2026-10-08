# KineSoft — Auditoría de estado (checklist de severidad vivo)

> **Qué es este documento.** La fuente única de verdad de "¿qué sigue abierto?" para KineSoft,
> siguiendo el proceso E1-E2 y el meta-modelo de documentación del
> [ENGINEERING-MANUAL.md](ENGINEERING-MANUAL.md) (Parte 5). Cada finding tiene severidad
> verificable, un estado (ABIERTO/CERRADO) y una sesión del [ROADMAP.md](ROADMAP.md) que lo
> resuelve. Es un documento **vivo**: se actualiza el estado a medida que cada sesión cierra.
>
> **Metodología.** Auditoría E1 (documental) + E2 (sweep verificado en código) corrida el
> 2026-07-22 sobre 9 áreas del baseline, con verificación adversarial de cada finding
> crítico/alto (se refutó lo que no resistió lectura del código real). 24 findings confirmados,
> 63 menores, 2 refutados. El código es el árbitro: donde un doc decía una cosa y el código otra,
> mandó el código.
>
> **Estado global:** MVP funcional, desplegado, 1 cliente vivo. El núcleo (auth/tenancy, flujo de
> booking, visibilidad de pacientes, billing de copago, webhook MP) está **genuinamente sólido**
> (ver §Inventario de preservar). Los gaps de abajo son la distancia entre "anda para mi hermano"
> y "SaaS vendible a consultorios".

## Estado de ejecución

**Ronda 1 — Ola 1 (2026-07-23):** cerrada la tanda de fixes de código sin migraciones (bugs QA de
agenda + barrido de timezone + login + boundaries + CI capa-1). Gate: `tsc` ✅ · `next build` ✅ ·
`vitest` 16/16 ✅. QA manual pendiente del dueño en [QA.md](QA.md).

- 🟢 **Cerrados:** timeline-oncreate-wrong-day-hour, agenda-client-emptyslot-sethours,
  turnos-fuera-de-horario-o-media-hora-no-visibles, statustag-no-exhaustivo, statustag-label-drift,
  public-booking-slots-host-tz, public-booking-wizard-today-utc, public-slots-ratelimit-vacio,
  suggest-next-free-slot-host-tz, getdaycounts-utc-slice, booking-overlap-race-no-cas-no-unique,
  conflict-findfirst-sin-orderby, seguimiento-today-bucket-and-display, search-booking-toLocale-no-tz,
  portal-session-date-no-tz, dashboard-buckets-utc, mini-calendar-days-getdate-utc,
  dashboard-page-getmonth-utc, mini-calendar-today-browser-tz, notifications-bell-no-tz,
  pacientes-lastvisit-no-tz, session-detail-no-tz, ics-export-week-window-host-tz,
  login-sin-feedback-error, sin-error-loading-boundaries, sin-not-found-403-custom (404; 403 diferido),
  no-ci-triple-gate.
- 🟡 **Parcial:** no-test-suite / c2-no-tests-ci (solo capa-1 sobre datetime-ar+format; suite
  completa = Ola 2.1) · formateadores-moneda-duplicados (solo agenda; resto = Ola 2.0) ·
  batch-create-overlap-race-and-no-rls (idempotencia ✅; parte RLS = Ola 2.2) ·
  plan-startdate-utc-midnight (diagnosis.ts ✅; plan-templates.ts + patients.ts = próxima ronda).
**Ronda 2 — Olas A3+A4 (2026-07-23):** Fase A **completa**. Gate: `tsc` ✅ · `next build` ✅ ·
`vitest` 19/19 ✅. Migración `payment_expected_amount_and_delete_restrict` aplicada al Docker local.
QA manual pendiente del dueño en [QA.md](QA.md) (los de pago requieren sandbox de MP).

- 🟢 **Cerrados:** c3-payment-amount, booking-hard-delete-payment-cascade (crítica),
  mp-webhook-idempotency-check-outside-tx, checkout-practitionerid-sin-validar,
  patient-hard-delete-cascades-hc (gate de rol), program-session-hard-delete (gate),
  session-totalsessions-read-modify-write, coverage-sin-schema-zod, money-input-sin-parser-ar,
  plan-startdate-utc-midnight (las 3 instancias: diagnosis, patients, plan-templates + ProgramCreate),
  sin-headers-seguridad-csp (CSP en Report-Only), serveractions-allowedorigins-localhost,
  m2-silent-catches, audit-fire-and-forget, password-sin-complejidad, invitation-token-en-claro.
- 🟡 **Parcial / listo-para-activar:** m1-sentry-no-wired / sentry-no-cableado (shim no-op cableado en
  `lib/observability.ts`; activación = instalar `@sentry/nextjs` + `SENTRY_DSN`, bucket C) · CSP
  (Report-Only; activar como bloqueante tras 2 semanas sin violaciones propias).
- 🔴 **Diferido menor:** booking-paid-toggles-no-optimistic-lock. **Próxima fase (B):** todo Etapa 2
  (ver [ROADMAP.md](ROADMAP.md) + [FASE-B-PLAN.md](FASE-B-PLAN.md)).

**Ronda 3 — Fase B, olas B0+B1 (2026-07-24):** splits + tests. Gate: `tsc` ✅ · `next build` ✅ ·
`vitest` 35/35 ✅. Sin migración (cero-cambio conductual).

- 🟢 **Cerrados:** h2-oversized-components + deuda-archivos-grandes (los 4 archivos gigantes troceados:
  configuracion-client 1636→52, patient-profile 2341→181, agenda-client 2180→338, diagnostico-screen
  1627→231; sub-componentes en módulos por feature) · formateadores-moneda-duplicados (consolidados en
  `formatARS`; `Money`/`fmtMoney` que eran componentes se preservaron) · provider-value-inline-bulk-select
  (no reapareció en el split). **B1:** `resolveBookingCopagoCents` extraído a `lib/copago.ts` puro +
  test (cierra el test de copago diferido de Fase A); `agenda-utils.ts` puro + test de `layoutBookings`
  (**helper y tests eliminados en la Ronda 9**, cuando el timeline dejó de calcular grupos de solape);
  fábrica de tenant efímero en `tests/helpers/tenant-factory.ts` (lista para capa 3).
- 🔴 **Próxima (gated en el rol sin BYPASSRLS que arma el dueño):** B2 RLS wholesale, B3 multi-profesional,
  B4 realtime — ver [FASE-B-PLAN.md](FASE-B-PLAN.md). Diferido menor: test de `diagnosis-engine`
  (puro, listo para cuando se retome Etapa 3).

**Ronda 4 — Wave features + RLS local (2026-08-02):** Gate: `tsc` 0 · `next build` 0 · `vitest`
39/39 (+4 RLS). Todo en **local Docker** (sin tocar prod).
- 🟢 **B2b RLS activado en local:** rol `kinesoft_app` (sin BYPASSRLS) creado, `.env.local` apuntando
  la app a ese rol (`DIRECT_URL`=owner para migraciones + canal service); test de aislamiento
  `rls-isolation` en verde (cross-tenant INSERT rechazado por WITH CHECK). **Prod sigue en BYPASSRLS**
  hasta que el dueño corra `prisma/roles.supabase.sql` + flip de env en Supabase. `rls-bypassed-by-superuser-role`
  y `runwithrls-solo-en-2-modulos` → cerrados en código; el flip prod es bucket C.
- 🟢 **Features:** color por servicio (16 pastel, `Service.color`, barra de la card de agenda);
  agenda día = 5 columnas full-width + wrap (tope 10) + "+N" con expansión (**reemplazado por el layout
  en flujo de la Ronda 9**); mini-diagnóstico por turno
  (`Booking.title/description`, default a nivel paciente `Patient.diagnosisTitle/diagnosisNote` con
  propagación); modales de carga (paciente/turno/servicio/plan) → **drawers**; preview de últimos 2
  turnos en el drawer; animaciones framer-motion (sidebar, ruta, agenda vista/día, tabs del perfil,
  stagger de pacientes) + pulido del dashboard (count-up, chart animado, dropdowns, PinKpiModal→primitivo).
- Migración local aplicada: `20260802220514_wave_service_color_booking_title_patient_diagnosis` (aditiva).

**Ronda 5 — Wave agenda/portal/compartir + QA fixes (2026-08-02):** Gate: `tsc` 0 · `next build` 0 ·
`vitest` 39/39 (+4 RLS). Local Docker (migración aislada del enum `PATIENT_SHARED`; prod intacta).
- 🟢 **QA fixes wave 1:** autocomplete del navegador desactivado en el patient-picker (pisaba nuestro
  typeahead); card de agenda ahora muestra `title || description` (antes solo `title` → quedaba vacía si
  el diagnóstico se cargó en descripción).
- 🟢 **Features:** leyenda de colores de servicio en la agenda + "filtro" de resaltado (lift sutil,
  single-select, sin IA; `serviceId` threadeado al DTO); campos Diagnóstico+descripción en el portal
  público de turnos; notificación al profesional cuando le comparten un paciente (`setPatientShares` →
  `notify(PATIENT_SHARED)`); "Compartir turno" en el booking-drawer (link `wa.me` + recordatorio
  imprimible/PDF client-side, sin lib).
- 🔴 **Diferido (tracked):** 2(b) ejercicios+multimedia en portal, 2(c) export PDF/JPEG completo con
  links, envío por email/WhatsApp-API (**bucket C** — falta sumar entrada WhatsApp a EXTERNAL-CONFIG).
  Gap: la landing publicita WhatsApp sin implementación (alinear cuando (d) esté real).

**Ronda 6 — QA fixes: turnos que se pisaban + confirmación mismo-día + autofill (2026-08-02):** Gate:
`tsc` 0 · `next build` 0 · `vitest` 45/45 (+6 nuevos de `patientDayStatus`). Local Docker, sin migraciones.
- 🟢 **Pérdida de datos (crítico funcional) CERRADO:** la `idempotencyKey` determinística
  (`tenant:prof:slot:paciente` + upsert) sobrescribía silenciosamente un turno existente al re-bookear
  el mismo paciente en el mismo instante. Reemplazada por **key del cliente** (`crypto.randomUUID()` por
  instancia del modal, fallback random) en `createBooking` y `createBookingsBatch`. Repro DB confirma:
  misma key → dedup; keys distintas → filas distintas.
- 🟢 **Guard de paciente (nuevo):** `createBooking` bloquea el solape con el propio turno del paciente
  (cualquier profesional, con look-back de 240min para cruces de medianoche AR) y pide **confirmación
  suave** para un 2º turno el mismo día (helper puro testeable `patientDayStatus` en `lib/booking-capacity.ts`).
  El guard excluye la propia fila por `idempotencyKey` → un reintento idempotente no se auto-bloquea.
- 🟢 **Autofill de Chrome** (sugería el email de la cuenta Google sobre el typeahead de paciente):
  `autoComplete="new-password"` + aria/opt-outs en `patient-picker` y 4 typeahead más (search-bar,
  diagnóstico-wizard, assign-plan, command-palette).
- 🟢 **CERRADO · `booking-same-patient-slot-toctou` (era el residual del review, bajo):** el guard de app
  es best-effort (TOCTOU); ahora tiene **backstop race-free a nivel DB**. Migración aislada
  `20260803002623_booking_patient_slot_active_unique`: índice único parcial
  `CREATE UNIQUE INDEX ... ON "Booking" ("tenantId","patientId","scheduledFor") WHERE "patientId" IS NOT NULL AND status <> 'CANCELLED'`.
  Dos submits genuinamente concurrentes al mismo slot → uno gana el INSERT, el otro recibe `P2002`,
  manejado en **todos** los paths de escritura → mensaje de solape amable: `createBooking`
  (`e.meta.target` = `["tenantId","patientId","scheduledFor"]`), `updateBooking` (reprogramar sobre slot
  propio, `.catch` P2002), `createBookingsBatch` (skip existente), portal `submitPublicBooking`
  ("Ya tenés un turno reservado en ese horario"). Respeta el predicado parcial: guests (patientId null) y
  turnos CANCELLED no colisionan (se puede re-bookear un slot liberado). Verificado por repro DB. NOTA
  Prisma: el índice parcial no se expresa en el schema (5.22) y se maneja solo por la migración; probado
  que un `migrate dev` posterior NO lo dropea (genera migración vacía, sin drift).

**Ronda 7 — Wave "Plataforma" (superadmin) + CRUD del catálogo de ejercicios (2026-08-02):**
Gate del backend: `tsc` 0 · `next build` 0 · guard verde · prueba RLS OK. Local Docker, prod intacta.
- 🟢 **Fundación (4 migraciones aisladas):** `UserProfile.isPlatformAdmin`; `TagKind += MUSCLE_GROUP, DISCIPLINE`
  (aislada); `Exercise` reps/sets **opcionales** + `durationSeconds` + `archivedAt` (soft-delete);
  `ExerciseMedia` (1:N) + `ExerciseArticle` (1:1) con RLS `ENABLE/FORCE` + `SELECT USING(true)` **sin write**
  (rol app lee, solo el canal service escribe — verificado: `INSERT` global denegado por RLS).
- 🟢 **Identidad superadmin:** `Actor.isPlatformAdmin` + `requireSuperAdmin()`/`ForbiddenError` (lib/session.ts);
  script `scripts/set-platform-admin.ts`. Cierra el gap `sin-panel-owner` (parcial: falta la UI + cross-tenant).
- 🟢 **Backend CRUD (canal `prismaService` BYPASSRLS + `requireSuperAdmin`):** `lib/exercises-admin.ts`
  (create/update/archive/restore/hardDelete-guardado + upsertArticle), `lib/tags-admin.ts`
  (create/rename/delete + counts), `lib/exercise-media.ts` (upload Supabase bucket `exercise-media` + YouTube
  nocookie + signed URLs + stub local), `lib/catalog-tags.ts` (helpers). Zod en `lib/validation.ts`.
- 🟢 **Tags estructurados:** backfill de 73 ejercicios (135 links; free-text→MUSCLE_GROUP/EQUIPMENT), seed
  actualizado, ambos paths de create linkean tags, facets/filtros de /biblioteca leen tags, columnas
  free-text conservadas (denormalizadas para las cards). Blindaje nullable de reps/sets en ~8 sitios.
- 🟢 **UI (Fase D) COMPLETA:** sidebar "Plataforma" (solo superadmin, threadeado layout→app-shell→sidebar) +
  guard `app/(app)/plataforma/layout.tsx`; `plataforma/ejercicios` (lista + drawer editor con Común/Pro,
  reps/tiempo opcional, tags, media manager + article editor) y `plataforma/tags` (CRUD de categorías por
  kind); lector `app/(app)/biblioteca/[slug]` (blogpost: header + media grid + markdown seguro
  `components/ui/markdown.tsx`, sin HTML crudo) + botón "Ejercicio completo" y display reps/tiempo opcional
  en biblioteca-client. Fan-out: 3 agentes (media/article, tag-admin, lector) con contratos exactos.
- 🟢 **Review adversarial (Fase E):** 4 dimensiones × verify; **seguridad/RLS/authz LIMPIA** (sin holes).
  5 hallazgos confirmados (0 refutados) **todos corregidos**: (HIGH) `updateGlobalExercise` no podía LIMPIAR
  reps/tiempo — cliente ahora manda `null`, schema `optionalCount` preserva null (verificado con zod);
  (MEDIUM) el drawer no refrescaba media/artículo tras mutar — callback `onChanged`→refetch de `full`;
  (LOW×3) duración `<60s` mostraba "0 min" en lector + "×" pelado en el picker de sesión (guards de null +
  fallback a segundos). Gate: `tsc` 0 · `next build` 0 · `vitest` 45/45 · guard verde.
- 🔴 **PENDIENTE (dueño, prod, al cierre de sesiones):** aplicar migraciones + `set-platform-admin` (vos +
  cliente) + confirmar `prismaService`→`kinesoft_service` (BYPASSRLS). QA manual del panel. Diferidos de la
  wave: dropear columnas free-text; owner-panel completo (tickets/impersonación/multi-tenant); planes/
  ejercicios-en-turno; billing.

**Ronda 8 — Tabla admin del catálogo + edit-in-place + fix de hidratación (2026-08-03):** Gate: `tsc` 0 ·
`next build` 0 · `vitest` 45/45 · guard verde. Local Docker, prod la aplica el dueño al cierre.
- 🟢 **Tabla de Plataforma → Ejercicios:** `listGlobalExercisesForAdmin` pasó de "traer todo" a
  `{rows,total}` con search + filtros (tipo/plan/dificultad/archivados + tags por kind, AND entre kinds) +
  sort por columna + `skip/take` (primer paginado offset del repo, `Promise.all(findMany,count)`).
  Cliente: toolbar con búsqueda debounced y multiselects (`tag-filter-menu.tsx`), headers sortables, chips
  agrupados, **acciones inline** (toggle Común↔Pro, archivar/restaurar) y pager con tamaño configurable.
- 🟢 **Preferencias por usuario:** columna `UserPreferences.catalogPrefs Json?` (migración
  `user_prefs_catalog`) + `sanitizeCatalogPrefs` (coerción total: blob hostil/viejo → defaults, verificado).
  La URL manda; sin params se restaura la vista guardada. Round-trip verificado contra la DB.
- 🟢 **Edit-in-place:** `ExerciseDrawer` extraído a `components/plataforma/exercise-drawer.tsx`; biblioteca
  y terapia-manual pasan `isPlatformAdmin` (leído del actor en el Server Component) y un superadmin que
  clickea una card **del catálogo global** edita ahí mismo (privadas del tenant → detalle read-only; el
  drawer además tiene estado explícito "no pertenece al catálogo global"). Drawer cargado con
  `next/dynamic` → `/biblioteca` bajó de 160 kB a **153 kB** para los no-admin.
- 🟢 **Hidratación (Planes/seguimiento) CERRADO:** `session-detail.tsx` formateaba la fecha en el cliente
  sin `hour12` → el "a. m." con espacio U+202F difería entre el ICU de Node y el del browser. Ahora se
  formatea en el server (`scheduledLabel`) y el preset `longDateTime` de `lib/format.ts` fija `hour12:false`
  (alineado con el resto de la app, que ya usaba 24h).
- 🟢 **Review adversarial:** 16 hallazgos confirmados (6 distintos, el resto duplicados entre dimensiones),
  **todos corregidos**: (HIGH) closure obsoleto en el debounce de búsqueda que resucitaba filtros recién
  limpiados y los persistía; (MED) input de búsqueda desincronizado con Back/Forward; (MED) el multiselect
  de tags perdía la selección previa al clickear rápido (ahora estado optimista local); (LOW) página fuera
  de rango mostraba "catálogo vacío" (ahora auto-clamp al último page con filas); (LOW) `?muscle=a&muscle=b`
  tiraba 500 (`csv` tolera arrays); (LOW) sort sin desempate único podía duplicar/ocultar filas homónimas al
  paginar (ahora `{id:"asc"}` en todos los órdenes, verificado con dos ejercicios del mismo nombre).
- 🟡 **Aceptado por diseño:** volver con el botón Back a la URL sin parámetros re-muestra la vista guardada
  (es la persistencia pedida, no un bug).

**Ronda 9 — Agenda: refactor del timeline a layout en flujo + anchos de drawers (2026-08-03):** Local
Docker, sin migraciones.
- 🟢 **Timeline reescrito:** `components/agenda/views/timeline-view.tsx` pasó de posicionamiento
  **absoluto** (`top` = hora×56px, ancho = % del strip repartido por grupos de solape) a **layout en
  flujo**: una fila por hora que **crece con su contenido**, cards en flex-wrap con
  `flexBasis: calc((100% - 32px) / 5)`, `minWidth 186` / `maxWidth 280`, `flexGrow 0`. Cierra tres
  síntomas de QA a la vez: cards que se cruzaban entre franjas horarias, filas que no crecían al
  acumularse turnos, y cards estiradas a lo ancho cuando la hora tenía 1-2 turnos. Hasta 5 por fila; el
  texto **trunca con ellipsis + tooltip** en vez de ensanchar la card. "+N más" por hora (límite 10).
- 🟢 **Código muerto eliminado:** `layoutBookings` + el tipo `BookingLayout` borrados de
  `components/agenda/agenda-utils.ts` (el nuevo timeline no calcula grupos de solape, así que ya no se
  usan) junto con sus **3 tests** en `tests/unit/agenda-utils.test.ts`.
- 🟢 **Anchos de drawers** (había scroll lateral): `components/ui/drawer.tsx` default 420→**480**;
  `components/agenda/booking-modal.tsx` 460→**580** (para que los avisos de sobreturno / 2º turno el
  mismo día entren sin scrollear); `components/plataforma/exercise-drawer.tsx` 480→**600**;
  `components/patients/new-patient-button.tsx` 480→**560**; `components/patients/profile/hero.tsx`
  520→**560**.
- Gate: `tsc` 0 · `next build` 0 · `vitest` **42/42** (bajaron 3 por los tests borrados, no por
  regresión) · guard verde.

> **Nota — conteo de tests vigente (2026-08-03).** Las líneas de gate de las Rondas 4-8 (`39/39`,
> `45/45`) eran correctas **en su momento**; no se reescriben. El conteo real de hoy es **42 unit + 4
> integration (RLS)**: `booking-capacity` 10, `agenda-utils` 4, `copago` 9, `datetime-ar` 10, `format` 9.
> La caída 45→42 es exactamente la eliminación de los 3 tests de `layoutBookings` en la Ronda 9 (código
> borrado), no una pérdida de cobertura. El integration (`tests/integration/rls-isolation.test.ts`) corre
> aparte con `npm run test:integration` (`RLS_IT=1`), por eso no entra en el `42/42` de `npm test`.

**Ronda 10 — Feedback del cliente: agenda 30 min + batch con preflight + solape confirmable (2026-08-16):**
Gate: `tsc` 0 · `next build` 0 · `vitest` 54/54 · guard verde. Local Docker; prod la aplica el dueño
(ver [MIGRACIONES-RUNBOOK.md](MIGRACIONES-RUNBOOK.md)).
- 🟢 **Agenda con granularidad configurable:** `Tenant.agendaSlotMinutes` (30|60, migración
  `20260816014954`) editable en Configuración → "Horario del consultorio". Helpers puros nuevos en
  `agenda-utils.ts` (`buildSlots`/`slotLabel`/`slotOf`/`coveredSlots`) + `toARMinutes` en `datetime-ar.ts`
  (minutos exactos: `toARHour()*60` perdía precisión, 08:20 → 499.99…). **12 tests capa-1 nuevos**
  (reemplazan a los de `layoutBookings` borrados en la Ronda 9). Día y Semana comparten el grid; se
  corrigió que la Semana usaba `Math.round` (un 13:30 caía en la fila de las **14**, contradiciendo al Día).
- 🟢 **5 hallazgos del review interrumpido de la Ronda 9, cerrados:** duración que el ellipsis se comía
  (ahora va primero y en el tooltip), turnos largos que dejaban ver "libres" las franjas siguientes (hint
  «· continúa X»), franja invisible de creación (acotada a `CARD_MAX`), gutter de la hora que era zona
  muerta (ahora crea), y turnos fuera de banda que competían por el "+N" (ahora filas propias
  "Antes/Después del horario").
- 🟢 **Batch multi-turno con preflight:** `createBookingsBatch` gana `dryRun`/`allowOverbooking` y devuelve
  `BatchOutcome` (por fecha: `libre`/`sobreturno`/`duplicado`). El modal avisa **antes** de crear y ofrece
  «Crear todos» / «Crear solo los libres». Los forzados se tagean `[SOBRETURNO]` (paridad con el single) y
  los P2002 del índice se reportan como "ya existían" en vez de "omitidos por conflicto" mudos. Una sola
  query para todo el rango (antes 2 por slot). Ahora también mira el solape del **propio paciente**.
- 🟢 **Solape del paciente confirmable:** el bloqueo duro pasa a prompt («dos servicios en paralelo es
  normal»); el **instante exacto** queda como error terminal con texto accionable ("movelo unos minutos"),
  porque el índice único lo rechaza siempre. Los dos flags (`allowPatientOverlap`/`allowSamePatientDay`) son
  independientes — antes confirmar "mismo día" salteaba también la regla de solape. Todos los avisos hacen
  `scrollIntoView` (renderean debajo del formulario en un drawer con scroll).
- 🟢 **CI:** se agregó el paso `npm run guard:isolation` al workflow. El guard existía y se corría a mano —
  cierra de verdad `no-static-security-guard`, que el checklist §2 daba por abierto con razón.
- 🟢 **Docs unificados:** eliminado el árbol duplicado `docs/` (congelado en Ronda 3; recuperable del
  historial) y `roadmap.md` → `ROADMAP.md` registrado con `git mv` (10 links lo esperaban; rompía en hosts
  case-sensitive). Rondas 3-9 documentadas en QA.md, ROADMAP con marcadores de avance reales,
  ARCHITECTURE/SECURITY al día (RLS ya no "inerte", tier superadmin), EXTERNAL-CONFIG con WhatsApp
  (bucket C, **pendiente del dueño**) y el bucket `exercise-media`.
- 🟢 **Review adversarial:** 2 hallazgos confirmados (5 refutados), ambos corregidos: (MED) el prompt de
  solape se ofrecía también para el instante exacto, que la DB nunca acepta → la confirmación no "pegaba";
  (LOW) en Semana a 30 min un turno de 45/60 min tapaba y robaba los clicks del chip de la media hora
  siguiente → el span ahora se corta antes de la siguiente celda ocupada.

**Ronda 11 — Auditoría pre-producción + Bloque A0 (2026-09-23 / 2026-09-29):**
Auditoría completa de solo lectura (14 auditores + 181 votos de verificación adversarial + crítico de
completitud + 3 áreas extra): 161 hallazgos, deduplicados en ~45 grupos. El trabajo pendiente se reorganizó en
**bloques por urgencia** (ver [ROADMAP.md §Plan vigente](ROADMAP.md)). El detalle completo (file:line, votos,
diseño de Planes) está en el plan del 23-sep, referenciado desde el ROADMAP.

- **Altos de la auditoría (Bloque A)** — estado al 30-sep-2026 (detalle y evidencia en §Ronda 12):
  - 🟢 **H1** `deleteBooking` borraba en duro turnos con copago cobrado a mano u OS confirmada (el guard solo
    miraba el `Payment` de MP). Cerrado en A2a-S06.
  - 🟢 **H2** editar paciente descartaba Plan / N° de afiliado y, con OS "Otra", borraba `Coverage.copagoCents`
    en cada guardado. Cerrado en A2a-S08.
  - 🟢 **H3** "Cerrar sesión" en Seguimiento descartaba EVA/notas no guardadas. Cerrado en A2a-S03.
  - 🟢 **H4** la reserva pública con DNI ajeno escribía el email del atacante en la ficha (takeover del
    portal). Cerrado en A2b-S-pub.
  - 🟢 **H5** el signup auto-confirmaba cualquier email (`admin.createUser({ email_confirm: true })`) y rompía
    el gate `email_confirmed_at` del portal. Cerrado en A3c-S-signup: `auth.signUp` con email verificado
    (`lib/auth.ts:49-137`) y el tenant se crea recién en `/onboarding`. Evidencia en §Ronda 12.
  - 🟢 **H6** los Preview de Vercel aplicaban migraciones en la DB de prod: cerrado en código en A0b (ver
    abajo); falta el staging aislado (A0d, dueño).
- 🟢 **A0b `ops-hardening` (2026-09-29):**
  - `vercel.json` → `node scripts/vercel-build.mjs`: `prisma migrate deploy` **solo** con
    `VERCEL_ENV=production` (verificado: en Preview no migra; en Production migra y corta el build si falla).
  - CI (`ci.yml`) en todas las PR y en push a `main`/`develop`/`feat/**`/`fix/**`.
  - `scripts/lib/assert-safe-target.ts` (+9 tests): `prisma/seed.ts`, `seed-santiago` y `seed-sprint13` son
    **solo locales** (abortan contra un destino remoto); `set-platform-admin`, `backfill-exercise-tags` y
    `create-tenant` exigen `DATABASE_URL` explícita (sin fallback a localhost) y
    `KINESOFT_CONFIRM_PROD=<project ref>` para prod. `create-tenant` normaliza el email y ya no imprime el
    password; `seed-santiago` ya no imprime la pista del password.
  - `prisma/roles.supabase.sql` sin passwords literales: se pasan con `psql -v`, y re-correrlo **rota** los
    passwords (verificado en un Postgres descartable).
  - `package.json`: `db:deploy` (leía el `.env` ambiente) → `db:prod:status|deploy|backup`, que leen solo
    `.env.prod.local` (gitignored).
  - `lib/env.ts`: fail-fast **solo en Production** (`VERCEL_ENV`) para DB/Supabase/`NEXT_PUBLIC_APP_URL` no
    localhost y `MP_WEBHOOK_SECRET` si hay token de MP; aviso por consola si faltan `DATABASE_URL_SERVICE`,
    Upstash o Sentry (+7 tests).
  - Eliminada la ruta huérfana `app/api/booking/checkout/route.ts`.
  - Gate: `tsc` 0 · `next build` 0 · `vitest` 70/70 (+16) en TZ=UTC y TZ=AR · guard verde.
- 🟢 **A1 red de tests + baseline de performance (2026-09-30):**
  - **A1.1:**
    - Harness de integración con las server actions reales y `getActor()` real; solo se mockean la
      cookie/headers, la red de Supabase (y el admin client: ningún test manda mails reales) y el runtime de
      cache de Next.
    - Fábrica de tenant con limpieza ordenada. **Cierra `test-infra-factory-cleanup`**: `Service`, `Patient`,
      `Booking` y `TreatmentProgram` no cascadean desde `Tenant`, así que la limpieza vieja fallaba siempre en
      silencio y dejaba tenants huérfanos.
    - 37 tests de integración: turnos, paciente/cobertura/copago, matriz cross-tenant y el tripwire RLS. Los
      bugs conocidos quedan como `it.fails` con la sesión de A2 que los cierra (contrato en TESTING.md).
    - Job `integration` en CI: Postgres efímero, migraciones desde cero, rol app **y** owner. Simulado en local:
      las 24 migraciones aplican limpias en una base vacía. Unit también en TZ=AR.
  - **A1.2:** baseline en [PERF.md](PERF.md), con contador de queries/tx sobre loaders reales, fixture de volumen
    efímero, `EXPLAIN` automático, presión de pool y reporte de bundle en CI. Solo medición.
  - **Hallazgos nuevos de A1:**
    - (MED, A2-S06) **`p2002-target-null-bajo-rls`**: con RLS aplicada, Postgres no expone qué índice violó un
      INSERT (`meta.target === null`), así que `createBooking` y el batch caen al mensaje genérico en vez del
      accionable. Latente en prod hasta el flip de RLS.
    - (MED, C1) **`session-exercise-count-full-scan`**: el `_count` de ejercicios del perfil agrega la tabla
      `SessionExercise` entera (todos los tenants) con RLS fila por fila: 250-380 ms con 24k filas, y crece con la
      plataforma.
    - Con datos, `runwithrls-interactive-tx-per-read` pasa de (P) a **confirmado**, y el "dashboard ~1 s" se
      **refuta** (era un artefacto de estadísticas vacías).
  - Gate: `tsc` 0 · unit 70/70 (UTC y AR) · integración 37/37 (app) y 33 + 4 skip (owner) · guard ✓ ·
    `next build` ✓.
- ⚠️ **Nota operativa:** `@prisma/client` carga el `.env` del proyecto al importarse, antes de que corra
  cualquier script. Por eso los guards de A0b leen el destino **real** y lo imprimen, en vez de confiar en la
  intención de quien corre el comando.

**Ronda 12 — Bloque A2 + A3a + A3b + A3c (30-sep-2026):** cero pérdida de datos, reserva pública, paridad de
UI, visibilidad, montos, rate-limit, sesión/cookies/identidad, observabilidad, signup verificado y stepper de
alta. **Cierra el Bloque A (A0-A3).** La única migración del bloque es la de A3c
(`20260930120000_tenant_onboarding`); A2, A3a y A3b no tienen. Orden de prod:
[MIGRACIONES-RUNBOOK.md §Deploy del Bloque A](MIGRACIONES-RUNBOOK.md). QA manual:
[QA.md §Bloque A — A2/A3](QA.md). Todos los `it.fails` del contrato A2 dados vuelta (ver
[TESTING.md](TESTING.md)).

Gate final del Bloque A: `tsc` 0 · unit 252/252 en 19 archivos (TZ=UTC y TZ=AR) · guard ✓ · integración
175/175 en 13 archivos (`kinesoft_app`) y 171 + 4 skip (owner) · `next build` ✓ · perf sin regresiones graves
(re-medición en [PERF.md](PERF.md)).

- 🟢 **A2a-S06 · turnos:**
  - **H1:** `deleteBooking` rechaza si `paymentStatus ∈ {PAID, AUTHORIZED, REFUNDED}` o `insurerPaidAt ≠ null`
    ("tiene un cobro registrado (copago u OS): cancelalo…") — `lib/bookings.ts:1046`, mensaje en `:1115`.
  - Toggles de cobro (`setBookingInsurerPaid` `:1191`, `setBookingCopagoPaid` `:1210`) con lock atómico
    (`updatedAt` en el WHERE) y devuelven el `updatedAt` nuevo. Cierra `booking-paid-toggles-no-optimistic-lock`.
  - Paridad de `updateBooking` (`:818`): capacidad al cambiar horario/duración o reactivar un CANCELLED,
    solape del paciente y los mismos flags que `createBooking`.
  - **IDOR de turnos:** `practitionerId ∈ tenant` en create (`:565-595`) y batch (`:1295-1317`); `patientId ∈
    tenant` también en el batch (incluido `dryRun`). El conflicto nombra al profesional del tenant, nunca su
    email (`:82-86`).
  - **Filtración cerrada (encontrada en la sesión):** la `idempotencyKey` es `@unique` global; bajo BYPASSRLS
    una key de OTRO tenant hacía que el upsert pisara el turno ajeno. `createBooking` la rechaza (`:712-720`).
  - **P2002 bajo RLS (`p2002-target-null-bajo-rls`):** `resolveUniqueViolation` (`:234`) resuelve en una tx
    nueva: éxito idempotente si la key existe viva; si no, el mensaje de "exactamente a esa hora". **Era
    prerrequisito del flip de RLS en prod: cerrado.**
  - **Acceso básico = solo ver** en servidor: update/estado/delete/toggles/create/batch rechazan
    (`BASIC_ACCESS_ERROR` `:64`); los guest se operan; `listBookingsInRange` oculta `title`/`description` a
    basic (`:366-372`).
  - **ICS:** `exportBookingsIcs` salió del `"use server"` a `lib/bookings-export-internal.ts:19` (`server-only`);
    la única puerta es `app/api/agenda/export/route.ts:64` (rate-limit + tope de 90 días), y enmascara basic.
  - Drawer de turno: solo lectura para basic, manda solo los campos cambiados, "Cambiar" paciente exige
    elegir, "Cancelar edición" resetea.
- 🟢 **A2a-S08 · paciente/cobertura/copago:**
  - **H2:** `setPatientCoverage` (`lib/patients.ts:1091`) actualiza en el lugar si la OS no cambia; con OS
    distinta el copago propio se borra solo con `resetCopago: true` (`:1168-1169`), que la UI pide con
    `useConfirm` mostrando el monto (`hero.tsx:334-343`).
  - `updatePatient` (`:823`): vaciar opcionales, `notes` ≤ 4000, optimistic lock, audit solo con los nombres de
    los campos (sin PHI). Email normalizado (trim + lowercase) en alta y edición (`lib/validation.ts:25`).
  - Script `scripts/normalize-patient-emails.ts` (dry-run por defecto, `--apply`, `assertSafeTarget`, aborta sin
    BYPASSRLS, reporta colisiones): lo corre el dueño en prod después del deploy.
  - `getPatientBillingPreview(patientId, serviceId?)` (`:1258`) = el resolver real, con la fuente.
  - `sendPatientPortalInvite` (`:1609`) chequea `{ error }` en las dos ramas y exige `full`.
  - **`deletePatient` eliminado** (`lib/patients.ts:996`): solo Archivar.
  - `getPatientBookingsAll` (`:584`) paginado con cursor; "Ver más" en el perfil (antes cortaba en 100 sin aviso).
- 🟢 **A2a-S03 · Seguimiento:**
  - **H3:** `completeSessionFromSeguimiento` (`lib/sessions.ts:462`) en una tx, idempotente (`updateMany … WHERE
    completedAt IS NULL`, `:481`), con EVA/notas del cierre y autocompletado del plan **por conteo**
    (solo ACTIVE/PAUSED → COMPLETED). Notificación post-commit.
  - `session-detail`: borrador subido al padre, `useConfirm`, guard de cambios sin guardar
    (`components/seguimiento/use-unsaved-guard.ts`), errores visibles, notas vaciables.
  - **Heurística ±2 h eliminada:** `rescheduleSession` (`:319`) mueve solo la sesión e informa `bookingOnDay`
    con link a la agenda; rechaza reprogramar una sesión realizada.
  - `listOpenSessions` (`:157`): buckets Vencidas sin cerrar / Hoy / Próximas / Realizadas, día AR, solo ACTIVE y
    solo pacientes `full`. `getSessionDetail` → 404 a basic. `completeSession` muerto de `lib/patients.ts`
    (tenía el bug H3) eliminado.
- 🟢 **A2b-S-pub · reserva pública + webhook MP:**
  - **H4:** `resolvePublicPatient` (`lib/public-booking-internal.ts:122`) matchea solo por DNI normalizado y
    **nunca** modifica una ficha existente (ni completa vacíos); contacto distinto → snapshot
    `guestName/guestEmail/guestPhone` + nota "Reserva online · datos de contacto distintos a la ficha" (`:62`).
  - P2002 familiar (teléfono/email compartido): ficha nueva sin el campo que choca, retry ×2.
  - Key por instancia del wizard `pub:<tenantId>:<uuid>`; key reusada con otros datos → rechazo; un CANCELLED ya
    no revive. `releaseOwnExpiredPublicHold` (`:260`) deja re-reservar el propio slot vencido.
  - Grilla pura en `lib/public-booking-slots.ts` (`buildPublicSlots` `:68`, `checkPublicSlot` `:114`): horario,
    domingo y 1 h de anticipación también en el submit. Cierra en parte `logica-en-use-server-y-cliente`.
  - **Webhook:** `nextPaymentStatus` (`lib/mercadopago.ts:184`: un PAID solo baja a REFUNDED), historial
    `rawPayload.attempts` (redactado, 20), `FOR UPDATE` sobre el turno (`:283`) + retry de P2002, solo
    PENDING → CONFIRMED; un CANCELLED/NO_SHOW/COMPLETED registra el pago y avisa "revisá el reembolso" (`:419-425`).
- 🟢 **A2b-S-ui · paridad de UI:** alta inline sin duplicar ficha; profesional por defecto = filtro → usuario →
  primero; Múltiples turnos aplica "actualizar copago"; preview por servicio con fuente; rama muerta
  `mode="edit"` borrada; turnos-view con lock, rollback del borrado y solo lectura; `Drawer.dirty` +
  `ConfirmDialog` que frena el Esc; toggles "Mostrar cancelados/ausentes" con conteo (`lib/agenda-filters.ts`);
  rótulo "Pendiente de pago" / "· vencida". Cierra `native-confirm-alert`.
- 🟢 **A2b-S-vis · visibilidad de HC + export:** gates `full` en archivos (audit **antes** de firmar), actividad
  y 9 mutaciones de HC; dashboard con acceso resuelto fuera del `unstable_cache` y `Date` rehidratadas; export
  CSV con `archived: exclude|include|only`, audit `patient.export`, escape de fórmulas (`lib/csv.ts:24`) y basic
  enmascarado, movido a `lib/patients-export-internal.ts:33` (`server-only`; única puerta
  `app/api/pacientes/export/route.ts:49`). Decisión: archivar exige `full`.
- 🟢 **A2b-S-cfg · montos + equipo:** `MoneyInput` (`components/ui/money-input.tsx`, string math sin float)
  cierra el copago de $50 bloqueado y el error ×100; audit antes/después en servicios y OS; `removeMember`
  rechaza con conteo si hay turnos futuros o pacientes asignados; `listPractitioners` (`lib/bookings.ts:421`)
  solo membresías aceptadas; tag `practitioners` invalidado.
- 🟢 **Fixes de la revisión de A2:** discriminante de reserva pública **por key** (`isPublicReservation`,
  `lib/booking-capacity.ts:97`: reconoce `pub:<tenant>:<uuid>` y el formato pre-A2; ante la duda retiene);
  `isHoldingCapacity` (`:132`) vence UNPAID **y** FAILED; un guest al que se le asigna paciente pasa a CONFIRMED
  y `BookingUpdate` ya no acepta PENDING.
- 🟢 **A3a-S-rl · rate-limit:** Upstash con try/catch + `AbortSignal.timeout(1500)` (`lib/rate-limit.ts:177`) +
  validación de respuesta + fallback a memoria con log `rate_limit.upstash_fallback` (`:145`) + prefijo
  `rl:<VERCEL_ENV|dev>:` (`:58`) + purga del `Map` (10k claves, `:45`). `clientIp` único (`lib/client-ip.ts`),
  `rateLimitAll`, `hashKeyPart`; límites nuevos en invitaciones, portal invite, `acceptInvite` y login/forgot por
  hash de email; 429 uniforme. Tabla en [SECURITY.md §8](SECURITY.md).
- 🟢 **A3b-S-auth · sesión, cookies, identidad:**
  - El middleware refresca la sesión (`getAll`/`setAll` + `getSession()`, `middleware.ts:69-87`) y marca
    `private, no-store` si hubo Set-Cookie (`:129`); el strip de `x-tenant-*` y el `x-request-id` siguen
    (`:109-119`).
  - Cookies de Supabase httpOnly + secure (prod) + lax (`lib/supabase/cookie-options.ts:23-27`).
  - **Open redirects cerrados:** `safeNext`/`safeNextFromUrl` (`lib/safe-next.ts:29,91`) en sign-in, sign-out,
    google, callback y login (`next=@evil.com` en callback/sign-out era explotable). `isAllowedOrigin` en los 3
    POST de auth (`app/api/auth/sign-in/route.ts:31`).
  - Login con mapa cerrado de códigos de error; Google sin `prompt=consent`/`access_type=offline`; wizard y
    portal por form POST (antes 405).
  - `/auth/confirm` (`verifyOtp`) y cookie `ks_recovery` httpOnly de 15 min firmada HMAC
    (`lib/recovery-cookie.ts:28-49`).
  - **Staff ≠ paciente:** portal (`lib/portal.ts:61-63`), callback (`app/auth/callback/route.ts:62`),
    `createInvitation` (`lib/invitations.ts:148`, solo el propio tenant) y `acceptInvite`
    (`app/invite/[token]/accept-action.ts:64`).
  - **Check-in que pisaba notas:** `submitCheckIn` (`lib/portal.ts:196`) ya no escribe `Patient.notes`: EvaScore +
    notificación al asignado (u OWNER/ADMIN) + audit `portal.checkin`. Portal con email case-insensitive.
  - Invitaciones: re-invitar actualiza datos; el token no se loguea; "Crear mi cuenta para unirme".
- 🟢 **A3b-S-obs · Sentry, CSP, headers, Next:** Next 14.2.18 → **14.2.35** (CVE-2025-29927 bypass de
  middleware, y 56332, 32421, 57822, 55183/55184/67779); `@sentry/nextjs` 11.1.0, **no-op sin `SENTRY_DSN`**
  (`instrumentation.ts:10`), `sendDefaultPii:false` + `beforeSend*` por `redact()`
  (`lib/observability-config.ts:42-51`), sin SDK de cliente; `lib/redact.ts` en logger y Sentry; CSP (sigue
  Report-Only) con report-uri/report-to → Sentry, Google Fonts, youtube-nocookie, form-action Supabase +
  Google (`next.config.mjs:77-96`); HSTS con preload solo en Production (`:113`); `allowedOrigins` sin
  localhost en Production.
- 🟢 **A3c · signup verificado + stepper de alta (cierra H5):**
  - **Signup** (`signUpPractitioner`, `lib/auth.ts:49`): `auth.signUp` con
    `emailRedirectTo=<APP_URL>/auth/confirm?next=/onboarding` (`:108-112`). Se eliminaron
    `admin.createUser({ email_confirm: true })` y la creación de tenant en el signup. Rate-limit 3/10 min por IP
    + 3/h por hash del email (`:82-85`). Un email de paciente con portal recibe la **misma respuesta** sin mail
    ni tenant (anti-oráculo, `:98-104`). Si Supabase devuelve sesión (Confirm email OFF) se loguea
    `signup.confirm_email_disabled` (`:131-133`).
  - **Gate de la app** (`app/(app)/layout.tsx` → `decideAppGate`, `lib/onboarding-logic.ts:100`): sin sesión →
    `/login?next=` (el path sale de `x-pathname`, que setea el middleware en `middleware.ts:123-124`, y pasa por
    `safeNext`); sin membresía → `/onboarding`; OWNER con `Tenant.onboardingCompletedAt == null` → `/onboarding`.
  - **Stepper `/onboarding`, pasos 2-7** (`lib/onboarding.ts`, `lib/onboarding-internal.ts`,
    `components/onboarding/**`): el paso 2 (`saveOnboardingClinic`, `:35`) crea Tenant + Practitioner + OWNER +
    Insurer "Particular" + audit en una tx vía `bootstrapTenant` (`lib/tenant-bootstrap.ts:64`), con slug
    derivado del nombre y estable al re-editar; repetir el paso 2 edita sin duplicar. Los pasos 3-6 reusan
    `setBusinessHours`, servicios, OS e invitaciones. El paso 7 (`completeOnboarding`, `:161`) exige ≥1 servicio
    y es idempotente (`updateMany … onboardingCompletedAt: null`). Una invitación pendiente se ofrece en
    `/onboarding` (`openPendingInvitation`, `:195`).
  - **Unión por invitación:** `/signup?invite=<token>` fija el email de la invitación, no crea tenant y usa
    `emailRedirectTo=/auth/confirm?next=/invite/<token>` (`lib/auth.ts:62-78`).
  - **Reset** (`updatePasswordWithRecoverySession`, `lib/auth.ts:206`): con cookie `ks_recovery` válida del mismo
    usuario no pide la contraseña actual (cookie de un solo uso: se borra tras el éxito); sin cookie exige la
    actual, con 5/10 min por usuario. `sendPasswordReset` (`:145`) usa
    `redirectTo=<APP_URL>/auth/confirm?type=recovery&next=/reset` (`:183`).
  - `scripts/create-tenant.ts` usa `bootstrapTenant`: ahora crea "Particular" y rechaza un Practitioner de otro
    tenant (`PractitionerElsewhereError`).
  - Tests: unit `onboarding-logic` (13), integración `signup` (10) y `onboarding` (8).
- **Hallazgos nuevos de A2/A3** (clasificados; filas en §2 "Hallazgos 23-sep y A2/A3"):
  - [C0] los write-paths validan practitioner ∈ tenant pero **no membresía aceptada**.
  - [C] el batch no rechaza una `idempotencyKey` de otro tenant (usa `update: {}`, no escribe).
  - [C] TOCTOU de cupo 1 entre chequeo e INSERT (agenda y pública); el pago tardío sobre una reserva vencida
    confirma y avisa sin revalidar el cupo.
  - [C1] `formatARS` no muestra centavos en listados; destildar el copago de una reserva pública la vuelve
    UNPAID y puede quedar vencida (aceptado); /seguimiento pasó de 1 a ~7 queries en 1 tx.
  - [C1 · portal v2] `getPortalPlan` expone `Session.notes` del kine al paciente.
  - [ops] `.env.local` define `NODE_ENV` → `next build` local falla en el prerender (ver TESTING.md).
  - **[A · cerrado 30-sep]** **`signup-confirm-doble-salto`** (hallado al documentar el cierre de A3c): el
    `emailRedirectTo` era `<APP_URL>/auth/confirm?next=/onboarding` y la plantilla pone `next={{ .RedirectTo }}`,
    así que `/auth/confirm` redirigía a sí mismo sin `token_hash` → "link inválido" con la cuenta ya verificada
    (igual en unión por invitación). Fix: `emailRedirectTo = <APP_URL><destino>` y `redirectTo = <APP_URL>/reset`
    (`lib/auth.ts`), más `unwrapConfirmNext` en `/auth/confirm` para links viejos (`lib/safe-next.ts`,
    `app/auth/confirm/route.ts`). Test: `tests/unit/safe-next.test.ts` "unwrapConfirmNext" recorre el link de la
    plantilla.
  - [C0] (A3c) `phone`/`whatsapp`/`publicEmail` del tenant solo se editan en el stepper: faltan en Configuración
    (`updateTenantBasics`).
  - [C] (A3c) un OWNER con el alta sin terminar que además acepta la invitación de otro tenant: en los pasos
    3-6 `getActor` puede elegir el otro tenant. Caso raro.

**Ronda 13 — B-pre: fundaciones de agenda y catálogo (30-sep / 01-oct-2026):** catálogo global, agenda por
profesional × sede, motor de disponibilidad único, capabilities, agenda multi-profesional de Secretaria
(Por profesional, Recepción, candado por día) y modal de turno nuevo. **Código completo; pendiente commit,
deploy y QA de Martin, más el import del catálogo.** ⚠️ **DOS migraciones nuevas:**
`20260930200000_catalog_global` y `20261001090000_agenda_foundations` (orden de prod en
[MIGRACIONES-RUNBOOK.md §2.2](MIGRACIONES-RUNBOOK.md)). Arquitectura en
[ARCHITECTURE.md §Agenda profesional y catálogo](ARCHITECTURE.md) (ADR-003). QA en [QA.md §B-pre](QA.md).

Gate de cierre (01-oct): `tsc` 0 · unit **1156/1156 en 51 archivos** (TZ=UTC y TZ=AR, incluye render tests) ·
guard ✓ · integración **395/395 en 28 archivos** (`kinesoft_app`) y 379 + 16 skip (owner) · `next build` ✓ ·
perf B4.6 en [PERF.md](PERF.md). Las líneas de `lib/bookings.ts` de abajo son del 01-oct; el fixer final seguía
editando el archivo (las marcadas `~`).

- 🟢 **B1 · catálogo global:**
  - Migración `catalog_global`: 6 tablas + 2 enums, punteros nullable `Insurer.payerId`, `Coverage.payerPlanId`,
    `Service.practiceId` (FK SET NULL), RLS **GLOBAL_READONLY** (solo policy SELECT) y PayerPlan split, índices
    parciales de PayerPlan con comentario (`prisma/migrations/20260930200000_catalog_global/migration.sql:1-40`).
  - Guard de aislamiento: parsea **todas** las migraciones y exige el contrato GLOBAL_READONLY
    (`scripts/guard-tenant-isolation.mjs:37,52,84,188-209`). Antes leía solo `20260725120000_rls_policies`.
  - Import `scripts/catalog-import.ts` + `lib/catalog/{normalize,csv,import-core}.ts`: dry-run por defecto, una tx,
    no pisa curado (`lib/catalog/import-core.ts:590`) ni desarchiva, seed create-only, `CatalogImportRun`,
    exige BYPASSRLS. Datos oficiales en `prisma/catalog/` (780 prestadoras SSS RNOS/RNEMP/COSSPRA, 71 planes,
    91 especialidades REFEPS, 70 prácticas PMO/curadas + seed del benchmark; `SOURCES.md` CC BY 4.0).
  - Plataforma → Catálogo (`lib/catalog-admin.ts`): buscar, editar (`curatedAt`), archivar, merge de
    prestadoras/prácticas, promover planes propuestos, importaciones y "Refrescar catálogo" (`:494`).
  - Adopción en el consultorio (`lib/catalog.ts`, `lib/catalog-validate.ts`): Obras sociales del catálogo,
    práctica en el servicio, plan del paciente con "Otro plan…". Ids validados (global o propio, no archivado).
  - **Capabilities** `lib/capabilities.ts:56` + `lib/authz.ts` reemplazan los 6 chequeos de admin copiados.
  - Refactors sin cambio de comportamiento: `lib/booking-schedule.ts` (S07, hoy oráculo congelado), modal y
    drawer partidos en carpetas, `agenda-toolbar`, `grid/booking-card`.
- 🟢 **B2 · M-agenda + motor + APIs de configuración:**
  - Migración `agenda_foundations`: Location, PractitionerSchedule, ScheduleException, TimeBlock,
    PractitionerService, PractitionerPayer, PractitionerSpecialty, Booking expand, `UserPreferences.agendaPrefs`,
    RLS + CHECKs + índices parciales, **backfill idempotente** con `SET LOCAL row_security = off`
    (`prisma/migrations/20261001090000_agenda_foundations/migration.sql:353-487`), incluido el paso 3b
    (`:427-449`).
  - Motor puro `lib/availability/*` con paridad contra el turnero y el suggest viejos; loader único
    `lib/availability-loader.ts` (dos canales, `where tenantId`, fallback, `NO_LOCATION_ID`).
  - APIs `lib/locations.ts`, `lib/practitioner-schedule.ts` (+ `lib/schedule-validate.ts`),
    `lib/practitioner-services.ts`, `lib/practitioner-payers.ts`, `lib/time-blocks.ts`; altas que nacen con sede,
    franjas, PS y PP (`lib/agenda-defaults.ts`); `setBusinessHours` sincroniza la plantilla por defecto.
  - **Bug de reloj cerrado:** `toARMinutes`/`toARHour` devolvían 1440/24 a la medianoche AR
    (`lib/datetime-ar.ts:77-83`, `% 24`).
- 🟢 **B3 · motor conectado:**
  - `lib/bookings.ts` sobre el motor: el suggest ve turnos en curso (240 min atrás) y bloqueos; avisos blandos
    `blocked`/`outOfHours` forzables; batch con `frequency` y `count` validado con zod (antes NaN reventaba);
    escribe `isOverbooked` (+ prefijo), `locationId`, telemedicina; PS deshabilitado → rechazo
    (`SERVICE_DISABLED_ERROR`, `:313`).
  - **`cupo-1-toctou` cerrado en agenda y turnero:** lock de cupo por (profesional, servicio, día AR) dentro de
    la tx que cuenta y escribe (`lib/booking-cap-lock.ts`; `lib/bookings.ts:1136,1432,~2237`;
    `lib/public-booking.ts:516`). Test de carrera determinístico con `pg_locks`
    (`tests/integration/bookings-availability.test.ts:441`). Queda abierto el pago tardío del webhook (ver §2).
  - Turnero público sobre el motor: franjas por profesional, excepciones, bloqueos duros, solo PS PUBLIC y
    habilitado, solo profesionales con membresía aceptada (`lib/public-booking.ts:74-108`), sede,
    `findFirstPublicSlot`.
  - `lib/availability-actions.ts`: lecturas sin PHI y sin cache. Configuración: pestañas Sedes y Profesionales.
- 🟢 **B4 · agenda multi-profesional:**
  - `listAgendaBookings` (`lib/bookings.ts:673`): proyección sin el grafo paciente → coberturas → programas +
    gate `clinical.read`. Medido en B4.6: 60 ms vs 78 ms de la vieja, pero el payload de la semana de 6
    profesionales es ~1 MB (1.036 kB vs 786 kB: suma sede, recepción y telemedicina por fila) → C1.
  - Recepción (`markReceptionAction`, `lib/bookings.ts:~1706`), candado por día con preview, mantener/cancelar
    y carrera detectada (`lib/time-blocks.ts:567`, `cancelBookingsInTx` respeta H1), vista Por profesional,
    chips con favoritos, filtro de sede, prefs `agendaPrefs`, badges en las cards.
  - Re-chequeo de bloqueos **dentro** de la tx de alta/edición/batch, después del lock de cupo
    (`lib/bookings.ts:1136-1159`).
  - Carga diferida en /agenda (`components/agenda/agenda-client.tsx:89-95`): bundle 238 → 195 kB.
- 🟢 **B5 · modal y superficies:** modos Turno / Varias sesiones / Bloquear horario, slot picker con "cualquier
  profesional", estado en vivo, sede y telemedicina; drawer, turnos del paciente y dashboard manejan los avisos
  nuevos; turnero con filtros de sede y cobertura y fix mobile 375 px; onboarding de 9 pasos (Sede, Tu horario,
  práctica, OS del catálogo).
- 🟢 **Fixes de la revisión de B-pre** (los marcados *fixer* ya están en el código al 01-oct; el fixer todavía podía
  ajustar líneas):
  1. [MEDIA] rechazo "servicio no habilitado" = regresión para el cliente vivo con 2 profesionales → paso 3b
     del backfill (PRIVATE para todo par con turnos no cancelados) y copy del slot picker "No atiende este
     servicio — habilitalo en Configuración → Profesionales" (`components/agenda/booking-modal/slot-picker.tsx:341`).
  2. [MEDIA-BAJA] al asignar un servicio compartido a un profesional, los demás quedan PRIVATE
     (`lib/services.ts:229-241`, *fixer*).
  3. [MEDIA-BAJA] `markReceptionAction`: un PRACTITIONER (sin `agenda.manageBlocks`) solo opera turnos propios o
     de pacientes con acceso completo; guest ok (`lib/bookings.ts:~1748-1750`, *fixer*).
  4. [BAJA-MEDIA] "Deshacer" de recepción vuelve a PENDING para guest o reserva pública impaga, no a CONFIRMED
     (`lib/reception-state.ts:40-49`, *fixer*).
  5. Runbook: UPDATE post-deploy de `isOverbooked` y precheck del rol de `DIRECT_URL` (MIGRACIONES-RUNBOOK §2.2).
- **Hallazgos nuevos de B-pre** (clasificados; filas en §2 "Hallazgos de B-pre"):
  - [C1 perf] `weekOccupancy` O(n+filas); batch en 1 tx; `createBooking` 34 statements; `previewRecurrence`
    mensual 106; payload /agenda ~1 MB/semana; harness de EXPLAIN de A1 con params tipados; índice
    `Coverage.patientId`; bundles por encima del presupuesto.
  - [C1] zoom 15/30/60 en Día/Semana; `StatusTag`/`fmtMoney` duplicados (`formatARS` sin centavos ya estaba).
  - [C] regla `.booking-body` de `globals.css`; texto fijo "lun-sáb 8 a 19hs" del turnero;
    `PUBLIC_OVERLAP_LOOKBACK_MS` sin uso.
  - [C0] login de Secretaria sin fila Practitioner (`lib/session.ts:91-97`).
  - [catálogo] 37 siglas ambiguas sin alias (OSPA no se busca por sigla); Sancor 1000/1500 y especialidades de
    Mendoza por verificar.

**Ronda 14 — Planes P0 (ES1): fugas E0, Secretaria (E1), fixes de planes y cimientos (04-oct-2026):** ejecutada en
develop según [PLANES.md §8](PLANES.md). **Sin migraciones.** Pendiente: commit de Martin y QA de staging
([QA.md §Planes P0](QA.md)). Nada se despliega hasta cerrar B (decisión del 04-oct): las fugas E0 siguen vivas en
prod salvo hotfix (PLANES.md, "Abierto para Martin" (1)). Filas cerradas en §2 "Hallazgos del planning de Planes";
los cimientos (motor y plata puros, loader por días, locks, `auditInTx`, dedupe) no tienen callers hasta ES2b.

- 🟢 **E0 (fugas vivas, bloque A):**
  - `getPatient` borrada: era una server action sin gate que devolvía la HC completa por RPC
    (`tests/integration/patients-rpc-surface.test.ts:66-68` afirma que el export no existe).
  - Firmador de media: `lib/exercise-media.ts` ya no exporta firmadores (`:10-12`); `signExerciseMedia(mediaId)`
    carga la fila y firma su clave (`lib/exercise-media-internal.ts:56`). Nada firma una clave que mande el cliente.
  - Storage por service role: `lib/storage-internal.ts:68,86,104` (upload/sign/remove chequeando `{error}`), usado
    por `lib/files.ts:39` con los gates de hoy. **Lado prod = precheck (17)** (buckets privados, sin policies
    anon/authenticated) y `SUPABASE_SERVICE_ROLE_KEY` en Vercel.
  - `listBookingsInRange` con `bookingFieldAccess` (`lib/bookings.ts:727`) y `patientCondition` solo con
    `clinical.read` + full (`:744-777`); programas con `orderBy createdAt desc` (`:697`).
- 🟢 **E1 (Secretaria):**
  - Nivel de acceso **`admin`** (PD-13): un rol sin `clinical.read` tiene siempre exactamente `admin` sobre todos los
    pacientes del tenant, también con "Consultorio común", share o asignación (`lib/visibility.ts:138,153-155,200,249`).
    Campo nuevo `Visibility.adminView` (`:90`). Cambio visible: `seesAll=false` para esos roles → el dashboard de
    Secretaria/Facturación queda con alcance propio y Seguimiento vacío.
  - Predicados puros `canOperateBooking` = `full || agenda.operateAll` y `canWriteClinical` = `clinical.read &&
    full` (`lib/capabilities.ts:182,192`), en forma positiva: con `admin`, la forma `!== "basic"` dejaría operar a
    BILLING. `bookingFieldAccess` (`lib/booking-field-access.ts:34`): un campo se escribe si y solo si se lee.
  - Turnos: gate `canOperateBooking` en create/batch/update/status/cancel y los campos clínicos se sacan del patch
    **antes** del write y del audit (`lib/bookings.ts:162-212`); `AgendaBookingRow.canOperate`/`clinicalWritable`
    calculados en el server (`:943`); `admin` ve obra social, cobertura y estado de cobro, nunca texto clínico
    (`:745,904,945`). Borrar turnos y cobros siguen pidiendo full (matriz de cobros → C0).
  - Pacientes: `createPatient(raw, {assignTo})` deja la ficha a cargo del profesional del turno, validado en la tx
    (`lib/patients.ts:757-857`); BILLING no crea; `getPatientCore` devuelve la proyección `admin` (`:332-402`);
    `setPatientDiagnosis` exige `canWriteClinical` (`:1026-1036`). Audits nuevos: `patient.create`
    `{assignedPractitionerId, clinicalIgnored?}` y `patient.read.admin`.
  - UI: drawer opera con `canOperate` y edita texto con `clinicalWritable`; "Usar como diagnóstico" ya no borra el
    diagnóstico (`components/agenda/booking-drawer/index.tsx:18-21,163,265`); perfil administrativo sin pestañas
    clínicas y "Agregar turno" solo con `agenda.operateAll` (`components/patients/patient-profile.tsx:356-397`,
    `app/(app)/pacientes/[id]/page.tsx:56`); la Secretaria crea pacientes solo desde el modal del turno.
- 🟢 **Fixes de planes:** gates full en `createProgram` (`lib/programs.ts:164-187`, zod + día AR), Diagnóstico
  (`lib/diagnosis.ts:208-280`) y plantillas (`lib/plan-templates.ts:172-224`); ejercicios `assignableExerciseWhere`;
  dosis `?? 3/12`; tope 60; días elegidos en Diagnóstico; portal sin `Session.notes` y con el ACTIVE más reciente
  (`lib/portal.ts:150-168`); ICS con `bookingFieldAccess` (`lib/bookings-export-internal.ts:68-84`); `addCustomSession`
  con `FOR UPDATE` del programa (`lib/sessions.ts:~745`); fechas de plan en día AR en las 4 superficies; StatusTag
  único (`components/ui/status-tag.tsx`); tokens (`app/globals.css:26,34,51-52,63+`); perfil con el ACTIVE más
  reciente + "+N" (`pickProfilePrograms`, `patient-profile.tsx:63`).
- 🟢 **Cimientos sin callers (ES2b los consume):** `runWithRls(..., {timeout, maxWait})` + `auditInTx`;
  `lockCapacityMany` y `lockPlanPatient` (`lib/booking-cap-lock.ts`, `lib/plan-lock.ts`); motor puro
  `lib/availability/plan.ts` + `patientConflictsAt` + `nextFreeSlot({until})`; `lib/plan-schedule.ts`;
  `loadAvailabilityInputsForDays` (`lib/availability-loader.ts`); `lib/plan-pricing.ts` y `lib/plan-display.ts`;
  `lib/sessions-internal.ts` (`completeSessionInTx:67`, `reopenSessionIfUntouchedInTx:152`); dedupe de
  `(programId, index)` (`scripts/plans-dedupe-session-index.ts`, dry-run local: 0 duplicados); `tests/perf/compare.ts`
  y `PERF_OUT_DIR`; `tests/helpers/advisory-wait.ts`.
- **Revisión P0.Z:** revisor (a) 0 altos, revisor (b) 0 fugas nuevas. Sus ítems (A1, A3-A5, H-b1..H-b4) están en §2
  como "cerrado en P0.Z (fixer)" (verificados en el archivo y con tests `[P0-Z]`: `tests/unit/plan-pricing.test.ts`,
  `tests/unit/availability-plan.test.ts`, `tests/integration/sessions.test.ts`, `tests/integration/es1-review-fixes.test.ts`).
- **Gate de ES1 (04-oct, en solitario sobre el Docker):** `tsc` 0 (app y `tsconfig.scripts.json`); unit 1451/1451 en UTC
  y en AR; guard OK; `next build` OK; `perf:bundle` sin excesos; integración completa 572 + 1 skip (`kinesoft_app`) y
  555 + 18 skip (owner BYPASSRLS); perf + `compare.ts` sin regresiones (28 escenarios); 0 `it.fails` pendientes.
- **Perf (fixer 3):** las 7 "regresiones" que dio `compare.ts` ya estaban en HEAD `3ff2e50` (medido con `git archive`
  de HEAD contra el mismo Docker): `agenda-multi.json` se grabó antes de `liveBlocksInTx` (re-lectura de bloqueos con el
  lock de cupo, +1 por tx de escritura) y las filas A1 `createBooking`/`createBookingsBatch.20` se emparejaban por nombre
  con un camino sin motor. `compare.ts` lleva `REFERENCE_ERRATA` documentada; **al regrabar los JSON, borrarla en el
  mismo cambio**. Deltas de ES1 solo informativos: `listBookingsInRange` y el perfil leen Membership una vez más
  (`getMembershipRole` en tx propia). Pendientes perf (C1): batch con `create` + catch P2002 en vez de `upsert`
  (~40 sentencias menos en 20 turnos; cambia la semántica de un write-path), rol duplicado en `listBookingsInRange` y
  perfil, `bulkPatientAccess` re-lee tenant/membership ya leídos por `visibilityForActor`; la regla `plus10` de
  `listOpenSessions*` no matchea ninguna fila (loaders lo mide como `seguimiento`).
- **Hallazgos nuevos** (filas en §2 "Hallazgos del planning de Planes"): `lib/search.ts` (C); edición de contacto y
  cobertura por la Secretaria, selector "Profesional a cargo", proyección `admin` del directorio y filtros/selector de UI
  sin `clinical.read` (C0); "Deshacer
  Atendido" no reabre una sesión a medida (B, ES2b/S12b); wizard mobile sin días (S23); tooltip de `edit-toggles`
  (P3); `--app-bg` del invite (C); `lockCapacityScope` → `lockCapacityMany` (C1).

**Ronda 15 — Planes P1 (ES2a): migración M1 `plans_booking_link` (04-oct-2026):** ejecutada en develop según
[PLANES.md §9](PLANES.md). **1 migración nueva**, aplicada y verificada **solo en el Docker local**; staging y prod
van en el deploy único del cierre de B (desde el 07-oct, desde vacío: [MIGRACIONES-RUNBOOK «Go-live con reset»](MIGRACIONES-RUNBOOK.md)).
Commit `0edb0c8`. sha256 de `migration.sql` = `7a0e279799547192c135e70f5e87dbe28db873406de67efee7ec9872300445cd`; el bloque SQL de
PLANES §3 es idéntico al archivo.

- 🟢 **M1 escrita (S10a/b/c):** FK turno↔plan/sesión + 3 FKs compuestas (la red bajo BYPASSRLS), 4 únicos parciales
  (`Session_programId_index_live_key`, `Booking_session_active_key`, `ProgramAuthorization_programId_current_key`,
  `PatientChangeRequest_patient_pending_key`), precio por sesión/paquete, disciplina, responsable (backfill con guarda
  sin-BYPASSRLS), `archivedAt`, idempotencia por tenant, tags DISCIPLINE, `ProgramAuthorization` y `PatientChangeRequest`
  con RLS ENABLE + FORCE + policy (guard OK), `Patient_userId_key` → `Patient_tenantId_userId_key` (DROP INDEX aprobado
  el 03-oct). Schema con `map:` a los nombres del SQL; `UserProfile.patients` 1:n. ADR-001 → ACCEPTED.
- 🟢 **Revisión P1.Z (cerrados por el fixer):**
  - **F1 `pricing-check-null-mode`:** `TreatmentProgram_pricing_check` y `PlanTemplate_pricing_check` usaban `=`; con
    `pricingMode` NULL el disyunto da NULL (lógica de 3 valores) y el CHECK aceptaba un precio sin modo. Ahora `IS NOT
    DISTINCT FROM`. **Enmienda de C1** (decisión del orquestador, avisada a Martin). Una base que haya aplicado la
    versión vieja se arregla con la nota de RUNBOOK §2.4.
  - **F2 `dedupe-agrupa-archivadas`:** el dedupe agrupaba sesiones archivadas con vivas. Ahora filtra `"archivedAt" IS
    NULL` si la columna existe (`lib/plans-dedupe-internal.ts:72-85`); post-M1 el dry-run da 0 y sigue siendo una
    herramienta pre-M1.
  - Comentario del SQL corregido: el `DROP INDEX` toma ACCESS EXCLUSIVE sobre Patient (también lecturas) hasta el
    COMMIT. El RUNBOOK pide ventana sin uso para todo M1, no solo para el dedupe.
- **Notas de la revisión** (sin cambio de código):
  - `Booking_patientId_fkey` es `ON DELETE SET NULL` desde `init` (`prisma/migrations/20260518134107_init/migration.sql:614`);
    si un día se borrara un paciente con turno de plan, el SET NULL violaría `Booking_plan_patient_check`. Hoy no pasa
    porque `TreatmentProgram→Patient` es RESTRICT y frena antes. Tenerlo en cuenta si se toca el borrado de pacientes.
  - Un RESTRICT de FK llega como SQLSTATE **23503** (`foreign_key_violation`), no 23001: los tests y los mapeos de
    error de ES2b tienen que esperar 23503 / P2003.
- **Gate de ES2a (04-oct, en solitario sobre el Docker):** M1 aplicada en local con `migrate deploy`, `migrate status` al día (28 migraciones), sha256 `7a0e2797…45cd` = checksum, SQL idéntico a PLANES §3; `migrate diff` = solo las 3 FKs compuestas de Booking (drift aceptado); integración con el cliente VIEJO sobre el schema nuevo en verde (568+5 skip app, 552+21 skip owner); `tsc` 0 (app y scripts); unit 1451/1451 UTC y AR; guard OK (30 modelos con tenantId); `next build` OK; `perf:bundle` sin excesos; integración completa 632+19 skip (`kinesoft_app`) y 625+26 skip (owner); perf + `compare.ts` sin regresiones; 0 `it.fails` pendientes.
- **Hallazgos nuevos para ES2b** (bloque B; filas en §2 "Hallazgos del planning de Planes"):
  `delete-service-sin-contar-planes` y `hard-delete-plan-session` ahora con la causa concreta post-M1 (P2003 → 500).

**Ronda 16 — EV0: verticales, /plataforma de consultorios y Data API (07-oct-2026) ✅ (commit `ddfdff3`):** ejecutada
en develop según [VERTICALES.md](VERTICALES.md) (decisiones de Martin del 07-oct: reset de prod, verticales General /
Kine base / Kine PRO, Sala de Espera realtime). **1 migración nueva**, M2 `20261007120000_tenant_verticals`, aplicada
y verificada **solo en el Docker local** (sha256 en [MIGRACIONES-RUNBOOK «Go-live con reset»](MIGRACIONES-RUNBOOK.md));
va desde vacío en el deploy único de B. Olas V.0 (M2 sola) → V.0b → V.1 → V.2 → V.Z (integrador, 2 revisores de solo
lectura, fixer). Orden siguiente: **ES2b** → ES3 → SV → ES4 → EV1 → reset + deploy único.

- 🟢 **Cerrados** (filas en §2 «Hallazgos y filas de EV0»): `tenant-verticals`, `plataforma-consultorios`,
  `turnero-sin-switch`, `entitlements-escritor-unico`, `audit-plataforma-en-tenant-afectado`; en código,
  `data-api-anon-sin-rls` (REVOKE en M2 + guard 3c; **la acción de consola de Martin sigue pendiente**).
- 🟢 **Bugs vivos cerrados en la corrida:**
  - **EV-G:** el ⌘K buscaba condiciones sin filtro de tenant (con BYPASSRLS mostraba nombres de condiciones custom de
    otros consultorios). Ahora `OR [{tenantId:null},{tenantId}]` y solo con el módulo `diagnostico` (`lib/search.ts:76-83`).
  - **V.Z P1 (bloque A, preexistente):** `loadFilterFacets` (`lib/exercises.ts:137`) listaba las condiciones custom de
    todos los tenants; ahora filtra por tenant y devuelve `[]` sin `diagnostico` (el módulo va en la clave de cache).
  - **V.Z P2 (bloque B, preexistente, PD-14):** el prefill del turnero buscaba la ficha por email en **todos** los
    consultorios (`findPatientByEmailForPrefill` sin `tenantId`): un paciente de A que abría `/c/B/booking` veía DNI,
    nacimiento, cobertura y contacto de emergencia cargados por A, y B los recibía al reservar. Ahora `tenantId` es
    obligatorio y el criterio es ficha con `userId` = usuario → única ficha con ese email → nada
    (`lib/public-booking-internal.ts:146-185`). Entre consultorios solo viaja el nombre de la sesión. **Corrige** la nota
    vieja de SECURITY §2 que lo daba por intencional.
- 🟢 **Revisión V.Z (cerrados por el fixer):**
  - **N1:** `lib/programs.ts` sin gate de módulo → escrituras con `requireModule('planes')`, lecturas `[]`.
  - **N2:** `createExercise` devuelve `ActionResult` con `MODULE_DENIED_COPY.ejercicios` y `ensureTag` tira sin
    `gate.canCreate` (`lib/exercises.ts:229,275`).
  - **B1-B8 (UX):** `Switch` con `aria-label`; el Drawer de /plataforma refresca ante stale; copy "Turnos online" /
    "Activo" / "Apagado" / "Titular"; lista de consultorios sin Miembros/Creado (quedan en el detalle); atajos ⌘K
    "Inicio"/"Ejercicios" iguales al nav; comentario de `lib/authz.ts` corregido; tests de `BookingUnavailable` y
    `TabsBar` de Configuración.
- **Enmiendas nuevas a sesiones pendientes** (VERTICALES §5, copiadas en PLANES §10-§11): `searchPatientsForAssignment`
  → S17d; `recordEvaScore`/`getPatientEvaScores` → S22b; `getSessionsChart` y la clave de cache del dashboard → S14;
  sobrevivientes de `programs.ts` → S15/S27a; función de la policy de realtime sin GRANT a `authenticated` → SV01.
- **Aceptado:** el nav del layout no se repinta en navegación suave después de un cambio desde /plataforma (los guards
  sí redirigen): recargar.
- **Gate de EV0 (07-oct, en solitario sobre el Docker):** M2 aplicada en local (`migrate status` al día, 29 migraciones); `tsc` 0 (app y scripts); unit 1577/1577 en TZ=UTC y TZ=AR; guard OK (incluido 3c de grants); `next build` OK (sin Suspense extra para `useSearchParams`: `(app)` es dinámico); `perf:bundle` sin excesos; integración completa 706 + 19 skip (`kinesoft_app`) y 699 + 26 skip (owner); perf + `compare.ts` sin regresiones; greps §15.9: entitlements solo por el escritor único (más seeds dev), 4/4 `requireSuperAdmin` en `lib/platform-tenants*`, 0 lecturas de PHI; 0 `it.fails` pendientes.

**Ronda 17 — Planes P2 (ES2b): core de turnos y dominio server de Planes (07-oct-2026) ✅ (commit `58ec36f`):**
ejecutada en develop sobre `ddfdff3` según [PLANES.md §10](PLANES.md), con las enmiendas EV0/SV. **Sin migraciones
nuevas** (M1 re-aplicada como no-op en el gate). Olas P2.0.0 (P2-C1) → P2.0 (S07c, S13, S13g, S13x, S14) → P2.1 (S11e,
S11v, S12, S12p) → P2.2.0 (P2-C2) → P2.2 (S12b, S15, S16a, S16b, S17d, S25a, S11x) + P2-FX1 → P2.Z (integrador, 2
revisores de solo lectura, 3 fixers: motor, Seguimiento, plata). Todo es server: la UI llega con ES3 (handoffs en
PLANES §10 «Handoffs para ES3»). Arquitectura en [ARCHITECTURE.md §Módulos de Planes ES2b y ADR-004](ARCHITECTURE.md).

- 🟢 **Cerrados del planning** (filas en §2 «Hallazgos del planning de Planes»): `updateProgram-desincroniza-total`,
  `hard-delete-plan-session` (S15), `delete-service-sin-contar-planes` (S13), `ensureTag-kind-libre` (S13x),
  `reception-p2002-500`, `upsert-holder-pisa-turno-de-plan` (S12), `dashboard-session-index-crudo` (lado server, S14;
  la página de Seguimiento es P3-S20), `deshacer-atendido-no-reabre-sesion-a-medida` (S12b: `Session.title`).
  `retroactive-copago-on-coverage-replace` queda 🟡 **parcial** (Q8 de S12: el copago se congela al marcar Cobrado); el
  resto → C0.
- 🟢 **Hallazgos de la revisión, cerrados en P2.Z** (filas en §2 «Hallazgos de ES2b»): bug `moved/currentAt` del motor,
  H-a1 (sesión realizada con turno activo), H-a2 (deadlock Seguimiento ↔ re-planificar/adoptar), `addCustomSession`
  sin motor (H-a3 = B-M1), P2002 de `rescheduleSession` (H-a4), reprecio PACKAGE con filas sin precio → 500 (B-M2),
  cobro previo desincronizado por `toggleBilling` (B-M3), `listAllTags` sin gate (B-L1), `listPlanTemplates` sin gate
  (B-L2), "usadas" de la autorización con dos criterios (B-L3), buscador de pacientes de la agenda roto por H-b4
  (P2-FX1), `searchPatientsForAssignment` con archivados, `deleteTenantDeep` con planes ajenos.
- **Nuevos abiertos** (clasificados en el momento; filas en §2): `applyDayLock`/`createTimeBlock`/`createBooking` sin
  reintento P2034 (C0/C1); turnero, webhook MP y bloqueos sin `afterBookingsCommitted` (SV06); gates reimplementados
  en `rescheduleSession`/`createProgram`/`applyPlanTemplate` (S27a); `onCreateTag` no muestra el error (C1); aviso de
  autorización por vencer (C1); OS pagada en el saldo (C0); payload C9 (DTO compacto en ES3).
- **Decisiones de las sesiones** (resumen en PLANES §10 «Decisiones de ES2b»): la sincronía turno↔sesión corre sin
  gate de módulo (es consistencia de datos); el verificador corre solo en el motor; `addCustomSession` pasa por el
  motor y exige `plans.manage` (la Secretaria ya no agrega sesiones a medida); la OS pagada no suma en "cobrado".
- **Gate de ES2b (orquestador, en solitario sobre el Docker):** `migrate deploy` re-aplicado = no-op y `migrate status` al día (29); `tsc` 0 (app y scripts); unit 1667/1667 en TZ=UTC y TZ=AR; guard OK; `next build` OK; `perf:bundle` sin excesos; integración completa 1025 + 19 skip (`kinesoft_app`) y 1018 + 26 skip (owner); perf + `compare.ts` sin regresiones (agenda 16 statements, techo 16); 0 `it.fails` pendientes. La carrera "cierre ∥ generar" está cubierta en los dos órdenes (`plans-engine-fixes.test.ts` cierre primero; `plans-sync-sessions.test.ts` turno primero).

**Ronda 18 — Planes P3 (ES3): UI de Planes, ingresos reales y retiro de las altas viejas (08-oct-2026) ✅ (commit `ad50059`):**
ejecutada en develop sobre `58ec36f` según [PLANES.md §11](PLANES.md), con las enmiendas EV0/SV y las del 08-oct.
**1 migración nueva**, M3a `20261008120000_billing_paid_at` (`Booking.copagoPaidAt` + `UserPreferences.dashboardPrefs`
con CHECK de objeto), aplicada y verificada **solo en el Docker local**; va desde vacío en el deploy único de B
([MIGRACIONES-RUNBOOK «Go-live con reset»](MIGRACIONES-RUNBOOK.md)). Olas P3.0.0 (M3a sola) → P3.0 (P3-C) → P3.1 (10) →
P3.2 (10) → P3.Z.0 (retiro: S27a, S27b) → P3.Z (2 revisores de solo lectura, 4 fixers: F1 server, F2 editor/Planes, F3a
agenda, F3b perfil; integrador). Decisiones que cambiaron el contrato en PLANES §11 «Decisiones de ES3».

- 🟢 **Cerrados del planning** (filas en §2): `plantillas-sin-crud` (S17t + S21t), `plan-status-sin-confirm` (S22a),
  `hero-plan-activo-falso` (S22h), `statustag-fmtmoney-duplicados`, `dashboard-session-index-crudo` (la página de
  Seguimiento, S20), `wizard-mobile-sin-dias` (S23: el wizard abre el editor), `gates-reimplementados-legacy`
  (S27a/S27b), `payload-c9-agenda` (P3-C), `ingresos-dashboard-solo-mp` (M3a + S14r; era P11 de C0).
- 🟢 **Retiro (P3.Z.0):** `createProgram`, `updateProgram`, `getPatientProgramsLite/Full`, `lib/plan-form-defaults.ts`
  (S27a); `assignDiagnosisAndCreateProgram`, `applyPlanTemplate` viejo, `addCustomSession`, `AssignInput`,
  `AddCustomSessionInput` (S27b). Cada caso de ES1 se re-afirmó sobre la puerta nueva antes de borrar. Gate grep = 0
  (excepción: `tests/perf/baseline.json`, versionado, clave `createProgram.16`). `rescheduleSession` →
  `assertPlanScheduleInTx` + full (`lib/sessions.ts:649`). Sobreviven en `lib/programs.ts` `setProgramStatus`,
  `deleteProgram` y `deleteSession`, sin callers de app (decisión 2 de abajo).
- 🟢 **Bugs de la revisión, cerrados en P3.Z** (filas en §2 «Hallazgos de ES3»): **ALTA** barrera del módulo
  `plantillas` perdida en el retiro; dosis de plantilla; ejercicio de plantilla archivado después; "a medida" sin fecha
  stale para siempre; re-marcar copago/OS ya cobrado mudaba la fecha de cobro; plantilla de un colega validada con el
  actor; ordinal en la tabla de preview; editor trabado en "Buscando turnos…"; loops de stale en D7 y Vincular;
  Resumen en General con Planes/Diagnóstico; EVA sin el módulo `evaluaciones`; `programId` en
  `SchedulablePlanSession`; `authorization` en el prefill de URL; aviso L11 genérico; "Cancelalo" en cualquier estado;
  Links de la fila Plan sin dirty-guard; conteo de Semana ≠ leyenda; a11y; mobile; `?agendar=1` sin limpiar; copy
  "Completado"/"Finalizado"; tests que no podían fallar (títulos secretos).
- **Nuevos abiertos** (clasificados en el momento, filas en §2 «Hallazgos de ES3»): `ingresos-visibles-a-todo-rol` y
  `facturacion-cancelados-con-cobro` (cerrados en SR, Ronda 19); C1 `bulk-exercises-rango-por-index`, `recordatorio-whatsapp-sin-ordinal`,
  `slot-cell-helpers-bundle`, `plan-template-prefill-doble`, `label-codigo-de-la-orden`,
  `tabs-perfil-patron-incompleto`, `diagnosis-name-en-plandto`, `renovar-autorizacion-sin-os`,
  `bundle-es3-sobre-criterio`; ES4 `archivar-paciente-lista-sin-L9`; EV1 `programs-sobrevivientes`; nota
  `bookings-conflict-literal`.
- **Decisiones de Martin (08-oct, al cerrar ES3; PLANES §11):** (1) bundle aceptado, sigue en C1; (2) los
  sobrevivientes de `programs.ts` se quedan; (3) R-LEGACY sin "a medida" se deja; (4) cancelados con cobro siempre
  visibles y (5) ingresos por rol → **ejecutadas en SR** (Ronda 19); (6) `diagnosisName` en `PlanDTO` → C1;
  (7) "Renovar autorización" sin saber si el plan tiene OS → C1 si molesta. Aceptada por el orquestador: la concurrencia de "a medida" es "stale-preview limpio + entra al
  reintentar".
- **Gate de ES3 (en solitario, Docker local):** `migrate deploy` re-aplicado sin pendientes, `migrate status` al día
  (30 migraciones); `tsc` 0 (app y `tsconfig.scripts.json`); `next build` OK; unit 102 archivos / 2114 tests en TZ=UTC y
  TZ=AR; guard OK; integración completa `kinesoft_app` 84 archivos / 1074 ✓ (19 skip) y owner 83 ✓ + 1 skip / 1067 ✓
  (26 skip), 0 fallas; 0 `it.fails` de ES3 sin dar vuelta; perf + `compare.ts` sin regresiones fuera de umbral (28
  escenarios, 1 nuevo); bundle en [PERF.md §ES3](PERF.md).

**Ronda 19 — SR: Salas/Consultorios, Facturación con cancelados cobrados e ingresos por rol (08-oct-2026) ✅ (pendiente commit):**
ejecutada en develop sobre `ad50059` según el plan vigente §17 + §17.5 (respuestas de Martin). **1 migración nueva**, M4
`20261009120000_rooms` (sola en SR0), aplicada y verificada **solo en el Docker local** (31 migraciones); va en la
cadena del deploy único después de M3a y antes de M5 ([MIGRACIONES-RUNBOOK «Go-live con reset»](MIGRACIONES-RUNBOOK.md)).
Olas SR0 (SR-M) → SR1.0 (SR-C, contratos) → SR1 (SR1a motor, SR1b CRUD, SR1c horarios, SR1d ocupación, SR-D4F, SR-D5I)
→ SR2 (SR2a core, SR2b Planes + turnero, SR-B bloqueos, SR-U1..U4) → SR3 (SR3a `lib/bookings.ts`, SR-U5a/b/c, SR-BU) →
SR4 (SR-U6 agenda) → SRZ (2 revisores de solo lectura, fixers FX1/FX2a/FX2b/FX3, gate en solitario). Arquitectura en
[ARCHITECTURE.md §Salas (SR)](ARCHITECTURE.md); locks C2 (1b) en ADR-004.

- 🟢 **Qué entró:**
  - **Server:** CRUD de salas (`lib/rooms.ts`); horarios con sala y vigencia y choque duro entre profesionales
    (`lib/practitioner-schedule.ts`, `lib/room-schedule-validate.ts`, lock `room-schedule` condicional); motor puro
    (`lib/availability/rooms.ts`) y loader con `roomBlocks` aparte; ocupación server-only en una sentencia
    (`lib/booking-rooms-internal.ts`); core con sala (`applyBookingUpdateInTx` recalcula, valida y cuenta;
    `room-busy`/`bad-room`); alta, batch, agenda y clasificación con sala; Planes y turnero estampan sin chequear (SR-D3);
    bloqueos de sala (`lib/time-blocks*.ts`).
  - **UI:** Configuración › Sedes › Salas; editor de horarios con sala y vigencia; agenda con filtro de sala, vista
    "Por sala", sala en tarjetas, lista, semana y Recepción; drawer (fila Sala, "Asignar igual"); modal (select Sala,
    "Agendar igual", batch con casilla aparte); candado "Una sala"; PlanCard "Moverlo igual (sala ocupada)". Sin salas,
    todo igual que en `ad50059` (agenda 15/15 byte a byte, editor verificado contra HEAD).
  - **Decisiones 4 y 5 de Martin del cierre de ES3:** SR-D4F y SR-D5I (filas abajo).
- 🟢 **Cerrados** (filas en §2): `salas-inexistentes`, `ingresos-visibles-a-todo-rol` (SR-D5I),
  `facturacion-cancelados-con-cobro` (SR-D4F).
- 🟢 **Bugs de la revisión, cerrados en SRZ** (filas en §2 «Hallazgos de SR»). Revisor (a) server: 0 altos; MEDIA
  reprogramar una sesión de plan a una sala ocupada no tenía salida (FX2b: "Moverlo igual (sala ocupada)",
  `components/planes/plan-card.tsx:260-270`); lookback de sala 240 → 480; franjas vencidas con sala archivada
  impedían guardar; test flaky del índice único y test de fuga de cache que no fijaba la clave. Revisor (b) UI: 0 altos;
  MEDIA "Asignada: ?", ocupación de "Por sala" filtrada por los chips, vigencia visible sin salas, "Sin sala" mezclando
  sedes; bajas de total del filtro, foco, copy del vacío por rol, toggle sin opción marcada, sala archivada, select de
  sala sin salas en la sede, `aria-describedby` del candado, picker de KPI de la Secretaria.
- 🟢 **Fixes del gate** (orquestador):
  - **Fuga de conexiones en tests:** `tests/helpers/query-counter.ts` creaba 2 clientes Prisma por archivo sin
    cerrarlos; con los tests de SR la integración completa agotaba las 100 conexiones. Ahora reusa un singleton por
    proceso (`:31-50`); pico medido 60.
  - **Pool del dashboard (riesgo real en prod):** `getDashboardData` abría 6 tx interactivas de ingresos en paralelo
    con las de los counts → "Unable to start a transaction in the given time" intermitente. `loadRevenue` es ahora
    **una** tx con las lecturas en serie (`revenueAmountsInTx`, `lib/dashboard.ts:585,642`): 19 → 15 tx, mismas
    sentencias.
  - **`todaySlot` de Recepción** (tests de ES2b `plans-sync-bookings`, `plans-sync-sessions`): "una hora antes de
    ahora" caía AYER entre 00:00 y 01:30 AR; ahora con piso en el inicio del día AR.
  - **`liveBlocksInTx`** (`lib/bookings-core.ts:534-550`) suma `roomId: null`: un bloqueo de sala bloqueaba el alta de
    **todos** los profesionales. Test que falla sin el fix (`day-lock.test`, «[SR-B] un bloqueo de sala no bloquea el
    alta…»).
- **Nuevos abiertos** (clasificados en el momento, filas en §2 «Hallazgos de SR»): C1 `copy-sala-ocupada-genero`,
  `delete-exception-sin-reaviso`, `golden-sin-salas`, `room-filter-densidad`, `por-sala-filtro-sin-sala`,
  `aviso-sala-sin-profesional`, `bundle-sr-sobre-criterio` (WeekDrawer lazy); C1 perf `dashboard-counts-tx-paralelas`;
  C0 `ingresos-filtro-owner-por-profesional`.
- **Decisiones de las sesiones** (firmadas por Martin el 08-oct o con default; ARCHITECTURE §Salas): SR-D1..D9 +
  §17.5; elegir sala no cambia la sede (otra sede → `bad-room`); sala por defecto archivada → sin sala; "Por sala" sin
  filtro de profesionales; "Sin sala" por sede del alcance; la Secretaria que guarda el picker de KPI pierde
  `monthRevenue` fijada (nunca la ve); ingresos atribuidos al profesional **actual** del turno; la vigencia de la franja
  solo se ve con salas o si ya está cargada.
- **Decisión para Martin** (con recomendación): **bundle** — el criterio "≤ +1 kB" no se cumplió en `/agenda`
  (~202 → 204,5 kB) ni en `/configuracion` (~212,5 → 216,2 kB) (PERF §SR). Recomendado: **aceptar** (el bundle
  bloqueante está en C1) y, como mejora concreta, cargar el `WeekDrawer` del editor de horarios con `dynamic` (C1).
- **Gate de SR (en solitario, Docker local):** `migrate status` al día (31); `tsc` 0 (app y `tsconfig.scripts.json`);
  `next build` OK; guard OK; unit 114 archivos / 2417 tests en TZ=UTC y TZ=AR; integración completa `kinesoft_app` 95
  archivos / 1228 ✓ (19 skip) y owner 94 + 1 skip / 1214 ✓ (33 skip), 0 fallas; perf + `compare.ts` sin regresiones
  fuera de umbral (28 escenarios; `f.createBooking` 35 = base); bundle en [PERF.md §SR](PERF.md).

## Cómo leer la severidad

| Severidad | Criterio |
|---|---|
| **crítica** | Fuga/pérdida de datos, pérdida de dinero, o corrupción silenciosa alcanzable en prod |
| **alta** | Bug de lógica que el usuario ve, o deuda que bloquea escalar / vender |
| **media** | Riesgo latente (hoy mitigado por otra capa) o inconsistencia acotada |
| **baja** | Pulido, consistencia cosmética, deuda sin impacto inmediato |

Bucket (quién resuelve): **A** código directo · **B** hardening con decisión de alcance ·
**C** config externa del dueño · **D** legal/negocio · **E** marca.

---

## 0. Causa raíz arquitectónica (el hallazgo que orienta todo el plan)

> **Actualización 2026-09-29:** esta sección describe el estado del 2026-07-22. Desde la Ronda 4 RLS está
> **completa en código** (`runWithRls` en ~22 módulos, canal dual `prisma`/`prismaService`, policies en
> `20260725120000_rls_policies`) y **aplicada en local** con el rol `kinesoft_app`. **En PROD sigue sin
> aplicarse** hasta que el dueño haga el flip del rol: allí el `where tenantId` a mano sigue siendo la única
> barrera, y los chequeos de FK saltean RLS (los ids de entrada se validan contra el tenant). Se conserva el
> texto original como historia.

**La segunda capa de aislamiento multi-tenant (RLS) es estructuralmente inerte.** No es un bug
suelto: es una condición de fondo que explica varios findings a la vez.

- Las policies existen y están `ENABLE + FORCE` en 17 tablas (`prisma/migrations/policies.sql`),
  pero la aplicación se conecta con un rol que tiene **BYPASSRLS** (dev: superuser `kinesoft` del
  Docker; prod: rol `postgres.<ref>` de Supabase). Un rol con BYPASSRLS/SUPERUSER **ignora RLS
  incluso con FORCE** → ninguna policy se evaluó jamás en runtime.
- `runWithRls` (que setea el GUC `app.current_tenant_id`) solo está cableado en `lib/patients.ts`
  y `lib/bookings.ts`. Las demás mutaciones usan `prisma` plano.
- 9 tablas con `tenantId` no figuran ni en las policies ni en el auto-filtro de `lib/db.ts`.

**Consecuencia:** hoy el aislamiento depende **100% del filtro `where: { tenantId }` a mano** en
cada query (que sí está presente y es correcto — ver preserve). La "defensa en dos capas" que
describen ARCHITECTURE.md y SECURITY.md es, a día de hoy, **una sola capa**. Activar RLS de verdad
es un workstream **acoplado y todo-o-nada** (rol sin BYPASSRLS + GUC en todos los módulos +
policies faltantes), no tres fixes sueltos → ver Ola 2.2 del ROADMAP. Findings:
[F-B3](#f-b3), [F-B4](#f-b4), [F-B2](#f-b2), y los menores `batch-fuera-de-runwithrls`,
`gettenantprisma-dead-code`, `rls-coverage-gaps`.

> **Enmarcado para no-técnicos:** las primeras olas de hardening (higiene de entorno, recableo del
> flujo crítico, RLS real, tests) son "fundación invisible" — trabajo sin impacto visual que
> habilita todo lo demás. No es estancamiento; es secuencia deliberada.

---

## 1. Findings confirmados (crítico / alto) — detalle

Formato por finding: ubicación · clase del catálogo · bucket · severidad (→ ajuste de la
verificación adversarial si hubo) · descripción · acción. El **slug** es el ancla que referencia
el ROADMAP.

### <a id="f-b1"></a>F-B1 — `booking-hard-delete-payment-cascade` · Borrar un turno destruye su registro de pago
- **Ubicación:** `lib/bookings.ts:594` (`deleteBooking`) + `prisma/schema.prisma:853` (`Payment.onDelete: Cascade`)
- **Clase:** C-INT (soft-delete con evidencia) · **Bucket:** B · **Severidad:** alta → **crítica** (escalada en verificación)
- **Descripción:** `deleteBooking` hace `tx.booking.delete` físico, sin flag de soft-delete
  (`Booking` no tiene `archivedAt`). El FK `Payment.booking` es `onDelete: Cascade`, así que borrar
  un turno **pagado** destruye en silencio el `Payment` asociado (`amountCents`, `externalId` de MP,
  `rawPayload` de conciliación) además del `copagoCents`/`insurerPaidAt` del propio turno. No queda
  rastro para auditar ni reconciliar el cobro. Cableado desde la agenda, el booking-drawer y el
  perfil de paciente.
- **Acción:** (1) `Payment.onDelete → Restrict` + migración del FK; (2) `deleteBooking` carga el
  `Payment`/`paymentStatus` antes de borrar y **rechaza** (o soft-delete) si existe pago o
  `paymentStatus ∈ {AUTHORIZED, PAID, REFUNDED}`. → sesión `delete-guard-booking`.

### <a id="f-a1"></a>F-A1 — `c3-payment-amount` · El webhook valida el monto contra el precio vivo, no contra un monto anclado
- **Ubicación:** `lib/mercadopago.ts:183`; checkouts en `app/api/booking/checkout/route.ts:~72` y `lib/public-booking.ts:~330`
- **Clase:** C-INT · **Bucket:** A · **Severidad:** crítica → **alta**
- **Descripción:** `consumeWebhook` compara `capturedCents` contra `booking.service.priceCents`
  **vivo**. El `Payment` se crea recién dentro del webhook, no en el checkout, así que un cambio de
  precio o de `copagoCents` entre el inicio del checkout y el settlement no queda anclado: un pago
  legítimo al precio viejo puede rechazarse, o uno menor pasar. (Este es el ítem **C3** que
  AUDIT.md de junio dejó abierto.)
- **Acción:** migración `Payment.expectedAmountCents Int`; crear la fila `Payment` en **ambos**
  checkouts al generar la preferencia con `expectedAmountCents`; comparar el webhook contra ese
  monto y persistir `Payment FAILED` en caso de mismatch (no perder traza). → sesión
  `payment-amount-anclado`.

### <a id="f-a2"></a>F-A2 — `public-booking-slots-host-tz` · La reserva pública genera y guarda turnos en la timezone del host
- **Ubicación:** `lib/public-booking.ts:113` (`new Date(input.date+"T00:00:00")`), `:117` (`getDay`), `:135` (`setHours`)
- **Clase:** C-UX-03 (fecha de negocio en UTC crudo) · **Bucket:** A · **Severidad:** crítica → **alta**
- **Descripción:** en prod (Vercel/Supabase = UTC) el paciente elige un slot rotulado p.ej. "08:00"
  pero el turno queda guardado a las 08:00 UTC = **05:00 AR**; la agenda del kine (que sí renderiza
  en AR) lo muestra a las 05:00. Además solo aparecen slots de mañana y el chequeo de choques usa
  una ventana corrida 3h. Es el flujo que **cobra por Mercado Pago**, así que el bug toca dinero.
  Se oculta en dev AR-local y solo explota en prod UTC.
- **Acción:** construir cada slot como instante AR con `localToARIso`; derivar `dayStart`/`dayEnd`
  y el dow con los helpers de `lib/datetime-ar.ts`; label con `timeZone` AR. → sesión
  `fix-public-booking-tz`.

### <a id="f-a3"></a>F-A3 — `timeline-oncreate-wrong-day-hour` · Click en el timeline precarga el turno en HOY y con la hora desfasada
- **Ubicación:** `components/agenda/agenda-client.tsx:737-743` (TimelineView)
- **Clase:** C-UX-03 · **Bucket:** A · **Severidad:** **alta** — *causa raíz dominante del síntoma QA "los turnos se crean en cualquier día"*
- **Descripción:** `const baseIso = new Date(new Date(bookings[0]?.scheduledFor ?? new Date()).setHours(h,0,0,0)).toISOString()`.
  Dos fallas: (1) **DÍA** — si el día visible no tiene ningún turno, `bookings[0]` es `undefined` y
  cae en `new Date()` = **HOY real**, no el día que el kine está mirando; (2) **HORA** — `setHours`
  usa wall-clock del host, así que en prod UTC el turno queda **-3h**. Es el único punto del
  pipeline de fechas de la agenda que sobrevivió sin migrar a AR (el resto —parseDate, startOfWeek,
  navigate, batch— ya está correcto).
- **Acción:** threadear `todayKey` (ya disponible en el padre) a TimelineView y construir `baseIso`
  con `localToARIso(\`${todayKey}T${hh}:00\`)`; eliminar el patrón `bookings[0] ?? new Date()` +
  `setHours` + `toISOString`. → sesión `fix-timeline-oncreate` (cubre también el menor
  `agenda-client-emptyslot-sethours`).

### <a id="f-a4"></a>F-A4 — `suggest-next-free-slot-host-tz` · La sugerencia de "próximo turno libre" evalúa horario en el host
- **Ubicación:** `lib/bookings.ts:246-251` (`suggestNextFreeSlot`)
- **Clase:** C-UX-03 · **Bucket:** A · **Severidad:** **alta**
- **Descripción:** el walker usa `cursor.getDay()`/`getHours()` (host-tz) contra
  `businessHoursStart/End` que son horas **AR**. En host UTC evalúa con 3h de corrimiento y puede
  saltear el sábado o incluir domingos. Inconsistencia dentro del mismo archivo, que ya importa y
  usa `toARDow` correctamente en `createRecurringBookings`.
- **Acción:** `toARDow`/`toARHour` para el gate de dow y horario; dejar el redondeo a 15 min tal
  cual (AR no tiene DST). → sesión `fix-bookings-tz` (con el menor `getdaycounts-utc-slice`).

### <a id="f-a5"></a>F-A5 — `seguimiento-today-bucket-and-display` · El bucket "Hoy" de Seguimiento y su display están en host-tz
- **Ubicación:** `app/(app)/seguimiento/page.tsx:13-17` y `:147`
- **Clase:** C-UX-03 · **Bucket:** A · **Severidad:** **alta**
- **Descripción:** Server Component (host UTC): `todayStart/End` se calculan con `new Date()` +
  `setHours` en host-tz, así que la ventana "Hoy" es `[21:00 AR ayer, 21:00 AR hoy)`; una sesión de
  las 22:00 AR de hoy salta a "Próximas" y una de anoche cuenta como hoy. El display usa
  `toLocaleString` sin `timeZone`.
- **Acción:** anclar límites al día AR con `toARDateKey`/`localToARIso`; `timeZone` AR en el
  display. → sesión `tz-vistas`.

### <a id="f-a6"></a>F-A6 — `search-booking-toLocale-no-tz` · La búsqueda global formatea el horario del turno sin timezone AR
- **Ubicación:** `lib/search.ts:140` y `:148`
- **Clase:** C-UX-03 · **Bucket:** A · **Severidad:** **alta**
- **Descripción:** `search.ts` es `"use server"` (host UTC). El sublabel usa `toLocaleString('es-AR')`
  sin `timeZone`, y el href de "ver en agenda" usa `toISOString().slice(0,10)` (fecha UTC) → para
  turnos de la noche apunta al día equivocado.
- **Acción:** `timeZone` AR en el formateo; `toARDateKey` para el date-link. → sesión `tz-vistas`.

### <a id="f-a7"></a>F-A7 — `portal-session-date-no-tz` · El portal del paciente muestra la fecha de sesión sin timezone AR
- **Ubicación:** `app/(portal)/portal/c/[slug]/page.tsx:193`
- **Clase:** C-UX-03 · **Bucket:** A · **Severidad:** alta → **media**
- **Descripción:** Server Component (host UTC): `toLocaleDateString('es-AR', {...})` sin `timeZone`
  para sesiones de tarde/noche; inconsistente con el bloque hermano `nextSession` del mismo archivo
  (línea 129) que sí usa AR.
- **Acción:** espejar el bloque hermano con `timeZone` AR (o formatter AR reutilizable). → sesión `tz-vistas`.

### <a id="f-a8"></a>F-A8 — `login-sin-feedback-error` · El login nunca muestra el error de credenciales
- **Ubicación:** `app/(auth)/login/page.tsx` + `components/screens/login-screen.tsx:189`
- **Clase:** C-UX (error accionable) · **Bucket:** A · **Severidad:** **alta**
- **Descripción:** el form postea a `/api/auth/sign-in` que redirige a `/login?error=...`, pero
  `LoginPage` renderiza `<LoginScreen/>` sin props y `LoginScreen` no lee `searchParams`. El query
  se pierde y el usuario reintenta a ciegas. Es la única pantalla de auth así (signup y forgot sí
  manejan error). El texto de error ya está en español.
- **Acción:** threadear `searchParams.error` a `LoginScreen` y renderizar un banner condicional.
  → sesión `login-error-feedback`.

### <a id="f-a9"></a>F-A9 — `practitioner-userid-unique-blocks-multitenant` · Un kine no puede pertenecer a dos consultorios
- **Ubicación:** `prisma/schema.prisma:123` (`Practitioner.userId String @unique`) + `lib/session.ts:75-81`
- **Clase:** C-SEC-07 (unicidad global vs tenant-scoped) · **Bucket:** A · **Severidad:** **alta**
- **Descripción:** `Membership` es N:N y `session.ts` documenta "switch between tenants", pero
  `Practitioner.userId` es `@unique` **global**: un kine invitado a un 2º consultorio queda
  bloqueado — accept-action no le crea `Practitioner` en el 2º tenant, y `buildActor` exige un
  `Practitioner` en el tenant elegido → `throw Unauthenticated`. Es la **única línea** que bloquea
  el modelo multi-profesional; el resto del schema ya lo soporta. Regla de dominio del dueño: *un
  kine puede ocupar silla en N consultorios* → esto hay que arreglarlo.
- **Acción:** `@@unique([tenantId, userId])` (quitar el `@unique` global); `UserProfile.practitioner`
  → array; accept-action crea **siempre** el `Practitioner` del tenant; fix de `scripts/create-tenant.ts`.
  → sesión `practitioner-multi-tenant` (Etapa 2, requiere migración).

### <a id="f-b2"></a>F-B2 — `tenant-tables-sin-rls-ni-filtro` · 9 tablas tenant-scoped sin RLS ni auto-filtro
- **Ubicación:** `prisma/migrations/policies.sql` + `lib/db.ts:29` (`TENANT_SCOPED_MODELS`)
- **Clase:** C-DB-07 · **Bucket:** B · **Severidad:** crítica → **media** (mitigado por el `where` a mano)
- **Descripción:** `Insurer` (dinero), `PatientFile` (PHI), `PatientShare` (control de acceso),
  `Invitation`, `Notification`, `Favorite`, `PlanTemplate`, `UserPreferences` y `DismissedReminder`
  tienen `tenantId` pero no están ni en `policies.sql` (sin RLS) ni en `TENANT_SCOPED_MODELS`. El
  aislamiento depende 100% del `where: { tenantId }` manual. Se agregaron en sprints 13-18 y nadie
  las sumó a ninguna de las dos capas (no había guard que lo detectara — ver F-B11).
- **Acción:** prioridad por drift real: PatientFile (PHI), PatientShare (acceso), Insurer (pricing)
  primero. → sesión `policies-tablas-faltantes` (Ola 2.2, después del rol sin BYPASSRLS).

### <a id="f-b3"></a>F-B3 — `rls-bypassed-by-superuser-role` · El rol de conexión bypassea RLS
- **Ubicación:** prod `.env` `DATABASE_URL` (rol `postgres.<ref>`, BYPASSRLS); dev `docker-compose.yml:18` (`POSTGRES_USER: kinesoft`, superuser)
- **Clase:** C-DB-08 · **Bucket:** B · **Severidad:** alta → **media** (porque hoy el `where` a mano protege)
- **Descripción:** ver §0. `FORCE RLS` no anula BYPASSRLS ni SUPERUSER; `runWithRls` setea un GUC
  que ninguna policy llega a consultar porque el motor no aplica RLS a ese rol.
- **Acción:** provisionar un rol de login dedicado **sin** SUPERUSER/BYPASSRLS en dev y prod
  (parte del dueño en Supabase); GRANT DML; verificar con `pg_roles`. → sesión `rol-db-sin-bypassrls`
  (Ola 2.2). **Ojo:** activar esto sin cablear el GUC en todos los módulos (F-B4) rompe la app.

### <a id="f-b4"></a>F-B4 — `runwithrls-solo-en-2-modulos` · El GUC de tenant solo se setea en 2 módulos
- **Ubicación:** `lib/rls.ts:19` + `lib/db.ts:76` (`getTenantPrisma`)
- **Clase:** C-DB · **Bucket:** B · **Severidad:** alta → **media**
- **Descripción:** `runWithRls` solo se usa en `patients.ts`/`bookings.ts`. Si se corrige el rol
  (F-B3) sin migrar el resto, esas queries verían `app.current_tenant_id = NULL` → toda policy
  evalúa `FALSE` → cero filas / escrituras bloqueadas. `getTenantPrisma` (backstop app-layer) es
  además **código muerto** (menor `gettenantprisma-dead-code`). La aislación en dos capas es
  estructuralmente inalcanzable en el estado actual.
- **Acción:** plegar el `SET LOCAL app.current_tenant_id` en un único cliente tenant-scoped por
  request y enrutar **todos** los módulos de dominio. → sesión `cliente-tenant-unico-guc` (Ola 2.2).

### <a id="f-b5"></a>F-B5 — `booking-overlap-race-no-cas-no-unique` · Doble-submit de turno sin defensa
- **Ubicación:** `lib/bookings.ts:301-314` (clash-check) y `:352-370` (create)
- **Clase:** C-INT-08 · **Bucket:** B · **Severidad:** alta → **media**
- **Descripción:** el clash-check y el create no comparten transacción (el propio comentario dice
  "safe outside the tx"), no hay unique compuesto ni exclusion sobre `(practitionerId, scheduledFor)`,
  y el `idempotencyKey` se genera con `randomBytes(16)` en cada llamada → el `@unique` de la columna
  nunca colisiona. Dos requests concurrentes (doble-click / reintento de red) crean dos turnos
  solapados. **No** conviene un unique/exclusion duro: rompería el sobreturno intencional.
- **Acción:** `idempotencyKey` **determinística** `${tenantId}:${practitionerId}:${slotISO}:${patientId}`
  + `upsert` (replicando `lib/public-booking.ts:314-328`); `orderBy` en el `findFirst` del
  clash-check. → sesión `booking-concurrencia` (cubre menores `conflict-findfirst-sin-orderby`,
  `booking-paid-toggles-no-optimistic-lock`, y la parte de idempotencia de `batch-create-overlap-race-and-no-rls`).

### <a id="f-b6"></a>F-B6 — `patient-hard-delete-cascades-hc` · Borrar un paciente destruye su historia clínica
- **Ubicación:** `lib/patients.ts:863-875` (`deletePatient`)
- **Clase:** C-INT (soft-delete) · **Bucket:** B · **Severidad:** alta → **media**
- **Descripción:** `deletePatient` hace `tx.patient.delete` físico y cascada `EvaScore`/`PatientFile`/
  `Coverage`/`EmergencyContact`/`PatientShare`, dejando turnos huérfanos (`SetNull`) y rompiendo la
  facturación histórica — **conviviendo** con `setPatientArchived` (`archivedAt`) que ya provee
  borrado lógico. Son dos caminos deliberados co-presentados en el mismo modal ("Archivar" vs
  "Eliminar definitivamente"). **No** eliminar la función: falta un **gate de rol**.
  Legal AR (Ley 26.529, retención de HC) hace esto sensible (bucket D).
- **Acción:** gate de rol OWNER/ADMIN en `deletePatient` (y en `deleteProgram`/`deleteSession`,
  menor `program-session-hard-delete`), reusando el patrón de `assignPatientToPractitioner`. → sesión
  `patients-integridad` (gate mínimo E1) → residual soft-delete wholesale en `soft-delete-wholesale` (E2).

### <a id="f-b7"></a>F-B7 — `sin-error-loading-boundaries` · No existe ningún error/loading boundary en toda la app
- **Ubicación:** `app/` (0 archivos `error.tsx`/`loading.tsx`/`global-error.tsx`/`not-found.tsx`; 0 `Suspense`/`ErrorBoundary`)
- **Clase:** C-UX-05 · **Bucket:** B → A (creación) · **Severidad:** alta → **media**
- **Descripción:** un fallo de datos en un Server Component (permiso, timeout, Prisma) explota en la
  pantalla default de Next ("Application error", en inglés, sin retry). El tercer estado
  (error-con-retry) no está cubierto a nivel de ruta. Skeleton solo en `patient-profile.tsx`.
- **Acción:** boundaries por route-group + `not-found.tsx`/403 en español con retry. → sesión
  `error-loading-boundaries`.

### <a id="f-b8"></a>F-B8 — `h2-oversized-components` · Componentes gigantes
- **Ubicación:** `patient-profile.tsx` (2341), `agenda-client.tsx` (2157), `diagnostico-screen.tsx` (1627), `configuracion-client.tsx` (1581), `public-booking-wizard.tsx` (1064), `biblioteca-client.tsx` (1042)
- **Clase:** deuda estructural · **Bucket:** B · **Severidad:** **alta** (bloquea testeo/mantenimiento y el trabajo paralelo)
- **Descripción:** difíciles de testear y de tocar en paralelo. Son el **cuello de botella de
  ownership** de todo el plan: muchos findings tocan `agenda-client.tsx` y `patient-profile.tsx`.
- **Acción:** trocear por tab/modal ANTES de que multi-profesional/realtime/soft-delete los toquen
  en paralelo. → Ola 2.0 (`split-agenda-client`, `split-patient-profile`, `split-diagnostico-screen`,
  `split-configuracion-y-wizard`). Cubre menores `deuda-archivos-grandes`, `provider-value-inline-bulk-select`.

### <a id="f-b9"></a>F-B9 — `no-test-suite` / `no-ci-triple-gate` / `c2-no-tests-ci` · Cero tests, cero CI
- **Ubicación:** `package.json` (sin runner ni script `test`); sin `.github/workflows/`
- **Clase:** C-TEST · **Bucket:** B · **Severidad:** crítica → **alta**
- **Descripción:** la única verificación es `tsc` + `next build` a mano. Regresiones en
  booking/copago/auth/RLS —justo las costuras de dinero y PHI— llegan a prod sin red. La pirámide de
  4 capas del manual está vacía.
- **Acción:** paso 1 barato y de alto valor (Etapa 1): CI `typecheck` + `build` como required check
  + vitest capa-1 sobre helpers YA correctos (`datetime-ar`, `format`, `resolveBookingCopagoCents`)
  para congelar la fundación **antes** de los fixes de tz. Suite completa en Ola 2.1. → sesiones
  `ci-gate-minimo` (E1) y `suite-integracion`/`ci-pipeline-completo-y-guard` (E2).

### <a id="f-b11"></a>F-B11 — `no-static-security-guard` · Falta el guard estático de seguridad en CI
- **Ubicación:** `lib/db.ts:29`, `policies.sql`, `schema.prisma` (3 listas de tablas mantenidas a mano que ya divergieron)
- **Clase:** C-SEC-08 / C-DB-07 · **Bucket:** B · **Severidad:** **alta** (pieza de mayor apalancamiento del estándar de testing)
- **Descripción:** schema (20 modelos con `tenantId`), `TENANT_SCOPED_MODELS` (9) y `policies.sql`
  (17) deben sincronizarse a mano y ya divergieron (F-B2). Nada mecánico falla el build cuando una
  tabla nueva con `tenantId` queda fuera de RLS/auto-filtro, ni cuando el admin client aparece fuera
  de allowlist.
- **Acción:** `scripts/guard-tenant-isolation.mjs` (Node, sin deps) que parsea las 3 fuentes y falla
  ante drift. → sesión `ci-pipeline-completo-y-guard` (Ola 2.1). Detalle en [TESTING.md](TESTING.md).

### <a id="f-b12"></a>F-B12 — `no-saas-billing-charge-clinic` · No existe billing SaaS para cobrarle al consultorio
- **Ubicación:** `lib/mercadopago.ts` (solo checkout de turnos del paciente)
- **Clase:** gap de producto · **Bucket:** B · **Severidad:** **alta** (sin esto no hay SaaS vendible)
- **Descripción:** MP se usa exclusivamente para el copago del paciente. No hay modelo `Subscription`,
  ni preapproval/pago recurrente del tenant, ni facturas de suscripción, ni webhook que active/
  desactive el plan del consultorio. Regla de dominio del dueño: *cada consultorio paga su plan; los
  profesionales no son quienes pagan.*
- **Acción:** modelo `Subscription(tenantId, plan, mpPreapprovalId, status, currentPeriodEnd, seats)`
  + integración MP Preapproval separada del checkout de turnos. → Ola 2.4 (`subscription-entitlements`,
  `mp-preapproval-webhook`, `paywall-trial-ui`, `seats-limits`).

### <a id="f-b13"></a>F-B13 — `plan-fields-inert-no-upgrade-no-enforcement` · Los campos de plan del tenant están inertes
- **Ubicación:** `prisma/schema.prisma:28-30` (`plan`/`subscriptionStatus`/`trialEndsAt`)
- **Clase:** gap de producto · **Bucket:** B · **Severidad:** alta → **media**
- **Descripción:** cero escrituras a esos campos: sin upgrade, sin paywall, sin lectura de
  `PAST_DUE`/`CANCELLED`/`trialEndsAt` para bloquear acceso. Todo tenant queda en `FREE` para
  siempre; `SubscriptionStatus` es decorativo. El único consumidor del plan es el catálogo de
  ejercicios (`lib/plan-gating.ts`).
- **Acción:** al implementar billing, cablear upgrade/downgrade + `tenantEntitlements()` +
  gate en layout que degrade/bloquee. → Ola 2.4.

### <a id="f-c1"></a>F-C1 — `c1-ratelimit-inmemory` · El rate-limit cae a in-memory en Vercel
- **Ubicación:** `lib/rate-limit.ts:32-38`; env de Vercel
- **Clase:** C-SEC-09 · **Bucket:** C (config del dueño, sin cambio de código) · **Severidad:** crítica → **alta**
- **Descripción:** sin `UPSTASH_REDIS_REST_URL/_TOKEN`, `rateLimit()` usa `memory()`: cada isolate de
  Vercel tiene su propio `Map` y los cold starts resetean contadores → las superficies públicas
  (booking, slots, webhook, check-in) quedan **sin protección real**. El código ya rutea a Upstash
  correctamente cuando las env están; el fallback a memory ante error de transporte **debe
  preservarse**.
- **Acción:** setear las env de Upstash en Vercel prod. → [EXTERNAL-CONFIG.md](EXTERNAL-CONFIG.md) ítem Upstash.

---

## 2. Checklist maestro (todos los findings) — estado vivo

Estado: 🔴 ABIERTO · 🟡 PARCIAL · 🟢 CERRADO · ⏸ DIFERIDO-CON-GATE.
La columna **Sesión** referencia el [ROADMAP.md](ROADMAP.md). Estado re-verificado contra el código al
**2026-09-29** (Ronda 11), con los cierres de A2/A3 del **30-sep-2026** marcados en línea: sin evidencia
clara de cierre, la fila queda en 🔴. Los hallazgos de la auditoría del 23-sep que tocó el Bloque A y los
nuevos de A2/A3 están en la tabla "Hallazgos de la auditoría 23-sep y de A2/A3", más abajo.

### Confirmados (24 + 2 hallazgos posteriores)

| Slug | Sev | Bkt | Ubicación | Estado | Sesión / cierre |
|---|---|---|---|---|---|
| booking-hard-delete-payment-cascade | crítica | B | lib/bookings.ts:594 | 🟢 | Ronda 2 — `Payment.onDelete: Restrict` + guard de pago en `deleteBooking` |
| c3-payment-amount | alta | A | lib/mercadopago.ts:183 | 🟢 | Ronda 2 — `Payment.expectedAmountCents` anclado en ambos checkouts |
| public-booking-slots-host-tz | alta | A | lib/public-booking.ts:113 | 🟢 | Ronda 1 (fix-public-booking-tz) |
| timeline-oncreate-wrong-day-hour | alta | A | agenda-client.tsx:738 | 🟢 | Ronda 1 (fix-timeline-oncreate) |
| suggest-next-free-slot-host-tz | alta | A | lib/bookings.ts:246 | 🟢 | Ronda 1 (fix-bookings-tz) |
| seguimiento-today-bucket-and-display | alta | A | seguimiento/page.tsx:15 | 🟢 | Ronda 1 (tz-vistas) |
| search-booking-toLocale-no-tz | alta | A | lib/search.ts:140 | 🟢 | Ronda 1 (tz-vistas) |
| portal-session-date-no-tz | media | A | portal/c/[slug]/page.tsx:193 | 🟢 | Ronda 1 (tz-vistas) |
| login-sin-feedback-error | alta | A | login-screen.tsx:189 | 🟢 | Ronda 1 (login-error-feedback) |
| practitioner-userid-unique-blocks-multitenant | alta | A | schema.prisma:123 | 🔴 | practitioner-multi-tenant — `userId String @unique` global sigue en el schema |
| tenant-tables-sin-rls-ni-filtro | media | B | prisma/migrations/20260725120000_rls_policies | 🟢 | Ronda 4 — la migración cubre PatientShare/PatientFile/Insurer/Invitation/PlanTemplate/Notification/DismissedReminder; Favorite/UserPreferences quedan user-scoped a propósito (allowlist del guard). Re-verificado 2026-09-29 con `npm run guard:isolation` ✓ |
| rls-bypassed-by-superuser-role | media | B | .env / docker-compose | 🟢 | Ronda 4 — **cerrado en código** (rol `kinesoft_app` sin BYPASSRLS en local + test de aislamiento). **El flip de PROD sigue pendiente del dueño** (bucket C) |
| runwithrls-solo-en-2-modulos | media | B | lib/rls.ts:19 | 🟢 | Ronda 4 — **cerrado en código**: `runWithRls` cableado en ~22 módulos de `lib/` (verificado). Depende del mismo flip prod |
| booking-overlap-race-no-cas-no-unique | media | B | lib/bookings.ts:301 | 🟢 | Ronda 1 (idempotencia + `orderBy`) → revisado en Ronda 6 (key del cliente + índice único parcial) |
| patient-hard-delete-cascades-hc | media | B | lib/patients.ts:996 | 🟢 | Ronda 2 (gate de rol) → A2a-S08 (30-sep): **`deletePatient` eliminado**, solo Archivar (decisión del dueño) |
| sin-error-loading-boundaries | media | B | app/ | 🟢 | Ronda 1 — `global-error` + `error.tsx` por route-group + `loading.tsx` (verificado) |
| h2-oversized-components | alta | B | components varios | 🟢 | Ronda 3 — los 4 archivos gigantes troceados |
| no-test-suite | alta | B | package.json | 🟢 | Ronda 1 (capa-1) → Ronda 3 (copago/agenda-utils) → Ronda 4 (integration RLS) |
| no-ci-triple-gate | alta | B | package.json | 🟢 | Ronda 1 — `.github/workflows/ci.yml`: typecheck → test → build |
| c2-no-tests-ci | alta | B | package.json | 🟢 | Ronda 1 + Ronda 3 (mismo cierre que `no-test-suite`) |
| no-static-security-guard | alta | B | .github/workflows/ci.yml | 🟢 | Ronda 10 — step `npm run guard:isolation` en CI; desde A0b (Ronda 11) el CI corre en todas las ramas, no solo `main` |
| no-saas-billing-charge-clinic | alta | B | lib/mercadopago.ts | 🔴 | mp-preapproval-webhook (Ola 2.4) |
| plan-fields-inert-no-upgrade-no-enforcement | media | B | schema.prisma:28 | 🔴 | subscription-entitlements (Ola 2.4). **07-oct:** EV0 le da efecto al plan (matriz de módulos) y lo hace editable desde /plataforma; el billing SaaS (webhook MP `source:"billing"`) sigue diferido |
| c1-ratelimit-inmemory | alta | C | lib/rate-limit.ts:38 | 🟡 | Código endurecido en A3a (30-sep: timeout, fallback con log, prefijo por entorno, purga). **Falta la env de Upstash** (EXTERNAL-CONFIG §4, dueño) |
| booking-same-patient-slot-toctou | baja | B | lib/bookings.ts (create/update/batch) | 🟢 | Ronda 6 — guard de app + **backstop DB**: índice único parcial `("tenantId","patientId","scheduledFor") WHERE patientId IS NOT NULL AND status <> 'CANCELLED'`, `P2002` manejado en los 4 paths de escritura |
| sin-panel-owner | alta | B | lib/session.ts / app/(app)/plataforma | 🟡 | Ronda 7 — **parcial**: entregados `UserProfile.isPlatformAdmin`, `requireSuperAdmin()`, guard + sidebar y el panel `plataforma/{ejercicios,tags}` con CRUD del catálogo global. **Faltan** tickets/feedback, formulario de contacto e impersonación cross-tenant |

### Menores (63) — agrupados por tema

**Timezone (bucket A, sweep de fechas):**

| Slug | Sev | Ubicación | Estado | Sesión |
|---|---|---|---|---|
| dashboard-buckets-utc | media | lib/dashboard.ts:371 | 🟢 | tz-dashboard (Ronda 1) |
| mini-calendar-days-getdate-utc | media | lib/dashboard.ts:514 | 🟢 | tz-dashboard (Ronda 1) |
| dashboard-page-getmonth-utc | baja | dashboard/page.tsx:13 | 🟢 | tz-dashboard (Ronda 1) |
| mini-calendar-today-browser-tz | baja | mini-calendar.tsx:18 | 🟢 | tz-dashboard (Ronda 1) |
| notifications-bell-no-tz | baja | notifications-bell.tsx:250 | 🟢 | tz-dashboard (Ronda 1) |
| pacientes-lastvisit-no-tz | media | pacientes/page.tsx:326 | 🟢 | tz-vistas (Ronda 1) |
| session-detail-no-tz | baja | session-detail.tsx:121 | 🟢 | tz-vistas (Ronda 1) + hidratación en Ronda 8 |
| public-booking-wizard-today-utc | baja | public-booking-wizard.tsx:606 | 🟢 | fix-public-booking-tz (Ronda 1) |
| agenda-client-emptyslot-sethours | baja | agenda-client.tsx:738 | 🟢 | fix-timeline-oncreate (Ronda 1) |
| getdaycounts-utc-slice | baja | lib/bookings.ts:163 | 🟢 | fix-bookings-tz (Ronda 1) |
| plan-startdate-utc-midnight | media | lib/programs.ts:164-187 · lib/plan-form-defaults.ts:32 | 🟢 | Reabierto en Ronda 11; **cerrado en ES1** (Ronda 14): `createProgram` con zod `ProgramCreate` y día AR (P0-S02a), Tab Plan y plantilla con hoy AR (P0-S02u-plan, P0-S02t). Ver `plan-dates-utc-host` |
| ics-export-week-window-host-tz | media | agenda/export/route.ts:17 | 🟢 | tz-server-exports (Ronda 1) |

**Integridad / concurrencia (bucket A/B):**

| Slug | Sev | Ubicación | Estado | Sesión |
|---|---|---|---|---|
| conflict-findfirst-sin-orderby | media | lib/bookings.ts:301 | 🟢 | booking-concurrencia (Ronda 1) |
| batch-fuera-de-runwithrls | media | lib/bookings.ts:755 | 🟢 | Ronda 4 — `createBookingsBatch` corre bajo `runWithRls` (verificado) |
| batch-create-overlap-race-and-no-rls | media | lib/bookings.ts:734 | 🟢 | idempotencia Ronda 1 + parte RLS Ronda 4 |
| booking-paid-toggles-no-optimistic-lock | baja | lib/bookings.ts:1191,1210 | 🟢 | A2a-S06 (30-sep) — lock atómico con `updatedAt` en el WHERE; devuelven el `updatedAt` nuevo |
| mp-webhook-idempotency-check-outside-tx | baja | lib/mercadopago.ts:193 | 🟢 | payment-amount-anclado (Ronda 2) |
| session-index-no-unique-constraint | baja | prisma/migrations/20261004120000_plans_booking_link | 🟢 | Planes P1-S10 (ES2a, Ronda 15) — único parcial `Session_programId_index_live_key` (`WHERE "archivedAt" IS NULL`), test en `plans-m1-schema.test.ts`; dedupe previo P0-S02x para prod. Absorbe `soft-delete-wholesale` (el "archivar en vez de borrar" de las actions es P2-S15) |
| program-session-hard-delete | media | lib/patients.ts:1316 | 🟢 | patients-integridad — gate de rol (Ronda 2) |
| session-totalsessions-read-modify-write | baja | lib/patients.ts:1347 | 🟢 | patients-integridad (Ronda 2) |
| retroactive-copago-on-coverage-replace | media | lib/patients.ts:1091 | 🟡 parcial → C0 | Planes P2-S12 (Ronda 17, Q8): al marcar Cobrado con `copagoCents` null se congela el copago resuelto. El resto (impagos pasados, `insurerPaidAt`) → **C0**. A2a-S08 cortó la parte de pérdida: misma OS actualiza en el lugar y el copago propio solo se borra con `resetCopago` confirmado |
| coverage-sin-schema-zod | media | lib/patients.ts:1015 | 🟢 | patients-integridad (Ronda 2) |

**Seguridad / config / observabilidad:**

| Slug | Sev | Ubicación | Estado | Sesión / Gate |
|---|---|---|---|---|
| sin-headers-seguridad-csp | media | next.config.mjs | 🟡 | headers-seguridad — CSP en **Report-Only** (Ronda 2), con reportes a Sentry y HSTS solo en Production desde A3b (30-sep); falta activarla como bloqueante (C1) |
| serveractions-allowedorigins-localhost | baja | next.config.mjs | 🟢 | headers-seguridad (Ronda 2) |
| checkout-practitionerid-sin-validar | media | ~~booking/checkout/route.ts~~ | 🟢 | Ronda 2; la ruta huérfana `/api/booking/checkout` se **eliminó** en A0b (Ronda 11): sin callers, creaba turnos sin validar |
| upload-sin-magic-bytes | media | lib/files.ts:118 | 🔴 | files-magic-bytes — sin sniffing de firma en el código |
| password-sin-complejidad | baja | lib/auth.ts:53 | 🟢 | password-policy (Ronda 2; el lado Supabase es del dueño) |
| rate-limit-inmemory-activo-prod | media | lib/rate-limit.ts | 🟡 | Código listo (A3a, 30-sep); EXTERNAL-CONFIG: Upstash (dueño) |
| m1-sentry-no-wired | media | instrumentation.ts | 🟡 | A3b-S-obs (30-sep): `@sentry/nextjs` 11.1.0 instalado, no-op sin DSN, PII redactada. **Falta `SENTRY_DSN`** (dueño). Sin SDK de cliente hasta C1 |
| sentry-no-cableado | media | instrumentation.ts | 🟡 | mismo estado que `m1-sentry-no-wired` |
| m2-silent-catches | media | notifications-internal.ts:37 | 🟢 | sentry-observabilidad (Ronda 2) |
| audit-fire-and-forget | media | audit-extension.ts:74 | 🟢 | sentry-observabilidad (Ronda 2) |
| m3-no-apm | media | — | ⏸ | gate: ≥5 tenants o incidente p95 |
| l2-no-virus-scan | baja | lib/files.ts:33 | ⏸ | gate: antes de upload de pacientes |
| public-slots-ratelimit-vacio | media | lib/public-booking.ts:95 | 🟢 | fix-public-booking-tz (Ronda 1) |
| gettenantprisma-dead-code | media | lib/db.ts:76 | 🔴 | cliente-tenant-unico-guc — `getTenantPrisma` sigue definido (lib/db.ts:108) y sin ningún call site |
| rls-coverage-gaps | media | policies.sql:32 | 🟢 | cerrado junto con `tenant-tables-sin-rls-ni-filtro` (Ronda 4, re-verificado 2026-09-29) |
| sin-test-tripwire-aislamiento | media | schema.prisma:19 | 🟢 | Ronda 4 — `tests/integration/rls-isolation.test.ts` (4 casos, cross-tenant INSERT rechazado) |

**UX / forms / calidad de código:**

| Slug | Sev | Ubicación | Estado | Sesión |
|---|---|---|---|---|
| native-confirm-alert | media | turnos-view · plan-view · archivos-view · session-detail | 🟢 | A2 (30-sep): todo `useConfirm`; el `prompt()` de «Sesión a medida» pasó a Drawer. Re-verificado sin `confirm/alert/prompt` nativos en `components/` y `app/` |
| basics-sin-feedback-exito | media | general-panel.tsx:83 | 🟢 | configuracion-ux ("Guardado ✓", verificado 2026-09-29) |
| statustag-no-exhaustivo | media | agenda-client.tsx:1266 | 🟢 | agenda-visibilidad-statustag (Ronda 1) |
| statustag-label-drift | baja | agenda-client.tsx:1271 | 🟢 | agenda-visibilidad-statustag (Ronda 1) |
| turnos-fuera-de-horario-o-media-hora-no-visibles | media | agenda-client.tsx:1046 | 🟢 | agenda-visibilidad-statustag (Ronda 1) |
| formateadores-moneda-duplicados | media | agenda-client.tsx:95 | 🟢 | consolidados en `formatARS` (Ronda 1 parcial → Ronda 3) |
| export-type-en-use-server | baja | lib/dashboard.ts:32 | 🔴 | extraccion-logica-pura |
| logica-en-use-server-y-cliente | media | lib/public-booking.ts | 🟡 | A2b-S-pub extrajo la grilla pública a `lib/public-booking-slots.ts` (puro + test); el resto sigue en extraccion-logica-pura |

**Deuda estructural / SaaS / docs:**

| Slug | Sev | Ubicación | Estado | Sesión / Gate |
|---|---|---|---|---|
| deuda-archivos-grandes | media | components varios | 🟢 | split-* (Ronda 3) |
| role-gating-disperso-sin-matriz-central | media | lib/capabilities.ts · lib/authz.ts | 🟡 | capabilities-matrix — B-pre B1.7 (matriz única, los 6 chequeos copiados reemplazados); falta que `Actor` lleve el rol (C0) |
| roles-assistant-billing-cosmeticos | media | schema.prisma:108 · lib/capabilities.ts | 🟡 | roles-assistant-billing — B-pre les dio capabilities reales (ASSISTANT opera la agenda sin `clinical.read`); falta en C0 que puedan loguearse sin fila Practitioner (`secretaria-sin-practitioner`) |
| no-seat-usage-limits | media | lib/plan-gating.ts:36 | 🔴 | seats-limits |
| no-realtime-agenda-compartida | media | lib/cache-tags.ts:54 | 🔴 | **B · corrida SV** (07-oct: Sala de Espera realtime, entre ES3 y ES4; VERTICALES.md §7). Antes C2 |
| portal-auth-por-email-no-userid | media | lib/portal.ts:52 | 🔴 | Planes P4-S24a: el portal autoriza por `(tenantId, userId)`; vínculo automático por email verificado o invitación (PD-15) |
| patient-tenancy-single-home-row | baja | schema.prisma:250 | 🔴 | Planes P1-S10 (M1: `Patient.userId` único por consultorio, PD-14) + P4-S24a (una cuenta, fichas por consultorio, sin compartir nada clínico) |
| l1-portal-minimo | baja | lib/portal.ts:1 | 🔴 | Portal v2 (Ola 2.6) |
| scripts-adhoc-como-tests | baja | scripts/create-tenant.ts:1 | 🔴 | suite-integracion |
| no-qa-checklist-versionado | baja | — | 🟢 | TESTING.md |
| roadmap-vacio | media | docs/roadmap.md | 🟢 | ROADMAP.md |
| doc-memory-inexistente | baja | CLAUDE_CODE_SKILLS.md:61 | 🔴 | docs-baseline |
| doc-rls-adopcion-stale | baja | AUDIT.md:44 | 🟢 | reescrito en §0 |
| doc-falta-checklist-seguridad | media | SECURITY.md | 🟢 | este AUDIT.md |
| doc-falta-catalogo-bugs | baja | — | ⏸ | gate: catálogo propio post-Etapa 1 |
| doc-falta-qa-conv-testing | baja | — | 🟡 | TESTING.md (convenciones aún diferidas) |

### Ítems nuevos de esta pasada (features + hallazgos incidentales)

| Slug | Sev | Ubicación | Estado | Sesión |
|---|---|---|---|---|
| invitation-token-en-claro | media | lib/invitations.ts:161 | 🟢 | invitation-token-hash — `hashInviteToken` en `lib/invitations-tokens.ts` (Ronda 2, verificado) |
| money-input-sin-parser-ar | media | configuracion-client.tsx:565, agenda-client.tsx:218 | 🟢 | money-input-parser — `parseARS` en `lib/format.ts` + call sites migrados (Ronda 2) |
| dicom-fuera-de-allowlist | baja | lib/files.ts:33 | 🔴 | booking-adjuntos |
| sin-not-found-403-custom | baja | app/ | 🟡 | error-loading-boundaries — `app/not-found.tsx` ✅ (Ronda 1); **403 custom sigue diferido** |
| sin-sitemap-robots | baja | app/ | 🔴 | seo-analytics |

### Hallazgos de la auditoría 23-sep y de A2/A3 (30-sep-2026)

Solo los grupos que tocó el Bloque A (el resto de los ~45 grupos vive en el plan vigente, con su bloque).
Evidencia de cada cierre en §Ronda 12.

| Slug | Sev | Bloque | Ubicación | Estado | Cierre / destino |
|---|---|---|---|---|---|
| H1 delete-booking-con-cobro-manual | alta | A | lib/bookings.ts:1046 | 🟢 | A2a-S06 |
| H2 editar-paciente-borra-cobertura-copago | alta | A | lib/patients.ts:1091 · hero.tsx:334 | 🟢 | A2a-S08 |
| H3 cerrar-sesion-descarta-eva-notas | alta | A | lib/sessions.ts:462 | 🟢 | A2a-S03 |
| H4 reserva-publica-takeover-por-dni | alta | A | lib/public-booking-internal.ts:122 | 🟢 | A2b-S-pub |
| H5 signup-autoconfirma-email | alta | A | lib/auth.ts:49-137 | 🟢 | A3c-S-signup — `auth.signUp` verificado; el tenant se crea en `/onboarding` |
| H6 preview-migra-prod | alta | A | scripts/vercel-build.mjs | 🟢 | A0b (staging aislado: A0d, dueño) |
| booking-idor-practitioner-patient | alta | A | lib/bookings.ts:565-595,1295-1317 | 🟢 | A2a-S06 |
| booking-idempotency-key-cross-tenant | alta | A | lib/bookings.ts:712-720 | 🟢 | A2a-S06 (hallado en la sesión) |
| p2002-target-null-bajo-rls | media | A | lib/bookings.ts:234 | 🟢 | A2a-S06 — prerrequisito del flip de RLS cerrado |
| basic-access-puede-escribir | alta | A | lib/bookings.ts:64 · lib/sessions.ts · lib/files.ts | 🟢 | A2a-S06/S03/S08, A2b-S-vis (acceso básico = solo ver) |
| ics-export-invocable-como-rpc | media | A | lib/bookings-export-internal.ts:19 | 🟢 | A2a-S06 |
| csv-export-invocable-como-rpc | media | A | lib/patients-export-internal.ts:33 | 🟢 | A2 (revisión) + escape de fórmulas y audit |
| reschedule-heuristica-2h | alta | A | lib/sessions.ts:319 | 🟢 | A2a-S03 — mueve solo la sesión |
| mp-webhook-downgrade-y-revive | alta | A | lib/mercadopago.ts:184,247 | 🟢 | A2b-S-pub |
| public-booking-fuera-de-grilla | media | A | lib/public-booking-slots.ts:114 | 🟢 | A2b-S-pub |
| public-pending-retiene-cupo-para-siempre | media | A | lib/booking-capacity.ts:132 | 🟢 | A2 — vence a los 30 min (UNPAID y FAILED) |
| money-input-step-100-y-x100 | media | A | components/ui/money-input.tsx | 🟢 | A2b-S-cfg |
| remove-member-con-turnos | media | A | lib/invitations.ts | 🟢 | A2b-S-cfg |
| rate-limit-sin-timeout-y-gaps | alta | A | lib/rate-limit.ts:177 | 🟢 | A3a-S-rl (falta la env de Upstash, dueño) |
| open-redirect-next | alta | A | lib/safe-next.ts:29 | 🟢 | A3b-S-auth |
| session-sin-refresh-y-cookies-no-httponly | media | A | middleware.ts:69-87 · lib/supabase/cookie-options.ts | 🟢 | A3b-S-auth |
| staff-igual-paciente | alta | A | lib/portal.ts:61 · lib/invitations.ts:148 | 🟢 | A3b-S-auth (solo propio tenant en `createInvitation`; ver SECURITY §9) |
| checkin-trunca-notas-del-kine | media | A | lib/portal.ts:196 | 🟢 | A3b-S-auth |
| next-cves-14.2.18 | alta | A | package.json | 🟢 | A3b-S-obs → 14.2.35 |
| logs-y-sentry-con-pii | media | A | lib/redact.ts | 🟢 | A3b-S-obs |
| write-paths-sin-membresia-aceptada | media | C0 | lib/bookings.ts (create/batch) · lib/patients.ts (reasignar) · lib/services.ts · lib/sessions.ts (sesión a medida) | 🔴 | C0 — validan practitioner ∈ tenant pero no membresía aceptada; los pickers ya no ofrecen removidos |
| batch-key-otro-tenant-no-rechaza | baja | C | lib/bookings.ts:1465 | 🔴 | C — usa `update: {}` (no escribe nada ajeno), pero debería rechazar como `createBooking` |
| cupo-1-toctou | media | C | lib/booking-cap-lock.ts · lib/bookings.ts · lib/public-booking.ts · lib/mercadopago.ts | 🟡 | **B-pre cerró agenda y turnero** (lock de cupo por profesional+servicio+día AR dentro de la tx; test con `pg_locks`). Sigue 🔴 en C: el pago tardío del webhook sobre una reserva vencida confirma y avisa sin revalidar el cupo |
| formatars-sin-centavos-en-listados | baja | C1 | lib/format.ts | 🔴 | C1 — $1.500,50 se ve "$1.501" |
| destildar-copago-publica-la-vence | baja | C1 | components/agenda | ⏸ | aceptado: vuelve UNPAID y puede quedar vencida |
| seguimiento-7-queries | baja | C1 | app/(app)/seguimiento/page.tsx | 🔴 | C1 perf — medido al cierre de A: 8→28 statements en 1 tx, 15→47 ms (PERF.md) |
| portal-plan-expone-notas-de-sesion | media | B | lib/portal.ts:150-168 | 🟢 | P0-S02p (ES1) — `getPortalPlan` sin `notes` y con el ACTIVE más reciente; test en `portal.test.ts` |
| signup-confirm-doble-salto | alta | A | lib/auth.ts · lib/safe-next.ts `unwrapConfirmNext` · app/auth/confirm/route.ts | 🟢 | cerrado 30-sep: `emailRedirectTo` = destino final + unwrap de `next` autorreferente; test en safe-next.test.ts |
| tenant-contacto-solo-en-stepper | baja | C0 | lib/onboarding.ts · Configuración | 🔴 | C0 — `phone`/`whatsapp`/`publicEmail` no se editan en `updateTenantBasics` |
| onboarding-actor-otro-tenant | baja | C | lib/onboarding.ts (pasos 3-6) | 🔴 | C — OWNER con alta sin terminar que acepta invitación de otro tenant: `getActor` puede elegir el otro |
| env-local-node-env-rompe-build | baja | ops | .env.local | 🟡 | documentado en TESTING.md (build con `-v NODE_ENV=production`) |

### Hallazgos de B-pre (01-oct-2026)

Evidencia en §Ronda 13. Ninguno bloquea el deploy de B-pre.

| Slug | Sev | Bloque | Ubicación | Estado | Destino |
|---|---|---|---|---|---|
| servicio-deshabilitado-regresion-multi-pro | media | B-pre | lib/bookings.ts:313 · migración agenda_foundations paso 3b | 🟢 | fix de la revisión: backfill 3b (PRIVATE) + copy del slot picker |
| servicio-asignado-sigue-publico-para-otros | media-baja | B-pre | lib/services.ts | 🟢 | fixer — los demás profesionales quedan PRIVATE (`lib/services.ts:229-241`) |
| recepcion-practitioner-sobre-ajenos | media-baja | B-pre | lib/bookings.ts `markReceptionAction` | 🟢 | fixer — propio o acceso completo (`lib/bookings.ts:~1748-1750`) |
| recepcion-deshacer-confirma-guest-impago | baja-media | B-pre | lib/reception-state.ts | 🟢 | fixer — vuelve a PENDING (`lib/reception-state.ts:40-49`) |
| toarminutes-medianoche-1440 | media | B-pre | lib/datetime-ar.ts:77-83 | 🟢 | `% 24` + test |
| batch-count-sin-zod | baja | B-pre | lib/validation.ts:216 | 🟢 | zod 1..60 |
| perf-week-occupancy-on | baja | C1 | lib/agenda-layout.ts `weekOccupancy` | 🔴 | C1 perf — ~10 ms por semana de 6 profesionales (presupuesto de frame 16 ms) |
| perf-batch-una-tx | baja | C1 | lib/bookings.ts `createBookingsBatch` | 🔴 | C1 perf — 166 statements / 22 tx para 20 turnos |
| perf-create-booking-34-statements | baja | C1 | lib/bookings.ts `createBooking` | 🔴 | C1 perf — 34 statements / 5 tx (A1: 12/7) |
| perf-preview-recurrence-mensual | baja | C1 | lib/availability-actions.ts `previewRecurrence` | 🔴 | C1 perf — 106 statements para 20 fechas mensuales |
| perf-agenda-payload-1mb | media | C1 | lib/bookings.ts `listAgendaBookings` · app/(app)/agenda/page.tsx | 🔴 | C1 perf — ~1 MB por semana con 6 profesionales |
| perf-harness-explain-params-tipados | baja | C1 | tests/perf/loaders.perf.test.ts | 🔴 | C1 — pasar a literales como `agenda-multi.perf.test.ts`; los Seq Scan del baseline de A1 pueden ser falsos positivos |
| missing-fk-indexes (`Coverage.patientId`) | baja | C1 | prisma/schema.prisma | 🔴 | C1 (ya anotado en A1; se re-confirmó) |
| bundle-sobre-presupuesto-bpre | media | C1 | /agenda 195 · /configuracion 209 · /pacientes/[id] 194 · /onboarding 185 · /plataforma/ejercicios 184 · /diagnostico 180 · /c/[slug]/booking 153 kB | 🔴 | C1 — el layout compartido creció 10-16% |
| zoom-dia-semana | baja | C1 | lib/preferences.ts · components/agenda/agenda-utils.ts | 🔴 | C1 — el zoom 15/30/60 solo aplica a Por profesional; decidir zoom por usuario vs `Tenant.agendaSlotMinutes` |
| statustag-fmtmoney-duplicados | baja | B | components/ui/status-tag.tsx · components/agenda/booking-drawer/billing-rows.tsx:4,68 | 🟢 | P0-S04b (un `StatusTag`, `formatARS` en `billing-rows`); cierre formal en P3.Z (Ronda 18) |
| booking-body-css-regla-muerta | baja | C | app/globals.css | 🔴 | C — regla `.booking-body` (≤1024 px) |
| turnero-texto-fijo-lun-sab | baja | C | nav del turnero público | 🔴 | C — "lun-sáb 8 a 19hs" fijo; derivar de las franjas reales |
| public-overlap-lookback-sin-uso | baja | C | lib/public-booking* | 🔴 | C — `PUBLIC_OVERLAP_LOOKBACK_MS` sin uso |
| agenda-listpatients-in-1000 | baja | C1 | app/(app)/agenda/page.tsx | 🔴 | C1 — conocido (`agenda-loads-full-patient-directory`) |
| secretaria-sin-practitioner | media | C0 | lib/session.ts:91-97 | 🔴 | C0 — `buildActor` exige fila Practitioner: una Secretaria (ASSISTANT) no puede loguearse sin una |
| catalogo-siglas-ambiguas | baja | catálogo | prisma/catalog/payers.csv (`aliases`) · lib/catalog/normalize.ts `matchKey` | 🔴 | curado en Plataforma — 37 siglas ambiguas sin alias (p. ej. OSPA no se encuentra por sigla) |
| catalogo-datos-por-verificar | baja | catálogo | prisma/catalog/payer-plans.csv · specialties.csv | 🔴 | curado — planes Sancor 1000/1500 y especialidades de Mendoza |

### Hallazgos del planning de Planes y de su verificación (02/03-oct-2026)

Planning en [PLANES.md](PLANES.md) (firmado por Martin el 03-oct). Los de bloque A eran fugas vivas o permisos de la
Secretaria (enmiendas E0/E1, verificadas por `wf_bf603f14-cb7`). **ES1 los cerró en código** (Ronda 14); por la
decisión del 04-oct ("nada se despliega hasta cerrar B") **siguen vivos en prod** hasta el deploy final. Desde el
07-oct no hay hotfix: prod se resetea y el código nuevo sale en el deploy único. Las líneas de 🟢 son del working tree al cierre de ES1.

| Slug | Sev | Bloque | Ubicación | Estado | Sesión dueña / cierre |
|---|---|---|---|---|---|
| getpatient-rpc-sin-gate | alta | A | ~~lib/patients.ts:647~~ | 🟢 | P0-S02a — borrada; `tests/integration/patients-rpc-surface.test.ts:66-68` afirma que el export no existe. El revisor (b) barrió las exports que leen Patient/Booking/Session: 0 fugas nuevas |
| exercise-media-firmador-abierto | alta | A | lib/exercise-media.ts:10-12 · lib/exercise-media-internal.ts:56 | 🟢 | P0-S02m — `lib/exercise-media.ts` sin firmadores; `signExerciseMedia(mediaId)` firma solo la clave de la fila (solo media global; scoping por tenant → C1 si aparece media de tenant) |
| storage-policies-sin-verificar | alta | A | lib/storage-internal.ts:68,86,104 · lib/files.ts:39 · storage.objects | 🟢 | **Lado código** (P0-S02m: Storage solo por service role, `{error}` chequeado). **Prod pendiente:** precheck (17) de Martin; si hay bucket público o policy anon/authenticated, se saca en el go-live (MIGRACIONES-RUNBOOK «Go-live con reset», paso 10). Requiere `SUPABASE_SERVICE_ROLE_KEY` en Vercel |
| listbookingsinrange-rpc-sin-clinical | media | A | lib/bookings.ts:663,727,744-777 | 🟢 | P0-S07k — `bookingFieldAccess` + `patientCondition` solo con `clinical.read` y full; test `bookings-range-clinical.test.ts` (borrarla sigue en C1) |
| secretaria-autoasigna-pacientes | alta | A | lib/patients.ts:757-857 | 🟢 | P0-S07sp — `createPatient(raw, {assignTo})` al profesional del turno, validado en la tx. Prod: precheck (15) antes del deploy |
| secretaria-ve-hc-con-shared | alta | A | lib/visibility.ts:138,153-155,200,249 · lib/patients.ts:332-402,1026-1036 · booking-drawer/index.tsx:163 · patient-profile.tsx:356 | 🟢 | P0-S02p (nivel `admin`) + P0-S07sp (proyección `admin`, `setPatientDiagnosis` con `canWriteClinical`) + P0-S07u (drawer; "Usar como diagnóstico" ya no borra) + P0-S07v (perfil) |
| portal-userid-unique-500 | media | B | prisma/schema.prisma (Patient) · app/auth/callback/route.ts:69-83 | 🟡 | **Índice listo en P1-S10** (ES2a): `Patient_tenantId_userId_key` reemplaza al global, test en `plans-m1-new-tables.test.ts` (mismo `userId` en 2 tenants pasa, en el mismo da P2002). Se cierra con P4-S24a (el flujo del callback y el P2002 del mismo consultorio) |
| plan-creation-sin-gate-basic | alta | B | ~~lib/programs.ts:164-187~~ · lib/plans-engine-internal.ts (`createPlanInTx`) | 🟢 | P0-S02a — `createProgram` con `hcAccessError` en la tx. Desde ES3 (S27a) `createProgram` no existe: toda alta va por el motor (`plans.manage`) |
| diagnosis-ejercicios-y-condicion-sin-gate | alta | B | lib/diagnosis.ts:208-280 | 🟢 | P0-S02d — gate full en la tx, ejercicios `assignable`, condición global o del tenant |
| apply-plan-template-null-sets-reps | media | B | lib/plans-engine-internal.ts:249-277 | 🟢 | P0-S02t — dosis `?? 3/12`. Desde ES3 el `applyPlanTemplate` viejo no existe (S27b): la plantilla va por `createPlan` con `templateId` y el motor usa `defaultSets ?? 3` / `defaultReps ?? 12` del ejercicio (P3.Z F1) |
| varios-planes-activos-take1 | media | B | lib/patients.ts:186 · lib/bookings.ts:697 · lib/diagnosis.ts:435 · lib/portal.ts:168 · patient-profile.tsx:63 | 🟢 | P0-S02a / S07k / S02d / S02p / S02u-perfil — `orderBy createdAt desc`; el perfil elige el ACTIVE más reciente y muestra "+N" |
| session-index-race-addCustomSession | media | B | ~~lib/sessions.ts:~745~~ · motor (`addPlanSessions`) | 🟢 | P0-S02s — `SELECT … FOR UPDATE` del programa. `addCustomSession` se retiró en ES3 (S27b); la carrera de 2 altas "a medida" sobre `addPlanSessions` sigue en `tests/integration/sessions.test.ts:320` |
| gating-ejercicios-incluye-archivados | media | B | lib/plan-gating.ts:88 · lib/sessions.ts:646,810,959 | 🟢 | P0-Ck (`assignableExerciseWhere`) + P0-S02s/S02d/S02t; el bulk no toca sesiones realizadas |
| statustag-tres-paletas | baja | B | components/ui/status-tag.tsx:83 | 🟢 | P0-S04b — un solo `StatusTag` con `--st-*`; drawer, Lista, perfil y Recepción lo re-exportan |
| tokens-inexistentes | baja | B | app/globals.css:26,34,51-52,63 | 🟢 | P0-S04a — `--lime-700`, `--navy-400`, `--disc-kine`/`--disc-osteo` (hex AA) y `--st-*` definidos; `tag.tsx` no necesitó cambios |
| saveDiagnosisDraft-rpc-muerta | baja | B | lib/diagnosis.ts:14 | 🟢 | P0-S02d — borrada (sin callers) |
| ics-ignora-clinical-read | media | B | lib/bookings-export-internal.ts:68-84 | 🟢 | P0-S02p — detalle solo con `bookingFieldAccess` (full **y** `clinical.read`); test `ics-export.test.ts` |
| plan-dates-utc-host | media | B | diagnostico-wizard.tsx:60 · assign-plan-modal.tsx:103 · plan-template-apply.tsx:10 · lib/plan-form-defaults.ts:32 | 🟢 | P0-S02u-diag + P0-S02u-plan — hoy AR con `toARDateKey` (`plan-view.tsx:346` no era bug). Absorbe `plan-startdate-utc-midnight` |
| updateProgram-desincroniza-total | alta | B | lib/plans-lifecycle.ts | 🟢 | P2-S15 (Ronda 17) + P3-S27a (Ronda 18): `updateProgram` se retiró entero; queda `updatePlanDetails` (título y notas, CAS). Cantidad y fechas solo por `addPlanSessions`/`archivePlanSessions`/`replanPlan` |
| hard-delete-plan-session | media | B | lib/programs.ts:328 (`deleteProgram`) · :344 (`deleteSession`) | 🟢 | P2-S15 (Ronda 17) — `deleteProgram` archiva (solo CANCELLED/COMPLETED); `deleteSession` rechaza (*"archivala desde el plan"*); archivar/restaurar por `archivePlan`/`archivePlanSessions`/`restoreSession`. Nada vinculado se borra (§5.39) |
| delete-service-sin-contar-planes | media | B | lib/services.ts:315-318 (`deleteService`) | 🟢 | P2-S13 (Ronda 17) — cuenta `bookings` y `programs` → mensaje, no P2003. Test `plan-refs-guards-services.test.ts` |
| ensureTag-kind-libre | media | B | lib/exercises.ts:268,277 | 🟢 | P2-S13x (Ronda 17) — allowlist `TENANT_CREATABLE_TAG_KINDS` (sin DISCIPLINE) y slugs `kinesiologia`/`osteopatia` reservados (`isReservedTagSlug`), también en los tags de `createExercise`. Test `exercises-discipline.test.ts` |
| reception-p2002-500 | media | B | lib/bookings.ts:1285 (`markReceptionAction`) | 🟢 | P2-S12 (Ronda 17) — "Deshacer Ausente" con otro turno activo de la sesión atrapa P2002 → mensaje. Test `plans-sync-bookings.test.ts` |
| upsert-holder-pisa-turno-de-plan | alta | B | lib/bookings.ts:759 (`createBooking`, upsert del holder) | 🟢 | P2-S12 (Ronda 17) — un reintento de alta sobre un turno adoptado (`programId` no nulo) devuelve éxito idempotente sin update (C3) |
| dashboard-session-index-crudo | baja | B | lib/dashboard.ts · app/(app)/seguimiento/[sessionId]/page.tsx:17-18,48 | 🟢 | P2-S14 (server, Ronda 17) + P3-S20 (página, Ronda 18) — "Sesión n de N" por ordinal entre vivas (M13); título/condición nulos sin `clinical.read` |
| limites-sesiones-divergentes | baja | B | lib/validation.ts:318 · diagnosis · plantillas · plan-view.tsx:419 | 🟡 | tope 60 (`PLAN_MAX_SESSIONS`) aplicado en P0 (S02a/S02d/S02t/S02u-plan) → se cierra en P4.Z con el editor |
| plantillas-sin-crud | media | B | lib/plan-templates.ts · components/planes/templates/ | 🟢 | P3-S17t + P3-S21t (Ronda 18) — CRUD con disciplina, servicio, horario, precio y archivo; CAS opcional; autor o admin; `getTemplatePrefill` abre el editor; solo con el módulo `plantillas` |
| plan-status-sin-confirm | baja | B | components/planes/plan-lifecycle-dialogs.tsx:158 (`PlanStatusDialog`) | 🟢 | P0-S02u-plan + P3-S22a (Ronda 18) — cambio de estado por diálogo D7 (cancelar/mantener futuros), "cancelar" en variante danger |
| hero-plan-activo-falso | baja | B | components/patients/profile/hero.tsx:41-45 | 🟢 | P0-S02u-perfil + P3-S22h (Ronda 18) — chips por disciplina (`heroPlanChips`: ACTIVE antes que PAUSED), sin título; `HeroPlanState` retirado |
| service-duration-mayor-lookback | baja | C1 | lib/services.ts:70 (5..480) vs lookback 240 | 🔴 | C1 — Planes valida la duración efectiva 15..240 (`validatePlanRefsInTx`) y exige override |
| perf-baseline-se-regraba | baja | B | tests/perf/loaders.perf.test.ts:77-80 · pool-pressure:40 · agenda-multi:23 · tests/perf/compare.ts | 🟢 | P0-Cs + P0-Ct — `PERF_OUT_DIR` (medir fuera del árbol) + `compare.ts` contra el baseline versionado |

**Revisión de cierre de ES1 (P0.Z).** Revisor (a) (locks, dedupe, sesiones, TZ): 0 altos. Revisor (b) (seguridad,
E0/E1): 0 fugas nuevas; los H-b son preexistentes.

| Slug | Sev | Bloque | Ubicación | Estado | Cierre |
|---|---|---|---|---|---|
| A1 prior-paid-cuenta-refunded | media | B | lib/plan-pricing.ts:309 (`priorPaidStamp`) | 🟢 | cerrado en P0.Z (fixer) — el reemplazo salía en $0 con un previo REFUNDED/AUTHORIZED. Ahora "cobro previo" = `bookingWasCollected` (`PAID`, `insurerPaidAt` o Payment `PAID`, `lib/plan-pricing.ts:89`); `bookingHasMoney` sigue para la fila bloqueada del reprecio. PLANES C5 |
| A3 sugerencia-ultima-fila-mismo-dia | baja | B | lib/availability/plan.ts (`classifyPlanRows`, última fila) | 🟢 | cerrado en P0.Z (fixer) — la última fila usaba `addDays(día,1)` y nunca sugería otro día; ahora pasa `null` (horizonte de `nextFreeSlot`) |
| A4 autocompletar-carrera-ultimas-sesiones | baja | B | lib/sessions.ts (`completeSessionFromSeguimiento`) | 🟢 | cerrado en P0.Z (fixer) — dos cierres concurrentes de las últimas sesiones nunca autocompletaban; ahora toma Session → `TreatmentProgram` `FOR UPDATE` antes del conteo (PLANES C2 (3)) |
| A5 reschedule-session-check-then-write | baja | B | lib/sessions.ts (`rescheduleSession`) | 🟢 | cerrado en P0.Z (fixer) — check-then-write sin lock; ahora toma Session → `TreatmentProgram` `FOR UPDATE` en la tx (PLANES C2 (3)) |
| H-b1 listpatients-oraculo-diagnostico | media | B | lib/patients.ts (`listPatients`) | 🟢 | cerrado en P0.Z (fixer) — era un oráculo de diagnóstico. Decisión: con filtros clínicos (diagnóstico / con plan / sin plan) un rol sin `clinical.read` recibe lista vacía; con obra social / edad / última visita se descartan las filas basic y se conservan las `admin`. Cerrado también el oráculo de email en `q` para filas basic. Test: `tests/integration/es1-review-fixes.test.ts` para `admin`/basic |
| H-b2 share-authority-secretaria | baja-media | B | lib/patients.ts (`requireShareAuthority`, `assignPatientToPractitioner`) | 🟢 | cerrado en P0.Z (fixer) — la Secretaria asignada manejaba shares y `assignPatientToPractitioner` no exigía `CLINICAL_ROLES`. Test: `es1-review-fixes.test.ts` |
| H-b3 guest-full-abre-billing | baja | B | lib/bookings.ts (turnos guest) | 🟢 | cerrado en P0.Z (fixer) — guest = full le abría a BILLING operar, borrar y cobrar turnos guest. Ahora `guestOperable` = `agenda.operateAll || clinical.read`; la Secretaria sigue fijando el copago de un guest (intencional). Test: `es1-review-fixes.test.ts` |
| H-b4 search-assignment-edad-plan | baja | B | lib/diagnosis.ts:404 (`searchPatientsForAssignment`) | 🟢 | cerrado en P0.Z (fixer) — devolvía edad y plan activo a cualquier rol (el picker del Plan Builder queda en propios + compartidos). Test: `es1-review-fixes.test.ts` |

**Hallazgos nuevos de ES1** (clasificados en el momento):

| Slug | Sev | Bloque | Ubicación | Estado | Destino |
|---|---|---|---|---|---|
| search-condition-sin-tenant-y-email-basic | baja | C | lib/search.ts:76-83,126 | 🟡 condiciones 🟢 en EV0 (EV-G) | C (queda el email) — la búsqueda de `condition` no filtra por tenant (con BYPASSRLS ve los nombres de condiciones privadas de otros consultorios; sin PHI) y a nivel basic muestra el email del paciente si no hay DNI |
| secretaria-edita-contacto-cobertura | media | C0 | lib/patients.ts (`updatePatient`, cobertura) · perfil `admin` | 🔴 | C0 — PD-13 dice que `admin` ve contacto y cobertura; en ES1 el perfil `admin` es **solo lectura**. También: selector "Profesional a cargo" al crear desde el directorio (hoy la Secretaria crea solo desde el modal del turno) y `getPatientBillingPreview` sigue pidiendo full (la Secretaria ve copago null en el modal) |
| ui-filtros-y-selector-sin-clinical | baja | C0 | profile/hero.tsx (selector "Profesional a cargo") · PatientsSearchBar | 🔴 | C0 — el selector del hero debería listar solo roles clínicos (el server ya rechaza los otros) y la barra del directorio debería ocultar "Con plan/Sin plan" y el filtro de diagnóstico sin `clinical.read` (el server ya devuelve vacío) |
| directorio-admin-sin-contacto | baja | C0 | lib/patients.ts (`listPatients`) · patients-list.tsx:44 · recent-patients.tsx | 🔴 | C0 (no entró en ES3) — el directorio para `admin` sigue con la proyección básica (sin contacto); al sumar `admin` a `PatientRow`, los chequeos de UI pasan a la forma positiva `=== "full"` |
| deshacer-atendido-no-reabre-sesion-a-medida | media | B | lib/sessions.ts (`addCustomSession`) | 🟢 | P2-S12b (Ronda 17) — el título va a `Session.title` (M1), no a `notes`: la sesión a medida queda "untouched" y "Deshacer Atendido" la reabre. Desde P2.Z `addCustomSession` delega en el motor (H-a3) |
| wizard-mobile-sin-dias | baja | B | components/diagnostico/assign-plan-modal.tsx:10,39-40 | 🟢 | P3-S23 (Ronda 18) — el modal y el wizard abren el editor único prellenado, que tiene el horario por día |
| edit-toggles-tooltip-secretaria | baja | B | components/agenda/booking-drawer/edit-toggles.tsx:67 | 🔴 | P3 (o integrador) — "Editar duración + notas del turno" no aplica a la Secretaria |
| invite-app-bg-token | baja | C | app/invite/[token]/page.tsx:67 | 🔴 | C — `var(--app-bg, …)`: reemplazar por el fallback literal cuando se toque |
| time-blocks-lockcapacityscope | baja | C1 | lib/time-blocks.ts:152,340 | 🔴 | C1 perf — pasar `lockCapacityScope` a `lockCapacityMany` (1 sentencia) |

**Hallazgos de ES2a (P1.Z)** (Ronda 15):

| Slug | Sev | Bloque | Ubicación | Estado | Cierre |
|---|---|---|---|---|---|
| F1 pricing-check-null-mode | media | B | M1: `TreatmentProgram_pricing_check` · `PlanTemplate_pricing_check` | 🟢 | cerrado en P1.Z (fixer) — `=` → `IS NOT DISTINCT FROM`: con modo NULL el CHECK aceptaba precio (3VL). Enmienda de C1, avisada a Martin |
| F2 dedupe-agrupa-archivadas | baja | B | lib/plans-dedupe-internal.ts:72-85 | 🟢 | cerrado en P1.Z (fixer) — filtra `"archivedAt" IS NULL` si la columna existe; test "archivada + viva = 0" en `plans-dedupe.test.ts` |
| booking-patient-setnull-vs-plan-check | baja | B | init `Booking_patientId_fkey` (SET NULL) · M1 `Booking_plan_patient_check` | 🔴 | nota — latente: hoy lo frena `TreatmentProgram→Patient` RESTRICT. Revisar si se cambia el borrado de pacientes |

**Hallazgos de ES2b (P2.Z)** (Ronda 17). Revisor (a): concurrencia, locks C2, sincronía C4, extracción del core.
Revisor (b): plata C5, I6/I8, PHI del título, gates, autorización de la OS, contratos C7/C9. Todo lo marcado FIX quedó
cerrado por los fixers de P2.Z (motor, Seguimiento, plata) y verificado en el archivo.

| Slug | Sev | Bloque | Ubicación | Estado | Cierre / destino |
|---|---|---|---|---|---|
| motor-moved-currentAt | media | B | lib/plans-engine-internal.ts:269,588,837 | 🟢 | P2.Z (fixer motor) — en modo `replan`, `commitPlanRowsInTx` comparaba la fecha nueva contra sí misma (`moved` siempre falso) y no movía la sesión existente cuya fila quedó libre (I3). Ahora `PlanEngineRow.currentAt` = fecha actual de la sesión; se borraron los 2 workarounds (S16a, S25a). Test `plans-engine-fixes.test.ts` |
| H-a1 sesion-realizada-con-turno-activo | media-alta | B | lib/sessions.ts:949-964 · lib/plans-engine-internal.ts:737 | 🟢 | P2.Z (fixers motor + Seguimiento) — el cierre en Seguimiento leía el turno activo antes del claim y el motor creaba/adoptaba turnos sin re-chequear `completedAt` → sesión realizada con turno futuro (cobro doble). Ahora el motor lockea las sesiones que escribe (`lockWrittenSessionsInTx`, stale si ya se cerró) y Seguimiento re-cuenta después del claim (rollback + *"La sesión cambió mientras la cerrabas: reintentá."*) |
| H-a2 deadlock-seguimiento-replan | media | B | lib/sessions.ts:706,996 · lib/plans-move-internal.ts:719 | 🟢 | P2.Z — Seguimiento/`rescheduleSession` (Session → Program `FOR UPDATE`) contra re-planificar/vincular/adoptar (Program antes que Session; la FK de Booking pide `FOR KEY SHARE` sobre el plan). Ahora `FOR NO KEY UPDATE` sobre el plan, replan lockea sesiones antes de escribir refs, Session antes de los INSERT de Booking y `withTxConflictRetry` en cierre y reschedule. ADR-004 |
| H-a3 / B-M1 addCustomSession-sin-motor | media | B | ~~lib/sessions.ts:1233~~ (retirada en ES3, S27b) | 🟢 | P2.Z — creaba la sesión sin cuota, sin chequear estado/tope ni el verificador (PACKAGE vinculado quedaba trabado por I6) y con gate propio. Ahora delega en `addSessionsInTx` (`plans.manage`: la Secretaria ya no puede; PACKAGE sin `packagePricing` → rechazo con copy; COMPLETED → rechazo) |
| H-a4 reschedule-session-p2002-500 | baja | B | lib/sessions.ts (`rescheduleSession`) | 🟢 | P2.Z — P2002 → mensaje (`UPDATE_SAME_INSTANT_ERROR`), como `updateBooking` |
| B-M2 reprecio-package-sin-precio-500 | media | B | lib/plan-pricing.ts:196,242 · `rejection()` de plans-edit/move/plans/diagnosis | 🟢 | P2.Z (fixer plata) — pasar a PACKAGE con filas bloqueadas sin cuota: preview OK y commit tiraba I6 → 500. Ahora `repricePlan` devuelve `locked-unpriced` (preview y commit) y `ProgramInvariantViolation` se mapea a error de dominio en los 4 `rejection()` |
| B-M3 toggleBilling-cobro-previo | media | B | lib/bookings.ts:1488-1498,1581 | 🟢 | P2.Z — marcar/desmarcar Cobrado en un turno de plan CANCELLED/NO_SHOW no re-sincronizaba el reemplazo ($0 para siempre, o cobro doble). Ahora re-estampa el turno activo de la sesión con CAS en la misma tx y devuelve `notice` (stale → rollback). `setBookingCopagoPaid`/`InsurerPaid` devuelven `notice?` → toast en ES3 |
| B-L1 listAllTags-sin-gate | baja | B | lib/exercises.ts:316 | 🟢 | P2.Z — sin gate de módulo ni filtro: devolvía el texto libre de Tags de otros consultorios. Ahora `[]` sin `ejercicios` y solo tags usados por ejercicios/condiciones globales o propios; el superadmin ve todo |
| B-L2 listPlanTemplates-sin-gate | baja | B | lib/plan-templates.ts:36 | 🟢 | P2.Z — `[]` sin el módulo `plantillas` |
| B-L3 autorizacion-usadas-dos-criterios | baja | B | lib/plans-load-internal.ts:319 | 🟢 | P2.Z — el motor contaba "usadas" con otro día que el detalle; ahora ambos con `sessionDayKey` |
| P2-FX1 buscador-agenda-roto-por-H-b4 | alta | B | lib/patient-search.ts:55 · components/patients/patient-picker.tsx:30 | 🟢 | P2.2 — el `PatientPicker` de la agenda usaba `searchPatientsForAssignment` (desde H-b4 solo `full`, desde S17d con módulo `diagnostico`): la Secretaria, un PRACTITIONER en básico y un consultorio General no encontraban pacientes (rompía PD-09). Ahora `searchPatientsForBooking` (nombre + DNI, sin gate de módulo) y prop `source` del picker. Test `patient-search-booking.test.ts` |
| search-assignment-archivados | baja | B | lib/diagnosis.ts:484 | 🟢 | S17d — `searchPatientsForAssignment` devolvía pacientes archivados; ahora `archivedAt: null` |
| tenant-factory-planes-ajenos | baja | B (tests) | tests/helpers/tenant-factory.ts (`deleteTenantDeep`) | 🟢 | S12b/orquestador — el sweep fallaba con planes de otro tenant que apuntaban a sede/servicio/profesional del tenant (FKs simples); ahora los borra antes |
| retry-p2034-agenda | media | C0/C1 | lib/time-blocks.ts (`applyDayLock`, `createTimeBlock`) · lib/bookings.ts (`createBooking`) | 🔴 | **C0/C1** — no reintentan P2034/40P01 (C2 lo pide) y tapan la excepción con un error genérico ("No pudimos …"). Los tests de carrera de S11x pasan, pero un deadlock real llega al usuario como error opaco |
| after-commit-fuera-de-planes | media | B (SV) | lib/time-blocks.ts · lib/public-booking*.ts · lib/mercadopago.ts | 🔴 | **SV06** — escriben `Booking` sin `afterBookingsCommitted` (no revalidan ni van a publicar realtime). Ya planeado en SV |
| gates-reimplementados-legacy | baja | B | lib/sessions.ts:649 (`rescheduleSession`) | 🟢 | P3-S27a/S27b (Ronda 18) — `createProgram` y `applyPlanTemplate` retirados; `rescheduleSession` → `assertPlanScheduleInTx` + full |
| onCreateTag-sin-error | baja | C1 | components/biblioteca/biblioteca-client.tsx:969 | 🔴 | **C1** — no atrapa el Error de `ensureTag`; en prod Next enmascara el mensaje y el usuario no ve por qué no se creó |
| autorizacion-por-vencer-dashboard | baja | C1 | lib/dashboard.ts | 🔴 | **C1** — S14 no sumó el aviso "autorización por vencer" (era opcional) |
| os-pagada-en-saldo | baja | C0 | lib/plans-read-internal.ts (`balanceOf`) | 🔴 | **C0** — decisión S14: la OS pagada (`insurerPaidAt`) no suma en "cobrado" (es copago vs OS); el saldo expone `insurerPaidBookings` (conteo). Borde: turno cancelado con OS pagada |
| payload-c9-agenda | baja | B | components/agenda/agenda-utils.ts:131-176 (`compactPlanFields` / `expandPlanFields`) | 🟢 | **P3-C (Ronda 18)** — DTO compacto: omite los neutros C9 y `serviceDiscipline` sale del catálogo en el cliente. Statements de la agenda = ES2b (16). El +5 % sobre turnos sueltos no se midió aparte (PERF §ES3) |

**Diferidos del planning de Planes** (sin fila propia hasta que se planifique su bloque):
- **D:** prepago o seña con MP (D6); cargo por ausencia; **cargo por cancelación tardía** (fila `cargo-cancelacion-tardia`); pagar online desde el portal.
- **C0:** "Cobrar paquete" (salvo PQ-08); arancel de OS retroactivo y turnero que cobra `service.priceCents` (P11; los ingresos del
  dashboard que solo cuentan MP se cerraron en ES3: fila `ingresos-dashboard-solo-mp`); resto de `retroactive-copago-on-coverage-replace`; matriz fina de cobros (la
  Secretaria marcando cobros o borrando turnos) y BILLING; BILLING en "cualquier profesional". La Secretaria sobre
  turnos de plan **ya no es diferido**: entra en P0 (S07sb) y P2 (PD-09).
- **C1:** condiciones custom en Diagnóstico; BK-01/03/04/05/08/09; dosis por tiempo; único anti-carrera del check-in de
  EVA; perf del batch y de `createBooking`; borrar `listBookingsInRange`; zoom por usuario; ~~aviso del candado si exige
  tocar `time-blocks.ts`~~ (hecho en ES3: `DayLockAffected.inPlan`); presupuesto de bundle bloqueante; duraciones > 240 min; **ejercicios del portal fuera de un
  plan** (los del plan entran en P4-S24e); adjunto de la orden médica de la OS; aviso "autorización por vencer" en el
  dashboard (no entró en S14: fila `autorizacion-por-vencer-dashboard`); FKs compuestas opcionales hacia Service/Practitioner/Location; sub-ramas de disciplina.
- **C2:** plan abierto. (`no-realtime-agenda-compartida` pasó a la corrida SV del bloque B el 07-oct.)
- **Contract de B-pre:** después de P4.

**Modelo de permisos (E1), vigente desde ES1:** nivel de acceso `admin` en `lib/visibility.ts` (datos administrativos,
nunca HC) y capabilities `agenda.operateAll` (OWNER, ADMIN, ASSISTANT), `plans.manage`, `plans.schedule` y
`plans.authorize` (aplicadas desde ES2b por `lib/plan-authz-internal.ts`, SECURITY §13). §5.6 y §5.35 quedaron enmendados.

### Hallazgos y filas de EV0 · verticales y /plataforma (07-oct-2026)

Contexto y contratos en [VERTICALES.md](VERTICALES.md) (plan vigente §15). Corrida **EV0** con la migración M2
`20261007120000_tenant_verticals`.

| Slug | Sev | Bloque | Ubicación | Estado | Sesión dueña / cierre |
|---|---|---|---|---|---|
| data-api-anon-sin-rls | **crítica** | A | 9 tablas de `public` sin RLS (`UserProfile`, `UserPreferences`, `Favorite`, `Tag`, `ExerciseTag`, `ConditionTag`, `ConditionExerciseLink`, `AnatomicalRegion`, `ConditionAnatomy`) + policies sin `TO <rol>` + grants por defecto de Supabase a `anon`/`authenticated` | 🟡 REVOKE en M2 ✅ + acción de Martin en consola: **pendiente** | Si la Data API (PostgREST) expone `public`, la **anon key** (pública) podría leer emails y **escribir `UserProfile.isPlatformAdmin`**. La app nunca usa PostgREST. **Acción de Martin en consola** (Settings → API → Data API: desactivarla o sacar `public`; precheck de solo lectura en VERTICALES.md §1) **+ REVOKE guardado en M2 (EV0)** (`REVOKE ALL … FROM anon, authenticated` + `ALTER DEFAULT PRIVILEGES`, solo si los roles existen) y guard que falla ante un GRANT a `anon`/`authenticated`. No lo resuelve el reset de prod. **EV0:** M2 con el REVOKE guardado (`tenant-verticals-m2.test.ts` con roles temporales) + guard 3c en `guard:isolation`; post-check en RUNBOOK |
| tenant-verticals | media | B | `Tenant` · `lib/tenant-modules.ts`* · `lib/authz.ts` · `lib/session.ts` | 🟢 EV0 | EV-M (M2) + EV-C1: tipo de consultorio (General / Kinesiología), matriz de módulos `modulesFor`, `assertModule`/`guardModuleSegment`, nav único `lib/nav.ts`. Cubre el gap "no hay gating por tenant" y los segmentos `/diagnostico`, `/seguimiento`, `/biblioteca`, `/terapia-manual` sin guard (EV-Gd). Avanza `plan-fields-inert-no-upgrade-no-enforcement` (el plan pasa a tener efecto) sin billing |
| plataforma-consultorios | media | B | `lib/platform-tenants*.ts`* · `app/(app)/plataforma/**` | 🟢 EV0 | EV-P1/P2/P3: el superadmin ve y configura todos los consultorios (vertical, plan, estado de suscripción, trial, turnero). `prismaService` + `requireSuperAdmin` por export; solo `count`/`_count` sobre modelos con PHI |
| turnero-sin-switch | media | B | `lib/public-booking*.ts` · `app/(booking)/c/[slug]/booking/page.tsx` | 🟢 EV0 | EV-T: `Tenant.publicBookingEnabled` (opt-in, EV-D2); apagado → página "Turnos online no disponibles" `noindex` (EV-D4), slots `[]` y submit rechazado sin escribir. Switch en Configuración (EV-K) y en /plataforma |
| entitlements-escritor-unico | alta | B | `lib/tenant-entitlements-internal.ts`* | 🟢 EV0 | EV-C2 (C-EV5): único escritor de `vertical/plan/subscriptionStatus/trialEndsAt/publicBookingEnabled` después de `bootstrapTenant`, con allowlist por `source`, FOR UPDATE + CAS. Gate: grep 1 de VERTICALES.md §4 |
| audit-plataforma-en-tenant-afectado | media | B | `lib/audit.ts` | 🟢 EV0 | EV-C2 (C-EV6): `auditPlatformInTx` audita en el tenant **afectado** (`action: "platform.*"`, `payload.platform.actorHomeTenantId`), no en el del superadmin |
| facetas-condiciones-cross-tenant | media | A | `lib/exercises.ts` (`loadFilterFacets`) | 🟢 EV0 V.Z (P1) | Preexistente: `condition.findMany` sin `where` → con BYPASSRLS listaba condiciones custom de todos los consultorios. Ahora tenant + globales y `[]` sin `diagnostico`. Test con el rol owner en `ev0-review-fixes.test.ts` |
| turnero-prefill-cross-tenant | media | B | `lib/public-booking-internal.ts` (`findPatientByEmailForPrefill`) | 🟢 EV0 V.Z (P2) | Preexistente (PD-14): prefill con PII de una ficha de **otro** consultorio. Ahora `tenantId` obligatorio; `userId` → ficha única por email → nada. Test: ficha en A, sesión en `/c/B` → prefill null |
| search-conditions-cmdk-sin-tenant | baja | C | `lib/search.ts:76-83` | 🟢 EV0 (EV-G) | ⌘K de condiciones sin filtro de tenant. Cerrado; ver la fila `search-condition-sin-tenant-y-email-basic` (queda el email a nivel basic) |
| copy-kinesiologo-en-general | baja | B | users-panel, step-team, steps-catalog (placeholder), hero "Kinesiólogo asignado"; "Título (diagnóstico)" en modal/drawer de turno | 🔴 | **EV1** — copy neutral para la vertical General |
| isbasic-muerto-en-plataforma | baja | B | `biblioteca/[slug]:64` (tag Común/Pro), exercise-admin-client / exercise-drawer (toggle), `validation.ts:401` | 🔴 | **EV1** — desde EV0 el catálogo global sale del plan (PRO), no de `isBasic` |
| soporte-escribinos-sin-canal | baja | B | `components/booking/booking-unavailable.tsx`, mensajes "escribinos" | 🔴 | **EV1** — definir el email/canal de soporte |
| exercise-drawer-link-en-general | baja | B | exercise-drawer (link a `/biblioteca`) | 🔴 | **EV1** — en un tenant General el link lleva a un segmento guardado (redirige a `/dashboard`) |

**Notas:**
- `no-realtime-agenda-compartida` (C2) se adelanta: la cubre la corrida **SV** (Sala de Espera realtime, M5; antes "M3"), después de
  ES3 y SR ([VERTICALES.md §7](VERTICALES.md)).
- Cambio de comportamiento aceptado: Kine FREE/STARTER dejan de ver los ejercicios globales `isBasic` (solo PRO ve el
  catálogo de Plataforma).
- Reset de prod (07-oct): el hotfix de E0 se cae y los prechecks de datos de Planes también (PLANES.md §16).

### Hallazgos y decisiones del 08-oct (post-ES2b, antes de ES3)

Fuente: plan vigente §16 (decisiones de Martin en [PLANES.md «Estado»](PLANES.md)). Orden: ES3 ✅ (M3a) → SR ✅ (M4) → SV (M5) → ES4 → EV1.

| Slug | Sev | Bloque | Ubicación | Estado | Sesión dueña / cierre |
|---|---|---|---|---|---|
| ingresos-dashboard-solo-mp | media | B (era C0, P11) | `lib/dashboard.ts:525-619` (`getRevenue`) · `lib/dashboard-revenue.ts` · `components/dashboard/revenue-card.tsx` · `lib/bookings.ts:1549,1554,1727` | 🟢 ES3 (Ronda 18) | Sumaba **solo** los `Payment` de MP. **M3a + S14r:** MP + copagos marcados a mano por `copagoPaidAt` (sin duplicar los de MP), OS aparte por `insurerPaidAt`, selector Mes/Semana en `dashboardPrefs`; pactado de un plan CANCELLED = devengado. Re-marcar un copago u OS ya cobrado no muda la fecha de mes (P3.Z). Los copagos marcados antes de M3a quedan con fecha NULL y no cuentan (irrelevante con el reset). Quién lo ve: cerrado en SR (fila `ingresos-visibles-a-todo-rol`, SR-D5I) |
| salas-inexistentes | media | B (SR) | `lib/rooms.ts` · `lib/availability/rooms.ts` · `lib/booking-rooms-internal.ts` · M4 | 🟢 SR (Ronda 19) | **SR** (M4 `rooms`, decisión 7): salas por sede, sala por franja con vigencia (la UI ahora usa `validFrom`/`validUntil`), choque duro entre profesionales en Configuración, conflicto de sala en el turno con aviso y forzado, bloqueo de sala, vista "Por sala". [ARCHITECTURE §Salas](ARCHITECTURE.md) |
| cargo-cancelacion-tardia | baja | D | saldo del plan (`planBalance`) | 🔴 | **D**, junto con el cargo por ausencia (decisión 3): cancelar no genera cargo; hay que modelar "cargos" en el saldo para que no aparezcan como plata a favor del paciente |

### Hallazgos de ES3 (P3.Z, 08-oct-2026)

Ronda 18. Revisor (a): UI, contratos C9/C10/C13, densidad de la Secretaria, a11y y PHI. Revisor (b): server de ES3 y que
no queden puertas que salteen el motor (sin bypass: los sobrevivientes de `programs.ts` y `sessions`/`diagnosis` tienen
gate; `searchPatientsForAssignment` sí tiene caller, `components/patients/patient-picker-search.ts:27`). Todo lo 🟢 lo
cerraron los fixers F1-F3b o el integrador, con test primero, y se verificó en el archivo.

| Slug | Sev | Bloque | Ubicación | Estado | Cierre / destino |
|---|---|---|---|---|---|
| plantillas-modulo-perdido-en-retiro | **alta** | B | lib/plans-engine-internal.ts:193-200 (`validatePlanRefsInTx`) | 🟢 | F1 — al retirar `applyPlanTemplate` (que lo cortaba con `[P0-S02t] FREE no aplica`) se perdió la barrera: un consultorio FREE creaba un plan con `templateId` por RPC. Ahora `templateId` exige `canBuildTemplates` con el copy de módulo. `it.fails` dado vuelta en `tests/integration/plan-templates-authz.test.ts` |
| dosis-plantilla-fija | media | B | lib/plans-engine-internal.ts:249-277 | 🟢 | F1 — con plantilla y sin `exercises`, la dosis era 3×12 fija; ahora `defaultSets ?? 3` / `defaultReps ?? 12` del ejercicio (C8) |
| ejercicio-plantilla-archivado-mata-alta | media | B | lib/plans-engine-internal.ts:244-264 | 🟢 | F1 — un ejercicio de la plantilla archivado después rechazaba el alta entera. Los ids **de la plantilla** se filtran por asignables; solo se rechazan los que manda el cliente |
| a-medida-sin-fecha-stale | media | B | lib/plans-edit-internal.ts:370-381 (`buildAdd`) | 🟢 | F1 — "a medida" sin fecha en un plan sin horario usaba `now + 7d` con milisegundos → `stateToken` distinto entre preview y commit → stale siempre. Anclado al día AR. Test endurecido (`plans-sync-sessions.test.ts:669`) |
| remarcar-cobro-muda-fecha | baja | B | lib/bookings.ts:1549,1554 (`toggleBilling`) | 🟢 | Revisor (b) B1 + integrador — re-marcar un copago u OS ya cobrado reescribía `copagoPaidAt`/`insurerPaidAt` y el cobro se mudaba de mes en el widget. Desmarcar sigue limpiando `copagoPaidAt` |
| plantilla-colega-valida-con-actor | baja | B | lib/plan-templates.ts:505-511 (`updatePlanTemplate`) | 🟢 | F1 — un admin editando la plantilla de un colega validaba el servicio con él mismo como responsable; ahora con `cur.authorId` |
| schedulable-sin-programId | media | B | lib/plans-read-types.ts:220-233 | 🟢 | Integrador (S19c H1) + revisor (b) M1 — sin `programId` la UI adivinaba el plan por disciplina y total y elegía mal con 2 planes de la misma disciplina. La allowlist suma `programId` (un id, no PHI) |
| authorization-en-prefill-url | media | B | lib/plans-deeplink.ts:60-87 | 🟢 | F1 — el código de la autorización de la OS (texto libre) viajaba en `?prefill=`. Fuera del schema; un link viejo abre igual |
| day-lock-aviso-generico | baja | B | lib/time-blocks.ts:247 · components/agenda/day-lock/day-lock-dialog.tsx:74-108 | 🟢 | F1 + F3a — L11: `DayLockAffected.inPlan`; el aviso cuenta solo sesiones de plan y suma un chip "Plan" por fila |
| preview-index-no-ordinal | media | B | components/planes/plan-preview-table.tsx:433 | 🟢 | F2 — la columna "#" mostraba `row.index`; ahora `ordinalOf` en generar/re-planificar/agregar |
| editor-buscando-turnos-trabado | media | B | components/planes/plan-editor-drawer.tsx:367 | 🟢 | F2 — `runPreview` sin manejo de error dejaba el editor en "Buscando turnos…" con la red caída; ahora *"No pudimos revisar la agenda. Probá de nuevo."* |
| stale-loops-d7-vincular | media | B | components/planes/plan-lifecycle-dialogs.tsx:230 · components/agenda/booking-drawer/plan-row.tsx:389 | 🟢 | F2 + F3a — `PlanStatusDialog` y "Vincular a una sesión" no se recuperaban de un stale |
| resumen-general-con-planes | media | B | components/patients/profile/views/resumen-view.tsx:69-71 | 🟢 | F3b — en un consultorio General el Resumen mostraba "Plan de tratamiento" y "Diagnóstico principal" |
| eva-sin-modulo-evaluaciones | media | B | lib/patients.ts:763-765,1158-1159 · resumen-view.tsx:266-273 | 🟢 | Integrador (S22b H1/H2, enmienda EV0) — `getPatientEvaScores` → `[]` y `recordEvaScore` tira sin `evaluaciones`; la UI no monta el slot |
| drawer-plan-ux-es3 | baja | B | components/agenda/booking-drawer/index.tsx:725 · plan-row.tsx:279 · grid/booking-card.tsx:71 | 🟢 | F3a — "Cancelalo" solo en PENDING/CONFIRMED; los links de la fila Plan pasan por el dirty-guard; el conteo de Semana excluye cancelados como la leyenda; `aria-label` de la leyenda en el botón |
| perfil-seguimiento-ux-es3 | baja | B | turnos-view / facturacion-view · tabs-bar.tsx · components/seguimiento/session-detail.tsx:149 | 🟢 | F3b — tablas de Turnos/Facturación con scroll interno en mobile; pestañas del perfil como `nav` + `aria-current`; `?agendar=1` se limpia al montar |
| copy-completado-finalizado | baja | B | components/planes/plan-booking-groups.ts:193 | 🟢 | F2 — "Completado" vs "Finalizado": unificado en "Finalizado" (PLANES C13) |
| tests-titulo-no-podian-fallar | baja | B (tests) | plan-card.test · planes.test · facturacion-plan.test | 🟢 | F2 + F3b — los tests de "sin título" para la Secretaria usaban fixtures sin título; ahora con un título secreto que no tiene que aparecer |
| ingresos-visibles-a-todo-rol | baja | B (SR; era C0) | lib/dashboard-revenue.ts:152 (`revenueScopeFor`) · lib/dashboard.ts:679 | 🟢 SR (Ronda 19) | **SR-D5I** (decisión 5 de Martin): `billing.manage` ve todo el consultorio, PRACTITIONER lo suyo, la Secretaria nada (widget, KPI y picker ocultos; `getRevenue` → error sin consultar). Clave de cache con el scope; test de fuga con cache real que afirma los `keyParts`. Filtro del OWNER por profesional → C0 |
| facturacion-cancelados-con-cobro | baja | B (SR; era C0) | components/planes/plan-booking-groups.ts:242 (`isBillingVisible`) · facturacion-view.tsx | 🟢 SR (Ronda 19) | **SR-D4F** (decisión 4 de Martin): cancelados y ausentes con cobro visibles **siempre**, agrupada o no, y en "percibido" (REFUNDED/AUTHORIZED visibles) |
| programs-sobrevivientes | baja | B | lib/programs.ts (`setProgramStatus`, `deleteProgram`, `deleteSession`) | ⚪ decidido | Decisión 2 de Martin (08-oct): **se quedan** (gate `planes`, sin bypass del motor, sin callers de app); no se retiran en EV1 |
| bulk-exercises-rango-por-index | baja | C1 | lib/sessions.ts (`bulkAddSessionExercises`) | 🔴 | **C1** — el rango filtra por `index`, no por ordinal (`fromOrdinal`); `firstSinTurno` de `PlanListRow` ya no hace falta |
| recordatorio-whatsapp-sin-ordinal | baja | C1 | share-actions (WhatsApp) · `recordatorioSessionLabel` | 🔴 | **C1** — el recordatorio impreso dice "Sesión n de N"; el de WhatsApp todavía no |
| slot-cell-helpers-bundle | baja | C1 | components/agenda/grid/slot-cell.tsx | 🔴 | **C1** — separar los helpers para bajar el bundle de la agenda |
| plan-template-prefill-doble | baja | C1 | components/patients/plan-template-apply.tsx | 🔴 | **C1** — pide `getTemplatePrefill` dos veces |
| label-codigo-de-la-orden | baja | C1 | form del editor (autorización de la OS) | 🔴 | **C1** — label "Código de la orden" (F2 H3, opcional, no aplicado) |
| tabs-perfil-patron-incompleto | baja | C1 | components/patients/profile/tabs-bar.tsx | 🔴 | **C1** — hoy `nav` + `aria-current` (correcto); el patrón tabs completo con flechas queda para C1 |
| diagnosis-name-en-plandto | baja | C1 | lib/plans-read-types.ts (`PlanDTO`) · resumen-view | 🔴 | **C1** (decisión 6) — el Resumen muestra `diagnosisTitle ?? título del plan`; la condición requiere `diagnosisName` |
| renovar-autorizacion-sin-os | baja | C1 | booking-drawer (fila Plan) | 🔴 | **C1** (decisión 7) — "Renovar autorización" aparece en todo turno de plan con `plans.authorize`; C9 no dice si el plan tiene OS |
| bundle-es3-sobre-criterio | baja | C1 | `/planes` 184,5 kB · `/agenda` 202 · `/pacientes/[id]` 205 | 🔴 | **C1** — decisión 1 de Martin (08-oct): crecimiento de ES3 **aceptado**; el bundle bloqueante sigue en C1. Ver [PERF.md §ES3](PERF.md) |
| archivar-paciente-lista-sin-L9 | baja | B (ES4) | patient-row-actions · bulk-select | 🔴 | **ES4 (S32a)** — reusar `ArchivePatientDialog` + `shouldAskArchivePlans` (en bulk `livePlanCount` es null) |
| bookings-conflict-literal | baja | B | lib/bookings.ts:1075 | 🔴 | nota — el literal del conflicto → `PRACTITIONER_CONFLICT_ERROR` (`lib/bookings-constants.ts`) cuando se reabra el archivo |
| r-legacy-sin-a-medida | baja | B | motor (`addPlanSessions`) | ⚪ decidido | Decisión 3 de Martin (08-oct): un plan sin responsable/servicio no acepta "a medida" ("Plan inválido."). **Se deja** (prod se resetea) |

### Hallazgos de SR (SRZ, 08-oct-2026)

Ronda 19. Revisor (a): server (locks C2 (1b), RLS, FKs compuestas, M4, SR-D1..D8 + §17.5, plata). Revisor (b): UI densa
de la Secretaria, a11y, PHI y "sin salas = igual". Todo lo 🟢 lo cerraron los fixers (FX1 server/tests, FX2a agenda,
FX2b drawer/modal/PlanCard, FX3 editor y KPI) o el orquestador en el gate, y se verificó en el archivo.

| Slug | Sev | Bloque | Ubicación | Estado | Cierre / destino |
|---|---|---|---|---|---|
| reprogramar-plan-sala-ocupada-sin-salida | media | B | components/planes/plan-card.tsx:260-270 (`rescheduleForceFor`) | 🟢 | FX2b — el server devolvía `ROOM_BUSY_ERROR`/`ROOM_BLOCKED_ERROR` y aceptaba `allowRoomConflict`, pero la UI no ofrecía forzar. Ahora "Moverlo igual (sala ocupada)", sin decir "sobreturno" (SR-D2) |
| room-lookback-240 | media | B | lib/booking-rooms-internal.ts:23 (`ROOM_LOOKBACK_MIN`) | 🟢 | FX1 — heredaba 240 min del cupo; un turno de > 4 h de otro profesional (gimnasio) no contaba. 480 = máximo de `Service.durationMin`, solo en la carga de sala (con índice) |
| franja-vencida-sala-archivada | media | B | lib/practitioner-schedule.ts:244 (`badRoomErrors`) · editor de horarios | 🟢 | FX1 + FX3 — una franja vieja con sala archivada impedía guardar la semana; server y cliente ignoran las vencidas (`validUntil` < hoy AR) |
| dashboard-revenue-flaky-unique | baja | B (tests) | tests/integration/dashboard-revenue-scope.test.ts:90-104 | 🟢 | FX1 — 3 turnos del mismo paciente con `new Date()` chocaban con el índice único parcial en el mismo ms; ahora escalonados (los ingresos no cuentan por `scheduledFor`) |
| test-fuga-cache-sin-clave | media | B (tests) | tests/helpers/integration-setup.ts:43 · dashboard-revenue-scope.test.ts | 🟢 | FX1 — el test seguía verde si se borraba el scope de los `keyParts` (el mock armaba la clave con los argumentos). `useRealUnstableCache()` devuelve los `keyParts` y el test afirma `own:<pid>`/`tenant` (mutación detectada) |
| por-sala-asignada-interrogacion | media | B | components/agenda/agenda-client.tsx:445 (`roomPractitionerById`) | 🟢 | FX2a — "Asignada: ? 9–13" con un solo profesional o con un chip puesto; ahora con todos los profesionales |
| por-sala-ocupacion-filtrada-por-chips | media | B | components/agenda/agenda-client.tsx:551,817 | 🟢 | FX2a — con un chip, una sala ocupada por otro profesional se veía libre y la Secretaria forzaba sin saber por qué. "Por sala" no aplica el filtro de profesionales y oculta los chips |
| vigencia-visible-sin-salas | media | B | components/configuracion/panels/practitioners/schedule-editor.tsx | 🟢 | FX3 — el cliente vivo (sin salas) veía una línea más por franja; ahora solo con salas o si la franja ya tiene vigencia (nunca se esconde un dato cargado) |
| sin-sala-mezcla-sedes | media | B | components/agenda/views/room-day-panel.tsx | 🟢 | FX2a — con "Todas las sedes", "Sin sala" mostraba turnos de otras sedes; ahora filtra a la sede del alcance |
| sr-ui-bajas | baja | B | room-filter.tsx · room-row.tsx · room-day-view.tsx · agenda-client.tsx · telemedicine-section.tsx · day-lock-dialog.tsx | 🟢 | FX2a/FX2b — total de "Todas las salas"; foco del drawer y del modal; copy del vacío según capability; toggle siempre con opción marcada; "Sala archivada" en tarjetas/Recepción (`withArchivedRooms`, `components/agenda/agenda-utils.ts:253-274`); select de sala solo con salas en la sede; `aria-describedby` del error del candado |
| kpi-picker-secretaria-ingresos | baja | B | lib/preferences-constants.ts:206,217 (`kpiOptionsFor`, `pinnableKpis`) | 🟢 | FX3 — el picker le ofrecía "Ingresos del mes" a la Secretaria (fijarla dejaba la fila vacía); el PRACTITIONER ve "Tus ingresos del mes" |
| tests-conexiones-agotadas | media | B (tests) | tests/helpers/query-counter.ts:31-50 (`installQueryCounter`) | 🟢 | Gate — 2 clientes Prisma por archivo sin cerrar agotaban las 100 conexiones; singleton por proceso (pico 60) |
| dashboard-revenue-pool | media | B | lib/dashboard.ts:585,642 (`revenueAmountsInTx`, `loadRevenue`) | 🟢 | Gate — 6 tx interactivas de ingresos en paralelo con los counts → timeout de pool intermitente (riesgo real en prod). Una tx en serie; 19 → 15 tx |
| today-slot-ayer | baja | B (tests) | tests/integration/plans-sync-bookings.test.ts:74 · plans-sync-sessions | 🟢 | Gate — "una hora antes de ahora" caía ayer entre 00:00 y 01:30 AR; piso en el inicio del día AR |
| bloqueo-sala-bloquea-a-todos | media | B | lib/bookings-core.ts:534-550 (`liveBlocksInTx`) | 🟢 | Gate — un bloqueo de sala (con `practitionerId` null por CHECK) se leía como "todo el equipo" en el alta y el batch. `roomId: null` + test que falla sin el fix (§5.42) |
| copy-sala-ocupada-genero | baja | C1 | lib/bookings-constants.ts:62 (`ROOM_BUSY_ERROR`) · booking-force-flags · booking-modal-state | 🔴 | **C1** — "Sala A está ocupado/bloqueado": concordancia de género; salida neutra "Ya hay alguien en X a esa hora." |
| aviso-sala-sin-profesional | baja | C1 | outcome `room-busy` | 🔴 | **C1** — el aviso no dice con quién está ocupada ("turno con Ana Pérez"): el server no manda el profesional |
| delete-exception-sin-reaviso | baja | C1 | lib/practitioner-schedule.ts (`deleteException`) | 🔴 | **C1** — borrar un CLOSED rehabilita una plantilla con sala que puede chocar con la excepción de otro; SR-D4 dice aviso, hoy no avisa |
| golden-sin-salas | baja | C1 (tests) | tests/unit/render/agenda-client.test.tsx | 🔴 | **C1** — "sin salas = igual" compara `rooms` ausente contra `[]` con el código nuevo; la comparación contra HEAD se hizo con un test temporal. Dejar un golden fijo de las 5 vistas |
| room-filter-densidad | baja | C1 | components/agenda/room-filter.tsx | 🔴 | **C1** — con > 4 salas los chips parten el toolbar en 2 líneas; pasar a `<select>` como el fallback de profesionales |
| por-sala-filtro-sin-sala | baja | C1 | components/agenda/views/room-day-panel.tsx | 🔴 | **C1** — con el filtro "Sin sala", "Por sala" dibuja las salas vacías más "Sin sala"; mostrar solo esa columna |
| bundle-sr-sobre-criterio | baja | C1 | `/agenda` 204,5 kB · `/configuracion` 216,2 kB | 🔴 | **Decisión de Martin** (recomendado aceptar, C1) — criterio "≤ +1 kB" no cumplido; mejora concreta: `WeekDrawer` del editor de horarios con `dynamic`. [PERF.md §SR](PERF.md) |
| dashboard-counts-tx-paralelas | baja | C1 (perf) | lib/dashboard.ts:153-300 (`_loadDashboardCounts`) | 🔴 | **C1 perf** — sigue abriendo ~8 `runWithRls` en paralelo, el mismo patrón que daba timeout de pool en ingresos |
| ingresos-filtro-owner-por-profesional | baja | C0 | dashboard (widget de ingresos) | 🔴 | **C0** — el OWNER ve el total del consultorio; filtrar por profesional queda para C0 (SR-D5I) |

### Resumen del checklist (al 2026-09-29)

93 filas en total (26 confirmados + 62 menores + 5 ítems nuevos). No incluye los hallazgos de la
auditoría del 23-sep ni los de A2/A3 (tabla de arriba). *Los conteos de abajo son del 29-sep; los cierres
del 30-sep (toggles de cobro, `native-confirm-alert`, y los 🟡 de rate-limit/Sentry/`logica-en-use-server`) no
se recontaron.*

| Estado | Confirmados | Menores | Nuevos | **Total** |
|---|---|---|---|---|
| 🟢 CERRADO | 21 | 36 | 2 | **59** |
| 🟡 PARCIAL | 1 | 5 | 1 | **7** |
| ⏸ DIFERIDO-CON-GATE | 0 | 4 | 0 | **4** |
| 🔴 ABIERTO | 4 | 17 | 2 | **23** |

Confirmados que siguen 🔴 al 30-sep: `practitioner-userid-unique-blocks-multitenant` (C0),
`no-saas-billing-charge-clinic` y `plan-fields-inert-no-upgrade-no-enforcement` (C2).
`c1-ratelimit-inmemory` pasó a 🟡: el código se endureció en A3a y falta solo la env de Upstash (dueño). El
**flip prod** de `rls-bypassed-by-superuser-role` (🟢 solo en código) sigue siendo del dueño; su prerrequisito
de código (`p2002-target-null-bajo-rls`) se cerró en A2a-S06.

---

## 3. Ítems del audit anterior (2026-06-18) — CERRADOS 🟢

Verificados como resueltos en el código actual (no vuelven como findings):

- **Optimistic concurrency** (`expectedUpdatedAt`) en `lib/bookings.ts` (6 usos) — update/delete/setStatus.
- **`updateBooking` transaccional** bajo `runWithRls` (TOCTOU cerrado).
- **Coverage reads deterministas** (order by `id` desc) y `resolveInsurerName` para free-form.
- **Catches genéricos de acción loguean** (`logger.error`): createBooking, createPatient, updatePatient,
  createService, createInsurer. (El residual de M2 son solo los catches de `notifications-internal.ts`
  y `audit-extension.ts` → menor `m2-silent-catches`.)
- **Webhook MP:** firma requerida siempre que `MP_WEBHOOK_SECRET` esté seteado, prod 503 sin secret,
  replay 5 min, consumo idempotente, payload redactado.
- **Middleware** strippea `x-tenant-slug` **y** `x-tenant-id`; auth callback gatea `email_confirmed_at`
  + no re-bind (anti-takeover).
- **RLS avanzó** respecto del snapshot de junio: `patients.ts` migrado a `runWithRls` (H1 sigue
  abierto solo para sessions/exercises/conditions/services/insurers → absorbido por
  `cliente-tenant-unico-guc`).

---

## 4. Findings refutados (verificación adversarial)

- **`h1-rls-optin`** (enunciado original: "sessions/exercises/conditions/services/insurers no usan
  `runWithRls`"). **Refutado como estaba redactado**: sobre-alcanzado y con severidad inflada. Tiene
  un núcleo real (esos módulos no tienen backstop RLS) que se absorbe en `cliente-tenant-unico-guc`,
  pero el problema de fondo no es "opt-in" sino que **RLS está globalmente inerte** (§0) — cambia el
  diagnóstico, no solo el scope.
- **`h3-etapa2-stub`** (enunciado: "módulo Etapa-2 parcialmente stub"). **Refutado**: 2 de 4 síntomas
  son falsos contra el código real y la severidad alta está inflada — es un **feature-gap
  planificado**, no un bug. El residual real (falta UI de autoría condición↔ejercicio) se planifica
  como épica `guia-diagnostico-completa` (Etapa 3), no como finding de auditoría.

---

## 5. Inventario de "preservar" (patrones correctos — NO regresar en el hardening)

Estos patrones están bien hechos. Todo prompt de sesión que toque su área debe incluir el preserve
correspondiente: el riesgo mayor de sesiones chicas en paralelo es que un agente "arregle" algo que
era intencional.

1. **`lib/rls.ts`** — `runWithRls` setea `app.current_tenant_id` vía `set_config(..., true)` local a
   la transacción. No romper la semántica local-a-tx.
2. **`lib/session.ts`** — `getActor()` throws / `tryGetActor()` null; demo actor gateado por
   `KINESOFT_ALLOW_DEMO_ACTOR` + `NODE_ENV !== "production"` + tenant `movare`. No relajar el gate.
3. **`middleware.ts:109-144`** — borra `x-tenant-slug` y `x-tenant-id` de cada request y solo re-setea
   `x-tenant-slug` para `/c/<slug>` y subdominios (anti-smuggling). Preservar el orden delete-then-set.
   Desde A3b (30-sep) el mismo middleware **refresca la sesión de Supabase** (`getAll`/`setAll` +
   `getSession()`, `:69-87`), copia las cookies al request y a la respuesta, marca `private, no-store` si hubo
   Set-Cookie (`:129`) y deja pasar `/_next` y `/api/webhooks` sin tocarlos (`:99`). El strip y el
   `x-request-id` corren en **todos** los caminos, también cuando hubo refresh: no separarlos.
4. **`lib/mercadopago.ts`** — firma HMAC-SHA256 con `timingSafeEqual`, ventana de replay 5 min,
   `consumeWebhook` idempotente por `(externalId, status)`, `redactPayload` allow-list; prod 503 sin
   `MP_WEBHOOK_SECRET`. No reintroducir carve-out por `NODE_ENV` en la firma. **Desde A2b (30-sep):**
   `nextPaymentStatus` (`:184`) nunca baja un PAID salvo a REFUNDED; cada evento queda en
   `rawPayload.attempts` (redactado, últimos 20); todo corre en una tx con `SELECT … FOR UPDATE` sobre el turno
   (`:283`) + reintento como update ante P2002; solo PENDING pasa a CONFIRMED y **nunca se reactiva** un turno
   CANCELLED/NO_SHOW/COMPLETED (se registra el pago y se avisa "revisá el reembolso").
5. **`lib/copago.ts`** (re-exportado por `lib/billing-internal.ts`) — `resolveBookingCopagoCents` con precedencia estricta nullable
   (`Booking.copagoCents` → `Coverage.copagoCents` → insurer → Particular → service); 0 es
   intencional. Fuente única de copago. No duplicar el cálculo.
6. **`lib/visibility.ts`** — `patientAccessFor`/`bulkPatientAccess`; PHI **nulificado en la
   proyección**, no solo oculto en UI; sin N+1. No mover el corte de acceso a la capa de UI.
   **Enmienda ES1 (PD-13, nivel `admin`):** `AccessLevel` = `full | admin | basic | none`. Un rol sin `clinical.read`
   (ASSISTANT, BILLING) tiene **siempre exactamente** `admin` sobre todos los pacientes del tenant: nunca `full` (ni con
   "Consultorio común", share o asignación) y nunca menos (`lib/visibility.ts:138,153-155,200,249`). `admin` ve datos
   administrativos (nombre, DNI, contacto, OS/cobertura, emergencia, turnos, estado de cobro), nunca HC. **Regla:**
   todo chequeo que habilita HC o escritura clínica es `=== "full"` (o `canWriteClinical`), **nunca** `!== "basic"`:
   con `admin` la forma negativa abre de más.
7. **`lib/bookings.ts`** — `expectedUpdatedAt` (optimistic concurrency, 6 usos); mutaciones bajo
   `runWithRls`. No quitar el chequeo de `updatedAt`.
8. **`app/auth/callback/route.ts`** — linkea `Patient` solo si `email_confirmed_at` y (`userId==null`
   o ya coincide); nunca re-bindea un `Patient` ya linkeado (anti-takeover). Desde A3b tampoco vincula
   fichas a una identidad con Membership (staff ≠ paciente, `:62`).
9. **`lib/files.ts`** — `ALLOWED_MIME`, `SAFE_EXT_RE /^[a-z0-9]{1,8}$/` contra traversal,
   `getDownloadUrl` audita cada URL firmada. Mantener el audit por descarga.
10. **`lib/insurers-internal.ts`** — `resolveInsurerName` normaliza y linkea free-form al catálogo
    (server-only).
11. **`lib/datetime-ar.ts`** — helpers AR fijos UTC−3 sin DST (`localToARIso`, `toARDateKey`,
    `toARDow`, `toARHour`). **Correcto en su totalidad.** Toda lógica wall-clock debe pasar por acá.
    **Excepción a respetar:** el round-trip UTC-midnight de `dateOfBirth` (`<input type="date">`) NO
    debe recibir tz AR.
12. **`lib/*-internal.ts`** — billing/insurers/public-booking/notifications con `import "server-only"`;
    no exponerlos como RPC (`"use server"`).
13. **`lib/rate-limit.ts`** — ruta Upstash con `INCR`+`PEXPIRE NX`; desde A3a (30-sep) con try/catch +
    `AbortSignal.timeout(1500)` + validación de la respuesta, y **ante cualquier falla cae a `memory()` con log**
    `rate_limit.upstash_fallback` (un Upstash caído no rompe el login). Claves con prefijo
    `rl:<VERCEL_ENV|dev>:` (preview y prod no comparten contadores) y purga del `Map` a 10k claves. La IP sale
    **solo** de `clientIp()` (`lib/client-ip.ts`); no volver a parsear `x-forwarded-for` a mano.
14. **`lib/audit-extension.ts`** — extensión Prisma que audita reads sobre `PHI_MODELS` tras resolver
    la query. ⚠️ **Corrección 2026-09-29: NO está cableada.** `getAuditedPrisma` (`lib/db.ts:53`) no tiene
    callers, así que hoy no se audita ninguna lectura automáticamente. Activarla o no es una decisión de
    C0/C1 (costo: un INSERT por lectura de PHI).
15. **`vercel.json` + `scripts/vercel-build.mjs`** — auto-migración en deploy **solo en Production**
    (`VERCEL_ENV=production`, desde A0b) + región `gru1`; `directUrl=env("DIRECT_URL")`. No volver a
    migrar en Preview.
16. **`package.json`** — scripts `prisma:*` envueltos con `dotenv -e .env.local` (evitan el footgun de
    pegarle a Supabase prod); la operación de prod va por `db:prod:*`, que lee solo `.env.prod.local`.
    Seeds/scripts con `assertSafeTarget` (A0b). `tsconfig` strict sin `noUnusedLocals`, excluye
    `scripts`.
17. **Anticipos de diseño ya presentes** — `Booking.seriesId` poblado para regrupar series sin
    migración destructiva; enum `Role` con ASSISTANT/BILLING/ENTERPRISE mirando al futuro; schema
    100% dinero en `*Cents Int`. No revertir.
18. **`lib/booking-capacity.ts` — contrato de `isHoldingCapacity` (A2, 30-sep).** Puro, sin reloj propio
    (`now` lo pasa el caller). Deja de contar para el cupo **solo** la reserva pública impaga y vencida:
    `isPublicReservation` && `status = PENDING` && `paymentStatus ∈ {UNPAID, FAILED}` && `now - createdAt > 30 min`
    (exactamente 30 min todavía retiene). El filtro de CANCELLED es del caller. Lo consumen el motor de
    disponibilidad (`lib/availability/classify.ts`, `next-free.ts`, `slots.ts`; B-pre), create/update/batch de
    `lib/bookings.ts`, el turnero público y el webhook. **El discriminante es la
    key, no `patientId != null`:** `isPublicReservation({idempotencyKey, patientId})` (`:97`) reconoce
    `pub:<tenantId>:<uuid>` y el formato pre-A2 `<tenant>:<prof>:<ISO>:<patientId>` (último segmento = el
    `patientId` de la fila); ante la duda **retiene**. Por eso `createBooking` descarta toda key de cliente
    con prefijo `pub:`. No simplificar a "PENDING con paciente": un guest de la recepción al que se le asigna
    paciente quedaría idéntico y liberaría el cupo.
19. **`lib/safe-next.ts`** — `safeNext`/`safeNextFromUrl` aceptan solo paths propios (empieza con `/`, sin `//`,
    sin `\`, sin caracteres de control, y el origin no cambia al resolverlo contra un centinela) y `isAllowedOrigin` chequea Origin/Sec-Fetch-Site en los POST de auth. Todo `next=` de
    sign-in, sign-out, google, callback, confirm y login pasa por acá; no concatenar `${APP_URL}${next}`.
20. **`lib/recovery-cookie.ts`** — cookie `ks_recovery` httpOnly de 15 min, valor `<userId>.<exp>.<hmac>`
    firmado y verificado con `timingSafeEqual`. Solo la setea `/auth/confirm` en `type=recovery`; el reset
    (A3c) la exige para no pedir la contraseña actual y la borra tras el éxito (un solo uso). No reemplazarla por
    un flag sin firma ni alargar el TTL.
21. **`lib/supabase/cookie-options.ts`** — cookies de Supabase `httpOnly`, `secure` en prod y `sameSite=lax`.
    `lib/supabase/browser.ts` hoy no tiene importadores: si se usa para auth del lado cliente, revisar el
    httpOnly antes (el cliente no podría leer la sesión).
22. **Staff ≠ paciente (A3b)** — una identidad con Membership no se trata como paciente en el portal, el
    callback no le vincula fichas, `createInvitation` rechaza un email de Patient con portal vinculado **del
    propio tenant** (no consultar otros tenants: sería un oráculo cross-tenant) y `acceptInvite` rechaza si
    `Patient.userId = user.id` o el email es de un Patient con portal.
23. **`lib/redact.ts` + Sentry sin cliente** — logger y `beforeSend*` de Sentry pasan por `redact()`
    (claves sensibles + emails, JWT, Bearer/Basic, tokens MP, `?token=`/`code=`, DNI con formato);
    `sendDefaultPii: false`; Sentry es **no-op total sin `SENTRY_DSN`**. No agregar el SDK de cliente sin
    pasar por C1 (presupuesto de bundle).
24. **Exports solo por ruta** — `exportBookingsIcs` y `exportPatientsCsv` viven en `lib/*-export-internal.ts`
    (`server-only`); la única puerta es su ruta (`/api/agenda/export`, `/api/pacientes/export`) con rate-limit,
    tope de rango y audit. No re-exportarlos desde un `"use server"`. **Desde ES1** el ICS decide el detalle con
    `bookingFieldAccess` (acceso full **y** `clinical.read`, `lib/bookings-export-internal.ts:68-84`): no volver a
    gatear solo por nivel.
25. **Gate de onboarding (A3c)** — `app/(app)/layout.tsx` decide con `decideAppGate`
    (`lib/onboarding-logic.ts:100`, pura y testeada): sin sesión → `/login?next=` (vía `x-pathname` del
    middleware + `safeNext`), sin membresía → `/onboarding`, OWNER con `onboardingCompletedAt == null` →
    `/onboarding`. La migración backfilleó `onboardingCompletedAt = createdAt`, así que los tenants existentes
    (el cliente vivo) no ven el stepper. No mover el gate a la UI ni saltearlo para "acelerar" un alta.
26. **`lib/tenant-bootstrap.ts` es el único camino de alta de tenant** — `bootstrapTenant` crea Tenant +
    Practitioner + Membership OWNER (aceptada) + Insurer "Particular" en una tx, con slug libre derivado del
    nombre, y rechaza un Practitioner de otro tenant. Lo usan `/onboarding` (paso 2) y
    `scripts/create-tenant.ts`. El signup **no** crea tenant: no volver a crearlo ahí ni con
    `admin.createUser({ email_confirm: true })` (era H5).

27. **Motor de disponibilidad y su paridad (B-pre).** `lib/availability/*` es puro (sin DB, `now` inyectado,
    reloj por `lib/datetime-ar.ts`); el único punto de DB es `lib/availability-loader.ts`, con `db` inyectado (tx
    de `runWithRls` o `prismaService` en el turnero) y `where: { tenantId }` a mano en cada query. El contrato es
    `lib/availability/types.ts`: `classifyInstant`/`nextFreeSlot` reciben **`scheduledRanges`** (no
    `workingRanges`); `RecurrenceInput.daysOfWeek` es 0=Lun y `dow` es 0=Dom; mensual = mismo día ajustado al
    último del mes; paso 15 / 14 días; turnos cargados desde 240 min atrás. **Paridad:** con el backfill aplicado
    la salida es idéntica a la de ef3281f (`tests/unit/availability-*.test.ts` contra el oráculo congelado
    `lib/booking-schedule.ts`, más `tests/unit/public-slots.test.ts` sin cambios). Un cambio de comportamiento
    va al motor con su propio test de paridad, nunca editando el oráculo. **ES1 (aditivo, sin cambiar la paridad):**
    `patientConflictsAt` exportado desde `lib/availability/classify.ts` y `nextFreeSlot({until?})` (cota exclusiva);
    `availability-*.test.ts` y `public-slots.test.ts` siguen sin cambios. **Fallback permanente:** profesional
    sin franjas = horario del tenant lun-sáb en la sede principal; `Booking.locationId` null = principal. Sin
    cache de disponibilidad a propósito.
28. **Orden de locks en escrituras de agenda (B-pre).** Siempre **cupo → sedes (compartido) → filas**: (1)
    `lockCapacityWindow` (`lib/booking-cap-lock.ts`: `pg_advisory_xact_lock` por tenant + profesional + servicio
    + **día AR**, todos los días que toca el turno, en orden ascendente), (2) `lockTenantLocationsShared` y
    **recién después** validar la sede `where {id, tenantId, active}` (`lib/location-lock.ts`), (3) contar,
    re-chequear bloqueos y escribir, todo en la misma tx. Lo cumplen create/update/batch (`lib/bookings.ts`), el
    submit del turnero (`lib/public-booking.ts:516,546`) y `applyDayLock` (`lib/time-blocks.ts:468,608-617`,
    claves ordenadas por profesional, servicio). El batch usa una tx por fecha. No invertir el orden ni contar
    fuera de la tx (reabre el TOCTOU de cupo y abre deadlocks). **Enmienda ES2b (§5.40, ADR-004):** el invariante es
    el **orden global**, no "un turno por tx": una tx puede tomar los cupos de N turnos si los ordena
    (`lockCapacityMany`); Planes antepone `lockPlanPatient` y fija el orden de filas Booking → Session →
    TreatmentProgram. **Enmienda SR (C2 (1b), ADR-004):** la sala va entre cupo y sedes, en la misma sentencia que el
    cupo (`lockCapacityAndRoomsMany`).
29. **`Booking.isOverbooked` + prefijo `[SOBRETURNO]` hasta el contract.** `isOverbooked` es la fuente; los
    write-paths **siguen escribiendo** el prefijo en `notes` (el código viejo que convive durante el deploy y las
    notas que ve el usuario lo usan) hasta la migración contract posterior a B-pre. No dejar de escribirlo ni borrarlo de las notas existentes.
30. **Backfill de `agenda_foundations` idempotente y re-ejecutable.** Bloque entre `>>> BACKFILL
    agenda_foundations BEGIN` y `<<< … END`: `WHERE NOT EXISTS` + ids md5 determinísticos (`agenda_foundations:…`,
    los mismos que usa `lib/agenda-defaults.ts`) + `ON CONFLICT DO NOTHING`; los UPDATE de Booking filtran lo ya
    hecho y **no tocan `updatedAt`** (es el optimistic lock); `SET LOCAL row_security = off` para que un rol sin
    BYPASSRLS falle en vez de backfillear 0 filas; GUC `kinesoft.backfill_tenants` acota el alcance; sin `;`
    dentro de una sentencia (`tests/integration/agenda-backfill.test.ts` lee el bloque literal del archivo y lo
    parte por `;`). El paso 3b va **después** del 3 para no pisar PUBLIC. No editar el bloque sin re-correr ese
    test, y no cambiar los ids.
31. **Catálogo GLOBAL_READONLY.** Specialty, Practice, PracticeSpecialty, Payer y CatalogImportRun: ENABLE +
    FORCE + **solo** `FOR SELECT USING (true)`, ninguna policy de escritura (`scripts/guard-tenant-isolation.mjs`
    lo exige). PayerPlan: split (lectura global + propia, escritura propia). Escriben solo el import (conexión
    owner, verifica `rolbypassrls`) y Plataforma (`prismaService` detrás de `requireSuperAdmin`). Las actions del
    consultorio validan `payerId`/`practiceId`/`payerPlanId` (global o propio, no archivado, plan de esa
    prestadora): las FK saltean RLS. No agregar una policy de escritura "para simplificar".
32. **`curatedAt` protegido por el import.** `scripts/catalog-import.ts` / `lib/catalog/import-core.ts` nunca
    pisan una fila con `curatedAt` (solo le suman alias), no desarchivan, los `*.seed-*.csv` son create-only y
    la segunda corrida da 0 cambios. Toda edición de Plataforma marca `curatedAt`. El import no revalida el cache
    de Next: después va "Refrescar catálogo".
33. **Defaults sin fila PS/PP.** Servicio sin `PractitionerService` = habilitado y PUBLIC si
    `Service.practitionerId` es null o es ese profesional; deshabilitado si es de otro. Cobertura sin
    `PractitionerPayer` = aceptada. "Particular" siempre activa (no destildable). Las altas nuevas nacen con sus
    filas (`lib/agenda-defaults.ts`). Mismo criterio en loader, `listPractitionerServices`, turnero y
    `eligiblePractitioners`: no divergir.
34. **`NO_LOCATION_ID = ""`** (`lib/availability/types.ts:64`): id sintético de un tenant sin sede principal.
    Un TimeBlock de una sede concreta no le resta; uno global (`locationId` null) sí. Los write-paths lo
    traducen a `locationId` null. No reemplazarlo por null en el motor (las claves por sede lo necesitan).
35. **Capabilities fallan cerrado.** `capabilitiesFor` (`lib/capabilities.ts`) con rol desconocido o sin
    membresía devuelve el set vacío; la UI solo esconde y la barrera es `requireCapability` /
    `requireTenantAdmin` en cada action. ASSISTANT no tiene `clinical.read` (`listAgendaBookings` anula
    title/description/notes). No volver a chequear `role === "OWNER"` a mano. **Enmienda ES1 (E1):**
    `agenda.operateAll` (OWNER, ADMIN, ASSISTANT; positiva, sin chequeos negativos) habilita operar cualquier turno
    (crear, reprogramar, estado, cancelar) sin campos clínicos. Se consume **solo** por los predicados puros
    `canOperateBooking` = `full || agenda.operateAll` y `canWriteClinical` = `clinical.read && full`
    (`lib/capabilities.ts:182,192`), más `bookingFieldAccess` (un campo se escribe si y solo si se lee). Borrar turnos
    y cobros siguen pidiendo full. `plans.manage`/`plans.schedule`/`plans.authorize` están en la matriz y se usan desde
    ES2b (el "con full" va en la action, no en la matriz): `assertPlan*InTx` de `lib/plan-authz-internal.ts`, nunca un
    gate reimplementado.
36. **Keys de turno de plan `plan:<generationId>:<index>` (ES2b, PLANES C3).** Las escribe solo el motor
    (`commitPlanRowsInTx`), con `seriesId = generationId`. Nunca terminan en `:<ISO>:<patientId>`, así que
    `isPublicReservation(...) === false` (§5.18, con test en `plans-create.test.ts`). `createBooking` y el batch
    **rechazan** keys de cliente con `pub:` o `plan:`. Un CANCELLED conserva su key; regenerar usa otro
    `generationId`. Un reintento de alta sobre un turno adoptado devuelve éxito idempotente sin update. No reutilizar
    keys ni aceptar el prefijo desde el cliente.
37. **"Sin turno" es derivado, no una columna (ES2b, C4).** Sesión viva, no completada y sin turno con `sessionId` y
    `status ∉ {CANCELLED, NO_SHOW}`: un único predicado (`sessionWithoutActiveBookingWhere`, `lib/plan-predicates.ts`)
    que usan lecturas, Seguimiento, generar y la proyección. Cancelar o marcar Ausente un turno de plan **no toca** la
    sesión: queda "sin turno" con su cuota y su fecha. No agregar un flag ni duplicar el predicado.
38. **I8: el único escritor de `pricedByPlan = true` (y de `programId`/`sessionId`) es el motor** (ES2b, C4/C5).
    `createBooking`, el batch, el turnero y el webhook nunca escriben el vínculo (`buildBookingCreateData` no lo
    acepta). La sincronía del core solo propaga (I3, re-estampado al reactivar). `Session.priceCents` es la fuente y
    `Booking.copagoCents` su espejo; `lib/copago.ts` no cambia (§5.5). El verificador
    (`assertProgramInvariantsInTx`, I1-I8) corre al final de cada tx del motor: no sacarlo "por perf".
39. **Nada vinculado se borra (ES2b, ADR-001).** Plan y sesión se **archivan** (`archivedAt`) y se restauran;
    `deleteProgram` archiva y `deleteSession` rechaza; un turno de plan no se borra (*"cancelalo y la sesión queda sin
    turno"*); sacar del plan con cobro → rechazo. La red es la FK RESTRICT (P2003/23503) y las FKs compuestas: no
    cambiar a CASCADE ni mapear el P2003 a un borrado.
40. **Orden de locks de Planes (ES2b, ADR-004 = PLANES C2; enmienda de §5.28).** `lockPlanPatient` primero (solo
    operaciones de estructura del plan) → cupos `lockCapacityMany` (una sentencia, claves ordenadas) → sedes
    compartidas → `Booking` `FOR UPDATE` id asc → `Session` → `TreatmentProgram` (CAS al final). Seguimiento y
    `rescheduleSession` lockean el plan con `FOR NO KEY UPDATE`; el motor lockea las sesiones que escribe; un
    reintento de la tx ante P2034/40P01. No invertir Program/Session ni escribir `Session` después de un INSERT de
    `Booking` con FK al plan (era el deadlock H-a2).
41. **Forzar sala ≠ sobreturno (SR-D2).** El conflicto de sala se fuerza con su propio flag `allowRoomConflict`
    (`lib/booking-force-flags.ts:36`), que **no** toca `isOverbooked` ni escribe `[SOBRETURNO]`
    (`lib/bookings-core.ts:1395,1712`). Copy "Asignar igual" / "Agendar igual" / "Moverlo igual (sala ocupada)", nunca
    "sobreturno". No unificarlo con `allowOverbooking`: el sobreturno es del cupo del profesional; la sala, del lugar.
42. **Un bloqueo de sala nunca es "todos" (§17.5).** `TimeBlock.roomId` lleva `practitionerId` null por CHECK
    (`TimeBlock_room_scope_check`), y `practitionerId` null también significa "todo el equipo". Todo lector de
    `TimeBlock` excluye los de sala: `liveBlocksInTx` (`lib/bookings-core.ts:534-550`), el loader (`roomBlocks`
    aparte), `listTimeBlocks`, `removeDayLock` y el reuso del candado (`NOT_ROOM_BLOCK`,
    `lib/time-blocks-schemas.ts:201`). Un bloqueo de sala no cambia los slots de nadie: para la ocupación cuenta como
    sala llena. Un lector nuevo de `TimeBlock` suma el filtro (el gate de SR encontró uno que bloqueaba a todos).
43. **El mismo profesional no ocupa su sala dos veces (SR-D1).** `capacity` = profesionales a la vez; `roomOccupancyAt`
    (`lib/availability/rooms.ts:107-140`) cuenta profesionales **distintos** del que pide. Los pacientes simultáneos
    siguen en el cupo del servicio. No contar turnos: un kine con varios pacientes chocaría consigo mismo.
44. **Planes, serie y turnero no chequean sala (SR-D3).** El motor de Planes, "este y los siguientes"
    (`capLocksHeld`) y el turnero **estampan** la sala por defecto (`defaultRoomFor`; archivada → sin sala) sin contar
    ocupación ni tomar clave de sala. La barrera es la validación dura de Configuración (SR-D4). No sumarles el chequeo:
    toca C6/C7 y agrega riesgo de deadlock. `rescheduleSession` y las ediciones sueltas sí chequean.

---

## 6. Anexo — Estado de superficies para las features nuevas

Inventario factual (EXISTE-COMPLETO / EXISTE-PARCIAL / NO-EXISTE) de lo que ya hay para las 5
features grandes que el dueño sumó. Alimenta las olas 2.6-2.8 del ROADMAP.
**Revisado al 2026-08-03** contra las Rondas 1-9 (lo cerrado quedó marcado 🟢 en línea).

**A · Cuentas de paciente + Portal — EXISTE-PARCIAL**
- Invitación de **profesional** (Membership): completa (`lib/invitations.ts`, `app/invite/[token]`).
  Token válido 7 días, un solo uso (`acceptedAt`), email debe coincidir. 🟢 **Token hasheado**
  (`hashInviteToken` en `lib/invitations-tokens.ts`; la fila guarda el hash y el raw solo viaja en la
  URL — rotar el invite mintea uno nuevo porque el original es irrecuperable) — cerrado en Ronda 2.
- Invitación de **paciente** al portal: existe pero por otro mecanismo (`sendPatientPortalInvite` →
  `supabase.auth.admin.inviteUserByEmail`, sin fila `Invitation`); vínculo por email en el callback.
- **Signup self-serve de paciente: NO-EXISTE** (solo entra por Google + email pre-cargado por el kine).
- **OAuth: solo Google** (`app/api/auth/google`). Apple/Meta: NO-EXISTE.
- CRUD de miembros en panel del tenant: completo. **Reset de password admin→otro miembro: NO-EXISTE.**
- Portal actual (mobile-first, <150kB): home con próximos turnos, `/me` solo-lectura, `/c/[slug]` con
  plan activo + check-in EVA + timeline de sesiones. Auth **por email match, no por `Patient.userId`**.
  NO existe: confirmar/cancelar/reagendar, cambio de contraseña, HC visible, datos personales
  editables, historial de planes.
- **Ejercicios/guías — matiz (Ronda 7):** el **lector** existe *app-side* (`app/(app)/biblioteca/[slug]`:
  header + grid de media + markdown seguro), pero **el portal del paciente sigue sin esa sección**: no hay
  ruta equivalente bajo `(portal)` ni link desde `/c/[slug]`. Sigue siendo el diferido 2(b) de la Ronda 5.

**B · Adjuntos en booking — EXISTE-PARCIAL**
- Mensaje descriptivo: **existe** (`Booking.notes`, textarea "Motivo de consulta" en el wizard,
  `z.string().max(1000)`).
- **Upload de archivos en el wizard: NO-EXISTE.** El upload (`lib/files.ts`, 25 MB, MIME allow-list)
  es solo del lado profesional (`archivos-view.tsx`). **DICOM/.dcm NO está** en el allow-list.

**C · Timeline de HC — EXISTE-PARCIAL**
- Perfil de paciente (profesional): 9 tabs (Resumen, Turnos, Sesiones, Plan, Archivos, Antecedentes,
  Evolución/EVA, Facturación, Actividad). **No hay vista timeline cronológica unificada.**
- Notas clínicas: campo libre `Patient.notes` (no hay modelo de nota por evento). EVA: `EvaScore`.
  El único timeline cronológico vive en el **portal**, no en el perfil profesional.

**D · Tickets / owner panel / contacto — EXISTE-PARCIAL** (era "mayormente NO-EXISTE" antes de la Ronda 7)
- Sin formulario de contacto en la landing (`landing-screen.tsx` tiene copy pero ningún `<form>`).
- 🟢 **Boundaries: cerrado en Ronda 1.** Existen `app/global-error.tsx`, `app/not-found.tsx`, `error.tsx`
  por route-group (`(app)`, `(booking)`, `(portal)`) y `loading.tsx` en agenda/dashboard/pacientes. El
  residual es la **403 custom**, que quedó explícitamente diferida.
- 🟢 **Panel de plataforma: EXISTE (parcial), entregado en Rondas 7-8.** La identidad de superadmin ya no
  es tenant-scoped: `UserProfile.isPlatformAdmin` (`prisma/schema.prisma:87`) + `Actor.isPlatformAdmin` y
  `requireSuperAdmin()`/`ForbiddenError` (`lib/session.ts:196`) + `scripts/set-platform-admin.ts`. Rutas
  entregadas: `app/(app)/plataforma/layout.tsx` (guard), `plataforma/ejercicios` (tabla paginada con
  search/filtros/sort + drawer editor + media/artículo) y `plataforma/tags` (CRUD de categorías), con la
  entrada "Plataforma" del sidebar visible solo para superadmin. Las escrituras van por el canal
  `prismaService` (BYPASSRLS) detrás de `requireSuperAdmin`.
- **Lo que del bloque D sigue faltando:** modelo `Ticket`/`Report`/`Feedback` y su bandeja, formulario de
  contacto, **impersonación / vistas cross-tenant** (el panel administra el *catálogo global*, no los
  tenants), métricas de plataforma. Sin analytics (GA/Vercel). SEO parcial (`metadata` sí; sin
  `sitemap.ts`/`robots.ts`/`manifest`).

**E · Dinero — EXISTE-PARCIAL**
- Schema 100% `*Cents Int` (sin `Float`/`Decimal`). ✅
- 🟢 **Inputs con parser AR: cerrado en Ronda 2.** `parseARS` vive en `lib/format.ts:102` y los call
  sites que hacían `Number(...) * 100` ya lo usan (`configuracion/panels/services-panel.tsx`,
  `configuracion/panels/insurers-panel.tsx`, `agenda/controls.tsx`), así que `"1.500,50"` ya no produce
  `NaN`. Queda como precondición **satisfecha** del módulo contable de Etapa 3.

---

## Bottom line

El núcleo está bien construido y las áreas de riesgo son **conocidas y acotadas**. La causa raíz es
arquitectónica (RLS inerte, §0), no una lista de bugs sueltos. **Antes de abrir a clientes que
pagan:** cerrar los bugs QA de agenda (F-A2/A3/A4), anclar el pago (F-A1/F-B1), rate-limit real
(F-C1), CI + tests capa-1 (F-B9), y el checklist de corte a producción del [ROADMAP.md](ROADMAP.md).
Todo lo demás escala incrementalmente por olas.

> **Estado al 2026-08-03 (Rondas 1-9).** De esa lista de corte ya están cerrados **en código** los bugs
> QA de agenda (F-A2/A3/A4), el anclaje del pago (F-A1/F-B1) y CI + tests (F-B9). Lo que falta para el
> corte es **bucket C (config del dueño)**: env de Upstash en Vercel (F-C1) y el flip del rol de DB sin
> BYPASSRLS en Supabase (F-B3, ya listo en local). Ver §2 para el desglose fila por fila.

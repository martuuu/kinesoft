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
| plan-fields-inert-no-upgrade-no-enforcement | media | B | schema.prisma:28 | 🔴 | subscription-entitlements (Ola 2.4) |
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
| plan-startdate-utc-midnight | media | plan-view.tsx:685 · lib/patients.ts:967 | 🔴 | **REABIERTO (Ronda 11)**: diagnosis/plan-templates OK, pero la Tab Plan manda `new Date("YYYY-MM-DD")` (medianoche UTC = 21:00 AR del día anterior) y `createProgram` no usa el zod `ProgramCreate`. Destino: B0-S02 |
| ics-export-week-window-host-tz | media | agenda/export/route.ts:17 | 🟢 | tz-server-exports (Ronda 1) |

**Integridad / concurrencia (bucket A/B):**

| Slug | Sev | Ubicación | Estado | Sesión |
|---|---|---|---|---|
| conflict-findfirst-sin-orderby | media | lib/bookings.ts:301 | 🟢 | booking-concurrencia (Ronda 1) |
| batch-fuera-de-runwithrls | media | lib/bookings.ts:755 | 🟢 | Ronda 4 — `createBookingsBatch` corre bajo `runWithRls` (verificado) |
| batch-create-overlap-race-and-no-rls | media | lib/bookings.ts:734 | 🟢 | idempotencia Ronda 1 + parte RLS Ronda 4 |
| booking-paid-toggles-no-optimistic-lock | baja | lib/bookings.ts:1191,1210 | 🟢 | A2a-S06 (30-sep) — lock atómico con `updatedAt` en el WHERE; devuelven el `updatedAt` nuevo |
| mp-webhook-idempotency-check-outside-tx | baja | lib/mercadopago.ts:193 | 🟢 | payment-amount-anclado (Ronda 2) |
| session-index-no-unique-constraint | baja | schema.prisma:715 | 🔴 | soft-delete-wholesale |
| program-session-hard-delete | media | lib/patients.ts:1316 | 🟢 | patients-integridad — gate de rol (Ronda 2) |
| session-totalsessions-read-modify-write | baja | lib/patients.ts:1347 | 🟢 | patients-integridad (Ronda 2) |
| retroactive-copago-on-coverage-replace | media | lib/patients.ts:1091 | 🔴 | copago-snapshot (B, con Planes). A2a-S08 cortó la parte de pérdida: misma OS actualiza en el lugar y el copago propio solo se borra con `resetCopago` confirmado |
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
| no-realtime-agenda-compartida | media | lib/cache-tags.ts:54 | 🔴 | realtime-agenda (B4) |
| portal-auth-por-email-no-userid | media | lib/portal.ts:52 | 🔴 | portal-userid-link |
| patient-tenancy-single-home-row | baja | schema.prisma:250 | ⏸ | gate: 1er paciente en 2 tenants |
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
| portal-plan-expone-notas-de-sesion | media | C1 | lib/portal.ts:148,156,179 | 🔴 | C1 · portal v2 — `getPortalPlan` devuelve `Session.notes` del kine al paciente |
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
| statustag-fmtmoney-duplicados | baja | C1 | components/agenda | 🔴 | C1 — dos `StatusTag` y dos `fmtMoney` |
| booking-body-css-regla-muerta | baja | C | app/globals.css | 🔴 | C — regla `.booking-body` (≤1024 px) |
| turnero-texto-fijo-lun-sab | baja | C | nav del turnero público | 🔴 | C — "lun-sáb 8 a 19hs" fijo; derivar de las franjas reales |
| public-overlap-lookback-sin-uso | baja | C | lib/public-booking* | 🔴 | C — `PUBLIC_OVERLAP_LOOKBACK_MS` sin uso |
| agenda-listpatients-in-1000 | baja | C1 | app/(app)/agenda/page.tsx | 🔴 | C1 — conocido (`agenda-loads-full-patient-directory`) |
| secretaria-sin-practitioner | media | C0 | lib/session.ts:91-97 | 🔴 | C0 — `buildActor` exige fila Practitioner: una Secretaria (ASSISTANT) no puede loguearse sin una |
| catalogo-siglas-ambiguas | baja | catálogo | prisma/catalog/payers.csv (`aliases`) · lib/catalog/normalize.ts `matchKey` | 🔴 | curado en Plataforma — 37 siglas ambiguas sin alias (p. ej. OSPA no se encuentra por sigla) |
| catalogo-datos-por-verificar | baja | catálogo | prisma/catalog/payer-plans.csv · specialties.csv | 🔴 | curado — planes Sancor 1000/1500 y especialidades de Mendoza |

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
    tope de rango y audit. No re-exportarlos desde un `"use server"`.
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
    va al motor con su propio test de paridad, nunca editando el oráculo. **Fallback permanente:** profesional
    sin franjas = horario del tenant lun-sáb en la sede principal; `Booking.locationId` null = principal. Sin
    cache de disponibilidad a propósito.
28. **Orden de locks en escrituras de agenda (B-pre).** Siempre **cupo → sedes (compartido) → filas**: (1)
    `lockCapacityWindow` (`lib/booking-cap-lock.ts`: `pg_advisory_xact_lock` por tenant + profesional + servicio
    + **día AR**, todos los días que toca el turno, en orden ascendente), (2) `lockTenantLocationsShared` y
    **recién después** validar la sede `where {id, tenantId, active}` (`lib/location-lock.ts`), (3) contar,
    re-chequear bloqueos y escribir, todo en la misma tx. Lo cumplen create/update/batch (`lib/bookings.ts`), el
    submit del turnero (`lib/public-booking.ts:516,546`) y `applyDayLock` (`lib/time-blocks.ts:468,608-617`,
    claves ordenadas por profesional, servicio). El batch usa una tx por fecha. No invertir el orden ni contar
    fuera de la tx (reabre el TOCTOU de cupo y abre deadlocks).
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
    title/description/notes). No volver a chequear `role === "OWNER"` a mano.

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

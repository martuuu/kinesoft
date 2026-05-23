Sprint 16 — Audit + Plan
Hice el barrido. Pongo todo en la mesa, agrupado por foundation → feature → quality. Cuando confirmes, arranco en ese orden.

A. Performance & Cache (foundation — ataca primero)
A1. Fix getTenantPrisma (lib/db.ts:60)
Hoy crea un $extends nuevo cada call. Solución: memoize por tenantId en un Map montado en globalThis (HMR-safe en dev, single-instance en prod). Constant-time lookup.

A2. Lazy-load getPatient (lib/patients.ts:217)
La query monolítica trae coverages + emergency + programs + sessions + exercises + bookings(20) + evaScores + diagnoses en un solo find. Para un paciente con 24 sesiones × 6 ejercicios = ~150 rows hidratadas + joins. Plan:

getPatientCore(id) → patient + coverages + emergency + insurer + assigned kine (always, fast)
getPatientPrograms(id) → programs + sessions + exercises (solo tab Plan/Sesiones)
getPatientBookings(id, limit) → paginado (tab Resumen muestra los últimos 5)
getPatientEvaScores(id) → solo tab Evolución
getPatientActivity(id) → ya está lazy ✓
Server component fetches core; client triggers tab-specific fetchers via server actions con React Suspense.

A3. Cache strategy con unstable_cache + tags
Surface	Cache	TTL	Tags
listServices(tenantId)	sí	5min	services:<tenant>
listInsurers(tenantId)	sí	5min	insurers:<tenant>
listExercises(filters)	sí	5min	exercises:<tenant>
loadFilterFacets()	sí	1h	facets
getDashboardData()	sí	60s	dashboard:<tenant>:<user>
getMonthBookingDays()	sí	60s	bookings:<tenant>
loadCatalog() (diagnosis)	sí	1h	catalog
getPatient*, listBookings, getSessionsChart	NO (PHI/realtime)	—	—
revalidateTag() en cada mutation (create/update/delete) que afecte.

A4. N+1 + indexes audit
Revisar lib/dashboard.ts (10+ queries paralelas con joins)
Revisar listPatients (sort en memoria post-join)
Agregar indexes faltantes en migration nueva
A5. React cache() ya está en getActor — verificar que no se rompió post-Sprint 13
B. Patient Sharing (feature flagship — reemplaza el modelo actual)
Modelo actual
assignedPractitionerId + Tenant.sharedPatientView. Si sharedPatientView=true, todos ven todo. Si false, cada kine ve los suyos + los null ("consultorio común").

Modelo nuevo
Cada paciente SIEMPRE tiene un dueño (el kine que lo cargó). Drop la semántica "null = común".
PatientShare nuevo modelo: (tenantId, patientId, practitionerId, sharedById, sharedAt).
Tres niveles de acceso:
Owner (assignedPractitionerId == self) → full access
Shared (existe PatientShare(patientId, self)) → full access
Otros del consultorio → "basic info" (nombre, DNI, próximo turno solamente)
OWNER/ADMIN → siempre full (auditoría)
Cambios concretos
Schema migration: model PatientShare + drop default null semántico (backfill: si hay nulls, asignar al primer OWNER).
lib/visibility.ts v2: nueva fn patientAccessFor(actor, patientId) → "full" | "basic" | "none" + helper bulkPatientAccess(actor, ids[]) para listas.
getPatient: rama según access level. Retorna shape pleno o "basic" (id, fullName, documentId, nextBookingISO).
listPatients: TODOS los del tenant aparecen, marcados con access: "full" | "basic". UI muestra row truncado cuando es basic.
Agenda: bookings de pacientes "basic" → solo "Nombre · DNI" en el card, sin patientCondition.
UI nueva: <SharePatientButton> en hero del paciente. Popover pequeño (no modal) con lista de kines del consultorio + checkboxes + "Compartir / Quitar".
Server actions: sharePatientWith(patientId, practitionerIds[]) + unsharePatient(patientId, practitionerId) con audit log.
/configuracion: el switch "Vista compartida" sigue (override global), pero ahora dispara warning de "esto sobrescribe los Shares individuales".
C. Auth (Phase 4 closeout)
C1. Sign-up de profesional
Nueva ruta /signup ([app/(auth)/signup/page.tsx])
Form: nombre clínica, slug, email, password, nombre profesional, matrícula
Server action signUpPractitioner: tx que crea Supabase user (admin API) + UserProfile + Tenant + Practitioner + Membership(OWNER)
Redirect a /dashboard
C2. Forgot/Reset password
/forgot → form email → supabase.auth.resetPasswordForEmail(email, { redirectTo: /reset })
/reset → form new password → supabase.auth.updateUser({ password })
Rate-limited
C3. Email confirmation flow
Ya está el guard en auth/callback; verificar el copy del email de Supabase
D. Phase 7 medium
D1. Bulk-assign exercises a programa existente
En Biblioteca: checkbox-grid mode + barra flotante "Asignar a plan (N)"
Modal con programPicker (lista programas activos del paciente) + sessionRangePicker (todas / desde sesión X / por phase)
Server action bulkAddSessionExercises(programId, exerciseIds, distribution)
D2. Advanced filters de pacientes
Bloque expandible "Filtros avanzados" en /pacientes toolbar:
Edad: rango con dual-slider
Último Dx: select de conditions con autocompletar
Última visita: rango de fecha
listPatients recibe los filters como params
D3. Conflict banner en BookingDrawer (edit flow)
BookingDrawer hoy NO permite editar scheduledFor. Agregamos botón "Reprogramar" → form inline con datetime-local.
Wire el conflict banner de updateBooking ya existente (la lógica server está, solo falta el UI).
D4. Manual link guest booking → Patient existente (Phase 9)
Decisión: este item lo resuelve la feature de sharing + el assignPatientToPractitioner ya existente. Si un guest booking crea un Patient duplicado, el kine que lo recibe puede re-asignarlo desde el hero (ya existe). No requiere código nuevo. Lo marcamos como cubierto por implicación.

E. Quality & Hardening
E1. RLS adoption (F-3)
Migrar prisma.* calls a runWithRls(actor.tenantId, async tx => ...) en TODOS los servers actions. Big bang riesgoso → propongo 2 etapas:

Etapa 1 (este sprint): mutations + dashboard + getPatient* (paths de alto riesgo)
Etapa 2 (Sprint 17 si todo va bien): el resto
E2. Request IDs + observability
middleware.ts: generar x-request-id (UUID) si no viene
lib/request-context.ts: agregar requestId al RequestContext
lib/logger.ts: helper loggerWithRequest() que pulla reqId+tenant del ALS y los stamps automático
E3. Upstash documentation
Agregar UPSTASH_REDIS_REST_URL + TOKEN al .env.example con comentario "REQUERIDO en producción"
El código ya está listo (lib/rate-limit.ts)
E4. A11y pass general
aria-label en todos los <button> icon-only
Focus trap consistente en Modal/Drawer (ya está en Modal, verificar Drawer)
Roles correctos en menús/dropdowns custom
Contraste de texto en placeholders sky-200
E5. File splits oportunistas (donde tocamos para otra feature)
patient-profile.tsx (2366) → al tocar para sharing, splitear en <PatientHero>, <PatientTabs>, <PlanView>, <SesionesView>, <ActivityView>, <EditPatientModal> cada uno a su archivo
agenda-client.tsx (1775) → al tocar para conflict banner, sacar <BookingDrawer> + <BookingModal> a archivos propios
diagnostico-screen.tsx (1587) → no se toca este sprint, queda
E6. Adopt primitives
En cada archivo que tocamos, migrar <Field> hand-rolled → <FormField>; modal markup → <Modal>; uppercase 11px → <EyebrowLabel>
Orden de ejecución propuesto
A1 + A2 + A3 + A4 — Performance foundation (1 día). Sin este orden, todo lo demás se siente lento durante desarrollo.
B — Patient sharing (1-2 días). Es la feature de mayor valor para el usuario y bloquea visualmente al consultorio multi-kine.
D3 + D4 — Conflict banner + nota sobre manual link (4h).
C — Auth signup/forgot (medio día).
D1 + D2 — Bulk assign + advanced filters (1 día).
E1 etapa 1 — RLS en paths críticos (medio día).
E2 + E3 — Request IDs + Upstash docs (2h).
E4 + E5 + E6 — A11y + file splits + primitives (medio día, en paralelo con E1).
Roadmap update — marcar todo como done en roadmap.md + escribir docs/SPRINT_16.md.
Estimación total: ~5-7 días de trabajo concentrado. Sin schema changes solo es B (1 migration), todo lo demás es código.

Riesgos identificados
Patient sharing migration: el backfill de null → primer OWNER puede sorprender en producción si hay pacientes histórica­mente compartidos. Sugiero: backfill marca assignedPractitionerId = primer OWNER Y crea PatientShare para TODOS los demás practitioners del tenant (preserva el comportamiento "todos veían todo" cuando el tenant tenía sharedPatientView=true).
RLS adoption: cambiar prisma.x a tx.x dentro de runWithRls en mutations puede romper algún detalle de transacción si hay nested transactions. Hacer 1-2 archivos primero, correr build, luego seguir.
Cache invalidation: si me equivoco con un revalidateTag, el usuario ve data stale. Plan: TTLs cortos (60s para dashboard) como red de seguridad mientras pulimos los tags.
File splits + features simultáneas: aumenta el surface area del diff. Mitigación: hacer split como primera acción en cada archivo, commit aparte, luego trabajar la feature.

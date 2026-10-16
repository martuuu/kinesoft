# Runbook de migraciones — dev (local Docker) y prod (Supabase)

> Guía operativa para el dueño. Los comandos están listos para copiar/pegar.
> El agente **solo** aplica migraciones en LOCAL; producción la ejecuta el dueño,
> en el orden que el agente deja escrito al cerrar cada bloque.
> Reescrito en A0b/A0c (2026-09-29): **ya no se comenta/descomenta el `.env`**.

---

## Go-live con reset (07-oct-2026) — **manda sobre §2.1-§2.4 donde choquen**

> **Paso a paso con comandos, consolas y variables: [GO-LIVE-PASO-A-PASO.md](GO-LIVE-PASO-A-PASO.md)** (14-oct). Esta
> sección es la referencia técnica; si hay diferencias, manda la guía.
>
> ⚠️ **Antes del reset:** `DROP SCHEMA public` borra también la biblioteca global (ejercicios, condiciones de
> Diagnóstico, tags, regiones, media) y **no hay carga versionada** para recuperarla en prod (el seed es solo local).
> Contar qué hay y resolverlo es el paso 1 de la guía.
>
> **Decisión de Martin del 07-oct:** prod se **resetea** antes del go-live (reset total; el cliente vuelve a cargar).
> No hay datos de prod que preservar: el deploy de todo el bloque B (A + B-pre + Planes + verticales + Sala de Espera)
> es **una sola vez**, con la cadena completa de migraciones aplicada **desde vacío**. Contexto y contratos:
> [VERTICALES.md](VERTICALES.md); prechecks marcados en [PLANES.md §16](PLANES.md).
>
> **Obsoleto por el reset** (queda escrito abajo como historia, con nota en cada sección; se borra cuando el go-live
> quede hecho): el deploy incremental de §2.1-§2.4, los prechecks de datos, el dedupe de `(programId, index)`, el ensayo
> de datos en staging, el backfill de `agenda_foundations`, `normalize-patient-emails`, la ventana sin uso y el
> down-script de M1. Siguen valiendo: el precheck (0) (rol con BYPASSRLS), (17) Storage privado y el P3009 liviano.

**⚠️ Ya, independiente del reset (bloque A, AUDIT `data-api-anon-sin-rls`):** en la consola de prod, Settings → API →
Data API: si `public` está expuesto, **desactivarla** (o sacar `public` de los schemas expuestos). Precheck de solo
lectura:

```sql
SELECT relname, relrowsecurity, has_table_privilege('anon', oid, 'UPDATE')
FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r';
```

**Cadena de migraciones** (en orden de timestamp, con `migrate deploy`). **Sin reset ni staging:** el go-live del
14-oct fue incremental sobre la base viva (prod = datos demo) y desde ahí cada migración nueva se aplica **incremental**
con precheck de solo lectura → backup → `db:prod:deploy` (todas aditivas y compatibles con el código anterior, así que
pueden ir antes del deploy). Cada migración va sola, encabezando su ola, con timestamp posterior a la anterior. Orden
vigente de corridas: el de §20 del plan ([ROADMAP.md «Plan vigente (15-oct)»](ROADMAP.md)): PL (M8) → EV2 (M9) → VX →
ES4 → PF (M10) → DIR (M11). (El «reset + deploy único» del 13-oct no se hizo; queda como historia.)

| Migración | Corrida | Estado |
|---|---|---|
| … todas las anteriores (tabla de §2, #1-#12) | A, B-pre | commiteadas |
| `20261004120000_plans_booking_link` (M1) | ES2a | commiteada (`0edb0c8`); el SQL no se toca |
| `20261007120000_tenant_verticals` (**M2**) | EV0 (ola V.0, sola) | **escrita y aplicada solo en el Docker local (07-oct), commiteada (`ddfdff3`)**. sha256 de `migration.sql` = `29649aa7fb7f4c1bc25eea9e5591a630569b632295961c315c6206c653cc8bb3`. `Tenant.vertical` (enum `TenantVertical`, default `KINESIOLOGY`), `Tenant.publicBookingEnabled` (default `false`) + bloque **guardado** `REVOKE … FROM anon, authenticated` (tablas, secuencias, rutinas y default privileges; en local no hay esos roles → NOTICE + no-op). `lock_timeout` 5 s |
| `20261008120000_billing_paid_at` (**M3a**) | ES3 (P3.0.0, sola) | **escrita y aplicada solo en el Docker local (08-oct), commiteada (`ad50059`)**. sha256 de `migration.sql` = `23a785a64586b6f8c481631620253790de7287fcf17f4ca9b7836f3bd8a75474`. Aditiva, sin backfill, `lock_timeout` 5 s: `Booking.copagoPaidAt TIMESTAMP(3) NULL` (fecha del cobro manual del copago; la escribe y limpia solo `toggleBilling`/`setBookingCopagoPaid`) + `UserPreferences.dashboardPrefs JSONB NULL` (`{revenueRange: 'month'\|'week'}`) con CHECK `UserPreferences_dashboardPrefs_object_check` (objeto o NULL). Verificada objeto por objeto; `migrate status` al día (30). Sin tabla nueva ni GRANTs. Orden para prod abajo («M3a») |
| `20261009120000_rooms` (**M4**) | SR (SR0, sola) | **escrita y aplicada solo en el Docker local (08-oct), commiteada (`5811ea2`)**. sha256 de `migration.sql` = `5ab748c120edead75ed2c8334a042404d0ced9d5776ce45d793d6e74dc7b5056`. Aditiva, sin backfill, `lock_timeout` 5 s: enum `RoomKind`; tabla `Room` (RLS ENABLE + FORCE + `Room_tenant_isolation`, sin GRANT: DEFAULT PRIVILEGES; CHECKs de nombre, `capacity` 1..50 y orden); `Location_id_tenantId_key`; `roomId` nullable en `PractitionerSchedule` (NO ACTION), `Booking` (RESTRICT, CHECK `Booking_room_location_check`) y `TimeBlock` (CASCADE, CHECK `TimeBlock_room_scope_check`), con FKs compuestas `(roomId, tenantId)` y `(roomId, locationId)`; índice parcial `Room_locationId_name_active_key` (**no se borra** si `migrate dev` lo propone: drift aceptado, «SR M4: DRIFT ACEPTADO» en el SQL y en `schema.prisma`). Verificada objeto por objeto en `tests/integration/rooms-m4.test.ts` (2 roles); `migrate status` al día (31); `guard:isolation` OK. Orden para prod abajo («M4») |
| `20261013120000_reception_call_realtime` (**M5**) | SV (ola SV0, sola) | **escrita y aplicada solo en el Docker local (13-oct), commiteada (`d70513a`)**. sha256 de `migration.sql` = `bb2aac28b8cf3ec331c93e0f9b1b8cd052dc50b521095febfaa768a40b3db2af`. Aditiva, sin backfill, `lock_timeout` 5 s: `Booking.calledAt TIMESTAMP(3) NULL` (estado «Llamado» de la Sala de Espera) con CHECK `Booking_called_requires_arrived_check` (`calledAt` exige `arrivedAt`); función pura `public.kinesoft_realtime_can_read(topic text, claims jsonb)` (IMMUTABLE, STRICT, PARALLEL SAFE, INVOKER, `search_path=''`, EXECUTE a `PUBLIC`: ningún GRANT a los roles de la Data API, guard 3c verde); bloque **guardado** (marcadores `REALTIME_POLICY`) que crea la policy `kinesoft_agenda_read` FOR SELECT a `authenticated` sobre `realtime.messages` (solo `extension='broadcast'`, sin policy INSERT: ningún cliente publica). En local no existe `realtime.messages` → NOTICE + no-op (0 policies en `realtime`). CHECK, función y policy **no** están en Prisma: drift aceptado, no se borran si `migrate dev` lo propone. Verificada objeto por objeto (psql + `tests/integration/reception-call-m5.test.ts`, 2 roles, con tabla de verdad del predicado y stubs de Supabase en ROLLBACK); `migrate status` al día (32); `guard:isolation` OK. Orden para prod abajo («M5») |
| `20261014120000_identity_access` (**M6**) | IAM-1 (sola) | **escrita y aplicada solo en el Docker local (14-oct), commiteada (`972359f`)**; el SQL no se toca. sha256 de `migration.sql` = `c217390839dbf619454cc3c3aef5d0c2e484d319ce18bd1d81cadbe3baef0773`. `lock_timeout` 5 s, con prechequeo interno (marcadores `PRECHECK`) que aborta si hay pares `(tenantId, userId)` repetidos en `Practitioner`. Objetos: único `Practitioner_tenantId_userId_key`, **DROP de `Practitioner_userId_key`** (única excepción a «aditiva», aprobada por Martin el 14-oct, IAM-D2; precedente M1) e índice `Practitioner_userId_idx`; `Membership.disabledAt/disabledById` (nullables); `Invitation.revokedAt/revokedById/acceptedByUserId/lastSentAt` (nullables), `sendCount INT NOT NULL DEFAULT 0`, `priorTokens TEXT[] NOT NULL DEFAULT '{}'`; tabla `EmailLog` (tenantId nullable, FK a Tenant CASCADE, índices `(tenantId, createdAt)` y `(entity, entityId, createdAt)`, CHECK `EmailLog_status_check` sent/skipped/failed/blocked, RLS ENABLE + FORCE + `EmailLog_tenant_isolation`, sin GRANT: DEFAULT PRIVILEGES). CHECK y policy no están en Prisma: drift aceptado. Verificada objeto por objeto (psql + `tests/integration/identity-m6.test.ts` y bloque EmailLog de `rls-isolation.test.ts`, 2 roles); `migrate status` al día (33); `guard:isolation` OK. Orden para prod abajo («M6») |
| `20261015120000_platform_backoffice` (**M7**) | BO0 (sola) | **escrita y aplicada solo en el Docker local (14-oct), commiteada (`a02137e`)**; el SQL no se toca. sha256 de `migration.sql` = `ba463441be7235e4274e0e2bf30a7dde0757470b8204b6ae763d8735c625fa9a`. Aditiva, sin backfill, `lock_timeout` 5 s. Objetos: enums `TenantStatus` (ACTIVE/SUSPENDED/CLOSED) y `SupportScope` (ADMIN_CONFIG); `Tenant.status` (NOT NULL default ACTIVE), `statusChangedAt`, `statusReason`, `subscriptionStatusChangedAt`, `seatLimitOverride` (CHECK `Tenant_seatLimitOverride_check`: NULL o ≥ 1); `UserProfile.disabledAt/disabledReason`; tabla `PlatformAuditEvent` (tenantId nullable, FK a Tenant RESTRICT, único `idempotencyKey`, índices `(createdAt DESC, id)`, `(tenantId, createdAt)`, `(actorId, createdAt)`, `(targetUserId, createdAt)`, función `platform_audit_event_append_only()` + triggers `PlatformAuditEvent_append_only` (UPDATE/DELETE) y `PlatformAuditEvent_no_truncate`, RLS ENABLE + FORCE **sin policies**); tabla `SupportSession` (**sin vencimiento**, FKs a Tenant y UserProfile RESTRICT, CHECK `SupportSession_reason_check` 10-500, índice **parcial** único `SupportSession_one_open_per_superadmin`, índices `(tenantId, startedAt)` y `(superadminId, startedAt)`, RLS ENABLE + FORCE + policy `SupportSession_tenant_read` FOR SELECT); tabla `TenantSlugAlias` (PK slug, FK RESTRICT, índice por tenant, RLS ENABLE + FORCE sin policies). Sin GRANT: DEFAULT PRIVILEGES. CHECKs, parcial, triggers y RLS no están en Prisma: drift aceptado (`migrate diff` no propone nada de M7). Verificada objeto por objeto (psql + `tests/integration/platform-backoffice-m7.test.ts` y bloque «RLS plataforma» de `rls-isolation.test.ts`, 2 roles); `migrate status` al día (34); `guard:isolation` OK (categorías nuevas SERVICE_ONLY / TENANT_READONLY). Orden para prod abajo («M7») |
| `20261015180000_pl_accounts_billing` (**M8**) | PL-0 (sola) | **escrita y aplicada solo en el Docker local (15-oct), commiteada (`6b1c50d`)**. sha256 de `migration.sql` = `b9953128eff790f5b010f51f2a578a610dd6b3e75af63c6403c0449314916658`. Aditiva (expand), una tx, `lock_timeout` 5 s, con backfill en la misma tx (sin tocar `updatedAt`). Objetos: enums `SaasPlan` (INDIVIDUAL/CONSULTORIO/CLINICA/LIBRE), `SaasChargeStatus`, `SaasPaymentSource`, `SaasPaymentStatus`, `SupportThreadKind`, `SupportThreadStatus`, `SupportAuthorKind`, `TwoFactorPurpose`; `Tenant.saasPlan` (NOT NULL default INDIVIDUAL; backfill FREE→INDIVIDUAL, STARTER→CONSULTORIO, PRO→CLINICA, ENTERPRISE→LIBRE) + `maxUsersOverride` (CHECK ≥ 1) / `maxProfessionalsOverride` (≥ 0, backfill = `seatLimitOverride`) / `maxStaffOverride` (≥ 0); `Membership.clinical` (default true; backfill ASSISTANT/BILLING false), `grantSettings` (backfill ADMIN true), `grantBilling`, `disabledReason` (CHECK MANUAL/PLAN_DOWNGRADE/PLATFORM; backfill MANUAL donde `disabledAt` no es NULL); `Practitioner.publicBookingEnabled` (default **false**, backfill **true** a todos los existentes, decisión 20); `UserProfile.twoFactorEmail/twoFactorTotp/twoFactorUpdatedAt`; `SaasPlanConfig` (PK plan, 4 filas, precios NULL; **GLOBAL_READONLY**); `SaasPlanPriceChange` (FK a SaasPlanConfig, trigger `SaasPlanPriceChange_guard` solo inserción salvo `appliedAt` NULL→valor + `_no_truncate`; **SERVICE_ONLY**); `SaasSubscription` (PK tenantId), `SaasCharge` (únicos `(tenantId, periodStart)` e `(id, tenantId)`), `SaasPayment` (FK compuesta `(chargeId, tenantId)`, únicos `mpPaymentId` y `mpAuthorizedPaymentId`, CHECKs de origen MP/MANUAL y de comprobante) — las tres **TENANT_READONLY**, FKs a Tenant RESTRICT; `SupportThread` (CHECKs de kind/lead y asunto 1..200, único `(id, tenantId)`, policies SELECT por tenant + INSERT solo `kind='TENANT'`), `SupportMessage` (cuerpo 1..5000, CHECK de autor, FK simple al hilo + compuesta `(threadId, tenantId)`, policies SELECT + INSERT solo `authorKind='TENANT'`), `SupportThreadRead` (marca de leído por usuario, `_tenant_isolation`); `TwoFactorChallenge` (índice **parcial** único `TwoFactorChallenge_one_open` `(userId, purpose, sessionId) WHERE closedAt IS NULL`), `TwoFactorRecoveryCode`, `UserSecurityEvent` (triggers `_append_only` y `_no_truncate` con `kinesoft_append_only()`) — **SERVICE_ONLY**. Sin GRANT: DEFAULT PRIVILEGES. CHECKs, parcial, funciones, triggers y RLS no están en Prisma: drift aceptado (`migrate diff` no propone nada de M8). Verificada objeto por objeto (psql + `tests/integration/pl-m8.test.ts`, 2 roles); `migrate status` al día (35); `guard:isolation` OK. Orden para prod abajo («M8») |
| `20261015200000_pl_admin_consultorio` (**M8b**) | PL-2 (inicio, sola) | **escrita y aplicada solo en el Docker local (15-oct), commiteada (`74642cf`)**. sha256 de `migration.sql` = `6c0c816f1539c5915a59df59fc1e6f5823a8b3891c37e555796b86cbba41d551`. **Solo datos** (sin DDL, el schema de Prisma no cambia), una tx, `lock_timeout` 5 s, idempotente, sin tocar `updatedAt`. Decisiones de Martin §20.17: (1) `SaasPlanConfig` CONSULTORIO → `maxProfessionals`/`maxStaff` NULL («5 usuarios de cualquier tipo»; `maxUsers` 5 no se toca); (2) ADMIN `clinical = true` con `Practitioner` en ese consultorio y agenda en uso (≥ 1 turno futuro PENDING/CONFIRMED, paciente asignado sin archivar o plan ACTIVE sin archivar a cargo: el criterio de `countPractitionerLoad` + `countActivePlansAsResponsible`) → `PRACTITIONER` + `clinical` + `grantSettings`; (3) el resto de los ADMIN → `clinical = false` («el Administrador/a nunca atiende»). No borra `Practitioner`. Verificada con psql (fila 5/–/–, `migrate status` al día: 36) y `tests/integration/pl-m8b.test.ts` (UPDATEs del SQL real en ROLLBACK, 2 roles). Orden para prod abajo («M8b») |
| `20261016120000_saas_payment_method` (**M8c**) | PL-F0 (sola) | **commiteada en `cb99c06`, aplicada solo en el Docker local (16-oct)**. sha256 de `migration.sql` = `273abbe33484e5be2fec08523ff3124899b076967031de268ac6b9323d640e0f`. Decisión de Martin (16-oct): el medio de pago de la suscripción va en columna propia, no en la nota. Aditiva, una tx, `lock_timeout` 5 s: enum nuevo `SaasPaymentMethod` (TRANSFER/CASH/CARD/WALLET/MERCADO_PAGO/OTHER) + `SaasPayment.method` NULL sin default (NULL = sin informar; sin backfill desde `note`; sin CHECK contra `source` para no romper el código viejo en la ventana de deploy). RLS, CHECKs, FKs e índices de `SaasPayment` sin cambios. Verificada con psql (columna `SaasPaymentMethod` nullable sin default, 6 valores en orden, RLS/FORCE + 1 policy SELECT, 4 CHECKs, `migrate status` al día: 37) y `tests/integration/pl-m8c.test.ts` (2 roles). Orden para prod abajo («M8c») |
| `20261017120000_clinical_notes` (**M9**) | EV2-0 (sola) | **commiteada (`8e3e9f6`), aplicada solo en el Docker local; re-verificada objeto por objeto en EV2-Z (5 triggers, 9 FKs, parcial, RLS ENABLE+FORCE, 2 policies)**. sha256 de `migration.sql` = `755ae1891bc3a989685bc37e4c4ba6903b23076889ac2d67f013d3730284fa3b`. Decisión 13 de Martin (evoluciones por consulta para todas las verticales; Ley 26.529: la inalterabilidad va en la base porque prod conecta con BYPASSRLS). Aditiva (expand), una tx, `lock_timeout` 5 s, sin backfill, sin ALTER de columnas existentes. Objetos: enum `ClinicalNoteKind` (EVOLUTION/FIRST_VISIT/DISCHARGE); únicos nuevos sobre tablas existentes `Booking_id_tenantId_patientId_key` y `Practitioner_id_tenantId_key` (destinos de FK compuesta; sobre `id`, no fallan por datos); tabla `ClinicalNote` (turno opcional, enmienda `amendsNoteId`, autor congelado, `revision`, anulación con motivo 3..500 todo-o-nada, `idempotencyKey` 8..100 única por consultorio; 9 FKs RESTRICT: 4 simples + 5 compuestas `(patientId, tenantId)`, `(bookingId, tenantId, patientId)`, `(authorPractitionerId, tenantId)`, `(amendsNoteId, tenantId, patientId)` y la de la revisión; índice **parcial** único `ClinicalNote_bookingId_live_key` = una raíz viva por turno; keyset `(tenantId, patientId, occurredAt DESC, id DESC)`); tabla `ClinicalNoteRevision` (versión anterior de cada edición, única `(noteId, revision)`); funciones `clinical_note_guard()` y `clinical_note_revision_insert_guard()` (`search_path` fijo, INVOKER) + 5 triggers: DELETE/TRUNCATE de la nota rechazados **también para el owner**, identidad inmutable, anulada = congelada, editar contenido solo dentro de 24 h 10 min y copia la versión anterior, la revisión solo nace del trigger y es solo inserción (`kinesoft_append_only()` de M8). RLS ENABLE + FORCE + `<T>_tenant_isolation` en las 2 tablas; sin GRANT (DEFAULT PRIVILEGES). Consecuencia buscada: un turno con evolución no se borra ni cambia de paciente (23503; la app lo traduce en EV2-2c). Parcial, FKs compuestas, CHECKs, funciones, triggers y policies no están en Prisma: drift aceptado («EV2 M9: DRIFT ACEPTADO» en el SQL y en `schema.prisma`; `migrate diff` solo propone borrar las 5 FKs compuestas, como las de M1/M4). Verificada objeto por objeto (psql + `tests/integration/clinical-notes-m9.test.ts`, 2 roles); `migrate status` al día (38); `guard:isolation` OK. Orden para prod abajo («M9») |
| `20261018120000_perf_fk_indexes` (**M10**) | PF-M (sola) | **escrita y aplicada solo en el Docker local (16-oct), sin commitear**. sha256 de `migration.sql` = `807a05097f9f021e0d6122b11f53a43fe0ac5fcbedb97e22383ca249cfda26c3`. Aditiva: solo 13 `CREATE INDEX IF NOT EXISTS` btree de una columna, sin `WHERE`, sin `UNIQUE`, sin backfill, una tx, `lock_timeout` 5 s, sin `CONCURRENTLY` (Prisma corre la migración en una tx; tablas chicas). Objetos: `Coverage_patientId_idx`, `EmergencyContact_patientId_idx`, `Patient_userId_idx`, `PatientTenantLink_tenantId_idx`, `Service_tenantId_idx`, `Service_practitionerId_idx`, `Session_practitionerId_idx`, `SessionExercise_exerciseId_idx`, `Booking_serviceId_idx`, `Favorite_exerciseId_idx`, `ExerciseTag_tagId_idx`, `ConditionTag_tagId_idx`, `Condition_createdById_idx`. Todos declarados en `schema.prisma` con `@@index` (mismo nombre): **sin drift nuevo** (`migrate diff` solo sigue proponiendo borrar las FKs compuestas aceptadas de M1/M4/M9). Verificada objeto por objeto (13 filas `USING btree (<col>)` en `pg_indexes`, `indisvalid`/`indisready`, sin predicado; la query de FKs sin índice pasó de 47 a 34 filas); `migrate status` al día (39); integración completa en los 2 roles. Orden para prod abajo («M10») |
| `20261019120000_public_directory` (**M11**) | DIR-1 (sola) | **aplicada solo en el Docker local (16-oct)**. sha256 `a35fdd6b3f5fe8a9b4b9bbf8fcebb0cff8a82031a9721ddfca171c6af067177d`. Aditiva: 6 columnas en `Tenant` (`directoryListed` default false, `directoryListedAt`, `directoryHiddenAt/Reason/ById`, `publicDescription`), `Location.provinceCode` y la tabla `ProfessionalPublicProfile` (por persona, `userId` único, FK CASCADE). 11 CHECK (los de matrícula/ocultamiento con `COALESCE`), trigger que des-verifica la matrícula, RLS **SERVICE_ONLY** (ENABLE + FORCE, 0 policies). Drift aceptado: CHECK, función, trigger, ENABLE/FORCE. Verificada objeto por objeto; `migrate status` al día (40); integración completa en los 2 roles. Orden: «M11 en prod» |
| `<ts>_public_directory` (**M11**) | DIR-1 (sola) | **pendiente, se escribe en su ola** (§20.10). Aditiva: `Tenant.directoryListed*`, `publicDescription`, `ProfessionalPublicProfile` (RLS); `DIRECTORY_MODE=off` por default |

**M3a en prod (ES3).** Prod se resetea antes del go-live (plan §15.6), así que M3a **no se aplica sola**: va dentro de la
cadena completa del deploy único de B (`migrate deploy` desde vacío, paso 4 de abajo). Solo si Martin decidiera
aplicarla **antes** del reset, el orden es:
1. Precheck de solo lectura (las 2 columnas no existen todavía; tiene que dar 0 filas):
   ```sql
   SELECT to_regclass('"Booking"') IS NOT NULL AS booking_ok;
   SELECT table_name, column_name FROM information_schema.columns
   WHERE table_schema = 'public'
     AND ((table_name = 'Booking' AND column_name = 'copagoPaidAt')
       OR (table_name = 'UserPreferences' AND column_name = 'dashboardPrefs'));
   ```
2. Backup (`npm run db:prod:backup`).
3. Staging primero.
4. Prod con el merge. Es aditiva, así que puede ir **antes** que el código (el código viejo no lee las columnas). Sin
   backfill: los copagos ya cobrados quedan con `copagoPaidAt` NULL y el widget no los cuenta.

**M4 en prod (SR).** Igual que M3a: **no se aplica sola**, va en la cadena del deploy único después de M3a y antes de
M5. Solo si Martin decidiera aplicarla **antes** del reset:
1. Precheck de solo lectura (la tabla no existe todavía; tiene que dar NULL):
   ```sql
   SELECT to_regclass('public."Room"');
   ```
2. Backup (`npm run db:prod:backup`).
3. Staging primero. Después de migrar, confirmar que los roles reciben los privilegios por DEFAULT PRIVILEGES (M4 no
   tiene GRANT): `SELECT has_table_privilege('kinesoft_app','"Room"','SELECT,INSERT,UPDATE');` → `t`, y lo mismo con
   `kinesoft_service` si existe.
4. Prod en horario de poco uso: `CREATE INDEX "Booking_tenantId_roomId_scheduledFor_idx"` **no es CONCURRENTLY** (frena
   escrituras en `Booking` mientras se construye) y los `ALTER`/`ADD CONSTRAINT` sobre Booking, PractitionerSchedule y
   TimeBlock toman lock exclusivo hasta el COMMIT; con `lock_timeout` 5 s falla rápido (P3009 liviano) en vez de
   colgar la agenda. Es aditiva: puede ir **antes** que el código (el código viejo no lee `roomId`).

**M5 en prod (SV).** Igual que M3a y M4: **no se aplica sola**, va en la cadena única del deploy desde vacío
(`… → M3a → M4 → M5`). Solo si Martin decidiera aplicarla **antes** del reset:
1. Precheck de solo lectura:
   ```sql
   -- la columna no existe todavía: 0 filas
   SELECT column_name FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'Booking' AND column_name = 'calledAt';
   -- R1: existe realtime.messages (esperado: true; relkind 'p', relrowsecurity true)
   SELECT to_regclass('realtime.messages') IS NOT NULL AS realtime_messages;
   SELECT c.relkind, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'realtime' AND c.relname = 'messages';
   -- R2: ninguna policy abierta en realtime (antes de M5: 0 filas)
   SELECT policyname, cmd, roles, qual, with_check FROM pg_policies WHERE schemaname = 'realtime';
   ```
2. Backup (`npm run db:prod:backup`).
3. Staging primero. Después de migrar: R2 da **1 fila** `kinesoft_agenda_read | SELECT | {authenticated}` sin
   `with_check`; en el log del deploy **no** tiene que aparecer el NOTICE `reception_call_realtime: no existe
   realtime.messages` (en Supabase la tabla existe: si aparece, la policy no se creó y el canal privado no entrega nada).
4. Prod: es aditiva, puede ir **antes** que el código (el código viejo no lee `calledAt`). `ALTER TABLE "Booking"` toma
   lock exclusivo hasta el COMMIT; con `lock_timeout` 5 s falla rápido (P3009 liviano).

**M6 en prod (IAM-1).** Prod conserva sus datos (decisiones del 14-oct: sin reset y sin staging), así que M6 se aplica
sobre la base viva:
1. Precheck de solo lectura:
   ```sql
   -- tiene que dar 0 filas (si no, la migración aborta con «identity_access: hay N par(es)…»)
   SELECT "tenantId", "userId", count(*) FROM "Practitioner" GROUP BY 1, 2 HAVING count(*) > 1;
   -- todavía no aplicada: el único global existe (1 fila) y EmailLog no (NULL)
   SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'Practitioner_userId_key';
   SELECT to_regclass('public."EmailLog"');
   ```
2. Backup (`npm run db:prod:backup`).
3. `npm run db:prod:deploy` y `npm run db:prod:status` → "Database schema is up to date!" (sin staging).
4. Verificación objeto por objeto (solo lectura):
   ```sql
   SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'Practitioner' ORDER BY 1;
   --   Practitioner_tenantId_userId_key (UNIQUE tenantId,userId) y Practitioner_userId_idx; NO Practitioner_userId_key
   SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('Membership','Invitation')
      AND column_name IN ('disabledAt','disabledById','revokedAt','revokedById','acceptedByUserId','lastSentAt','sendCount','priorTokens');
   --   8 filas; sendCount NOT NULL default 0, priorTokens NOT NULL default ARRAY[]::text[]
   SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public."EmailLog"'::regclass;   -- t | t
   SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'EmailLog';    -- EmailLog_tenant_isolation | ALL
   SELECT conname FROM pg_constraint WHERE conrelid = 'public."EmailLog"'::regclass ORDER BY 1;
   --   EmailLog_pkey, EmailLog_status_check, EmailLog_tenantId_fkey
   SELECT has_table_privilege('kinesoft_app', '"EmailLog"', 'SELECT,INSERT');                         -- t (DEFAULT PRIVILEGES)
   SELECT grantee FROM information_schema.role_table_grants
    WHERE table_name = 'EmailLog' AND grantee IN ('anon', 'authenticated');                             -- 0 filas
   ```
   Repetir `has_table_privilege` con `kinesoft_service` si existe.
4b. **Prechecks del código de IAM (antes del deploy, solo lectura).** No bloquean la migración; deciden qué avisarle a
   cada consultorio:
   ```sql
   -- (a) Turnos FUTUROS activos de Secretaria/Facturación. Desde IAM-2e/4b no son reservables: esos turnos siguen en la
   --     agenda (columna «Otros (sin agenda)» en «Día por profesional») y se pueden cancelar, pero no reprogramar.
   --     Reasignarlos a un profesional antes o después del deploy.
   SELECT m."tenantId", m.role, p.id AS "practitionerId", count(*) AS turnos_futuros
     FROM "Booking" b
     JOIN "Practitioner" p ON p.id = b."practitionerId"
     JOIN "Membership" m ON m."tenantId" = b."tenantId" AND m."userId" = p."userId"
    WHERE m.role IN ('ASSISTANT', 'BILLING')
      AND b."scheduledFor" > now()
      AND b.status IN ('PENDING', 'CONFIRMED')
    GROUP BY 1, 2, 3 ORDER BY 4 DESC;
   -- (b) Pacientes asignados a la fila Practitioner vieja de una Secretaria/Facturación: desde IAM-4a ella tiene
   --     `practitionerId` null y no los «posee»; quedan en acceso admin salvo para OWNER/ADMIN. Reasignarlos.
   SELECT m."tenantId", m.role, count(*) AS pacientes
     FROM "Patient" pa
     JOIN "Practitioner" p ON p.id = pa."assignedPractitionerId"
     JOIN "Membership" m ON m."tenantId" = pa."tenantId" AND m."userId" = p."userId"
    WHERE m.role IN ('ASSISTANT', 'BILLING')
    GROUP BY 1, 2;
   -- (c) Slugs reservados desde IAM-3a (rutas nuevas /sin-acceso y /elegir-consultorio). Tiene que dar 0 filas;
   --     si no, cambiar ese slug antes del deploy (quedaron reservados en `lib/onboarding-logic.ts:26-28`).
   SELECT id, slug FROM "Tenant" WHERE slug IN ('sin-acceso', 'elegir-consultorio');
   ```
   Después del deploy: los usuarios con 2+ consultorios ven «¿A qué consultorio querés entrar?» una vez al volver a
   entrar. Configuración de consola (Resend, Site URL, Redirect URLs) en [EXTERNAL-CONFIG.md §0.4](EXTERNAL-CONFIG.md).
5. **Antes o después del código:** puede ir **antes**. Es compatible hacia atrás: las columnas y la tabla nuevas el
   código viejo no las lee, y el DROP solo relaja la unicidad. El código viejo busca el Practitioner del usuario con
   `findUnique({ userId })` (en SQL `WHERE "userId" = $1 LIMIT 1`, no depende del índice) y nunca crea un segundo
   Practitioner para el mismo usuario (lo chequea antes: `bootstrapTenant` y `acceptInvite` viejos), así que no
   aparecen duplicados hasta que llega el código nuevo. Lo único que se pierde en la ventana entre migración y deploy:
   la red de la base contra dos altas simultáneas del paso 2 del onboarding del mismo usuario (el código nuevo la
   reemplaza con un advisory lock por usuario). Recomendado: migrar y deployar el mismo día; si se mergea a `main`
   sin aplicarla a mano, el build de Production la aplica antes de servir. `DROP INDEX` toma lock exclusivo sobre
   `Practitioner` hasta el COMMIT (milisegundos; `lock_timeout` 5 s → P3009 liviano si estuviera tomada).

**M7 en prod (BO0).** Igual que M6: prod conserva sus datos, sin reset y **sin staging**.
1. Precheck de solo lectura:
   ```sql
   -- todavía no aplicada: la primera da NULL | NULL | NULL y la segunda 0 filas
   SELECT to_regclass('public."PlatformAuditEvent"'), to_regclass('public."SupportSession"'), to_regclass('public."TenantSlugAlias"');
   SELECT typname FROM pg_type WHERE typname IN ('TenantStatus', 'SupportScope');
   -- M6 ya aplicada (M7 va después): 1 fila
   SELECT migration_name FROM _prisma_migrations WHERE migration_name = '20261014120000_identity_access' AND finished_at IS NOT NULL;
   ```
2. Backup (`npm run db:prod:backup`).
3. `npm run db:prod:deploy` y `npm run db:prod:status` → "Database schema is up to date!".
4. Verificación objeto por objeto (solo lectura):
   ```sql
   SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND ((table_name = 'Tenant' AND column_name IN ('status','statusChangedAt','statusReason','subscriptionStatusChangedAt','seatLimitOverride'))
      OR (table_name = 'UserProfile' AND column_name IN ('disabledAt','disabledReason')));
   --   7 filas; status NOT NULL default 'ACTIVE'::"TenantStatus", el resto nullable sin default
   SELECT count(*) FROM "Tenant" WHERE status <> 'ACTIVE';                                              -- 0
   SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
    WHERE relname IN ('PlatformAuditEvent','SupportSession','TenantSlugAlias');                         -- 3 filas t | t
   SELECT tablename, policyname, cmd FROM pg_policies
    WHERE tablename IN ('PlatformAuditEvent','SupportSession','TenantSlugAlias');                       -- 1 fila: SupportSession_tenant_read | SELECT
   SELECT tgname, tgenabled FROM pg_trigger
    WHERE tgrelid = 'public."PlatformAuditEvent"'::regclass AND NOT tgisinternal;                       -- _append_only y _no_truncate, O
   SELECT indexname FROM pg_indexes WHERE indexname = 'SupportSession_one_open_per_superadmin';         -- 1 fila
   SELECT conname FROM pg_constraint WHERE conname IN ('Tenant_seatLimitOverride_check','SupportSession_reason_check'); -- 2 filas
   SELECT grantee FROM information_schema.role_table_grants
    WHERE table_name IN ('PlatformAuditEvent','SupportSession','TenantSlugAlias') AND grantee IN ('anon','authenticated'); -- 0 filas
   ```
   Repetir `has_table_privilege('kinesoft_app'|'kinesoft_service', …, 'SELECT,INSERT')` si esos roles existen (t).
5. **Antes o después del código:** puede ir **antes** (y es lo recomendado: el código de BO1+ lee las columnas nuevas).
   Compatible hacia atrás: el código viejo no lee ni escribe nada nuevo (Prisma solo selecciona las columnas que
   conoce; `status` nace ACTIVE en todos). Los `ALTER TABLE` toman lock exclusivo sobre `Tenant` y `UserProfile` hasta
   el COMMIT (milisegundos, sin rewrite; `lock_timeout` 5 s → P3009 liviano si estuvieran tomadas).
6. **No se puede limpiar a mano** `PlatformAuditEvent`: el trigger rechaza UPDATE/DELETE/TRUNCATE también al owner, y
   las FKs RESTRICT impiden borrar un consultorio con registro de plataforma, alias o sesiones de soporte (la baja es
   `status = CLOSED`). Es a propósito.

**M8 en prod (PL-0).** Igual que M6/M7: prod conserva sus datos, sin reset y **sin staging**. Va **el mismo día que el
deploy de PL-1** (no antes con días de margen): entre M8 y ese deploy, un cambio de plan hecho por el código viejo no se
refleja en `saasPlan`, y un profesional creado por el código viejo nace con `publicBookingEnabled = false` (fuera del
turnero). El postcheck (paso 4) lo detecta.
1. Precheck de solo lectura (anotar los resultados):
   ```sql
   -- (a) todavía no aplicada: NULL | NULL | NULL y 0 filas; M7 ya aplicada: 1 fila
   SELECT to_regclass('public."SaasPlanConfig"'), to_regclass('public."SaasPayment"'), to_regclass('public."TwoFactorChallenge"');
   SELECT typname FROM pg_type WHERE typname IN ('SaasPlan','TwoFactorPurpose');
   SELECT migration_name FROM _prisma_migrations WHERE migration_name = '20261015120000_platform_backoffice' AND finished_at IS NOT NULL;
   -- (b) distribución de planes y estados (lo que va a quedar en saasPlan: FREE→INDIVIDUAL, STARTER→CONSULTORIO,
   --     PRO→CLINICA, ENTERPRISE→LIBRE)
   SELECT plan, "subscriptionStatus", count(*) FROM "Tenant" GROUP BY 1, 2 ORDER BY 1, 2;
   -- (c) consultorios que USAN salas o la sala de espera («Llamar») y que con el plan mapeado quedarían SIN Clínica
   --     (PL-D6/PL-D7: las salas «duermen», la sala de espera se oculta). Martin los sube a Clínica/Libre desde
   --     /plataforma después del deploy de PL-1 (o decide dejarlos).
   SELECT t.id, t.name, t.plan,
          (SELECT count(*) FROM "Room" r WHERE r."tenantId" = t.id AND r.active) AS salas_activas,
          (SELECT count(*) FROM "Booking" b WHERE b."tenantId" = t.id AND b."roomId" IS NOT NULL) AS turnos_con_sala,
          (SELECT count(*) FROM "Booking" b WHERE b."tenantId" = t.id AND b."calledAt" IS NOT NULL) AS turnos_llamados
     FROM "Tenant" t
    WHERE t.plan IN ('FREE', 'STARTER')
      AND (EXISTS (SELECT 1 FROM "Room" r WHERE r."tenantId" = t.id AND r.active)
        OR EXISTS (SELECT 1 FROM "Booking" b WHERE b."tenantId" = t.id AND (b."roomId" IS NOT NULL OR b."calledAt" IS NOT NULL)));
   -- (d) membresías activas por rol vs los límites nuevos (Individual 1 · Consultorio 5 = ≤4 clínicos + ≤1 no clínico ·
   --     Clínica 10). Excederse NO saca a nadie (M8 no deshabilita); solo frena invitar/subir. Revisar el cliente vivo.
   SELECT t.id, t.name, t.plan,
          count(*) FILTER (WHERE m.role IN ('OWNER','ADMIN','PRACTITIONER')) AS clinicos,
          count(*) FILTER (WHERE m.role IN ('ASSISTANT','BILLING')) AS no_clinicos,
          count(*) AS total
     FROM "Tenant" t JOIN "Membership" m ON m."tenantId" = t.id AND m."disabledAt" IS NULL
    GROUP BY t.id, t.name, t.plan ORDER BY total DESC;
   -- (e) overrides a medida que pasan a maxProfessionalsOverride
   SELECT id, name, plan, "seatLimitOverride" FROM "Tenant" WHERE "seatLimitOverride" IS NOT NULL;
   -- (f) membresías deshabilitadas (quedan con disabledReason = 'MANUAL') y profesionales (quedan en el turnero)
   SELECT count(*) FROM "Membership" WHERE "disabledAt" IS NOT NULL;
   SELECT count(*) FROM "Practitioner";
   ```
2. Backup (`npm run db:prod:backup`).
3. `npm run db:prod:deploy` y `npm run db:prod:status` → "Database schema is up to date!". Inmediatamente después,
   **M8b** (abajo) y recién ahí el deploy de PL (merge a `main`; si se mergea sin aplicarlas a mano, el build de
   Production aplica M8 y M8b, en ese orden, antes de servir).
4. Postcheck (solo lectura):
   ```sql
   -- backfill: 0 filas incoherentes en las tres
   SELECT count(*) FROM "Tenant" WHERE "saasPlan"::text <> CASE plan WHEN 'FREE' THEN 'INDIVIDUAL' WHEN 'STARTER' THEN 'CONSULTORIO'
     WHEN 'PRO' THEN 'CLINICA' WHEN 'ENTERPRISE' THEN 'LIBRE' END;                                          -- 0 (antes del deploy de PL-1)
   SELECT count(*) FROM "Tenant" WHERE "seatLimitOverride" IS DISTINCT FROM "maxProfessionalsOverride";     -- 0
   SELECT role, clinical, "grantSettings", count(*) FROM "Membership" GROUP BY 1, 2, 3 ORDER BY 1;
   --   ASSISTANT/BILLING → clinical f; ADMIN → grantSettings t; el resto clinical t, grantSettings f
   SELECT count(*) FROM "Membership" WHERE "disabledAt" IS NOT NULL AND "disabledReason" IS DISTINCT FROM 'MANUAL'; -- 0
   SELECT count(*) FROM "Practitioner" WHERE NOT "publicBookingEnabled";                                    -- 0 justo después;
   --   si da > 0 después del deploy: profesionales creados por el código viejo en la ventana → revisar y prender a mano
   --   desde Configuración (o UPDATE puntual por id, con backup)
   SELECT plan, label, "priceCents", "maxUsers", "maxProfessionals", "maxStaff", "trialDays" FROM "SaasPlanConfig" ORDER BY "sortOrder";
   --   4 filas, precios NULL; INDIVIDUAL 1/1/1/14 · CONSULTORIO 5/4/1/0 · CLINICA 10/–/–/0 · LIBRE –/–/–/0 (M8b después: CONSULTORIO 5/–/–/0)
   SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('SaasPlanConfig','SaasPlanPriceChange',
     'SaasSubscription','SaasCharge','SaasPayment','SupportThread','SupportMessage','SupportThreadRead','TwoFactorChallenge',
     'TwoFactorRecoveryCode','UserSecurityEvent');                                                          -- 11 filas t | t
   SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename IN ('SaasPlanConfig','SaasPlanPriceChange','SaasSubscription',
     'SaasCharge','SaasPayment','SupportThread','SupportMessage','SupportThreadRead','TwoFactorChallenge','TwoFactorRecoveryCode',
     'UserSecurityEvent') ORDER BY 1, 2;
   --   9 filas: SaasCharge/SaasPayment/SaasSubscription _tenant_read SELECT; SaasPlanConfig_read SELECT; SupportMessage y
   --   SupportThread _tenant_insert INSERT + _tenant_read SELECT; SupportThreadRead_tenant_isolation ALL. Las 4 SERVICE_ONLY sin policies.
   SELECT tgname, tgenabled FROM pg_trigger WHERE NOT tgisinternal
     AND tgrelid IN ('public."SaasPlanPriceChange"'::regclass, 'public."UserSecurityEvent"'::regclass);       -- 4 filas, O
   SELECT indexdef FROM pg_indexes WHERE indexname = 'TwoFactorChallenge_one_open';                         -- 1 fila, WHERE ("closedAt" IS NULL)
   SELECT grantee FROM information_schema.role_table_grants WHERE grantee IN ('anon','authenticated')
     AND table_name IN ('SaasPlanConfig','SaasPayment','SupportThread','TwoFactorChallenge','UserSecurityEvent'); -- 0 filas
   ```
   Repetir `has_table_privilege('kinesoft_app'|'kinesoft_service', …, 'SELECT,INSERT')` si esos roles existen (t).
5. **Antes o después del código:** **antes** de M8b y del deploy de PL (el código nuevo lee las columnas y tablas
   nuevas). Compatible hacia atrás: el código viejo no lee ni escribe nada nuevo. Los `ALTER TABLE` + backfill toman lock
   sobre `Tenant`, `Membership`, `Practitioner` y `UserProfile` hasta el COMMIT (tablas chicas, milisegundos; `lock_timeout`
   5 s → P3009 liviano si estuvieran tomadas: reintentar).
6. **No se puede limpiar a mano** `SaasPlanPriceChange` ni `UserSecurityEvent` (triggers de solo inserción, también para el
   owner), y las FKs RESTRICT impiden borrar un consultorio con cobros o mensajes. Es a propósito. M8 no se revierte
   (aditiva); el DROP de `Tenant.plan`/`TenantPlan`/`seatLimitOverride` va en una migración posterior (contract).

**Orden de prod de PL (PL-A..PL-Z, una sola ventana):** precheck de M8 → precheck de M8b (anotar la lista (b) de
ADMIN que se convierten) → backup → **M8** → postcheck M8 → **M8b** (sha256
`6c0c816f1539c5915a59df59fc1e6f5823a8b3891c37e555796b86cbba41d551`) → postcheck M8b → **M8c** (sha256
`273abbe33484e5be2fec08523ff3124899b076967031de268ac6b9323d640e0f`) → postcheck M8c → **deploy**. Antes del deploy, en
Vercel (EXTERNAL-CONFIG §0.5/§0.6): la 2FA por usuario del superadmin **activa** (las acciones de riesgo alto de
Plataforma la piden aunque `PLATFORM_MFA_ENFORCEMENT` no sea `enforce`) y, si se va a cobrar, `SAAS_BILLING_TRANSFER_INFO`
antes de pasar `SAAS_BILLING_MODE` a `manual`. Después del deploy: decidir los ADMIN convertidos de (b) (a3#12).

**M8b en prod (inicio de PL-2).** Solo datos, sin reset y sin staging. Va **después de M8** y **antes del deploy de
PL-1/PL-2** (puede ir en la misma ventana que M8, una detrás de la otra; el build de Vercel la aplica igual antes de
publicar el deploy). Compatibilidad hacia atrás (PL-Z, a3#13): el código de antes de PL no lee `clinical` ni
`SaasPlanConfig`; para ese código un ADMIN convertido a PRACTITIONER conserva agenda y HC pero **pierde lo que el rol
ADMIN le daba** (ver el aviso del precheck (b)). Desde PL-Z, `isClinicalMember` lee **ADMIN = no atiende siempre**: si el
código de PL llegara a deployarse sin M8b, los ADMIN legados con agenda **dejan de verla** (y la HC) hasta correr M8b, y
Consultorio frena al 5.º usuario por tipo (la fila dice 4 + 1). Por eso M8b va sí o sí antes del deploy.
1. Precheck de solo lectura (anotar los resultados):
   ```sql
   -- (a) M8 aplicada y M8b no: 1 fila | 0 filas; la fila de Consultorio todavía 5 | 4 | 1
   SELECT migration_name FROM _prisma_migrations WHERE migration_name = '20261015180000_pl_accounts_billing' AND finished_at IS NOT NULL;
   SELECT migration_name FROM _prisma_migrations WHERE migration_name = '20261015200000_pl_admin_consultorio';
   SELECT "maxUsers", "maxProfessionals", "maxStaff" FROM "SaasPlanConfig" WHERE plan = 'CONSULTORIO';
   -- (b) qué ADMIN se convierten (convierte = t) y cuáles quedan sin atender, por consultorio, con su carga
   SELECT t.name AS consultorio, t."saasPlan", m.id AS membership, m."userId", m."disabledAt" IS NOT NULL AS suspendida,
          p.id AS practitioner,
          (SELECT count(*) FROM "Booking" b WHERE b."tenantId" = m."tenantId" AND b."practitionerId" = p.id
             AND b."scheduledFor" >= (now() AT TIME ZONE 'UTC') AND b.status IN ('PENDING','CONFIRMED')) AS turnos_futuros,
          (SELECT count(*) FROM "Patient" pa WHERE pa."tenantId" = m."tenantId" AND pa."assignedPractitionerId" = p.id
             AND pa."archivedAt" IS NULL) AS pacientes_asignados,
          (SELECT count(*) FROM "TreatmentProgram" tp WHERE tp."tenantId" = m."tenantId" AND tp."practitionerId" = p.id
             AND tp.status = 'ACTIVE' AND tp."archivedAt" IS NULL) AS planes_activos
     FROM "Membership" m JOIN "Tenant" t ON t.id = m."tenantId"
     LEFT JOIN "Practitioner" p ON p."tenantId" = m."tenantId" AND p."userId" = m."userId"
    WHERE m.role = 'ADMIN' AND m.clinical
    ORDER BY t.name, m."userId";
   --   convierte = turnos_futuros + pacientes_asignados + planes_activos > 0 (y practitioner no NULL). El resto pasa a
   --   «no atiende» y deja de aparecer en la agenda; sus turnos PASADOS quedan como historia.
   --   ⚠ PL-Z (a3#12) — los que se CONVIERTEN (ADMIN → PRACTITIONER + «Configuración») PIERDEN lo que era del rol ADMIN:
   --   cobros (`billing.manage`), operar turnos de otros profesionales, bloqueos de agenda y ver todos los pacientes
   --   (pasan a ver los suyos). DECIDE MARTIN, caso por caso, con la lista de (b):
   --     · dejarlo así (atiende, configura, sin cobros ni agenda ajena);
   --     · darle «Planes y pagos» (`grantBilling`): ve plan y facturación de la cuenta, pero NO devuelve
   --       `billing.manage` (copagos y cobros de turnos);
   --     · volverlo a ADMIN desde Usuarios: recupera todo eso pero DEJA DE ATENDER (ADMIN nunca atiende, §20.17).
   -- (c) totales esperados para el postcheck
   SELECT count(*) AS admin_clinicos FROM "Membership" WHERE role = 'ADMIN' AND clinical;
   SELECT role, clinical, "grantSettings", count(*) FROM "Membership" GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
   -- (d) cupo a medida de no clínicos que quedaría excedido al pasar ADMIN a «no atiende» (no deshabilita a nadie;
   --     solo frena invitar). Ajustarlo desde /plataforma si aparece alguno.
   SELECT t.id, t.name, t."maxStaffOverride",
          count(*) FILTER (WHERE m.role IN ('ASSISTANT','BILLING') OR (m.role = 'ADMIN') OR (m.role = 'OWNER' AND NOT m.clinical)) AS no_clinicos_despues
     FROM "Tenant" t JOIN "Membership" m ON m."tenantId" = t.id AND m."disabledAt" IS NULL
    WHERE t."maxStaffOverride" IS NOT NULL
    GROUP BY t.id, t.name, t."maxStaffOverride";
   --   (cuenta como no clínicos a TODOS los ADMIN: los que se convierten bajan ese número; es una cota superior)
   --   Desde PL-Z (a3#1) los overrides solo rigen en LIBRE: en otro plan son inertes y esta fila no frena nada.
   ```
2. Backup (`npm run db:prod:backup`) si no se acaba de hacer el de M8 en la misma ventana.
3. `npm run db:prod:deploy` y `npm run db:prod:status` → "Database schema is up to date!". Después, el deploy de PL-1/PL-2.
4. Postcheck (solo lectura):
   ```sql
   SELECT "maxUsers", "maxProfessionals", "maxStaff" FROM "SaasPlanConfig" WHERE plan = 'CONSULTORIO';   -- 5 | NULL | NULL
   SELECT count(*) FROM "Membership" WHERE role = 'ADMIN' AND clinical;                                    -- 0
   SELECT role, clinical, "grantSettings", count(*) FROM "Membership" GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
   --   PRACTITIONER/t/t = los convertidos de (b); ADMIN/f/t = el resto; los demás roles igual que en (c)
   SELECT count(*) FROM "Booking" b JOIN "Practitioner" p ON p.id = b."practitionerId"
     JOIN "Membership" m ON m."tenantId" = b."tenantId" AND m."userId" = p."userId"
    WHERE b."scheduledFor" >= (now() AT TIME ZONE 'UTC') AND b.status IN ('PENDING','CONFIRMED') AND m.role = 'ADMIN'; -- 0
   ```
5. **Antes o después del código:** después de M8 y **antes** del deploy de PL-1/PL-2. Locks: solo filas de `Membership`
   y `SaasPlanConfig` que cambian (milisegundos); `lock_timeout` 5 s → P3009 liviano si estuvieran tomadas: reintentar.
6. Rollback: no hay (datos). Es idempotente; un ADMIN convertido por error se corrige desde Configuración → Equipo
   (cambiar el rol) con los bloqueos normales de la app.

**M8c en prod (PL-F0).** Aditiva, sin reset y sin staging. Va **después de M8 y M8b** y **antes del deploy** que
escriba o lea `SaasPayment.method` (puede ir en la misma ventana, una detrás de la otra; si se mergea sin aplicarla a mano,
el build de Production aplica M8 → M8b → M8c en ese orden). Es **compatible con el código anterior**: la columna es NULL
sin default y el código viejo no la nombra, así que sus INSERT/SELECT de `SaasPayment` siguen andando; aplicarla antes no
cambia nada visible.
1. Precheck de solo lectura (anotar los resultados):
   ```sql
   -- (a) M8b aplicada y M8c no: 1 fila | 0 filas
   SELECT migration_name FROM _prisma_migrations WHERE migration_name = '20261015200000_pl_admin_consultorio' AND finished_at IS NOT NULL;
   SELECT migration_name FROM _prisma_migrations WHERE migration_name = '20261016120000_saas_payment_method';
   -- (b) el tipo y la columna todavía no existen: 0 | 0
   SELECT count(*) FROM pg_type WHERE typname = 'SaasPaymentMethod' AND typnamespace = 'public'::regnamespace;
   SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'SaasPayment' AND column_name = 'method';
   -- (c) pagos existentes (todos quedan con method NULL = «sin informar»; anotar para el postcheck)
   SELECT count(*) FROM "SaasPayment";
   ```
2. Backup (`npm run db:prod:backup`) si no se acaba de hacer el de M8/M8b en la misma ventana.
3. `npm run db:prod:deploy` y `npm run db:prod:status` → "Database schema is up to date!".
4. Postcheck (solo lectura):
   ```sql
   SELECT udt_name, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'SaasPayment' AND column_name = 'method';  -- SaasPaymentMethod | YES | NULL
   SELECT enum_range(NULL::"SaasPaymentMethod");  -- {TRANSFER,CASH,CARD,WALLET,MERCADO_PAGO,OTHER}
   SELECT count(*), count(method) FROM "SaasPayment";  -- el total de (c) | 0
   SELECT policyname, cmd FROM pg_policies WHERE tablename = 'SaasPayment';  -- SaasPayment_tenant_read | SELECT (igual que antes)
   ```
5. **Antes o después del código:** antes del deploy que use `method` (o en la misma ventana). Locks: `ADD COLUMN` NULL
   sin default es solo catálogo, pero toma ACCESS EXCLUSIVE un instante sobre `SaasPayment`; `lock_timeout` 5 s → P3009
   liviano si estuviera tomada: reintentar.
6. Rollback: no hace falta (aditiva, el código viejo la ignora). Si hubiera que sacarla, es una migración nueva
   (`DROP COLUMN` + `DROP TYPE`) después de revertir el código que la usa.

**M9 en prod (EV2-0).** Aditiva, sin reset y sin staging (AGENTS). Orden: **M8 → M8b → M8c → M9 → deploy** (si
M8..M8c ya están aplicadas, M9 sola). Es **compatible con el código anterior**: no lee ni escribe nada nuevo y, mientras
no haya evoluciones, ningún RESTRICT nuevo puede dispararse → se aplica **antes** del deploy de EV2. sha256 de
`migration.sql` = `755ae1891bc3a989685bc37e4c4ba6903b23076889ac2d67f013d3730284fa3b`.
1. Precheck de solo lectura (anotar los resultados):
   ```sql
   SELECT version();                                                        -- PostgreSQL ≥ 13 (gen_random_uuid nativo)
   SELECT migration_name FROM _prisma_migrations
    WHERE migration_name IN ('20261016120000_saas_payment_method', '20261017120000_clinical_notes')
      AND finished_at IS NOT NULL;                                           -- M8c sí, M9 no
   SELECT to_regclass('public."ClinicalNote"'), to_regclass('public."ClinicalNoteRevision"');   -- NULL, NULL
   SELECT count(*) FROM pg_type WHERE typname = 'ClinicalNoteKind';         -- 0
   SELECT indexname FROM pg_indexes
    WHERE indexname IN ('Booking_id_tenantId_patientId_key', 'Practitioner_id_tenantId_key'); -- 0 filas
   SELECT count(*) FROM pg_proc WHERE proname IN ('kinesoft_append_only', 'app_current_tenant_id'); -- 2
   SELECT count(*) FROM "Booking"; SELECT count(*) FROM "Practitioner";     -- tamaño del build de índices
   SELECT pid, state, now() - xact_start AS age, left(query, 80) FROM pg_stat_activity
    WHERE xact_start < now() - interval '1 minute';                         -- sin tx largas
   ```
2. Backup: `npm run db:prod:backup` (si no se acaba de hacer el de M8..M8c en la misma ventana).
3. `npm run db:prod:deploy` (aplica solo M9) y `npm run db:prod:status` → "Database schema is up to date!". Si sale
   P3009 por `lock_timeout`: §2.4 «Si falla: P3009» (resolver como rolled back y reintentar fuera de horario).
4. Postcheck (solo lectura):
   ```sql
   SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
    WHERE relname IN ('ClinicalNote', 'ClinicalNoteRevision');               -- t, t (las 2)
   SELECT polname FROM pg_policy WHERE polrelid IN ('"ClinicalNote"'::regclass, '"ClinicalNoteRevision"'::regclass);
     -- ClinicalNote_tenant_isolation, ClinicalNoteRevision_tenant_isolation
   SELECT tgname FROM pg_trigger WHERE tgrelid IN ('"ClinicalNote"'::regclass, '"ClinicalNoteRevision"'::regclass)
     AND NOT tgisinternal;                                                   -- 5
   SELECT conname FROM pg_constraint WHERE conrelid = '"ClinicalNote"'::regclass AND contype = 'f'; -- 9
   SELECT indexdef FROM pg_indexes WHERE indexname = 'ClinicalNote_bookingId_live_key';
     -- … ("bookingId") WHERE (("bookingId" IS NOT NULL) AND ("amendsNoteId" IS NULL) AND ("voidedAt" IS NULL))
   ```
   Y el chequeo de grants de M2 (0 filas para `anon`/`authenticated`, «Orden del go-live» punto 11).
5. **Antes o después del código:** **antes** del deploy de EV2 (cuando Martin pushee, Vercel migra en el build y M9 ya
   estará aplicada). Locks: los `CREATE UNIQUE INDEX` sobre `Booking` y `Practitioner` toman SHARE (frenan escrituras
   de turnos mientras se construyen; con el volumen de prod, < 1 s) y los `ADD CONSTRAINT` de las FKs, SHARE ROW
   EXCLUSIVE hasta el COMMIT; `lock_timeout` 5 s → P3009 liviano: reintentar fuera de horario.
6. Rollback: el código se revierte sin tocar M9. **No hay rollback de datos**: las evoluciones no se borran (ningún
   trigger frena un `DROP TABLE`: no se hace nunca; el backup del paso 2 es la red). Para limpiar en local/test hay que
   usar `deleteTenantDeep` (modo réplica, solo superusuario): en prod no existe esa salida, a propósito.

**M10 en prod (PF-M).** Aditiva, sin reset y sin staging separado (AGENTS). Orden: **M9 → M10 → deploy** (si M9 ya
está aplicada, M10 sola). **Compatible con cualquier código**: solo crea índices, ninguna query depende de ellos para
ser correcta → se aplica **antes** del deploy de PF. sha256 de `migration.sql` =
`807a05097f9f021e0d6122b11f53a43fe0ac5fcbedb97e22383ca249cfda26c3`.
1. Precheck de solo lectura (anotar los resultados):
   ```sql
   SELECT migration_name FROM _prisma_migrations
    WHERE migration_name IN ('20261017120000_clinical_notes', '20261018120000_perf_fk_indexes')
      AND finished_at IS NOT NULL;                                           -- M9 sí, M10 no
   SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
     'Coverage_patientId_idx','EmergencyContact_patientId_idx','Patient_userId_idx','PatientTenantLink_tenantId_idx',
     'Service_tenantId_idx','Service_practitionerId_idx','Session_practitionerId_idx','SessionExercise_exerciseId_idx',
     'Booking_serviceId_idx','Favorite_exerciseId_idx','ExerciseTag_tagId_idx','ConditionTag_tagId_idx',
     'Condition_createdById_idx');                                           -- 0 filas
   SELECT (SELECT count(*) FROM "Coverage") cov, (SELECT count(*) FROM "EmergencyContact") ec,
          (SELECT count(*) FROM "Patient") pat, (SELECT count(*) FROM "PatientTenantLink") ptl,
          (SELECT count(*) FROM "Service") svc, (SELECT count(*) FROM "Session") ses,
          (SELECT count(*) FROM "SessionExercise") sx, (SELECT count(*) FROM "Booking") bk,
          (SELECT count(*) FROM "Favorite") fav, (SELECT count(*) FROM "ExerciseTag") et,
          (SELECT count(*) FROM "ConditionTag") ct, (SELECT count(*) FROM "Condition") cond;  -- tamaño del build
   SELECT pid, state, now() - xact_start AS age, left(query, 80) FROM pg_stat_activity
    WHERE xact_start < now() - interval '1 minute';                         -- sin tx largas
   ```
2. Backup: `npm run db:prod:backup` (si no se acaba de hacer el de M9 en la misma ventana).
3. `npm run db:prod:deploy` (aplica solo M10) y `npm run db:prod:status` → "Database schema is up to date!". Si sale
   P3009 por `lock_timeout` (alguien escribía en `Booking`/`Patient` con un lock largo): §2.4 «Si falla: P3009»
   (resolver como rolled back y reintentar en un momento sin uso; `IF NOT EXISTS` la hace re-ejecutable).
4. Postcheck (solo lectura):
   ```sql
   SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (…los 13 de arriba…);
     -- 13 filas, todas «USING btree ("<col>")» sin WHERE
   SELECT count(*) FILTER (WHERE i.indisvalid AND i.indisready AND i.indpred IS NULL) FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname IN (…los 13…);  -- 13
   ```
5. **Antes o después del código:** **antes** del deploy de PF (cuando Martin pushee, Vercel migra en el build y M10 ya
   estará aplicada: no-op). Locks: cada `CREATE INDEX` toma SHARE sobre su tabla (frena escrituras, no lecturas) hasta
   el COMMIT de la migración; con datos demo son milisegundos. Aplicar en un momento sin uso.
6. Rollback: no hace falta (los índices no cambian resultados). Si un índice molestara, una migración nueva
   `DROP INDEX IF EXISTS "<nombre>"` + sacar el `@@index` del schema en la misma tanda.

**M11 en prod (DIR-1).** Aditiva, sin reset y sin staging separado (AGENTS). Orden: **M10 → M11 → deploy** (si M10 ya
está aplicada, M11 sola). Compatible con el código anterior: nadie lee las columnas nuevas y todo nace en false/NULL, así
que los CHECK validan sin backfill; va **antes** del deploy de DIR. sha256 de `migration.sql` =
`a35fdd6b3f5fe8a9b4b9bbf8fcebb0cff8a82031a9721ddfca171c6af067177d`. Los CHECK de matrícula y ocultamiento van con
`COALESCE(…, false)` (un CHECK acepta NULL: sin eso entraban MP sin jurisdicción, matrícula sin tipo y «oculto» sin motivo).
1. Precheck de solo lectura:
   ```sql
   SELECT version();
   SELECT migration_name FROM _prisma_migrations
    WHERE migration_name IN ('20261018120000_perf_fk_indexes', '20261019120000_public_directory')
      AND finished_at IS NOT NULL;                                           -- M10 sí, M11 no
   SELECT count(*) FROM "Tenant";
   SELECT column_name FROM information_schema.columns WHERE table_name IN ('Tenant','Location')
     AND column_name IN ('directoryListed','provinceCode');                  -- 0 filas
   SELECT to_regclass('"ProfessionalPublicProfile"');                       -- NULL
   SELECT count(*) FILTER (WHERE province IS NOT NULL) FROM "Location";      -- sedes a cargar a mano (provincia)
   SELECT pid, state, now() - xact_start AS age, left(query, 80) FROM pg_stat_activity
    WHERE xact_start < now() - interval '1 minute';                         -- sin tx largas
   ```
2. Backup: `npm run db:prod:backup`.
3. `npm run db:prod:deploy` y `npm run db:prod:status` («Database schema is up to date!»). P3009 por `lock_timeout` →
   §2.4 y reintentar sin uso.
4. Postcheck de solo lectura:
   ```sql
   SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid IN
     ('"Tenant"'::regclass, '"Location"'::regclass, '"ProfessionalPublicProfile"'::regclass)
     AND (conname LIKE 'ProfessionalPublicProfile_%' OR conname IN ('Tenant_directoryListed_check',
          'Tenant_directoryHidden_check','Tenant_publicDescription_check','Location_provinceCode_check'));  -- 11 filas
   SELECT relrowsecurity, relforcerowsecurity,
          (SELECT count(*) FROM pg_policies WHERE tablename = 'ProfessionalPublicProfile') AS policies
     FROM pg_class WHERE oid = '"ProfessionalPublicProfile"'::regclass;      -- t, t, 0
   SELECT tgname, tgenabled FROM pg_trigger
    WHERE tgrelid = '"ProfessionalPublicProfile"'::regclass AND NOT tgisinternal;  -- license_guard, O
   SELECT grantee FROM information_schema.role_table_grants WHERE table_name = 'ProfessionalPublicProfile'
     AND grantee IN ('anon','authenticated');                               -- 0 filas
   SELECT count(*) FILTER (WHERE "directoryListed") FROM "Tenant";           -- 0
   ```
5. Deploy con `DIRECTORY_MODE` sin setear (= `off`) → `preview` para revisar → `public` cuando Martin decida, con
   revisión legal del texto de consentimiento antes (DIR-D20).
6. Rollback: revertir el código sin tocar M11 (columnas sin lector son inocuas). Sacarla = migración nueva con DROP y
   se pierden perfiles y consentimientos (backup del paso 2).

**Deploy de BO** (código de `0d058bb`..`c60014f`, después de M7). Las variables nuevas nacen en su default seguro, así
que el deploy no cambia el comportamiento de nadie salvo lo que se describe abajo.
1. **Antes del deploy (solo lectura):**
   ```sql
   -- (a) Cupos: desde BO2-B rigen también en Configuración y onboarding (Free = 1 profesional; Secretaria y
   --     Facturación no ocupan). Un consultorio por encima de su cupo sigue andando (bajar de plan no saca a nadie),
   --     pero no puede invitar ni subir de rol. Revisar el plan del cliente vivo: darle PRO o seatLimitOverride desde
   --     /plataforma después del deploy.
   SELECT t.id, t.name, t.plan, t."seatLimitOverride",
          (SELECT count(*) FROM "Membership" m WHERE m."tenantId" = t.id AND m."disabledAt" IS NULL
              AND m.role IN ('OWNER','ADMIN','PRACTITIONER')) AS clinicos
     FROM "Tenant" t ORDER BY clinicos DESC;
   -- (b) Consultorios en prueba vencida o impagos: con TENANT_ACCESS_ENFORCEMENT=banner solo ven la banda; con
   --     enforce quedarían en solo lectura. Mirarlos antes de pasar a enforce.
   SELECT id, name, "subscriptionStatus", "trialEndsAt" FROM "Tenant"
    WHERE ("subscriptionStatus" = 'TRIALING' AND "trialEndsAt" < now() + interval '7 days')
       OR "subscriptionStatus" IN ('PAST_DUE','CANCELLED');
   ```
   El primer día del cron, los OWNER de consultorios en prueba con ≤ 7 días o recién vencida reciben el mail de
   recordatorio (prod hoy es demo).
2. **Variables en Vercel (Production)** — todas con su default, ver [EXTERNAL-CONFIG §0.5](EXTERNAL-CONFIG.md):
   `TENANT_ACCESS_ENFORCEMENT` vacía (= `banner`), `PLATFORM_MFA_ENFORCEMENT` vacía (= `off`), `MAINTENANCE_MODE` vacía
   (= `off`), `CRON_SECRET` = `openssl rand -hex 32` (sin él los crons responden 503 y no corren).
3. **M7** (arriba) y **deploy** del código (merge a `main`; el build de Production aplica M7 si no se aplicó a mano).
   `vercel.json` suma `functions` (`app/api/consultorio/export/route.ts` 60 s antes de `app/**/*` 30 s: el orden de las
   claves importa) y `crons` (06:00, 11:00 y 12:00 UTC). En Hobby los crons corren una vez por día a una hora inexacta
   dentro de esa hora; con Pro, exacta (y se puede subir el export a 300 s).
4. **Después del deploy:**
   - superadmin: entrar a `/plataforma-mfa/configurar`, enrolar el TOTP, probar `/plataforma-mfa/verificar`;
   - `PLATFORM_MFA_ENFORCEMENT=enforce` + **redeploy**; recién ahí usar «Entrar como soporte» (el soporte no se usa sin
     MFA en enforce);
   - revisar en `/plataforma/sistema` que `CRON_SECRET` figure presente y en `/plataforma/salud` los detectores;
   - plan / `seatLimitOverride` del cliente vivo (precheck a);
   - `TENANT_ACCESS_ENFORCEMENT=enforce` solo cuando Martin lo decida (antes, cerrar `readonly-residual-actions` de AUDIT).
5. **Vuelta atrás sin código:** `TENANT_ACCESS_ENFORCEMENT=off` (ni la suspensión corta), `PLATFORM_MFA_ENFORCEMENT=off`
   (recuperación si se pierde el TOTP), `MAINTENANCE_MODE=off`; cada cambio pide redeploy. M7 no se revierte (aditiva).

**Deploy de SV en escalones** (después de que M5 esté aplicada, con la cadena o sola):
1. Vercel env `REALTIME_DRIVER=off` (variable nueva) y deploy del código: nada se conecta y la app es idéntica a SR.
2. Env `SUPABASE_JWT_SECRET` (+ `SUPABASE_JWT_KID` si la clave HS256 es del sistema nuevo de JWT Signing Keys, R4);
   confirmar `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY` (con
   `REALTIME_DRIVER=supabase` en Production, `lib/env.ts` hace fallar el build si falta cualquiera). El secreto y el
   `kid` son server-only, nunca `NEXT_PUBLIC_` (guard (d)).
3. Staging con `REALTIME_DRIVER=supabase` → verificaciones **V1-V7** (solo lectura sobre datos; `--confirm` = project
   ref de la URL, rechaza localhost; detalle en [EXTERNAL-CONFIG.md §3.1](EXTERNAL-CONFIG.md)):
   ```bash
   npx dotenv -e .env.staging.local -- npx tsx --conditions=react-server scripts/realtime-verify.ts \
     --tenant <tenantId> --confirm=<project-ref>
   ```
   Sale con código 1 si algún chequeo da FAIL. A mano: `/sala` en dos navegadores de staging; «Llegó» en uno aparece
   en el otro.
4. Prod con `REALTIME_DRIVER=supabase` + **redeploy** (la env se lee al cargar el módulo). Rollback sin código:
   `REALTIME_DRIVER=off` + redeploy (la app queda igual que SR, con polling de 60 s en `/sala`).

**Orden del go-live** (staging primero, desde vacío, con QA completo; después prod):

1. Gate final del bloque B en local (después de EV1), commit de Martin, `develop` listo para `main`.
2. **Backup** de prod (`npm run db:prod:backup`): aunque se descarte, es la única copia de lo que cargó el cliente.
3. **Reset** de prod (acción de Martin en la consola de Supabase). Precheck (1) → **base vacía**:
   `SELECT count(*) FROM pg_tables WHERE schemaname='public';` = 0. Precheck (0): el rol de `DIRECT_URL` tiene
   `rolbypassrls = t`.
4. `migrate deploy` desde vacío (cadena completa hasta M5): `npm run db:prod:deploy` y `npm run db:prod:status` →
   "Database schema is up to date!". O merge a `main` y el build de Production aplica la cadena antes de servir.
5. **Roles SQL** (`prisma/roles.supabase.sql`, ver §2 "Tareas de prod que van una sola vez", punto a) → en Vercel
   `DATABASE_URL` al rol app y `DATABASE_URL_SERVICE` a `kinesoft_service`.
6. **Import del catálogo global** (`scripts/catalog-import.ts`, dry-run → `--apply` → dry-run = 0; comandos en §2.2).
7. **`create-tenant --vertical kinesiologia`** (casa de la plataforma):
   `KINESOFT_CONFIRM_PROD=<project-ref> npx dotenv -e .env.prod.local -- npx tsx scripts/create-tenant.ts --vertical kinesiologia …`
   (`--vertical general|kinesiologia`, default `kinesiologia`).
8. **`set-platform-admin`** (§2, punto b).
9. Desde **/plataforma** → Consultorios: vertical y plan del cliente kine (PRO u otro) y **prender los turnos online**
   por consultorio (nacen apagados, EV-D2; también los prende el Titular desde Configuración → General).
10. **Data API desactivada** (arriba) y **Storage privado** (precheck (17): buckets `public = false`, ninguna policy de
    `storage.objects` para `anon`/`authenticated`; `SUPABASE_SERVICE_ROLE_KEY` en Vercel).
11. **Post-checks:** los de M1 (§2.4 "Post-checks", objeto por objeto), (11) tags DISCIPLINE = 2 y (12) vertical/plan del
    tenant ([PLANES.md §16](PLANES.md)), RLS de las tablas nuevas (incluida `Room` de M4) y **grants de M2** (tiene que dar 0 filas):

    ```sql
    SELECT c.relname
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','v','m','f')
      AND (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
           OR has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'));
    ```

    Y en el log del deploy, ningún `WARNING tenant_verticals: … siguen accesibles` (autochequeo de M2). Columnas:
    `SELECT vertical, "publicBookingEnabled" FROM "Tenant";` → el tenant casa con la vertical elegida.
12. Con SV: `REALTIME_DRIVER=off` en el deploy → prechecks R1-R4 y V1-V7 en staging ([EXTERNAL-CONFIG.md §3.1](EXTERNAL-CONFIG.md))
    → env → `supabase` (escalones de arriba, «Deploy de SV»).

**Si falla un `migrate deploy` (P3009):** con la base vacía no hay nada que salvar: corregir la causa, re-reset y
`migrate deploy` de nuevo (antes de abrir al cliente). Después de abrir, el rollback es revertir el deploy de Vercel.

---

## 0. Cómo está armado (leer una vez)

| Archivo | Apunta a | Lo usan |
|---|---|---|
| `.env` | **Solo DEV** (Docker :5433). Borrá el bloque PROD comentado si todavía lo tenés | Prisma CLI y `@prisma/client` (lo cargan solos) |
| `.env.local` | Docker :5433, rol app `kinesoft_app` (RLS activa) | `npm run dev`, scripts `prisma:*`, tests |
| `.env.prod.local` | **Supabase PROD** (owner): `DIRECT_URL` + `DATABASE_URL` | **solo** los scripts `db:prod:*` |

`.env.prod.local` lo creás vos (está en `.gitignore` por `.env*.local`) con dos líneas:

```
DIRECT_URL="postgresql://…@aws-1-sa-east-1.pooler.supabase.com:5432/postgres"
DATABASE_URL="postgresql://…@aws-1-sa-east-1.pooler.supabase.com:5432/postgres"
```

> ⚠️ Por qué cambió: con el switch manual, olvidarse de volver el `.env` a DEV
> hacía que el próximo `migrate reset` o seed del §1 pegara en producción.
> Además todos los seeds/scripts ahora imprimen su destino y se niegan a ir a
> una base remota sin confirmación (`assertSafeTarget`).

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Runtime de la app (rol **sin** BYPASSRLS). En el CLI: la base a migrar. |
| `DIRECT_URL` | Conexión **directa** (5432, sin pooler) — la que usa `prisma migrate`. |
| `DATABASE_URL_SERVICE` | `kinesoft_service` (BYPASSRLS) en prod. Sin esto el panel Plataforma no escribe. |

---

## 1. Local (Docker) — desarrollo

```bash
cd ~/Documents/kinesoft

# 0) La DB tiene que estar arriba (solo el servicio db: adminer usa el 8080 y suele chocar)
docker compose up -d db
docker compose ps                 # kinesoft-db … Up (healthy)

# 1) Aplicar migraciones pendientes (NO usa migrate dev: detecta drift y propone
#    resetear, y puede proponer borrar los índices parciales hechos a mano)
npx dotenv -e .env.local -- npx prisma migrate deploy
npx prisma generate

# 2) Verificar
npx dotenv -e .env.local -- npx prisma migrate status   # → "Database schema is up to date!"
```

**Crear una migración nueva:** a mano, en `prisma/migrations/<YYYYMMDDHHMMSS>_<nombre>/migration.sql`
(aditiva, con el porqué en la cabecera), editar `schema.prisma` en paralelo, y aplicarla con el paso 1.
Verificar objeto por objeto (columnas, índices, policies) y correr `npm run guard:isolation`.

**No correr `npx prisma format` en una sesión:** reformatea **todo** `schema.prisma` (alineación de columnas de
cada modelo) y el diff tapa el cambio real; se vio en ES2a. Se edita a mano solo el bloque que toca la sesión.

**Resetear la base local** (destructivo, solo el dueño; el agente no lo corre):

```bash
npm run prisma:reset     # re-migra y re-siembra el Docker (el seed se niega a ir a una base remota)
# Después del reset: re-crear el rol de app y re-marcar el superadmin
psql "postgresql://kinesoft:kinesoft@localhost:5433/kinesoft?schema=public" -f prisma/roles.local.sql
DATABASE_URL="postgresql://kinesoft:kinesoft@localhost:5433/kinesoft?schema=public" \
  npx tsx scripts/set-platform-admin.ts tu-email@dominio.com
```

---

## 2. Producción (Supabase + Vercel)

> Desde A0b **solo el deploy de Production migra** (`scripts/vercel-build.mjs`); los Preview no.
> Las migraciones son aditivas, así que el código viejo sigue andando si se aplican antes del deploy. Única
> excepción aprobada: M1 `plans_booking_link` dropea `Patient_userId_key` (relaja la unicidad, el código viejo lo
> tolera; §2.4).

### Paso a paso (para cada bloque con migraciones)

**1) Estado** (lee, no escribe; tiene que decir `…supabase.com`):

```bash
npm run db:prod:status
```

**2) Prechecks de solo lectura** que deja el agente para ese bloque (en el SQL Editor o con psql).
Los fijos, antes de cualquier migración:

```sql
-- Migraciones registradas, fallidas o de ramas descartadas
SELECT migration_name, finished_at, rolled_back_at, logs IS NOT NULL AS con_error
FROM _prisma_migrations ORDER BY started_at;
-- Roles (si existen y se crearon con el placeholder viejo, rotalos con roles.supabase.sql)
SELECT rolname, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname LIKE 'kinesoft%';
```

**3) Backup:**

```bash
npm run db:prod:backup      # pg_dump -Fc → ~/kinesoft-backups/prod-<fecha>.dump
```

**4) Staging primero:** con el Preview apuntado a staging, aplicar ahí y hacer el QA del bloque.

**5) Aplicar en prod:** o mergeás a `main` y el build de Production las aplica, o las aplicás antes:

```bash
npm run db:prod:deploy
npm run db:prod:status      # → "Database schema is up to date!"
```

### Migraciones pendientes en prod (bloque reciente)

> **Desde el reset del 07-oct:** esta tabla es la **cadena completa** que se aplica desde vacío en el go-live, no una
> lista de pendientes sobre datos vivos. Los avisos de abajo (#3 con duplicados, etc.) ya no aplican a prod.

> ⚠️ **Estado real sin verificar (auditoría 2026-09-23):** hasta A0b, `vercel.json` corría `migrate deploy` en
> cada build y `main` ya contiene estas migraciones, así que **puede que ya estén aplicadas** — o que un
> deploy haya fallado (por ejemplo la #3, si había duplicados). Antes de nada: `npm run db:prod:status` y la
> query de `_prisma_migrations` del paso 2.

En orden. Todas aplicadas y verificadas en local:

| # | Migración | Qué hace | Ronda |
|---|---|---|---|
| 1 | `20260802220514_wave_service_color_booking_title_patient_diagnosis` | `Service.color`, `Booking.title/description`, diagnóstico del paciente | 4 |
| 2 | `20260802232454_notification_kind_patient_shared` | enum `NotificationKind += PATIENT_SHARED` | 5 |
| 3 | `20260803002623_booking_patient_slot_active_unique` | **Índice único parcial** (paciente+instante, no cancelados) | 6 |
| 4 | `20260803022526_platform_admin_flag` | `UserProfile.isPlatformAdmin` | 7 |
| 5 | `20260803022544_tagkind_add_muscle_discipline` | enum `TagKind += MUSCLE_GROUP, DISCIPLINE` | 7 |
| 6 | `20260803022626_exercise_optional_reps_and_archive` | reps/series opcionales, `durationSeconds`, `archivedAt` | 7 |
| 7 | `20260803022653_exercise_media_and_article` | tablas `ExerciseMedia`/`ExerciseArticle` **+ políticas RLS** | 7 |
| 8 | `20260803183019_user_prefs_catalog` | `UserPreferences.catalogPrefs` (JSON) | 8 |
| 9 | `20260816014954_tenant_agenda_slot_minutes` | `Tenant.agendaSlotMinutes` (vista 30/60 min) | 10 |
| 10 | `20260930120000_tenant_onboarding` | `Tenant.onboardingCompletedAt/phone/whatsapp/publicEmail` + backfill | A3c — **ver §2.1** |
| 11 | `20260930200000_catalog_global` | catálogo global + punteros nullable + RLS de solo lectura | B-pre — **ver §2.2** |
| 12 | `20261001090000_agenda_foundations` | sedes, franjas, excepciones, bloqueos, PS/PP, Booking expand + **backfill** | B-pre — **ver §2.2** |
| 13 | `20261004120000_plans_booking_link` | M1 de Planes: FK turno↔plan/sesión, 2 tablas con RLS, `Patient_userId_key` por consultorio + **backfill** | ES2a — **ver §2.3 y §2.4** |
| 14 | `20261007120000_tenant_verticals` | M2: `Tenant.vertical` + `Tenant.publicBookingEnabled` + REVOKE guardado de `anon`/`authenticated` | EV0 — **ver «Go-live con reset»** |
| 15 | `20261008120000_billing_paid_at` | M3a: `Booking.copagoPaidAt` + `UserPreferences.dashboardPrefs` (+ CHECK de objeto) | ES3 — **ver «Go-live con reset»** |
| 16 | `20261009120000_rooms` | M4: `Room` con RLS + `roomId` en franja, turno y bloqueo (FKs compuestas, CHECKs) | SR — **ver «Go-live con reset»** |
| 17 | `20261013120000_reception_call_realtime` | M5: `Booking.calledAt` (+ CHECK) + `kinesoft_realtime_can_read` + policy guardada de `realtime.messages` | SV — **ver «Go-live con reset»** |
| 18 | `20261014120000_identity_access` | M6: `Practitioner` único por consultorio (DROP del único global, aprobado), `Membership.disabledAt`, campos de `Invitation`, tabla `EmailLog` con RLS | IAM-1 — **ver «M6 en prod»** |
| 19 | `20261015120000_platform_backoffice` | M7: `Tenant.status` + fechas + `seatLimitOverride`, `UserProfile.disabledAt`, `PlatformAuditEvent` (solo inserción), `SupportSession` (sin vencimiento, parcial una abierta por superadmin), `TenantSlugAlias`; RLS service-only / tenant-readonly | BO0 — **ver «M7 en prod»** |
| 20 | `20261015180000_pl_accounts_billing` | M8: `SaasPlan` + `Tenant.saasPlan` (backfill) y overrides de cupos, `Membership.clinical/grantSettings/grantBilling/disabledReason` (backfill), `Practitioner.publicBookingEnabled` (backfill true), `SaasPlanConfig` (4 filas), historial de precios, cobros (suscripción/cargos/pagos), mensajes, 2FA; RLS global-readonly / service-only / tenant-readonly | PL-0 — **ver «M8 en prod»** |
| 21 | `20261015200000_pl_admin_consultorio` | M8b (solo datos): Consultorio sin tope por tipo; ADMIN con agenda en uso → PRACTITIONER + «Configuración», el resto `clinical=false` | PL-2 — **ver «M8b en prod»** |
| 22 | `20261016120000_saas_payment_method` | M8c: enum `SaasPaymentMethod` + `SaasPayment.method` (NULL = sin informar, sin backfill) | PL-F0 — **ver «M8c en prod»** |
| 23 | `20261017120000_clinical_notes` | M9: `ClinicalNote` (evoluciones de HC, nunca se borran) + `ClinicalNoteRevision` (solo inserción), triggers de inalterabilidad, FKs compuestas, una raíz viva por turno (parcial), RLS; únicos destino en `Booking`/`Practitioner` | EV2-0 — **ver «M9 en prod»** |
| 24 | `20261018120000_perf_fk_indexes` | M10: 13 índices btree de una columna sobre FKs sin índice (`Coverage.patientId`, `Patient.userId`, `Service.tenantId`, `Booking.serviceId`, tags/favoritos…), sin parciales | PF-M — **ver «M10 en prod»** |
| 25 | `20261019120000_public_directory` | M11: opt-in y moderación del directorio en `Tenant`, `Location.provinceCode` (24 jurisdicciones) y `ProfessionalPublicProfile` (perfil por persona con consentimiento, SERVICE_ONLY, CHECK listed ⇒ consentimiento, nombre sin «@», trigger que des-verifica la matrícula) | DIR-1 — **ver «M11 en prod»** |

⚠️ La #7 además crea políticas RLS (`ENABLE`/`FORCE` + `SELECT` en las dos tablas nuevas).
⚠️ La #3 falla si ya existieran dos turnos activos del **mismo paciente en el mismo instante**
exacto. En local verifiqué 0 casos; si prod tuviera alguno, `migrate deploy` aborta sin
dejar la base a medias y hay que limpiar esos duplicados primero:

```sql
-- Diagnóstico previo (solo lectura) — debería devolver 0 filas:
SELECT "tenantId", "patientId", "scheduledFor", count(*)
FROM "Booking"
WHERE "patientId" IS NOT NULL AND status <> 'CANCELLED'
GROUP BY 1,2,3 HAVING count(*) > 1;
```

### Tareas de prod que van una sola vez (además de migrar)

```bash
# a) Roles: app sin BYPASSRLS + service con BYPASSRLS. Passwords por variable
#    (nunca en el archivo); re-correrlo ROTA los passwords.
set -a; . ./.env.prod.local; set +a
# -hex y no base64: `/`, `+` y `=` rompen las URLs de conexión (hay que guardarlas para Vercel).
APP_PW="$(openssl rand -hex 24)"; SVC_PW="$(openssl rand -hex 24)"
psql "$DIRECT_URL" -v app_password="$APP_PW" -v service_password="$SVC_PW" -f prisma/roles.supabase.sql
echo "app: $APP_PW"; echo "service: $SVC_PW"    # copiarlas a un gestor de contraseñas ahora
#    → después, en Vercel: DATABASE_URL apunta al rol app (pooler 6543)
#      y DATABASE_URL_SERVICE al rol kinesoft_service (cargala ANTES del flip).

# b) Superadmin de plataforma (vos + tu cliente). Pide confirmar el project ref.
DATABASE_URL="$DIRECT_URL" KINESOFT_CONFIRM_PROD=<project-ref> \
  npx tsx scripts/set-platform-admin.ts tu-email@dominio.com
DATABASE_URL="$DIRECT_URL" KINESOFT_CONFIRM_PROD=<project-ref> \
  npx tsx scripts/set-platform-admin.ts --list

# c) Backfill de tags estructurados (Ronda 7; sin esto los filtros de
#    músculo/equipamiento de /biblioteca quedan vacíos en prod). Idempotente.
DATABASE_URL="$DIRECT_URL" KINESOFT_CONFIRM_PROD=<project-ref> \
  npx tsx prisma/backfill-exercise-tags.ts

# d) Bucket de Supabase Storage para la media de ejercicios
#    Crear "exercise-media" PRIVADO en el proyecto de prod (la app usa signed URLs).
```

> Nunca corras `prisma/seed.ts` contra prod: es demo (borra los turnos del tenant `movare`) y
> se niega a ejecutarse contra una base remota.

### Variables de entorno en Vercel (chequeo)

- `DATABASE_URL` → rol de app (**sin** BYPASSRLS)
- `DIRECT_URL` → owner (migraciones)
- `DATABASE_URL_SERVICE` → `kinesoft_service` (BYPASSRLS) — **sin esto el panel Plataforma no escribe**
- `KINESOFT_ALLOW_DEMO_ACTOR` → **NO debe existir en prod** (es el bypass de login local)

---

## 2.1 Deploy del Bloque A (A2 + A3) — orden exacto (30-sep-2026)

> ⚠️ **Obsoleta por el reset de prod (07-oct):** el deploy incremental de A y `normalize-patient-emails` (no hay emails viejos que normalizar). `tenant_onboarding` se aplica desde vacío con la cadena; las tareas de consola de EXTERNAL-CONFIG §0.1 siguen valiendo. El orden vigente está en «Go-live con reset» (tope de este archivo). Se deja como historia hasta el go-live.

> ⚠️ **Hay UNA migración nueva en este bloque: `20260930120000_tenant_onboarding`** (A3c). A2, A3a y A3b no
> tienen migraciones. Reglas de corte:
> - ~~A3 no se despliega sin el SMTP propio configurado~~ (histórico: desde IAM, 14-oct, los mails los manda la app
>   por Resend y no hace falta SMTP en Supabase; ver EXTERNAL-CONFIG §0.4).
> - **A3b no se despliega sin A3c**: la página de invitación de A3b ofrece "Crear mi cuenta para unirme", que
>   con el signup viejo crearía un consultorio nuevo en vez de sumarse al equipo.
> - **El QA del signup (QA.md §A3c) se corre en staging con un email real ANTES del merge a `main`.** Si falla,
>   no se mergea.
> - El bug `signup-confirm-doble-salto` (hallado al cerrar A3c) **ya está corregido en código** (30-sep): el
>   `emailRedirectTo` es el destino final y `/auth/confirm` desenvuelve un `next` que apunta a sí mismo. Igual
>   se verifica con el QA de email real.
> - A2 (+ A3a) sí puede ir solo, antes, si conviene separar.

**1) Prechecks de solo lectura** (SQL Editor de prod, o `psql "$DIRECT_URL"` con `.env.prod.local`). Anotá los
tres resultados antes de seguir:

```sql
-- (a) Reservas públicas pre-A2 que el discriminante nuevo reconoce (por la key
--     vieja `<tenant>:<prof>:<ISO>:<patientId>`). Informativo.
SELECT status, "paymentStatus", count(*) FROM "Booking"
WHERE "patientId" IS NOT NULL
  AND "idempotencyKey" ~ '^[^:]+:[^:]+:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z:[^:]+$'
  AND "idempotencyKey" LIKE '%:' || "patientId"
GROUP BY 1,2;

-- (b) Reservas públicas impagas FUTURAS de más de 30 min: al deployar pasan a
--     "vencidas" y liberan el cupo (otro paciente puede tomar ese horario).
SELECT count(*) FROM "Booking"
WHERE status='PENDING' AND "paymentStatus" IN ('UNPAID','FAILED') AND "patientId" IS NOT NULL
  AND "scheduledFor" > now() AND "createdAt" < now() - interval '30 min';

-- (c) Turnos de AGENDA (no públicos) en PENDING con paciente.
SELECT count(*) FROM "Booking"
WHERE status='PENDING' AND "patientId" IS NOT NULL
  AND "idempotencyKey" NOT LIKE 'pub:%'
  AND "idempotencyKey" !~ '^[^:]+:[^:]+:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z:[^:]+$';

-- (d) Precheck de la migración: el Tenant todavía no tiene las columnas nuevas
--     (si ya existen, la migración falla: revisá _prisma_migrations primero).
SELECT column_name FROM information_schema.columns
WHERE table_name = 'Tenant'
  AND column_name IN ('onboardingCompletedAt','phone','whatsapp','publicEmail');   -- esperado: 0 filas
```

Qué hacer si dan > 0:
- **(a) > 0:** nada; es para saber cuántas reservas viejas entran en la regla de los 30 min.
- **(b) > 0:** **antes del deploy**, confirmar esas reservas a mano (o cobrarlas) desde la agenda. Si no, al
  deployar dejan de retener el cupo y se ven "Pendiente de pago · vencida".
- **(c) > 0:** recomendable pasarlos a CONFIRMED a mano desde la agenda. Desde A2 la agenda ya no deja un turno
  con paciente en PENDING, así que esos quedan en un estado que la app no produce más.
- **(d) > 0:** frenar; la migración ya corrió (o a medias). Revisar `_prisma_migrations` (§2 paso 2).

**2) Backup:** `npm run db:prod:backup`.

**3) Staging primero (antes del merge a `main`):** con los prerrequisitos de EXTERNAL-CONFIG §0.1 cargados en
staging (histórico; desde IAM sin SMTP ni plantillas de Supabase, ver EXTERNAL-CONFIG §0.4: Redirect URLs, "Confirm email" ON, "Secure
password change" OFF, Upstash, DSN), deployar el bloque al Preview de staging. La migración se aplica en staging
con `migrate deploy` contra la DB de staging (el Preview no migra solo). Correr el QA de
[QA.md §Bloque A — A2/A3](QA.md) **incluida la subsección A3c con un email real** (mail abierto en otro
dispositivo, invitación, forgot → reset). Recién con eso verde se mergea.

**4) Migración `20260930120000_tenant_onboarding`** — aditiva: 4 columnas nullable en `Tenant`
(`onboardingCompletedAt`, `phone`, `whatsapp`, `publicEmail`), sin DROP ni NOT NULL, y backfill
`onboardingCompletedAt = createdAt` para los tenants existentes (idempotente). `Tenant` no lleva policy nueva.
La aplica el build de Production al mergear a `main`, o antes, a mano:

```bash
npm run db:prod:deploy
npm run db:prod:status      # → "Database schema is up to date!"
```

Verificar **inmediatamente después** (el cliente vivo no debe ver el stepper de alta):

```sql
SELECT count(*) FROM "Tenant" WHERE "onboardingCompletedAt" IS NULL;   -- tiene que dar 0
```

Si da > 0 (un tenant creado entre la migración y el deploy): `UPDATE "Tenant" SET "onboardingCompletedAt" =
"createdAt" WHERE "onboardingCompletedAt" IS NULL AND "createdAt" < '<momento del deploy>';` solo para tenants
que ya operaban, no para altas nuevas del signup.

**5) Después del deploy — normalizar emails de pacientes** (no es migración; el código nuevo ya guarda los
emails normalizados):

```bash
set -a; . ./.env.prod.local; set +a
# dry-run (default): lista qué cambiaría y las COLISIONES (ids, no emails)
DATABASE_URL="$DIRECT_URL" KINESOFT_CONFIRM_PROD=<project-ref> \
  npx tsx scripts/normalize-patient-emails.ts
# revisar colisiones: dos fichas del mismo consultorio con el "mismo" email.
# Esas NO se tocan; el consultorio decide cuál es la buena (archivar la otra o corregir el email).
DATABASE_URL="$DIRECT_URL" KINESOFT_CONFIRM_PROD=<project-ref> \
  npx tsx scripts/normalize-patient-emails.ts --apply
```

La URL tiene que ser la **owner** (BYPASSRLS): con el rol de la app RLS devuelve 0 fichas y el script aborta.

**6) Verificación final en prod:** login del cliente vivo sin stepper; `curl -I` con HSTS; en Sentry (si hay
DSN) llega un evento de prueba; en Upstash aparecen claves `rl:production:`.

## 2.2 Deploy de B-pre (agenda y catálogo) — orden exacto (01-oct-2026)

> ⚠️ **Obsoleta por el reset de prod (07-oct):** los prechecks de datos y el backfill de `agenda_foundations` (con base vacía no hace nada). El import del catálogo (abajo) **sigue** y es el paso 6 del go-live. El orden vigente está en «Go-live con reset» (tope de este archivo). Se deja como historia hasta el go-live.

> ⚠️ **Hay DOS migraciones nuevas en esta tanda**, en este orden:
> 1. `20260930200000_catalog_global` — catálogo global (Specialty, Practice, PracticeSpecialty, Payer, PayerPlan,
>    CatalogImportRun + enums `CatalogSource`/`PayerKind`), punteros nullable `Insurer.payerId`,
>    `Coverage.payerPlanId`, `Service.practiceId` (FK SET NULL), RLS global de solo lectura y PayerPlan split,
>    índices parciales de PayerPlan. Sin backfill.
> 2. `20261001090000_agenda_foundations` — Location, PractitionerSchedule, ScheduleException, TimeBlock,
>    PractitionerService, PractitionerPayer, PractitionerSpecialty; Booking + `locationId` (RESTRICT),
>    `isOverbooked`, `arrivedAt`, `attendingAt`, `isTelemedicine`, `telemedicineUrl`; `UserPreferences.agendaPrefs`;
>    RLS + CHECKs + índices parciales; **backfill idempotente** con `SET LOCAL row_security = off`.
>
> Las dos son aditivas (expand): ningún DROP ni SET NOT NULL; el código viejo convive con el schema nuevo. Por eso
> van **antes o junto con** el código, nunca después. Lo normal es que las aplique el build de Production al
> mergear a `main`.
>
> **Relación con el Bloque A:** el Bloque A ya está commiteado (`ef3281f`). B-pre puede desplegarse **solo** (si A
> ya está en prod) o **en el mismo deploy** que A. Las reglas de A no cambian (el SMTP propio quedó
> superado por IAM, EXTERNAL-CONFIG §0.4) y A3b no va sin A3c. Si A no está en prod, este deploy lleva también
> `20260930120000_tenant_onboarding` (§2.1): aplicar los prechecks de las dos secciones y el orden de migraciones
> es por timestamp (onboarding → catalog_global → agenda_foundations), que es lo que hace `migrate deploy`.

**1) Prechecks de solo lectura** (SQL Editor de prod o `psql "$DIRECT_URL"` con `.env.prod.local`). Además de los
fijos de §2 paso 2. Anotá cada resultado: los conteos esperados del paso 5 salen de acá.

```sql
-- (a) Rol con el que migra el build (DIRECT_URL). TIENE que ser rolsuper o rolbypassrls:
--     el backfill corre con row_security = off y, sin BYPASSRLS, la migración FALLA a propósito.
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;

-- (b) Las tablas nuevas no existen todavía (todas null). Si alguna existe, frenar y revisar _prisma_migrations.
SELECT to_regclass('"Specialty"'), to_regclass('"Practice"'), to_regclass('"Payer"'), to_regclass('"PayerPlan"'),
       to_regclass('"CatalogImportRun"'), to_regclass('"Location"'), to_regclass('"PractitionerSchedule"'),
       to_regclass('"PractitionerService"'), to_regclass('"TimeBlock"');

-- (c) catalog_global: lo que hoy se tipea a mano (informativo; la migración no lo toca).
SELECT COUNT(*) FROM "Insurer";
SELECT "tenantId", COUNT(*) FROM "Insurer" GROUP BY 1;
SELECT COUNT(*) FILTER (WHERE "planName" IS NOT NULL) FROM "Coverage";
SELECT COUNT(*) FROM "Service";

-- (d) agenda_foundations: base de los conteos esperados.
SELECT COUNT(*) AS tenants FROM "Tenant";
SELECT id, "businessHoursStart", "businessHoursEnd" FROM "Tenant";
--     tenants con horario inválido: quedan SIN franjas (el motor usa el horario del tenant como fallback)
SELECT id FROM "Tenant"
WHERE NOT ("businessHoursStart" >= 0 AND "businessHoursStart" < "businessHoursEnd" AND "businessHoursEnd" <= 24);
--     profesionales con membresía aceptada, por tenant
SELECT p."tenantId", COUNT(*) FROM "Practitioner" p
JOIN "Membership" m ON m."userId"=p."userId" AND m."tenantId"=p."tenantId" AND m."acceptedAt" IS NOT NULL
GROUP BY 1;
--     turnos futuros de profesionales SIN membresía aceptada (no reciben franjas: revisar a mano)
SELECT b."practitionerId", COUNT(*) FROM "Booking" b
WHERE b."scheduledFor" > (now() AT TIME ZONE 'UTC') AND b.status <> 'CANCELLED' AND NOT EXISTS (
  SELECT 1 FROM "Practitioner" p
  JOIN "Membership" m ON m."userId"=p."userId" AND m."tenantId"=p."tenantId" AND m."acceptedAt" IS NOT NULL
  WHERE p.id=b."practitionerId")
GROUP BY 1;
SELECT "practitionerId" IS NULL AS compartido, COUNT(*) FROM "Service" GROUP BY 1;
SELECT COUNT(*) FROM "Insurer" WHERE active;
--     turnos de un servicio "propio" de OTRO profesional: el paso 3b del backfill los habilita como PRIVATE
SELECT COUNT(*) FROM "Booking" b JOIN "Service" s ON s.id=b."serviceId"
WHERE s."practitionerId" IS NOT NULL AND s."practitionerId"<>b."practitionerId" AND b.status<>'CANCELLED';
--     sobreturnos marcados por prefijo (= isOverbooked esperado)
SELECT COUNT(*) FROM "Booking" WHERE notes LIKE '[SOBRETURNO]%';
--     turnos futuros fuera del horario del tenant o en domingo: siguen en la agenda; desde B-pre reprogramarlos
--     o reactivarlos da el aviso blando "fuera de horario" (se fuerza, no se rechaza). Informativo.
SELECT COUNT(*) FROM "Booking" b JOIN "Tenant" t ON t.id=b."tenantId"
--     OJO (corregido en el Paso 0 de Planes, 03-oct): las columnas son TIMESTAMP(3) SIN zona y guardan UTC.
--     `col AT TIME ZONE 'America/...'` sobre un timestamp sin zona lo interpreta COMO hora AR y devuelve UTC:
--     corría la hora 3 h al revés. La hora AR es ((col AT TIME ZONE 'UTC') AT TIME ZONE 'America/...'),
--     y "ahora" comparable es (now() AT TIME ZONE 'UTC').
WHERE b."scheduledFor" > (now() AT TIME ZONE 'UTC') AND b.status <> 'CANCELLED' AND (
  EXTRACT(DOW FROM ((b."scheduledFor" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Argentina/Buenos_Aires'))=0
  OR EXTRACT(HOUR FROM ((b."scheduledFor" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Argentina/Buenos_Aires')) < t."businessHoursStart"
  OR EXTRACT(HOUR FROM ((b."scheduledFor" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Argentina/Buenos_Aires')) >= t."businessHoursEnd");
SELECT COUNT(*) FROM "Booking";
```

Qué hacer si:
- **(a)** no tiene `rolsuper` ni `rolbypassrls` → **frenar**: corregir `DIRECT_URL` en Vercel al owner antes del
  merge (si no, el deploy falla en la migración 2 y no queda nada a medias, pero no sale).
- **(b)** alguna no es null → frenar, revisar `_prisma_migrations` (§2 paso 2).
- **turnos de profesionales sin membresía aceptada > 0** → no rompen nada (el motor les aplica el horario del
  tenant), pero conviene reasignarlos o re-aceptar la membresía.

**2) Backup:** `npm run db:prod:backup`.

**3) Staging primero (antes del merge a `main`):** `migrate deploy` contra la DB de staging (el Preview no migra
solo) → correr los mismos prechecks y los conteos del paso 5 → QA de [QA.md §B-pre](QA.md) con `TZ=UTC` → import
del catálogo en staging (paso 6). Recién con eso verde se mergea.

**4) Aplicar en prod:** merge a `main` (el build de Production aplica las dos), o antes a mano:

```bash
npm run db:prod:deploy
npm run db:prod:status      # → "Database schema is up to date!"
```

Si se aplican a mano **antes** del deploy del código, en el hueco el código viejo sigue andando (todo es nullable
o con default). Lo único que queda desfasado se corrige en el paso 5.

**5) Post-deploy (inmediatamente después de que el código nuevo esté vivo):**

```sql
-- (a) Sobreturnos que el código VIEJO cargó entre la migración y el deploy (solo escribía el prefijo):
UPDATE "Booking" SET "isOverbooked" = true WHERE notes LIKE '[SOBRETURNO]%' AND NOT "isOverbooked";

-- (b) Conteos esperados
SELECT COUNT(*) FROM "Location";                       -- = #tenants (una "Principal" por tenant)
SELECT COUNT(*) FROM "Location" WHERE "isPrimary";     -- = #tenants
SELECT COUNT(*) FROM "PractitionerSchedule";           -- = 6 × profesionales aceptados (de tenants con horario válido)
SELECT COUNT(*) FROM "Booking" WHERE "locationId" IS NULL;                  -- = 0
SELECT COUNT(*) FROM "Booking" WHERE "isOverbooked";   -- = conteo de '[SOBRETURNO]%' del precheck (+ los nuevos)
SELECT visibility, COUNT(*) FROM "PractitionerService" GROUP BY 1;          -- PRIVATE = pares del paso 3b
SELECT COUNT(*) FROM "PractitionerPayer";              -- = aceptados × insurers activos, por tenant
-- (c) RLS del catálogo: solo SELECT
SELECT tablename, policyname, cmd FROM pg_policies
WHERE tablename IN ('Specialty','Practice','PracticeSpecialty','Payer','CatalogImportRun','PayerPlan')
ORDER BY 1, 2;
```

- **(d) Re-correr el backfill** si entre la migración y el deploy del código se creó un tenant, se aceptó una
  invitación o se cargó un servicio/obra social (esas altas nacen sin sede/franjas/PS/PP con el código viejo; el
  código nuevo ya las crea con `lib/agenda-defaults.ts`). Es idempotente: re-correrlo no cambia lo ya hecho.
  Owner connection:

  ```bash
  set -a; . ./.env.prod.local; set +a
  M=prisma/migrations/20261001090000_agenda_foundations/migration.sql
  { echo 'BEGIN;'
    sed -n '/>>> BACKFILL agenda_foundations BEGIN/,/<<< BACKFILL agenda_foundations END/p' "$M"
    echo 'COMMIT;'; } | psql "$DIRECT_URL" -v ON_ERROR_STOP=1
  # Para acotarlo a ciertos tenants: agregar, después de BEGIN,
  #   SET LOCAL kinesoft.backfill_tenants = '<id1>,<id2>';
  ```

  Después, repetir los conteos de (b). Con el deploy por merge (migración y código juntos) el hueco es de
  segundos y normalmente no hace falta.

**6) Import del catálogo** (lo corre Martin; no es migración; **staging primero**, después prod):

```bash
npm run db:prod:backup                     # backup antes (en staging, el suyo)
# dry-run (default): imprime el diff y los conflictos, no escribe. Lee prod → pide el project ref.
KINESOFT_CONFIRM_PROD=<project-ref> npx dotenv -e .env.prod.local -- npx tsx scripts/catalog-import.ts
# revisar conflictos (siglas ambiguas, referencias desconocidas): esas filas no se escriben, el resto sí
KINESOFT_CONFIRM_PROD=<project-ref> npx dotenv -e .env.prod.local -- npx tsx scripts/catalog-import.ts --apply
# verificación: otro dry-run tiene que dar 0 cambios
KINESOFT_CONFIRM_PROD=<project-ref> npx dotenv -e .env.prod.local -- npx tsx scripts/catalog-import.ts
```

- Usa `DIRECT_URL` (owner) y aborta si la conexión no tiene BYPASSRLS: el catálogo es de solo lectura para el rol
  de la app. Escribe todo en **una** tx (o entra completo o nada) y deja un `CatalogImportRun` por archivo.
- Nunca pisa una fila curada en Plataforma (`curatedAt`), no desarchiva y los `*.seed-*.csv` solo crean.
- El script corre fuera de Next y no puede invalidar el cache: **Plataforma → Catálogo → Importaciones →
  "Refrescar catálogo"**. Sin eso, los consultorios ven el catálogo viejo hasta que expire el cache (1 h).
- Después de un import grande, `ANALYZE` (lección de PERF.md: sin estadísticas el planner elige mal).
- Local: `npm run catalog:import` (dry-run) y `npm run catalog:import -- --apply`.

**7) Verificación final en prod:** el cliente vivo entra a `/agenda` y ve lo mismo que antes (sus turnos, su
horario); en Configuración → Profesionales tiene franjas lun-sáb con el horario del consultorio; el turnero
público ofrece los mismos horarios que antes; un sobreturno viejo muestra el badge.

**Rollback:** volver el deploy de Vercel al commit anterior. El schema nuevo es compatible con el código viejo
(columnas nullable o con default, tablas nuevas sin uso). Las filas que cargue el código nuevo (sedes, franjas,
bloqueos) quedan y se reusan al volver a desplegar.

## 2.3 Planes: preparación del deploy de M1 (`plans_booking_link`) — desde ES1 (04-oct-2026)

> ⚠️ **Obsoleta por el reset de prod (07-oct):** el dedupe de `(programId, index)` y los prechecks (2) y (15). El (17) Storage privado **sigue** (paso 10 del go-live). El orden vigente está en «Go-live con reset» (tope de este archivo). Se deja como historia hasta el go-live.

> **ES1 (Planes P0) no tiene migraciones.** La única migración de Planes es M1 `plans_booking_link`, escrita y
> aplicada en local en ES2a (04-oct). Por la decisión del 04-oct va en **un solo deploy al cierre del bloque B**,
> después de `catalog_global` y `agenda_foundations`. Esta sección deja lo que ES1 preparó (el dedupe y dos prechecks
> que vencen antes del deploy); el deploy en sí está en **§2.4**.

**Prechecks de solo lectura** (los SQL completos están en PLANES.md §16; acá los que trajo ES1):

```sql
-- (2) BLOQUEANTE para M1: sesiones repetidas (programId, index). Si > 0 → dedupe (abajo).
SELECT count(*) FROM (SELECT "programId","index" FROM "Session" GROUP BY 1,2 HAVING count(*)>1) x;

-- (15) Pacientes asignados a ASSISTANT/BILLING (S07sp). Si > 0: REASIGNARLOS con "Asignar profesional"
--      (assignPatientToPractitioner) ANTES del deploy. Con el nivel `admin` esa Secretaria deja de tener full
--      sobre "sus" pacientes y el kine tiene que quedar a cargo.
SELECT count(*) FROM "Patient" p
JOIN "Practitioner" pr ON pr.id = p."assignedPractitionerId"
JOIN "Membership" m ON m."userId" = pr."userId" AND m."tenantId" = p."tenantId"
WHERE m.role IN ('ASSISTANT','BILLING');

-- (17) Storage (S02m): buckets privados y ninguna policy de storage.objects para anon/authenticated.
SELECT id, public FROM storage.buckets;
SELECT policyname, roles, cmd FROM pg_policies WHERE schemaname='storage' AND tablename='objects';
```

- **(17):** desde ES1 la app usa Storage **solo con service role** (`lib/storage-internal.ts`), así que
  `SUPABASE_SERVICE_ROLE_KEY` **tiene que estar en Vercel** (Production y staging) antes del deploy; sin ella, subir,
  firmar y borrar archivos fallan cerrado. Si (17) muestra un bucket `public = true` o una policy para `anon` /
  `authenticated` sobre `patient-files` o `exercise-media`, es una **fuga de bloque A**: hacer privado el bucket y
  dropear esas policies **en el mismo deploy** en que el código pasa a service role (ni antes, porque el código viejo
  las usa, ni después, porque quedarían abiertas). En el SQL Editor: `DROP POLICY "<nombre>" ON storage.objects;`
  por cada una, con backup previo.

**Dedupe de `(programId, index)`** (S02x; lo corre Martin; no es migración). Es una herramienta **pre-M1**: M1 crea el
único parcial `Session_programId_index_live_key` y aborta si hay repetidos. El script renumera: en cada grupo conserva el
id menor y manda el resto, en id asc, a `max+1`, `+2`… del programa. No borra nada ni toca `SessionExercise`,
`EvaScore`, `totalSessions` ni `Booking`. Idempotente. Dry-run por defecto (tx READ ONLY); aborta sin BYPASSRLS (bajo
RLS vería 0 sesiones = falso verde). Imprime el mapeo viejo → nuevo con ids, sin PHI. Requiere
`--conditions=react-server` (importa un módulo `server-only`).

```bash
# Local (Docker :5433)
npm run plans:dedupe-session-index                 # dry-run (local, con M1 aplicada: 0 movimientos)
npm run plans:dedupe-session-index -- --apply

# Prod (y staging, con su .env): NUNCA el script npm (lee .env.local). Pide el project ref.
KINESOFT_CONFIRM_PROD=<project-ref> npx dotenv -e .env.prod.local -- npx tsx --conditions=react-server scripts/plans-dedupe-session-index.ts
# opcional: --tenant=<id>[,<id>…] limita el alcance
```

**Orden** (staging primero, después prod), **inmediatamente antes del deploy de M1 y en la misma ventana sin uso**
(entre el dedupe y M1 no puede entrar una sesión a medida nueva que vuelva a duplicar):
1. precheck (2);
2. backup (`npm run db:prod:backup`);
3. dry-run;
4. revisar el mapeo (qué sesiones cambian de número);
5. `--apply`;
6. dry-run otra vez → **tiene que dar 0**;
7. recién ahí, el deploy con M1 (§2.4).

Aviso al usuario: las sesiones movidas cambian su "Sesión n" (pasan al final del plan).

**Después de M1** el script sigue andando pero no tiene nada que hacer: si existe `Session.archivedAt`, agrupa solo las
sesiones **vivas** (`"archivedAt" IS NULL`, F2 de P1.Z), igual que el único parcial. Una archivada que repite el index de
una viva no es duplicado, y el dry-run da 0. `tests/integration/plans-dedupe.test.ts` lo prueba post-M1 (dry-run = 0,
archivada + viva = 0, se niega sin BYPASSRLS); el apply con duplicados quedó probado en ES1 y en el unit del
planificador.

## 2.4 Deploy de M1 (`plans_booking_link`) — escrita en ES2a (04-oct-2026)

> ⚠️ **Obsoleta por el reset de prod (07-oct):** los prechecks de datos, la ventana sin uso, el orden incremental y el down-script. **Siguen:** el precheck (0), el P3009 (liviano: re-reset) y los post-checks objeto por objeto. El orden vigente está en «Go-live con reset» (tope de este archivo). Se deja como historia hasta el go-live.

> **Hay 1 migración nueva:** `20261004120000_plans_booking_link` (sha256 de `migration.sql` =
> `7a0e279799547192c135e70f5e87dbe28db873406de67efee7ec9872300445cd`). Aplicada y verificada en el Docker local; en
> staging y prod **no**. Va en el deploy único del cierre de B. Qué crea: PLANES.md §3 (el bloque SQL es idéntico al
> archivo). Incluye la **única excepción** a "todo aditivo", aprobada por Martin el 03-oct: `DROP INDEX
> "Patient_userId_key"`, reemplazado por `Patient_tenantId_userId_key`.

### Prechecks (solo lectura; SQL completo en PLANES.md §16)

| # | Qué | Esperado | Si no |
|---|---|---|---|
| (0) | rol de `DIRECT_URL` y migraciones previas | `rolbypassrls = t`; B-pre aplicado, nada fallido | sin BYPASSRLS, el backfill **aborta** M1 (guarda a propósito): usar el owner |
| (1) | M1 no corrió | 0 columnas/tipos; `to_regclass` null en las 2 tablas y los 2 índices nuevos; `Patient_userId_key` presente | frenar |
| (2) | duplicados `(programId, index)` | 0 | dedupe (§2.3) en la misma ventana |
| (3) | integridad cross-tenant | 0 en las 4 | frenar |
| (4) | `idempotencyKey LIKE 'plan:%'` y `copagoCents < 0` | 0 | frenar |
| (5) | volumen (Booking, Session, Patient) | dimensiona el lock | — |
| (11) | slugs `kinesiologia` / `osteopatia` | libres o ya `kind = 'DISCIPLINE'` | renombrar el tag ajeno antes: el `ON CONFLICT` es por slug, pero un id `tag_discipline_*` usado con otro slug choca por PK |
| (15) / (17) | Secretaria asignada / Storage | §2.3 | §2.3 |

```sql
-- (2) y (11), los bloqueantes que más se mueven entre staging y prod
SELECT count(*) FROM (SELECT "programId","index" FROM "Session" GROUP BY 1,2 HAVING count(*)>1) x;   -- 0
SELECT id, slug, kind FROM "Tag" WHERE slug IN ('kinesiologia','osteopatia') OR id LIKE 'tag_discipline_%' OR kind='DISCIPLINE';
```

### Ventana sin uso (no solo por el dedupe)

M1 es **una** transacción. Cada `ALTER TABLE` toma ACCESS EXCLUSIVE y lo retiene hasta el `COMMIT`: sobre
`TreatmentProgram`, `Session`, `Booking`, `PlanTemplate`, `EvaScore` y `Service`, y el `DROP INDEX` toma ACCESS
EXCLUSIVE sobre `Patient` (bloquea **también lecturas**: la ficha y la agenda esperan). Como toma TreatmentProgram y
Session antes que Booking, un turno en vuelo que tenga Booking y vaya a leer el plan puede cruzarse en un deadlock; el
`lock_timeout = '5s'` hace que falle rápido en vez de colgar la agenda. Con el volumen actual son milisegundos, pero se
hace en horario sin uso (el mismo de §2.3) y con el cliente avisado.

### Orden en prod (deploy único al cierre de B)

1. Prechecks (0)-(4), (11), (13), (15) y (17), primero en staging y después en prod.
2. Si (2) > 0: dedupe según §2.3 (dry-run → revisar → `--apply` → dry-run = 0).
3. `npm run db:prod:backup` (en staging, el suyo).
4. **Staging:** `migrate deploy` de todas las pendientes **en orden**: `catalog_global` → `agenda_foundations` →
   `plans_booking_link`; post-checks de abajo; QA de B-pre y de Planes con `TZ=UTC`.
5. **Prod:** merge de develop a `main` en la ventana sin uso. El build de Production aplica las migraciones **antes**
   de servir el código nuevo (`scripts/vercel-build.mjs`); si M1 falla, el build falla y sigue sirviendo el deploy
   anterior.
6. Post-checks en prod. Después, los pasos post-deploy de PLANES.md §16 (paso 4).

**GUC del backfill:** `kinesoft.backfill_tenants` acota el backfill del responsable a ciertos tenants (lo usan los
tests). En prod **no se setea** (= todos). Si alguna vez se acota, va **sin espacios**: `'id1,id2'`
(`string_to_array` no recorta y `' id2'` no matchea nada, en silencio).

### Si falla: P3009

Cualquier error dentro de la tx (`lock_timeout`, duplicado `(programId, index)`, rol sin BYPASSRLS por la guarda del
backfill, un id `tag_discipline_*` ya usado con otro slug) hace **ROLLBACK completo**: la base queda como antes, pero
`_prisma_migrations` registra M1 como fallida y el próximo `migrate deploy` corta con **P3009**. Corregir la causa y:

```bash
npx dotenv -e .env.prod.local -- npx prisma migrate resolve --rolled-back 20261004120000_plans_booking_link
npm run db:prod:status        # M1 vuelve a figurar como pendiente
# reintentar: redeploy en Vercel (o npm run db:prod:deploy)
```

### Post-checks (objeto por objeto)

```sql
-- Registro: M1 aplicada una vez, sin error
SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name LIKE '%plans_booking_link';
-- checksum = 7a0e279799547192c135e70f5e87dbe28db873406de67efee7ec9872300445cd

-- Tablas nuevas con RLS: t,t en las dos; una policy <tabla>_tenant_isolation por tabla; vacías
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('ProgramAuthorization','PatientChangeRequest');
SELECT tablename, policyname FROM pg_policies WHERE tablename IN ('ProgramAuthorization','PatientChangeRequest');
SELECT (SELECT count(*) FROM "ProgramAuthorization") pa, (SELECT count(*) FROM "PatientChangeRequest") pcr;

-- Identidad del portal: el viejo no está, los 2 nuevos sí
SELECT to_regclass('"Patient_userId_key"') viejo, to_regclass('"Patient_tenantId_userId_key"') por_tenant,
       to_regclass('"Patient_id_tenantId_key"') destino_fk;

-- Los 4 únicos parciales, con su predicado
SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('Session_programId_index_live_key','Booking_session_active_key',
  'ProgramAuthorization_programId_current_key','PatientChangeRequest_patient_pending_key');

-- FKs compuestas y CHECKs (nombres de PLANES §3)
SELECT conrelid::regclass, conname, contype FROM pg_constraint
WHERE conname LIKE 'Booking_plan_%' OR conname LIKE 'Booking_session_%' OR conname LIKE 'Booking_priced_%'
   OR conname LIKE 'TreatmentProgram_%_check' OR conname LIKE 'PlanTemplate_%_check' OR conname LIKE 'Session_%_check'
   OR conname LIKE 'ProgramAuthorization_%' OR conname LIKE 'PatientChangeRequest_%' ORDER BY 1,2;

-- Pricing con IS NOT DISTINCT FROM (F1): Postgres lo guarda como NOT (… IS DISTINCT FROM …); ok = t en las 2
SELECT conname, pg_get_constraintdef(oid) LIKE '%NOT ("pricingMode" IS DISTINCT FROM%' ok FROM pg_constraint
WHERE conname IN ('TreatmentProgram_pricing_check','PlanTemplate_pricing_check');

-- Datos: M1 no vinculó turnos; tags DISCIPLINE = 2; backfill del responsable
SELECT count(*) FROM "Booking" WHERE "programId" IS NOT NULL OR "pricedByPlan";                -- 0
SELECT count(*) FROM "Tag" WHERE kind='DISCIPLINE' AND slug IN ('kinesiologia','osteopatia');  -- 2
SELECT count(*) FILTER (WHERE "practitionerId" IS NOT NULL) con_responsable,
       count(*) FILTER (WHERE "practitionerId" IS NULL AND EXISTS (SELECT 1 FROM "Session" s WHERE s."programId"=p.id)) sin_responsable_con_sesiones
FROM "TreatmentProgram" p;   -- sin_responsable_con_sesiones = 0, salvo profesionales de otro tenant (los descarta el EXISTS)
```

**Drift esperado.** `npx dotenv -e .env.prod.local -- npx prisma migrate diff --from-schema-datasource
prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script` (solo lee) tiene que mostrar **exactamente 3
líneas**: `DROP CONSTRAINT "Booking_plan_patient_fkey"`, `"Booking_plan_tenant_fkey"` y `"Booking_session_program_fkey"`
(las FKs compuestas de Booking que el schema no declara; drift aceptado). Prisma 5 no ve los CHECK, los predicados de los
únicos parciales ni las policies, así que no aparecen. Cualquier otra línea → frenar y avisar. **Nunca** se corre
`migrate dev` para "arreglarlo": borraría esos objetos.

### Rollback

1. **Lo normal:** volver el deploy de Vercel al commit anterior. El código viejo tolera M1 (columnas nuevas null o con
   default, tablas nuevas vacías, CHECKs que se cumplen sin vínculo, búsquedas por `Patient.userId` con `findFirst`).
   La migración **no** se baja.
2. **Down-script** (PLANES.md §3 «Rollback»): solo con backup previo y decisión de Martin. Una tx; si el chequeo del
   paso 3 encuentra un `userId` repetido, aborta todo (hay pacientes del portal vinculados en más de un consultorio:
   frenar y decidir antes).

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
-- 1. Tablas nuevas (arrastran sus policies, índices y FKs)
DROP TABLE "PatientChangeRequest";
DROP TABLE "ProgramAuthorization";
-- 2.
DROP TYPE "PatientChangeRequestStatus";
-- 3. Patient_userId_key vuelve SOLO si no hay userId repetidos
DO $$ BEGIN
  IF (SELECT count(*) FROM (SELECT "userId" FROM "Patient" WHERE "userId" IS NOT NULL GROUP BY 1 HAVING count(*)>1) x) > 0 THEN
    RAISE EXCEPTION 'Patient.userId repetido en más de un consultorio: no se recrea Patient_userId_key. Frenar.';
  END IF;
END $$;
CREATE UNIQUE INDEX "Patient_userId_key" ON "Patient"("userId");
DROP INDEX "Patient_tenantId_userId_key";
DROP INDEX "Patient_id_tenantId_key";
-- 4. El resto, en orden inverso al SQL de M1
DROP INDEX "EvaScore_sessionId_idx";
ALTER TABLE "EvaScore" DROP CONSTRAINT "EvaScore_sessionId_fkey", DROP COLUMN "sessionId", DROP COLUMN "note";

DROP INDEX "PlanTemplate_tenantId_discipline_idx";
DROP INDEX "PlanTemplate_serviceId_idx";
ALTER TABLE "PlanTemplate"
  DROP CONSTRAINT "PlanTemplate_schedule_check", DROP CONSTRAINT "PlanTemplate_duration_check",
  DROP CONSTRAINT "PlanTemplate_price_nonneg_check", DROP CONSTRAINT "PlanTemplate_pricing_check",
  DROP CONSTRAINT "PlanTemplate_serviceId_fkey",
  DROP COLUMN "archivedAt", DROP COLUMN "notes", DROP COLUMN "totalPriceCents", DROP COLUMN "pricePerSessionCents",
  DROP COLUMN "pricingMode", DROP COLUMN "schedule", DROP COLUMN "durationMin", DROP COLUMN "serviceId", DROP COLUMN "discipline";

DROP INDEX "Booking_session_active_key";
DROP INDEX "Booking_sessionId_idx";
DROP INDEX "Booking_tenantId_programId_idx";
ALTER TABLE "Booking"
  DROP CONSTRAINT "Booking_priced_by_plan_check", DROP CONSTRAINT "Booking_plan_patient_check",
  DROP CONSTRAINT "Booking_plan_link_check", DROP CONSTRAINT "Booking_session_program_fkey",
  DROP CONSTRAINT "Booking_plan_patient_fkey", DROP CONSTRAINT "Booking_plan_tenant_fkey",
  DROP CONSTRAINT "Booking_sessionId_fkey", DROP CONSTRAINT "Booking_programId_fkey",
  DROP COLUMN "pricedByPlan", DROP COLUMN "sessionId", DROP COLUMN "programId";

DROP INDEX "Session_programId_index_live_key";
DROP INDEX "Session_id_programId_key";
ALTER TABLE "Session" DROP CONSTRAINT "Session_priceCents_check",
  DROP COLUMN "updatedAt", DROP COLUMN "archivedAt", DROP COLUMN "priceCents", DROP COLUMN "title";

DROP INDEX "TreatmentProgram_templateId_idx";
DROP INDEX "TreatmentProgram_locationId_idx";
DROP INDEX "TreatmentProgram_serviceId_idx";
DROP INDEX "TreatmentProgram_practitionerId_idx";
DROP INDEX "TreatmentProgram_tenantId_discipline_status_idx";
DROP INDEX "TreatmentProgram_id_patientId_key";
DROP INDEX "TreatmentProgram_id_tenantId_key";
DROP INDEX "TreatmentProgram_tenantId_idempotencyKey_key";
ALTER TABLE "TreatmentProgram"
  DROP CONSTRAINT "TreatmentProgram_schedule_check", DROP CONSTRAINT "TreatmentProgram_duration_check",
  DROP CONSTRAINT "TreatmentProgram_price_nonneg_check", DROP CONSTRAINT "TreatmentProgram_pricing_check",
  DROP CONSTRAINT "TreatmentProgram_templateId_fkey", DROP CONSTRAINT "TreatmentProgram_locationId_fkey",
  DROP CONSTRAINT "TreatmentProgram_serviceId_fkey", DROP CONSTRAINT "TreatmentProgram_practitionerId_fkey",
  DROP COLUMN "archivedAt", DROP COLUMN "updatedAt", DROP COLUMN "idempotencyKey", DROP COLUMN "notes",
  DROP COLUMN "totalPriceCents", DROP COLUMN "pricePerSessionCents", DROP COLUMN "pricingMode", DROP COLUMN "schedule",
  DROP COLUMN "durationMin", DROP COLUMN "templateId", DROP COLUMN "locationId", DROP COLUMN "serviceId",
  DROP COLUMN "practitionerId", DROP COLUMN "discipline";

ALTER TABLE "Service" DROP COLUMN "discipline";
DROP TYPE "ProgramPricingMode";
DROP TYPE "Discipline";
-- Los 2 tags DISCIPLINE se dejan (el enum TagKind ya tenía DISCIPLINE desde la Ronda 7).
COMMIT;
```

3. **Marcar M1 como revertida** en `_prisma_migrations`; sin esto Prisma la sigue dando por aplicada y nunca la
   re-aplica:

```bash
npx dotenv -e .env.prod.local -- npx prisma migrate resolve --rolled-back 20261004120000_plans_booking_link
```

   ⚠️ Prisma documenta `--rolled-back` para migraciones **fallidas**; sobre una que terminó bien puede negarse (P3012,
   "not in a failed state"). En ese caso, con el backup ya hecho y en el SQL Editor:
   `UPDATE _prisma_migrations SET rolled_back_at = now() WHERE migration_name = '20261004120000_plans_booking_link';`
   (Prisma ignora las filas con `rolled_back_at` y la vuelve a aplicar en el próximo deploy). Probarlo primero en
   staging.

### Nota: bases que aplicaron la versión vieja de M1 (antes de F1)

En P1.Z se enmendó C1 (F1): `TreatmentProgram_pricing_check` y `PlanTemplate_pricing_check` pasaron de `=` a `IS NOT
DISTINCT FROM`, porque con `pricingMode` NULL el `=` da NULL (lógica de 3 valores) y el CHECK dejaba pasar un precio sin
modo. Prod y staging nunca la aplicaron. Si alguna base (otro Docker, un staging de prueba) ya tiene la versión
vieja, `migrate deploy` corta por checksum distinto. Arreglo, con backup, sin re-correr M1:

```sql
BEGIN;
ALTER TABLE "TreatmentProgram" DROP CONSTRAINT "TreatmentProgram_pricing_check",
  ADD CONSTRAINT "TreatmentProgram_pricing_check" CHECK (
       ("pricingMode" IS NULL AND "pricePerSessionCents" IS NULL AND "totalPriceCents" IS NULL)
    OR ("pricingMode" IS NOT DISTINCT FROM 'PER_SESSION' AND "pricePerSessionCents" IS NOT NULL AND "totalPriceCents" IS NULL)
    OR ("pricingMode" IS NOT DISTINCT FROM 'PACKAGE' AND "totalPriceCents" IS NOT NULL AND "pricePerSessionCents" IS NULL));
ALTER TABLE "PlanTemplate" DROP CONSTRAINT "PlanTemplate_pricing_check",
  ADD CONSTRAINT "PlanTemplate_pricing_check" CHECK (
       ("pricingMode" IS NULL AND "pricePerSessionCents" IS NULL AND "totalPriceCents" IS NULL)
    OR ("pricingMode" IS NOT DISTINCT FROM 'PER_SESSION' AND "pricePerSessionCents" IS NOT NULL AND "totalPriceCents" IS NULL)
    OR ("pricingMode" IS NOT DISTINCT FROM 'PACKAGE' AND "totalPriceCents" IS NOT NULL AND "pricePerSessionCents" IS NULL));
UPDATE _prisma_migrations SET checksum = '7a0e279799547192c135e70f5e87dbe28db873406de67efee7ec9872300445cd'
WHERE migration_name = '20261004120000_plans_booking_link';
COMMIT;
```

Si el `ADD CONSTRAINT` falla, hay filas con precio y sin modo: corregirlas antes (son justo las que el CHECK viejo dejaba
pasar).

## 3. Rollback

Prisma no revierte automáticamente. El rollback real es **volver el deploy de Vercel** al commit anterior: las
migraciones son aditivas y el código viejo sigue andando sobre el schema nuevo (columnas nuevas con default, tablas
nuevas sin uso). Si hiciera falta revertir el DDL, se escribe una migración inversa nueva; nunca se edita una ya
aplicada. Hasta el go-live con reset (07-oct), el rollback de un `migrate deploy` fallido es re-reset y volver a aplicar
(«Go-live con reset»); el down-script de M1 (§2.4) quedó sin uso.

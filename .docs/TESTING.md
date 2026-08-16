# KineSoft — Estándar de testing (diagrama de la suite)

> **Qué es este documento.** El diseño de la suite de tests de KineSoft — la Parte 4 del
> [ENGINEERING-MANUAL.md](ENGINEERING-MANUAL.md) instanciada para este producto. **Es un diagrama,
> no la implementación:** define las capas, qué se testea en cada una, los guards estáticos y el
> checklist de QA manual. La implementación se ejecuta en las sesiones `ci-gate-minimo` (capa 1) y
> `suite-integracion` / `ci-pipeline-completo-y-guard` (capas 3-4 + guards) del [ROADMAP.md](ROADMAP.md).
>
> **Estado actual: cero tests, cero CI** (findings `no-test-suite`, `no-ci-triple-gate` en
> [AUDIT.md](AUDIT.md)). La única verificación hoy es `tsc --noEmit` + `next build` a mano.

## Regla de oro: los fixes de timezone van ANTES que la suite de integración

Si la suite se escribe contra el comportamiento actual, **consagra los bugs de host-tz**
(F-A2/A3/A4/A5). Por eso Etapa 1 solo siembra **capa 1** sobre helpers que ya son correctos
(`lib/datetime-ar.ts`, `lib/format.ts`, `resolveBookingCopagoCents`) — la referencia contra la que
se corrigen los bugs — y la suite completa (capas 2-4) llega en la Ola 2.1, con las olas 1.1-1.2 ya
cerradas.

Corolario operativo: **todo QA de fechas se corre con `TZ=UTC`** (Docker o preview de Vercel). En dev
AR-local los bugs de fecha no se reproducen.

---

## La pirámide de 4 capas — instanciada

### Capa 1 — Unit de lógica pura (vitest; sin red ni DB)

Corre en milisegundos. Candidatos **ya puros** (arrancar acá, Etapa 1):

| Módulo | Qué protege |
|---|---|
| `lib/datetime-ar.ts` | `localToARIso`/`toARDateKey`/`toARDow`/`toARHour` — el corazón del correctness de fechas. Casos borde: cambio de día cerca de medianoche AR, string con offset vs pelado, dow domingo=0. |
| `resolveBookingCopagoCents` (`lib/billing-internal.ts`) | La escalera de precedencia de copago (Booking → Coverage → insurer → Particular → service); que `0` sea intencional en cada nivel. |
| `lib/format.ts` | `formatARS` (salida) y el futuro `parseARS` (entrada: `"1.500,50"` → 150050 cents) de la sesión `money-input-parser`. |
| `lib/diagnosis-engine.ts` | Ranking por overlap región+síntoma+trigger (cuando Etapa 3 lo active). |

Precondición para lo que hoy **no** es puro (sesión `extraccion-logica-pura`, Ola 2.1): sacar la
lógica de negocio de archivos `"use server"` y componentes cliente a módulos puros que reciben sus
dependencias (cliente Prisma, reloj, generador de ids) como argumento. La acción queda como shell
fino: autenticar → autorizar → I/O → delegar. Findings `logica-en-use-server-y-cliente`,
`export-type-en-use-server`.

### Capa 2 — Component con I/O mockeado (vitest + testing-library)

Render + interacción + estados de carga/error, con timers falsos y las server actions mockeadas en
el borde. Prioridad tras el split (Ola 2.0): el `BookingModal` (creación de turno), el StatusTag
exhaustivo de la agenda, los tres estados de las vistas de datos (skeleton / vacío real /
error-con-retry — finding `sin-error-loading-boundaries`).

### Capa 3 — Integración con tenant efímero contra Postgres real (Docker 5433)

La costura más peligrosa (RLS, constraints, concurrencia). Dos piezas la sostienen:

- **Fábrica de tenant efímero reusable** (una función compartida, no copiada) que crea tenant +
  credenciales reales + datos base, atravesando la auth real para que las policies se ejerciten de
  verdad. Base a partir de `prisma/seed.ts` / `scripts/create-tenant.ts` (hoy scripts ad-hoc que
  cumplen rol de test — finding `scripts-adhoc-como-tests`).
- **Barredor de huérfanos** al inicio de la suite (limpia tenants de corridas que crashearon).

Tests obligatorios de esta capa:

1. **Tripwire de aislamiento cross-tenant** (finding `sin-test-tripwire-aislamiento`): crea 2 tenants
   y falla si uno lee datos del otro. **Es el test que valida que la Ola 2.2 (RLS real) funciona** —
   debe correr con el rol sin BYPASSRLS.
2. **Concurrencia de booking**: N `createBooking` simultáneos sobre el mismo `(practitionerId, slot)`
   → exactamente uno gana (valida `booking-concurrencia`); el sobreturno intencional sigue posible.
3. **Impersonación de actores**: setear el claim de sesión (identidad/rol/tenant) dentro de una tx
   que se descarta, para cubrir en segundos "actor sin sesión", "actor de otro tenant", "PRACTITIONER
   no puede hard-delete" — sin un login real por combinación.
4. **Regresión de copago** al reemplazar cobertura (valida `copago-snapshot`).

### Capa 4 — E2E en navegador real (Playwright, gateado)

Flujos completos: **wizard de reserva pública** (el que cobra por MP — camino dorado), login con
feedback de error, y el portal del paciente. Cubre hidratación, navegación, prefetch, CSP real.
Corre gateado (rama principal / pre-corte), porque es lo más lento y ruidoso.

> **Qué NO testear** (decisión explícita, no descuido): no mockear los internals de Next para invocar
> server actions "directo" (harness frágil); no reproducir el contrato de la API de Mercado Pago en
> un mock (usar el no-op documentado + un smoke test aislado con sandbox); el copago/precisión de
> dinero se cubre en capa 1, no en E2E.

---

## Guards estáticos de seguridad (capa de mayor apalancamiento)

Corren en CI **sin levantar DB ni server**, parseando el repo. Sesión `ci-pipeline-completo-y-guard`.

- **`scripts/guard-tenant-isolation.mjs`** — parsea las **3 fuentes** que hoy divergen a mano
  (finding `no-static-security-guard`): modelos con `tenantId` en `prisma/schema.prisma` (20),
  `TENANT_SCOPED_MODELS` en `lib/db.ts` (9), y los arrays de `ENABLE/FORCE RLS` + policy directa de
  `prisma/migrations/policies.sql` (17). **Falla el build** si un modelo con `tenantId` directo no
  está en RLS forzada, o si a un modelo indirecto le falta su policy por subquery. Baseline tolerado
  hasta que la Ola 2.2 cierre las 9 tablas faltantes; después, cero tolerancia.
- **Allowlist del admin client** — falla si `getSupabaseAdminClient` (service-role, bypassa RLS)
  aparece importado fuera de un allowlist estático documentado.

---

## Forma del pipeline de CI (rápido → caro)

Sesión `ci-gate-minimo` arranca con los pasos 1 y 3; `ci-pipeline-completo-y-guard` completa el resto.

1. **Rápidos sin credenciales** — `tsc --noEmit`, lint, guards estáticos. Corren primero.
2. **Unit + coverage** — capas 1-2 con **umbral ratchet** (se fija apenas por debajo del coverage
   medido; sube con mejoras, nunca baja sin decisión explícita).
3. **Build** — `next build` (atrapa la clase de errores de runtime que el typecheck no ve).
4. **Gate de credenciales** — verifica que la DB de integración / secretos estén presentes; si
   faltan, la etapa de integración se **saltea de forma visible** en vez de fallar confuso.
5. **Integración serial** con concurrency group por rama (dos corridas no escriben el mismo entorno).
6. **E2E gateado** — al final, solo en `main` / pre-corte.

**Anti-false-green** (se revisa en cada test nuevo): (1) testear el **símbolo real** que corre en
prod, no una réplica local — mockear la dependencia externa (reloj, cookie, cliente de red), no la
función bajo test; (2) afirmar el **efecto observable** (el registro quedó en el estado esperado, el
evento se emitió con el payload correcto), no solo "no lanzó excepción / devolvió 200".

---

## Checklist de QA manual por ronda (versionado)

Se corre completo en **preview UTC** antes de cada corte / ronda de cambios significativa. Cierra el
finding `no-qa-checklist-versionado`. Marcar ✅/❌ por ítem, con captura si aplica.

**Agenda / turnos (siempre `TZ=UTC`):**
- [ ] Crear turno haciendo click en un slot de un día **sin turnos** → cae en ese día y esa hora (no HOY, no −3h).
- [ ] Crear turno en un día con turnos existentes → día/hora correctos.
- [ ] "Múltiples turnos" (batch) → todos en los días AR correctos.
- [ ] Turno a las 21:30 y turno a la media hora → **visibles** en grilla y timeline.
- [ ] Estados (PENDING/CONFIRMED/COMPLETED/NO_SHOW/CANCELLED) → label correcto en el StatusTag.
- [ ] Doble-click en "Crear turno" → **un** solo turno.
- [ ] Editar un turno con un drawer viejo (movido en otra pestaña) → rechazo por optimistic concurrency.
- [ ] Sugerencia de "próximo turno libre" → dentro del horario comercial AR, respeta sáb/dom.

**Reserva pública (preview UTC):**
- [ ] Elegir slot "08:00" → aparece **08:00** en la agenda del kine (no 05:00).
- [ ] Checkout MP sandbox → turno PAID; monto correcto.
- [ ] Cambiar el precio del servicio mientras hay un checkout en vuelo → `Payment FAILED` registrado (no silencioso).

**Pacientes / dinero:**
- [ ] PRACTITIONER intenta "Eliminar definitivamente" un paciente → bloqueado; OWNER/ADMIN puede.
- [ ] Borrar un turno **pagado** → error claro (no destruye el Payment).
- [ ] Input de precio/copago con "1.500,50" → se guarda 150050 cents.

**Auth / boundaries:**
- [ ] Login con credenciales inválidas → banner de error en español.
- [ ] Forzar un error en un server component → pantalla de error en español con retry (no "Application error").
- [ ] Ruta inexistente → 404 custom en español.

**Fechas transversales (preview UTC):** dashboard "hoy"/semana/mes, Seguimiento "Hoy", búsqueda
global, portal del paciente, listado de pacientes "última visita", export ICS → todos muestran la
fecha/hora **AR**, no la del host.

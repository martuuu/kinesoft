# AGENTS.md — Cómo se trabaja en KineSoft

KineSoft es un SaaS multi-tenant de gestión para kinesiólogos y osteópatas argentinos: agenda y turnos,
pacientes e historia clínica, planes de tratamiento, diagnóstico, biblioteca de ejercicios y maniobras, y
facturación de copago y obra social. El stack es Next.js 14 (App Router) + TypeScript strict + Prisma 5 +
PostgreSQL (Supabase) + Vercel + Mercado Pago. Todas las tablas de dominio llevan `tenantId`.

Project lead: Martin Navarro. **Prod tiene datos demo y todavía nadie lo usa**, pero se sigue tratando como
pre-producción real: cualquier cosa que toque datos, plata o la agenda va con precheck → backup → deploy (sin staging
ni reset). Este archivo resume cómo se ejecuta; el detalle vive en `.docs/`.

## 1. Planificación: nada se ejecuta sin planning

- El trabajo va **por bloques, olas y sesiones ya planificados**. Si algo no está en el planning, se consulta
  antes de hacerlo. Ninguna ola arranca sin su planning detallado aprobado por Martin.
- Hay cinco **bloques**:
  - **A** = fixes urgentes: pérdida de datos, seguridad y operación de prod. Olas A0 a A3.
  - **B** = agenda profesional y Planes: primero B-pre (catálogo, agenda por profesional, motor de
    disponibilidad) y después Planes completo. No hay "Planes v1".
  - **C** = diferido, en tres grupos:
    - C0: roles, Secretaria y administración.
    - C1: ejercicios, email e identidad del paciente, perf y cache.
    - C2: diferidos del ROADMAP.
  - **D** = marketplace tipo Crontu.
  - **E** = IA de diagnóstico.
- Todo hallazgo nuevo se clasifica en A, B, C, D o E y se anota en el momento. Si no, se pierde.
- Fuentes, en este orden:
  1. El plan vigente, `~/.claude/plans/necesito-que-asumas-el-piped-engelbart.md`: auditoría del 23-sep, bloques
     A-E, planning detallado de A0/A1 y benchmark de drapp. Desde el 15-oct manda su **§20** (orden 0 → PL → EV2 →
     VX → ES4 → PF → DIR, resumido en `.docs/ROADMAP.md` «Plan vigente (15-oct)»).
  2. `.docs/AUDIT.md`: checklist de severidad. **§5 = inventario de "preservar"**: son patrones intencionales y
     no se "arreglan".
  3. `.docs/ROADMAP.md`, `.docs/QA.md`, `.docs/ARCHITECTURE.md`, `.docs/SECURITY.md`, `.docs/TESTING.md`.
  4. `.docs/MIGRACIONES-RUNBOOK.md`, `.docs/DEPLOYMENT.md`, `.docs/EXTERNAL-CONFIG.md` (tareas de Martin en las
     consolas).
- Decisión nueva de Martin: se asienta en el documento que corresponda **en el momento**. Si es de producto, va al
  §9 del plan (decisiones del dueño); si es técnica, a `.docs/ARCHITECTURE.md` (ADR) o `.docs/AUDIT.md`.

## 2. Ejecución: en paralelo, sin pisarse

- Todo lo que se pueda va **en paralelo**, en sesiones que **no compartan archivos**: cada archivo tiene **un solo
  dueño** por ola. Si una sesión necesita cambiar un archivo ajeno, deja el cambio exacto como *handoff* y lo
  aplica el integrador.
- **`lib/bookings.ts` es siempre serial.** Nunca dos sesiones sobre ese archivo en la misma ola.
- **Una migración encabeza su ola, sola.**
- **Tests primero** en todo lo que toque escritura de datos. Cada bug conocido arranca como
  `it.fails("[<sesión>] …")` y la sesión lo da vuelta.
- **Se commitea entre sesiones** (lo hace Martin). Antes de lanzar una sesión: `git status` limpio y `git log -1`
  = el commit de la sesión anterior. Si no, se frena y se pide el commit.
- No se revierte trabajo ajeno del working tree. Un fix se verifica **en el archivo**, no en el resumen de un
  agente.

## 3. Testing

- **Por sesión:**
  1. `npx tsc --noEmit`.
  2. `TZ=UTC npm test` (unit).
  3. `npm run guard:isolation`.
  4. El test de integración afectado contra el Docker local: `npm run test:integration -- <patrón>`.
- **Al cerrar una ola, y siempre antes de que Martin migre prod:**
  1. `npx next build`.
  2. La suite unit completa en TZ=UTC y TZ=AR.
  3. La integración completa con los **dos roles**: `kinesoft_app` (RLS aplicado) y owner BYPASSRLS (reproduce
     prod).
  4. Las migraciones re-aplicadas en local con `migrate deploy`.
- **Todo QA de fechas se hace con `TZ=UTC`**: en dev AR-local los bugs de timezone se esconden.
- **Anti-false-green:**
  - Testear el símbolo real que corre en prod. Se mockea la cookie, la red y `next/cache`; nunca la función bajo
    test.
  - Afirmar el efecto observable: la fila quedó así, el evento salió con este payload.
- La lógica pura va fuera de los archivos `"use server"`, en un módulo testeable con su unit test.

## 4. Reglas duras (no negociables)

- **Git es solo de Martin.**
  - Nada de commit, push, pull, stash, checkout, reset ni ramas.
  - Leer (status, log, diff, show, blame) sí.
  - Al cerrar una sesión se le deja el comando de commit armado y lo ejecuta él. Formato fijo:
    - `git add -A`, y solo las **excepciones** van como pathspec de exclusión (`git add -A -- . ':!archivo'`).
      Nunca la lista de archivos agregados.
    - Mensaje **corto y conciso** (una línea).
    - **Sin** `Co-Authored-By` ni «Generated with».
  - **Nunca push**: Vercel deploya `main` y cada build auto-migra.
- **`.env` puede apuntar a PRODUCCIÓN.** Nunca se leen ni se imprimen sus valores: a lo sumo se comparan nombres de
  claves con `grep -c '^NOMBRE='`. `.env.local` = Docker local (puerto **5433**).
  - El Prisma CLI pelado (`npx prisma …`) lee `.env`, no `.env.local`. En local, siempre a través de los scripts
    npm o de `dotenv -e .env.local -- …`.
- **Local sí, prod nunca.**
  - Contra el Docker local el agente **puede**:
    - aplicar migraciones: `dotenv -e .env.local -- npx prisma migrate deploy`;
    - correr `npx prisma generate`, `next build` y tests unit, de integración y e2e.
  - El agente **no corre**:
    - ningún seed (`prisma/seed.ts`, `scripts/seed-*`), ni local;
    - `migrate reset` ni `db reset`;
    - `prisma migrate dev`: detecta drift, propone resetear y puede borrar el índice único parcial.
  - Contra producción: nada. Ni migraciones, ni scripts, ni lecturas.
- **Migraciones** (`prisma/migrations/<timestamp>_<nombre>/migration.sql`, escritas a mano):
  1. **Aditivas** (expand/contract): nada de DROP, SET NOT NULL ni UNIQUE sin backfill en la misma tanda que el
     código que los usa. El porqué va en la cabecera del SQL.
  2. Toda tabla nueva con `tenantId` lleva su policy RLS (`ENABLE` + `FORCE` + `tenantId =
     app_current_tenant_id()`) y tiene que pasar `npm run guard:isolation`.
  3. Los índices parciales no se expresan en Prisma: comentario en el SQL de que no se borran si `migrate dev` lo
     propone.
  4. Se aplica en local, se verifica **objeto por objeto** (columnas, índices, policies) y se corre la integración.
  5. Se le deja a Martin **el orden exacto de aplicación**, con queries de precheck de solo lectura, backup antes,
     staging primero y qué va antes o después del deploy. Siempre se le avisa **explícitamente** que hay
     migraciones nuevas en la tanda: nunca quedan implícitas en un diff.
- **Código:**
  - Un archivo `"use server"` exporta **solo funciones async**. Tipos y constantes van en `*-types.ts` /
    `*-constants.ts`, y los helpers internos con `import "server-only"`.
  - Cada action: `getActor()` → zod → **`where: { tenantId }` a mano** (en prod la conexión tiene BYPASSRLS: es la
    única barrera) → `runWithRls(tenantId, tx => …)`. Los ids de entrada (paciente, profesional, servicio, plan,
    ejercicio) se validan contra el tenant antes de escribir, porque las FK saltean RLS.
  - Mutaciones de turnos con `expectedUpdatedAt` (optimistic lock) y `idempotencyKey` del cliente (UUID por
    instancia de modal). No se tocan el índice único parcial ni la precedencia de copago (`lib/copago.ts`).
  - **Fechas:**
    - toda lógica de reloj usa `lib/datetime-ar.ts`: `getDay`/`setHours`/`toISOString().slice(0,10)` del host son
      bug en Vercel (UTC);
    - todo `toLocale*` en el cliente pasa `timeZone: "America/Argentina/Buenos_Aires"`;
    - excepción: `<input type="date">` y `dateOfBirth`.
  - **Plata:** 100% en centavos `Int` (`*Cents`), con `parseARS` / `formatARS` de `lib/format.ts`. Nunca
    `Number()*100`.
  - Se chequea el `{ error }` de cada llamada a Supabase: supabase-js no tira excepción.
  - Admin/service-role de Supabase y `prismaService` solo en superficies sin Actor (webhook MP, turnero público,
    Plataforma).
- **Comentarios que explican el POR QUÉ**: el bug que lo motivó, lo que se midió, lo que se descartó. Es la
  convención del repo. La skill genérica de "comentarios mínimos" no aplica.

## 5. UX/UI

- Design system en `app/globals.css` (tokens `--sky-*`, `--lime-*`, `--navy-*`, radios `--r-*`) y primitivas en
  `components/ui/`: `Button`, `Tag`, `Card`, `Drawer`, `Modal`, `FormField`, `useConfirm`, `Toast`. Se reusan antes
  de crear. **Nada de librerías de UI nuevas.**
- Los formularios de carga van en **Drawer**, con un dirty-guard. Las confirmaciones, con `useConfirm`: nunca
  `window.confirm/alert`.
- **Color en la agenda:** la barra lateral es el servicio, el fondo es el estado y la opacidad es el filtro. El plan
  y el profesional se marcan con canales **no cromáticos** (chip, avatar, iniciales).
- **La agenda de la Secretaria es crítica:** varios profesionales, días y pacientes simultáneos. Toda pantalla de
  agenda se diseña pensando en esa densidad.
- Copy en **español rioplatense** (voseo), claro y sin jerga. Montos con `formatARS`. Evitar el "IA slop": se
  construye sobre lo existente, no se inventan patrones sin planning.
- `reducedMotion="user"`: el estado final tiene que verse completo sin animación.

## 6. Documentación y cierre de sesión

- Al cerrar cada sesión:
  1. Verificar uno mismo: tsc, tests del área, `git status`.
  2. Actualizar `.docs/AUDIT.md` (estado de los hallazgos), `.docs/QA.md` (checklist manual de la sesión) y el
     ROADMAP.
  3. **Podar** lo falso o viejo de cada doc que se toca.
  4. Listar las migraciones nuevas y su orden para prod.
  5. Dejar el comando de commit para Martin.
- Reportes a Martin: cortos y concretos. Qué quedó, qué falta, qué decide él (con recomendación), con evidencia
  `archivo:línea`. Lo que quedó afuera se dice.

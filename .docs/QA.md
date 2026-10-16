# KineSoft — QA manual por ronda

> Checklist de verificación humana versionado (ver [TESTING.md](TESTING.md)). Cada ronda de cambios
> significativa agrega su sección. **Regla de oro:** todo lo de fechas se prueba con **`TZ=UTC`**
> (`TZ=UTC npm run dev` contra el Docker local, o directamente en un preview de Vercel) — en dev
> AR-local los bugs de timezone NO se reproducen.
>
> Marcá cada ítem ✅/❌. Los ítems 🔴 **críticos** son los que pueden generar problemas grandes:
> priorizalos.
>
> ⚠️ **Dónde se corre (desde 2026-09-29):** en **local** (`TZ=UTC npm run dev` contra el Docker :5433) o
> en un **Preview de Vercel apuntado a staging** — nunca en un Preview que comparta la DB de producción
> (hallazgo H6; ver EXTERNAL-CONFIG §Staging). Ítems marcados ~~tachados~~ = obsoletos por un cambio
> posterior; no se corren.

---

## Ronda 1 — Bugs QA de agenda + timezone + boundaries + CI (2026-07-23)

Verificación automática ya corrida: `tsc --noEmit` ✅ · `next build` ✅ · `vitest` 16/16 ✅.
Lo de abajo es lo que **necesita ojos humanos** (comportamiento observable o cambios de conducta).

### 🔴 Críticos (probar con `TZ=UTC` o en preview)

- [ ] **Bug reportado #1 — turno se crea en el día equivocado.** En la vista **timeline** (día),
  parate en un día **sin ningún turno** y hacé click en una franja horaria vacía (ej. 10:00). El
  modal de nuevo turno debe prefill **ese** día y **esa** hora — NO el día de hoy, NO 3 horas
  corridas. Repetí en un día **con** turnos: mismo resultado. *(era `agenda-client.tsx`: usaba
  `bookings[0] ?? new Date()` + `setHours` del host.)*
- [ ] **Reserva pública (flujo que cobra por Mercado Pago).** En un preview UTC, entrá a
  `/c/<slug>/booking`, elegí un slot rotulado p.ej. **08:00** y completá la reserva. En la agenda del
  kinesiólogo, ese turno debe aparecer a las **08:00 AR** (antes quedaba a las 05:00). Confirmá que
  los slots ofrecidos son los del horario comercial AR (no solo la mañana).
- [ ] **Doble-submit no duplica turnos.** En "Nuevo turno", hacé doble-click rápido en Guardar (o
  simulá reintento de red). Debe quedar **UN** solo turno, no dos solapados.
- [ ] **El sobreturno legítimo SIGUE funcionando.** Creá un turno para el Paciente A a las 10:00.
  Después creá otro para el Paciente **B** a las 10:00 con el mismo profesional y forzá el
  sobreturno cuando lo pida. Debe crear el **segundo** turno (no fusionarse). *(La idempotencia es
  por identidad del paciente, así que dos pacientes distintos = dos turnos.)*
- [ ] ~~**Re-reserva tras cancelar.**~~ *Obsoleto: la idempotencia determinística se revirtió en la
  Ronda 6 (hoy la agenda usa una key por modal y re-reservar crea un turno nuevo). La reserva pública
  todavía conserva el patrón viejo — bug abierto en A2 (S-pub), se prueba ahí.*

### Visibilidad y estados de la agenda

- [ ] **Turno fuera de horario comercial visible.** Con horario 8–19, creá un turno a las **21:30**.
  Debe **verse** (clampeado al borde inferior) tanto en la vista **timeline** como en la **semanal**
  — antes desaparecía. Idem un turno a la media hora (ej. 14:30).
- [ ] **Etiqueta de estado consistente.** Un turno marcado como realizado muestra **"Hecho"** tanto
  en la grilla de la agenda como en el drawer lateral (antes el drawer decía "Realizado").

### Timezone — spot-checks (con `TZ=UTC`)

- [ ] **Dashboard**: los contadores "hoy / esta semana / este mes" cuentan un turno de las **22:00 AR
  de hoy** como de HOY (no de mañana). El mini-calendario marca el día AR correcto.
- [ ] **Seguimiento**: el bucket "Hoy" incluye una sesión de las 22:00 AR de hoy.
- [ ] **Portal del paciente / listado de pacientes / búsqueda global / detalle de sesión**: las
  fechas y horas se ven en AR (no corridas 3h) para turnos de la tarde/noche.
- [ ] **Export ICS de la agenda**: el .ics importado a Google/Apple Calendar muestra los turnos en el
  horario correcto (el archivo usa UTC con `Z`; el calendario lo convierte a AR solo).

### Auth y boundaries (no necesitan TZ=UTC)

- [ ] **Login con error.** Ingresá con contraseña incorrecta → aparece un **banner rojo en español**
  ("Credenciales inválidas") arriba del formulario. Con login válido, no aparece banner y entra.
- [ ] **Pantalla de error.** Si una sección falla al cargar datos, se ve una pantalla **en español
  con botón "Reintentar"** (no el "Application error" en inglés de Next). *(Difícil de forzar sin
  romper algo a propósito — verificación oportunista.)*
- [ ] **404.** Entrá a una URL inexistente (ej. `/xyz`) → página 404 en español con "Volver al inicio".

---

## Ronda 2 — Pago + integridad + hardening (Fase A completa, 2026-07-23)

Verificación automática ya corrida: `tsc` ✅ · `next build` ✅ · `vitest` 19/19 ✅.
**Migración aplicada al Docker local** (`20260723213701_payment_expected_amount_and_delete_restrict`:
agrega `Payment.expectedAmountCents` + cambia el FK a `onDelete: Restrict`). Commiteala junto con el
código; prod migra sola en el deploy.

### 🔴 Críticos (pago) — requieren sandbox de Mercado Pago

- [ ] **Monto de pago anclado.** Un pago normal por MP marca el turno PAID. Ahora, si cambiás el
  precio del servicio **entre que el paciente inicia el checkout y paga**, el webhook debe **rechazar
  el pago con monto distinto y registrar un `Payment` en estado FAILED** (queda traza) en vez de
  marcar PAID contra el precio viejo. *(El monto esperado se ancla en `Payment.expectedAmountCents` al
  crear la preferencia.)*
- [ ] **No se puede borrar un turno pagado.** Con un turno que tiene un `Payment` AUTHORIZED/PAID/
  REFUNDED, "Eliminar" debe fallar con un mensaje claro ("tiene un pago registrado… cancelalo"). Un
  turno **sin** pago (o con checkout abandonado UNPAID/FAILED) se borra normal (y limpia el pago
  huérfano). *(El FK Payment→Booking ahora es Restrict, no Cascade — no se destruye el comprobante.)*

### Integridad de pacientes y dinero

- [ ] **Gate de rol en borrado definitivo.** Un usuario con rol PRACTITIONER **no** puede eliminar
  un programa / sesión (mensaje: "Solo el dueño o un administrador…"). Un OWNER/ADMIN sí.
  *(30-sep: "eliminar definitivamente" **paciente** ya no existe — solo Archivar, que exige acceso
  completo. Ver Bloque A — A2/A3.)*
- [ ] **Parser de dinero AR.** En Configuración (precio de servicio, copago, arancel fijo) y en el
  copago de un turno, ingresá **"1.500,50"** → debe guardar $1.500,50 (150050 centavos), no romperse.
  ~~Ingresá texto inválido → toma 0 sin explotar.~~ *Obsoleto (A2b, 30-sep): con `MoneyInput` un texto
  inválido marca el campo y bloquea Guardar.*
- [ ] **Validación de cobertura.** El formulario de cobertura del paciente ahora valida con schema
  (nombres largos recortados, etc.) y muestra errores de campo.

### UX / seguridad (no necesitan sandbox)

- [ ] **Confirmaciones in-app.** Las acciones destructivas de Configuración ya **no** usan el
  `confirm()`/`alert()` del navegador — usan el diálogo in-app. Y guardar "Datos del consultorio"
  muestra "Guardado ✓".
- [ ] **Política de contraseña.** En signup/reset, una contraseña sin al menos una letra Y un número
  es rechazada con mensaje en español.
- [ ] **Invitaciones (token hasheado).** Crear una invitación de equipo y abrir el link → funciona
  normal. ⚠️ **Nota:** las invitaciones pendientes creadas ANTES de este cambio dejan de funcionar
  (su token viejo estaba en texto plano y ahora se busca por hash); regenerá el link desde
  Configuración → Usuarios si hace falta. El token ahora se guarda **hasheado** en la DB.
- [ ] **Headers de seguridad.** Verificá que la app funcione normal (el CSP está en modo
  **Report-Only** — no bloquea nada todavía; revisá la consola del navegador para ver reportes de CSP
  y afinarlo antes de activarlo como bloqueante más adelante).

> ~~**Sentry** quedó cableado como **no-op**~~ *Actualizado 30-sep: el SDK real se instaló en A3b; su QA
> (con DSN en staging) está en la sección Bloque A — A2/A3.*

---

## Fase A — COMPLETA ✅ (rondas 1 + 2)

Todo lo de las olas A0-A4 está implementado y en verde. Lo que sigue es la **Fase B** (Fundaciones
Etapa 2), planificada en detalle en [FASE-B-PLAN.md](FASE-B-PLAN.md): splits de archivos gigantes →
tests → RLS wholesale → multi-profesional → realtime.

**Diferidos menores** (registrados, no bloqueantes): optimistic lock en `setBookingInsurerPaid`/
`setBookingCopagoPaid`; suite de tests completa capa 2-4 + test de copago (necesitan extracción de
lógica pura, Ola B1); virus-scan de uploads (gate: uploads de pacientes).

---

## Ronda 3 — Splits de archivos gigantes + tests capa-1 (2026-07-24)

Verificación automática: `tsc` ✅ · `next build` ✅ · `vitest` 35/35 ✅. **Sin migración.**

> **Qué cambió y por qué te importa:** 4 archivos de 1600-2300 líneas se partieron en módulos por
> feature (configuración 1636→52, perfil de paciente 2341→181, agenda 2180→338, diagnóstico
> 1627→231). La regla fue **cero cambio de comportamiento**: si ves *cualquier* diferencia visual o
> de funcionamiento, es un bug de esta ronda. Es un QA de "mirá que todo siga igual".

### 🔴 Críticos — regresión visual / funcional en las 4 pantallas partidas

- [ ] **Configuración — recorré las 5 solapas** (general, servicios, obras sociales, usuarios,
  diagnósticos). Cada panel abre, muestra los datos y **guarda** (editá un servicio y un copago, y
  confirmá que persiste tras recargar).
- [ ] **Perfil de paciente — recorré las 9 solapas.** Resumen, sesiones, plan, antecedentes,
  evolución, turnos, facturación, archivos, actividad. Ninguna debe quedar vacía ni tirar error.
- [ ] **Perfil de paciente — Turnos + Facturación juntos.** Estas dos vistas comparten los datos de
  turnos: abrí **Facturación**, marcá un turno como pagado, y verificá que **Turnos** refleja el
  mismo estado (y al revés). Era el punto de mayor riesgo del split.
- [ ] **Agenda — las 4 vistas.** Timeline (día), semana en grilla, lista y la tira de semana.
  Cambiar de vista y de día no debe perder el turno seleccionado ni descolocar nada.
- [ ] **Diagnóstico — flujo completo.** Mapa corporal → refinamiento → panel derecho → asignar plan.
  El estado tiene que seguir fluyendo entre los 3 paneles (era un reducer, es lo más frágil).

### Consolidaciones a mirar de reojo

- [ ] **Montos en pesos.** Todos los importes (agenda, perfil, configuración) se ven con el mismo
  formato `$1.500,50`. No debería aparecer ningún importe con formato distinto ni en crudo.
- [ ] **Selector de días de la semana.** El de agenda y el de diagnóstico se ven y se comportan igual.

---

## Ronda 4 — RLS activa en local + colores, mini-diagnóstico y drawers (2026-08-02)

Verificación automática: `tsc` ✅ · `next build` ✅ · `vitest` 39/39 (+4 de RLS) ✅.
Migración local: `wave_service_color_booking_title_patient_diagnosis` (aditiva).

> ⚠️ **Alcance de RLS:** todo esto está probado en el **Docker local** con el rol `kinesoft_app`.
> **Producción sigue con el rol viejo (BYPASSRLS)** hasta que corras `prisma/roles.supabase.sql` y
> apuntes `DATABASE_URL` al rol nuevo. Hasta entonces, en prod la protección real la sigue dando el
> filtro por tenant del código.

### 🔴 Críticos — aislamiento entre consultorios (RLS, en local)

- [ ] **La app funciona igual con el rol restringido.** Con `.env.local` apuntando a `kinesoft_app`,
  recorré agenda, pacientes, sesiones, dashboard, configuración y el **booking público**. Nada debe
  tirar "permission denied" ni quedar vacío. *(Una lista que aparece vacía sin error es la falla
  típica de RLS mal puesta — miralas con desconfianza.)*
- [ ] **Tripwire automático.** `npm run test:integration` pasa (el test intenta escribir en otro
  tenant y la DB lo rechaza).
- [ ] **Cruce manual entre tenants.** Con dos consultorios en el Docker local, logueate en el A y
  confirmá que **no** ves ningún paciente, turno ni servicio del B (ni en listados, ni en búsqueda
  global, ni entrando a mano a una URL con el id de un paciente del B → debe dar 404/403, no datos).
- [ ] **Superficies sin usuario logueado siguen andando.** Reserva pública desde `/c/<slug>/booking`
  y el webhook de pago: estas entran por el canal de servicio, no por RLS. Si alguna rompe, es
  exactamente el riesgo que teníamos anotado.

### Colores por servicio

- [ ] **Asignar color.** Configuración → Servicios: elegí un color para 2-3 servicios y guardá.
- [ ] **El color aparece en la agenda.** Las cards de esos servicios muestran su barra de color en
  timeline, semana y lista. Un servicio sin color usa el color por defecto (no queda invisible).

### Mini-diagnóstico por turno

- [ ] **Cargar diagnóstico en el turno.** Al crear/editar un turno, completá el campo de diagnóstico
  (título) y la descripción. La **card de la agenda muestra ese texto** en lugar del nombre del
  servicio.
- [ ] **Default desde el paciente.** Cargá un diagnóstico a nivel **paciente**; al crear un turno
  nuevo para ese paciente, el campo debe venir **pre-cargado** con ese diagnóstico (y poder pisarse).
- [ ] **Solo descripción.** Si cargás **solo** la descripción y dejás el título vacío, la card igual
  muestra texto (no queda en blanco).

### Drawers (los modales de carga pasaron a panel lateral)

- [ ] **Los 4 drawers abren y guardan:** nuevo/editar **paciente**, nuevo/editar **turno**, nuevo
  **servicio**, asignar **plan**. Cerrar con la X y con Escape funciona, y cerrar sin guardar no
  deja datos a medias.
- [ ] **Preview de últimos turnos.** El drawer de turno muestra los **2 turnos anteriores** del
  paciente elegido.
- [ ] **Animaciones.** Sidebar, cambio de ruta, cambio de vista de agenda y solapas del perfil
  animan sin saltos ni parpadeos. En el dashboard, los números hacen count-up y el gráfico entra
  animado (una sola vez, no en loop).

---

## Ronda 5 — Filtro por color, portal, compartir paciente y compartir turno (2026-08-02)

Verificación automática: `tsc` ✅ · `next build` ✅ · `vitest` 39/39 ✅.
Migración local aislada: enum de notificación `PATIENT_SHARED`.

### Agenda — leyenda de colores como filtro

- [ ] **Resaltado por servicio.** Debajo/al costado de la agenda hay una **leyenda** con los
  servicios y sus colores. Clickeá uno: **todas** sus cards se resaltan (se levantan) y el resto se
  atenúa. Clickeá de nuevo (o clickeá otro) → vuelve a la normalidad / cambia el resaltado.
- [ ] **Funciona en las 3 vistas** (timeline, semana, lista) y **no borra ni oculta** turnos: es
  resaltado, no filtro destructivo. Los turnos atenuados siguen siendo clickeables.

### Portal público de turnos

- [ ] **Diagnóstico visible para el paciente.** Entrá al portal público del turno y confirmá que se
  ven el **diagnóstico y la descripción** cargados por el kine. Si el turno no tiene diagnóstico, no
  debe quedar un bloque vacío ni "undefined".

### Compartir paciente → notificación

- [ ] **Notificación al profesional.** Con el usuario A, compartí un paciente con el profesional B.
  Logueate como **B**: tiene que haberle llegado una **notificación** de "te compartieron un
  paciente" (campana), y el paciente aparece en su listado.
- [ ] **Quitar el share** deja de mostrar el paciente a B.

### Compartir turno por WhatsApp + recordatorio imprimible

- [ ] **Link de WhatsApp.** Abrí un turno → "Compartir turno" → abre WhatsApp (web o app) con un
  mensaje pre-armado que tiene **paciente, fecha, hora y consultorio** correctos (chequeá que la
  hora sea la AR, no corrida). *(Es un link `wa.me` de compartir manual: **no** manda nada solo.)*
- [ ] **Recordatorio imprimible.** Desde el mismo turno, generá el recordatorio para imprimir/PDF:
  se ve prolijo en la vista previa de impresión (sin cortes raros) y los datos coinciden.
- [ ] ℹ️ **Recordá:** el envío **automático** por WhatsApp (API) **no está**: falta que configures el
  proveedor. Hoy es siempre compartir a mano. Ojo con lo que promete la landing.

---

## Ronda 6 — 🔴 ALTO RIESGO: turnos que se pisaban (2026-08-02/03)

Verificación automática: `tsc` ✅ · `next build` ✅ · `vitest` 45/45 (+6 nuevos) ✅.
Migración local aislada: `booking_patient_slot_active_unique` (índice único parcial).

> 🔴 **Esta es la ronda más importante para probar a mano.** Había una **pérdida de datos real**: al
> crear un segundo turno del mismo paciente, la app podía **sobrescribir el turno anterior en vez de
> crear uno nuevo** (la clave de idempotencia era determinística por paciente+horario). Se cambió por
> una clave por-formulario + un candado en la base de datos. **Probá esto antes que nada.**

### 🔴 Críticos — que NINGÚN turno se pierda

- [ ] **Dos turnos del mismo paciente, el mismo día, a horas distintas.** Creá para el Paciente A un
  turno a las **10:00**. Después creá otro para **A** a las **15:00** del **mismo día**. Debe
  aparecer una **confirmación suave** ("ya tiene un turno hoy, ¿lo agrego igual?"). Aceptá y
  verificá que quedan **LOS DOS** turnos en la agenda. Recargá la página y confirmá que **siguen
  los dos** (esto es lo que antes se perdía).
- [ ] **Repetilo 3 veces seguidas** con distintos pacientes y horarios. Contá los turnos antes y
  después. El número tiene que subir de a uno, **siempre**.
- [ ] **Turno solapado con el propio paciente → bloqueo claro.** Con A ya teniendo turno a las 10:00,
  intentá crearle **otro a las 10:00** (mismo o **distinto** profesional). Debe **bloquearse con un
  mensaje entendible** de solape — no crear nada, y **no pisar** el turno existente.
- [ ] **Reprogramar sobre un horario propio también se bloquea.** Tomá un turno de A y reprogramalo
  al horario de **otro** turno de A → mensaje de solape, y **ambos turnos siguen existiendo**.
- [ ] **Doble-click en Guardar.** Hacé doble-click rápido en "Guardar" al crear un turno: debe quedar
  **UNO** solo (no dos, y tampoco cero).
- [ ] **El sobreturno legítimo sigue vivo.** Paciente **A** a las 10:00 y Paciente **B** a las 10:00
  con el mismo profesional → se crean los dos (pacientes distintos no colisionan).
- [ ] **Re-bookear un horario liberado.** Cancelá el turno de A de las 10:00 y creale uno nuevo a las
  10:00 → debe dejarte (los cancelados no bloquean el horario).
- [ ] **Múltiples turnos (batch) y reserva pública.** Cargá una serie de turnos con "Múltiples
  turnos" y hacé una reserva desde el portal público en un horario que el paciente ya tiene: el
  batch no debe duplicar ni pisar, y el portal debe decir *"Ya tenés un turno reservado en ese
  horario"*.

### Autofill de Chrome

- [ ] **El buscador de paciente ya no sugiere tu mail.** En "Nuevo turno", empezá a tipear el nombre
  del paciente: Chrome **no** debe tapar el desplegable con tu email de Google. Verificá lo mismo en
  búsqueda global, wizard de diagnóstico, asignar plan y la paleta de comandos.

---

## Ronda 7 — Plataforma (superadmin) + catálogo global de ejercicios (2026-08-02)

Verificación automática: `tsc` ✅ · `next build` ✅ · `vitest` 45/45 ✅ · guard de aislamiento ✅.
Migraciones locales: flag de superadmin, tags `MUSCLE_GROUP`/`DISCIPLINE`, ejercicio con reps/series
opcionales + archivado, `ExerciseMedia` + `ExerciseArticle`.

> ⚠️ **Antes de QA-ear en prod:** hay que aplicar las migraciones, correr
> `scripts/set-platform-admin.ts` para vos y para el cliente, y confirmar que el canal de servicio
> apunta al rol con BYPASSRLS. En local ya está listo.

### 🔴 Críticos — quién puede entrar a "Plataforma"

- [ ] **Un usuario normal NO ve "Plataforma".** Logueate con un usuario que **no** sea superadmin
  (incluso siendo OWNER de su consultorio): en el menú lateral **no** aparece "Plataforma".
- [ ] **Y tampoco entra a mano.** Con ese mismo usuario, escribí `/plataforma/ejercicios` en la
  barra de direcciones → te tiene que **redirigir a `/dashboard`**, no mostrar la pantalla ni un
  error feo. Repetí con `/plataforma/tags`.
- [ ] **El superadmin sí.** Con tu usuario marcado como superadmin, "Plataforma" aparece en el menú
  y las dos secciones abren.

### Catálogo global — crear y editar

- [ ] **Crear un ejercicio.** Plataforma → Ejercicios → nuevo: nombre, tipo, dificultad, tags
  (grupo muscular, elementos, disciplina) y guardá. Aparece en la lista.
- [ ] **Series/reps/tiempo son opcionales.** Creá uno **sin** series ni reps (solo duración), y otro
  **solo** con series y reps. Ninguno debe mostrar "0" ni un "×" suelto en la biblioteca ni en el
  selector de ejercicios de una sesión.
- [ ] **Limpiar un valor.** Editá un ejercicio que tenía series/reps y **borralos** (dejar vacío) →
  guardá, salí y volvé: tienen que quedar **vacíos** (este fue un bug corregido: antes no se podían
  limpiar).
- [ ] **Crear una maniobra** (terapia manual) con el mismo flujo y verificá que aparece en
  `/terapia-manual`.
- [ ] **Archivar y restaurar.** Archivá un ejercicio → desaparece del catálogo que ven los
  consultorios. Restauralo → vuelve.

### Multimedia y artículo

- [ ] **Subir una imagen/video** al ejercicio y verificar que se ve en el detalle. Borrarla también
  funciona.
- [ ] **Agregar un video de YouTube** pegando la URL → se ve embebido en el lector.
- [ ] **El drawer se actualiza solo.** Después de subir/borrar media o guardar el artículo, el panel
  refleja el cambio **sin** que tengas que cerrarlo y abrirlo.
- [ ] **Escribir el artículo.** Cargá título, enfoque, minutos de lectura y cuerpo (markdown) →
  guardá.

### Lector y gating por plan

- [ ] **"Ejercicio completo".** Desde `/biblioteca`, el botón abre el lector `/biblioteca/<slug>` con
  el artículo formateado + la galería de media. El markdown se ve prolijo y **no** ejecuta HTML.
- [ ] **Duración corta.** Un ejercicio de menos de 60 segundos debe mostrar los **segundos**, no
  "0 min".
- [ ] **Tenant FREE ve solo lo Común.** Con un consultorio en plan **FREE**, la biblioteca muestra
  **solo** los ejercicios marcados como Común (básicos).
- [ ] **Tenant PRO ve todo.** Con un consultorio **PRO**, se ve el catálogo global completo (Común +
  Pro). Cambiá el plan y verificá que la lista cambia.

---

## Ronda 8 — Tabla del catálogo, preferencias y edit-in-place (2026-08-03)

Verificación automática: `tsc` ✅ · `next build` ✅ · `vitest` 45/45 ✅ · guard ✅.
Migración local: `user_prefs_catalog` (preferencias de la tabla por usuario).

### Tabla de Plataforma → Ejercicios

- [ ] **Buscar.** Escribí en el buscador: la lista filtra sola (con un pequeño retardo). **Borrá** lo
  escrito → vuelven todos. *(Bug corregido: el buscador podía "resucitar" filtros recién limpiados —
  probá limpiar filtros y escribir rápido a la vez.)*
- [ ] **Filtrar.** Combiná filtros de tipo, plan (Común/Pro), dificultad, archivados y **tags** de
  varias categorías a la vez. Los chips de filtros activos coinciden con lo que muestra la tabla.
- [ ] **Multiselect rápido.** En el menú de tags, clickeá **varias opciones seguidas rápido**: no
  debe perder las anteriores.
- [ ] **Ordenar.** Clickeá los encabezados de columna (nombre, tipo, dificultad, fecha) → ordena
  asc/desc. Con **dos ejercicios del mismo nombre**, paginá y confirmá que **ninguno se repite ni
  desaparece**.
- [ ] **Paginar.** Cambiá el tamaño de página y navegá. Estando en la página 5, aplicá un filtro que
  deje pocos resultados → debe llevarte a una página **con filas**, no mostrar "catálogo vacío".
- [ ] **URL con parámetros repetidos.** Una URL tipo `?muscle=a&muscle=b` debe funcionar (no error
  500).

### Preferencias que se recuerdan

- [ ] **Vuelve como la dejaste.** Configurá búsqueda + filtros + orden + tamaño de página, salí a
  otra sección y volvé a Plataforma → Ejercicios **sin parámetros en la URL**: la vista se restaura
  tal cual.
- [ ] **La URL manda.** Si entrás con una URL que trae parámetros, gana la URL (no tus preferencias).
- [ ] **Back/Forward.** Navegá con los botones atrás/adelante del navegador: el **campo de búsqueda**
  debe quedar sincronizado con lo que se está mostrando. *(Volver con Back a la URL sin parámetros
  re-muestra la vista guardada: es a propósito.)*

### Acciones inline y edición desde la biblioteca

- [ ] **Toggle Común ↔ Pro** desde la fila de la tabla: cambia al toque y persiste tras recargar.
- [ ] **Archivar / restaurar** desde la fila: idem.
- [ ] **Editar desde `/biblioteca`.** Como **superadmin**, clickeá una card de un ejercicio **del
  catálogo global** → se abre el panel de edición ahí mismo y podés guardar.
- [ ] **Ídem en `/terapia-manual`** con una maniobra.
- [ ] **Ejercicio privado del consultorio.** Como superadmin, clickeá uno **propio del tenant** (no
  global) → debe mostrar el detalle **read-only** y avisar que no pertenece al catálogo global.
- [ ] **Usuario normal no edita.** Con un usuario que no es superadmin, clickear una card abre el
  detalle de siempre — **sin** panel de edición.

### Hidratación

- [ ] **Sin warning en Planes/Seguimiento.** Abrí `/seguimiento/<id>` con la **consola del navegador
  abierta**: no debe aparecer ningún error de *hydration mismatch*. Las fechas y horas se ven en
  formato **24 h** (sin "a. m." / "p. m."), consistente con el resto de la app.

---

## Ronda 9 — Timeline de agenda rehecho + anchos de drawers (2026-08-15)

Verificación automática: `tsc` ✅ · `next build` ✅ · `vitest` ✅. **Sin migración.**

> **Qué cambió:** las cards del timeline ya no se posicionan por coordenadas según su hora exacta
> (eso hacía que turnos de franjas contiguas **se cruzaran y pisaran las líneas de la grilla**).
> Ahora cada hora es una fila que **crece** para contener sus turnos. Además se ensancharon los
> paneles laterales para que los formularios no scrolleen de costado.

### Agenda — vista de día (timeline)

- [ ] 🔴 **Nada se cruza entre franjas.** Cargá turnos en horas contiguas (ej. 10:00, 10:30, 11:00,
  11:30) y mirá la vista día: **ninguna card** debe invadir la fila de otra hora ni montarse sobre
  una línea de la grilla. Probá también con turnos a la media hora y con turnos **fuera del horario
  comercial** (ej. 21:30) — tienen que verse igual, no desaparecer.
- [ ] ~~**Hasta 5 por fila, de ancho parejo.**~~ *(Ronda 10: reemplazado por la grilla por slots de
  30/60 min — ver sección Ronda 10.)* Poné 5 turnos en la misma hora: se acomodan en una fila,
  todos del **mismo ancho**. Con 6 o más, los extras bajan a una segunda fila (misma hora).
- [ ] **Un turno solo no se estira.** Con **un** único turno en una hora, la card debe mantener un
  ancho razonable — **no** convertirse en una banda de punta a punta.
- [ ] **Nombres largos.** Cargá un paciente con nombre y apellido largos: el texto se **corta con
  puntos suspensivos** (no se desborda ni empuja la card), y **al pasar el mouse** aparece el
  tooltip con hora + nombre + detalle completos.
- [ ] **"+N" para ver más.** Con más de 10 turnos en la misma hora aparece el "+N": clickeándolo se
  expanden y la fila de esa hora crece. Volver a colapsar funciona.
- [ ] **Densidad compacta.** Cambiá la densidad de la vista: las filas se achican pero todo lo
  anterior sigue valiendo.
- [ ] **Click en hueco vacío.** Sigue precargando **ese** día y **esa** hora en el drawer de nuevo
  turno (regresión de la Ronda 1 — verificar que no volvió).
- [ ] ~~**Semana y lista intactas.**~~ *(Ronda 10: Día y Semana comparten la grilla nueva — ver
  sección Ronda 10.)*

### Paneles laterales (drawers) — sin scroll horizontal

- [ ] **Nuevo turno.** El formulario entra sin **scroll de costado**, y los avisos de **sobreturno /
  "ya tiene un turno hoy"** se leen **sin tener que scrollear** hacia abajo.
- [ ] **Nuevo paciente** y **Editar paciente**: los campos en dos columnas entran completos, sin
  corte lateral.
- [ ] **Ejercicio (Plataforma / edit-in-place).** La fila **Series / Reps / Tiempo** entra en una
  sola línea y los editores de media y artículo se ven completos.
- [ ] **En pantalla chica / notebook.** Repetí los 3 puntos anteriores con la ventana angosta: el
  panel no debe tapar toda la pantalla ni generar doble scroll.

---

## Ronda 10 — Agenda de 30/60 min + batch con preflight + solape confirmable (2026-08-16)

> Todo con `TZ=UTC`. Qué cambió: la agenda tiene granularidad configurable (Configuración → "Horario del
> consultorio": 30 o 60 min) y Día/Semana comparten la misma grilla; "Múltiples turnos" avisa **antes** de
> crear qué fechas chocan; el solape con otro turno del mismo paciente pasó de bloqueo a confirmación.

### Grilla de 30/60 minutos

- [ ] 🔴 **Un turno a las 13:30 cae en la fila de las 13:30** (con slots de 30) en **Día y en Semana** —
  antes la Semana lo mostraba en las 14:00.
- [ ] **Cambiar a 60 min** en Configuración: la agenda se redibuja con filas de una hora y el turno de
  las 13:30 queda dentro de la fila de las 13, sin perderse.
- [ ] **Turno de 45/60 min con slots de 30:** se ve el hint «· continúa X» en la franja siguiente y esa
  franja **no** aparece como libre. En Semana, el chip de la media hora siguiente sigue clickeable.
- [ ] **Turnos fuera del horario del consultorio** (ej. 07:00 o 21:30): aparecen en las filas
  **"Antes del horario" / "Después del horario"**, no se pierden ni compiten por el "+N".
- [ ] **Click en el gutter de la hora** (la columna con la hora) crea un turno en esa franja.
- [ ] **Duración visible:** en cards angostas la duración no la tapa el ellipsis (va primero y en el
  tooltip).

### Múltiples turnos con preflight

- [ ] 🔴 **Preflight antes de crear:** cargá 4 turnos semanales donde uno choca con otro paciente (servicio
  con cupo 1) y otro ya existe para el mismo paciente. El modal muestra, por fecha, **libre / sobreturno /
  duplicado** antes de escribir nada.
- [ ] **«Crear solo los libres»** crea solo los libres; **«Crear todos»** crea también los sobreturnos
  (marcados `[SOBRETURNO]`) y reporta los duplicados como "ya existían", no como error mudo.
- [ ] **Contar en la base/agenda** que la cantidad de turnos creados coincide con lo que dijo el
  preflight.

### Solape del mismo paciente

- [ ] **Dos servicios en paralelo** para el mismo paciente con horarios que se superponen (no el mismo
  instante): el modal **pide confirmación** («dos servicios en paralelo es normal») y, al confirmar, crea
  el turno.
- [ ] 🔴 **Mismo instante exacto** para el mismo paciente: error terminal con texto accionable ("movelo
  unos minutos"); **no** ofrece confirmar.
- [ ] **"Mismo día" y "solape" son independientes:** confirmar uno no saltea el otro.
- [ ] Todos los avisos hacen scroll hasta quedar visibles en el drawer.

---

## Ronda 11 — Bloque A0: operación segura (2026-09-29)

> La mayoría de A0 es infraestructura (lo verifica el gate automático). Lo que requiere mano del dueño:

- [ ] 🔴 **Preview no migra:** en el próximo Preview de Vercel, el log de build muestra
  `[vercel-build] skip migrate (VERCEL_ENV=preview)`. En el próximo deploy de Production, el log muestra
  `$ npx prisma migrate deploy`.
- [ ] 🔴 **Seeds bloqueados contra prod:** con `.env` apuntando a prod (o pasando la URL a mano),
  `npx tsx prisma/seed.ts` aborta con "es solo LOCAL". **No lo pruebes con una base real si dudás:** el
  guard imprime el destino antes de hacer nada.
- [ ] **Scripts de soporte:** `DATABASE_URL=<prod> npx tsx scripts/set-platform-admin.ts --list` pide
  `KINESOFT_CONFIRM_PROD=<project ref>`; con la confirmación exacta lista los superadmin.
- [ ] **`npm run db:prod:status`** (con `.env.prod.local` creado) muestra el datasource de Supabase y las
  migraciones pendientes, sin tocar el `.env`.
- [ ] **Roles:** `psql "$OWNER_URL" -f prisma/roles.supabase.sql` **sin** `-v` aborta sin cambios; con
  `-v app_password=… -v service_password=…` crea/rota los roles.
- [ ] **Env de Production incompleta:** si falta una variable obligatoria, el build de Production falla con
  `[env] configuración inválida — <VAR>` (no hace falta forzarlo; revisar el log si pasa).

---

## Ronda 11 — Bloque A1: red de tests + baseline de performance (2026-09-30)

> Todo lo de A1 lo verifica el gate automático. Lo que necesita mano del dueño:

- [ ] **CI en GitHub:** en la próxima PR aparecen los jobs `verify` y `integration`. `integration` corre dos
  veces la suite: con RLS y como owner.
- [ ] **Local:** con el Docker arriba, `npm run test:integration` queda todo verde y
  `npm run test:integration:owner` también, con los 4 del tripwire RLS saltados y el aviso "SKIP: … BYPASSRLS".
  *(Los 37/37 eran de A1; A2/A3 sumaron archivos.)*
- [ ] **Sin basura:** después de correr la integración, no quedan tenants `test-%`. En Adminer (:8080) o psql:
  `SELECT count(*) FROM "Tenant" WHERE slug LIKE 'test-%'` → 0.
- [ ] **Perf (opcional):** `npm run test:perf` imprime la tabla de .docs/PERF.md con números del mismo orden.

---

## Bloque A — A2/A3 (30-sep-2026)

> Gate automático de cierre del Bloque A (A2 + A3a/b/c): `tsc` 0 · unit 252/252 en TZ=UTC y TZ=AR · guard ✓ ·
> integración 175/175 (`kinesoft_app`) y 171 + 4 skip (owner) · `next build` ✓. **Todo lo de abajo se prueba en staging (o local) con `TZ=UTC`**, nunca en un Preview que
> comparta la DB de prod. Marcas: 🧪 **MP** = requiere sandbox de Mercado Pago · 📡 **DSN** = requiere
> `SENTRY_DSN` en staging · ⏱ **JWT** = requiere bajar el JWT expiry de staging · ☁️ **Upstash** = requiere
> Upstash configurado en staging · ✉️ **SMTP** = requiere email real (desde IAM, Resend con dominio propio: EXTERNAL-CONFIG §0.4). Ojo: **A3b no se
> despliega sin A3c** (ver MIGRACIONES-RUNBOOK §Deploy del Bloque A); el QA del signup/stepper va en la sección
> de A3c.

### A2a-S06 · Turnos (guards de escritura)

- [ ] 🔴 Con un PRACTITIONER de **acceso básico** (paciente no asignado ni compartido): el drawer del turno no
  muestra Editar / Reprogramar / estado / borrar; el ICS exportado no trae notas, título ni descripción de ese
  turno.
- [ ] Dos toggles seguidos en Facturación (copago y OS) → ninguno dice "cambió en otra sesión".
- [ ] 🔴 Borrar un turno con **copago cobrado a mano** → rechazo "tiene un cobro registrado… cancelalo".
- [ ] Alargar la duración de una osteopatía sobre un cupo lleno → banner de sobreturno y botón "Forzar".
- [ ] Reactivar un turno CANCELLED sobre un cupo lleno → pide confirmar el sobreturno.
- [ ] "Cambiar" paciente sin elegir uno → no guarda.
- [ ] "Cancelar edición" vuelve todos los campos a como estaban.

### A2a-S08 · Paciente, cobertura y copago

- [ ] 🔴 Editar solo el N° de afiliado → el copago propio del paciente se conserva.
- [ ] 🔴 Cambiar la obra social con copago propio → aviso con el monto; si cancelás, no se guarda nada.
- [ ] Vaciar email y teléfono del paciente → quedan vacíos.
- [ ] Editar el mismo paciente en dos pestañas → la segunda en guardar recibe el aviso de "cambió".
- [ ] No existe "Eliminar" paciente (solo Archivar).
- [ ] Un paciente con más de 100 turnos → "Ver más" en Turnos y Facturación.
- [ ] Invitar al portal con Supabase caído (o sin red al admin) → "Email no enviado", no un falso OK.

### A2a-S03 · Seguimiento

- [ ] 🔴 Cargar EVA y notas **sin guardar** y apretar "Cerrar sesión" → quedan guardadas.
- [ ] Doble click en "Cerrar sesión" → se cierra una sola vez (una EVA, una notificación).
- [ ] Salir de la sesión con cambios sin guardar → aviso.
- [ ] Vaciar las notas de una sesión → quedan vacías.
- [ ] EVA 11 → error de validación.
- [ ] Reprogramar una sesión a un día en el que el paciente tiene turno → aviso con link a la agenda; **el
  turno no se mueve**.
- [ ] "Sesión a medida" → Cancelar no crea nada.
- [ ] PRACTITIONER sin acceso al paciente → la sesión da 404.
- [ ] "Vencidas sin cerrar" muestra solo planes activos.

### A2b-S-pub · Reserva pública y webhook

- [ ] 🔴 Reservar con el DNI de un paciente existente y **otro** email → la ficha queda intacta y el turno
  trae la nota "datos de contacto distintos a la ficha".
- [ ] Reservar para un familiar con el mismo celular → funciona (no error boundary).
- [ ] Cancelar una reserva y volver a reservar → turno nuevo (el cancelado no revive).
- [ ] Forzar un horario fuera de la grilla (editando el request) → rechazo.
- [ ] Una reserva pendiente de pago con más de 30 min → libera el cupo y la agenda la muestra "· vencida".
- [ ] Re-reservar el propio slot vencido → ok, la reserva vieja queda cancelada.
- [ ] 🔴 🧪 **MP:** pagar un turno que ya estaba cancelado → sigue cancelado y llega el aviso "revisá el
  reembolso".

### A2b-S-ui · Paridad de modales y agenda

- [ ] Dirty-guard (Esc, backdrop y X piden confirmar) en Nuevo turno, Nuevo paciente, Editar paciente y el
  drawer del turno.
- [ ] Esc sobre el diálogo de confirmación cierra solo el diálogo, no el drawer de abajo.
- [ ] Alta inline de paciente con conflicto y reintento → no se duplica la ficha.
- [ ] El profesional por defecto del turno nuevo = el del filtro de la agenda.
- [ ] El copago cambia al cambiar el servicio y muestra de dónde sale.
- [ ] "Múltiples turnos" con "actualizar copago" → actualiza el copago del paciente.
- [ ] Toggles "Mostrar cancelados" / "Mostrar ausentes" → conteo de ocultos en el header y se recuerdan al
  recargar.
- [ ] Una reserva "Pendiente de pago" pasa a "· vencida" sin recargar.
- [ ] Perfil → Turnos: dos cambios de estado seguidos sin falso "cambió"; borrar uno cobrado → error y la fila
  vuelve.

### A2b-S-vis · Visibilidad de HC y export

- [ ] PRACTITIONER no asignado → Archivos y Actividad vacías; en el dashboard "Acceso básico" sin acciones;
  próximos turnos solo con el servicio.
- [ ] Export CSV desde Archivados y desde una selección → trae lo pedido, con la columna "Archivado".
- [ ] Un paciente con nombre `=1+1` → en Excel se ve como texto, no como fórmula.
- [ ] Descargar un archivo → queda el `AuditEvent` `patientFile.download`.
- [ ] "Marcar realizado" desde el dashboard con el turno editado en otra pestaña → error de lock y refresco.

### A2b-S-cfg · Montos y equipo

- [ ] Copago de $50 → el turno se crea (antes bloqueaba por el step de 100).
- [ ] "1.500,50" y "1500.5" en precio → se guarda $1.500,50; "abc" bloquea Guardar.
- [ ] Editar precio/copago → aviso "Solo cambia lo que se cobra en turnos sin cobrar que no tengan copago propio, de la
  obra social, del precio Particular ni del plan." (copy de ES2b/S13).
- [ ] Quitar un kine con turnos futuros → error con el conteo; sin turnos → desaparece de la agenda.
- [ ] Cambio de rol → confirmación; transferir OWNER → doble confirmación.
- [ ] Editar servicio/OS → `AuditEvent` con antes/después.

### Fixes de la revisión de A2

- [ ] Turno guest de osteopatía + asignarle paciente → pasa a Confirmado y sigue bloqueando el cupo.
- [ ] Reserva con tarjeta rechazada (FAILED) → "Pendiente de pago" y a los 30 min "· vencida".

### A3a-S-rl · Rate-limit

- [ ] 11 logins malos seguidos → vuelve a /login con el mensaje de demasiados intentos.
- [ ] Invitar el mismo email dos veces seguidas → "Probá de nuevo en N s".
- [ ] Reenviar la invitación al portal dos veces seguidas → idem.
- [ ] ☁️ **Upstash:** en staging con credenciales de Upstash inválidas → el login funciona igual y aparece el
  log `rate_limit.upstash_fallback`.
- [ ] ☁️ **Upstash:** en la consola de Upstash las claves llevan prefijo `rl:preview:` (staging) y
  `rl:production:` (prod), nunca mezcladas.

### A3b-S-auth · Sesión, cookies e identidad

- [ ] 🔴 ⏱ **JWT:** con un JWT expiry corto en staging, usar la app más de 1 h sin deslogueo.
- [ ] `/login?error=<cualquier texto>` → mensaje genérico, no el texto.
- [ ] `/api/auth/sign-in?next=//evil.com` (y `next=@evil.com`) → termina en /dashboard.
- [ ] Login con Google desde el wizard de reserva y desde el portal → funciona (antes 405).
- [ ] Recovery de contraseña abriendo el link en otro dispositivo → funciona (ver A3c).
- [ ] Re-invitar a un email con otro rol → la invitación queda con el rol nuevo.
- [ ] 🔴 Un usuario del equipo entra al portal de pacientes → ve "sin fichas".
- [ ] 🔴 Check-in del paciente → llega como notificación al kine y las notas de la ficha quedan intactas.
- [ ] Las cookies `sb-…` aparecen como HttpOnly (y Secure en staging/prod) en DevTools.

### A3b-S-obs · Sentry, CSP, headers

- [ ] 📡 **DSN:** forzar un error de servidor → llega a Sentry sin emails, DNI ni tokens.
- [ ] 📡 **DSN:** los reportes de CSP aparecen en Sentry → Security.
- [ ] `curl -I` a prod → trae `Strict-Transport-Security`; a un Preview → no.
- [ ] Login con Google desde el portal → sin violaciones de `form-action` en la consola.
- [ ] Un video de YouTube de la biblioteca y las Google Fonts → sin violaciones de CSP.

### A3c · Signup verificado y stepper de alta

> Con ✉️ email real. **Desde IAM (14-oct)** los mails los manda la app por Resend (EXTERNAL-CONFIG §0.4) y las
> plantillas de Supabase ya no se usan; «Confirm email» ON sigue (§0.1). Sin staging (decisión del 14-oct): QA en prod
> demo. El QA vigente del signup está en «Identidad y acceso».

- [ ] 🔴 ✉️ Landing → "Probar gratis" → signup → llega el mail → abrirlo **en el celular** → cae en
  `/onboarding` paso 2.
- [ ] 🔴 Completar los pasos 2 a 9 (desde B-pre: Sede y Tu horario suman dos) → termina en `/agenda`. Recargar a mitad del stepper → retoma en el paso
  donde estaba.
- [ ] Volver al paso 2 y guardar de nuevo → edita el consultorio, no duplica tenant ni slug.
- [ ] Último paso ("Listo") sin ningún servicio cargado → bloqueado con el aviso.
- [ ] 🔴 ✉️ Signup con un email ya registrado (o de un paciente con portal) → el mismo mensaje de "te mandamos
  un mail", y no llega ningún mail.
- [ ] ✉️ Invitación → "Crear mi cuenta para unirme" → el email viene fijo → confirmar → `/invite/<token>` →
  aceptar → entra a la app **sin** stepper.
- [ ] ✉️ Cuenta verificada que tiene una invitación pendiente → en `/onboarding` ve la invitación y puede
  aceptarla o crear su propio consultorio.
- [ ] 🔴 ✉️ "Olvidé mi contraseña" → link → `/reset` **sin** pedir la actual. Reusar el mismo link (o volver a
  `/reset` después del cambio) → ahora pide la actual.
- [ ] 🔴 El cliente vivo (tenant existente) entra y **no** ve el stepper.
- [ ] Entrar sin sesión a una ruta protegida (p. ej. `/pacientes/<id>`) → `/login?next=…` y, tras loguearse,
  vuelve a esa ruta.

---

## B-pre — agenda profesional y catálogo (01-oct-2026)

> Gate automático: `tsc` 0 · unit 1155/1155 en 51 archivos (TZ=UTC y TZ=AR, con render tests) · guard ✓ ·
> integración 389/389 (`kinesoft_app`) y 373 + 16 skip (owner) · `next build` ✓. **Todo en staging (o local) con
> `TZ=UTC`**, después de aplicar las DOS migraciones de B-pre y el import del catálogo en staging
> (MIGRACIONES-RUNBOOK §2.2). Para los casos multi-profesional: un consultorio de prueba con 6 profesionales y 2
> sedes; para "cliente vivo", una copia con 1 profesional.

### Catálogo
- [ ] Plataforma → Catálogo: buscar una prestadora por nombre y por alias; editarla → queda "curada"; re-correr el
  import en dry-run → esa fila no aparece como cambio.
- [ ] Archivar una práctica → deja de ofrecerse en el picker de Servicios; los servicios que ya la tenían siguen
  andando.
- [ ] Merge de dos prestadoras → las obras sociales de los consultorios y sus planes apuntan a la que queda.
- [ ] Un consultorio propone "Otro plan…" → aparece en Propuestas → promoverlo → queda global y el paciente sigue
  con su plan.
- [ ] Importaciones: se ve la corrida con conteos; "Refrescar catálogo" → un consultorio ve el cambio sin esperar.
- [ ] Configuración → Obras sociales → "Agregar del catálogo"; una OS tipeada a mano muestra la sugerencia
  "vincular al catálogo".
- [ ] Servicio con práctica del catálogo; plan de cobertura del paciente con el picker (y texto libre si la OS no
  está vinculada).

### Configuración (Sedes y Profesionales)
- [ ] Sedes: la "Principal" existe; crear otra, marcarla principal; archivar una con franjas/turnos → muestra los
  conteos y pide confirmación.
- [ ] Profesionales → Horarios: franjas por día (dos franjas el mismo día), "copiar a otros días", solape en el
  mismo día o entre sedes → error claro.
- [ ] Editar el mismo horario en dos pestañas → la segunda en guardar recibe el aviso de conflicto.
- [ ] Excepciones: día cerrado y horario especial (abrir un domingo).
- [ ] Servicios por profesional (habilitado, duración propia, público/privado, cupo) y coberturas (Particular no
  se puede destildar).
- [ ] 🔴 Cliente vivo: sus franjas son lun-sáb con el horario del consultorio; cambiar el horario del consultorio
  mueve también la plantilla por defecto.

### Agenda
- [ ] 🔴 Cliente de **1 profesional**: la agenda se ve y se comporta igual que antes (turnos, horas, sobreturnos
  viejos con badge).
- [ ] Secretaria con 6 profesionales: chips con favoritos, `?pros=` en la URL, "Todos".
- [ ] Modo "Por profesional": una columna por profesional, ocupación "2/3" y "4/∞", celda llena "1/1",
  sobreturno marcado, fuera de horario y bloqueado rayado, línea de ahora, navegación con teclado.
- [ ] 🔴 Candado de **todo el equipo** con "cancelar turnos" → los turnos con cobro registrado **quedan** (aviso);
  el resto se cancela. Candado parcial (algunos profesionales). Desbloquear.
- [ ] Candado mientras otra pestaña carga un turno en ese día → el candado avisa "cambió" y re-muestra afectados.
- [ ] Recepción: Llegó → En atención → Atendido; "Deshacer"; un guest o una reserva pública impaga vuelve a
  pendiente. Dos pestañas marcando el mismo turno → la segunda recibe el aviso de conflicto.
- [ ] Un PRACTITIONER no puede marcar la recepción de un turno de otro profesional cuyo paciente no ve completo.
- [ ] Filtro de sede; vista en 375 px.

### Modal de turno
- [ ] Solo se ofrecen los servicios habilitados del profesional, con su duración.
- [ ] Slot picker: días, chips de horario, "cualquier profesional" → elige el primer libre.
- [ ] Horario bloqueado → aviso con "Cargar como sobreturno" y "Usar próximo libre"; fuera de horario → "Cargar
  igual".
- [ ] Profesional que no atiende el servicio → "No atiende este servicio — habilitalo en Configuración →
  Profesionales" y no deja guardar.
- [ ] Varias sesiones: semanal, cada 2 semanas y mensual desde un 31 (cae el último día de los meses cortos);
  preview por fecha con duplicados/bloqueados/fuera de horario.
- [ ] Bloquear horario: un PRACTITIONER solo puede bloquear lo propio; admin/recepción puede "todos".
- [ ] Telemedicina: exige URL `https://`; el badge aparece en la card.

### Drawer, turnos del paciente y dashboard
- [ ] Reprogramar o reactivar un turno sobre un bloqueo / fuera de horario → mismo aviso forzable.

### Turnero público
- [ ] Filtros de sede y cobertura; servicios según el profesional; "primer turno disponible".
- [ ] Día bloqueado → sin horarios; domingo con excepción "horario especial" → ofrece ese domingo.
- [ ] Servicio PRIVATE de un profesional → no se ofrece con ese profesional.
- [ ] 🔴 Dos reservas simultáneas en un cupo 1 → entra una sola.
- [ ] Mobile 375 px.

### Onboarding
- [ ] Alta nueva: 9 pasos; Sede con dirección, Tu horario, práctica en servicios, obras sociales del catálogo.
- [ ] 🔴 El cliente vivo no ve el stepper.

## Planes P0 (ES1) — fugas E0, Secretaria, fixes de planes (04-oct-2026)

> **Sin migraciones.** Todo en staging (o local) con **`TZ=UTC`**, sobre B-pre ya aplicado. Usuarios de prueba:
> OWNER, PRACTITIONER con un paciente ajeno (acceso básico), Secretaria (ASSISTANT) y BILLING; un tenant con
> "Consultorio común" y otro sin. Para Storage, `SUPABASE_SERVICE_ROLE_KEY` cargada en el entorno.
> Primero la agenda completa de [§B-pre](#b-pre--agenda-profesional-y-catálogo-01-oct-2026) (no cambió).

### Planes y fechas
- [ ] 🔴 Crear un plan desde la Tab Plan a las 22:30 AR → la sesión 1 cae **hoy** (no ayer a las 21:00).
> ⚠️ **Obsoletos desde ES3** (la Tab Plan vieja, el modal viejo de Diagnóstico, `applyPlanTemplate` y
> `addCustomSession` se retiraron): los 4 ítems tachados se prueban sobre el editor nuevo en [§Planes P3](#planes-p3-es3--ui-de-planes-ingresos-reales-y-retiro-08-oct-2026).
- [ ] ~~Tab Plan: 6 y 7 sesiones por semana se aceptan; más de 60 sesiones → error visible; "Aplicar plantilla" en
  gris con aviso en FREE; cambiar el estado pide confirmación y un error se ve; "Eliminar" solo para admin.~~
- [ ] ~~Diagnóstico → Asignar plan: fecha de hoy AR, sin paciente preseleccionado; lun/jue → sesiones solo lun y jue;
  1 día × 60 sesiones → error "máximo 58" visible; sin días → error; wizard con "No encontramos…" si no hay match.~~
- [ ] ~~Plantilla con ejercicios sin dosis → crea 3×12; un PRACTITIONER en básico no aplica plantilla ni crea plan
  (ni desde Diagnóstico); borrar la plantilla de otro sin ser admin → rechazo.~~
- [ ] ~~Doble click en "Sesión a medida" → una sola sesión nueva.~~
- [ ] Bulk de ejercicios no toca sesiones realizadas; reprogramar una sesión de un plan cancelado → rechazo; un
  ejercicio archivado no se puede asignar.
- [ ] Cerrar desde Seguimiento la última sesión → plan COMPLETED y aparece en Actividad. **Cerrar desde dos pestañas
  las dos últimas sesiones → plan COMPLETED.**
- [ ] Perfil: plan COMPLETED o PAUSED → el hero no dice "Plan activo"; con 2 ACTIVE muestra el más reciente y "+1";
  Sesiones agrupadas con badge coherente.

### Secretaria (ASSISTANT) y Facturación (BILLING)
- [ ] 🔴 La Secretaria reprograma, cambia estado, cancela y crea un turno de un paciente en básico, **sin ver ni pisar**
  título, descripción ni notas. No ve Eliminar ni cobros. "Usar como diagnóstico" no aparece.
- [ ] 🔴 La Secretaria da de alta un paciente desde el modal del turno → queda a cargo del profesional del turno; la
  Secretaria no ve su HC. En el directorio no hay botón "Nuevo paciente".
- [ ] Con "Consultorio común", la Secretaria ve el perfil administrativo (datos y turnos con estado de cobro), sin
  pestañas clínicas; "Agregar turno" visible. BILLING ve el perfil sin "Agregar turno" y no opera turnos.
- [ ] Re-vincular un turno con notas a otro paciente como Secretaria → *"Este turno tiene datos clínicos: pedile al
  profesional que lo cambie"*. El copago que tipea la Secretaria se ignora (rige la cobertura); en un guest sí lo fija.
- [ ] BILLING no opera turnos guest (ni borra ni cobra).
- [ ] Directorio como Secretaria: con `?diagnosisSlug=…` o `?filter=active` → lista vacía; sin filtros ve todos.
- [ ] Secretaria asignada a un paciente no puede compartirlo ni reasignarlo.
- [ ] PRACTITIONER básico: el perfil ajeno dice "Sin acceso" a la HC; no encuentra por email a un paciente ajeno; el
  picker del Plan Builder muestra solo propios y compartidos.
- [ ] Dashboard de la Secretaria con alcance propio; Seguimiento vacío.

### PHI, exports y Storage
- [ ] ICS exportado por la Secretaria → sin título, descripción ni notas.
- [ ] Portal del paciente con 2 planes ACTIVE → muestra el más reciente y **sin** notas de sesión.
- [ ] Archivos del paciente: subir, descargar y borrar (full); un básico no los ve.
- [ ] Plataforma → media de ejercicios: subir, ver y borrar; `/biblioteca/<slug>` muestra la media.

### Display
- [ ] Ausente en ámbar en Lista, drawer, perfil y Recepción (StatusTag único).

### Plata (lógica pura; se ve desde ES2b, se prueba en unit)
- [ ] Ausente con copago REFUNDED → el turno de reemplazo lleva la cuota, no $0 (con PAID previo → $0).
- [ ] Preview con la última sesión en un día bloqueado → sugiere el día hábil siguiente.

### Prechecks de Martin (solo lectura, durante ES1)
- [ ] (0)-(17) de PLANES.md §16; si (2) > 0, dedupe en dry-run (MIGRACIONES-RUNBOOK §2.3); si (15) > 0, reasignar.

---

## EV0 · Verticales y Plataforma (07-oct-2026)

> Correr con `TZ=UTC npm run dev` contra el Docker local, con M2 aplicada (`dotenv -e .env.local -- npx prisma migrate
> deploy`) y un usuario superadmin. **El seed demo arranca con los turnos online apagados** (M2: default `false`,
> opt-in): para probar el turnero de `movare`, prendelos primero (Configuración o /plataforma). Contexto en
> [VERTICALES.md](VERTICALES.md). Después de cambiar la vertical desde /plataforma, **recargá**: el nav no se repinta en
> navegación suave (los guards sí redirigen).

### /plataforma (superadmin)
- [ ] 🔴 Un OWNER que no es superadmin no ve "Plataforma" en el nav y `/plataforma/consultorios` le da 404 (desde BO3-A).
- [ ] `/plataforma` (Resumen): cantidades por vertical × plan, trials por vencer, onboarding pendiente. Sub-nav Resumen ·
  Consultorios · Ejercicios · Tags · Catálogo.
- [ ] Consultorios: lista con filtros, columnas "Turnos online" (Activo / Apagado) y "Titular", sin Miembros ni Creado
  (están en el detalle); entra en pantalla sin scroll horizontal a 1366 px.
- [ ] 🔴 Detalle → "Editar suscripción": cambiar la vertical pide confirmación (`useConfirm`); guardar → toast y el
  detalle muestra el cambio. El historial de cambios del consultorio muestra `platform.*`; el consultorio del
  superadmin **no** registra nada.
- [ ] 🔴 Stale: abrir el Drawer en dos pestañas, guardar en una y después en la otra → "Otro cambio se guardó antes.
  Recargá y revisá." y el Drawer se resincroniza (no pisa el cambio).
- [ ] El detalle no muestra datos de pacientes, turnos ni HC: solo conteos.

### Vertical General vs Kinesiología
- [ ] 🔴 Pasar `movare` a **General** y recargar: nav sin Diagnóstico, Seguimiento, Ejercicios, Terapia Manual ni
  Reportes; ⌘K sin esos atajos ni condiciones. `/diagnostico`, `/seguimiento`, `/biblioteca`, `/terapia-manual` y
  `/reportes` escritos a mano → `/dashboard`.
- [ ] Configuración en General: sin pestaña Diagnósticos; la card "Funciones del consultorio" muestra tipo y plan de
  solo lectura.
- [ ] ~~Perfil del paciente sin Plan/Sesiones en General~~ → se prueba en [§Planes P3](#planes-p3-es3--ui-de-planes-ingresos-reales-y-retiro-08-oct-2026) (General).
- [ ] Volver a **Kinesiología** y recargar: todo vuelve. Atajos ⌘K "Inicio" y "Ejercicios" (mismos nombres que el nav).

### Catálogo de ejercicios por plan
- [ ] 🔴 Kine **FREE/STARTER**: Biblioteca sin ejercicios globales; empty state "Creá tu primer ejercicio" + "PRO suma el
  catálogo de la plataforma." (en Terapia Manual, "Creá tu primera maniobra"). Crear un ejercicio propio funciona.
- [ ] Kine **PRO**: ve el catálogo de Plataforma y puede asignarlo.
- [ ] Filtro de condiciones de la Biblioteca: solo condiciones globales y las de este consultorio (crear una condición
  custom en otro consultorio y verificar que no aparece).
- [ ] Favoritos bloqueados sin STARTER: el copy dice "plan Base".

### Turnos online (switch)
- [ ] 🔴 Apagados: `/c/movare/booking` muestra "Turnos online no disponibles" con el contacto del consultorio (o sin
  canales si no hay contacto); el email largo corta bien en mobile. El HTML lleva `noindex`.
- [ ] 🔴 Apagados con un turno ya reservado: la página de estado del turno sigue funcionando.
- [ ] Prender desde Configuración → General ("Funciones del consultorio" → switch "Turnos online", con nombre
  accesible): el wizard vuelve. Apagarlo pide confirmación ("¿Apagar los turnos online?").
- [ ] Prender/apagar desde /plataforma: Configuración refleja el valor al recargar; el detalle del consultorio tiene
  "Ver la página de turnos ↗".
- [ ] 🔴 Prefill: logueado con un email que tiene ficha en **otro** consultorio → el wizard de `movare` no precarga DNI,
  nacimiento, cobertura ni emergencia (a lo sumo el nombre de la sesión). Con ficha en `movare` → precarga esa.

### Onboarding y alta
- [ ] Onboarding nuevo: segmentado "Kinesiología y osteopatía" / "Clínica general" (rótulo desde BO3); el consultorio nace con esa
  vertical y con los turnos online apagados (el paso lo avisa: "Activalos en Configuración → General"). Las tarjetas no
  desbordan a 320 px.
- [ ] `create-tenant --vertical general|kinesiologia` crea con esa vertical (solo local).

### Data API (Martin, consola de prod)
- [ ] Precheck de solo lectura de VERTICALES §1 y desactivar la Data API (o sacar `public`).

---

## Planes P2 (ES2b) — core de turnos y dominio server (07-oct-2026)

> **Sin migraciones nuevas.** Correr con `TZ=UTC npm run dev` contra el Docker local (M1 y M2 aplicadas). ES2b es todo
> server: la UI de Planes llega con ES3, así que acá va (A) lo que ya se ve desde la UI vieja y (B) lo que queda para
> el QA de ES3. Usuarios: OWNER, PRACTITIONER con un paciente ajeno (básico), Secretaria (ASSISTANT), BILLING; un
> consultorio Kine y uno General. Contexto en [PLANES.md §10](PLANES.md) y [AUDIT.md §Ronda 17](AUDIT.md).

### (A) Desde la UI de hoy

**Buscador de pacientes de la agenda (P2-FX1)**
- [ ] 🔴 Modal de turno nuevo y drawer, como **Secretaria**: el buscador encuentra pacientes por nombre, apellido,
  "Juan Pérez" y DNI (también tipeado "30.123.456"). Placeholder "Buscá por nombre o DNI…". No muestra edad, plan
  ni email. Un archivado no aparece.
- [ ] Mismo buscador como PRACTITIONER (encuentra a un paciente ajeno en básico) y en un consultorio **General**.
- [ ] El picker del Plan Builder / Diagnóstico sigue mostrando solo pacientes propios o compartidos (full).

**Configuración y guardas (S13, S13g)**
- [ ] Servicios: con módulo `planes`, el modal tiene "Disciplina" con el hint "Los planes de esa disciplina ofrecen
  este servicio. Sin disciplina, lo ofrecen todos." y la lista muestra "Disciplina: …"; en General no aparece.
- [ ] Borrar un servicio usado por un plan → mensaje claro (no 500). Archivar una sede con un plan ACTIVE y quitar
  del equipo al responsable de un plan ACTIVE → mensaje con el motivo.

**Biblioteca (S13x, B-L1)**
- [ ] Crear el tag "Kinesiología" o "Osteopatía" → no se crea (el error no se ve en prod: `onCreateTag-sin-error`,
  C1). Los filtros de tags solo muestran tags usados por ejercicios globales o propios (un tag creado en otro
  consultorio no aparece).

**~~Tab Plan vieja (legacy delegando en S15/S12b)~~** — obsoleto desde ES3: la Tab Plan vieja, "Eliminar sesión" y
`addCustomSession` se retiraron. Lo equivalente está en [§Planes P3](#planes-p3-es3--ui-de-planes-ingresos-reales-y-retiro-08-oct-2026) (perfil).
- [ ] ~~Editar un plan: solo se guarda el título (total, frecuencia e inicio ya no cambian las sesiones).~~
- [ ] ~~"Eliminar sesión" → *"archivala desde el plan"*; "Eliminar" (admin) un plan ACTIVE → rechazo ("primero hay que cancelarlo"); uno CANCELLED/COMPLETED →
  desaparece de la lista (archivado, no borrado).~~
- [ ] ~~Cambiar el estado (pausar/cancelar) → los turnos quedan como estaban (la UI vieja manda "mantener").~~
- [ ] ~~"Sesión a medida" en un plan con precio **Paquete** → rechazo con copy accionable; en un plan COMPLETED →
  rechazo; como Secretaria → no puede. En un plan sin precio → se agrega con su título y "Deshacer Atendido" la reabre.~~
- [ ] Reprogramar una sesión que tiene turno: mueve el turno por el core (con los avisos de cupo/bloqueo); a un
  horario donde el paciente ya tiene turno → mensaje, no 500.

**Seguimiento (S12b)**
- [ ] Cerrar una sesión con turno PENDING/CONFIRMED → el turno pasa a Atendido en la agenda.
- [ ] Cerrar la última sesión → el plan **no** se completa solo (D22: queda la sugerencia de alta para ES3).
- [ ] Cerrar desde dos pestañas la misma sesión → una gana y la otra recibe un mensaje (no 500).
- [ ] En General: `/seguimiento` redirige; Seguimiento vacío sin el módulo `sesiones`.

**Pacientes, cobros y dashboard**
- [ ] Archivar un paciente con un plan ACTIVE → el plan queda PAUSED y sus turnos siguen en la agenda (L9).
- [ ] Turno suelto sin copago propio: marcar Cobrado y después cambiar la cobertura del paciente → el monto cobrado no
  cambia (Q8).
- [ ] Dashboard: "sesión n" muestra el ordinal entre vivas, no el índice; como Secretaria, sin título ni condición; en
  General no consulta planes (0).

### (B) Para el QA de ES3 (hoy solo con tests de integración)

> Desde ES3 se ven en la UI: se prueban junto con [§Planes P3](#planes-p3-es3--ui-de-planes-ingresos-reales-y-retiro-08-oct-2026).

- [ ] Crear un plan con "Revisá los turnos" (TZ=UTC): 10 sesiones lun/jue caen en el día AR correcto; keys `plan:`; un
  bloqueo nunca se fuerza; stale si la agenda cambió.
- [ ] Chip `Kine · 3/10` en la agenda, sin título para Secretaria/BILLING/básico; "Fuera de plan" en turnos sueltos del
  mismo paciente y disciplina.
- [ ] Drawer/Recepción sobre turnos de plan: reprogramar mueve la sesión; Ausente deja la sesión "sin turno"; cancelar
  con cobro → *"Tiene un cobro registrado: reprogramalo"*; borrar → *"cancelalo y la sesión queda sin turno"*; Deshacer
  Ausente con otro turno activo → mensaje; los `notice` se ven como toast.
- [ ] Ciclo de vida: diálogo D7 (cancelar/mantener futuros; los cobrados no se tocan), archivar, restaurar
  (OWNER/ADMIN), reactivar revalida sede y responsable.
- [ ] Mover "este y los siguientes" (+1 h en una tx; un conflicto = stale entero) y re-planificar desde la sesión N con
  cambio de profesional; lo cobrado queda intacto.
- [ ] Cantidad y precio: 10→12, reducir archiva las últimas sin cobro, reprecio solo en futuros impagos, PACKAGE
  "mantener total / precio por sesión", "sin precio" con sesiones realizadas → PACKAGE rechaza con copy
  (`locked-unpriced`).
- [ ] Cobro previo: Ausente cobrado → el turno nuevo de esa sesión sale $0; desmarcar el cobro del previo re-estampa el
  reemplazo con aviso.
- [ ] Generar turnos de pendientes (la Secretaria puede, con una sesión puntual), vincular un turno suelto, adoptar
  una serie, sacar del plan (con cobro → rechazo).
- [ ] Autorización de la OS: alta con el plan, renovación (ASSISTANT sí, BILLING no), avisos de exceso y vencimiento
  (30/11 23:00 AR no vencida); no aparece en agenda, ICS ni portal; un PRACTITIONER básico no la ve.
- [ ] Diagnóstico → plan por el motor (caso + plan + turnos en una tx; un stale no deja nada).
- [ ] Saldo del plan: pactado, devengado, cobrado (la OS pagada no suma; C0), pendiente y a favor nunca negativos.

---

## Planes P3 (ES3) — UI de Planes, ingresos reales y retiro (08-oct-2026)

> **1 migración nueva: M3a `20261008120000_billing_paid_at`.** Correr con `TZ=UTC npm run dev` contra el Docker local
> con M1, M2 y M3a aplicadas (`dotenv -e .env.local -- npx prisma migrate deploy`). Usuarios: OWNER, PRACTITIONER con
> un paciente ajeno (básico), Secretaria (ASSISTANT) y BILLING; un consultorio Kine PRO, uno Kine FREE y uno General.
> Servicios con disciplina cargada. Contexto en [PLANES.md §11](PLANES.md) y [AUDIT.md §Ronda 18](AUDIT.md).
> Incluye lo pendiente de [§Planes P2 (B)](#b-para-el-qa-de-es3-hoy-solo-con-tests-de-integración).

### Editor (crear / generar / re-planificar)
- [ ] 🔴 "Nuevo plan" desde la Tab Planes: Drawer de 600 px, orden C13 (disciplina → servicio → responsable → sede →
  inicio, cantidad y horario → precio → notas). 10 sesiones lun/jue → "Revisá los turnos" con las fechas AR correctas,
  resumen y "Crear plan y N turnos". Conflictos: "Sobreturno", "Bloqueado: <motivo>", "Ya tiene un turno a esa hora".
- [ ] 🔴 Stale: con el editor abierto, ocupar un horario desde otra pestaña → al confirmar, aviso C13 y las filas
  marcadas (no se borra solo).
- [ ] Red caída (DevTools offline) al revisar → *"No pudimos revisar la agenda. Probá de nuevo."*; no queda trabado en
  "Buscando turnos…".
- [ ] "Generar turnos para pendientes" en un plan de 10 con la 3 archivada → la columna "#" muestra el ordinal (no el
  índice). Solo aparece con más de 1 pendiente.
- [ ] "Editar desde la sesión N" (re-planificar) con cambio de profesional; lo cobrado no se mueve.

### Agenda y drawer
- [ ] Chip `Kine · 3/10` en Día, Semana, Lista, Por profesional y Recepción; sin título para Secretaria/BILLING/básico.
  "Fuera de plan" en un turno suelto del mismo paciente y disciplina.
- [ ] Leyenda De plan / Sueltos resalta (no filtra) y se recuerda al recargar; el conteo de Semana coincide con la
  leyenda (sin cancelados).
- [ ] Drawer de un turno de plan: fila Plan con "Sesión n de N"; "Agendar próxima sesión" (también la Secretaria, sin
  título); "Sacar del plan" (`plans.manage`); "Renovar autorización" (ASSISTANT sí, BILLING no). Turno Fuera de plan:
  "Vincular a una sesión" y "Crear plan desde este turno" (puerta 4).
- [ ] "Cancelalo" solo en PENDING/CONFIRMED. Con el drawer sucio, un link de la fila Plan pide confirmación.
- [ ] Reprogramar un turno de plan → "Solo este / Este y los siguientes"; "Copago (plan)"; recordatorio impreso con
  "Sesión 3 de 10".
- [ ] Ausente → *"la sesión 3 queda sin turno para reprogramar"*.
- [ ] Candado del día con 2 sesiones de plan y 1 suelto → aviso *"2 de estos turnos son sesiones de un plan…"* y chip
  "Plan" en esas 2 filas, sin título. Sin sesiones de plan, no hay aviso.
- [ ] Modal "Varias sesiones" → "Crealo como plan…"; con paciente sin guardar, deshabilitado con *"Guardá el paciente
  para armar un plan"*.

### Seguimiento
- [ ] Bucket "Sin turno" → "Agendar" abre un modal de **una fila** (no el editor); stale → aviso y reintento.
- [ ] Atendido sin evolución → tag "Sin evolución" → "Cargar evolución". Título de la pestaña "Sesión n de N" (ordinal).
- [ ] Cerrar la última sesión → banner de alta (no completa solo). Entrar con `?agendar=1` → abre el modal y la URL
  queda sin el parámetro.

### Perfil del paciente
- [ ] `?tab=plan` abre la pestaña Planes (alias); `?tab=planes&programa=<id>` enfoca el plan.
- [ ] PlanCard: estados de sesión, línea de autorización (solo a quien la ve), historial, "Aplicar plantilla" por el
  editor. Cambiar estado → diálogo D7 (cancelar recomendado; los cobrados no se tocan); "Cancelar" en rojo. Un plan
  COMPLETED dice "Finalizado".
- [ ] 🔴 Plata con CAS: cantidad 10→12 y bajar a 8; precio con turnos cobrados (*"M quedan como están"*); PACKAGE
  "mantener total / precio por sesión"; sesión a medida; archivar y restaurar sesión. Dos pestañas → la segunda recibe
  stale y recarga.
- [ ] Hero: un chip por disciplina, sin título. Archivar el paciente con un plan ACTIVE o PAUSED → diálogo L9.
- [ ] Turnos y Facturación agrupados por plan con el saldo del server (pactado, devengado, cobrado, OS aparte); los
  cancelados con cobro se ven (desde SR, también sin agrupar: §Salas (SR)). A 360 px, las tablas scrollean adentro y "Ver en agenda" no se corta.
- [ ] 🔴 Secretaria: perfil administrativo con turnos y facturación por plan **sin títulos** de plan.

### `/planes/[disciplina]` y plantillas
- [ ] Pestañas solo de disciplinas con un servicio activo; otra disciplina en la URL → 404. "Nuevo plan" con
  `plans.manage`.
- [ ] "Sesiones sin turno" (la Secretaria también, sin título) → Agendar.
- [ ] Plantillas: CRUD en STARTER+; en FREE deshabilitadas con aviso. 🔴 FREE no puede crear un plan con plantilla (ni
  por RPC). Plantilla con un ejercicio archivado después → el plan se crea igual, sin ese ejercicio; ejercicios sin
  dosis toman la dosis por defecto del ejercicio.

### Diagnóstico
- [ ] `/diagnostico?patientId=&bookingId=` → "Asignar plan" abre el editor prellenado, sin paciente preseleccionado
  cuando no viene en el link; fecha de hoy AR; la nota de ejercicios muestra la rampa ("Sesiones 1-3 · Activación ·
  2 ejercicios"). El wizard (mobile) abre el mismo editor.

### Dashboard (S14r + M3a)
- [ ] 🔴 Cobrar un copago a mano hoy → aparece en "Semana" y en "Mes"; desmarcarlo → desaparece. Re-marcarlo otro día
  no lo muda de mes.
- [ ] Un pago de MP no se duplica; lo de la obra social se ve aparte. El selector Mes/Semana se recuerda al recargar.
  Borde: un cobro el domingo 23:30 AR cuenta en esa semana.

### Clínica general (vertical GENERAL)
- [ ] 🔴 Nada de Planes, Diagnóstico ni EVA: sin pestaña Planes, Resumen sin "Plan de tratamiento" ni "Diagnóstico
  principal", sin slot de EVA; agenda sin leyenda ni chip; drawer sin fila Plan; candado sin aviso de plan.

## Salas (SR) — salas y consultorios, Facturación e ingresos por rol (08-oct-2026)

> **1 migración nueva: M4 `20261009120000_rooms`.** Correr con `TZ=UTC npm run dev` contra el Docker local con M1-M4
> aplicadas (`dotenv -e .env.local -- npx prisma migrate deploy`). Usuarios: OWNER, dos PRACTITIONER (AP y BF), Secretaria
> (ASSISTANT) y BILLING; dos sedes. Contexto en [ARCHITECTURE.md §Salas (SR)](ARCHITECTURE.md) y
> [AUDIT.md §Ronda 19](AUDIT.md).

### Sin salas (el consultorio del cliente vivo)
- [ ] 🔴 Día, Por profesional, Semana, Lista y Recepción iguales que antes: sin filtro de sala, sin "Por sala", sin
  "· Sala" en las tarjetas, sin columna Sala. Candado igual que antes. Alta y edición como siempre.
- [ ] Editor de horarios ("Editar semana") sin la línea de vigencia. En Sedes solo aparece "· Sin salas" y el link
  "Salas".

### OWNER: Configuración
- [ ] Configuración › Sedes › Salas: en la principal "Consultorio 1" (capacidad 1) y "Gimnasio" (3); en otra sede
  "Box A". Ayuda de capacidad: "Profesionales a la vez". Nombre repetido en la misma sede → error en el campo.
- [ ] Franja de AP 9–13 en Consultorio 1 y de BF 14–18. 🔴 Darle a BF 12–15 en Consultorio 1 → choque, no guarda. Con
  vigencia que no se pisa ("Solo por un período"), guarda.
- [ ] Una franja vencida con una sala que después se archiva → la semana guarda igual.
- [ ] Archivar una sala con franjas, turnos futuros o excepciones futuras → se niega y dice por qué. Sin eso, archiva y
  sus bloqueos futuros desaparecen.

### Secretaria: agenda
- [ ] Día con "Todas las sedes": filtro "Todas las salas / Consultorio 1 / Gimnasio / Sin sala" con conteos del día;
  tarjetas "· Consultorio 1" (lector: "en Consultorio 1").
- [ ] Elegir "Gimnasio": solo sus turnos, sin la sala en las tarjetas; se recuerda al refrescar. Cambiar a la otra
  sede: el filtro vuelve a "Todas" (una sola sala → no hay filtro).
- [ ] Toggle Día / Por profesional / Por sala: flechas con vuelta; columnas en el orden de Configuración, header
  "Asignada: AP 9–13" (nunca "?"), "Sin sala" al final solo con turnos de esa sede. En "Por sala" no hay chips de
  profesionales.
- [ ] Click (o Enter) en una celda libre del Gimnasio a las 10:00 → modal con Gimnasio y 10:00. En "Sin sala", sin
  sala.
- [ ] 🔴 Dos profesionales en Consultorio 1 a la misma hora → celda 2/1, el modal pide "Agendar igual"; el turno
  **no** queda como `[SOBRETURNO]`. El mismo profesional con dos pacientes en su sala no choca consigo mismo.
- [ ] Turno de 6 h (servicio de 360 min) en Consultorio 1 a las 8:00 → otro profesional a las 12:30 en la misma sala:
  avisa ocupada.
- [ ] 🔴 Candado › "Una sala" › Consultorio 1, 11–12, "Mantenimiento": en "Por sala" solo esa columna rayada y sin
  alta; en Por profesional la agenda de AP sigue libre (el bloqueo de sala **no cambia la agenda de nadie**). Alta en
  esa sala a las 11:30 → "bloqueado (Mantenimiento)" con opción de asignar igual. Al reabrir el candado aparece
  "11:00–12:00 · Consultorio 1 · Mantenimiento"; "Desbloquear" lo quita.
- [ ] Recepción: columna "Sala" entre Profesional y Estado ("—" sin sala, "Sala archivada" si la archivaron). A 360 px,
  "SALA · Consultorio 1" sin scroll horizontal.
- [ ] Drawer › fila Sala › Cambiar: si está ocupada, "Asignar igual"; el foco vuelve a "Cambiar". En el modal, el
  select Sala solo aparece si la sede elegida tiene salas.
- [ ] Turno a las 23:30 AR: se ve a las 23:30 y "continúa" el día siguiente.
- [ ] Varias sesiones (batch) con una fecha en sala ocupada → esa fecha se omite salvo tildar la casilla aparte.

### PRACTITIONER y Planes
- [ ] Ve el filtro y "Por sala"; el candado no ofrece "Una sala" y un bloqueo de sala sale deshabilitado ("Es un
  bloqueo de sala.").
- [ ] Turno de plan en "Por sala": chip de sesión, nunca el título del plan.
- [ ] PlanCard › reprogramar una sesión a una hora con la sala por defecto ocupada → "Moverlo igual (sala ocupada)".

### Facturación (SR-D4F) e ingresos por rol (SR-D5I)
- [ ] 🔴 Turno suelto cancelado (y uno ausente) con copago cobrado → aparece en Facturación sin agrupar y agrupada, y
  suma en "percibido".
- [ ] 🔴 OWNER y BILLING: "Ingresos del mes" de todo el consultorio. PRACTITIONER: "Tus ingresos del mes", solo sus
  turnos (dos profesionales seguidos en la misma ventana del cache: cada uno ve lo suyo). Secretaria: sin widget ni
  KPI, y el picker de KPI no ofrece ingresos.

### Cierre
- [ ] Guardar "Por sala" y archivar todas las salas → la agenda abre en el Día de siempre.
- [ ] A 360 px, filtro y toggle envuelven sin scroll horizontal.

## Sala de Espera realtime (SV) — `/sala`, «Llamar», avisos y agenda en vivo (13/14-oct-2026)

> **1 migración nueva: M5 `20261013120000_reception_call_realtime`.** Correr con `REALTIME_DRIVER=local TZ=UTC npm run dev`
> contra el Docker local con M1-M5 aplicadas (`dotenv -e .env.local -- npx prisma migrate deploy`). Usuarios: Secretaria
> (ASSISTANT), PRACTITIONER AP, OWNER que atiende y BILLING; un consultorio Kine con la sala «Consultorio 2» y otro
> General. Dos navegadores o dos perfiles (cada pestaña es un usuario). Contexto en
> [ARCHITECTURE.md §Sala de Espera realtime](ARCHITECTURE.md) y [AUDIT.md §Ronda 20](AUDIT.md). Lo que solo se prueba
> contra Supabase real (policy, firma, 202, p95, «Allow public access», CSP del `wss://`) va en V1-V7 de staging
> ([EXTERNAL-CONFIG.md §3.1](EXTERNAL-CONFIG.md)).

### Llegada y llamado entre pestañas
- [ ] 🔴 Secretaria en `/agenda?view=reception`, AP en `/dashboard` con «Visual y sonido» (y un clic previo en la
  página): «Llegó» en un turno de AP → en < 2 s AP ve el toast «Llegó <Nombre A.> · 10:30» con «Ver sala», suena el
  chime y el título dice «(1) Llegó …». «Ver sala» abre `/sala` con el paciente en «En sala» y el anillo de llegada; el
  título vuelve al enfocar. Con «Visual»: toast sin sonido. Con «Apagado»: nada, y `/sala` igual se actualiza.
- [ ] 🔴 «Llamar» desde `/sala` (AP) → en la pestaña de la Secretaria la card **se desliza** a la banda «Llamado» sin
  recargar, y ve el toast «Pase <Nombre A.> · Consultorio 2 · <AP>». En `/sala` el llamado sale en la banda «Pase …»
  arriba (8 s) **sin toast** y **sin mover el tablero** (las cards no saltan al aparecer ni al irse la banda).
  «Deshacer» vuelve a «En sala». La Secretaria también puede «Llamar» en nombre de AP.
- [ ] La pestaña que marca «Llegó» o «Llamar» no se avisa a sí misma.
- [ ] Llegada a un turno de AP con OWNER mirando: OWNER (no es el profesional del turno) no recibe «Llegó». BILLING no
  recibe nada.
- [ ] Tres llegadas juntas (o al volver de una ausencia) → un solo toast «Llegaron 3 pacientes».

### Reconexión y pestañas
- [ ] 🔴 DevTools → Network **Offline** 30 s en una pestaña → indicador «Sin conexión en vivo · se actualiza cada
  60 s»; un cambio en la otra pestaña llega al reconectar o a los 60 s; al volver **Online** el indicador vuelve a
  «En vivo». El lector de pantalla no anuncia cada «Reconectando…».
- [ ] Pestaña oculta 2 min con cambios en la otra → al volver se actualiza enseguida, sin toasts repetidos y **sin
  sonido**.
- [ ] Sin clic previo en la página el chime puede no sonar: el toast sale igual, con la nota «El sonido se activa
  después del primer clic en la página.»

### Agenda en vivo
- [ ] 🔴 AP abre el drawer de un turno; la Secretaria lo mueve de hora en otra pestaña → la agenda de AP lo muestra en
  la posición nueva (con flash) y el drawer la hora nueva; guardar con datos viejos → «El turno cambió en otra sesión».
- [ ] 🔴 Mover un turno «en sala» o «llamado» a **otro día** → en el día nuevo aparece «por llegar» (sin llegada,
  llamado ni atención). Moverlo de hora dentro de hoy no le cambia el estado.
- [ ] Batch de 20 turnos → **una** actualización en la otra pestaña (fade único, sin 20 parpadeos).
- [ ] Turnero público (`/c/<slug>/booking`) reserva → aparece en la agenda de la Secretaria; `devMarkBookingPaid` →
  pasa a confirmado en vivo; candado del día con «cancelar» → los turnos desaparecen y el día queda bloqueado en la
  otra pestaña; un bloqueo de varios días se refleja de una vez.

### `/sala`
- [ ] 🔴 Nunca título de diagnóstico, notas ni título del plan en ninguna card (PD-13), tampoco después de un cambio en
  vivo (DevTools → Network: la respuesta de `listSalaBookings` no trae `title`/`notes`/`description`).
- [ ] «Por profesional | Por sala» arriba (el segundo solo en el consultorio con salas); se recuerda al refrescar.
  Bandas En atención · Llamado · En sala · Demorados · Próximos; «N más tarde» / «Ocultar los de más tarde».
- [ ] Contadores: «En sala» **incluye** a los llamados y «Llamados» es ese subconjunto (los mismos números que
  Recepción).
- [ ] Teclado: Tab hasta «Llamar», Enter → el foco queda en el botón primario nuevo de esa card (o en la card); una
  llegada de otro paciente mientras tanto no saca el foco. En el toast, el foco en «Ver sala» no se pierde si llega el
  mismo aviso otra vez.
- [ ] Vacíos: «Nadie en la sala por ahora» (con los próximos del día) y «Hoy no hay turnos», sin que el tablero salte.
- [ ] Buscador: filtra por paciente en el momento.
- [ ] Paletas **mint** y **coral** (Configuración → General): los estados de la sala se distinguen y se leen (En sala,
  Llamado, En atención, Demorado).
- [ ] `prefers-reduced-motion`: sin pulso del punto «En vivo» ni anillo; las cards cambian de banda sin deslizarse y el
  estado final se ve completo.
- [ ] A 360 px: columnas apiladas, sin scroll horizontal; header y contadores envuelven.

### Preferencias, roles y verticales
- [ ] Configuración → General → «Avisos de la sala de espera»: AP ve «Cuando llega un paciente mío»; la Secretaria ve
  «Cuando un profesional llama a un paciente»; OWNER que atiende ve las dos. Se recuerda al refrescar; el mismo control
  en Agenda ⋯ (Vista).
- [ ] General y Kine: «Sala de espera» en el nav en **ambos** y lleva a `/sala` (activo en `/sala`, Agenda no se
  ilumina); BILLING no ve la entrada y `/sala` lo manda a `/agenda`; `/agenda?view=reception` sigue abriendo.

### Con `REALTIME_DRIVER=off`
- [ ] 🔴 Agenda y Recepción se ven y se comportan como en SR: sin indicador, sin toasts, sin flash, sin re-pedidos.
- [ ] `/sala` sin indicador «En vivo»; se actualiza sola cada 60 s y al volver a la pestaña.
- [ ] La Card de avisos en Configuración se ve con la nota «Los avisos se activan cuando la sala en vivo esté
  encendida en el consultorio.»; en Agenda ⋯ no aparece el control.

## Identidad y acceso · IAM-0 a IAM-4 (14-oct-2026)

> Con mailpit en local (`docker compose --profile mail up -d mailpit` → http://localhost:8025) o con Resend en prod
> (dominio verificado + `RESEND_API_KEY` y `EMAIL_FROM` en Vercel). En prod, primero Site URL/Redirect URLs de
> Supabase (§19.9 del plan). Sin dominio, los mails quedan en el log y la UI muestra el link para copiar.

- [ ] 🔴 Configuración → Usuarios: el selector de rol ofrece Kinesiólogo/a, Secretario/a, Administrador/a y Facturación,
  con una línea que explica cada uno. El ADMIN también ve la pestaña, pero no puede tocar al dueño.
- [ ] 🔴 Invitar a una Secretaria: llega el mail con la marca de KineSoft («Consultorio X vía KineSoft») y el botón lleva a
  `/invite/<token>` del dominio real (nunca localhost ni `#access_token`).
- [ ] 🔴 Abrir el link sin sesión → «Activar tu cuenta» → nombre + contraseña → entra solo al consultorio y llega el mail
  de bienvenida.
- [ ] 🔴 La Secretaria no aparece como profesional en la agenda, en el turnero público ni en «primer hueco libre».
- [ ] «Reenviar»: el link del primer mail sigue funcionando. «Generar link nuevo»: el viejo deja de funcionar. «Anular»:
  el link muestra «El consultorio anuló esta invitación».
- [ ] Un kine que ya tiene cuenta en otro consultorio: «Ya tenés cuenta» → ingresar → «Unirme a X» → entra a X.
- [ ] Link abierto con sesión de otro email → «Esta invitación es para otro email: cerrá sesión».
- [ ] Signup nuevo → «Revisá tu email» → el mail de confirmación llega → confirmar → `/onboarding`. «Reenviar» con espera
  de 60 s. Signup con un email que ya tiene cuenta: misma pantalla, y llega el mail «Ya tenés una cuenta».
- [ ] Olvidé mi contraseña → mail → link → `/reset` sin pedir la contraseña actual. Link vencido →
  «El link venció o ya se usó» con «olvidé mi contraseña».
- [ ] Login con email sin confirmar → aviso con «Reenviar email de confirmación» (el email ya cargado).
- [ ] Outlook (Safe Links abre el link antes): el link de confirmación igual funciona (pasa por «Confirmando…»).
- [ ] `/signup?invite=<token>` (links viejos) redirige a `/invite/<token>`.

### IAM-3a · acceso sin bucles

- [ ] 🔴 Kine con consultorio A acepta una invitación de B: entra a B (sin bucle) y A le sigue funcionando.
- [ ] 🔴 Usuario con 2+ consultorios: después de **cada** login aparece «¿A qué consultorio querés entrar?»
  (`/elegir-consultorio`, «Hola, <nombre>.»); elige uno y entra ahí. Con un solo consultorio entra directo.
- [ ] Sesión de un usuario sin ningún consultorio usable (suspendido en el único, o solo con invitaciones sin aceptar) →
  `/sin-acceso` «No podés entrar todavía.» con el motivo (p. ej. «Tu acceso está suspendido»), nunca un bucle ni el
  onboarding.
- [ ] Usuario sin ninguna membresía → `/onboarding` (alta de consultorio) como antes.
- [ ] Removido de su único consultorio que acepta otra invitación → entra al nuevo (ya no aparece «escribinos a soporte»).
- [ ] Prod después del deploy: los usuarios con 2+ consultorios ven la elección una vez al volver a entrar.

### IAM-3b · selector de consultorio

- [ ] 🔴 Sidebar con 2+ consultorios: el nombre del activo es un botón; abre la lista con el rol por vertical
  («Kinesiólogo/a» / «Profesional») y un check en el activo; elegir otro recarga la app entera en ese consultorio (agenda,
  pacientes y sala del nuevo, nada del anterior).
- [ ] Con un solo consultorio: solo el nombre, sin flecha ni lista.
- [ ] Sidebar colapsado: botón con iniciales y el nombre en el tooltip. Teclado: flechas, Home/End, Escape.
- [ ] «Cambiar de consultorio» lleva a `/elegir-consultorio`.
- [ ] Suspendido en B entre que se pintó el sidebar y el click → «Ese consultorio ya no está disponible para tu usuario.»

### IAM-3c · portal con magic link

- [ ] 🔴 `/portal/c/<slug>` → «Mandame un link para entrar» con el email de una ficha → llega el mail «<Consultorio> vía
  KineSoft» → el link pasa por «Confirmando…» y entra al portal de ese consultorio, con sus turnos.
- [ ] 🔴 Email que no es de ningún paciente (o de alguien del equipo): **mismo mensaje** («Si tu email está registrado…»)
  y no llega nada.
- [ ] Ficha → «Invitar al portal»: llega el mail propio (no el de Supabase); a un paciente ya vinculado «Reenviar» ahora
  funciona.
- [ ] Google sigue funcionando; entrar desde `/portal/c/<slug>` vincula solo la ficha de ese consultorio y desde
  `/portal` las de todos los consultorios con ese email.
- [ ] Outlook: el link del portal funciona aunque Safe Links lo abra antes.

### IAM-4a · Secretaria y Facturación sin profesional

- [ ] 🔴 Invitar una Secretaria nueva y activarla: entra, ve la agenda de **todos**, crea un turno eligiendo el
  profesional y opera Recepción; **no** aparece como profesional en la agenda, el turnero ni «primer hueco libre».
- [ ] 🔴 La Secretaria no ve historia clínica de pacientes sin asignar (nivel «admin», nunca «full») ni sesiones abiertas
  de pacientes sin asignar en Seguimiento.
- [ ] Facturación entra y ve los ingresos de **todo** el consultorio.
- [ ] Dashboard de la Secretaria abre sin error; sus KPIs propios en 0 y sin ingresos.
- [ ] Secretaria vieja (con fila de profesional de antes de IAM) entra igual y se comporta como la nueva.

### IAM-4b · superficies de agenda

- [ ] 🔴 Modal de turno nuevo con varios profesionales y sin filtro: arranca en «Elegí un profesional» (no en el
  primero); con filtro o con el profesional del usuario, queda ese; con uno solo, ese.
- [ ] «Día por profesional»: un turno viejo de la Secretaria aparece en la columna «Otros (sin agenda)», no desaparece;
  sin turnos así, la columna no está.
- [ ] Reprogramar un turno viejo de la Secretaria → error claro; cancelarlo funciona.
- [ ] La Secretaria bloquea horarios de cualquier profesional (o de todos) desde «Bloquear horario», sin agenda propia
  que elegir; Facturación no puede bloquear horarios.

### IAM-4c · administración del equipo

- [ ] 🔴 OWNER → Configuración → Usuarios → menú de un miembro → «Suspender acceso»: avisa cuántos turnos futuros le
  quedan (no se cancelan); el suspendido ya no entra a ese consultorio (cae a otro o a `/sin-acceso`) ni aparece en la
  agenda; badge «Suspendido» con fecha. «Reactivar» le devuelve todo.
- [ ] 🔴 «Mandar link para nueva contraseña»: le llega el mail al miembro; quien lo pidió **nunca** ve el link (ni en
  pantalla ni en la actividad); el panel muestra «Link de contraseña enviado».
- [ ] ADMIN: ve el menú para los miembros, pero no para sí mismo ni para el dueño.
- [ ] «Cambiar rol» de Secretaria a Kinesiólogo/a: queda con agenda y aparece en la agenda. De Kinesiólogo/a a
  Secretaria con turnos futuros o pacientes asignados → rechazo con el conteo; sin nada, OK.
- [ ] Re-invitar a un suspendido → «Usá Reactivar». Las invitaciones pendientes ya no dicen «Compartí el link».

## BO · Plataforma y producción (14-oct-2026)

> Superadmin con `scripts/set-platform-admin.ts` (local) o desde `/plataforma/usuarios`. Fechas y vencimientos con
> `TZ=UTC` en local (`TZ=UTC npm run dev`). Mails con mailpit en local o Resend en prod (EXTERNAL-CONFIG §0.4). Flags:
> `TENANT_ACCESS_ENFORCEMENT` (default `banner`), `PLATFORM_MFA_ENFORCEMENT` (default `off`), `MAINTENANCE_MODE`,
> `CRON_SECRET` (EXTERNAL-CONFIG §0.5). Cada acción de Plataforma tiene que aparecer en **Auditoría** y en la
> **Actividad** del consultorio afectado.

### Acceso a Plataforma
- [ ] 🔴 Usuario de consultorio que abre `/plataforma` → 404 (no «sin permiso», no redirige). Sin sesión → `/login`.
- [ ] 🔴 Superadmin **sin consultorio propio** entra a `/plataforma` (shell propio, sin «Volver a mi consultorio»).
- [ ] Superadmin deshabilitado → `/cuenta-desactivada`, ni Plataforma ni consultorio.

### Alta de consultorio
- [ ] 🔴 «Nuevo consultorio» con email nuevo **con Resend/mailpit**: llega «Tu consultorio X ya está en KineSoft» →
  «Activar mi acceso» → `/reset` para elegir contraseña → entra a su consultorio. El drawer no muestra el link.
- [ ] Mismo alta **sin mail** (Production sin Resend o falla): el drawer muestra el link para copiar.
- [ ] Doble click en «Crear» → un solo consultorio (el segundo dice que ya se creó, sin reenviar el mail).
- [ ] Email de alguien que ya tiene cuenta → reutiliza la cuenta (sin pisar su contraseña); slug pedido en uso → error en
  el campo.
- [ ] Servicios iniciales según la vertical (precio 0); PRO con prueba de 14 días; «Clínica general» sin Planes.

### Equipo y cupos
- [ ] 🔴 Consultorio Free con su titular: «Invitar» un 2º profesional → rechazo con el cupo (en Plataforma **y** en
  Configuración → Usuarios). Invitar Secretaria o Facturación → OK (no ocupan lugar).
- [ ] Subir el `seatLimitOverride` o pasar a PRO desde «Suscripción» → ya se puede invitar. Bajar de plan no saca a nadie.
- [ ] Invitación hecha con lugar, plan bajado después, aceptar → «El consultorio no tiene lugares libres…».
- [ ] «Transferir la titularidad» exige tipear el email; siempre queda un solo titular.
- [ ] Configuración → «Plan y uso» (solo titular): plan, lugares usados/total y vencimiento de la prueba.

### Usuarios y salud
- [ ] Buscador global: miembros, pacientes de portal y huérfanos, con estado de Auth. Un PRACTITIONER de Clínica general
  se ve «Profesional».
- [ ] «Mandar link de acceso» (activación o recuperación) con y sin Resend: con mail enviado el link **no** se muestra.
- [ ] «Deshabilitar usuario» → no entra a ningún consultorio (y queda baneado en Auth); «Habilitar» lo devuelve. No te
  podés deshabilitar a vos mismo.
- [ ] «Dar acceso a Plataforma» / «Quitar acceso» exige tipear el email; no se le puede quitar al último superadmin.
- [ ] `/plataforma/salud`: las 3 reparaciones (borrar huérfano de Auth, crear el profesional que falta, sincronizar email)
  y «sin titular» lleva al equipo para transferir.

### Ciclo de vida y superficies públicas
- [ ] 🔴 «Suspender» (motivo + nombre tipeado): los miembros caen en `/suspendido`; el turnero del consultorio dice «no
  disponible»; el check-in del portal se rechaza; un pago de Mercado Pago en curso **concilia igual**.
- [ ] «Reactivar» (también desde baja) devuelve todo. «Dar de baja» no borra nada.
- [ ] «Cambiar el slug»: `/c/<viejo>/booking` redirige (308) a `/c/<nuevo>/booking`; el slug viejo no se puede reusar.
- [ ] «Forzar fin del alta» saca al titular del onboarding.
- [ ] Con `TENANT_ACCESS_ENFORCEMENT=enforce` y una prueba vencida hace más de 7 días (TZ=UTC): la banda dice solo
  lectura; crear un turno o un paciente muestra el mensaje de solo lectura (no un error genérico); leer HC funciona.
  Con `banner`, mismo consultorio: solo la banda.

### Soporte
- [ ] 🔴 «Entrar como soporte» (motivo ≥ 10 caracteres) → abre el consultorio con la banda fija; al titular le llega el
  mail «soporte entró» con link a Configuración → «Accesos de soporte», donde figura la sesión con el motivo.
- [ ] 🔴 Como soporte: Configuración escribe (servicios, obras sociales, sedes, salas, horarios, datos del consultorio,
  turnos online, usuarios); la agenda, pacientes, cobros y bloqueos **no** (mensaje «Entraste como soporte: acá solo
  podés mirar.»).
- [ ] 🔴 Como soporte no se ve historia clínica (lo mismo que la Secretaria), no hay exports (403) ni sala en vivo; el
  switch de «compartir pacientes» no se puede cambiar.
- [ ] «Salir de soporte» (banda o Plataforma) y cerrar sesión cierran la fila; la sesión **no** vence sola.
- [ ] Lo que hizo soporte aparece en la Actividad del consultorio marcado como soporte.

### MFA de superadmin
- [ ] Con `off`: `/plataforma-mfa/configurar` → QR → código → «verificado». Nada más cambia.
- [ ] 🔴 Con `enforce`: sin factor → `/plataforma-mfa/configurar`; con factor y sesión nueva → `/plataforma-mfa/verificar`
  con `next` de vuelta; sin bucles.
- [ ] Acción de riesgo (suspender, entrar como soporte, deshabilitar…) pasados 10 min del último código → modal pide el
  código y reintenta sola.
- [ ] Códigos mal puestos repetidos → «Demasiados intentos. Probá de nuevo en N s.».
- [ ] La toolbar de Vercel no aparece en `/plataforma` en Preview (CSP bloqueante, esperado).

### Cron
- [ ] Sin `CRON_SECRET`: `curl /api/cron/trial-reminders` → 401 en local/Preview (503 en Production).
- [ ] Con `Authorization: Bearer $CRON_SECRET`: `trial-reminders` manda el mail a los titulares con prueba en 7/3/1 días
  o vencida (TZ=UTC; una vez por etapa: la segunda corrida no repite); `health-digest` manda el resumen a los
  superadmins solo si hay hallazgos y una vez por día; `invitations-expire` devuelve el conteo sin escribir.
- [ ] Con `MAINTENANCE_MODE=on`: los crons responden `skipped`.

### Mantenimiento
- [ ] `MAINTENANCE_MODE=on` (+ reiniciar en local / redeploy en Vercel): cualquier página → `/mantenimiento` con 503 y el
  mensaje opcional; `/api/*` → 503 JSON; `/api/health` → 200 con `maintenance: true`; el webhook de MP sigue.
- [ ] Sin bypass: el superadmin también ve `/mantenimiento`. `off` → todo vuelve.

### Export del consultorio
- [ ] 🔴 Titular → Configuración → «Exportar datos» → baja un JSON con manifest (incluye pacientes, turnos, HC, cobros;
  **no** tokens, ips, ruta de archivos ni payload de MP).
- [ ] ADMIN o Secretaria: la pestaña no aparece y la URL da 403. Soporte: 403.
- [ ] Titular de un consultorio **suspendido**: en `/suspendido` está «Descargar el export de mis datos».
- [ ] Cuarto export en una hora → 429 (hoy se baja como archivo de texto: hallazgo `export-error-como-archivo`).
- [ ] Plataforma → «Ciclo de vida» → «Pedir export al titular»: al titular le llega el mail; el superadmin no baja nada.

### Auditoría y sistema
- [ ] `/plataforma/auditoria`: filtros y «Cargar más»; cada acción de esta lista figura con quién y cuándo.
- [ ] `/plataforma/sistema`: Upstash, Sentry, Resend, MP, realtime y cron como **presente/ausente**; ningún valor de
  secreto en pantalla ni en el HTML. Migraciones aplicadas al día.
- [ ] `/api/health` → `{ ok, db, maintenance, time }`, nada más. `/robots.txt` y `/sitemap.xml` responden.

## EV1 · Clínica general (14-oct-2026)

> Dos consultorios en local (`TZ=UTC npm run dev` contra el Docker): uno **Clínica general** (alta desde
> `/plataforma/consultorios` con vertical General, o cambiándole la vertical a uno de prueba) y uno **Kinesiología PRO**
> como control. En General no tiene que aparecer «kine», «kinesiólogo/a», «sesión/sesiones», «diagnóstico» ni
> «plan de tratamiento»; en Kine todo tiene que verse **igual que antes**. Sin migraciones.

### Dashboard
- [ ] 🔴 General: el gráfico de turnos muestra datos al cargar **y al cambiar de rango** (antes se vaciaba).
- [ ] General: sin KPIs «Planes en curso» ni «Cerca del alta»; «Pacientes atendidos», «Turnos esta semana», «Asistencia
  semanal». Sin recordatorio de planes ni «Hola, Lic.». «Hoy tenés 1 turno» / «N turnos».
- [ ] Menú de perfil → Ajustes: el selector de KPIs ofrece lo mismo que el «+ Agregar» de la fila (sin KPIs de planes en
  General). «Próximos turnos» dice «1 turno» con uno solo.
- [ ] PRACTITIONER (no titular) en Kine: el gráfico al cambiar de rango cuenta solo sus turnos (mismo número que al cargar).

### Agenda
- [ ] General: modal de turno con «Motivo de consulta» (no «Título (diagnóstico)»), sin «Usar como diagnóstico del
  paciente»; modo «Varios turnos» con resumen «N turnos · Semanal …» y «Se generan X de N turnos pedidos.».
- [ ] General: drawer del turno, recordatorio y avisos de conflicto sin «sesión» ni «kine».
- [ ] Buscador de pacientes del modal y ⌘K: buscar «%» o «_» no trae a todos.

### Pacientes y perfil
- [ ] General: lista sin columna ni filtros de plan ni «Último diagnóstico»; «Última visita» = último turno realizado (antes quedaba en «—»).
- [ ] 🔴 Búsqueda de pacientes con «%», «_» y un apellido con «_»: solo matchea literal. Filtro por obra social igual.
- [ ] General: perfil con «Profesional asignado» y «Motivo de consulta (opcional)»; compartir paciente sin «kine».

### Configuración
- [ ] General: Equipo dice «Profesional» (no «Kinesiólogo/a»); Obras sociales «al profesional por turno»; Servicios y
  General sin ejemplos de kinesiología/osteopatía.
- [ ] Vincular una obra social escribiendo «O_DE» u «OS%»: **no** se linkea a OSDE.
- [ ] 🔴 Con `TENANT_ACCESS_ENFORCEMENT=enforce` y el consultorio en solo lectura (o como soporte fuera de la allowlist):
  guardar en Servicios, Sedes, Horarios, Salas, Obras sociales, Equipo y General muestra el aviso de solo lectura, no
  «Ocurrió un error». Lo mismo en Diagnóstico (crear caso/plan), ejercicios propios, plantillas de plan y favoritos.

### Onboarding, turnero y portal
- [ ] Alta de un consultorio General: pasos Servicios y Obras sociales sin copy de kine («por turno»); Equipo con
  «Profesional».
- [ ] Turnero público de un General: un profesional sin especialidad no dice «Kinesiología»; textos con «turno».
- [ ] Portal del paciente de un General: sin «tu plan» ni «tu kinesiólogo»; el de Kine igual que antes. El mismo email en
  un Kine y un General: cada ficha con su copy.
- [ ] Login: «pensado para consultorios de salud»; título del sitio neutral.

### Plataforma
- [ ] `/plataforma/ejercicios`: sin filtro «Todo plan», sin columna «Plan» ni toggle Común/Pro; una URL vieja con
  `tier=pro&sort=tier` abre ordenada por nombre. Buscar «%» no trae todo el catálogo. Lo mismo en catálogo, usuarios,
  consultorios y auditoría.
- [ ] Biblioteca (Kine) → editar un ejercicio global → «Ver ficha completa» aparece; en Plataforma no.

## PL-1 · Planes SaaS, cupos y acceso por miembro (15-oct-2026)

> Local (`TZ=UTC npm run dev` contra el Docker con M8 aplicada). Sin migraciones nuevas en PL-1. Hasta **M8b** (inicio de
> PL-2) la fila de `SaasPlanConfig` de Consultorio sigue en 4 profesionales + 1 no clínico y los ADMIN viejos siguen
> clínicos: lo marcado con «(M8b)» se prueba después de esa migración. **M8b ya está escrita y aplicada en el Docker local** (ver sección siguiente). La 2FA todavía **no tiene UI** (PL-2a).

### Plan nuevo
- [ ] Configuración → General → «Plan» dice Individual / Consultorio / Clínica / Libre (no FREE/PRO). «Plan y uso» con el mismo nombre.
- [ ] Un Individual Kine: Planes, sesiones, diagnóstico y ejercicios propios sí; plantillas, favoritos y ejercicios globales no; sin Salas ni Sala de espera.
- [ ] Un Consultorio: como Individual + plantillas/favoritos/globales; sin Salas ni Sala de espera. Un Clínica: todo.
- [ ] /plataforma → consultorio → Editar: el plan se elige entre los 4 nuevos; cupos a medida por tipo («a medida» en la lista).

### Cupos
- [ ] Individual: no se puede invitar a nadie (ni Secretaria): «Tu plan tiene 1 usuario…».
- [ ] Consultorio (M8b): entran 5 de cualquier tipo (5 profesionales o 3 + 2 Secretarias); el 6.º rebota por total.
- [ ] Una invitación pendiente reserva lugar; anularla lo libera. Plataforma → Equipo: «Profesionales N · Secretaría/administración N · Total N de M».

### Titular sin agenda y Administrador/a
- [ ] Alta desde /plataforma con «¿Atiende pacientes el titular?» = No: entra sin agenda, no figura en el turnero ni en
  el selector de profesionales, y en Pacientes ve la ficha administrativa (sin HC, sin planes). En Usuarios: «Titular (sin agenda)».
- [ ] Invitar un Administrador/a: entra **sin agenda** y sin HC, con Configuración. Pedirlo «atendiendo» rebota con copy.
- [ ] Pasar un Profesional con turnos o pacientes a Administrador/a: se frena pidiendo reasignar; sin carga, pasa y deja de atender.
- [ ] Transferir la titularidad siendo un Titular que atiende: quedás como Profesional con Configuración (conservás la agenda).
- [ ] (M8b) Un Administrador/a viejo con agenda en uso queda Profesional con Configuración; uno sin agenda, sin HC.

### Delegación
- [ ] Un ADMIN sin «Configuración» no entra a Configuración (ni por URL); con ella sí, y sigue sin HC.
- [ ] Una Secretaria con «Configuración» delegada edita Servicios/Horarios pero no ve HC ni Planes.

### Sesión y 2FA
- [ ] La navegación entre páginas no hace más idas a la base que antes (el miembro viaja en el Actor).
- [ ] 2FA: ver «PL-2 · Verificación en dos pasos» (las pantallas ya existen).

### Plataforma (VX0-b)
- [ ] Detalle de un consultorio: «Titular» muestra el nombre (o «Usuario sin nombre»), el email en «Email del titular». La lista igual (nombre + «Email: …»).
- [ ] La barra superior de Plataforma muestra tu nombre, no tu email (el email en el tooltip).

## PL-2 · M8b (`20261015200000_pl_admin_consultorio`, solo datos; 15-oct-2026)

> Local, con M8b aplicada (`npx dotenv -e .env.local -- npx prisma migrate deploy`). Lo automatizado está en
> `tests/integration/pl-m8b.test.ts` y en los `[M8b]` de `tests/integration/seats.test.ts`; esto es el repaso a mano.
- [ ] Consultorio: invitar hasta 5 personas de cualquier tipo (p. ej. 4 profesionales + el Titular, o 3 + 2 Secretarias); el 6.º rebota con «Tu plan tiene 5 usuarios y están ocupados».
- [ ] /plataforma → consultorio Consultorio: «Plan y uso» ya no muestra tope por tipo (solo el total de 5).
- [ ] En una base con un ADMIN de antes (con turnos futuros): después de M8b figura como **Profesional** con «Configuración», conserva su agenda, sus turnos y sus pacientes.
- [ ] Un ADMIN de antes sin turnos futuros, pacientes asignados ni planes activos: después de M8b sigue como Administrador/a, ya no aparece en la agenda ni en el turnero y no abre historias clínicas; sus turnos pasados siguen en el historial.

## PL-2 · 2FA, cobros manuales, mensajes, Facebook y salas por plan (15-oct-2026)

> Local (Docker + Mailpit). Lo automatizado: `two-factor*.test.ts`, `saas-billing*.test.ts`, `support-threads`/`leads`,
> `auth-callback.test.ts`, los `rooms`/`public-booking*` de 2f. Esto es el repaso a mano.

### Verificación en dos pasos (PL-2a)
- [ ] Menú de perfil (y el shell de Plataforma) → «Seguridad de la cuenta» abre `/cuenta/seguridad`.
- [ ] Activar con app de autenticación (QR + código) y, aparte, con código por email: llega el mail del código (sin el código en el asunto) y el aviso «Activaste…».
- [ ] Se muestran 10 códigos de recuperación una sola vez.
- [ ] Login con 2FA: (1) código de la app, (2) código por email, (3) código de recuperación (llega el aviso «Se usó un código de recuperación»). Las tres terminan en el `next` original.
- [ ] Límites: código vencido (10 min) o 5 intentos fallidos → pide uno nuevo; «Reenviar» espera 60 s.
- [ ] Apagar la 2FA pide step-up (código otra vez); sin 2FA, una acción con step-up dice «Activá la verificación en dos pasos…».
- [ ] Superadmin con 2FA pendiente que abre `/plataforma` → `/verificar-acceso?next=/plataforma` (no el login); después vuelve a Plataforma.
- [ ] /plataforma → Usuarios → «Resetear verificación en dos pasos»: auditado y mail «El equipo de KineSoft reseteó…».
- [ ] «Cerrar sesión» borra `kine_2fa` y `kine_stepup` (DevTools → Cookies).
- [ ] Entrar como soporte en un consultorio funciona en prod sin MFA de Plataforma (se quitó el corte).

### Cobros manuales (PL-2b, sin Mercado Pago)
- [ ] Con `SAAS_BILLING_MODE=off` (default) el cron diario no genera cargos ni manda mails de cobro.
- [ ] Con `manual`: `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/daily` crea el cargo del período (repetirlo no duplica cargos ni mails); llega «Ya está tu cuota del mes».
- [ ] Cargo sin pagar 5 días después del inicio del período → `PAST_DUE` + mail «Tenés una cuota vencida»; un consultorio en prueba vencida sigue TRIALING; CANCELLED nunca cambia.
- [ ] /plataforma → Facturación: imputar un pago manual con recibo (PDF/JPG/PNG/WEBP ≤ 4 MB; un .exe renombrado rebota), aprobar/rechazar un comprobante (mail con el motivo), anular/condonar un cargo, precio a medida, editor de precios con vigencia (mail «Nuevo precio…»).
- [ ] El recibo se ve solo con link firmado (vence a los 60 s).
- [ ] La pantalla del consultorio (`?tab=facturacion`): ver «PL-3 · Configuración».

### Mensajes y leads (PL-2d)
- [ ] Configuración → pestaña «Soporte»: arriba «Mensajes con soporte», abajo «Accesos de soporte». Crear un mensaje → llega aviso a `PLATFORM_INBOX_EMAIL` SIN el texto del mensaje.
- [ ] /plataforma → «Mensajes» (en el nav después de Usuarios): responder → el consultorio recibe «Te respondimos» y ve la respuesta; abrir/cerrar la conversación.
- [ ] Como soporte dentro del consultorio, la pestaña «Soporte» no deja escribir (aviso de sesión de soporte).
- [ ] Más de 10 mensajes en una hora por usuario → rebota con el aviso de límite.
- [ ] Lead (desde el formulario «Hablemos» de la landing, `#contacto`): llega «Consulta nueva desde la web» con el mensaje escapado; responder desde Plataforma manda el mail al lead; el honeypot `website` lleno no crea nada.

### Ingreso con Google y Facebook (PL-2e)
- [ ] `POST /api/auth/oauth/google?next=/agenda` y `/facebook` llevan al proveedor y vuelven a `next`; `/api/auth/google` sigue andando (portal, turnero).
- [ ] Facebook sin compartir el email → `/login?error=oauth_no_email` con «No recibimos tu email…»; no se crea perfil.
- [ ] Proveedor apagado en Supabase → «Ese método de ingreso no está disponible por ahora…».
- [ ] Alta nueva por OAuth → consultorio INDIVIDUAL en prueba de 14 días; nombre y foto del proveedor (la foto de Facebook se ve: `platform-lookaside.fbsbx.com` en `remotePatterns`).

### Salas y sala de espera por plan; turnero por profesional (PL-2f)
- [ ] Consultorio (sin `salas`/`salaEspera`) con salas cargadas de antes: la agenda no muestra «Por sala» ni Recepción, no hay «Llamar»; «Llegó» y «En atención» siguen andando.
- [ ] Guardar un horario de un profesional cuya franja tiene sala dormida: guarda sin error y conserva la sala.
- [ ] El modal de turno no avisa «sala ocupada» con salas dormidas; el turno nuevo no lleva sala.
- [ ] Volver a Clínica: las salas reaparecen con sus franjas y turnos.
- [ ] Turnero: un profesional con `publicBookingEnabled = false` no aparece (el switch está en Configuración → Profesionales, PL-3b).

## PL-3 · UI de planes, cobros, equipo y Plataforma (15-oct-2026)

> Sin commitear (se commitea en PL-Z). Probar con `TZ=UTC`, M8 + M8b aplicadas en local y `SAAS_BILLING_MODE=manual`
> para lo de cobros. Anchos: **390** (celular), **1024×768** y **1366×768**: sin desbordes horizontales en ninguna
> pantalla de esta sección.

### Configuración: plan, facturación y soporte (PL-3a)
- [ ] Secretaria con «Planes y pagos» (`grantBilling`) y sin «Configuración»: ve **solo** Plan y uso, Facturación y Soporte (3 pestañas), con el desglose de cupos; sin «Planes y pagos» ve solo Soporte (desde PL-F, Soporte es de cualquier miembro; ver «PL-F»).
- [ ] Bajar de Clínica a Consultorio con 7 usuarios activos: el drawer muestra cuántos sobran y pide elegir **exactamente** quiénes pierden el acceso; «Pasar a Consultorio» queda apagado hasta que la cuenta cierra.
- [ ] Cambiar de plan sin 2FA activada → modal «Activá la verificación en dos pasos»; con 2FA → pide el código (step-up) y, al confirmar, el menú refleja los módulos del plan nuevo (salas, sala de espera).
- [ ] Plan Libre: «Consultanos» abre Soporte con el mensaje prellenado; no hay botón de cambio directo.
- [ ] `?tab=facturacion` abre Facturación directo (y el link del mail de cuota): saldo, cargos, pagos, los datos para transferir y «Informar pago» (sin `SAAS_BILLING_TRANSFER_INFO` no aparece).
- [ ] Subir comprobante desde el celular con una foto grande (> 1,5 MB): se comprime antes de subir y entra (≤ 4 MB); un PDF entra tal cual; el cargo sugerido es el pendiente más viejo.
- [ ] `SAAS_BILLING_MODE=off`: Facturación lo dice y no ofrece pagar; cargos y pagos viejos se ven solo si existen.
- [ ] Consultorio en solo lectura: «Plan y uso» lo dice y se puede subir el comprobante igual.

### Equipo y profesionales (PL-3b)
- [ ] Titular → Usuarios: «Atiendo pacientes» (su propio switch) pide step-up; apagado, deja de tener agenda.
- [ ] Permisos de un miembro («Puede cambiar la Configuración», «Puede ver y cambiar el plan y los pagos»): piden step-up y el delegado ve las pestañas que corresponden al recargar.
- [ ] Transferir titularidad: pide step-up (sin 2FA → modal de activarla) y confirmación tipeada.
- [ ] Un ADMIN con «Configuración» delegada abre /configuracion sin 500 y ve la pestaña Usuarios (`tenant.admin`).
- [ ] Usuarios muestra «Lugares: N de M» y «Cupo lleno» cuando corresponde.
- [ ] Profesionales → switch del turnero online: apagado, el profesional desaparece de `/c/<slug>/booking`; prendido, vuelve. Se ve también en el resumen de cada profesional.

### Plataforma (PL-3c)
- [ ] /plataforma → Facturación: filtros por vista (con deuda, a revisar, vencidas), plan y estado (los filtra el server: la página trae solo esas cuentas) y búsqueda.
- [ ] Ledger de un consultorio (`/plataforma/consultorios/<id>/facturacion`): registrar pago con recibo PDF entra; un `.exe` renombrado a `.pdf` rebota con el copy de archivo inválido.
- [ ] Anular un cargo pide tipear la palabra; condonar y aprobar/rechazar comprobantes (rechazo con motivo).
- [ ] /plataforma → Precios: precio con vigencia futura queda «pendiente»; con vigencia hoy cambia el catálogo al guardar.
- [ ] Ficha del consultorio → Editar suscripción: no tiene selector de plan (el plan se cambia con «Cambiar de plan», ADR-018); Libre se puede elegir solo desde Plataforma.
- [ ] Equipo del consultorio en Plataforma: «Atiende pacientes» del Titular y Permisos de los demás piden la re-verificación (riesgo alto, `team.grants`).

## PL-Z · cierre del bloque PL (15-oct-2026)

> Sin commitear. `TZ=UTC`, M8 + M8b aplicadas en local, `SAAS_BILLING_MODE=manual` y `SAAS_BILLING_TRANSFER_INFO`
> cargada para lo de cobros. Hallazgos en [AUDIT «Hallazgos de PL-Z»](AUDIT.md).

### Cobros
- [ ] Registrar desde Plataforma un pago **a cuenta** (sin cargo) y después correr el cron diario: el cargo nuevo del período queda pagado con ese saldo y el consultorio no pasa a «Pago pendiente».
- [ ] Registrar o aprobar un pago **mayor** que lo que falta del cargo: el cargo queda pagado y el excedente aparece como pago a cuenta (saldo a favor), no se pierde.
- [ ] Configuración → Facturación muestra los datos para transferir; sin `SAAS_BILLING_TRANSFER_INFO`, no hay «Informar pago» y Plataforma no deja pasar el cobro a `manual`.
- [ ] /plataforma → Facturación: una cuenta con cargos vencidos se ve con un aviso ámbar en negrita («N cargos vencidos»), más fuerte que una «Con deuda» sin vencer.
- [ ] «Cambiar de plan» en Plataforma nombra los módulos igual que «Plan y uso» del consultorio (no aparecen «Evoluciones» ni «Reportes»).

### 2FA y seguridad
- [ ] Usuario con 2FA por email que enrola un TOTP propio contra GoTrue (fuera de KineSoft): igual le pide el código por email en `/verificar-acceso`.
- [ ] Export completo del consultorio (`/api/consultorio/export`) con la 2FA pendiente → 401; verificada → baja. El Titular que no atiende baja la HC (excepción AUDIT §5.50).
- [ ] Con `PLATFORM_MFA_ENFORCEMENT=off`, una acción de riesgo alto de Plataforma (permisos, cambiar de plan, reset de 2FA) pide el código de la 2FA del superadmin; sin 2FA activa, pide activarla.
- [ ] Un superadmin no puede resetear la 2FA de otro superadmin: en su ficha «Resetear verificación» aparece deshabilitado con «Es superadmin: su verificación la cambia esa persona desde Seguridad de la cuenta.».
- [ ] Usuarios → cambiar el rol de alguien a Administrador/a con la 2FA activada: pide el código (modal de step-up) y al confirmarlo cambia el rol; sin 2FA, ofrece activarla. Antes salía un error crudo en la fila.
- [ ] Un ADMIN con «Configuración» (no atiende): invitar a un Profesional, pasar a alguien a Profesional o reactivar a un Profesional → «Solo el titular o un profesional del consultorio pueden sumar a alguien que atiende.»; invitar a una Secretaria sí puede.
- [ ] Un ADMIN no ve la agenda ni la HC aunque su fila diga `clinical = true`.

### Plan y cupos
- [ ] Consultorio con cupos a medida (Libre con overrides) que intenta cambiar de plan desde Configuración → «Tu consultorio tiene cupos a medida: escribinos para cambiar el plan.»; desde Plataforma se puede.
- [ ] Consultorio Clínica con un override de cupo legado (de M8): Plan y uso **no** lo muestra «a medida», los cupos son los de Clínica y el cambio de plan no se traba.
- [ ] Consultorio (5 de cualquier tipo): se pueden sumar 5 profesionales, o 4 + 1 Secretaria, o cualquier mezcla hasta 5; Plataforma lo dice «5 usuarios de cualquier tipo».
- [ ] Bandeja de Plataforma: el filtro dice «Consultas de la web» y cada fila «Consulta de la web» (no «Lead»).

### Turnero
- [ ] Alta nueva: el Titular que atiende aparece en el turnero al prenderlo (nace con su switch en sí); General avisa que el turnero arranca apagado.
- [ ] Profesional sin «Configuración»: el switch de su propio turnero está en el menú de perfil del dashboard (el avatar); apagado, desaparece de `/c/<slug>/booking`; al recargar el dashboard el switch conserva el valor. Con el turnero del consultorio apagado, el switch está deshabilitado con «Primero el consultorio tiene que prender el turnero.». La Secretaria (sin ficha) no lo ve.
- [ ] El switch del menú de perfil mide 52×30 (< 44 px): pendiente de PF/MB, no es un bug de PL.

## PL-F · UI sin funcionalidad, medio de pago y Soporte para todos (15/16-oct-2026)

> Commiteado: M8c en `cb99c06`, la UI en `7e97ba5`. `TZ=UTC`, M8 + M8b + **M8c** aplicadas en local y `SAAS_BILLING_MODE=manual`
> con `SAAS_BILLING_TRANSFER_INFO` para lo de cobros. Regla de Martin (16-oct): «todo lo que quede sin funcionalidad,
> se quita». Hallazgos en [AUDIT «PL-F»](AUDIT.md).

### Medio de pago (M8c)
- [ ] Configuración → Facturación → «Informar pago»: el select «Medio de pago» es obligatorio, arranca en Transferencia y ofrece Efectivo, Tarjeta, Billetera, Mercado Pago y Otro. La nota llega a Plataforma tal cual se escribió (sin «Medio: …» adelante).
- [ ] Plataforma → ledger del consultorio → «Registrar pago»: mismo select «Medio de pago», obligatorio.
- [ ] Con dos cargos impagos, los dos drawers sugieren el **último** (el período más reciente) y el monto es lo que le falta; al cambiar de cargo en «Registrar pago», el monto pasa a lo que le falta a ese cargo. «A cuenta» sigue disponible.
- [ ] Un pago cargado antes de M8c se ve con «Sin informar» en la lista de pagos del consultorio y en el ledger de Plataforma; ningún pago dice «Mercado Pago» por su origen.

### Soporte y accesos
- [ ] Profesional y Secretaria (sin «Configuración»): el menú de perfil (avatar del dashboard) tiene «Ayuda y soporte» → `/configuracion?tab=soporte`, con Mensajes y Accesos de soporte; pueden escribir un mensaje nuevo. En el nav sigue sin aparecer «Configuración».
- [ ] Accesos de soporte: es **solo lectura** para todos (quién entró, cuándo, motivo y cuándo terminó); no hay botón para terminar un acceso abierto (decisión pendiente de Martin).

### Navegación y barra superior
- [ ] «Reportes» no aparece en el sidebar, en la barra superior ni en ⌘K; `/reportes` lleva a `/dashboard`. En Plataforma, la ficha del consultorio no muestra el chip «Reportes».
- [ ] Apariencia → «Barra superior»: el avatar es el usuario de la sesión (sin nombre → «Usuario sin nombre», nunca el email); la búsqueda abre ⌘K; la campana es la real (notificaciones y «marcar leídas»).
- [ ] Menú del avatar de la barra superior: Apariencia, Ayuda y soporte, Seguridad de la cuenta, Cambiar de consultorio (solo con 2+), Cerrar sesión. Un Profesional con ficha ve además el switch «Aparece en el turnero online» (con el turnero del consultorio apagado, deshabilitado con «Primero el consultorio tiene que prender el turnero.»); la Secretaria no.
- [ ] Dashboard con barra superior: botón «Ajustes» arriba del calendario → abre el modal de paleta y KPIs fijadas; guardar aplica la paleta sin recargar.

### Apariencia (ex Tweaks)
- [ ] Al cargar cualquier pantalla, Apariencia está cerrada y no queda ningún engranaje flotante tapando el pie de los Drawers («Guardar»). Se abre desde el pie del sidebar o desde el menú del avatar de la barra superior.
- [ ] Opciones: Paleta (Celeste, Verde, Coral, Violeta), Navegación (Barra lateral / Barra superior), Barra lateral contraída y Vista semanal (encabezado, sábado, domingo). No están «Timeline / Semana / Lista» ni «Card de paciente».
- [ ] Elegir otra paleta en Apariencia, ir a Inicio y recargar: la paleta se mantiene (se guarda en el server). En Ajustes del perfil, las paletas tienen los mismos nombres.

### Textos quitados
- [ ] Recepción: ninguna fila tiene el botón «Cobrar» gris «Próximamente».
- [ ] Turnero público: no dice «Cancelás gratis hasta 6 hs antes» (ni en datos ni en el resumen); al confirmar no promete «Te mandamos un email».
- [ ] Alta de turno con Telemedicina: «Si ya tenés el link, pegalo acá (es opcional).» (no «después, desde el turno»).
- [ ] Bloquear un día con turnos: «El paciente no recibe aviso: avisale vos.» (sin «todavía» ni «llega más adelante»).
- [ ] Plan sin plantillas (Individual): Plantillas muestra solo el aviso del plan, sin el botón «Nueva plantilla» deshabilitado.


## RX · Escritorio de Recepción (15/16-oct-2026)

> RX-0 (`a762130`), RX-1 (`ee97af3`) y RX-2 + RX-Z (`a5ca20a`) commiteados. **Sin migración**: la
> cara se guarda en `agendaPrefs.receptionLayout` (preferencias de usuario). `TZ=UTC`. **Necesita turnos de hoy en
> local** (3+ profesionales, salas, estados variados): el agente no corre seeds, los carga Martin. Hallazgos en
> [AUDIT «RX»](AUDIT.md); decisiones RX-D1..D10 en el [ROADMAP](ROADMAP.md).

### Elegir la cara
- [ ] Apariencia → «Recepción» ofrece tres caras de `/sala`: **Tablero** (la de siempre, default), **Lista y panel** y **Flujo**. Con `/sala` abierta, cambiar de cara la cambia sin recargar.
- [ ] Recargar: la cara elegida se mantiene; en otro navegador con el mismo usuario, también (se guarda en el server).
- [ ] Desde el escritorio (Lista o Flujo), «Vista» del header abre Apariencia; con Apariencia abierta, tipear en sus controles **no** dispara los atajos del escritorio.

### Operar desde el escritorio (Lista y panel, y Flujo)
- [ ] Llegó → Llamar (aparece la banda de llamado) → En atención → Atendido → Deshacer, todo desde el escritorio. Una segunda pestaña con `/sala` (cualquier cara) lo ve en vivo, o en menos de 60 s con el driver realtime en off.
- [ ] El llamado muestra los minutos **desde que llegó** (no «0' espera»); quien pasó al box sin esperar muestra «—», no «esperó 0'».
- [ ] Atajos: `/` enfoca el buscador; `N` abre `/agenda?new=1`; `Esc` limpia el buscador. Ninguno se dispara mientras se escribe en un input.
- [ ] Buscar un paciente filtra las filas sin pintar todo de lima.
- [ ] La línea de «ahora» se ve al abrir y usa el mismo naranja que la de la agenda.

### Permisos
- [ ] Como **Secretaria**: no aparecen «Cobrar» ni la card/carril «Por cobrar»; en su lugar se ve «En atención».
- [ ] Como **Titular o Admin** (permiso de cobros, `billing.manage`): «Cobrar» registra el cobro y la fila sale de «Por cobrar»; el total del header de «Por cobrar» baja.

### Layout (en Chrome, ventana de app o PWA)
- [ ] **1366×680** y **1024×680**, en Lista y en Flujo, con el sidebar **abierto y cerrado**: sin scroll de página (cada columna scrollea por dentro), la tira de profesionales no se recorta y ninguna fila pierde el nombre del paciente.
- [ ] A 1024 con sidebar abierto, «Por cobrar» puede cortar nombres largos (abierto, va a PF/MB): anotar si molesta.
- [ ] **390** (móvil): una sola columna, el estado no tapa el nombre y las acciones bajan a su propia fila; los ítems del menú de acciones tienen 44 px de alto. (El sidebar todavía no tiene modo móvil: abierto, MB.)

### Recepción de la agenda
- [ ] `/agenda?view=reception` en un día **pasado**: ninguna fila dice «Demorado» y los contadores no se ponen en ámbar (G1).
- [ ] Arriba de la lista está el link «Abrir escritorio de Recepción →» que lleva a `/sala`.

## EV2 · Evoluciones de HC (15/16-oct-2026)

> EV2-0..EV2-3 commiteados (`8e3e9f6` → `55042c5`); EV2-Z sin commitear. **Migración M9** (`clinical_notes`) aplicada en
> el Docker local; en prod va **antes** del deploy (RUNBOOK «M9 en prod»). `TZ=UTC`. Necesita en local un consultorio
> **Kinesiología** y uno **General**, cada uno con Titular clínico, 2 profesionales (uno con un paciente compartido),
> Secretaria y Facturación, y turnos de hoy, de ayer y de mañana: el agente no corre seeds, los carga Martin. Hallazgos
> en [AUDIT «EV2»](AUDIT.md); decisiones EV2-D13..D24 y las de EV2-Z en el [ROADMAP](ROADMAP.md).

### Alta y edición
- [ ] Perfil del paciente → pestaña **«Evoluciones»** (la de la curva ahora dice **«EVA»**): «Nueva evolución» abre el Drawer; tipos Evolución / Primera consulta / Alta; sin turno, la fecha arranca en «ahora» redondeada a 5 min.
- [ ] Guardar con cuerpo vacío o > 20.000 caracteres → error en el campo; el contador avisa solo cerca del límite («Te quedan N caracteres»).
- [ ] Fecha a más de 12 h en el futuro: **sin turno** → «La fecha de la evolución no puede ser más de 12 h en el futuro.»; **con turno** de mañana → «Todavía no llegó la hora del turno: la evolución se puede cargar desde 12 h antes.»
- [ ] Doble clic en «Guardar» (o red lenta) → una sola evolución.
- [ ] El autor la edita dentro de las 24 h («editable hasta mañana HH:MM»); otro profesional o el Titular no ven «Editar». Cerrar el Drawer con cambios pide confirmación.
- [ ] Editar en dos pestañas a la vez → la segunda recibe «La evolución cambió mientras la editabas…», sin pisar.
- [ ] Picker de minutos: una nota o turno con hora fuera de la grilla (p. ej. **10:07**) muestra «07» como opción (no salta a 10:05). Revisar también en **reprogramar turno, Planes y bloqueos**, que usan el mismo picker.

### Enmienda, anulación e historial
- [ ] Pasadas las 24 h (o en una nota de otro profesional con escritura): «Agregar enmienda» copia el texto con el hint «Copiamos tu texto: dejá solo lo que agrega o corrige.»; la enmienda queda colgada de la original.
- [ ] «Anular» (autor o Titular clínico) pide motivo (3..500) en un Modal; la anulada se ve colapsada, sin tachar, con «Anulada el {fecha} por {quién} · Motivo»; no se puede editar ni enmendar.
- [ ] «Historial» muestra las versiones anteriores de una editada, también en una anulada.

### Turnos, agenda y Recepción
- [ ] Drawer del turno: fila de evolución («Cargar evolución» / «Ver evolución» con link «Abrir en la HC» de 44 px). Marcar «Atendido» en un turno **propio** → toast de 10 s con «Cargar evolución» que abre el editor con «Paciente: Apellido, Nombre».
- [ ] Como Titular sobre el turno de **otro** kine: no aparece el toast.
- [ ] Turno con evolución: «Eliminar turno» deshabilitado con hint; cancelarlo sí; cambiarle el paciente → «Este turno tiene una evolución: no se puede cambiar el paciente.» (como Secretaria: el error genérico, sin decir que hay evolución).
- [ ] Turno cancelado o ausente → no admite evolución (mensaje); si ya tenía una, se sigue viendo.
- [ ] Recepción (`/agenda?view=reception` y `/sala`): «Atendido» ofrece el toast solo a un profesional con `clinical.read`; la sala nunca muestra texto clínico.
- [ ] Deep link `/pacientes/<id>?tab=evoluciones&turno=<id>`: con nota existente hace scroll y la resalta 2 s (sin animación con «reducir movimiento»), sin abrir el editor.
- [ ] Kine que atiende un turno de un paciente **de otro kine sin share**: el toast aparece y al guardar dice «No tenés acceso…» (abierto a6, C0: anotar si molesta).

### Seguimiento (vertical Kinesiología)
- [ ] El detalle de la sesión tiene **«Registrar sesión»** (notas, RPE, EVA) y **«Cargar evolución»** (HC del turno) por separado; una evolución de HC **no** bloquea «Registrar sesión».
- [ ] El bucket «Sin evolución» lista sesiones realizadas en los últimos 14 días sin evolución ni registro; al cargar la evolución desde el detalle, sale del bucket al volver.
- [ ] Historial del plan y actividad del paciente dicen «Sesión registrada» (no «evolución»).

### Impresión
- [ ] «Imprimir historia clínica» (solo con notas) abre `/pacientes/<id>/imprimir`: sin sidebar ni barra en la vista de impresión, «Turno: {servicio}», pie con paciente y DNI, «Cerrar» cierra la pestaña. Queda «Historia clínica impresa» en la actividad.
- [ ] Con más de 2000 notas se imprimen las más recientes con el aviso «pedile la exportación al/la Titular».

### Por rol y vertical
- [ ] **Profesional dueño o con share:** ve, crea y enmienda. **Profesional sin acceso al paciente:** no ve ninguna evolución (ni en el perfil ni en el drawer).
- [ ] **Secretaria, Facturación, ADMIN y Titular que no atiende:** no ven texto de evoluciones en ningún lado (perfil, drawer, Recepción, Seguimiento); `/pacientes/<id>/imprimir` → 404. El Titular sin agenda sí recibe las evoluciones en el **export del consultorio** (§5.50, pide 2FA).
- [ ] **Soporte** (sesión de soporte): solo lectura, sin HC.
- [ ] **Portal del paciente y ⌘K:** ninguna evolución.
- [ ] **Vertical General:** pestaña «Evoluciones» sí; sin «EVA», sin sesiones ni Seguimiento; el drawer del turno ofrece la evolución igual.

### Layout
- [ ] **390**: búsqueda de 16 px (no hace zoom), botones del header de 44 px, tipo de nota de 44 px; el Drawer ocupa la pantalla.
- [ ] **1024** con sidebar abierto: perfil y editor sin scroll horizontal (el detalle de Seguimiento todavía no es responsive: abierto, PF/MB).
- [ ] **1366**: la línea de tiempo agrupa nota y sesión del mismo turno.

## VX · Cara pública y cimientos visuales (15/16-oct-2026)

> Ola F (`f80a6f3`), F2 (`31fcc91`), VX2.1 (`4203e93`), VX2.2 + VX-Z (1) (`30ed858`) commiteados; VX-Z (2) sin
> commitear. **Sin migración.** Con `next build && next start` (no dev: el bundle y el ISR cambian), `TZ=UTC`, en Chrome,
> Safari y Firefox; turnero y portal además en **iOS Safari real**. Anchos: **360, 390, 768, 1024, 1366×768, 1728**: en
> todos, sin scroll horizontal. Capturas con «reducir movimiento» (o `?motion=reduce`). Hallazgos en
> [AUDIT «Hallazgos de VX»](AUDIT.md); decisiones D-VX* en el [ROADMAP «VX ✅»](ROADMAP.md). OAuth de Google real queda
> para cuando se pushee.

### Transversal (cada superficie de abajo)
- [ ] **Teclado:** todo se alcanza con Tab en orden visual, con anillo de foco visible (`--focus-ring`); nada atrapa el foco; Escape cierra el menú mobile de la landing.
- [ ] **Sin JS** (DevTools → deshabilitar JavaScript): login, signup, forgot, reset, email del portal y contacto de la landing envían y muestran el resultado.
- [ ] **Reducir movimiento** (sistema): el estado final se ve completo desde el primer frame; sin animaciones de entrada.
- [ ] **Zoom 200 %** a 1280: sin scroll horizontal; nada tapado.
- [ ] Una sola `h1` por página; controles ≥ 44 px por debajo de 768.
- [ ] Red (DevTools): ninguna request a `fonts.googleapis.com`/`fonts.gstatic.com`; ninguna superficie pública baja `framer-motion`.

### Landing (`/`)
- [ ] Skip link «Saltar al contenido» con Tab; menú mobile (< 1024) con `aria-expanded`, Escape y foco que vuelve al botón.
- [ ] Claims con su evidencia (solo esto se promete): agenda día/semana/lista (`components/agenda/agenda-toolbar.tsx:16-19`) · turnero por link con profesional, servicio y horario, **sin** nombrar Mercado Pago (`components/landing/features.tsx`, `faq.tsx`; AUDIT `turnero-mp-cuenta-plataforma`) · evolución editable 24 h y después enmienda o anulación (`lib/clinical-notes-logic.ts:150`) · copago y obra social (`lib/copago.ts:9-10`) · roles y HC solo para quien atiende (`lib/visibility.ts:143-146`) · salas y sala de espera en Clínica, sin «en vivo» (`lib/tenant-modules.ts:72`) · ejercicios propios para todo el consultorio (`lib/exercises.ts:429-430`).
- [ ] Sección **«Enfoque exclusivo para kinesiólogos y osteópatas»**, sin switch; línea final a `#funciones` para Clínica general.
- [ ] Precios: tarjetas desde Plataforma → Precios; con precio sin cargar dice «Pedinos el precio» (link a `#contacto`); Libre como banda «Hablemos». Editar un precio en Plataforma → `/` lo muestra (revalidación del tag).
- [ ] FAQ «¿Cómo pago?» aparece solo con `SAAS_BILLING_MODE=manual`.
- [ ] Contacto: enviar sin JS y con JS → «Recibimos tu consulta…» con foco en el mensaje; honeypot lleno → no crea nada; envío inmediato tras cargar (con JS) → rechazado como bot.
- [ ] El guard de claims (`tests/unit/public-claims.test.ts`) en verde.

### Login (`/login`)
- [ ] ≥ 1024: panel de producto oscuro + form; < 1024 solo el form; a **1366×768** entra sin scroll; a **390×844** «Ingresar» visible sin scroll.
- [ ] Botones sociales solo de los proveedores prendidos en Supabase (Facebook apagado → no aparece); postean a `/api/auth/oauth/<p>`.
- [ ] Credenciales mal → aviso con `role="alert"` y los dos campos con `aria-invalid`; Tab desde el email va a la contraseña (el «¿Olvidaste…?» viene después).
- [ ] Mostrar/ocultar contraseña: el lector anuncia «Mostrar contraseña, presionado/no presionado».
- [ ] Sin «Matrícula» ni «Recordarme».

### Signup (`/signup`)
- [ ] Split a 1200 px; a 390 los sociales visibles sin scroll; a 1366×768 «Crear cuenta» visible o a un scroll corto.
- [ ] «{N} días gratis» sale del catálogo (Plataforma → Precios, Individual); sin selector de tipo de consultorio.
- [ ] Contraseña con `new-password` (el gestor ofrece generar); hint «Al menos 8 caracteres, con una letra y un número.».
- [ ] Al crear: «Revisá tu email» con el foco en el título.

### Forgot / reset / estado / invite / 404
- [ ] `/forgot` y `/reset` (también `/reset?…expired`) en tarjeta centrada; reset con las dos contraseñas `new-password`.
- [ ] `/sin-acceso`, `/suspendido` (Titular de 2 consultorios suspendidos), `/cuenta-desactivada`, `/mantenimiento`, `/verificar-acceso`, `/elegir-consultorio`: tarjeta centrada, h1 en la tarjeta, botones como link (un solo `<a>`).
- [ ] `/invite/<token>`: activar con contraseña nueva; email equivocado; token vencido.
- [ ] 404 con sesión → «Ir a mi consultorio»; sin sesión → «Ir al inicio» (a 360 y 1366).
- [ ] `/cuenta/seguridad` y `/plataforma-mfa/verificar` abren sin «useToast must be used inside».

### Muro de módulo
- [ ] Kine **Individual** entra a `/sala` o a un módulo de plan mayor → muro «{Módulo} está en el plan {Plan}»; Titular ve «Ver planes» (`/configuracion?tab=plan`), el resto «Pedile a quien administra la cuenta…».
- [ ] Consultorio **General** entra a `/diagnostico` → vuelve a `/dashboard` (no se le vende Kine).
- [ ] En el muro no salen errores `ForbiddenError` en el log del server (la página corta antes de consultar).

### Turnero y resultados (`/c/<slug>/booking`, `/booking/<id>/{ok,pending,failed}`)
- [ ] La marca del consultorio adelante; horario real («Lun a vie 8 a 19 · Sáb 9 a 13»), sin franjas no se muestra nada.
- [ ] Los 3 pasos + resultado a los 6 anchos; al cambiar de paso el foco va al título del paso.
- [ ] Datos del paciente con autocompletar (nombre, email, teléfono).
- [ ] «Iniciar sesión» lleva a `/portal`; Google oculto si está apagado.
- [ ] Resultado ok/pending/failed: sin «te mandamos un email» ni «cancelás gratis»; botones de 44 px.

### Onboarding (`/onboarding`)
- [ ] Paso **«¿Atendés pacientes?»**: «Sí, atiendo» sigue con «mis horarios»; «No, organizo el consultorio» saltea horarios y termina el alta con prueba del plan **Consultorio** (verificar en Configuración → Plan y uso).
- [ ] Placeholders neutros (sin «Movare»/«Camila»); «escribinos» con `SupportContact` (mailto real); pasos hechos se anuncian «(completo)».
- [ ] Sin halos con blur; a 390 el editor de horarios entra sin scroll horizontal.

### Portal (`/portal`)
- [ ] Copy neutral sin consultorio («Tus turnos y tu tratamiento, en un solo lugar»); «sesión por sesión» y check-in solo en Kinesiología.
- [ ] «Entrar con tu email» sin JS y con JS → «Revisá tu email» con foco en el título.
- [ ] «Continuar con Google» solo si Google está prendido; «Mi cuenta» solo con sesión.

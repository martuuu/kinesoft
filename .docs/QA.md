# KineSoft — QA manual por ronda

> Checklist de verificación humana versionado (ver [TESTING.md](TESTING.md)). Cada ronda de cambios
> significativa agrega su sección. **Regla de oro:** todo lo de fechas se prueba con **`TZ=UTC`**
> (`TZ=UTC npm run dev` contra el Docker local, o directamente en un preview de Vercel) — en dev
> AR-local los bugs de timezone NO se reproducen.
>
> Marcá cada ítem ✅/❌. Los ítems 🔴 **críticos** son los que pueden generar problemas grandes:
> priorizalos.

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
- [ ] **Re-reserva tras cancelar (comportamiento nuevo — validar criterio).** Cancelá un turno del
  Paciente A a las 10:00 y volvé a crear uno para A a las 10:00. Hoy el turno **revive/re-crea** como
  activo en ese slot (en vez de devolver el cancelado). Confirmá que ese comportamiento es el que
  querés; si preferís que sea siempre un turno nuevo distinto, avisame y lo ajusto.

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

- [ ] **Gate de rol en borrado definitivo.** Un usuario con rol PRACTITIONER **no** puede "eliminar
  definitivamente" un paciente / programa / sesión (mensaje: "Solo el dueño o un administrador…").
  Un OWNER/ADMIN sí. *(Archivar sigue disponible para todos.)*
- [ ] **Parser de dinero AR.** En Configuración (precio de servicio, copago, arancel fijo) y en el
  copago de un turno, ingresá **"1.500,50"** → debe guardar $1.500,50 (150050 centavos), no romperse.
  Ingresá texto inválido → toma 0 sin explotar.
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

> **Sentry** quedó cableado como **no-op** (no rompe nada) hasta que cargues el `SENTRY_DSN`
> (bucket C) — no hay nada que QA-ear ahí todavía.

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
- [ ] **Hasta 5 por fila, de ancho parejo.** Poné 5 turnos en la misma hora: se acomodan en una fila,
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
- [ ] **Semana y lista intactas.** Las otras vistas no cambiaron: confirmá que se ven igual que antes.

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

## Wave en curso — agenda de 30 min + batch preflight

⏳ **Sin sección todavía.** La wave que está en ejecución (turnos de 30 minutos en la agenda +
preflight de la carga múltiple de turnos) **agregará su propia sección de QA acá al terminar**,
siguiendo el mismo formato. Hasta entonces, no hay nada nuevo que tildar en ese frente.

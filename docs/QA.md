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

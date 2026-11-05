# KineSoft — QA manual vigente

> Checklist de verificación humana versionado (ver [TESTING.md](TESTING.md)). **Corte del 22-oct-2026** (cierre de
> T6+T7): las rondas viejas (Ronda 1 a Tanda B, 874 ítems) están **textuales** en [QA-HISTORICO.md](QA-HISTORICO.md);
> lo crítico que sigue valiendo de ellas está resumido en el §2.
>
> **Orden:** §1 QA de producción por plan (después del push) → §2 P0 (lo que no puede fallar) → §3 lo vigente de T3 a
> CF3b. Marcá cada ítem ✅/❌. **Un 🔴 P0 en ❌ frena el pase a prod.** Desde el reset del 29/30-oct **prod tiene un cliente
> vivo**: lo de prod se prueba en consultorios de QA propios, nunca creando ni moviendo turnos en el del cliente.

## Cómo se corre

- **Local, siempre con `npm run dev:local`** (= `dev:mpfake` = `dev:wafake`, `scripts/dev-mp-fake.mjs`): `next dev` con
  la base del Docker (:5433), `TZ=UTC`, Mercado Pago falso (`MP_CONNECT_MODE=fake`, cobro de la suscripción
  `SAAS_BILLING_MODE=mp`) y Meta falso (`WHATSAPP_MODE=fake`); no lee `.env*` y no arranca si la base no es local
  (`scripts/lib/dev-mp-fake-env.mjs:92-123`). Entra el actor demo (sin Supabase): lo multi-rol se prueba en el E2E
  (GoTrue falso) o con un login real local.
  - Paneles de los simuladores: `http://localhost:3000/api/mp/fake/panel` (Mercado Pago) y
    `http://localhost:3000/api/whatsapp/fake/panel` (Meta). Plataforma → Sistema linkea el de MP.
  - **Nunca `npm run dev` pelado** contra algo que no sea el Docker (desde INF-DEV se niega a arrancar contra un
    Supabase remoto) y nunca un Preview que comparta la base de prod (H6).
- **Fechas siempre con `TZ=UTC`** (`dev:local` ya la fija): en AR-local los bugs de timezone no se ven.
- **Prod: solo el §1, el «CF», el «CF2», el «CF3» y el «CF3b»**, después del push y del postcheck, con los consultorios de `scripts/qa-tenants.ts` (o
  uno de QA propio). Nada más del QA se corre contra prod, y nada sobre el consultorio del cliente.
- Antes de marcar algo como manual, mirá la columna de cobertura: si dice **QA-M** (integración
  `tests/integration/plan-routing-matrix.test.ts`) o **QA-E** / **E2E** (Playwright, `tests/e2e/*.spec.ts`), ya corre
  en el gate; a mano conviene igual una pasada visual, pero no es lo que hay que priorizar.

### Qué falta automatizar (todo esto es manual hoy)

- Pestañas de **Configuración por rol** (`visibleConfigTabs`, `components/configuracion/controls.tsx:126-158`): QA-M lo
  deja fuera de alcance (cabecera del test) y no hay E2E.
- **Estados `--state`** sobre los consultorios QA reales (QA-M los prueba con consultorios efímeros; QA-E solo
  «solo lectura»). Suspendido con `/suspendido` y el export del titular: solo integración.
- **TV real** (Smart TV, Chromecast / Fire TV, Chrome `--kiosk`): legibilidad a distancia, wake lock, recarga de las
  04:00 AR, sonido. El E2E (`tv.spec.ts`) cubre vincular, llamar, sin apellido y desvincular en Chromium.
- **WhatsApp**: el recordatorio de las 18:00 por el cron (lo cubre el diagnóstico S1-S13, no el E2E), la respuesta a un
  horario viejo, calidad / `PARTNER_REMOVED`, Plataforma → WhatsApp, y `sandbox`/`live` con Meta real.
- **Suscripción**: transferencia, débito rechazado, bajada programada, reactivar, cancelar el débito pendiente,
  ajustes y re-anclaje de Plataforma y los mails (el E2E `subscription.spec.ts` cubre débito, débito aprobado, pagar con
  MP, baja + deshacer y subida con proporcional).
- Lo que solo existe en prod: realtime de Supabase, Resend, OAuth real (Google/Facebook), Sentry, PWA instalada, iOS
  Safari real, CSP enforced con tráfico real.

---

## §1 · QA de producción por plan (después del push)

### 1.0 Preparación

- Lo corre **Martin** (el agente nunca corre scripts de datos). Uso literal de la cabecera de `scripts/qa-tenants.ts`:
  ```
  QA_EMAIL_BASE=… QA_PASSWORD=… KINESOFT_CONFIRM_PROD=<ref> \
    npx dotenv -e .env.prod.local -- npx tsx --conditions=react-server scripts/qa-tenants.ts --target prod --sample-data
  … scripts/qa-tenants.ts --target prod --state qa-individual-kinesiologia read-only
  … scripts/qa-tenants.ts --target prod --cleanup
  ```
  (`npm run qa:tenants` es el mismo CLI sin el `dotenv`.) Imprime **una vez** la tabla de accesos; la contraseña de
  todas las cuentas es la de `QA_PASSWORD` (≥ 12 caracteres) y nunca se imprime.
- Crea **8 consultorios** `qa-<plan>-<vertical>` (`qa-individual-general` … `qa-libre-kinesiologia`), con nombre
  «QA <Plan> · <General|Kinesiología>», **ACTIVE**, turnero prendido y todos los profesionales en el turnero
  (`scripts/lib/qa-tenants-core.ts:192-203`, `:336-349`).
- Equipo por plan (`scripts/lib/qa-tenants-core.ts:71-83`), emails `<local>+<slug>-<tag>@<dominio>`:

  | Plan | Personas (tag) |
  |---|---|
  | Individual | Titular (`titular`, atiende) |
  | Consultorio | Titular · Administración (`admin`, con «Configuración» y «Planes y pagos») · Secretaría (`secretaria`) · Profesional 1 y 2 (`prof1`, `prof2`) = **5, el cupo justo** |
  | Clínica | lo mismo + Facturación (`facturacion`) = 6, y salas «Consultorio 1» y «Consultorio 2» |
  | Libre | igual que Clínica + cupos a medida 12 usuarios / 8 profesionales / 4 no clínicos (`:50`) |

- **Titular no clínico:** el script no lo arma (el Titular nace atendiendo, `lib/tenant-bootstrap.ts:203`). Lo cubre
  QA-M (`OWNER_NOCLIN`); a mano: Configuración → Usuarios → «Atiendo pacientes» apagado (pide la 2FA).
- **Modos de prod en el primer deploy** (brief §26.7): `MP_CONNECT_MODE=off`, `WHATSAPP_MODE=off`,
  `SAAS_BILLING_MODE=off`, `TENANT_ACCESS_ENFORCEMENT` vacío (= `banner`). Consecuencias para este §1:
  - **no aparece «Cobros»** en ningún menú (`lib/nav.ts:140-142`; con `sandbox`/`live` aparece para Titular, Admin,
    Secretaría y Facturación) y `/cobros` redirige a `/dashboard` (QA-M);
  - no aparecen las pestañas «Cobros online» ni «WhatsApp» (`components/configuracion/controls.tsx:134-136`);
  - con `banner`, los estados vencidos **solo muestran la banda** y se puede escribir; la suspensión **sí** corta
    (`lib/tenant-access.ts:126-130`). Para ver «solo lectura» de verdad hace falta `enforce` (decisión de Martin).

### 1.1 Oráculo (de dónde sale cada fila)

- Módulos (`modulesFor`, `lib/tenant-modules.ts:68-80` y `:104-117`): **núcleo** en todos (Agenda, Pacientes,
  Facturación, Obras sociales, Historia clínica) · **Kinesiología en todos los planes**: Reportes, Planes, Sesiones,
  Diagnóstico, Evaluaciones (módulo; la EVA salió de la UI en CF), Ejercicios · **Kine desde Consultorio**: plantillas, favoritos y el catálogo global
  de ejercicios · **Clínica y Libre, en las dos verticales**: Salas y Sala de espera · el turnero es un switch.
- Menú (`lib/nav.ts:64-118`), en este orden: Inicio · Agenda · Sala de espera (módulo + `agenda.reception`) ·
  Pacientes · Planes · Diagnóstico · Seguimiento · Ejercicios · Terapia Manual · Cobros (`billing.collect` + cobros
  online) · Configuración (`tenant.admin`). **Desde CF (decisión 7, `lib/nav.ts:87-123`)** Planes, Diagnóstico,
  Seguimiento, Ejercicios y Terapia Manual piden `clinical.read`: Secretaría, Facturación y un Titular/Admin **que no
  atiende** no los ven y la URL los manda a `/dashboard`. Ojo: `qa-tenants` crea como «atiende» solo al Profesional
  (`scripts/lib/qa-tenants-core.ts:217`); si una tarjeta de abajo le lista esas entradas al Titular o al Admin y el menú
  real no las tiene, es por esto (anotalo, no es un bug).
- Capacidades (`lib/capabilities.ts`, `MATRIX`): Profesional y Secretaría tienen `agenda.reception`; Facturación no
  (no ve «Sala de espera» y `/sala` la manda a `/agenda`, `app/(app)/sala/page.tsx:50`). Solo Titular y Admin (con
  «Configuración») ven «Configuración» en el menú; cualquier miembro abre `/configuracion` y ve al menos «Soporte»
  (`components/configuracion/controls.tsx:150-151`).
- Cupos (`lib/saas-plans-logic.ts:28-33`): Individual 1 usuario · Consultorio 5 de cualquier tipo · Clínica 10 ·
  Libre sin tope salvo override (los overrides solo valen en Libre, `:43-50`). Una invitación pendiente ocupa lugar.

### 1.2 Muros y redirecciones (copy literal)

| Caso | Qué pasa | Copy / destino |
|---|---|---|
| Módulo de un plan **mayor** (hoy: `/sala` en Individual y Consultorio, las dos verticales) | Muro, la URL queda en `/sala` (`lib/module-wall.ts:59-63`) | eyebrow «Plan Clínica» (`components/ui/access-wall.tsx:94`); título «Sala de espera está en el plan Clínica» (`:20-23`) |
| … con `account.billing` (Titular; Admin del script) | Upsell con salida | «Cambiá de plan para usarlo en tu consultorio.» + «Ver planes» → `/configuracion?tab=plan` + «Volver al inicio» (`:105-111`) |
| … sin `account.billing` (Secretaría, Profesional) | Upsell sin compra | «Pedile a quien administra la cuenta que cambie de plan.» + «Volver al inicio» (`:117-121`) |
| Módulo que **no existe en la vertical** (General: `/planes`, `/diagnostico`, `/seguimiento`, `/biblioteca`, `/terapia-manual`) | Redirect a `/dashboard`, sin upsell (`lib/module-wall.ts:59-60`) | — |
| `/reportes` (cualquiera) | Redirect a `/dashboard` (`app/(app)/reportes/page.tsx:10`) | — |
| Módulo **deshabilitado a mano** por Plataforma | Muro sin upsell (`lib/module-wall.ts:58`) | eyebrow «Módulo no habilitado» (`access-wall.tsx:62`); título «Sala de espera no está habilitado» (`:30-35`); «Este módulo no está habilitado para tu consultorio. Si lo necesitás, escribinos desde Soporte.» (`lib/tenant-modules.ts:283-284`) + «Escribir a Soporte» |
| Facturación en `/sala` (Clínica/Libre) | Redirect a `/agenda` (`app/(app)/sala/page.tsx:50`) | — |
| Action sin el módulo (por ejemplo, plantillas en Individual Kine) | `ForbiddenError` con el copy del módulo | «Las plantillas de plan están disponibles desde el plan Consultorio.» · «Los favoritos están disponibles desde el plan Consultorio.» · «El catálogo de ejercicios de la plataforma está disponible desde el plan Consultorio.» (`lib/tenant-modules.ts:277-279`) |
| Sala sin el plan, desde una action | `ForbiddenError` | «La sala de espera viene con los planes Clínica y Libre. El plan se cambia en Configuración → Plan y uso.» (`lib/tenant-modules.ts:267`) |

### 1.3 Tarjetas por consultorio × rol

> En cada rol: entrá con su cuenta, recorré el menú, escribí a mano las URLs bloqueadas y probá una escritura simple
> (crear un turno o un paciente). Cobertura: **QA-M** cubre menú, muros y `/tv` de **todas** las combinaciones;
> **QA-E** cubre las marcadas. Lo que no dice nada es solo manual.

**`qa-individual-general`** (1 persona)
- [ ] **Titular** — Menú: Inicio · Agenda · Pacientes · Configuración (QA-M literal 8). `/sala` → muro «Sala de
  espera está en el plan Clínica» con «Ver planes». `/planes`, `/diagnostico`, `/seguimiento`, `/biblioteca`,
  `/terapia-manual`, `/reportes` → `/dashboard` (QA-M; QA-E en Consultorio General). Perfil del paciente con
  «Historia clínica» y sin Planes, Sesiones ni EVA (QA-E en General). Configuración sin «Diagnósticos».
- [ ] **Cupo:** Configuración → Usuarios: «Cupo lleno» (`components/configuracion/panels/users-panel.tsx:129`);
  «Invitar usuario» → «No quedan lugares en el plan para sumar a alguien con este rol. Liberá un lugar o cambiá de plan
  en «Plan y uso».» y «Crear invitación» deshabilitado (`:867-871`; QA-E en Individual Kine).

**`qa-individual-kinesiologia`** (1 persona)
- [ ] **Titular** — Menú: Inicio · Agenda · Pacientes · Planes · Diagnóstico · Seguimiento · Ejercicios · Terapia
  Manual · Configuración (QA-E: sin «Sala de espera»). `/sala` → muro con «Ver planes» (QA-E, QA-M literal 1).
  `/planes`, `/seguimiento`, `/diagnostico`, `/biblioteca`, `/terapia-manual` abren (QA-M literal 4).
- [ ] Biblioteca sin el catálogo global; Planes → Plantillas muestra solo el aviso del plan, sin «Nueva plantilla»
  (PL-F); un favorito o una plantilla por action → el copy de `lib/tenant-modules.ts:277-279`.
- [ ] **Cupo:** igual que Individual General (QA-E).

**`qa-consultorio-general`** (5 personas)
- [ ] **Titular** — Menú: Inicio · Agenda · Pacientes · Configuración. `/sala` → muro con «Ver planes»; módulos Kine
  → `/dashboard` (QA-E: Diagnóstico ausente, URLs a `/dashboard`).
- [ ] **Administración** — mismo menú que el Titular; `/sala` → muro **con** «Ver planes» (tiene «Planes y pagos»).
  No ve la HC (no atiende): perfil del paciente sin «Historia clínica».
- [ ] **Secretaría** — Menú: Inicio · Agenda · Pacientes (sin Configuración). `/sala` → muro con «Pedile a quien
  administra la cuenta que cambie de plan.» (QA-M literal 6). Perfil del paciente: solo Datos, Turnos y Facturación
  (QA-E); cobra un turno eligiendo el medio (QA-E). `/configuracion` abre solo «Soporte».
- [ ] **Profesional 1** — Menú: Inicio · Agenda · Pacientes. `/sala` → muro sin «Ver planes». `/configuracion` →
  «Mis fichas» y «Soporte».
- [ ] **Cupo:** 5 de 5 → «Cupo lleno»; invitar a cualquiera → mismo aviso; por el server: «Tu plan tiene 5 usuarios y
  están ocupados (5 contando invitaciones pendientes). Para sumar a otro profesional, liberá un lugar o cambiá de plan
  en Configuración → Plan y uso.» (`lib/team-internal.ts:465-479`; QA-M: el 6.º bloqueado).

**`qa-consultorio-kinesiologia`** (5 personas)
- [ ] **Titular** y **Administración** — Menú: Inicio · Agenda · Pacientes · Planes · Diagnóstico · Seguimiento ·
  Ejercicios · Terapia Manual · Configuración. `/sala` → muro con «Ver planes» (QA-M literal 6 para el Admin).
  Biblioteca con el catálogo global; plantillas y favoritos habilitados.
- [ ] **Secretaría** — Menú: Inicio · Agenda · Pacientes (CF: sin Planes, Diagnóstico, Seguimiento, Ejercicios ni
  Terapia Manual; esas URLs → `/dashboard`). Sin HC. `/sala` → muro sin «Ver planes» (QA-M literal 6).
- [ ] **Profesional 1 y 2** — Menú: Inicio · Agenda · Pacientes · Planes · Diagnóstico · Seguimiento · Ejercicios ·
  Terapia Manual; HC solo de sus pacientes (o compartidos).
- [ ] **Cupo:** igual que Consultorio General.

**`qa-clinica-general`** (6 personas, 2 salas)
- [ ] **Titular** — Menú: Inicio · Agenda · Sala de espera · Pacientes · Configuración. `/sala` abre (QA-M literal 3);
  «Pantallas» visible en `/sala`. Agenda con «Por sala» y filtro de salas.
- [ ] **Administración** — igual que el Titular, sin HC.
- [ ] **Secretaría** — Menú: Inicio · Agenda · Sala de espera · Pacientes. `/sala` abre con «Pantallas» (tiene
  `agenda.operateAll`).
- [ ] **Profesional 1** — Menú: Inicio · Agenda · Sala de espera · Pacientes. `/sala` abre **sin** «Pantallas».
- [ ] **Facturación** — Menú: Inicio · Agenda · Pacientes (sin Sala de espera ni Configuración, QA-M). `/sala` →
  `/agenda`. Perfil del paciente sin HC; no aprueba pedidos del portal.
- [ ] **Cupo:** 6 de 10; con 4 invitaciones pendientes la 5.ª ya rebota (QA-M: el 11.º bloqueado). Anular una
  invitación libera el lugar.

**`qa-clinica-kinesiologia`** (6 personas, 2 salas)
- [ ] **Titular** / **Administración** — Menú completo: Inicio · Agenda · Sala de espera · Pacientes · Planes ·
  Diagnóstico · Seguimiento · Ejercicios · Terapia Manual · Configuración. `/sala` + «Pantallas» abre su drawer (QA-E).
- [ ] **Secretaría** y **Profesional** — Menú sin Configuración; Sala de espera sí; la Secretaría además sin las
  entradas clínicas (CF). `/tv` vinculada desde este consultorio muestra la sala (QA-M: `/tv` «paired» en Clínica).
- [ ] **Facturación** — Menú: Inicio · Agenda · Pacientes (CF: sin las entradas clínicas; sin Cobros con
  `MP_CONNECT_MODE=off`). `/sala` → `/agenda`.
- [ ] **Cupo:** igual que Clínica General.

**`qa-libre-general`** y **`qa-libre-kinesiologia`** (6 personas, 2 salas, cupos a medida)
- [ ] Menús y muros iguales a Clínica de su vertical (QA-M). Libre General: `/planes` y `/biblioteca` → `/dashboard`
  (QA-M literal 5). `/sala` abre también para la Secretaría (QA-M literal 3).
- [ ] **Titular** → Configuración → «Plan y uso»: cupos «a medida»; «Cambiar de plan» no está: «Consultanos» abre
  Soporte con el mensaje prellenado (PL-3a); por action, «Tu consultorio tiene cupos a medida: escribinos para cambiar
  el plan.» (PL-Z).
- [ ] **Cupo por tipo:** no clínicos 3 de 4 (Administración, Secretaría, Facturación): invitar 1 Secretaría entra; la
  siguiente rebota con «Tu plan tiene 4 lugares para Secretaría o administración y están ocupados (…)»
  (`lib/team-internal.ts:451-479`; QA-M: rige el override de Libre, y un override fuera de Libre es inerte).

### 1.4 Overrides de Plataforma (sobre un consultorio QA)

- [ ] `qa-consultorio-kinesiologia` → Plataforma → Suscripción → «Módulos» → habilitar **Sala de espera** a mano
  (pide 2FA): recargar → «Sala de espera» en el menú, `/sala` abre y una TV se puede vincular (QA-M).
- [ ] Deshabilitarla → muro «Sala de espera no está habilitado» con «Escribir a Soporte» y la TV queda en «Pantalla en
  pausa» (QA-M). Volver al estado del plan.
- [ ] `qa-clinica-general` → habilitar Diagnóstico: el núcleo y lo que no existe en la vertical tienen candado; un
  General nunca abre Kine (QA-M: un grant de Kine a un General no abre nada).

### 1.5 Estados de acceso con `--state` (de a un consultorio; volver con `active`)

> `qaStatePatch` (`scripts/lib/qa-tenants-core.ts:398-417`); cálculo en `lib/tenant-access.ts:69-101` (gracia de la
> prueba 7 días, de impago 10). Banda: `components/layout/access-banner.tsx`. «member» = Secretaría, Profesional y
> Facturación: su banda termina en «Avisale al titular del consultorio.» (`:36`, `:50`); el Titular y el Admin ven el
> contacto de soporte. **Siempre:** la HC se sigue leyendo (Ley 26.529) y el Titular puede bajar el export.

- [ ] `trial` (prueba de 14 días más): sin banda (faltan más de 7 días; la banda arranca con «Te quedan N días de
  prueba.» en los últimos 7, `:62-71`). Todo escribe.
- [ ] `trial-expired` (vencida hace 3 días, en gracia): banda «Tu prueba terminó. Te quedan 5 días antes de que el
  consultorio pase a modo lectura» (`:72-80`). **Escribe** (modo `grace`, `lib/tenant-access.ts:85`).
- [ ] `read-only` (vencida hace 10 días) **con `banner`**: banda «Tu prueba terminó. Pronto el consultorio va a pasar a
  modo lectura» (`access-banner.tsx:100`) y escribe igual (QA-E con `banner`).
- [ ] `read-only` **con `enforce`**: banda «Tu consultorio está en modo lectura: podés consultar todo, pero no cargar ni
  modificar datos.» (`:94`); crear un paciente o un turno → «Tu consultorio está en modo lectura: podés consultar todo,
  pero no cargar ni modificar datos. Para reactivarlo, el titular del consultorio tiene que escribirle al equipo de
  KineSoft.» (`lib/tenant-access.ts:142-143`), nunca «Ocurrió un error»; la HC y las fichas se leen (QA-E con
  `enforce`; QA-M).
- [ ] `past-due` (impago desde hoy): banda «Tenés un pago pendiente. Te quedan 11 días antes de que el consultorio
  pase a modo lectura» (`access-banner.tsx:81-89`). Escribe. Pasados 10 días (QA-M) → solo lectura con `enforce`, o
  «Tu suscripción no está activa. Pronto el consultorio va a pasar a modo lectura» con `banner` (`:103`).
- [ ] `suspended` (corta también con `banner`): cada miembro cae en `/suspendido` con «Consultorio suspendido» · «QA
  <Plan> · <Vertical> está suspendido» · «Mientras esté suspendido no se puede entrar a la agenda ni a los
  pacientes…» (`app/suspendido/page.tsx:56-62`). El Titular ve «Descargar el export de mis datos» (`:85`) y baja la HC
  (QA-M); el resto ve «avisale al titular del consultorio.». El turnero dice «no disponible» y una TV vinculada pasa a
  «Pantalla en pausa» (`components/tv/tv-pair-screen.tsx:141`, `:33-34`).
- [ ] `active`: todo vuelve sin recargar más que una vez; la TV se reconecta sola.
- [ ] Al terminar: `--cleanup` borra los 8 consultorios y sus cuentas QA (solo slugs `qa-`).

---

## §2 · P0 (lo que no puede fallar)

> Ítems críticos de las rondas viejas que siguen valiendo, **resumidos**; el texto original (y los pasos completos)
> está en [QA-HISTORICO.md](QA-HISTORICO.md) bajo la ronda que dice cada ítem. Criterio: plata, HC/PHI,
> RLS/aislamiento, concurrencia de turnos, auth/2FA, bloqueos por plan y timezone. Además, todo lo marcado
> **🔴 P0** en el §3 (T3, T4, T5, T6, T7) también es P0. En local con `npm run dev:local`, salvo lo marcado «prod».

### Turnos y concurrencia
- [ ] Dos turnos del mismo paciente el mismo día a horas distintas → confirmación suave; quedan **los dos** al recargar. Tres veces seguidas: el conteo sube de a uno *(Ronda 6)*.
- [ ] Mismo paciente, **mismo instante** → error terminal «movelo unos minutos», no ofrece confirmar y no pisa el existente *(Ronda 6, Ronda 10)*.
- [ ] Reprogramar un turno sobre otro del mismo paciente → aviso de solape; los dos siguen existiendo *(Ronda 6)*.
- [ ] Doble clic en «Guardar» (también con red lenta) → **un** turno, ni cero ni dos *(Ronda 1, Ronda 6)*.
- [ ] Sobreturno legítimo: A y B a las 10:00 con el mismo profesional → dos turnos *(Ronda 6)*.
- [ ] Cancelar un turno y volver a dar ese horario → deja (el cancelado no bloquea ni revive) *(Ronda 6, A2b-S-pub)*.
- [ ] «Varias sesiones»: el preflight muestra por fecha libre / sobreturno / duplicado **antes** de escribir y lo creado coincide con lo que dijo *(Ronda 10)*.
- [ ] Turnero: dos reservas simultáneas en un cupo 1 → entra una sola *(B-pre)*.
- [ ] Turnero con el DNI de un paciente existente y **otro** email → la ficha queda intacta y el turno trae la nota de datos distintos *(A2b-S-pub)*.
- [ ] Candado de todo el equipo con «cancelar turnos» → los turnos con cobro registrado **quedan** (aviso) y el resto se cancela *(B-pre)*.
- [ ] Dos profesionales en la misma sala a la misma hora → celda 2/1 y «Agendar igual», sin `[SOBRETURNO]` *(SR)*.
- [ ] Bloqueo de una sala → solo esa columna rayada; la agenda de los profesionales no cambia *(SR)*.
- [ ] Agenda en vivo: la Secretaria mueve un turno que el profesional tiene abierto → se ve en la posición nueva y guardar con datos viejos dice «El turno cambió en otra sesión» *(SV)*.
- [ ] Mover un turno «en sala» o «llamado» a otro día → en el día nuevo queda «por llegar» *(SV)*.
- [ ] Editar el mismo paciente u horario en dos pestañas → la segunda recibe el aviso de conflicto, sin pisar *(A2a-S08, B-pre)*.
- [ ] Planes: con el editor abierto, ocupar un horario en otra pestaña → aviso y filas marcadas al confirmar; cantidad y precio con CAS (10→12, bajar a 8, precio con turnos cobrados) y la segunda pestaña recibe stale *(Planes P3)*.
- [ ] Modal de turno nuevo con varios profesionales y sin filtro → arranca en «Elegí un profesional» *(IAM-4b)*.
- [ ] Cambiar de consultorio con el selector y crear un turno enseguida → queda en el nuevo; dos pestañas con dos consultorios → cada acción en el suyo *(PF2)*.
- [ ] Deshabilitar a un miembro desde otra sesión → su próxima acción ya no entra *(PF2)*.

### Timezone (con `TZ=UTC`)
- [ ] Clic en una franja vacía de la vista Día (día con y sin turnos) → el modal precarga **ese** día y **esa** hora *(Ronda 1, Ronda 9)*.
- [ ] Turnero: el horario de las 08:00 queda a las 08:00 AR en la agenda *(Ronda 1)*.
- [ ] Un turno a las 13:30 cae en la fila de las 13:30 en Día y en Semana *(Ronda 10)*.
- [ ] Dashboard: un turno de las 22:00 AR de hoy cuenta como de hoy *(Ronda 1)*.
- [ ] Crear un plan a las 22:30 AR → la sesión 1 cae hoy *(Planes P0)*.
- [ ] Cobrar un copago hoy → aparece en Semana y Mes; un cobro del domingo 23:30 AR cuenta en esa semana *(Planes P3)*.
- [ ] Turno a las 23:30 AR → se ve a las 23:30 y «continúa» al día siguiente *(SR)*.
- [ ] Turnero un sábado a la noche → muestra lunes a viernes de la semana siguiente *(Tanda A, TP-1)*.

### Plata
- [ ] Un turno con un pago de Mercado Pago o con copago cobrado a mano no se borra («tiene un cobro registrado… cancelalo») *(Ronda 2, A2a-S06)*.
- [ ] Editar solo el N.º de afiliado conserva el copago propio; cambiar la obra social con copago propio avisa el monto y, si cancelás, no guarda nada *(A2a-S08)*.
- [ ] «1.500,50» y «1500.5» → $ 1.500,50; «abc» bloquea Guardar; copago de $ 50 se acepta *(A2b-S-cfg)*.
- [ ] Editar precio o copago de un servicio → solo cambia lo que se cobra en turnos sin cobrar (aviso de ES2b) *(A2b-S-cfg)*.
- [ ] Turno cobrado y después cambio de cobertura del paciente → el monto cobrado no cambia *(Planes P2)*.
- [ ] Turno cancelado o ausente con copago cobrado → aparece en Facturación (agrupada y sin agrupar) y suma en «percibido» *(SR)*.
- [ ] Ingresos por rol: Titular y Facturación ven todo el consultorio; un Profesional «Tus ingresos del mes» (dos profesionales seguidos, cada uno lo suyo); la Secretaria sin widget *(SR, IAM-4a)*.
- [ ] Turnero sin `TURNERO_CHECKOUT`: «Confirmar turno», «Lo pagás en el consultorio», «¡Turno reservado!»; nunca manda a Mercado Pago; aviso de turno nuevo una sola vez *(Tanda A, TP-0)*.
- [ ] Un pago de Mercado Pago sobre un turno ya cancelado → sigue cancelado y llega el aviso para revisar la devolución *(A2b-S-pub)*.
- [ ] Suscripción: un pago a cuenta + el cron diario dejan pagado el cargo nuevo; un pago mayor que lo que falta deja el excedente a cuenta *(PL-Z)*.
- [ ] Portal → Estado de cuenta: un REFUNDED no suma deuda; montos con `formatARS` y fechas AR *(ES4)*.
- [ ] Plan Individual no crea un plan con plantilla, ni por RPC *(Planes P3)*.

### Historia clínica y PHI
- [ ] Profesional con acceso básico (paciente ajeno): el drawer del turno no ofrece editar, reprogramar, estado ni borrar, y el ICS no trae notas, título ni descripción *(A2a-S06)*.
- [ ] Secretaria: reprograma, cambia estado, cancela y crea turnos de un paciente en básico **sin ver ni pisar** título, descripción ni notas *(Planes P0)*.
- [ ] Secretaria da de alta un paciente desde el modal del turno → queda a cargo del profesional del turno y ella no ve su HC *(Planes P0)*.
- [ ] Secretaria: nunca nivel «full» de pacientes sin asignar ni sesiones abiertas de ellos en Seguimiento *(IAM-4a)*.
- [ ] Secretaria, Facturación, Admin y Titular que no atiende: ningún texto de HC (perfil, drawer, Recepción, Seguimiento) y `/pacientes/<id>/imprimir` → 404 *(EV2; QA-E cubre Secretaría)*.
- [ ] Profesional sin acceso al paciente → no ve ninguna ficha ni evolución *(EV2)*.
- [ ] Portal del paciente y ⌘K: ninguna evolución; el portal sin notas de sesión *(EV2, Planes P0)*.
- [ ] `/sala` nunca muestra título de diagnóstico, notas ni título del plan, tampoco tras un cambio en vivo (la respuesta de `listSalaBookings` no trae `title`/`notes`/`description`) *(SV)*.
- [ ] Perfil administrativo de la Secretaria: turnos y facturación por plan **sin títulos** de plan *(Planes P3)*.
- [ ] ICS exportado por la Secretaria → sin título, descripción ni notas *(Planes P0)*.
- [ ] Turnero logueado con un email que tiene ficha en **otro** consultorio → no precarga DNI, nacimiento, cobertura ni emergencia *(EV0)*.
- [ ] Un usuario del equipo que entra al portal de pacientes ve «sin fichas» *(A3b-S-auth)*.
- [ ] Export CSV con un paciente llamado `=1+1` → en Excel es texto, no fórmula *(A2b-S-vis)*.
- [ ] Export del consultorio: JSON con manifest (pacientes, turnos, HC, cobros), **sin** tokens, ips, rutas de archivos ni payload de MP; Admin, Secretaria y soporte → 403; con la 2FA pendiente → 401 *(BO, PL-Z)*.
- [ ] Como soporte: sin HC, sin exports (403), sin sala en vivo; Configuración escribe y la agenda, pacientes y cobros no («Entraste como soporte: acá solo podés mirar.») *(BO)*.
- [ ] Mails y avisos sin PHI: Sentry sin emails, DNI ni tokens (📡 con DSN) *(A3b-S-obs)*.

### RLS y aislamiento
- [ ] La app entera con `kinesoft_app` (RLS): agenda, pacientes, sesiones, dashboard, configuración y turnero sin «permission denied» ni listas vacías sospechosas *(Ronda 4)*.
- [ ] Dos consultorios en el Docker: desde A, ningún dato de B en listados, búsqueda global ni por URL con un id de B (404/403) *(Ronda 4)*.
- [ ] Superficies sin login (turnero, webhook de MP, portal) andan por el canal service *(Ronda 4)*.
- [ ] Búsqueda de pacientes y obras sociales con «%» y «_» → solo literal (no trae a todos ni vincula «O_DE» a OSDE) *(EV1)*.
- [ ] `npm run test:integration` y `:owner` en verde, y `npm run guard:isolation` *(Ronda 4, Ronda 11; gate)*.

### Auth, 2FA e identidad
- [ ] ✉️ Signup → mail → abrirlo en el celular → `/onboarding`; recargar a mitad del alta retoma el paso *(A3c)*.
- [ ] ✉️ Signup con un email ya registrado (o de un paciente con portal) → la misma pantalla «Revisá tu email» y llega «Ya tenés una cuenta», nunca un error que delate la cuenta *(A3c, IAM)*.
- [ ] ✉️ Olvidé mi contraseña → `/reset` sin la actual; link reusado o vencido → «El link venció o ya se usó» *(A3c, IAM)*.
- [ ] ✉️ Invitación: mail con la marca, botón al dominio real (nunca localhost ni `#access_token`); sin sesión → «Activar tu cuenta» → entra solo a ese consultorio *(IAM)*.
- [ ] Link de invitación abierto con la sesión de otro email → «Esta invitación es para otro email: cerrá sesión» *(IAM)*.
- [ ] La Secretaria no aparece como profesional en la agenda, el turnero ni «primer hueco libre» *(IAM, IAM-4a)*.
- [ ] Con 2+ consultorios: después de cada login «¿A qué consultorio querés entrar?»; aceptar una invitación de B no rompe A; sin consultorio usable → `/sin-acceso`, nunca un bucle *(IAM-3a)*.
- [ ] Portal con magic link: llega el mail y entra; un email que no es de ningún paciente → **el mismo mensaje** y no llega nada *(IAM-3c)*.
- [ ] Suspender el acceso de un miembro: no entra más a ese consultorio ni aparece en la agenda; «Reactivar» lo devuelve. «Mandar link para nueva contraseña»: quien lo pidió nunca ve el link *(IAM-4c)*.
- [ ] `/api/auth/sign-in?next=//evil.com` (y `next=@evil.com`) → `/dashboard`; `/login?error=<texto>` → mensaje genérico *(A3b-S-auth)*.
- [ ] Cookies `sb-…` HttpOnly (y Secure en prod) *(A3b-S-auth)*.
- [ ] 11 logins malos seguidos → mensaje de demasiados intentos *(A3a-S-rl)*.
- [ ] 2FA: activar con app y con email (sin el código en el asunto); 10 códigos de recuperación una sola vez; login con app, email y recuperación vuelve al `next`; código vencido o 5 intentos → pide otro *(PL-2)*.
- [ ] Apagar la 2FA, cambiar de plan, permisos, «Atiendo pacientes» y transferir la titularidad piden step-up; sin 2FA, ofrecen activarla *(PL-2, PL-3, PL-Z)*.
- [ ] «Cerrar sesión» borra `kine_2fa` y `kine_stepup` *(PL-2)*.
- [ ] «Mantenerme conectado» destildado → cerrar el navegador del todo → pide login; tildado sigue logueado *(Tanda B)*.
- [ ] Facebook sin compartir el email → `/login?error=oauth_no_email`, sin perfil creado *(PL-2e)*.
- [ ] Un ADMIN sin «Configuración» no entra a Configuración ni por URL; con ella, sigue sin HC y no puede sumar a alguien que atiende («Solo el titular o un profesional del consultorio pueden sumar a alguien que atiende.») *(PL-1, PL-Z)*.

### Plataforma y superadmin
- [ ] Un usuario de consultorio (aun OWNER) no ve «Plataforma» y `/plataforma` le da 404; sin sesión → `/login` *(Ronda 7, EV0, BO)*.
- [ ] Superadmin sin consultorio propio entra a `/plataforma` *(BO)*.
- [ ] «Entrar como soporte» (motivo ≥ 10) → banda fija y mail al titular; queda en «Accesos de soporte» *(BO)*.
- [ ] MFA `enforce`: sin factor → configurar; con factor y sesión nueva → verificar; acción de riesgo pasados 10 min pide el código *(BO)*.
- [ ] Un superadmin no resetea la 2FA de otro superadmin *(PL-Z)*.
- [ ] `SUPERADMIN_2FA_BYPASS`: banda de pausa; cambiar o apagar la 2FA y sumar un TOTP siguen pidiendo el código; fecha a más de 30 días u otro usuario → no hay pausa *(Tanda A, HF-3)*.
- [ ] Editar la suscripción desde dos pestañas → «Otro cambio se guardó antes. Recargá y revisá.» sin pisar *(EV0)*.
- [ ] `/plataforma/sistema` sin ningún valor de secreto (en pantalla ni en el HTML); «Últimos mails que no salieron» solo con el dominio del destinatario *(BO, Tanda B)*.

### Bloqueos por plan y ciclo de vida
- [ ] Todo el §1 (menús, muros, cupos y estados) en local antes del push, con consultorios propios o los del E2E.
- [ ] «Suspender» desde Plataforma: los miembros caen en `/suspendido`, el turnero dice «no disponible» y un pago de MP en curso **concilia igual** *(BO)*.
- [ ] Con `enforce` y solo lectura: guardar en Servicios, Sedes, Horarios, Salas, Obras sociales, Equipo, General, Diagnóstico, ejercicios, plantillas y favoritos muestra el aviso de solo lectura, no «Ocurrió un error»; leer la HC funciona *(BO, EV1)*.
- [ ] Bajar de Clínica a Consultorio con 7 usuarios → hay que elegir **exactamente** quiénes pierden el acceso; «Pasar a Consultorio» apagado hasta que la cuenta cierra *(PL-3a)*.
- [ ] Bajar de Clínica: las salas «duermen» (sin «Por sala», Recepción ni «Llamar»; «Llegó» sigue) y al volver reaparecen con sus franjas *(PL-2f)*.
- [ ] Turnos online apagados → `/c/<slug>/booking` «Turnos online no disponibles» con el contacto y `noindex`; la página de estado de un turno ya reservado sigue andando *(EV0)*.

### Realtime y Recepción
- [ ] prod · Plan Consultorio en Chrome y en la PWA instalada: la agenda dice «En vivo» y un cambio desde otra cuenta llega en < 2 s; sin «En vivo» se actualiza cada ~60 s *(Tanda A, HF-1; hasta CF nunca anduvo en prod: ver «CF»)*.
- [ ] prod · `/plataforma/sistema`: huella del secreto de realtime (8 caracteres, nunca el valor) igual a la de `scripts/realtime-verify.ts` *(Tanda A, HF-1)*.
- [ ] «Llegó» desde el drawer en Individual y Consultorio (turno de hoy) con «Deshacer»; en Consultorio no hay «Llamar» *(Tanda A, HF-2c)*.
- [ ] Clínica: «Llegó» → el profesional ve el aviso en < 2 s; «Llamar» desde `/sala` mueve la card sin recargar en la otra pestaña *(SV)*.
- [ ] Network Offline 30 s → «Sin conexión en vivo · se actualiza cada 60 s» y vuelve a «En vivo»; con `REALTIME_DRIVER=off`, nada de indicador ni toasts *(SV)*.

### Operación y prod
- [ ] prod · Un Preview no migra (`skip migrate (VERCEL_ENV=preview)`) y Production sí *(Ronda 11 · A0)*.
- [ ] Los seeds abortan contra una base que no es local («es solo LOCAL») *(Ronda 11 · A0)*.
- [ ] `MAINTENANCE_MODE=on` → `/mantenimiento` con 503, `/api/*` 503, `/api/health` 200 con `maintenance: true`, el webhook de MP sigue *(BO)*.
- [ ] Crons sin `CRON_SECRET` → 401 (503 en Production); con el secreto, una sola vez por etapa *(BO)*.
- [ ] prod · `curl -I` → `Strict-Transport-Security`; a un Preview no *(A3b-S-obs)*.

### Cubierto por E2E (no hace falta repetirlo a mano salvo una pasada visual)
- «Llegó» de Recepción y WhatsApp manual con el celular normalizado (`recepcion.spec.ts`) ·
  cobro manual con medio (`cobro.spec.ts`) · alta de paciente (`pacientes.spec.ts`) · plan con sus turnos
  (`plan.spec.ts`) · portal con el turno de mañana (`portal.spec.ts`) · turnero de 5 días sin cobro (`turnero.spec.ts`)
  · tickets, legales, inactividad y marca de PV (`tickets`, `legal`, `idle`, `brand.spec.ts`) · fichas: alta a 390, edición en 24 h, enmienda, anulación, PDF/Word, respaldo, importar .docx y compartir
  (`fichas*.spec.ts`, `ficha-*.spec.ts`) · turnero con seña y REQUIRED, link de pago y «Mi Mercado Pago»
  (`turnero-cobro`, `payment-link`, `mp-connect`) · matriz por plan (`plans-matrix.spec.ts`) · TV, WhatsApp y
  suscripción (§3).

---

## §3 · Vigente por tanda (T3 a T7, PV, CF, CF2 y CF3)

## T3 · Agenda, Secretaria, cobros y módulos (19-oct-2026)

> T3a..T3e (`fd5e6af`..`d25c5a7`) + fixers de T3-Z. **Con migración M12** (`agenda_secretaria_config`, solo en local:
> probar contra el Docker local o un preview con M12). Plan §23.13; hallazgos en [AUDIT «Ronda T3»](AUDIT.md). **🔴 P0** =
> plata o permisos: no se pasa a prod con uno en ❌. Fechas con `TZ=UTC`. Usuarios: Titular, Admin (sin agenda),
> Secretaria (con y sin «Configuración»), Facturación, Profesional (con y sin «Configuración»).

### 🔴 P0 · Cobros (C-AS2)
- [ ] 🔴 P0 **Secretaria** en `/sala` → «Cobrar» → «Registrar cobro»: elige **Efectivo** → «Marcar pagado · $ …» (el copago entero). La fila queda «Pagado · Efectivo»; en Facturación figura con medio y quién cobró.
- [ ] 🔴 P0 **Secretaria** desde la **ficha** del paciente → pestaña «Facturación» → cobra un turno en efectivo. Lo mismo desde el drawer del turno («Cobrar» → «Pagado · Efectivo · Deshacer cobro»).
- [ ] 🔴 P0 Sin elegir medio el botón no cobra («Elegí cómo pagó.»). Re-marcar con otro medio cambia solo el medio; «Deshacer cobro» pide confirmación y deja el turno por cobrar sin medio.
- [ ] 🔴 P0 **Profesional** cobra sus turnos; en el turno de **otro** profesional no ve «Cobrar» (y el server lo rechaza).
- [ ] 🔴 P0 La **Secretaria no confirma** el pago de obra social (solo Titular, Admin o Facturación).
- [ ] 🔴 P0 Un turno pagado por **Mercado Pago** no se desmarca ni se le cambia el medio: «Este turno se pagó por Mercado Pago: el cobro no se cambia a mano.»
- [ ] **Admin** y **Facturación** cobran desde `/sala` y Facturación igual que la Secretaria.
- [ ] 🔴 P0 El modal «Registrar cobro» dice **a quién se imputa** en los tres lugares (drawer de la agenda, `/sala` y Facturación de la ficha): «Se imputa a {Profesional}» con el nombre (nunca un email), también con un solo profesional; la descripción ya no repite el profesional (T3-Y).

### 🔴 P0 · Permisos (C-AS1)
- [ ] 🔴 P0 **Admin cambia el plan** desde Suscripción: pide el código de 2FA (step-up) y ve la facturación de la suscripción. Si el Titular le saca «Planes y pagos», deja de verla.
- [ ] 🔴 P0 **Secretaria con «Configuración»** maneja servicios, obras sociales, horarios, sedes, salas y topes, pero **no ve** el switch del turnero (del consultorio ni de profesionales), Directorio, «quién ve la HC», datos del consultorio, Usuarios, diagnósticos propios ni «Terminar acceso» de soporte. Lo mismo Facturación con «Configuración».
- [ ] 🔴 P0 **Profesional con «Configuración»** sí ve y usa todo lo delicado.
- [ ] 🔴 P0 **Secretaria** edita teléfono, email, DNI y cobertura del paciente («Editar datos»); **no** ve ni manda notas ni diagnóstico. Facturación no edita datos.
- [ ] 🔴 P0 Secretaria **carga, cambia y vacía** el email de cualquier ficha (con o sin portal vinculado) desde «Editar datos»: se guarda en minúsculas (T3-Y revierte el bloqueo de T3-Z A1, decisión de Martin 19-oct).
- [ ] 🔴 P0 Facturación no aprueba ni rechaza pedidos del portal (no ve los botones).
- [ ] 🔴 P0 Export CSV de pacientes como **Facturación**: sin email ni teléfono; como Secretaria, con contactos (fix T3-Z M1).
- [ ] Secretaria da de alta un paciente en `/pacientes` con «Profesional a cargo» obligatorio.
- [ ] Titular → Configuración → Accesos de soporte → «Terminar acceso» (con confirmación): la fila dice «Lo terminó el consultorio» y el superadmin cae en su próxima acción.

### 🔴 P0 · Módulos desde Plataforma
- [ ] 🔴 P0 Plataforma → consultorio → Suscripción → «Módulos»: deshabilitar a mano un módulo (por ejemplo, Planes) pide 2FA; el consultorio ve el muro «Módulo no habilitado» y el ítem desaparece del menú (recargar). El núcleo tiene candado. Sacar Planes ofrece sacar Sesiones y Plantillas juntos.
- [ ] Habilitar a mano un módulo que el plan no trae: aparece. La fila «Precio» muestra «a medida» con link a Facturación.

### Tope de turnos por intervalo (C-AS3)
- [ ] 🔴 P0 Configuración: «Máximo de turnos por profesional: **2 cada 15** min». En el modal: el **2.º** turno a las 10:00 muestra el aviso «Ya hay 1 turno de {Profesional} a las 10:00» sin pedir confirmación; el **3.º** pide «Cargar como sobreturno» y queda con el chip «Sobreturno».
- [ ] Profesional con «Sin tope» y con tope propio: manda el suyo sobre el del consultorio.
- [ ] Turnero: con el tope lleno ese horario **no se ofrece**. Paso del turnero: servicio de 30' ofrece cada 30, de 50' cada 60.
- [ ] Lote/serie: «{n} fechas llegan al tope» + «Agendar igual esas fechas». Drawer, Turnos y plan-card avisan y permiten sobreturno.

### Agenda en 15'
- [ ] Configuración → granularidad **15**: Día y Semana muestran filas de 15' (Semana legible, con el conteo en la celda). Un usuario que nunca tocó el zoom ve la grilla del consultorio; el que eligió zoom conserva el suyo.
- [ ] Duraciones de servicios de 15 en 15 (servicios, editor por profesional y onboarding); uno viejo de 50 se ve «50 min (actual)».

### Filtro por obra social
- [ ] Agenda `?os=` → **OSDE**: solo turnos de pacientes con OSDE vigente; «Particular» incluye sin cobertura y texto libre sin vincular. Como profesional sin acceso a la cobertura de algunos turnos: «{n} turnos no se muestran con este filtro…».
- [ ] `/pacientes` filtra por la obra social **vigente** (no por una cobertura vieja).

### Ocupación
- [ ] Agenda → «Más opciones» → **Ocupación**: «Lo que pasó» (4/8/12 semanas) y «Lo que viene» (1/2/4) con número en cada celda y «x de tope». Secretaria/Titular ven todos; un profesional, solo lo suyo.
- [ ] A **390**: lista por día, sin scroll horizontal, targets de 44. A **1366×768**: la tabla entra sin scroll horizontal.
- [ ] Un turno a las 23:30 AR cae en su día y hora AR (probar con `TZ=UTC`).

## T4 · Fichas clínicas (19-oct-2026)

> T3-Y (`59b6181`) + T4a..T4e + fixers ZF1..ZF5 de T4-Z (`5d07636`..`a2d1dcd`). **Con migración M14** (`fichas_clinicas`,
> solo en local: probar contra el Docker local). `TZ=UTC npm run dev`, a **390**, **1024×768** y **1366×768**. Plan §24.12
> (Anexo C) + revisores de T4-Z; hallazgos en [AUDIT «Ronda T4»](AUDIT.md). **🔴 P0** = PHI o portal: no se pasa a prod
> con uno en ❌. Usuarios: Titular que atiende, Profesional, Secretaria, un paciente con portal y otro sin portal ni email.
> Sin Storage local, el PDF compartido queda como `stub:` y el portal lo re-renderiza desde la foto.

### 🔴 P0 · PHI y portal
- [ ] 🔴 P0 **Compartir sin portal** (paciente sin cuenta): el diálogo no promete mail ni portal; tras compartir dice «Listo: la ficha quedó compartida. El paciente todavía no tiene portal.» y ofrece «Invitar al portal». **Sin email** cargado: no aparece la casilla de aviso y se ve el aviso de falta de email antes de confirmar.
- [ ] 🔴 P0 **Compartir con portal:** el diálogo muestra el email de la cuenta **enmascarado** (`j***@gmail.com`), nunca completo (M-3 ★). El paciente lo ve en «Documentos». El mail dice solo «Tenés un documento nuevo de {Consultorio} en tu portal»: sin título, tipo ni texto de la ficha.
- [ ] 🔴 P0 Editar la ficha compartida → chip «Compartida · desactualizada» → «Compartir la versión actual» → el portal muestra la nueva. «Dejar de compartir» → desaparece del portal.
- [ ] 🔴 P0 **Anular** una ficha compartida (el diálogo avisa «…al anularla, deja de verla en su portal») → desaparece del portal. **Anular una enmienda** de una ficha compartida → el diálogo avisa «Esta enmienda va en el documento compartido con el paciente: al anularla, deja de verlo en su portal…» y el documento de la raíz desaparece del portal (M-1 ★); volver a compartir la raíz lo muestra sin la enmienda anulada.
- [ ] 🔴 P0 **Portal a 390** (QA 14): lista, vista y descarga del PDF; el id de un documento de **otro** paciente (o revocado) da 404. Forzar errores de descarga: 429 (bajar muchos seguidos), 503 y 500 vuelven a la página con un aviso claro (`role="alert"`), nunca una página en blanco.
- [ ] 🔴 P0 La Secretaria, Facturación, un Admin que no atiende y el soporte **no** ven la HC ni «Compartir con el paciente» ni las descargas (las rutas dan 403/404).
- [ ] 🔴 P0 En DevTools → Network, importando Word: **ningún** request lleva el .docx (QA 8).

### Historia clínica y composer
- [ ] **QA 1.** Un profesional abre un paciente: «Historia clínica» es la primera pestaña y está activa (`?tab=hc` también). **A 1024×768 y 1366×768** el composer compacto (editor de 4 filas que crece hasta 10; tipo, turno y fecha en una fila; «Agregar título y diagnósticos» plegado) y la **primera tarjeta** entran sin scroll. A 390 la barra «Nueva ficha» queda a mano y muestra el turno de hoy.
- [ ] **QA 2.** Slow 4G: escribir antes de que cargue el editor y no perder nada. Atajos, «Insertar estructura» + Ctrl+Z (un solo paso), pegar desde Word (colores, tabla, link): solo queda el formato permitido. «Sin formato» vuelve al textarea.
- [ ] **QA 3.** Ir a Resumen y a Agenda y volver: el borrador sigue (punto en la pestaña). Recargar: el navegador avisa. Descartar pide confirmación.
- [ ] **QA 4.** Turno de las **23:30 AR** preseleccionado (con `TZ=UTC`); «Sin turno»; la fecha sigue al turno. Guardar: fecha AR, títulos, diagnósticos y «Lic. … · MN …».
- [ ] **QA 5.** Diagnósticos: favoritos primero; crear uno propio inline; atribución «CIE-11 © OMS · CC BY-ND 3.0 IGO» visible; cambiar el principal; casilla «Usar como diagnóstico activo del paciente» destildada y, tildada, el Resumen se actualiza. Sin catálogo cargado: «El catálogo CIE-11 todavía no está cargado» y funcionan propios, kine y texto libre.
- [ ] La **hora del hero** del perfil sale en 24 h (sin «p. m.») y la consola no muestra errores de hidratación (#425/#422).

### PDF, Word y respaldo
- [ ] **QA 6.** PDF: membrete, logo, firma del **autor**, código de verificación, URI CIE-11 junto al código y `≤ → ñ` bien. Word abre en Word y en LibreOffice con las **fechas** correctas. HC completa en PDF; si es demasiado pesada: «Usá «Imprimir historia clínica»».
- [ ] **QA 9.** Carpeta de respaldo en Chrome: elegir (con la casilla «Esta computadora la uso solo yo»), guardar, editar (sobrescribe), anular. **Cerrar y reabrir el navegador**: el permiso se vuelve a pedir dentro de «Guardar en la carpeta» y guarda. Sin carpeta elegida, «Guardar» descarga. Safari y Firefox: descarga común.

### Importar Word, entradas y Configuración
- [ ] **QA 8.** Importar 3 .docx (uno de > 20.000 caracteres → «Dividir en N fichas»; uno con imágenes → aviso; uno con fecha por `lastModified`). Hay que tildar «Revisé las fechas» para importar; quedan con «Carga tardía» / «Importada» y la fecha correcta en `TZ=UTC`.
- [ ] **QA 10.** El drawer de la agenda, el toast «Atendido» y Seguimiento abren el mismo formulario de ficha.
- [ ] **QA 11.** Configuración: radio «¿Quién ve la historia clínica…?» con el copy nuevo y confirmación al ampliar a «Todos»; error y «Guardando…» dentro de la tarjeta. Logo del consultorio (General, solo con lo delicado). «Mis fichas» visible para un profesional sin delegaciones: honorífico, matrícula, firma, carpeta, diagnósticos propios (renombrar/archivar). Botones de 44 a 390.

### Archivos y accesibilidad
- [ ] **QA 12.** Archivos: uno de **20 MB** con barra de progreso y «Archivo subido»; cancelar a mitad no deja nada; un **.exe renombrado a .pdf** se rechaza («El contenido del archivo no coincide con su tipo…»). Error de la lista ≠ lista vacía («No pudimos cargar los archivos» + «Reintentar»).
- [ ] **QA 13.** Solo teclado + VoiceOver/NVDA: toolbar (Alt+F10, roving), combobox de diagnósticos (opción activa visible, live region), chips («Quitar: …», «Favorito: …»), menú «⋯» (el foco vuelve al botón), contador de caracteres («Te pasaste por {n} caracteres»); `prefers-reduced-motion`.

## T5 · Cobros online con Mercado Pago (22-oct-2026)

> T4-Y (`6f56c03`) + T5a..T5f + TP-ZF de T5-Z (`a31337c`..`92c600c`). **Con migración M18** (`turnero_cobros_mp`, solo en
> local: probar contra el Docker local). **Siempre con `npm run dev:mpfake`** (MP falso, `TZ=UTC`, nunca lee `.env*`;
> panel del simulador en `/api/mp/fake/panel`, linkeado desde Plataforma → Sistema), **nunca** `npm run dev` pelado (toma
> Supabase de `.env`, que puede ser prod: AUDIT `tp3j dev-pelado-supabase-env`). A **390**, **1024×768** y **1366×768**.
> Plan §25.14 (Anexo C) + revisores de T5-Z; hallazgos en [AUDIT «Ronda T5»](AUDIT.md). `dev:mpfake` entra con el actor
> demo: los puntos multi-rol (2, 10, 13) se cubren en el E2E con el GoTrue falso; a mano, con un login real local si lo
> tenés. **🔴 P0** = plata o secretos: no se pasa a prod con uno en ❌.

### 🔴 P0 · Plata
- [ ] 🔴 P0 **QA 1.** El profesional conecta la cuenta fake desde «Mi Mercado Pago» (Configuración o menú de cuenta) →
  «Conectada» + badge «Simulador local» → prende «Permitir que la Secretaría y los administradores generen links de pago
  a mi cuenta».
- [ ] 🔴 P0 **QA 2.** El Titular prende «Cobros online» en REQUIRED + valor del turno (pide confirmación al pasar a
  REQUIRED). La Secretaría con «Configuración» no ve la pestaña, ni con `?tab=cobros-online`.
- [ ] 🔴 P0 **QA 3.** Turnero → simulador → «Simular pago aprobado» → «¡Turno confirmado!» + comprobante. «Pagado MP» en
  Día, Semana, Lista y Por profesional **sin cambio de fondo**. El comprobante del drawer tiene la fecha AR. Otra pestaña
  con la agenda se actualiza sola.
- [ ] 🔴 P0 **QA 4.** REQUIRED rechazado → `/failed`. El hold muestra «Pendiente de pago». Aprobar una preferencia vencida →
  aviso «reserva vencida».
- [ ] 🔴 P0 **QA 5.** OPTIONAL con seña del 30 %: dos opciones sin preselección y la seña en el resumen → «Pagar ahora» →
  aprobado → «Seña pagada / Por cobrar». En /sala la Secretaría cobra el resto en efectivo. **Ingresos = seña + resto.**
  Facturación sin doble conteo.
- [ ] 🔴 P0 **Cobro a mano anula lo vivo (T5-Z M2/M3).** OPTIONAL «Pagar ahora» sin pagar → la Secretaría marca «Pagado» en
  el drawer → el checkout del turnero ya no deja pagar. Cancelar (o «Ausente») un turno con link activo → `/pagar` dice
  «ya no está disponible».
- [ ] 🔴 P0 **Seña reintegrada después del cobro a mano (T5-Z M1):** seña aprobada → cobrar el resto en efectivo →
  «Simular reintegro» de la seña → Ingresos sigue en seña − reintegro + resto (no suma el copago entero). Facturación del
  paciente todavía muestra percibido de más en este caso (pendiente, AUDIT).
- [ ] 🔴 P0 **QA 8.** Link desde el drawer por lo que falta → pago → «Pagado por Mercado Pago», sin «Deshacer» ni
  «Cobrar».
- [ ] 🔴 P0 Simulador «Simular con otro monto» → el cobro **no** pasa a PAID y llega el aviso «Pago con monto distinto».
  Reenviar el mismo pago (panel) → nada cambia (replay).

### Links de pago y `/pagar`
- [ ] **QA 7.** Link desde la ficha, sin turno → WhatsApp, email (sin concepto ni datos clínicos) y Copiar → ventana
  privada a **390** → `/pagar` sin datos del paciente (ver el HTML: el nombre no aparece) → aprobado → «¡Pago recibido!»
  → Facturación y /cobros.
- [ ] **QA 12.** Desconectar la cuenta → los links activos quedan anulados → `/pagar` dice «ya no está disponible».
- [ ] `/cobros`: filtros en la URL (tipo, estado, período, profesional), tabla desde 768 y cards a 390; copiar, reenviar,
  anular y comprobante. Con `MP_CONNECT_MODE=off` (lo cubre `tp3g-cobros`; a mano, en prod después del deploy con `off`) `/cobros` redirige
  y no aparece en el nav, ni «Mi Mercado Pago» ni «Cobros online».

### Reintegros, cuentas y avisos
- [ ] **QA 6.** OPTIONAL «Reservar y pagar en el consultorio» → «¡Turno reservado!». «Pagar ahora» rechazado → «tu turno
  quedó reservado».
- [ ] **QA 9.** «Simular reintegro» → «Reintegrado por Mercado Pago». Cancelar un turno con seña → la confirmación (drawer,
  Turnos y candado) muestra el aviso de reintegro.
- [ ] 🔴 P0 **QA 10.** El Titular conecta la cuenta del consultorio con 2FA (app y email) → el Admin ve el estado sin
  botones → «Usar la cuenta del consultorio» → un profesional sin cuenta cobra con la del consultorio.
- [ ] **QA 11.** «Forzar reconexión» (panel del simulador) → campana «Reconectá tu Mercado Pago» y estado del panel → el
  turnero de ese profesional reserva sin cobro.
- [ ] **QA 13.** Un profesional sin delegaciones ve «Mi Mercado Pago» y nada de «Cobros online».
- [ ] **Particular en $ 0 (T5-Z A1):** con el copago de Particular en $ 0, Configuración → «Cobros online» avisa; el turnero
  cotiza el precio del servicio pero el resultado avisa que no se cobró online (decisión pendiente, AUDIT).

### Accesibilidad y guardas
- [ ] **QA 14.** Teclado + lector de pantalla: radios del turnero, foco del drawer del link, regiones en vivo de `/pagar`
  («procesando» → «pagado»); `prefers-reduced-motion`.
- [ ] 🔴 P0 **QA 15.** `next build && next start` con `MP_CONNECT_MODE=fake` y `VERCEL_ENV=production` → el boot falla. Sin
  fake → `/api/mp/fake/*` da 404. (En una copia **sin** `.env*`: regla de FC-4i.)

### T4-Y · aviso al paciente de una ficha anulada
- [ ] 🔴 P0 Anular una ficha compartida (y, aparte, una **enmienda** de una ficha compartida) con el paciente con portal
  vinculado → el documento se revoca (desaparece de «Documentos») y en Mailpit llega «{Consultorio} actualizó un documento
  de tu portal»: «…ya no está disponible porque fue modificado. Si lo necesitás, pedíselo nuevamente al consultorio.»
  **Sin** título, fecha ni motivo de anulación. Pasado el tope de 3 avisos por hora por paciente (compartido con
  compartir) se anula igual, sin mail.


## T7 · Pantalla de la sala de espera (TV) (22-oct-2026)

> TV-1a..TV-I + TV-E (`cf2ea06`) + ZF3. **Con migración M17** (`reception_displays`, solo en local). `npm run dev:local`
> en un consultorio **Clínica o Libre** (o con «Sala de espera» habilitada a mano desde Plataforma). La TV va en **otro
> navegador o una ventana privada** (la cookie `kine_tv` vive en `/tv`). Con el driver `local` la TV se actualiza por
> polling de 15 s. Lo automatizado: `tests/e2e/tv.spec.ts` (vincular, llamar con nombre corto, sin apellido,
> desvincular, CSP y manifest) y QA-M (`/tv` por plan). **🔴 P0** = PHI en pantalla o una TV que muestra otro consultorio.

### Vincular
- [ ] `/sala` → **«Pantallas»** (en Tablero y en Lista y panel / Flujo) solo para Titular, Admin y Secretaría
  (`agenda.operateAll`, `components/sala/displays/displays-button.tsx:12`); un Profesional no lo ve.
- [ ] Drawer «Pantallas» → «Agregar pantalla»: Nombre (placeholder «TV de la recepción»), sede («Todas las sedes»),
  «Cómo se llama al paciente» («Nombre y apellido abreviado» · Ej.: «María G.» / «Hora del turno» · Ej.: «Turno de las
  10:30». No se ve ningún nombre.), tema Oscuro, «Link de YouTube» (opcional), «Disposición», «Durante el llamado»,
  «Arrancar sin sonido» y el aviso «Los derechos de exhibición del video son del consultorio (SADAIC / AADI-CAPIF si
  hay música).» (`components/sala/displays/display-form.tsx:34-64`). Cerrar con cambios → «¿Descartar los cambios?».
- [ ] «Agregar y generar código» → tarjeta «En la TV, abrí esta dirección en el navegador:» + «Cargá este código:»
  (`ABCD-EFGH`) + «Lo mostramos una sola vez: si cerrás, vas a tener que generar otro.»; «Copiar» → «Código copiado.»
  (`components/sala/displays/pairing-code-card.tsx:21-29`). Chip «Esperando el código».
- [ ] En la TV: `/tv` → «Vinculá esta pantalla» → código → «Vincular» → «Te damos la bienvenida.»
  (`components/tv/tv-screen.tsx:328`). El chip del drawer pasa a «En línea».
- [ ] 🔴 P0 **Un solo uso:** el mismo código en otra ventana, uno mal tipeado o uno de hace más de 10 min → «El código no
  es válido o venció. Pedí uno nuevo en Sala de espera → Pantallas.» (`lib/reception-displays-types.ts:52`). En el
  drawer, el vencido dice «El código venció. Generá uno nuevo.» con «Generar uno nuevo».
- [ ] Muchos intentos seguidos desde la TV → se frena (10 cada 10 min por IP) con el mismo mensaje.
- [ ] Tope: la 11.ª pantalla viva o un nombre repetido → error en el drawer.

### Lo que muestra (feed)
- [ ] 🔴 P0 **Sin PHI:** marcar «Llegó» en la agenda → aparece en «Próximos» con el **nombre corto** («María G.»);
  nunca el apellido completo, DNI, teléfono, servicio ni notas. DevTools → Network en la TV: el feed no trae
  `lastName`, ids ni el servicio (`tv.spec.ts` lo afirma sobre el body). Con «Hora del turno»: «Turno de las 10:30».
- [ ] «Llamar» desde `/sala` → región «Llamado» con el nombre en grande (no se corta: se achica) y el destino: «Pasá al
  consultorio 2.» / «Pasá a {sala}.» / «Te espera {profesional}.» / «Acercate a recepción.»
  (`components/tv/tv-screen.tsx:70-77`); suena el chime si el sonido está activo.
- [ ] El llamado queda hasta 10 min y pasa a recientes (3 de la última hora). Sin nadie: «Nadie más esperando.» y
  «Todavía no hubo llamados.» (`:361`, `:383`). Contador «N esperando».
- [ ] Una TV con sede elegida muestra solo esa sede (la principal incluye los turnos sin sede).

### Video y sonido
- [ ] Link de YouTube: video, lista, vivo (`/live/…`) y vivo del canal (`channel/UC…/live`) se aceptan con vista previa
  silenciada. «Ese link no es de YouTube. Pegá un link de youtube.com o youtu.be.», «No reconocemos ese link de
  YouTube…» y, con `@handle/live`, «Pegá el link del video en vivo (youtube.com/live/…) o del canal
  (youtube.com/channel/UC…)» (`lib/youtube.ts:34-38`).
- [ ] «Video al costado» (SIDE): recuadro + «Próximos». «Video grande cuando no hay llamados» (HERO_IDLE): el video
  ocupa el centro y un llamado lo interrumpe ~15 s.
- [ ] «Durante el llamado»: **bajar el volumen** (DUCK, 12 s desde el último llamado), **ocultar el video** (oculta solo
  el recuadro) o **seguir igual** (`display-form.tsx:54`).
- [ ] Con sonido: overlay «Tocá OK para activar el sonido»; con «Arrancar sin sonido», arranca mudo hasta el toque.
- [ ] Un video que falla (privado o borrado) → el recuadro se oculta y reintenta cada 5 min (cada 2 si es un vivo);
  la sala sigue.

### Kiosco, accesibilidad y bloqueos
- [ ] Cursor oculto a los 3 s sin mover el mouse; la pantalla no se apaga (wake lock, se re-pide al volver a la
  pestaña). Recarga sola a las 04:00 AR (opcional: largo de probar).
- [ ] `prefers-reduced-motion`: el llamado aparece sin animación y se lee completo (`components/tv/tv.module.css`).
- [ ] Indicador del pie «En vivo» / «Reconectando…»; sin red, la TV no queda en blanco (`error.tsx` recarga a los 30 s).
- [ ] 🔴 P0 **Desvincular:** drawer → «Desvincular» → «La pantalla deja de mostrar la sala. Para volver a usarla hay que
  vincularla de nuevo.» → toast ««{nombre}» quedó desvinculada.» → en ≤ 15 s la TV vuelve a «Vinculá esta pantalla»
  con «Esta pantalla se desvinculó desde Sala de espera. Para volver a usarla, generá un código nuevo.»
  (`components/sala/displays/displays-drawer.tsx:50`, `:71`; `components/tv/tv-pair-screen.tsx:32`; E2E).
- [ ] 🔴 P0 Consultorio suspendido o sin Sala de espera (revoke de Plataforma o bajar de plan) → «Pantalla en pausa» ·
  «La sala de espera de este consultorio no está disponible en este momento. Cuando vuelva a estarlo, la pantalla se
  reconecta sola.» (`components/tv/tv-pair-screen.tsx:33-34`, `:141`); al volver, se reconecta sin código.
- [ ] Consola de la TV sin violaciones de CSP (enforced solo en `/tv`); `/tv` no indexable.
- [ ] prod · Spike en una TV real (Smart TV, Chromecast / Fire TV o Chrome `--kiosk`) a 1080p: legible a 3 m.

## T6 · WhatsApp del consultorio (22-oct-2026)

> WA-P1..WA-U6 + WA-E (`2c040b1`) + ZF2/ZF3. **Con migración M15** (`whatsapp_messaging`, solo en local). **Todo con
> `npm run dev:wafake`** (= `dev:local`, `WHATSAPP_MODE=fake`): Meta falso, panel en `/api/whatsapp/fake/panel`
> («Responder como el paciente», plantillas, calidad). En prod queda `off` hasta que Meta apruebe. Lo automatizado:
> `tests/e2e/whatsapp.spec.ts` (conectar, consentimiento en el alta, turno agendado → «Leído», recordatorio →
> «Confirmó», «No puedo ir» → campana, BAJA, compartir ficha, turnero a 390, desconectar). **🔴 P0** = mandar algo sin
> consentimiento o con datos de salud.

### Conectar y plantillas
- [ ] Configuración → **WhatsApp** (Titular o quien tiene lo delicado; Secretaría no la ve,
  `components/configuracion/controls.tsx:136`): «Simulador local: la ventana es un Meta falso y no se conecta ningún
  número real.» → «Conectar» (pide el código de la 2FA) → ventana «Simulador de Meta (solo desarrollo)» → «Conectar
  número de prueba» → «Conectado». Si el navegador bloquea la ventana: «Abrir el simulador de Meta»
  (`components/configuracion/panels/whatsapp-panel.tsx:84-93`).
- [ ] Solo el Titular conecta o desconecta: el resto lee «Solo el titular de la cuenta conecta o desconecta el WhatsApp
  del consultorio.».
- [ ] Plantillas: 5, de «En revisión de Meta» a «Aprobada» en segundos (recargar). Rechazar una desde el panel →
  «Rechazada» y sus envíos no salen («La plantilla todavía no está aprobada por Meta.», `lib/whatsapp/copy.ts:81`).
- [ ] Checklist «Cargá un medio de pago en Meta: cada aviso entregado tiene un costo que cobra Meta, no nosotros.»
  (`lib/whatsapp/copy.ts:143`). «Mensaje de prueba» llega al panel.

### Consentimiento
- [ ] 🔴 P0 Alta de paciente con celular: la casilla «El paciente acepta recibir avisos de sus turnos por WhatsApp»
  (`lib/whatsapp/copy.ts:144`) arranca **destildada**; sin tildarla, no sale ningún aviso («El paciente todavía no
  aceptó recibir avisos por WhatsApp.»). Tildada → consentimiento anclado a ese número (E2E).
- [ ] Cambiar el celular de un paciente con consentimiento → «El celular cambió desde que el paciente aceptó: hay que
  volver a pedirle el consentimiento.» (`:80`). Un fijo → «El teléfono cargado no es un celular válido.» (`:79`).
- [ ] Turnero a **390**: casilla «Quiero recibir avisos de mis turnos por WhatsApp» destildada, con el texto «Vas a
  recibir por WhatsApp avisos de tus turnos (cuando se agendan, se reprograman y el día anterior) desde el número del
  consultorio. Los mensajes no incluyen datos de salud. Podés darte de baja cuando quieras respondiendo BAJA.»
  (`components/booking/wizard/data-step.tsx:32-33`); tildada, el resultado dice «Te vamos a avisar por WhatsApp.»
  (`components/booking/booking-result.tsx:40`). Sin scroll horizontal (E2E).
- [ ] El turnero **no revierte** una BAJA ni re-ancla el consentimiento de otro paciente con el mismo número (ZF2).
- [ ] Portal → card «Avisos por WhatsApp» con la cuenta activa (aunque los avisos automáticos estén apagados): «Quiero
  recibir avisos de mis turnos por WhatsApp» → «Listo: te vamos a avisar por WhatsApp.»; darse de baja → «Dejás de
  recibir avisos…» → «Listo: no te vamos a mandar más avisos por WhatsApp.»
  (`components/portal/whatsapp-consent-card.tsx:35-50`).

### Avisos y respuestas
- [ ] Turno de mañana con un paciente con consentimiento → sale solo «Turno agendado»; el drawer → región «WhatsApp» →
  «Historial de WhatsApp» llega a «Entregado» y «Leído» (E2E). Moverlo → «Turno reprogramado».
- [ ] Recordatorio de las 18:00 AR (con `CRON_SECRET` en `.env.local`):
  `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/whatsapp` → «Recordatorio» de los turnos de
  mañana con origen «Programado»; correrlo otra vez no duplica (`app/api/cron/whatsapp/route.ts`).
- [ ] «Enviar recordatorio por WhatsApp» a mano → sale «Enviado a mano»; repetirlo enseguida → «Ya se mandó un
  recordatorio hace poco. Probá de nuevo en unos minutos.»; con menos de 1 h para el turno no sale («Faltaba menos de
  una hora para el turno.») (`lib/whatsapp/copy.ts:91`, `:137-138`).
- [ ] Panel → «Confirmo» → badge «Confirmó» en la agenda (lector: «El paciente confirmó el turno por WhatsApp»), sin
  sonido (E2E).
- [ ] Panel → «No puedo ir» → badge «Pidió cancelar» y campana «{Nombre Apellido} avisó que no puede ir»
  (`lib/whatsapp/reply-internal.ts:272-273`); el turno **sigue agendado** (no se cancela solo, E2E). «Descartar
  aviso» lo saca. Responder a un horario viejo → «El paciente respondió a un horario anterior.».
- [ ] 🔴 P0 Panel → **BAJA** → «Editar paciente» dice «Se dio de baja por WhatsApp el dd/mm» (E2E); los mensajes en cola
  a ese número se cancelan y ningún aviso nuevo sale («El paciente pidió no recibir avisos por WhatsApp.»). Una madre
  con dos hijos pacientes con el mismo número: la BAJA corta a los dos, solo en este consultorio.
- [ ] **ALTA** → vuelve el consentimiento solo a quienes estaban en BAJA con ese número; un número sin consentimiento
  previo no queda habilitado por escribir ALTA.
- [ ] Mensaje libre del paciente → respuesta automática («Respuesta automática»). Ningún mensaje lleva datos de salud;
  el pie dice «Respondé BAJA para no recibir más avisos.» (`lib/whatsapp/templates.ts:17`).

### Compartir ficha, Plataforma y apagado
- [ ] Ficha → «Compartir con el paciente» → «Enviar también por WhatsApp» → «Compartir» queda deshabilitado hasta
  tildar «El paciente pidió recibirlo por WhatsApp»; el resultado muestra la línea de WhatsApp (enviado o en cola) y en
  el panel sale el documento (E2E).
- [ ] «Desconectar WhatsApp» → «¿Desconectar el WhatsApp del consultorio?» con «Se dejan de mandar avisos y se cancelan
  los mensajes en cola. El número sigue registrado en Meta y lo podés volver a conectar.» → vuelve a «Conectá…» (E2E).
- [ ] Panel → «Mandar aviso de calidad» → la calidad se actualiza en Configuración → WhatsApp. Si Meta quita la cuenta
  (`PARTNER_REMOVED`, lo cubre la integración de WA-S3) → «Hay que volver a conectar» con «Volver a conectar».
- [ ] Plataforma → WhatsApp: modo, variables presentes (nunca el valor), cuentas, plantillas y mensajes de 7 días por
  consultorio, **sin teléfonos**.
- [ ] 🔴 P0 **Modo `off`** (prod hoy; en local, `WHATSAPP_MODE` sin setear): sin pestaña WhatsApp, sin casilla
  en el paciente, el turnero ni el portal, sin región WhatsApp en el drawer y el cron responde `skipped: "off"` sin
  tocar la base (`lib/whatsapp/active-internal.ts:29-30`, `components/configuracion/controls.tsx:136`).

## T6 · Suscripción con Mercado Pago (22-oct-2026)

> MPS-K..MPS-4b + MPS-E (`21f3b20`) + ZF1/ZF3. **Con migración M16** (`saas_mp_subscriptions`, solo en local). **Todo con
> `npm run dev:mpfake`** (`SAAS_BILLING_MODE=mp`, MP falso; panel en `/api/mp/fake/panel`). Como Titular (o alguien con
> «Planes y pagos»). `dev:local` deja `SAAS_BILLING_TRANSFER_INFO` vacío: para probar Transferencia, cargala a mano
> antes de arrancar. Copy en `lib/saas-billing-view.ts:356-384`. Lo automatizado: `tests/e2e/subscription.spec.ts`
> (débito, débito aprobado, pagar con MP, baja y deshacer, subida con proporcional). **🔴 P0** = plata.

### Cómo pagás
- [ ] Configuración → Facturación (`?tab=facturacion`): «Suscripción» y «Cómo pagás» con «Débito automático con Mercado
  Pago» («Se debita el 4 de cada mes. Tu tarjeta la cargás en Mercado Pago, no acá.»), «Mercado Pago cada mes» («Te
  avisamos el 4 y pagás hasta el 9.») y, solo con datos para transferir, «Transferencia».
- [ ] 🔴 P0 Sin `SAAS_BILLING_TRANSFER_INFO`, «Transferencia» **no se ofrece** y no hay «Informar pago» (ZF3,
  `lib/saas-billing-view.ts:396-398`). Con la variable: «Transferí a:» con los datos y «Informar pago» con comprobante.
- [ ] Débito bloqueado desde Plataforma → el consultorio no ve la opción de débito.

### Débito automático
- [ ] 🔴 P0 Elegir el débito → «Email de tu cuenta de Mercado Pago» → MP falso → «Autorizar débito (tarjeta de prueba)» →
  vuelve con «Listo: el débito automático quedó activo.» y la banda «Débito activo · m***@… · próximo débito 4/12 por
  $ X»; el email completo **nunca** aparece (E2E).
- [ ] «Cancelar y volver» en el MP falso → banda «Falta autorizar el débito en Mercado Pago» con «Continuar en Mercado
  Pago» y «Cancelar» → «Listo: cancelaste la autorización del débito.» (ZF3,
  `components/configuracion/panels/billing-subscription-section.tsx:218`).
- [ ] 🔴 P0 Panel → «Simular débito aprobado» → el cargo del período queda «Pagado» (E2E). «Simular débito rechazado» →
  «No pudimos debitar $ X. Pagalo antes del 9/12 para no perder el acceso.» (`lib/saas-billing-view.ts:433`);
  «Simular reintento aprobado» lo salda sin cobrar dos veces.
- [ ] «Cambiar tarjeta» y «Dejar de usar el débito»; con el débito en pausa: «El débito está en pausa: este mes no se
  debita nada.»; plan sin precio: «Tu plan todavía no tiene precio: el débito se activa cuando lo carguemos.».

### Pagar con Mercado Pago y día 4
- [ ] 🔴 P0 Cargo «Vencido» → «Pagar con Mercado Pago» → «Simular pago aprobado» → vuelve a Facturación con «Recibimos tu
  pago. Puede tardar unos minutos en verse acá.» → «Pagado» y la suscripción activa (E2E). Rechazado → «Mercado Pago
  no aprobó el pago. Probá de nuevo o elegí otra forma de pago.».
- [ ] 🔴 P0 Día 4 (con `TZ=UTC`): `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/daily` crea el
  cargo del período con vencimiento el 9; repetirlo no duplica cargos ni mails.

### Cambiar de plan, baja y reactivar
- [ ] 🔴 P0 **Subida:** Plan y uso → «Cambiar de plan» → Consultorio → «Pasás a Consultorio hoy. En el cargo del 4/12 se
  suman $ X por los N días que quedan.» → «Pasar a Consultorio» → «Listo: ahora tenés el plan Consultorio» (E2E,
  `lib/saas-billing-view.ts:499-502`). Los módulos nuevos aparecen al recargar.
- [ ] **Bajada programada:** Clínica → Consultorio → «Tu plan pasa a Consultorio el 4/12. Hasta ese día seguís con
  Clínica y nadie pierde el acceso. Si sumás usuarios antes, la bajada no se aplica y te avisamos.» → toast «Listo: tu
  plan pasa a Consultorio el 4/12» (`:504-508`; `plan-change-drawer.tsx:255-256`). «Anular el cambio de plan» la
  deshace.
- [ ] 🔴 P0 **Baja a fin de período:** «Dar de baja la suscripción» → «¿Dar de baja la suscripción?» («Vas a tener
  acceso completo hasta el 4/12. Después el consultorio queda en solo lectura.» + «El débito se pausa ahora.» si hay
  débito) → banda «Pediste la baja: tenés acceso completo hasta el 4/12…» → «Deshacer baja» → «Listo: deshiciste la
  baja.» (E2E). Con la baja pendiente, cambiar de plan → «Tenés una baja programada: deshacela para cambiar de plan.».
- [ ] 🔴 P0 **Reactivar:** suscripción dada de baja → «Tu suscripción está dada de baja: el consultorio quedó en solo
  lectura.» → «Reactivar suscripción» → «Listo: reactivaste la suscripción.», **sin doble cobro** del período (ZF1).
- [ ] Mails en Mailpit: débito activo, débito rechazado, baja y cambio de plan; sin datos de tarjeta.

### Plataforma
- [ ] Plataforma → consultorio → Facturación → «Suscripción y cobro»: «Cómo paga», «Débito automático» (Permitido /
  Bloqueado / Activo), «Próximo débito», «Última sincronización» y «Consultar en Mercado Pago».
- [ ] «Bloquear débito» / «Permitir débito» con confirmación → toast «Débito automático bloqueado / permitido»
  (`components/plataforma/billing/subscription-mp-card.tsx:194`, `:324-341`).
- [ ] 🔴 P0 «Sumar saldo a favor» y «Sumar cargo extra» con descripción («La ve el consultorio en el detalle de su
  cargo.»): el consultorio lo ve en el detalle del próximo cargo; «Anular cargo» pide la palabra.
- [ ] 🔴 P0 «Re-anclar al 4» → vista previa → «Consultorio re-anclado al 4»; uno que ya cobra el 4: «Ya cobra el 4: no hay
  nada que re-anclar.» (`components/plataforma/billing/ledger-dialogs.tsx:483`, `:537-547`). El re-anclaje no
  reactiva un débito bloqueado (ZF1).
- [ ] «Bajada programada.» → «Anular bajada»; «Baja programada.» → «Deshacer baja» («Baja deshecha»).

## PV · Antes de vender (27-oct-2026)

Plan §27, commits `f9099b1`..`dcec562`, **con migración M19** (`support_tickets`, solo local). Diseño en ARCHITECTURE
ADR-030 / ADR-031; hallazgos en [AUDIT «Ronda PV»](AUDIT.md#ronda-pv). Los E2E `tickets`, `legal`, `idle` y
`brand.spec.ts` cubren el camino feliz: esto es lo que piden ojos. Mails en Mailpit (`localhost:8025`).

### 🔴 P0 · Tickets (`/contacto` → Plataforma «Tickets»)
- [ ] Anónimo: `/contacto`, `?motivo=precio` («Pedinos el precio»), `?motivo=plan-libre`, `?motivo=alta`,
  `?motivo=privacidad` → form de lead → «Volver al inicio» sin el form debajo (sin doble envío). Un `?motivo=cuenta` o
  `?motivo=onboarding` anónimo **no** abre un ticket «Cuenta desactivada» / «Alta en curso»: el origen queda «Web · contacto».
- [ ] Con consultorio usable: `/contacto?motivo=plan` redirige a Configuración → Soporte con el borrador del motivo.
- [ ] Titular de un consultorio **suspendido**, usuario con **cuenta desactivada** y usuario **en alta** (sin
  consultorio): `/contacto` muestra el form con su email (no se puede cambiar) y «Volver»; el ticket sale con la
  identidad de la sesión. Paciente del portal sin membresías → form de lead.
- [ ] Más de 5 tickets por día con el mismo usuario → error de tope; dos envíos simultáneos no pasan el tope.
- [ ] `/plataforma/mensajes` dice «Tickets»: el ticket aparece en **Nuevos** con su **origen** y la tarjeta de contacto;
  un lead del formulario web dice «Identidad: Sin verificar».
- [ ] «Tomar» → **En curso** con tu nombre; otro superadmin que toma el mismo ve que ya está tomado.
- [ ] Nota interna → aparece en la lista; el consultorio **no** la ve en su Soporte ni en su export de auditoría.
- [ ] Responder (también toma) → el consultorio ve la respuesta; «Marcar resuelto» con confirmación → **Resuelto**;
  «Reabrir» → vuelve a **En curso**. Filtro por origen y por etapa; el consultorio sigue viendo Abierta / Cerrada.
- [ ] Con Resend apagado el ticket igual queda creado.

### 🔴 P0 · Legales (casilla «Acepto los Términos y condiciones y la Política de privacidad.»)
- [ ] Alta por email: sin tildar no avanza («Para seguir, aceptá los Términos y la Política de privacidad.»).
- [ ] Alta con Google: la casilla aparece en el paso del onboarding que crea el consultorio.
- [ ] Invitación: activar (cuenta nueva) y aceptar con sesión (cuenta existente sin aceptación) piden la casilla.
- [ ] Alta asistida desde Plataforma: el titular nuevo hace `/reset` → **`/aceptar-terminos`** → `/dashboard`; sin tildar
  vuelve con el error.
- [ ] Gate de la app (LG-G): un usuario sin aceptación (p. ej. entró por «Olvidé mi contraseña» o el reenvío del link)
  que abre `/agenda` cae en `/aceptar-terminos`; tilda → vuelve a `/agenda`; «Cerrar sesión» funciona desde ahí.
- [ ] Cuenta → Seguridad muestra «Aceptaste los Términos y la Política de privacidad».
- [ ] `/terminos` y `/privacidad` a 390 y a 1366; links en el pie de AuthShell, landing, portal, turnero y directorio
  (abren en pestaña nueva desde la casilla). Sin `LEGAL_ENTITY` no aparece ninguna línea «CUIT: …».

### 🔴 P0 · Cierre por inactividad (ingresar con «Mantenerme conectado» **destildado**)
- [ ] **Verificar a ojo en Chrome y Safari que el aviso «¿Seguís ahí?» se VE (opaco, con fondo)**: el E2E lo afirma
  con el reloj falso de Playwright, que no deja terminar el fade de framer (la opacidad no se puede afirmar ahí).
- [ ] 14 min sin tocar nada → «¿Seguís ahí?» con la cuenta regresiva; «Seguir conectado» lo cierra y reinicia.
- [ ] Dejar vencer → «Tu sesión se cerró por inactividad» → `/login?reason=idle` con «Cerramos tu sesión por
  inactividad. Ingresá de nuevo para seguir.» (arriba de los botones sociales); al volver a entrar, vuelve al path.
- [ ] Dos pestañas: usar una mantiene viva la otra; cuando una cierra, la otra también.
- [ ] Cerrar Chrome con «Continuar donde lo dejaste», esperar > 16 min y reabrir → login, **sin** datos de pacientes en
  la pantalla ni en el HTML (también en `/cuenta` y `/plataforma`).
- [ ] Con la sesión vencida, `GET /api/pacientes/export` y `/api/agenda/export` → **401**.
- [ ] Con «Mantenerme conectado» tildado no aparece nunca el aviso. `/tv` y el portal no se cierran.

### Marca «Consultorio Online»
- [ ] Sidebar y MobileBar a 360 px: logo Sello C sin cortes; topbar (a 1366 desborda desde antes: backlog ZB M7).
- [ ] Landing a 1024: cabecera sin partir links ni CTA; login a 1366×768 sin scroll y pie legal sin «·» sueltos.
- [ ] Pestañas: «Agenda · Consultorio Online» (sin marca duplicada). Manifest (`/manifest.webmanifest`, `short_name`
  «Consultorio»), ícono de PWA instalada y `/apple-icon`; vista previa OG al pegar el link en WhatsApp.
- [ ] Mails en Mailpit: remitente «<Consultorio> vía Consultorio Online» y pie sin «kinesiología y osteopatía».
- [ ] 2FA nueva sale como «Consultorio Online»; una ya enrolada sigue con el nombre viejo y sus códigos funcionan.

### `/pacientes` paginado (con más de 50 pacientes)
- [ ] 50 por página, `?page=`, indicador arriba y paginación abajo; el total es de todo el directorio (las pastillas de
  plan salieron en CF2).
- [ ] Orden (próximo turno, última visita) estable entre páginas; filtro de obra social (`?os=`) pagina sobre lo filtrado.
- [ ] Secretaría ve la proyección admin paginada igual; una búsqueda nueva vuelve a la página 1.
- [ ] El export CSV trae **todos**, no solo la página.

### Plata y webhook
- [ ] Montos con centavos solo cuando no son cero ($ 1.500,50; $ 1.500). Proporcional de una subida de plan con centavos.
- [ ] Webhook de MP con body de más de 64 KiB → **413** (`curl -X POST --data-binary @grande.json`); uno normal sigue 200.
- [ ] Débito cancelado desde MP (simulador) → mail «débito cancelado» en Mailpit.


## CF · Feedback del primer cliente (30-oct-2026)

Plan §28, **con migración M20** (`cf_agenda_rules`; en prod antes del push, [RUNBOOK «M20 en prod»](MIGRACIONES-RUNBOOK.md)).
Diseño en ARCHITECTURE ADR-032; hallazgos en [AUDIT «Ronda CF»](AUDIT.md#ronda-cf). **En prod, después del deploy**, con
un consultorio de QA propio (Kine, con dos profesionales y dos servicios cada uno, turnero prendido), nunca creando
turnos en el del cliente. Cada pantalla a **1366×768** y a **390** (Chrome mobile o la PWA). Los E2E `cf-*` cubren el
camino feliz en local.

### 🔴 P0 · Un profesional no atiende servicios distintos a la vez
- [ ] Con el interruptor apagado (default): turno de Kinesiología 10:00-11:00 del Prof. 1; nuevo turno de **otro
  servicio** del Prof. 1 a las 10:30 con **otro paciente** → el selector marca ese horario como ocupado por otro servicio
  y al guardar sale el aviso «<Prof. 1> está atendiendo «Kinesiología» en ese horario.» **sin escribir nada**.
- [ ] Desde el aviso, forzar → el turno queda como **sobreturno** (marca de sobreturno en la agenda).
- [ ] Mismo servicio a la misma hora → entra hasta el cupo del servicio, como antes. Mismo **paciente** con otro servicio
  seguido o pisado → sin aviso de «otro servicio».
- [ ] Mover o alargar un turno existente hasta pisar uno de otro servicio → mismo aviso.
- [ ] Configuración → Profesionales → Prof. 1 → Horarios → «Reglas de la agenda de <nombre>» → tildar «Atiende servicios
  distintos a la vez» → Guardar reglas (salir sin guardar avisa) → el alta de 10:30 entra sin aviso.
- [ ] Turnero público con el interruptor apagado: el servicio B **no ofrece** 10:00 ni 10:30 del Prof. 1 (el día figura
  como completo si no queda nada); con el interruptor prendido, sí.

### Pasos y hora manual
- [ ] Configuración → General → «Reglas de la agenda»: horarios cada 30 → en el modal del turno el selector dice
  «Horarios cada 30 min» y ofrece :00 y :30. Un profesional con paso propio de 15 → ofrece de a 15 solo para él.
- [ ] Paso del turnero en 60 (o automático) → `/c/<slug>/booking` ofrece de a 60 (automático = según la duración).
- [ ] Hora manual: el link «¿Otro horario?» del selector lleva el foco a «Hora»; cargar 10:10 a mano guarda 10:10. A 1366
  y a 390 «Duración» queda alineada con «Hora» aunque se vea la ayuda.

### Anticipación del turnero
- [ ] «Reglas de la agenda» → anticipación 2 días (también probar horas y semanas) → el turnero no ofrece nada antes de
  pasado mañana, dice «Los turnos online se piden con al menos 2 días de anticipación.» una sola vez y arranca la
  ventana en el primer día posible. Con 1 hora o vacío, no aparece el texto.
- [ ] Un servicio del profesional con anticipación propia (0 incluido) le gana a la del consultorio.

### Formulario del turnero
- [ ] Kine: «Diagnóstico» obligatorio y arriba (sin él no confirma y dice qué falta); fecha de nacimiento **opcional**
  (vacía → la reserva entra). General: «Motivo de consulta» obligatorio. Nombre, apellido, DNI, email y teléfono siguen
  obligatorios.

### 🔴 P0 · Bloquear varios días
- [ ] Agenda → «Bloquear días» → «Hasta el día (opcional)»: vacaciones de lunes a viernes con un turno el **martes** →
  la vista previa lista el turno del martes; confirmar → los 5 días bloqueados y el diálogo muestra «Listo» (no vuelve
  al formulario).
- [ ] Abrir un día del rango → quitar **solo ese día** → los otros siguen bloqueados.
- [ ] «Quitar todo el bloqueo (…)» → se liberan todos los días del rango.
- [ ] Turnero: los días bloqueados no se ofrecen (y vuelven al quitar el bloqueo). Más de 31 días → error claro.

### Menú por rol, EVA y Diagnóstico
- [ ] **Secretaría** (y Facturación): sin Diagnóstico, Planes, Ejercicios, Seguimiento ni Terapia manual en el menú, en
  la barra de mobile ni en ⌘K; abrir `/planes`, `/diagnostico`, `/biblioteca`, `/seguimiento` o `/terapia-manual` →
  `/dashboard`. El Profesional los sigue viendo.
- [ ] EVA fuera: el perfil no tiene la pestaña de evolución ni la tarjeta de EVA en Resumen; Seguimiento sin EVA pre/post
  ni curva; el portal sin check-in; la HC sin la línea «EVA a → b»; landing, precios y «Plan y uso» sin «Diagnóstico» ni
  «Evaluaciones» como beneficio.
- [ ] `/diagnostico` → «Diagnóstico · Próximamente» con «Volver al inicio».

### Notificaciones y realtime
- [ ] Con más de 4 avisos: el panel muestra más de 4, se nota que hay más (pie con cuántos, desvanecido) y «Ver
  anteriores» trae los anteriores. Alta de un paciente por la Secretaría → le llega al Titular.
- [ ] Apariencia «Barra lateral»: la campana está en la barra lateral (se abre con teclado y Escape vuelve al botón); a
  390 la campana está en la barra de arriba. Nunca dos campanas en el dashboard.
- [ ] **«En vivo» en la PWA instalada y en Chrome**: la agenda dice «En vivo» y un turno creado desde otra cuenta aparece
  en < 2 s. Si dice «Versión nueva» sin haber deployado, o «error del servidor», pegá el diagnóstico del indicador.

### Mail, favicon y detalles
- [ ] Perfil del paciente → invitar al portal con Resend mal configurado (o un email inválido) → el error dice el
  motivo (no culpa siempre al proveedor) y muestra el link del portal para copiar; Titular/Admin ven el motivo técnico.
- [ ] Favicon: borrar la caché del sitio (o ventana privada) → la pestaña muestra el sello C; `/favicon.ico` responde.
  La PWA reinstalada muestra el ícono nuevo.
- [ ] Configuración → Servicios: el campo de precio (MoneyInput) tiene el mismo alto y borde que los demás, con el «$»
  adentro y foco visible, a 1366 y a 390.
- [ ] Fichas y HC: debajo de «Podés editar hasta…» se lee «Después se puede editar, pero queda como enmienda.»

## CF2 · Feedback de los clientes, 2.ª ronda (02-nov-2026)

Plan §29, **con migración M21** (`cf2_profesional_caja`; en prod antes del push, M20 antes si falta, [RUNBOOK «M21 en
prod»](MIGRACIONES-RUNBOOK.md)). Diseño en ARCHITECTURE ADR-033 (caja y reparto) y ADR-034 (avisos); hallazgos en
[AUDIT «Ronda CF2»](AUDIT.md#ronda-cf2). **En prod, después del deploy**, con un consultorio de QA propio (plan Clínica,
2 sedes, Titular que atiende + 2 profesionales + Secretaria, turnero prendido), nunca sobre el del cliente. Cada pantalla
a **1366×768** y a **390**. Los E2E `cf2-*` cubren el camino feliz en local (sin push).

### Agenda: de quién es, Semana y Mes
- [ ] Profesional entra a `/agenda` → título «Tu agenda · <nombre>» y la fecha como subtítulo; Secretaria → «Todos los
  profesionales (N)». Elegir 1, 2 y 3+ chips → «Agenda de …», «… y …», «3 profesionales: …» (3+: primer nombre +
  inicial del apellido). Consultorio con un solo profesional: sin cambios.
- [ ] Elegir profesionales, ir a Pacientes y volver a `/agenda` (sin `?pros=`) → la selección sigue. Un link con
  `?pros=` le gana. «Por sala» ignora la selección sin borrarla. A 390 los chips scrollean horizontal.
- [ ] Semana: **un solo** encabezado (la tira, sticky al scrollear), alineado con las columnas, «hoy» con anillo, el
  candado del día en la tira (bloquear/desbloquear desde ahí). Clic en el día → vista Día de ese día.
- [ ] Segmento «Mes» (`?view=month`): cantidad de turnos por día de los profesionales elegidos, iniciales, estado
  bloqueado / parcial / sin atención (con glifo, también a 390). ‹ › mueven un mes; clic en un día → Día. Sin nombres de
  pacientes; filtros de OS y sala ocultos. El conteo de un día = el de la vista Día con la misma sede.
- [ ] Mes en vivo: crear un turno desde otra cuenta → la celda suma sin recargar.

### 🔴 P0 · Cobro visible, Recepción y `/sala`
- [ ] Secretaria cobra un copago en efectivo desde el drawer → la tarjeta de la agenda (Día, Semana, Lista) muestra
  «Pagado · Efectivo» en < 2 s en otra pestaña. Un atendido o llegado que debe → «Por cobrar». Un online retenido →
  «Retenido» (en Semana compacta, glifo distinto del de «Por cobrar»).
- [ ] El Profesional ve el tag solo en **sus** turnos; la Secretaria, en todos.
- [ ] Recepción: columna «Cobro», chip «Por cobrar · N · $X» (visible y deshabilitado en 0) → «Cobrar» abre el modal
  con medio de pago; cobrado → la fila cambia y el chip baja. También en un día que no es hoy.
- [ ] `/sala` Tablero: «Por cobrar · N · $X» en el header (mismo número y total que el chip de Recepción, incluye a los
  que llegaron y no terminaron) → drawer → cobrar. Lista y Flujo con «Llamados» y el tag «Pagado · medio» junto al
  estado. Abrir el turno desde `/sala` → `/agenda?…&open=<id>` con el drawer abierto.
- [ ] Con 2 sedes: selector «Sede» en `/sala` (compartido con la agenda); «Todas las sedes» muestra todo. «¿Otro día? →
  Recepción» lleva a la agenda en Recepción.
- [ ] **1366×768 y una pantalla de ≤ 800 de alto:** el header del Tablero en una fila en orden (título → segmentado →
  buscador → cobro → Sede → link → Pantallas), sin desbordar ni dejar el buscador en 0; < 1280 el link se oculta.

### Pacientes
- [ ] Sin la columna «Plan activo» ni las pastillas «Con plan / Sin plan» (para nadie); el plan sigue en la ficha.
- [ ] Columna «Kinesiólogo» (General: «Profesional»): el a cargo primero con la marca «a cargo», «+N» con el resto
  (tooltip con todos). Un paciente con turno próximo con otro profesional lo suma.
- [ ] **Secretaria** ve «Última visita» y «Estado» (Activo / Inactivo) con valores, sin notas ni planes. «Último
  diagnóstico» oculto sin `clinical.read`.
- [ ] «Última visita» = el último turno pasado no cancelado, ausente ni pendiente (sin marcar «Atendido» igual cuenta);
  el filtro «Última visita desde/hasta» y el orden dan lo mismo que la columna.
- [ ] Profesional con acceso básico a un paciente ajeno: ve el a cargo y los de turno próximo, no «Última visita» ni
  «Estado».

### 🔴 P0 · Caja e Inicio
- [ ] Titular: nav «Caja» → `/caja` Día y Mes por profesional (Copagos, Online, Obra social, Total, Destina, Recibe,
  Neto), «Por medio de pago» y «Reparto vigente» en Día. Los totales del Mes = el widget de Ingresos del Inicio.
- [ ] Secretaria con Mercado Pago apagado: «Caja» está en el nav; `/caja` solo hoy, **sin** columna de OS ni Mes. Inicio:
  tarjeta «Cobrado hoy» (por profesional, «destina $X», total, hora) → «Ver caja». El widget de Ingresos sigue oculto.
- [ ] Profesional: solo su fila y lo que recibe, Día y Mes; ningún bruto de otro profesional (mirar el HTML).
- [ ] Un cobro a las 23:30 AR cae en ese día (no en el siguiente). `/caja` no deja ir al futuro.
- [ ] A 390: tarjeta por profesional; controles del período de 44 px.

### 🔴 P0 · Reparto con cambio de regla a mitad del día
- [ ] Configuración → Profesionales → Prof. B → «Reparto»: 20 % a A sobre copagos + online → «Guardar desde ahora».
  Cobrar un copago de B a las 10:00. A las 15:00 cambiar a 25 % sobre las 3 fuentes; cobrar otro → en `/caja` el de las
  10:00 queda al 20 % y el nuevo al 25 %. Σ Neto = Σ Total al centavo.
- [ ] Historial con las dos reglas; «Recibe de» en A (solo lectura). «Dejar de destinar» cierra la vigente.
- [ ] Quien recibe no puede destinar (se explica); no hay regla a sí mismo. Dos pestañas guardando a la vez → una entra y
  la otra dice «Cambió mientras lo editabas».
- [ ] Soporte de Plataforma: no ve la subpestaña ni `/caja`.

### Suspender a un receptor
- [ ] Con la regla B → A vigente, suspender a A desde Equipo → la regla queda cerrada en ese instante (historial); los
  cobros de B posteriores ya no descuentan. Reactivar a A **no** la reabre. Lo mismo al quitarlo del equipo o pasarlo a
  Secretaria. (Hoy el editor y la caja no explican el porqué: backlog «cf2 aviso-receptor-inactivo».)

### Mi agenda y avisos
- [ ] Profesional → Configuración → «Mi agenda»: switch del turnero propio, anticipación propia (le gana al consultorio,
  pierde contra la del servicio), teléfono con consentimiento, «Avisarme por mail». Clic en el texto del switch lo cambia.
- [ ] Reservar un turno online con el mail prendido → llega «Nuevo turno online: <día> <hora>» con «Juan P.», duración y
  sede, sin servicio; «Ver en la agenda» abre ese día. Un turno cargado por el staff **no** manda nada (solo la campana).
- [ ] La campana del Titular muestra el turno online en < 2 s (antes llegaba en el polling siguiente).
- [ ] **Push** (con las claves VAPID en Vercel), en cada uno: **Android Chrome**, **Chrome y Edge de escritorio** y
  **iPhone con la app instalada** (Safari → Compartir → Agregar a inicio, abrir desde el ícono):
  - [ ] «Activar en este dispositivo» pide el permiso **recién ahí**; queda en la lista de dispositivos («Chrome en
    Android», etc.). En iPhone sin instalar, dice que hay que instalar la app.
  - [ ] «Probar notificación» llega; más de 3 en 5 min → aviso de espera.
  - [ ] Reserva online → notificación «Nuevo turno online · <día> · <hora> · <Consultorio>», **sin** el nombre del
    paciente en la pantalla bloqueada; tocarla abre la agenda de ese día (o enfoca la pestaña abierta).
  - [ ] «Quitar» un dispositivo → deja de recibir. Cerrar sesión en ese navegador → su dispositivo desaparece de la lista;
    los otros siguen.
  - [ ] Permiso denegado en el navegador → la tarjeta lo explica, sin botón roto.

### Turnero: contacto dentro de la anticipación
- [ ] Profesional con anticipación de 1 día, teléfono y consentimiento prendidos, y lugar libre **hoy** dentro de esa
  ventana → el turnero (con ese profesional elegido) muestra «¿Necesitás un turno antes?» con «WhatsApp» (principal, abre
  `wa.me` en otra pestaña con el texto) y «Llamar» (`tel:`).
- [ ] Sin lugar libre hoy, en otro día, con «cualquier profesional» o con el contacto apagado → no aparece. El número no
  está en el HTML de la página (viene por action).
- [ ] El Titular, desde Profesionales → Horarios, solo puede ocultarlo; volver a mostrarlo lo hace el profesional.

## CF3 · Precio por profesional, Mi agenda, compartir y sede (04-nov-2026)

Plan §30, **con migración M22** (`cf3_precios_sede`; en prod antes del push, [RUNBOOK «M22 en prod»](MIGRACIONES-RUNBOOK.md)).
Diseño en ARCHITECTURE ADR-035 (precio por profesional) y ADR-036 (sede digital); hallazgos en [AUDIT «Ronda
CF3»](AUDIT.md#ronda-cf3). En local con `npm run dev:local`; **en prod, después del deploy**, con un consultorio de QA propio
(Titular que atiende + otro profesional + Secretaria, turnero prendido, una OS con copago y la fila «Particular»), nunca
sobre el de TMP. Cada pantalla a **1366×768** y a **390**.

### 🔴 P0 · Dos profesionales, precios distintos
- [ ] En «Mi agenda», el Titular carga $ 20 000 y el otro profesional $ 15 000 en el mismo servicio. Configuración →
  Servicios / Profesionales muestra la columna de precio de cada uno (vacío = hereda).
- [ ] Agenda (Día, Semana, Lista): un turno particular de cada uno muestra su precio; uno con OS real y copago, el copago de
  la OS (no el precio del profesional); uno con OS sin copago cargado, el precio del profesional.
- [ ] Modal de turno: elegir paciente particular y cambiar de profesional → el preview cambia de $ 20 000 a $ 15 000 con la
  fuente «precio del profesional».
- [ ] Turnero: paso de servicio con el profesional elegido → su precio; con «Cualquier profesional» → sin precio, y en el
  resumen el del profesional que tocó.
- [ ] Link de pago a nombre de un paciente particular del segundo profesional → $ 15 000. Cobrar desde el drawer → se
  congela $ 15 000; cambiar después el precio en «Mi agenda» no mueve ese cobro.
- [ ] Reasignar un turno sin cobrar del Titular al otro → pasa a $ 15 000; ya cobrado, no cambia.
- [ ] Turno sin paciente (invitado): la agenda y el Inicio muestran lo mismo que después se cobra.
- [ ] «Mostrar el precio en el turnero» apagado en uno: el turnero no lo muestra (mirar el HTML: ni el número ni el precio
  del servicio si es el mismo), y con cobro online el monto aparece en la pantalla antes de Mercado Pago.

### Paciente con obra social en el turnero
- [ ] Profesional con «WhatsApp para pacientes con obra social» prendido (pide aceptar el consentimiento nuevo) → paciente
  que elige su OS: sin precio, «Consultá tu cobertura con {Profesional}» + botón de WhatsApp que abre `wa.me` con el texto.
  El número no está en el HTML (viene al tocar).
- [ ] Con el switch apagado, o tocando muchas veces seguidas (rate limit): «Consultá tu cobertura con el consultorio» +
  teléfono del consultorio, sin nombrar al profesional y sin dos textos a la vez.
- [ ] Borrar el teléfono en «Mi agenda» con el switch prendido → el switch se apaga solo.

### Profesional sin «Configuración» en «Mi agenda»
- [ ] Entra a Configuración → cae en «Mi agenda» (no en Soporte). No ve General, Sedes, Profesionales ni Servicios.
- [ ] Ve las 5 secciones en orden: Servicios y precios · Días y horarios · Vacaciones y días especiales · Turnero online ·
  Avisos.
- [ ] «Nuevo servicio» → crea uno propio (Drawer con dirty-guard); aparece en su turnero, **no** en el de otro profesional;
  un solo precio editable. Los del consultorio: habilitar, precio, duración y público/privado, sin poder editarlos.
- [ ] Cambiar días y horarios de la semana; un horario que choca de sala con otro profesional → rechazo con copy claro.
- [ ] Cargar vacaciones (rango de días) → la agenda y el turnero las respetan. Un rango inválido → mensaje, no error 500.
- [ ] No puede cambiar la capacidad, la anticipación ni el horizonte del servicio (siguen en Configuración del Titular).
- [ ] Tarjeta «Turnero online» → «Tu link para sacar turno» con «Copiar» y «Compartir por WhatsApp»; abrirlo → «Turnos con
  {Nombre}» y «Ver otros profesionales». Con su switch apagado o el turnero del consultorio cerrado: deshabilitado con el
  motivo.
- [ ] El Titular (también atiende) ve «Mi agenda» además de las pestañas del consultorio; en Profesionales, el link de cada
  uno. La Secretaria no ve «Mi agenda».

### Secretaria compartiendo desde el perfil
- [ ] Perfil de un paciente → ícono de WhatsApp en el teléfono: abrir chat, llamar, copiar, recordatorio del próximo turno
  (con el nombre del consultorio), próximos turnos (hasta 5), link del turnero (solo si está abierto), link de pago (con
  cobros online y permiso de cobro). Sin datos clínicos en ningún texto.
- [ ] El próximo turno saltea ausentes y cancelados. La invitación al portal solo aparece con acceso full.
- [ ] Pestaña Turnos: «Compartir por WhatsApp» y «Copiar» por fila, con teclado (flechas, Esc devuelve el foco).
- [ ] Paciente sin celular válido → el menú lo explica. Acceso básico → contacto oculto («en sus datos»).
- [ ] A 390: botones de 44 px.

### Titular en «Sitio web» y `/tmp`
- [ ] Configuración → «Sitio web»: prender, frase (contador ≤ 120), descripción (≤ 800), teléfono y WhatsApp públicos;
  «Ver mi sitio» abre `/<slug>`. Con dos pestañas, la segunda en guardar avisa que cambió.
- [ ] `/tmp` (en el QA, `/<slug del consultorio QA>`): logo, nombre, frase, descripción, «Sacar turno», profesionales con
  especialidad, matrícula, servicios y precio (solo de quien lo muestra), «Sacar turno con X» → turnero con él elegido,
  horarios, «Quién atiende cada día», sede con «Ver en el mapa», obras sociales y contacto del consultorio. Nunca el
  WhatsApp ni el email de un profesional (mirar el HTML).
- [ ] `/TMP` → 308 a `/tmp`. Un slug inexistente → 404 de la sede (no 500). Sitio apagado → 404. `/caja`, `/cobros`,
  `/pagar`, `/contacto` siguen siendo lo de siempre.
- [ ] Subir otro logo en General → a los ≤ 10 min la sede muestra el nuevo. Cambiar el nombre o un precio → idem.
- [ ] `/robots.txt` no bloquea `/tmp` ni un slug como `tvsalud`; con el sitio prendido, `/sitemap.xml` lo lista.
  `/consultorios/<slug>` apunta a la sede (canonical).
- [ ] Plataforma → consultorio → prender/apagar el sitio; soporte no puede publicarlo.
- [ ] A 390 y 1366: una sola columna legible en mobile, nav sin anclas a secciones vacías, «Ver en el mapa» de 44 px.


## CF3b · Marca TMP, servicios, co-titular, matrícula y foto (05-nov-2026)

Decisiones y pedidos de Martin del 05-nov, **con migraciones M23** (`cf3_co_titular`) **y M24** (`cf3_practitioner_photo`),
que van con M22 en un solo `db:prod:deploy` ([RUNBOOK «M23 en prod» y «M24 en prod»](MIGRACIONES-RUNBOOK.md)). Diseño en
ARCHITECTURE ADR-036 (encabezado y logo público), ADR-037 (co-titular y matrícula) y ADR-038 (foto y marca); hallazgos en
[AUDIT «Ronda CF3b»](AUDIT.md#ronda-cf3b). En local con `npm run dev:local` y un consultorio de QA (Titular que atiende +
otro profesional + Secretaria, turnero y «Sitio web» prendidos, con logo). **En prod**, la paleta de TMP es una activación
(se asigna sobre TMP y se mira sin tocar turnos); el resto, en un consultorio de QA propio. Cada pantalla a **1366×768** y
a **390**.

### Tema TMP
- [ ] Plataforma → el consultorio → Ciclo de vida → colores del sitio y del turnero → «TMP (de marca)» → pide
  confirmación → guarda. En prod, después del deploy, esto se hace sobre **TMP** (es la activación de la marca).
- [ ] La sede `/<slug>` y el turnero `/c/<slug>/booking` quedan en azul marino y turquesa: botones, avisos, turno
  elegido, sombras (ningún celeste fijo de los de antes). El fondo general del turnero no cambia (C-F1).
- [ ] Apariencia (miembro de ese consultorio) ofrece «TMP» además de las cuatro de siempre; elegirla pinta la app.
  «Ajustes» la muestra marcada. En otro consultorio del mismo usuario no aparece y se ve «Celeste».
- [ ] Configuración → «Sitio web»: las cuatro generales + «TMP». Elegir otra y «Guardar» → confirmación que avisa que
  volver a TMP lo hace soporte; cancelar no guarda. Un consultorio sin la paleta asignada no ve «TMP».

### Logo en la app
- [ ] Con logo cargado (General): se ve en el selector del sidebar (abierto y contraído), la barra móvil (con la marca
  del producto en una baldosa al lado), el menú de cuenta y `/elegir-consultorio`. Sin logo: las iniciales de siempre.
- [ ] Cambiar el logo → al recargar se ve el nuevo en todos lados. Abrir `/api/consultorio/logo?t=<otro tenant>` →
  404 (no distingue «no existe» de «no es tuyo»); sin sesión → 401.

### Encabezado de la sede
- [ ] `/<slug>`: foto de consultorio de fondo con el velo en el color del consultorio, el logo grande, nombre, frase y
  «Sacar turno». La foto se mueve despacio y los puntos flotan; con «reducir movimiento» del sistema no se mueve nada y
  se ve completo.
- [ ] Compartir `/<slug>` por WhatsApp (o un validador de OG): la tarjeta trae la foto con el nombre del consultorio.
- [ ] A 390 el encabezado no tapa el texto y no hay salto al cargar la foto.

### Servicios con «Para todo el consultorio»
- [ ] Configuración → Servicios → «Nuevo servicio» (Titular que atiende): el checkbox «Para todo el consultorio»
  viene marcado; marcado → queda del consultorio, habilitado y en el turnero para todos. Desmarcado → aparece el
  selector con uno mismo elegido.
- [ ] «Mi agenda» → «Nuevo servicio» (profesional sin «Configuración»): el checkbox viene desmarcado → queda suyo.
  Marcado → la fila dice «Del consultorio», ya no lo puede editar ni borrar; los colegas lo tienen habilitado para la
  agenda pero **no** en su turnero hasta que lo publiquen.
- [ ] Con 30 servicios propios: el checkbox queda marcado y fijo (solo puede crear del consultorio).

### Co-titular
- [ ] Titular principal → Configuración → Usuarios → otro profesional activo: switch «Co-titular» con el texto de qué
  puede y qué no, y su matrícula (o «sin matrícula») → pide el código de 2FA → badge «Co-titular». A una Secretaria o a
  un Administrador/a no se le ofrece.
- [ ] El co-titular entra: ve Configuración como el Titular (equipo, servicios, sedes, «Sitio web», export de datos) y
  todo el consultorio en agenda, pacientes e Inicio. **No** ve «Plan y uso» ni «Facturación», no puede delegar «Planes y
  pagos», no recibe los mails de cobro de la plataforma y donde un módulo falta lee «Pedile al titular…».
- [ ] Sobre el principal: no puede cambiarle el rol, los permisos ni suspenderlo (fila bloqueada con el motivo), no
  transfiere la titularidad, no da ni saca «Co-titular» (tampoco a sí mismo). Puede delegar «Configuración» a los demás.
- [ ] Reparto: una regla donde destina el principal no la puede crear ni cerrar (rechazo con copy); las demás sí.
- [ ] Quitar «Co-titular» → vuelve a Profesional con lo que tenía; «Planes y pagos» no reaparece. Cambiarle el rol a un
  co-titular (lo hace solo el principal) le saca la marca sin error.
- [ ] Con el consultorio suspendido, el co-titular también ve «Descargar el export de mis datos» en `/suspendido`.

### Matrícula
- [ ] «Mi agenda» → «Matrícula»: «Sin matrícula» esconde los campos; MN pide número; MP pide número y provincia. Un
  número con símbolos raros → error en el campo. Guardar → toast; vaciar → la borra.
- [ ] `/cuenta/seguridad` → actividad: «Cambiaste tu matrícula» / «Borraste tu matrícula». No aparece en la sede ni en
  el turnero.

### Foto
- [ ] «Mi agenda» → «Tu foto»: subir una foto de teléfono grande → se reduce y se ve en el avatar de la barra superior,
  la barra móvil y el menú de cuenta. Un PNG con fondo transparente queda recortado sobre blanco. Un PDF o un archivo
  renombrado → mensaje claro.
- [ ] El switch «Mostrar mi foto en el turnero y en el sitio del consultorio» está deshabilitado sin foto. Prendido →
  en el turnero (elegir profesional) y en las tarjetas de la sede sale la foto en el marco blanco con la sombra en el
  color del consultorio y el logo chico abajo a la derecha. Apagado → iniciales en el mismo marco.
- [ ] Apagar el switch o borrar la foto: a lo sumo en un día deja de verse en una URL ya abierta; una página recargada
  ya no la pide. Con foto en dos consultorios, el switch es por consultorio.
- [ ] `/cuenta/seguridad` → actividad: «Cambiaste tu foto» / «Borraste tu foto». Una foto con GPS en el EXIF: la descargada desde
  `/api/public/pro-photo/…` no lo trae.

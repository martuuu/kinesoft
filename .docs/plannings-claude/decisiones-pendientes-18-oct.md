# Decisiones con default para firmar (18-oct)

> **Actualizado 18-oct (noche):** decididas #59 (marca: logo A) y #60 («Mantenerme conectado», ya implementado en la tanda B). El resto sigue con su default.

**65 entradas** (algunas agrupan varias decisiones chicas del mismo tema). **Ninguna bloquea las tandas A y B; mientras no firmes, rige el default.**

Cómo leerlo: «Hoy» = el default que rige o va a regir. «Para» = la tanda que lo usa (A, B, T3 = AS/M12, T4 = FC/M14,
T5 = TP/M18, T6 = WA + MPS, T7 = TV) o «ya rige» (está en el código, solo confirmar). Para firmar alcanza con
«OK #n» o «#n → alternativa».

Quedan **afuera** porque ya las decidiste: EV2-D1..D12, D-VX1..D-VX12, MPS-D4/D7 (proporcional al primer cargo, cobro
el 4), D-HF1, TP-D2, TP-D5/D6, TV-D1 (§22.1 #3), ADR-016 (bajada/subida de plan), MP por profesional (§22.1 #5,
cierra `turnero-mp-cuenta-plataforma`), 2FA de Plataforma apagada (supera BO-D6 y BO-Z B3), OPS-D5 (E2E no bloqueante
2 semanas, orden §22.13), PL-D20 y la delegación del Titular.

---

## 1. Agenda y Recepción

| # | ID | Hoy (default) | Alternativa | Recomiendo | Para |
|---|---|---|---|---|---|
| 1 | RX-D2 cara de `/sala` | Tablero para todos (`lib/preferences-constants.ts:389`) | «Lista y panel» para quien tiene `agenda.operateAll` (Secretaria, Admin) | Pasar a Lista y panel para operateAll: es la vista densa que pide la Secretaria; es una línea | B (AS-0 toca Recepción) |
| 2 | RX-D1, D3, D5, D6, D7, D8, D9, D10 | `/sala` con 3 caras; «Nuevo turno» navega a `/agenda?new=1`; TV fuera; Apariencia minimizada; **sin riel navy (D7)**, se usa el sidebar; nav «Sala de espera»; franja solo con profesionales con turnos hoy; sin flag «1.ª vez» | Riel navy del prototipo; drawer «primer hueco libre» | Confirmar en bloque. El drawer «primer hueco» conviene meterlo en AS | ya rige |
| 3 | D-HF2 diagnóstico realtime | Huella del secreto + «Probar desde el servidor» en Sistema | Solo log en Vercel | Así: te ahorra abrir consolas | A |
| 4 | D-HF3 sin driver realtime | Polling cada 60 s con la pestaña visible | 30 s (más carga) | Así | A |
| 5 | D-HF4/D5 latido «Llegó» | «Espera larga» desde 15 min; tope de 12 puntos animados | 10 o 20 min | Así; ajustar después de verlo con la Secretaria | A |
| 6 | D-LL1 estilo del latido | Punto lima en la esquina; «Borde que late» como opción en Apariencia | Borde por defecto | Así (el borde compite con el color de estado) | A |
| 7 | D-HF6 drawer del turno | Llegó, En atención y Deshacer en el drawer; la acción rápida sobre la tarjeta va a AS | Acción rápida ya en A | Así | A |
| 8 | AS-D5 tope por hora | Por profesional con default del consultorio; hora AR del inicio; todos los servicios; el staff lo puede forzar, el turnero no | Solo por consultorio | Así | T3 |
| 9 | «Cancelar turno» | Con confirmación (`components/agenda/booking-drawer/index.tsx:417-423`); antes era 1 click | 1 click + «Deshacer» en el toast | Así | ya rige |
| 10 | Legado B-pre | Las 14 decisiones del dev senior (bloqueo blando para staff y duro en turnero, fuera de horario solo avisa, mensual = mismo día ajustado, sin feriados automáticos, etc., ROADMAP «Decisiones para Martin»); `patientCondition` fuera del drawer; zoom: manda el del usuario, el del consultorio es default (C1) | Revisar una por una | Confirmar en bloque; feriados automáticos al backlog C | ya rige |

## 2. Historia clínica / Evoluciones

| # | ID | Hoy (default) | Alternativa | Recomiendo | Para |
|---|---|---|---|---|---|
| 11 | **EV2-D19** nombres en Seguimiento | «Registrar sesión» = meta de sesión (notas, RPE, EVA); «Cargar evolución» = evolución de HC | Volver a un solo «Cargar evolución» | Así: dos acciones distintas con el mismo nombre confundían | T4 (FC renombra la pestaña a «Historia clínica») |
| 12 | EV2-D18 + EV2-Z A2 | «Sin evolución» y reabrir sesión miran la evolución viva del turno; una evolución de HC **no** bloquea «Registrar sesión»; «Deshacer Atendido» no reabre la sesión | Bloquear «Registrar sesión» si ya hay evolución | Así | ya rige |
| 13 | EV2-D13 | Turno ausente (NO_SHOW) no admite evolución, igual que cancelado | Permitir nota en ausente («no vino, llamé») | Así; la nota suelta sin turno cubre ese caso | ya rige |
| 14 | EV2-D14 enmienda | Cualquier profesional con escritura sobre el paciente, sin límite de tiempo | Solo el autor | Así (equipo que comparte paciente) | ya rige |
| 15 | EV2-D15 anular | El autor o el Titular clínico (nunca el Admin), motivo 3..500 | Solo el autor | Así | ya rige |
| 16 | EV2-D16, D17, D20..D24 + EV2-Z | Auditoría sin texto clínico; la base frena edición a 24 h + 10 min; pestaña «EVA» + «Evoluciones»; no se cambia el paciente de un turno con evolución; export con evoluciones; anulada colapsada y bloquea borrar el turno; fecha = hora del turno; toast solo en turnos propios; «Sesión registrada»; impresión corta en las 2000 más recientes | — | Confirmar en bloque | ya rige |
| 17 | a6 paciente ajeno | El kine que atiende un paciente de otro sin share ve el toast «Cargar evolución» pero al guardar falla (cerrado, correcto) | (a) share automático al atender; (b) esconder el toast sin permiso | (b) ya, chico; (a) con la visibilidad por registro de C0 | T3 o T4 |
| 18 | Título de la pestaña del perfil | «Paciente · KineSoft» sin nombre (`app/(app)/pacientes/[id]/page.tsx:21`): vuelve el esqueleto y no queda el nombre en el historial de PCs compartidas | Nombre del paciente (+1 tx, TTFB peor) | Así | ya rige |
| 19 | Export del consultorio | Saca `authorUserId` (id de Auth) fuera de `team` (EV2-1b); incluye `team.userId` opaco para mapear la auditoría (BO5-C) | Sin ids | Así: sin ids no se reconstruye quién hizo qué | ya rige |

## 3. Fichas clínicas (T4)

| # | ID | Hoy (default) | Alternativa | Recomiendo | Para |
|---|---|---|---|---|---|
| 20 | **FC-D17** fuente de la CIE-10 | A verificar: OPS/OMS o tablas del DEIS (MSal) | CIE-11 (CC BY-ND) | DEIS/MSal si la licencia permite redistribuir; hasta tenerla: propios + kine + texto libre | T4 (bloquea solo la carga completa) |
| 21 | FC-D6 PDF guardado | Solo se guarda al compartir; la descarga se genera al vuelo | Guardar siempre | Así (menos storage, una sola verdad) | T4 |
| 22 | FC-D8 quién comparte | Cualquier profesional con escritura sobre el paciente | Solo el autor | Así | T4 |
| 23 | FC-D10/D11 importar Word | En el navegador; la persona confirma la fecha del archivo; autor = quien importa; «carga tardía» visible | Importar en el server | Así | T4 |

## 4. Secretaria y permisos

| # | ID | Hoy (default) | Alternativa | Recomiendo | Para |
|---|---|---|---|---|---|
| 24 | **AS-D2 quién marca cobros** (junta `plf-toggle-billing-sin-cap`, RX-D4 y «`billing.manage` no está en PRACTITIONER») | Hoy un profesional con acceso full marca **cualquier** cobro como pagado: `toggleBilling` solo mira `hasFullAccess` (`lib/bookings.ts:1717`, chequeo en `:1752`), sin `billing.manage`. RX «Cobrar» pide `billing.manage` y no tiene medio de pago | Default propuesto: copago lo marcan Titular, Admin, Secretaria, Facturación y el profesional **solo en sus turnos**; obra social con `billing.manage` | El propuesto. Es plata y está abierto (alta) | T3 (`lib/bookings.ts` serial) |
| 25 | `secretaria-edita-contacto-cobertura` | La Secretaria (perfil `admin`) ve contacto y cobertura pero no los edita (`lib/patients.ts`, `updatePatient`) | Que edite contacto y cobertura | Que edite: es su trabajo diario en la recepción | T3 |
| 26 | `billing-aprueba-cobertura` | Facturación aprueba pedidos de cobertura del portal (`lib/patient-portal-requests.ts:64`, `canDecide` = admin o full) aunque no edita cobertura a mano | Restringir a Secretaria, Titular y Admin | Restringir (coherente con #25) | T3 |
| 27 | `plf-terminar-acceso-soporte` | El consultorio no puede cortar un acceso de soporte abierto (termina cuando soporte sale) | Action para `tenant.admin` que llame a `closeOpenSessionsInTx` (`lib/support-session-internal.ts:229`) | Hacer la action | B o T3 |
| 28 | **a3#12** ADMIN que M8b convierte | Un ADMIN con agenda pasa a PRACTITIONER + Configuración y pierde cobros, operar turnos de otros, bloqueos y ver todos los pacientes | Revisar caso por caso con el precheck (b) del RUNBOOK «M8b en prod»; darle los permisos que falten | Correr el precheck y decidir con nombres concretos | **antes de migrar M8b en prod** |
| 29 | IAM/BO/PL ya aplicadas | IAM-D1 (activar invitación crea el usuario confirmado), D3 (equipo lo gestionan Titular y Admin), D4 (un miembro crea su propio consultorio), D5 (portal Google + magic link); IAM-3 (el consultorio activo lo decide la cookie, no la preferencia guardada); BO-Z A2 (soporte solo invita Secretaria/Facturación); PL-D5 (los ADMIN existentes conservan Configuración) | — | Confirmar en bloque | ya rige |

## 5. Turnero y cobros

| # | ID | Hoy (default) | Alternativa | Recomiendo | Para |
|---|---|---|---|---|---|
| 30 | TP-D1 | Cobro online del turnero apagado (`TURNERO_CHECKOUT` vacío) hasta TP-2 | Dejarlo como está hoy (cuenta MP de la plataforma) | Apagado | A |
| 31 | TP-D3 ventana | 5 días con turnos, búsqueda de 6 semanas, tope de 90 días | 7 días visibles | Así | A (TP-1) |
| 32 | AS-D9 paso del turnero | `clamp(ceil15(duración), 15, 60)`; hoy fijo 45 (`lib/availability/types.ts:74`) | Paso fijo configurable | Así: un servicio de 30 min hoy ofrece huecos cada 45 | T3 |
| 33 | TP-D7 seña | Pagar la seña no marca el copago como cobrado | Descontar la seña del copago | Así en v1 | T5 |
| 34 | TP-D8/D9 sin cuenta MP | Se reserva sin cobro + aviso; cuenta MP del consultorio opcional | Exigir cuenta para activar cobro | Así | T5 |
| 35 | TP-D10/D11 conexión | OAuth de MP; comisión de la plataforma 0 | Comisión % | 0 al principio | T5 |
| 36 | TP-D12/D13 links de cobro | Requieren delegación del profesional (también el Titular); vencen a los 7 días (máx. 30); $1 a $1.000.000 | — | Así | T5 |
| 37 | TP-D14/D15/D16 reglas | Sin cancelación online (reintegros desde MP); cobro obligatorio con `binary_mode` y sin efectivo; «Pagar ahora» opcional confirma igual | Cancelación con reintegro automático | Así en v1 | T5 |

## 6. Portal del paciente

| # | ID | Hoy (default) | Alternativa | Recomiendo | Para |
|---|---|---|---|---|---|
| 38 | ES4-D1..D12 + varios | «Buscar mis fichas» 5/h; ficha archivada no ve el portal; plan = el vinculado activo más reciente; media propia solo YouTube; cuenta 12 meses + futuros (máx. 50); **vincular con consultorio suspendido sí vincula** (solo lecturas); archivar desvincula; REFUNDED no reabre deuda; aviso de «Mis datos» también a la Secretaria; ICS dice «n/N» y el resto «Sesión n de N» | Cualquiera es una línea | Confirmar en bloque; unificar el ICS a «Sesión n de N» | ya rige |

## 7. Suscripción

| # | ID | Hoy (default) | Alternativa | Recomiendo | Para |
|---|---|---|---|---|---|
| 39 | PL-D6/D7 bajar de plan | «Llegó»/«En atención» en todos los planes (decidido); las salas «duermen» (no se borran) | Borrar salas | Así | T6 |
| 40 | PL-D8/D10 precios y prueba | Precios con vigencia y aviso; la prueba de 14 días se conserva al cambiar de plan durante la prueba | Reiniciar la prueba | Así | T6 |
| 41 | PL-D11/D12 2FA | Step-up válido 10 min en acciones sensibles; recuperación: 10 códigos + email + reset por superadmin | 5 min | Así | ya rige |
| 42 | PL-D13/D14/D15 | Se auditan descargas de adjuntos y escrituras clínicas; el lead de la landing no recibe respuesta automática | Respuesta automática al lead | Así hasta tener Resend con dominio | ya rige |
| 43 | PL-D16/D18/D19/D22/D23 | `SAAS_BILLING_MODE=off`; precios en NULL («Consultá») hasta que los cargues; un solo cron diario; comprobantes PDF/JPG/PNG/WEBP ≤ 4 MB; pausa de débito reanudable | — | Así; cargar los precios antes de prender cobro | T6 |
| 44 | B3 alta sin atender | Quien contesta «No atiendo» arranca en prueba **Consultorio** (no Individual) y la conserva si después se marca clínico | Re-evaluar el plan al marcarse clínico | Así (es una prueba y se ve en Plataforma) | ya rige |
| 45 | `SIGNUP_MODE` (BO-D11 / BO-Z B4) | `open` (alta web abierta) | `assisted` (solo desde Plataforma) | `open` mientras sea demo; pasar a `assisted` si aparecen altas basura | ya rige |
| 46 | Vencimiento (BO-D2/D3/D4) | `TENANT_ACCESS_ENFORCEMENT=banner` (avisa, no bloquea); gracia 7 días (prueba) y 10 (impago), después solo lectura; suspendido puede exportar | `enforce` ya | `banner` hasta que el cobro esté prendido | T6 |

## 8. Directorio (apagado por defecto)

| # | ID | Hoy (default) | Alternativa | Recomiendo | Para |
|---|---|---|---|---|---|
| 47 | DIR-D1..D10 | Consentimiento por persona; `DIRECTORY_MODE`; provincia/ciudad sin geocodificar; iniciales (sin foto); sin precios ni rating; caché 10 min; orden alfabético; opt-in no editable por soporte; «verificada» solo tras verificación de Plataforma | Avatar de Google (v1.1) | Confirmar en bloque | antes de prender `DIRECTORY_MODE` |
| 48 | Qué se muestra | Sin foto, sin ningún email, zona desde las sedes; `preview` por link con noindex; el motivo de moderación no queda en la auditoría; «desverificar matrícula» agregado | Mostrar email del consultorio | Así (cero PII extra) | antes de prender |
| 49 | Consentimiento | Editar un perfil publicado no revoca el consentimiento; un usuario deshabilitado sale solo del directorio | Re-pedir consentimiento al editar | Así | antes de prender |
| 50 | Técnicas | Landing y fichas `force-static` (ISR 1 h); 404 raíz dinámico (lee la sesión para el CTA); alias de consultorio viejo redirige **sin** la query; CHECKs de M11 con COALESCE | 404 estático sin CTA por sesión | Así | ya rige |

## 9. Mobile / PWA

| # | ID | Hoy (default) | Alternativa | Recomiendo | Para |
|---|---|---|---|---|---|
| 51 | Barra inferior y PWA | Barra fija (Inicio, Agenda, Sala, Pacientes + Más), sin push ni badges; SW solo en workspace y Plataforma; interruptor `NEXT_PUBLIC_PWA=off`; no promocionar «Instalar» hasta mudar el dominio | Barra flotante / que se oculta; badges | Así; promocionar «Instalar» después del rename (OPS-4) | B |
| 52 | Total en la Sala (celular) | Total junto al chevron del pliegue además del badge de «esperando» | Total solo para lectores de pantalla (aria) | Solo aria: dos números juntos se leen mal | B (AS-3 pulido mobile) |
| 53 | Encabezado del escritorio | «Jueves, 15 de octubre» con mayúscula inicial | Minúscula | Así | ya rige |

## 10. WhatsApp (T6)

| # | ID | Hoy (default) | Alternativa | Recomiendo | Para |
|---|---|---|---|---|---|
| 54 | WA-D1 número | Número nuevo, o coexistencia con la app WhatsApp Business si Meta la habilita en AR | Solo número nuevo | Así | T6 |
| 55 | WA-D3 consentimiento | Opt-in explícito por paciente; sin consentimiento solo el link `wa.me` manual | Opt-out | Opt-in (datos de salud) | T6 |
| 56 | WA-D7 «No puedo ir» | Avisa al consultorio; no cancela solo | Cancelar automático | Así (la Secretaria reubica) | T6 |

## 11. TV de la sala (T7)

| # | ID | Hoy (default) | Alternativa | Recomiendo | Para |
|---|---|---|---|---|---|
| 57 | TV-D2/D3 | Layout SIDE (video al costado de los llamados); video muteado, baja al llamar (DUCK) | Pantalla completa con overlay | Así | T7 |
| 58 | TV-D4 cuándo | Después de AS-0; antes solo si hay un cliente Clínica esperando | Adelantar | Así | T7 |

## 12. Operación

| # | ID | Hoy (default) | Alternativa | Recomiendo | Para |
|---|---|---|---|---|---|
| 59 | **OPS-D4 marca visible** | ✅ **Decidido por Martin (18-oct): «Consultorio Online», logo A (Sello C).** Sobre fondos azules puede ir solo la C con el punto; en marketing se juega con los 3 colores (C, punto, blanco y verde) | — | — | B (OPS-4, renombrado) |
| 60 | «Mantenerme conectado» | Tildado = sesión persistente; destildado = cookie que muere al cerrar el navegador (hoy no existe, `components/screens/login-screen.tsx:26`) | Destildado por defecto | Así (PCs dedicadas de recepción); destildado en PCs compartidas lo elige cada uno | B |
| 61 | D-HF7 bypass de tu 2FA | 14 días (tope 30), solo tu id, nunca con `enforce` | Sin bypass | Así; cargás `SUPERADMIN_2FA_BYPASS` con tu id y la fecha | A (HF-3) |
| 62 | Bundle de SR y SV | +3,7 kB en `/configuracion` y +4,5 kB en todas las rutas, aceptados | Sesión de toast diferido | Aceptar (PF ya dejó todo ≤ 180 kB) | ya rige |
| 63 | D-VX13..D31 + D-PF1..D5 | Inputs 44/48 px; OAuth apagado no se muestra; landing ISR; `BRAND_NAME` sin rename; presupuestos de bundle; sin RUM ni analizador como dependencia; write-paths de turnos a C | — | Confirmar en bloque | ya rige |
| 64 | `cn()` sin tailwind-merge | `lib/cn.ts` sin `twMerge` (−6 kB); el paquete sigue en `package.json:45` | Volver a `twMerge` | Así; sacarlo del `package.json` en OPS-1 (pide `npm install`) | B |
| 65 | Seguridad ya aplicada | El signup sobre una cuenta sin confirmar **no** pisa la contraseña (anti pre-account takeover); el mail «soporte entró» al Titular va con motivo genérico | Pisar contraseña (más simple para el usuario) | Así | ya rige |

---

## Las 5 que conviene mirar primero

1. **#24 Quién marca cobros (AS-D2).** Es plata y hoy está abierto: cualquier profesional con acceso full marca como
   pagado el copago o la obra social de cualquier turno (`lib/bookings.ts:1717`). Define T3 y toca `lib/bookings.ts`, que es serial.
2. **#28 ADMIN que M8b convierte (a3#12).** Hay que decidirlo antes de migrar M8b en prod: si no, un Admin real con agenda
   pierde cobros y ver todos los pacientes el día del deploy.
3. **#3-#7 defaults de la tanda A (latido, drawer, polling).** Se están construyendo ahora: cambiarlos antes cuesta nada,
   después es otra vuelta de QA con la Secretaria.
4. **#59 Marca (OPS-D4) + #60 «Mantenerme conectado».** Los dos entran en la tanda B, y el rename toca copy, mails,
   metadata y OG de toda la app. Conviene elegir en el prototipo de logo.
5. **#20 Fuente de la CIE-10 (FC-D17).** Es la única que pide averiguar afuera (licencia OPS/DEIS). Si se arranca
   ahora, llega resuelta a T4.

De paso, en un minuto: **#1 (RX-D2, Lista y panel para la Secretaria)** y **#11 (EV2-D19, nombres en Seguimiento)**
son cambios de una línea que conviene fijar antes de que T4 renombre la pestaña de HC.

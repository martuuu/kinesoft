# Manual de Ingeniería y Auditoría de Software

> Destilado de la auditoría de dos productos multi-tenant reales en producción (2026): patrones
> que funcionaron, clases de bug que se repitieron entre stacks distintos, y el proceso que evita
> que ambas cosas se pierdan. Para auditar un proyecto nuevo de punta a punta.

## Índice

- [Parte 0 — Cómo usar este manual](#parte-0-cómo-usar-este-manual)
  - [0.1 Qué es / qué no es](#01-qué-es-qué-no-es)
  - [0.2 Las 6 etapas del proceso de auditoría (E1-E6)](#02-las-6-etapas-del-proceso-de-auditoría-e1-e6)
  - [0.3 Reglas del auditor](#03-reglas-del-auditor)
- [Parte 1 — Baseline: checklist auditable por área](#parte-1-baseline-checklist-auditable-por-área)
  - [1.1 Arquitectura y estructura](#11-arquitectura-y-estructura)
  - [1.2 Multi-tenancy y seguridad](#12-multi-tenancy-y-seguridad)
  - [1.3 Integridad de datos y concurrencia](#13-integridad-de-datos-y-concurrencia)
  - [1.4 Fechas y timezones](#14-fechas-y-timezones)
  - [1.5 Runtime (framework de UI y equivalentes)](#15-runtime-framework-de-ui-y-equivalentes)
  - [1.6 Plataforma de datos (motor de datos relacional/RLS/Realtime/migraciones)](#16-plataforma-de-datos-motor-de-datos-relacionalrlsrealtimemigraciones)
  - [1.7 UX/UI](#17-uxui)
  - [1.8 Testing y verificación](#18-testing-y-verificación)
  - [1.9 Observabilidad y operación](#19-observabilidad-y-operación)
  - [1.10 Proceso y documentación](#110-proceso-y-documentación)
- [Parte 2 — Catálogo de clases de bug con detección](#parte-2-catálogo-de-clases-de-bug-con-detección)
  - [2.1 Seguridad / RLS / Autorización](#21-seguridad-rls-autorización)
  - [2.2 Integridad de datos y concurrencia](#22-integridad-de-datos-y-concurrencia)
  - [2.3 Plataforma de datos](#23-plataforma-de-datos)
  - [2.4 Runtime (framework y librerías de UI)](#24-runtime-framework-y-librerías-de-ui)
  - [2.5 UX / producto](#25-ux-producto)
  - [2.6 Testing (clases de bug del testing)](#26-testing-clases-de-bug-del-testing)
- [Parte 3 — Plantillas de ejecución](#parte-3-plantillas-de-ejecución)
  - [3.1 Esqueleto de plan de hardening por fases (F0-F10 + bloque post-hardening)](#31-esqueleto-de-plan-de-hardening-por-fases-f0-f10-bloque-post-hardening)
  - [3.2 Buckets A-E + formato de finding individual](#32-buckets-a-e-formato-de-finding-individual)
  - [3.3 Plan por olas (ownership disjunto)](#33-plan-por-olas-ownership-disjunto)
  - [3.4 Checklist de corte a producción](#34-checklist-de-corte-a-producción)
  - [3.5 Spec del doc "configuración externa" (servicios que configura el dueño)](#35-spec-del-doc-configuración-externa-servicios-que-configura-el-dueño)
- [Parte 4 — Estándar de testing](#parte-4-estándar-de-testing)
  - [4.1 La pirámide de 4 capas](#41-la-pirámide-de-4-capas)
  - [4.2 Extracción de lógica pura (la precondición de todo lo demás)](#42-extracción-de-lógica-pura-la-precondición-de-todo-lo-demás)
  - [4.3 Fábrica de tenant/entorno efímero](#43-fábrica-de-tenantentorno-efímero)
  - [4.4 Guards estáticos de seguridad en CI](#44-guards-estáticos-de-seguridad-en-ci)
  - [4.5 Coverage con umbral ratchet](#45-coverage-con-umbral-ratchet)
  - [4.6 Impersonación de actores en tests de integración](#46-impersonación-de-actores-en-tests-de-integración)
  - [4.7 Qué NO testear (y por qué)](#47-qué-no-testear-y-por-qué)
  - [4.8 Forma de un pipeline de CI](#48-forma-de-un-pipeline-de-ci)
  - [4.9 Protecciones anti-false-green](#49-protecciones-anti-false-green)
- [Parte 5 — Meta-modelo de documentación](#parte-5-meta-modelo-de-documentación)
  - [El set de documentos recomendado](#el-set-de-documentos-recomendado)
  - [Catalogar por CLASE, no por instancia](#catalogar-por-clase-no-por-instancia)
  - [Checklist de severidad como fuente de verdad](#checklist-de-severidad-como-fuente-de-verdad)
  - [Diferido-con-gates](#diferido-con-gates)
  - [Inventario de "preservar"](#inventario-de-preservar)
  - [Nombrar la causa raíz arquitectónica](#nombrar-la-causa-raíz-arquitectónica)
- [Parte 6 — Patrones de proceso y orquestación](#parte-6-patrones-de-proceso-y-orquestación)
  - [Olas disjuntas](#olas-disjuntas)
  - [Foundation-first](#foundation-first)
  - [Revisión adversarial](#revisión-adversarial)
  - [Schemas de salida planos](#schemas-de-salida-planos)
  - [Patrón "listo-para-activar"](#patrón-listo-para-activar)
  - [Paridad de entorno local](#paridad-de-entorno-local)
  - [Disciplina de control de versiones](#disciplina-de-control-de-versiones)
- [Apéndice A — Índice de detección rápida](#apéndice-a-índice-de-detección-rápida)

## Parte 0 — Cómo usar este manual

### 0.1 Qué es / qué no es

Este manual es la destilación de un proceso de auditoría aplicado más de una vez, sobre productos
con stacks completamente distintos entre sí. No es un documento de arquitectura de referencia ni
un starter kit: es un **catálogo + checklist + proceso**, pensado para copiarse tal cual a un
proyecto nuevo y ejecutarse de punta a punta sin adaptación previa.

**Qué es:**

- Un **baseline auditable por área** (Parte 1): la línea de base contra la que se contrasta el
  código real, independiente del stack.
- Un **catálogo de clases de bug** con detección reproducible, grep-first (Parte 2): cada entrada
  describe una clase (síntoma → causa → detección → fix canónico → regla), no un fix puntual.
- Un **estándar de testing** (Parte 4) que define qué pirámide de tests protege realmente contra
  esas clases.
- Un **meta-modelo de documentación** (Parte 5): el set de documentos que un producto necesita para
  que lo aprendido en la auditoría no se pierda apenas termina.
- Un **proceso de principio a fin** en 6 etapas (0.2) más las plantillas para ejecutarlo (Parte 3)
  y los patrones de orquestación para correrlo con varios ejecutores en paralelo (Parte 6).

**Qué NO es:**

- No es una plantilla de código ni un boilerplate de arquitectura. No prescribe un framework, un
  motor de datos ni un proveedor de infraestructura.
- No reemplaza el criterio del auditor: las clases del catálogo son candidatas a verificar, no
  veredictos automáticos (ver regla en 0.3).
- No es un documento legal ni sustituye una revisión de compliance — señala DÓNDE conviene una
  revisión de ese tipo (bucket D, Parte 3.2), no reemplaza a quien la hace.
- No asume que el proyecto auditado hizo algo mal: gran parte del valor de una auditoría es
  confirmar y proteger lo que ya está bien hecho (ver inventario de "preservar", Parte 5).

**Por qué las clases de bug son portables entre stacks distintos.** El principio que sostiene todo
el manual es que las clases de bug NO son específicas de un stack. Una escritura concurrente sin
control de bloqueo corrompe un contador de la misma manera exista o no un ORM de por medio; un
off-by-one de zona horaria en una fecha de negocio aparece exista o no una plataforma de BaaS
detrás; un filtro de UI con un enum incompleto esconde registros exista o no un framework con
Server Components. Por eso cada entrada del catálogo (Parte 2) está redactada para reconocerse en
cualquier stack, no solo en el/los stack(s) donde se descubrió originalmente. Este mismo principio
es, de hecho, el motor de origen del manual: se construye auditando un producto usando el
baseline+catálogo de un producto hermano, etiquetando cada hallazgo nuevo con la clase de la que es
instancia, y devolviendo al catálogo compartido las clases genuinamente nuevas que aparecen. Es un
proceso bidireccional — cada vez que este manual se aplica a un proyecto nuevo, debería volver más
rico de lo que era, no solo "aplicado".

**Cómo recorrerlo:** leer esta Parte 0 una vez de punta a punta antes de tocar código. Después, las
etapas E1-E6 (0.2) son el hilo conductor: E1-E2 se apoyan en las Partes 1 y 2 como checklist; E3-E4
se resuelven con las plantillas de la Parte 3; E5 se ejecuta con los patrones de orquestación de la
Parte 6 si hay más de un ejecutor trabajando en paralelo; E6 produce el documento descrito en 3.5.
La Parte 4 se teje transversalmente (todo fix relevante debería dejar detrás una prueba). La Parte 5
se instala al final como el sistema que hace que la auditoría siga rindiendo después de cerrada.

### 0.2 Las 6 etapas del proceso de auditoría (E1-E6)

**E1 — Auditoría documental.** Leer TODOS los documentos existentes del proyecto (roadmap,
tracker de diferidos, checklist de seguridad, convenciones, notas de arquitectura) y contrastarlos
contra el código real, no al revés. El código es el árbitro (ver regla en 0.3): si un documento dice
"pendiente" y el código ya lo implementa, el documento está desactualizado, no el código. La salida
de esta etapa es un inventario explícito de contradicciones doc-vs-código, que casi siempre revela
por dónde arrancó a divergir el proyecto de su propia documentación.

**E2 — Sweep de findings verificado en código.** Recorrer el catálogo de clases de bug (Partes 1 y
2 de este manual) contra el código real, clase por clase, con una búsqueda reproducible (grep u
otra señal equivalente) seguida SIEMPRE de la lectura del hit antes de reportarlo: un hit de
búsqueda es una pista, nunca un veredicto por sí solo. La salida es una lista de findings con
severidad explícita y ubicación exacta (archivo y línea, o superficie/flujo si no aplica a una línea
puntual). El Apéndice A al final de este documento consolida todas las recetas `[grep]` del
catálogo en una sola tabla — correrlas todas de punta a punta es el sweep de una tarde; las
entradas marcadas `[señal]`/`[pregunta]` en la Parte 2 necesitan lectura manual en vez de un comando
ejecutable.

**E3 — Clasificación en 5 buckets.** Todo finding y todo pendiente detectado en E1-E2 se clasifica
en uno de cinco buckets según quién puede resolverlo y con qué tipo de decisión (detalle completo y
formato de finding en 3.2):

- **A — Código:** fixes/features que un ejecutor puede aplicar directo sobre el repo, sin decisión
  de alcance pendiente.
- **B — Hardening/Seguridad:** endurecimiento que sí requiere una decisión de alcance (rate-limit
  real vs. nativo del proveedor, 2FA, rotación de secretos, backups/DR).
- **C — Externo/Infra:** acciones que dependen de un servicio de terceros que solo el dueño del
  proyecto puede configurar (DNS, proveedor de hosting, email transaccional, analítica, monitoreo
  de errores).
- **D — Externo/Legal:** validaciones que dependen de un asesor legal o de una decisión de negocio
  no técnica.
- **E — Marca:** assets visuales/de marca pendientes (favicon, fotografía real, logos de
  certificación, etc.).

**E4 — Ronda de decisión con el dueño del proyecto.** Presentar el inventario ya clasificado junto
a una tabla de decisión: qué se avanza YA (y con qué alcance), qué se deja libre pero con un
switch/flag ya preparado para activarlo después, qué se difiere explícitamente con su gate de
desbloqueo, y qué cambia de alcance por una decisión de producto. Esta ronda es la que convierte un
inventario de posibilidades en un plan con autoridad para ejecutarse — sin ella, el plan de fases de
E5 no tiene mandato para arrancar.

**E5 — Plan de ejecución por olas + definición de corte a producción.** Traducir las decisiones de
E4 en olas de trabajo con ownership de archivo disjunto entre ejecutores paralelos (ver Parte 6).
Definir explícitamente las condiciones que marcan el "corte a producción" — un checklist de
iría/no-iría con una tabla de dependencias entre ítems (ver 3.4).

**E6 — Documento de configuración externa.** Producir un documento único que enumera los servicios
externos que el dueño del proyecto debe configurar de su lado (hosting, DNS, proveedor de base de
datos gestionada, email transaccional con su verificación de dominio, monitoreo de errores,
analítica, rate-limiting gestionado, identidad/OTP si aplica, legal, marca — spec completa en 3.5).
El objetivo de separar esto en su propio documento es que la auditoría técnica y la configuración
externa no se mezclen ni se pierdan entre sí: cada una tiene su propio dueño y su propio ritmo.

### 0.3 Reglas del auditor

- **El código manda.** Ante un conflicto entre lo que dice un documento y lo que hace el código, el
  código gana; el documento se corrige, nunca al revés.
- **Inventario de "preservar" antes de tocar nada.** Listar explícitamente los patrones CORRECTOS ya
  presentes en el proyecto para que el hardening posterior no los regrese sin querer (desarrollo
  completo del inventario en Parte 5).
- **Distinto no es lo mismo que incorrecto.** Un patrón que difiere del baseline no es
  automáticamente un bug: hay que entender el porqué de la diferencia antes de "corregirla". Puede
  ser una decisión deliberada del proyecto auditado que el baseline no contempla.
- **Severidad explícita, no impresión subjetiva.** Todo finding lleva una etiqueta verificable
  (crítica/alta/media/baja), justificada por su impacto real, no por cuánto "llama la atención".
- **Nombrar la causa raíz, no solo el síntoma.** El hallazgo más valioso de una auditoría suele ser
  arquitectónico — por ejemplo, que conviven dos implementaciones distintas del mismo flujo y solo
  una de ellas es la que realmente corre en producción — y no una lista de bugs sueltos. Nombrarlo
  explícitamente es lo que orienta todo el plan de fases (ver 3.1 y Parte 5).
- **Todo lo diferido tiene un gate.** Nunca se difiere algo "verbalmente" o por omisión: todo ítem
  que no se ejecuta ahora queda registrado con su contexto y su condición de desbloqueo explícita
  (ver "diferido-con-gates" en Parte 5).

## Parte 1 — Baseline: checklist auditable por área

> Cómo leer esta parte: cada ítem es una afirmación auditable, no una aspiración. Un auditor debe
> poder marcarlo ✅ / ⚠️ / ❌ / N-A mirando código o config concreta, no la intención declarada del
> equipo. El link `→ C-XXX-NN` (cuando existe) apunta a la clase de bug correspondiente en la
> Parte 2, con síntoma/causa/fix/detección; cuando un principio no tiene una clase de bug asociada
> se deja sin link — no es un hueco, es señal de que ese principio se audita por inspección, no por
> patrón de detección.

## 1.1 Arquitectura y estructura

- **Las acciones de servidor son un shell fino.** *Por qué:* la lógica de negocio debe poder
  testearse y reusarse sin depender del framework que la invoca. *Qué mirar:* archivos de
  acciones/handlers que hacen algo más que autenticar, autorizar, hacer I/O y delegar.
- **La capa de servicios es pura y portable.** *Por qué:* un módulo sin imports de framework ni de
  I/O se puede mover de proyecto o de runtime sin reescritura. *Qué mirar:* funciones de dominio
  que importan el cliente de datos o helpers específicos del framework en vez de recibirlos como
  argumento.
- **Una sola aplicación con superficies gateadas por rol, nunca sitios paralelos.** *Por qué:* dos
  bases de código para el mismo dominio duplican el mismo bug y solo uno se corrige. *Qué mirar:*
  más de un deploy/repo sirviendo la misma lógica de negocio para roles distintos.
- **Un solo design system con tokens compartidos.** *Por qué:* sin una fuente única de estilos, la
  UI diverge y aparecen implementaciones duplicadas del mismo componente. *Qué mirar:* colores/
  espaciados hardcodeados fuera del archivo de tokens, o un segundo botón/input reimplementado.
- **Gating de features centralizado en una sola matriz.** *Por qué:* condicionales de rol/plan
  dispersos por el código terminan contradiciéndose entre sí. *Qué mirar:* `if (role === ...)` o
  `if (plan === ...)` repetido en múltiples archivos en vez de un único helper consultado.
- **Entitlements de edición/plan como una tercera capa ortogonal.** *Por qué:* mezclar el límite
  comercial dentro del chequeo de rol hace que ninguno de los dos sea auditable por separado.
  *Qué mirar:* un chequeo de plan/edición escrito dentro de una función que valida rol.
- **La matriz de gating se consume desde pocos puntos.** *Por qué:* si cada pantalla reimplementa
  su propio chequeo, un cambio de regla exige tocar N lugares y siempre queda uno desactualizado.
  *Qué mirar:* la misma condición de acceso escrita a mano en más de dos o tres componentes.
- **Las páginas son Server Components async; lo client-only vive aparte.** *Por qué:* separar el
  fetch de datos de los hooks de estado evita que la carga de datos dependa del ciclo de vida del
  cliente. *Qué mirar:* un componente marcado como cliente que también hace el fetch principal de
  datos de la página.

## 1.2 Multi-tenancy y seguridad

- **Aislamiento de tenant en dos capas.** *Por qué:* el filtro a nivel de aplicación es necesario
  pero no alcanza; si el motor de datos no lo fuerza, un bug de código es una fuga de datos.
  *Qué mirar:* RLS (o equivalente) deshabilitada, en modo permisivo, o ausente en una tabla nueva.
  → `C-DB-07`
- **Toda query filtra por tenant, con un test-tripwire de aislamiento.** *Por qué:* el filtro debe
  ser una regla mecánica verificada, no una convención que un desarrollador puede olvidar.
  *Qué mirar:* un test que crea dos tenants y falla si uno puede leer datos del otro.
- **Cliente con privilegios elevados bajo un allowlist estático y testeado.** *Por qué:* un cliente que
  bypassea la seguridad del motor de datos es la superficie más peligrosa del sistema si no está
  acotada. *Qué mirar:* uso del cliente con privilegios elevados fuera de un módulo/allowlist documentado, cada
  entrada con su invariante de scope explícito. → `C-SEC-08`
- **La autorización siempre viene del motor de datos, nunca de cookies/JWT del cliente.**
  *Por qué:* un claim leído del lado cliente puede ser manipulado; solo lo que el motor de datos
  resuelve con las policies aplicadas es confiable. *Qué mirar:* una decisión de acceso tomada
  leyendo un rol desde una cookie o un JWT decodificado en el cliente.
- **Toda validación de cliente se re-ejecuta server-side; el rol más alto nunca es creable desde
  una UI.** *Por qué:* una regla solo en el cliente es una sugerencia, no un control; la
  anti-escalación depende de que el server la repita. *Qué mirar:* un formulario que permite
  elegir un rol que el backend no re-valida antes de persistir.
- **RBAC en dos capas: gate de ruta + capability de acción.** *Por qué:* el acceso a una pantalla y
  el permiso de ejecutar una mutación son preguntas distintas; una sola capa deja mutaciones sin
  cubrir. *Qué mirar:* una mutación sensible sin su propio chequeo de capability, protegida solo
  por el gate de navegación de la ruta que la contiene. → `C-SEC-16`
- **Endpoints públicos endurecidos.** *Por qué:* login, checkout y formularios anónimos son el
  blanco natural de bots y credential stuffing. *Qué mirar:* ausencia de rate-limit, honeypot, o
  una respuesta que confirma/niega la existencia de una cuenta. → `C-SEC-09`
- **Uploads validados en profundidad, almacenamiento privado con URLs firmadas.** *Por qué:* el
  tipo MIME declarado por el cliente no prueba el contenido real del archivo; un bucket público
  expone todo lo subido a cualquiera con la URL. *Qué mirar:* validación solo por extensión/MIME
  sin magic bytes, o un bucket de storage con acceso público por default.
- **CSP estricta: los fetches a terceros son siempre server-side.** *Por qué:* la CSP del
  navegador bloquea (a veces en silencio) llamadas a hosts de terceros; resolverlas en el servidor
  evita ese problema y mantiene el secreto de la integración fuera del bundle del cliente.
  *Qué mirar:* un `fetch` a una API de un partner ejecutado desde un componente de cliente.
  → `C-RUN-13`
- **Log de auditoría append-only a nivel de motor de datos.** *Por qué:* un log que vive solo en
  la capa de aplicación se puede perder o falsear; a nivel de motor de datos es más difícil de
  evadir. *Qué mirar:* mutaciones sensibles sin un registro correspondiente, o un log editable/
  borrable desde la aplicación.
- **El middleware que gatea navegación no cubre las mutaciones.** *Por qué:* un middleware que
  solo redirige en GET no protege una acción de servidor invocada directo por POST. *Qué mirar:*
  una acción de servidor sensible sin su propio chequeo de autorización, confiando en que el
  middleware de la ruta ya filtró.
- **Activar/desactivar un tenant o sucursal es una acción privilegiada con efectos en cascada.**
  *Por qué:* si desactivar no corta las sesiones anónimas vigentes, se puede seguir operando ahí un
  rato después. *Qué mirar:* una desactivación que solo bloquea logins nuevos sin invalidar
  sesiones activas ni auditar el cambio. → `C-SEC-11`

## 1.3 Integridad de datos y concurrencia

- **Migraciones escritas a mano, con un comando de deploy explícito.** *Por qué:* el auto-sync de
  un ORM en producción puede aplicar un cambio destructivo sin revisión. *Qué mirar:* un paso de
  deploy que sincroniza schema automáticamente en vez de aplicar migraciones versionadas.
  → `C-DB-06`
- **La expansión de un enum vive en su propia migración aislada.** *Por qué:* el motor SQL no
  permite usar un valor de enum recién agregado en la misma transacción que lo crea. *Qué mirar:*
  un `ALTER TYPE ... ADD VALUE` seguido de su uso en el mismo archivo de migración. → `C-INT-07`
- **Invariantes garantizados por construcción, no por disciplina.** *Por qué:* una regla que
  depende de que el desarrollador se acuerde eventualmente se rompe. *Qué mirar:* un invariante de
  negocio (ej. stock nunca negativo) documentado en un comentario en vez de un constraint/tipo.
- **Concurrencia resuelta en capas, nunca con read-modify-write ingenuo.** *Por qué:* leer, calcular
  en la aplicación y escribir de vuelta pierde escrituras bajo concurrencia real. *Qué mirar:* un
  contador o stock actualizado sin `SELECT ... FOR UPDATE`, sin update condicionado al estado
  esperado (CAS), o sin un unique compuesto que impida el duplicado. → `C-INT-01`
- **Duplicación por doble-submit prevenida en varias capas a la vez.** *Por qué:* una sola defensa
  (por ejemplo solo un unique) falla ante reintentos de red o doble click; la combinación es lo que
  sostiene la garantía. *Qué mirar:* ausencia de unique compuesto + CAS + un único choke-point de
  máquina de estados para la misma transición. → `C-INT-08`
- **Un código de reserva/hold solo es seguridad real si está completamente cableado.** *Por qué:*
  una función que resta de una tabla de reservas sin que nada la inserte siempre da cero — el
  usuario nunca ve "reservado para vos" y el control es una ilusión. *Qué mirar:* una RPC de
  reserva sin su contraparte de creación en ningún flujo de la aplicación. → `C-INT-09`
- **Dinero como tipo decimal exacto, cantidades como entero no-nulo con default.** *Por qué:*
  `float` para dinero acumula error de redondeo; un `NULL` sumado a un delta da `NULL` y pierde la
  operación en silencio. *Qué mirar:* una columna monetaria en punto flotante, o un stock nullable
  sin default `0`.
- **Agregación antes de truncar, nunca al revés.** *Por qué:* tomar el top-N por grupo y recién
  después consolidar cruza-grupos da totales incorrectos. *Qué mirar:* un `LIMIT`/top-N aplicado
  antes del `GROUP BY`/consolidación final que necesita todas las filas. → `C-INT-05`
- **Un agregado que necesita filas de otros usuarios/entidades nunca se apoya en la policy pensada
  para acceso individual.** *Por qué:* una policy de "cada quien ve lo suyo" es correcta para el
  resto del sistema pero hace que un cálculo cross-entidad (ej. un neteo) dé siempre cero para
  roles no-admin, sin ningún error visible. *Qué mirar:* un agregado cross-entidad que depende de
  la policy general de RLS en vez de una RPC dedicada con su propio scope explícito. → `C-INT-03`
- **Un valor heredado editado se persiste como override explícito, no como copia silenciosa.**
  *Por qué:* si el primer edit de un campo heredado lo convierte en un valor fijo sin dejar rastro,
  se pierde la relación con el valor por defecto del padre para siempre. *Qué mirar:* un campo que,
  al editarse una vez, deja de reflejar cambios futuros del valor por defecto sin que eso sea una
  decisión explícita y visible. → `C-INT-06`
- **Soft-delete con evidencia: nada se borra físicamente.** *Por qué:* un borrado físico destruye
  la posibilidad de auditar o restaurar; archivar preserva ambas. *Qué mirar:* un `DELETE` real
  sobre una entidad de negocio en vez de un flag de archivado con acción de restauración.
- **Retro-compatibilidad de identificadores ya persistidos o impresos.** *Por qué:* renormalizar un
  esquema de identificador rompe todo lo ya emitido en el mundo físico (etiquetas, comprobantes).
  *Qué mirar:* un cambio de formato de identificador que no contempla los ya existentes.
- **Un null de serialización (ORM/JSON) no es lo mismo que un null de columna.** *Por qué:*
  confundirlos hace que un diff o una migración de datos trate como "sin cambios" algo que sí
  cambió, o viceversa. *Qué mirar:* código que compara un valor deserializado contra `null` para
  decidir si la columna es nula.
- **Transferencias cross-tenant con doble-entrada inmutable.** *Por qué:* un balance mutable sin
  snapshot en ambos lados no deja rastro verificable de quién transfirió qué a quién. *Qué mirar:*
  una transferencia entre tenants que actualiza un balance sin dejar un registro congelado
  en cada extremo.
- **Import/bulk en modo skip nunca sobreescribe lo no-matcheado.** *Por qué:* un modo "solo crear"
  que en la práctica pisa filas existentes o le roba un identificador único a otra fila causa
  pérdida de datos silenciosa. *Qué mirar:* un import con flag `create_only` que igual actualiza
  columnas de una fila que debía saltear. → `C-INT-04`

## 1.4 Fechas y timezones

- **Un solo gate de formateo con la timezone de negocio explícita.** *Por qué:* si cada pantalla
  formatea fecha por su cuenta, alguna va a usar la timezone del servidor por accidente. *Qué
  mirar:* una llamada a formateo de fecha sin un parámetro de timezone explícito.
- **La timezone de la conexión a la base de datos está fijada, no heredada del host/sesión.**
  *Por qué:* si la timezone de sesión cambia, el mismo instante se lee con offset distinto y la
  auditoría deja de ser confiable. *Qué mirar:* una conexión nueva sin `SET TIME ZONE` explícito
  al inicio. → `C-DB-10`
- **Un valor "solo fecha" hace ida y vuelta anclado a un instante neutro (ej. mediodía UTC).**
  *Por qué:* anclar a medianoche hace que la conversión de timezone empuje la fecha al día
  anterior o siguiente según dónde se renderice. *Qué mirar:* un date-picker o una fecha "de
  cumpleaños"/"de emisión" que se guarda o se lee a medianoche UTC.
- **Los buckets de agregación (día/mes/semana) se anclan a la timezone de negocio, nunca a UTC
  crudo.** *Por qué:* recortar la fecha con un slice de ISO string en UTC produce un off-by-one de
  varias horas cerca del cambio de día. *Qué mirar:* `toISOString().slice(0,10)` u operación
  equivalente usada para agrupar por "día" de negocio. → `C-UX-03`
- **La precisión temporal es proporcional a la criticidad del dato.** *Por qué:* un registro
  transaccional o de auditoría necesita milisegundos; un comprobante legible por humanos puede
  aceptar segundos si es verificable independientemente. *Qué mirar:* timestamps de auditoría
  truncados a segundos o a fecha sin hora.
- **Los exports legales/de auditoría llevan doble columna de tiempo.** *Por qué:* una sola
  columna obliga a elegir entre trazabilidad exacta (UTC) y legibilidad humana (local); ambas son
  necesarias para distintos consumidores del export. *Qué mirar:* un export de auditoría con una
  sola columna de timestamp.
- **Un cambio de timezone de sesión en el motor de datos nunca reinterpreta un instante ya
  persistido.** *Por qué:* si el mismo valor almacenado cambia de lectura según la sesión que
  consulta, la auditoría pierde sentido. *Qué mirar:* una columna de timestamp sin zona horaria
  (naive) combinada con una timezone de sesión variable. → `C-DB-10`
- **Toda métrica de "hoy"/"este mes" para reportes de negocio se deriva de la misma función de
  bucket.** *Por qué:* reimplementar el cálculo por pantalla garantiza que dos reportes del mismo
  período den números distintos. *Qué mirar:* más de una función que calcula límites de período
  de negocio de forma independiente.

## 1.5 Runtime (framework de UI y equivalentes)

- **Un helper de memoización "por request" del framework no comparte estado fuera del árbol de
  render que lo originó.** *Por qué:* usarlo para compartir estado entre una acción de servidor y
  un route handler asume una garantía que el framework no da. *Qué mirar:* un holder de contexto
  (ej. scope de tenant) implementado solo con el caché por-request del framework, sin un contexto
  de ejecución asíncrono explícito. → `C-RUN-01`
- **Entrar en un contexto de ejecución asíncrono no se propaga hacia arriba desde una función
  anidada tras un `await`.** *Por qué:* setear el contexto dentro de una función await-eada no
  afecta al caller una vez que la promesa resuelve. *Qué mirar:* un `.run()` (o equivalente) de un
  storage asíncrono invocado dentro de una función auxiliar en vez del frame que hace las queries.
  → `C-RUN-02`
- **El `value` de un Provider de contexto está memoizado.** *Por qué:* un objeto literal inline
  crea una referencia nueva en cada render, y cualquier consumidor que lo use en dependencias de
  efecto o callback entra en loop. *Qué mirar:* `<Context.Provider value={{ ... }}>` con un objeto
  construido inline en el render. → `C-RUN-03`
- **Un efecto que mueve el foco o corre "una vez al abrir" depende solo del flag de apertura.**
  *Por qué:* si depende de un callback recreado en cada render de cada caller, cada tecleo puede
  re-disparar el efecto y robar el foco antes de que se pueda escribir la segunda letra. *Qué
  mirar:* un `useEffect` de foco inicial con una función inestable entre sus dependencias.
  → `C-RUN-04`
- **Un estado inicializado desde un prop server-fed se deriva del prop, no se congela en el primer
  render.** *Por qué:* `useState(prop)` no se refresca solo porque el prop cambió tras una
  navegación same-route. *Qué mirar:* `useState` inicializado con un valor que viene del servidor
  sin remount (`key`) ni derivación directa del prop/URL. → `C-RUN-05`
- **La invalidación de caché de una escritura cross-tenant queda documentada como límite conocido
  si no cruza el límite de tenant.** *Por qué:* una invalidación que solo alcanza el tenant que
  escribe deja al tenant afectado con datos viejos hasta un refresh manual — es una limitación
  inherente del modelo, no siempre un bug a corregir. *Qué mirar:* una mutación de un actor
  privilegiado sobre el espacio de otro tenant sin invalidación documentada de ese lado.
  → `C-RUN-05b`
- **Un editor de fila inline nunca comparte estado local con otra fila.** *Por qué:* un input no
  controlado inicializado con el valor de la fila puede guardar en silencio el valor de la fila
  anterior si el componente no remonta al cambiar de fila. *Qué mirar:* un `useState(row.valor)`
  sin un `key` por identificador de fila en el elemento padre de la lista. → `C-RUN-06`
- **Un flag de configuración que dice "RLS activo" no reemplaza a las policies reales del motor de
  datos.** *Por qué:* las policies siguen aplicadas aunque el flag de la app diga lo contrario; sin
  el rol de bypass correcto, hasta el propio login se puede bloquear. *Qué mirar:* un toggle de
  aplicación que pretende desactivar RLS sin tocar policies ni roles a nivel de motor de datos.
  → `C-RUN-07`
- **Ningún link interno apunta a una ruta que hace `redirect()` server-side.** *Por qué:* el
  prefetch automático de links visibles puede entrar en loop con un ciclo de redirects, colgando
  la pestaña sin ningún request de servidor visible. *Qué mirar:* un `<Link>`/`router.push` hacia
  una ruta convertida en redirect de compatibilidad. → `C-RUN-08`
- **Un archivo de acciones de servidor exporta solo funciones async.** *Por qué:* exportar una
  constante, tipo u objeto desde ese archivo rompe el build (no el typecheck) porque el bundler
  necesita tratar cada export como una función invocable remotamente. *Qué mirar:* un `export
  const` o `export interface` en el mismo archivo que las acciones de servidor. → `C-RUN-09`
- **Un `export type` re-exportado desde un archivo de acciones de servidor no garantiza estar a
  salvo solo porque el build pasa.** *Por qué:* el bundler puede emitir una referencia runtime a un
  tipo ya eliminado, y el crash solo aparece al ejecutar la ruta, no al tipar ni al buildear.
  *Qué mirar:* tipos re-exportados junto a acciones de servidor, verificados solo por typecheck y
  build sin un test end-to-end que ejercite la ruta real. → `C-RUN-09b`
- **La CSP se actualiza para cada host nuevo que sirve un recurso, no solo el que lo recibe.**
  *Por qué:* el host de una URL firmada puede estar autorizado para conectarse pero no para
  mostrarse como imagen, y el bloqueo es silencioso. *Qué mirar:* un recurso servido desde un host
  nuevo sin revisar la directiva de CSP correspondiente (y sin reiniciar el server de dev tras
  cambiarla). → `C-RUN-10`
- **Contenedores de aspecto fijo para avatares/miniaturas, nunca una imagen suelta dentro de un
  flex.** *Por qué:* `object-fit` sin un contenedor de tamaño fijo con overflow oculto se deforma
  con el reflow del layout. *Qué mirar:* una imagen circular/cuadrada sin contenedor de tamaño fijo
  y `no-shrink`. → `C-RUN-11`
- **Cualquier librería de animación que anima al montar se gatea con un flag "mounted" en páginas
  estáticas.** *Por qué:* animar automáticamente en una página generada estáticamente produce un
  mismatch de hidratación. *Qué mirar:* una animación de entrada activa por default en un
  componente que se renderiza en una página SSG/estática. → `C-RUN-12`
- **Los fetches a APIs de terceros ocurren siempre server-side.** *Por qué:* la CSP del navegador
  excluye por diseño las APIs de terceros del lado cliente, y hacerlo server-side además evita
  exponer el secreto de la integración. *Qué mirar:* un `fetch` directo a un dominio de partner
  dentro de un componente de cliente. → `C-RUN-13`
- **Ningún generador de tokens/códigos pide un entero aleatorio en un rango extremo.** *Por qué:*
  un rango que un runtime viejo tolera en silencio puede explotar al endurecerse una versión nueva
  del mismo runtime, sin ningún cambio en el código propio. *Qué mirar:* un generador de tokens que
  pide un entero aleatorio nativo en un rango mayor al que el runtime garantiza soportar, en vez de
  bytes aleatorios opacos. → `C-RUN-14`
- **Un logout con redirect que atraviesa el middleware se implementa como route handler nativo,
  nunca como acción de servidor.** *Por qué:* el parser de respuesta de una acción de servidor no
  sabe leer un redirect que atraviesa el middleware de la app. *Qué mirar:* un flujo de logout
  implementado como acción de servidor sobre una ruta con middleware activo. → `C-RUN-15`
- **Un campo de imagen opcional se normaliza a `null` antes de llegar al componente de imagen.**
  *Por qué:* un componente de imagen del framework puede tratar un string vacío distinto de
  `null`/`undefined` y crashear en vez de mostrar un fallback. *Qué mirar:* un valor de imagen
  potencialmente vacío pasado sin normalizar a un componente de imagen. → `C-RUN-16`
- **Toda escritura best-effort, aunque no bloquee la respuesta al usuario, se awaitea si es la
  última operación del handler.** *Por qué:* una función serverless puede congelarse apenas
  responde al cliente, perdiendo una escritura en vuelo sin ningún error visible. *Qué mirar:* un
  insert/update fire-and-forget sin `await` inmediato dentro de un handler serverless. → `C-RUN-17`
- **Un selector multi-tenant nunca defaultea a "la primera opción alfabética".** *Por qué:* ese
  default aterriza al usuario en un scope vacío al azar, que se ve como un bug en cualquier demo o
  onboarding. *Qué mirar:* un `.sort()` o un `[0]` sobre la lista de tenants/sucursales del usuario
  usado como selección inicial. → `C-RUN-18`
- **Las fechas se serializan a string antes de cruzar el borde servidor→cliente.** *Por qué:* pasar
  un objeto de fecha vivo a través del borde puede producir un mismatch de hidratación en tablas o
  gráficos renderizados en cliente. *Qué mirar:* un valor `Date` (no string) pasado como prop desde
  un Server Component a un Client Component. → `C-RUN-19`

## 1.6 Plataforma de datos (motor de datos relacional/RLS/Realtime/migraciones)

- **RLS forzada (no solo habilitada) en toda tabla con datos de tenant.** *Por qué:* forzada
  significa que ni siquiera el dueño de la tabla la esquiva por accidente; habilitada sin forzar
  deja un camino de bypass involuntario. *Qué mirar:* una tabla nueva con datos de tenant sin RLS
  forzada, detectable con un guard estático en CI. → `C-DB-07`
- **Un rol de conexión directa (bypass de RLS) es exclusivo de administración y migraciones.**
  *Por qué:* el camino de un usuario en runtime siempre debe pasar por el cliente autenticado con
  su JWT real; correr queries de usuario por el canal directo es un error de infraestructura grave
  si ocurre por accidente. *Qué mirar:* código de runtime de usuario usando la connection string
  directa/administrativa en vez del cliente autenticado. → `C-DB-08`
- **Toda función con privilegios elevados fija su `search_path` explícito.** *Por qué:* sin
  fijarlo, una función con privilegios elevados es vulnerable a hijacking de `search_path`. *Qué
  mirar:* una función con privilegios elevados sin `SET search_path` en su definición. → `C-DB-05`
- **El único SQL dinámico permitido corre sobre un allowlist hardcodeado de tablas.** *Por qué:*
  interpolar nombres de tabla o columna sin allowlist reabre la puerta a inyección aunque el resto
  del query esté parametrizado. *Qué mirar:* un `EXECUTE format(...)` o equivalente que interpola
  un nombre de tabla/columna sin validarlo contra una lista fija. → `C-DB-09`
- **Realtime se implementa como broadcast explícito (nunca replicación nativa de cambios de fila)
  cuando el scope de RLS es custom, y el canal tiene su propia policy de lectura.** *Por qué:* los
  streams nativos de cambios de fila no respetan un scope de policy custom; un canal privado sin su
  propia policy de SELECT sobre la tabla de mensajes falla al suscribirse aunque el trigger dispare
  bien. *Qué mirar:* una suscripción a cambios de fila nativos sobre una tabla cuya policy de acceso
  no es la de "todo el mundo autenticado ve todo", o ausencia de policy de SELECT sobre la tabla de
  mensajes de realtime. → `C-DB-03`
- **El trigger de broadcast maneja el caso de borrado y no invierte el orden de argumentos.**
  *Por qué:* un DELETE deja el registro nuevo en null; un trigger que no lo contempla revienta justo
  en el caso menos frecuente y más tarde en notarse. *Qué mirar:* una función de trigger de broadcast
  sin `coalesce(NEW, OLD)` al inicio, declarada para INSERT/UPDATE/DELETE combinados. → `C-DB-02`
- **Toda tabla bajo RLS forzada tiene su policy de UPDATE el día que necesita escrituras.**
  *Por qué:* sin la policy correspondiente, la escritura falla en silencio en vez de con un error
  ruidoso — se ve como "no pasó nada". *Qué mirar:* una tabla con policy de SELECT pero sin
  policy de UPDATE que sin embargo recibe mutaciones desde la aplicación. → `C-DB-01`
- **Los seeds corren antes de forzar RLS, o por un canal privilegiado.** *Por qué:* sembrar datos
  después de forzar RLS sin el rol adecuado bloquea al propio proceso de seed. *Qué mirar:* un
  script de seed que falla con un error de policy al insertar datos base. → `C-DB-04`
- **Una única fuente de verdad de schema entre definición, migraciones y tipos generados.**
  *Por qué:* sin generación automática en CI/pre-commit, los tipos se editan a mano en cada
  migración y divergen tarde o temprano. *Qué mirar:* tipos de datos escritos a mano que deberían
  venir de una generación automática a partir del schema real. → `C-DB-06`
- **El paso de deploy siempre aplica las migraciones pendientes como paso explícito.** *Por qué:*
  generar un cliente y buildear la aplicación no es equivalente a migrar la base; sin este paso,
  la primera query a una columna nueva explota recién en producción con un error opaco. *Qué
  mirar:* un pipeline de deploy que corre generación de cliente + build pero no un paso separado
  de aplicar migraciones contra la base real.
- **Los timestamps se fijan a una timezone constante a nivel de conexión.** *Por qué:* sin fijarla,
  un cambio de timezone de sesión hace que el mismo instante se lea con offset distinto y rompe la
  confiabilidad de la auditoría. *Qué mirar:* una conexión nueva sin `SET TIME ZONE` explícito.
  → `C-DB-10`
- **La expansión de un valor de enum vive en su propia migración, aislada de su primer uso.**
  *Por qué:* el motor no permite usar un valor de enum recién agregado en la misma transacción que
  lo crea. *Qué mirar:* un `ALTER TYPE ... ADD VALUE` en el mismo archivo/transacción que una
  query que ya lo usa. → `C-INT-07`

## 1.7 UX/UI

- **Una advertencia informativa nunca funciona como gate bloqueante.** *Por qué:* mezclar ambos
  conceptos hace que el usuario no sepa si puede seguir o está trabado, y esconde cuál regla es
  realmente obligatoria. *Qué mirar:* un mensaje con tono de advertencia que en la práctica
  deshabilita el botón de continuar sin ser una regla dura documentada, y sin un test que confirme
  que la acción sigue siendo posible con el aviso visible. → `C-TEST-03`
- **Todo error mostrado al usuario es accionable y está en su idioma.** *Por qué:* un mensaje
  crudo de validación o del motor de datos no le dice al usuario qué hacer, solo lo confunde.
  *Qué mirar:* un `catch` que renderiza `error.message` directo en la UI.
- **Cada vista de datos cubre sus tres estados: skeleton, vacío real y error-con-retry.**
  *Por qué:* colapsar un error en un estado vacío hace que una falla de permisos o de conexión se
  vea como "no hay datos". *Qué mirar:* un `.catch()` o chequeo de error que retorna un array
  vacío por default en vez de propagar el error a un estado distinto de "vacío". → `C-UX-05`
- **Ninguna mutación falla en silencio.** *Por qué:* toda escritura iniciada por el usuario debe
  mostrar feedback atado al resultado real de la operación, no a una suposición optimista. *Qué
  mirar:* una acción de guardar/eliminar sin toast ni cambio visible de estado tras completarse.
- **Normalización de dominio en el input, con excepciones explícitas y documentadas.** *Por qué:*
  reescribir el input del usuario sin decirlo genera sorpresas; no normalizar nada genera datos
  sucios. *Qué mirar:* un campo que transforma el valor tipeado sin feedback visual de qué cambió.
- **Defaults editables inteligentes que nunca pisan una edición manual.** *Por qué:* un valor
  calculado que se recalcula después de que el usuario ya lo tocó a mano descarta su trabajo sin
  avisar. *Qué mirar:* un campo con valor por defecto derivado que se sobreescribe solo aunque el
  usuario ya lo haya editado.
- **El motion es sobrio y respeta `prefers-reduced-motion` en todos lados.** *Por qué:* sin esta
  preferencia respetada, una animación se convierte en una barrera de accesibilidad; el modo
  reducido debe mostrar el estado final completo, no un frame roto a mitad de animación. *Qué
  mirar:* una transición sin comprobación de la preferencia de movimiento reducido, verificada con
  capturas en ambos modos. → `C-UX-02`
- **Identificadores físicos escaneables resuelven contra un único punto central de deep-link.**
  *Por qué:* un QR o código impreso que enruta con lógica dispersa por la aplicación es imposible
  de mantener retro-compatible cuando cambia el esquema de rutas. *Qué mirar:* más de un lugar en
  el código que interpreta el contenido de un código físico escaneado.
- **`alert`/`confirm` nativos del navegador nunca se usan para confirmación o notificación.**
  *Por qué:* rompen el estilo visual, no son accesibles de forma consistente y bloquean el hilo de
  UI. *Qué mirar:* una llamada a `window.confirm` o `alert` en código de producción.
- **Cobertura exhaustiva de enum en cada filtro/branch de UI.** *Por qué:* un valor de enum sin
  rama que lo maneje no lanza error, simplemente desaparece de la vista — el registro parece
  perdido. *Qué mirar:* un `switch`/mapeo sobre un enum sin un check exhaustivo que falle al
  compilar si se agrega un valor nuevo. → `C-UX-04`
- **Un número que el usuario ve dos veces se calcula con una sola función pura compartida.**
  *Por qué:* calcular el mismo total en dos lugares (ej. carrito y confirmación) garantiza que
  eventualmente diverjan. *Qué mirar:* el mismo cálculo de precio/total reimplementado en más de
  un archivo. → `C-UX-01`
- **Copy uniforme en el idioma del usuario; un solo formateador de moneda/número.** *Por qué:* el
  formateo inline ad-hoc produce inconsistencias sutiles (separador de miles, símbolo de moneda)
  entre pantallas. *Qué mirar:* `toLocaleString`/concatenación manual de moneda repetida en vez de
  pasar por un formateador compartido.
- **Consentimiento capturado antes de inyectar cualquier tag de analítica de terceros.** *Por qué:*
  cargar un script de tracking antes del consentimiento es un problema legal, no solo de UX. *Qué
  mirar:* un script de analítica/marketing que se inyecta al cargar la página sin gate de
  consentimiento previo.
- **Estados vacíos honestos, nunca datos fabricados.** *Por qué:* un número inventado (uptime
  falso, variación año a año ficticia) es peor que mostrar honestamente que no hay datos todavía.
  *Qué mirar:* un placeholder numérico hardcodeado en un dashboard en vez de un estado vacío real.
- **Un identificador físico único-por-construcción mantiene retro-compatibilidad para siempre.**
  *Por qué:* una vez impreso o entregado a un tercero, el esquema de codificación no se puede
  renormalizar sin invalidar lo ya emitido. *Qué mirar:* un cambio de formato de código/identificador
  físico sin un plan de convivencia con el formato anterior.
- **Una UI de flujo crítico ya validada se congela y solo se re-cablea, no se rediseña en la misma
  pasada.** *Por qué:* cambiar diseño y backend a la vez en un flujo crítico hace imposible aislar
  qué causó una regresión. *Qué mirar:* un cambio que toca layout/estilos y la fuente de datos de
  un flujo crítico en el mismo commit/PR.
- **Un evento originado en hardware (cámara, sensor, lector) nunca dispara una mutación de negocio
  sin pasar por una guarda de referencia estable + debounce.** *Por qué:* un sensor puede emitir
  varias lecturas para el mismo evento físico en un lapso corto, y cada una procesada de forma
  independiente duplica la mutación (doble alta, doble descuento de stock). *Qué mirar:* un handler
  de evento de hardware que dispara la mutación de negocio en cada lectura, sin una ventana de
  debounce ni una referencia del último valor procesado. → `C-UX-07`

## 1.8 Testing y verificación

- **Triple gate antes de cualquier entrega: typecheck + suite completa + build.** *Por qué:* cada
  uno de los tres atrapa una clase de error que los otros dos no ven. *Qué mirar:* un pipeline o
  una entrega que se considera lista habiendo corrido solo uno o dos de los tres.
- **Guards estáticos de seguridad corren en CI y parsean schema/policies reales.** *Por qué:* es la
  única red que atrapa una tabla nueva sin RLS o un uso del cliente con privilegios elevados fuera
  de su allowlist antes de que llegue a producción — la pieza de mayor apalancamiento de todo el estándar
  de testing. *Qué mirar:* ausencia de un chequeo automatizado que falle el build ante una tabla
  org-scoped sin RLS (→ `C-DB-07`) o un uso del cliente con privilegios elevados fuera de la lista permitida.
  → `C-SEC-08`
- **Un test nuevo reproduce el bug reportado y falla ANTES del fix.** *Por qué:* si el test no
  falla contra el código viejo, no se sabe si realmente protege contra la regresión. *Qué mirar:*
  un test agregado junto con un fix que nunca se corrió en rojo contra la versión previa.
- **Un test siempre invoca el símbolo real que corre en producción, nunca una réplica local.**
  *Por qué:* un test que reimplementa a mano una copia de la función bajo prueba puede pasar para
  siempre sin proteger nada si el símbolo real diverge de esa copia. *Qué mirar:* un test que
  define su propia versión de la función bajo prueba en vez de importarla del módulo real.
  → `C-TEST-01`
- **La pirámide separa por lo que cada capa ejercita: lógica pura, componente con I/O mockeado,
  límites adversariales de compliance, integración contra base real gateada por env, y un smoke de
  aislamiento con dos o más tenants reales.** *Por qué:* cada capa cubre una clase de defecto que
  las demás no pueden ver de forma económica. *Qué mirar:* toda la suite concentrada en un solo
  tipo de test (por ejemplo, todo mockeado, o todo end-to-end).
- **Un checklist de QA manual versionado, no conocimiento tribal.** *Por qué:* sin versionarlo,
  cada persona verifica algo distinto antes de cada entrega. *Qué mirar:* ausencia de un documento
  de QA manual referenciado desde el proceso de release.
- **Diagnosticar empieza por reproducir el problema, no por adivinar la causa.** *Por qué:* un
  diagnóstico sin reproducción empírica lleva a arreglar el síntoma equivocado. *Qué mirar:* un fix
  propuesto sin un paso previo que reproduzca el error reportado.
- **Una assertion débil se rechaza en revisión: debe afirmar el efecto real, no solo el status.**
  *Por qué:* un test que solo verifica un código 200 o "no lanzó excepción" puede pasar aunque la
  función bajo test no haya hecho lo que dice hacer. *Qué mirar:* un test de una función con efecto
  secundario (invalidar caché, enviar notificación) que no verifica que ese efecto ocurrió.
  → `C-TEST-02`
- **Toda mutación concurrencia-sensible tiene un test dedicado de escritores concurrentes.**
  *Por qué:* un CHECK a nivel de columna evita valores inválidos pero no prueba que el algoritmo de
  concurrencia realmente resuelve la carrera. *Qué mirar:* una RPC de stock/contador/código único
  sin un test que la ejecute con N intentos simultáneos.
- **La autorización de canales realtime tiene un test de camino negativo explícito.** *Por qué:*
  sin probar el caso "no debería poder", un cambio futuro puede abrir un canal a un scope ajeno sin
  que ningún test lo note. *Qué mirar:* tests de un canal realtime que solo cubren el camino
  "debería poder", sin un caso de scope ajeno o de sesión anónima.
- **Los scripts de verificación manual ad-hoc se reemplazan por tests de integración estructurados
  una vez que el flujo estabiliza.** *Por qué:* un script que se corre a mano y se descarta no dejó
  ninguna protección permanente contra la regresión. *Qué mirar:* un directorio de scripts que
  cumple la función de test de un flujo ya estable en producción. → `C-TEST-04`
- **Los tipos que describen el schema real se generan automáticamente, nunca se editan a mano.**
  *Por qué:* sin un gate en CI que compare el tipo comprometido contra el generado, el drift entre
  ambos no lo detecta ningún test hasta que una query falla en runtime. *Qué mirar:* tipos de
  columnas/tablas editados a mano sin un paso de generación automática verificado en CI/pre-commit.
  → `C-TEST-05`

## 1.9 Observabilidad y operación

- **Toda mutación sensible audita quién, qué, antes/después, IP y cuándo con precisión de
  milisegundos.** *Por qué:* un log parcial (solo "qué" sin "quién" o sin el estado anterior) no
  alcanza para reconstruir un incidente. *Qué mirar:* una mutación privilegiada sin registro de
  auditoría, o un registro que omite el snapshot de rol de quien la ejecutó.
- **Los accesos privilegiados/cross-tenant se auditan dentro del espacio del tenant afectado.**
  *Por qué:* un log solo a nivel de plataforma es invisible para el dueño del tenant afectado, que
  no puede auditar su propio espacio. *Qué mirar:* un acceso de soporte/plataforma a datos de un
  tenant que no deja rastro visible para ese tenant.
- **Los exports legales/de auditoría llevan doble columna de tiempo (UTC ISO + local con
  segundos).** *Por qué:* un solo formato obliga a elegir entre trazabilidad exacta y legibilidad
  humana. *Qué mirar:* un export de auditoría con una sola columna de timestamp. → `C-DB-10`
- **La impresión de un documento o etiqueta también es un evento auditado.** *Por qué:* si solo se
  audita la creación del documento, una reimpresión indebida queda invisible. *Qué mirar:* una
  acción de imprimir/exportar sin su propio registro de auditoría.
- **La política de compliance se resuelve centralizadamente por regla y siempre audita,
  independientemente del modo (enforce/warn/off).** *Por qué:* si el modo "warn" u "off" también
  apaga la auditoría, se pierde visibilidad justo cuando más se necesita vigilar. *Qué mirar:* un
  modo no-bloqueante de una policy de compliance que tampoco deja registro de lo que habría
  bloqueado.
- **Una acción con peso legal/de compliance dispara siempre una mutación real, nunca solo un
  cambio de estado en el cliente.** *Por qué:* una retracción o un consentimiento que solo cambia
  estado optimista en memoria se revierte con un refresh de página, mientras el riesgo legal ya
  existe. *Qué mirar:* un botón de acción legal (retracción, baja, consentimiento) sin una fila
  persistida con timestamp que lo respalde. → `C-UX-06`
- **El manejo de errores está centralizado en una función que también alimenta el monitoreo.**
  *Por qué:* sin un único punto de traducción de errores, cada capa inventa su propio logging y
  algunos errores no llegan a ningún lado. *Qué mirar:* un `catch` que solo hace `console.log` en
  vez de pasar por el manejador central de errores.
- **El monitoreo de errores corre como no-op documentado hasta que hay credencial configurada.**
  *Por qué:* una integración de monitoreo que lanza excepción por falta de credencial en vez de
  degradar a no-op puede tumbar producción por un problema de configuración, no de negocio. *Qué
  mirar:* una inicialización de monitoreo sin un branch explícito de "credencial ausente → no-op".
- **Un error de la capa de datos nunca se traduce en un resultado vacío de éxito silencioso.**
  *Por qué:* si el código ignora el campo de error y devuelve una lista vacía por default, una
  falla de permisos o de conexión se ve idéntica a "no hay datos". *Qué mirar:* un wrapper de query
  que retorna `[]` sin distinguir entre "vacío" y "la llamada falló". → `C-UX-05`

## 1.10 Proceso y documentación

- **Las decisiones de convención están numeradas, con su por-qué, actualizadas en el mismo cambio
  que las origina.** *Por qué:* una convención sin numerar ni versionar se vuelve tribal y se
  reinterpreta distinto por cada persona. *Qué mirar:* una regla de equipo mencionada solo en un
  mensaje o comentario, sin entrada en el documento de convenciones.
- **Existe un catálogo vivo de clases de bug (síntoma → causa → fix → regla).** *Por qué:* sin él,
  la misma clase de bug se vuelve a descubrir desde cero en cada proyecto o cada iteración. *Qué
  mirar:* un bug recurrente conocido por el equipo que no tiene entrada documentada en ningún
  catálogo.
- **Hay un changelog por release.** *Por qué:* sin registro por release, es imposible saber qué
  cambió entre dos versiones sin leer el historial completo de commits. *Qué mirar:* releases
  etiquetadas sin una entrada de changelog correspondiente.
- **El roadmap se mueve solo hacia adelante.** *Por qué:* borrar ítems completados o abandonados en
  vez de archivarlos destruye el historial de decisiones de priorización. *Qué mirar:* un roadmap
  donde los ítems desaparecen en vez de marcarse como hechos/descartados con fecha.
- **Un tracker de deuda técnica explícito, con contexto y condición de desbloqueo por ítem.**
  *Por qué:* lo diferido "de palabra" se olvida; un ítem con contexto y gate de desbloqueo puede
  retomarse meses después sin reconstruir el razonamiento. *Qué mirar:* una decisión de "lo dejamos
  para después" que no quedó registrada en ningún tracker.
- **Las migraciones son aditivas y numeradas; el squash/reset ocurre como paso deliberado antes de
  un corte a producción.** *Por qué:* un reset accidental o no documentado en el momento equivocado
  puede destruir el historial de schema que se necesita para diagnosticar producción. *Qué mirar:*
  una migración que reescribe o borra migraciones anteriores fuera de un corte a producción
  explícitamente planeado.
- **Hay un gate legal/de compliance explícito donde aplica, con dueño y condición de disparo
  documentados.** *Por qué:* sin un gate explícito, una obligación legal se cumple "porque alguien
  se acordó" en vez de por diseño. *Qué mirar:* un flujo con implicancia legal (datos personales,
  facturación, consentimiento) sin un punto de control documentado.
- **La documentación de un mismo concepto vive en un solo lugar, referenciada desde donde haga
  falta.** *Por qué:* duplicar la misma explicación en varios documentos garantiza que uno quede
  desactualizado cuando el otro se edita. *Qué mirar:* la misma explicación de una regla de negocio
  escrita casi igual en dos documentos distintos.
- **El riesgo de drift entre schema/tipos generados tiene un dueño y un paso de CI, no una nota de
  "acordarse de regenerar".** *Por qué:* un paso manual eventualmente se salta; automatizarlo en CI
  lo hace imposible de olvidar. *Qué mirar:* tipos de datos regenerados a mano según memoria en vez
  de un paso de CI/pre-commit. → `C-DB-06`

## Parte 2 — Catálogo de clases de bug con detección

> Cada entrada describe una CLASE de bug, no una instancia puntual: el mismo síntoma va a volver a
> aparecer en un stack distinto si la causa raíz no se ataca a nivel de norma. Un par de entradas
> documentan defensas/patrones a preservar en vez de bugs — quedan marcadas explícitamente.

## 2.1 Seguridad / RLS / Autorización

### C-SEC-01 — Estado sensible mantenido en memoria del proceso sin autenticación

**Síntoma:** Un endpoint devuelve o borra datos de carrito/orden/PII (nombre, email, documento) sin que el caller esté autenticado; en serverless el estado además desaparece entre invocaciones.
**Causa:** El handler usa una estructura en memoria (`Map`, variable de módulo) como si fuera almacenamiento durable y compartido, y nunca exige sesión antes de leer/escribir esa estructura.
**Detección:**
- [grep] `new Map\(\)` o una variable de módulo mutable en un archivo de ruta/handler, sin un chequeo de sesión antes del primer acceso a esa estructura
**Fix canónico:** Mover el estado a una tabla con RLS; el handler autentica y autoriza antes de cualquier lectura/escritura.
**Regla:** Ningún estado de negocio vive en memoria del proceso; vive en la base de datos, detrás de RLS.
**Severidad:** crítica

### C-SEC-02 — Endpoint proxy a un servicio de terceros sin gate de autorización (IDOR)

**Síntoma:** Un actor anónimo puede leer, modificar o borrar recursos reales de un partner externo a través de una ruta que solo reenvía la request.
**Causa:** La ruta actúa como proxy transparente hacia la API del tercero y nunca valida sesión/rol antes de reenviar el método (incluido DELETE).
**Detección:**
- [grep] rutas bajo un path tipo `*/proxy/*` o `*/partner/*` que llaman `fetch\(` sin una función de auth invocada antes, en el mismo archivo
**Fix canónico:** Gate de rol (manager o superior) antes de cualquier I/O hacia el tercero; "es solo un proxy" no exime de autorización.
**Regla:** Todo endpoint que reenvía a un tercero autoriza primero, reenvía después.
**Severidad:** crítica

### C-SEC-03 — Orden auth-antes-de-IO violado / tenant tomado del cliente

**Síntoma:** Un handler ejecuta una query o instancia un cliente con privilegios elevados antes de confirmar sesión y rol; el id de tenant/sucursal se toma de un parámetro del request en vez de derivarse de la sesión.
**Causa:** La lógica de negocio se escribe primero y la autorización queda "más abajo" o al final, sin un choke-point único; un rol de plataforma que opera cross-tenant se infiere del cliente en vez de ser un claim propio.
**Detección:**
- [grep] handlers donde el primer efecto es una query/`createAdminClient` y el chequeo de sesión aparece después, o donde `tenantId`/`storeId` viene de params sin cruzarlo contra la sesión
**Fix canónico:** Autenticar y autorizar primero; instanciar cualquier cliente con privilegios elevados después; derivar tenant/sucursal siempre de la sesión, nunca de params del cliente.
**Regla:** Auth-antes-de-IO es innegociable, incluso para el actor de mayor privilegio del sistema.
**Severidad:** crítica

### C-SEC-04 — Secretos o PII en logs de texto plano

**Síntoma:** Un log de aplicación contiene un access token, una contraseña o un email completo, visible en cualquier agregador de logs.
**Causa:** Se loguea el objeto completo de request/response o el error crudo sin sanitizar, "para debug", y el logueo queda en el código.
**Detección:**
- [grep] `console\.(log|error|debug)\(` cuyo argumento incluye un objeto/variable con nombre `token|password|email|dni` (case-insensitive)
**Fix canónico:** Loguear solo identificadores opacos (id de usuario, id de request); nunca el valor del secreto ni el PII completo.
**Regla:** Ningún secreto ni dato personal identificable entra a un log, ni siquiera en desarrollo.
**Severidad:** alta

### C-SEC-05 — Oráculo de enumeración de cuentas en login/reset

**Síntoma:** La respuesta de login o de recuperación de contraseña permite distinguir si un email existe en el sistema (mensaje distinto, código de estado distinto).
**Causa:** El handler propaga `error.message` del proveedor de auth tal cual, o responde distinto según exista o no la cuenta.
**Detección:**
- [grep] `error\.message` devuelto directo al cliente en una ruta de login/reset, o dos ramas de `return` distintas según exista o no el usuario
**Fix canónico:** Una única respuesta genérica ("si el email existe, te llegará un correo") para todos los casos, en login y en reset.
**Regla:** Ninguna superficie de auth revela si una cuenta existe.
**Severidad:** media

### C-SEC-06 — Error crudo de upstream expuesto al cliente

**Síntoma:** Un modal o toast muestra el texto de error tal cual devuelto por un servicio de terceros o por el motor de datos.
**Causa:** El catch propaga `err.message`/`err.toString()` directo a la UI en vez de mapearlo a un mensaje seguro.
**Detección:**
- [grep] bloque `catch` que termina en un `setError`/`toast` usando `.message` del error sin pasar por un traductor central
**Fix canónico:** Un único mapeador de errores a mensajes accionables en el idioma del usuario; el error crudo solo va a logs/observabilidad.
**Regla:** Ningún error de un sistema externo llega sin traducir a la UI.
**Severidad:** media

### C-SEC-07 — Resolución global de un identificador con unicidad solo tenant-scoped (fuga cross-tenant)

**Síntoma:** Un identificador corto (slug, código QR) resuelto con un cliente con privilegios elevados enruta al recurso de OTRO tenant.
**Causa:** El identificador es único solo dentro del tenant, pero la resolución usa un cliente que ignora RLS y busca sin filtrar por tenant; el mismo riesgo aplica a un rol de plataforma que opera cross-tenant sin acotar el scope explícitamente.
**Detección:**
- [pregunta] ¿la resolución de un slug/código con un cliente con privilegios elevados filtra explícitamente por tenant en la misma query, o asume una unicidad global que nadie garantizó?
**Fix canónico:** Toda resolución con un cliente con privilegios elevados exige unicidad GLOBAL real del identificador, o un filtro de tenant explícito antes de resolver; un rol de plataforma nunca afloja el scope de tenant por default.
**Regla:** Un cliente que bypassea RLS nunca resuelve "por las suyas" sin acotar el scope de tenant.
**Severidad:** crítica

### C-SEC-08 — Guard estático del cliente con privilegios elevados con allowlist en CI (patrón de detección)

**Síntoma:** N/A — esta entrada documenta una DEFENSA, no un bug.
**Causa:** Sin este guard, cualquier archivo nuevo puede instanciar un cliente con privilegios elevados sin que nadie lo note hasta que produce una fuga real.
**Detección:**
- [señal] test de CI que parsea el árbol de archivos y falla el build si aparece la construcción del cliente con privilegios elevados fuera de una allowlist chica y versionada
**Fix canónico:** Mantener la allowlist mínima y documentada; cada entrada nueva requiere justificación explícita en el mismo PR que la agrega.
**Regla:** Ningún cliente con privilegios elevados se instancia fuera de una allowlist auditada estáticamente.
**Severidad:** N/A (preventivo)

### C-SEC-09 — Superficies públicas sin rate-limiting ni headers de endurecimiento

**Síntoma:** Login, checkout o sign-in anónimo aceptan tráfico ilimitado; además faltan headers básicos (X-Frame-Options, nosniff, HSTS, CSP), o una CSP nueva bloquea silenciosamente un host legítimo.
**Causa:** El rate-limiting se dejó para "después"; los headers de seguridad nunca se centralizaron; la CSP se endurece de una sola vez sin un modo de observación previo.
**Detección:**
- [pregunta] ¿cada ruta pública (login, checkout, sign-in anónimo) tiene un wrapper de rate-limit en el mismo handler? ¿existe un middleware central de headers de seguridad?
**Fix canónico:** Rate-limit por capas (nativo del proveedor → Redis en prod, con un hook no-op mientras tanto); CSP en modo Report-Only antes de enforce, con nonce.
**Regla:** Ninguna superficie pública queda sin límite de tráfico ni sin headers básicos de endurecimiento.
**Severidad:** alta

### C-SEC-10 — Usuario desactivado o baneado sigue autorizado durante la ventana de vida del JWT

**Síntoma:** Un empleado desvinculado o un usuario baneado sigue operando con normalidad durante minutos u horas después de la desactivación.
**Causa:** El acceso no rechequea el flag de activo/baneado en cada request (solo al emitir el JWT); revocar el refresh token no invalida un access-token ya emitido, que sigue vivo hasta su expiración natural.
**Detección:**
- [pregunta] ¿el guard de cada request revalida `active`/`banned` contra la base, o confía ciegamente en el claim del JWT emitido hace rato?
**Fix canónico:** Chequear el flag activo/baneado en cada acceso sensible además del claim del JWT; revocar sesiones y documentar la ventana residual en el copy de confirmación al operador.
**Regla:** Ninguna desactivación se considera efectiva hasta que se verificó también contra la base, no solo contra el JWT.
**Severidad:** alta

### C-SEC-11 — Bypass de máquina de estados en transiciones privilegiadas

**Síntoma:** Una mutación revive un registro en estado terminal (entregado, cancelado), o activa un tenant/sucursal sin pasar por validaciones ni cortar sesiones/planes asociados.
**Causa:** Existen varios puntos de entrada para cambiar de estado y no todos pasan por el mismo validador de transiciones; una activación no se trata como su propia transición auditada con efectos en cascada.
**Detección:**
- [pregunta] ¿hay más de un lugar en el código que actualiza el campo de estado de la misma entidad, fuera de un único módulo de transiciones?
**Fix canónico:** Un solo choke-point para todo cambio de estado de una entidad; activar/desactivar es una transición más, con corte de sesiones vigentes y validación de límites de plan incluida.
**Regla:** Ninguna transición de estado ocurre fuera del validador único de esa entidad.
**Severidad:** alta

### C-SEC-12 — Password en claro compartida al crear un usuario

**Síntoma:** El operador que crea una cuenta nueva conoce la contraseña inicial del usuario creado.
**Causa:** El flujo de alta pide una contraseña en un formulario que llena el operador, en vez de delegar la definición de contraseña al propio usuario.
**Detección:**
- [grep] un formulario de alta de usuario con un campo `password` que no sea de invitación/token
**Fix canónico:** Migrar a invite-link: el operador solo dispara la invitación, el usuario define su propia contraseña.
**Regla:** Ningún tercero conoce la contraseña de la cuenta que administra.
**Severidad:** media

### C-SEC-13 — Queries que confían solo en RLS, sin guard explícito de scope

**Síntoma:** Una query retorna filas fuera del scope esperado en algún camino no cubierto por la policy vigente, o el bug se descubre solo cuando la policy cambia.
**Causa:** El código de aplicación asume que RLS es la única línea de defensa y no valida explícitamente el scope (sucursal, tenant) antes de operar.
**Detección:**
- [pregunta] si se desactivara RLS por accidente en esta tabla, ¿el código de aplicación seguiría acotando el resultado al scope correcto?
**Fix canónico:** Agregar el guard explícito de scope en el código de aplicación como defensa en profundidad, aunque RLS esté forzada.
**Regla:** RLS es la última línea de defensa, nunca la única.
**Severidad:** alta

### C-SEC-14 — Secretos opcionales en el schema de entorno (sin fail-fast)

**Síntoma:** Una integración falla en silencio en producción porque una env var necesaria nunca se seteó, y nadie lo nota hasta que un usuario reporta el síntoma.
**Causa:** La variable está marcada como opcional en el schema de validación de entorno en vez de requerida, porque "no siempre se usa".
**Detección:**
- [grep] marca de opcional en el schema de env (ej. `\.optional\(\)`), cruzada contra un módulo de integración que lee esa variable sin chequear si vino indefinida
**Fix canónico:** Todo secreto que un flujo activo necesita es requerido en el schema; el flujo que puede no estar activo usa un feature-flag explícito, no una env opcional silenciosa.
**Regla:** Fail-fast al boot, nunca fail-silent en runtime, para cualquier secreto necesario.
**Severidad:** media

### C-SEC-15 — Columnas secretas legibles vía la policy de SELECT de la tabla

**Síntoma:** Cualquier rol con acceso de lectura a una tabla (ej. un manager) puede hacer SELECT de una credencial de integración guardada en una columna de esa misma tabla.
**Causa:** La policy de RLS autoriza SELECT a nivel de fila, no de columna; el secreto vive en la misma tabla que los datos de negocio que ese rol sí debe leer.
**Detección:**
- [pregunta] ¿alguna columna `token`/`secret`/`api_key`/`credential` vive en una tabla cuya policy de SELECT alcanza a roles no-admin?
**Fix canónico:** Mover el secreto a una tabla sin policy de SELECT para roles normales, o cifrarlo app-side (ej. AES-256-GCM) y exponer solo un campo write-only desde el panel.
**Regla:** Ningún secreto de integración es legible por una policy de tabla pensada para datos de negocio.
**Severidad:** crítica

### C-SEC-16 — Modelo de roles de dos capas con bypass de gate por prefijo mal derivado

**Síntoma:** Una subruta sensible queda accesible para un rol que la matriz de permisos debería bloquear.
**Causa:** El modelo tiene una capa de código (superset de permisos, aplicado por middleware/proxy) y una capa de matriz editable por tenant que solo debería recortar ese superset; el gate de la capa 2 deriva el prefijo de ruta del argumento heredado del layout padre en vez del pathname real de la request, y una subruta más específica se escapa.
**Detección:**
- [pregunta] ¿el gate de autorización de capa-2 recibe el prefijo de ruta como prop/arg heredado del layout, o lo calcula a partir del pathname real de la request?
**Fix canónico:** Derivar el prefijo más específico posible del pathname real en cada gate; la matriz de capa 2 solo puede recortar el superset de código, nunca ampliarlo, y la seguridad de datos la garantiza siempre RLS+claims, no la matriz.
**Regla:** El gate de autorización se calcula sobre la ruta real de la request, nunca sobre el argumento heredado de un layout.
**Severidad:** alta

### C-SEC-17 — Mutación privilegiada sin el guard de paridad de rango compartido

**Síntoma:** Un rol inferior logra reasignar o modificar un recurso que pertenece a un rol superior.
**Causa:** Existe un guard compartido "¿el que ejecuta tiene rango igual o mayor que el afectado?" pero una mutación puntual se implementó sin invocarlo.
**Detección:**
- [pregunta] de los mutadores que tocan el campo de rol/asignación de un recurso, ¿cuáles no invocan la función de guard de paridad compartida?
**Fix canónico:** Todo mutador que toca un recurso perteneciente a un rol invoca el mismo guard de paridad, sin excepciones.
**Regla:** Ninguna mutación privilegiada se implementa sin el guard de paridad compartido de rango.
**Severidad:** alta

### C-SEC-18 — Secretos que escapan su ciclo de vida seguro (git history / entornos compartidos)

**Síntoma:** Una credencial hardcodeada se borra del archivo pero sigue accesible en el historial de versiones; o un script de desarrollo apunta por error a la base de datos de producción.
**Causa:** Borrar el archivo no purga el historial de versiones; los scripts de desarrollo y los de runtime nunca se separaron explícitamente por proyecto/entorno.
**Detección:**
- [pregunta] ¿se revisó el historial completo de versiones contra patrones de credencial conocidos? ¿los scripts del repo distinguen explícitamente el entorno de desarrollo del de runtime al leer una env var de base de datos?
**Fix canónico:** Rotar la credencial filtrada siempre (borrar el archivo no alcanza); mantener proyecto/entorno de desarrollo completamente separado del de runtime.
**Regla:** Una credencial filtrada se rota siempre, nunca se asume "resuelta" solo por borrar el archivo del árbol actual.
**Severidad:** crítica

### C-SEC-19 — Webhook público sin verificación de firma sobre el body crudo, ni dedupe por evento

**Síntoma:** Un webhook público procesa payloads sin verificar su firma, o la verifica sobre el body ya parseado/re-serializado por el framework en vez del buffer crudo recibido; un actor sin credencial puede inyectar eventos falsos, y sin dedupe, un reintento del emisor duplica el efecto de negocio (doble alta, doble notificación).
**Causa:** El handler no verifica el HMAC antes de cualquier parseo/transformación del body — una comparación sobre el body ya parseado y re-serializado puede no coincidir byte a byte con lo que el emisor realmente firmó — y no existe una tabla/registro de eventos ya procesados consultado antes de aplicar el efecto.
**Detección:**
- [grep] handler bajo un path que incluye `webhook`/`hook` que llama `JSON\.parse\(` o consume el body ya parseado por el framework ANTES de invocar una función de verificación de firma (`verify.*[Ss]ignature|createHmac|timingSafeEqual`); ausencia de una tabla/registro (`processed_events`/`webhook_events`/columna `event_id` única) consultado antes de aplicar el efecto
**Fix canónico:** Verificar la firma HMAC sobre el buffer RAW del body (antes de cualquier `JSON.parse`), con comparación en tiempo constante; deduplicar por id de evento/lote contra una tabla de eventos ya procesados antes de aplicar cualquier efecto.
**Regla:** Ningún webhook público aplica un efecto sin verificar su firma sobre el body crudo y sin deduplicar por id de evento.
**Severidad:** alta

### C-SEC-20 — Callback OAuth sin validación del parámetro `state` (CSRF de conexión de cuenta)

**Síntoma:** Un flujo de login/conexión de cuenta de terceros vía OAuth redirige de vuelta a la app y confía en el código de autorización recibido sin verificar que el parámetro `state` coincide con uno generado y guardado por la app antes de redirigir al proveedor.
**Causa:** El handler de callback lee `code`/`state` de los query params e intercambia el código directo por un token, sin comparar el `state` recibido contra un valor guardado en sesión/cookie firmada al momento del redirect inicial.
**Detección:**
- [grep] handler de callback OAuth (path que incluye `callback`/`oauth`) que lee `code` de los query params e invoca el intercambio de token sin una comparación previa de `state` contra un valor leído de sesión/cookie firmada, en el mismo archivo
**Fix canónico:** Generar un `state` aleatorio antes del redirect al proveedor y guardarlo en una cookie firmada/httpOnly o en la sesión; en el callback, comparar el `state` recibido contra el guardado (en tiempo constante) antes de intercambiar el `code`, y rechazar la request si no coincide.
**Regla:** Ningún callback OAuth intercambia un código de autorización sin validar primero que el `state` devuelto coincide con el generado por la propia app.
**Severidad:** alta

## 2.2 Integridad de datos y concurrencia

### C-INT-01 — Read-modify-write con lost update bajo concurrencia

**Síntoma:** Dos requests concurrentes sobre el mismo recurso (ej. stock) pisan la escritura una de la otra; el resultado final queda mal aunque cada request individual sea válida.
**Causa:** El cálculo de "leer, sumar/restar en el lenguaje de aplicación, escribir" no es atómico; un CHECK de no-negativo en la columna evita valores negativos pero no evita que se pierda una escritura.
**Detección:**
- [grep] un SELECT seguido de aritmética en el lenguaje de aplicación y luego un UPDATE con el valor ya calculado, en vez de `UPDATE ... SET x = x + delta`
**Fix canónico:** RPC atómica con `SELECT ... FOR UPDATE` + `UPDATE SET x = x + delta` dentro de la misma transacción.
**Regla:** Ningún valor compartido bajo concurrencia se actualiza vía read-modify-write en el lenguaje de aplicación.
**Severidad:** crítica

### C-INT-02 — RPC atómica con locking determinístico (patrón a preservar)

**Síntoma:** N/A — esta entrada documenta un PATRÓN CORRECTO a no regresar, no un bug.
**Causa:** Sin este patrón, cualquier refactor futuro puede reintroducir un lost update o un deadlock bajo carga concurrente.
**Detección:**
- [señal] la RPC crítica (checkout/reserva) toma locks en orden determinístico sobre los recursos involucrados, deriva tenant/store del propio recurso (nunca de un parámetro del cliente), recalcula valores server-side y valida invariantes al final
**Fix canónico:** Mantener este patrón como única vía de mutar el recurso bajo concurrencia; toda variante nueva se revisa contra este contrato.
**Regla:** Todo camino de escritura concurrente sobre el mismo recurso pasa por esta RPC, nunca por un atajo paralelo.
**Severidad:** N/A (patrón a preservar)

### C-INT-03 — Agregado RLS-scoped que da no-op silencioso por diseño de policy

**Síntoma:** Un cálculo que necesita sumar filas de OTROS usuarios/entidades (ej. un neteo cross-entidad) siempre da cero o vacío para roles no-admin.
**Causa:** La policy de RLS vigente es "cada quien ve lo suyo", correcta para el resto del sistema, pero bloquea exactamente las filas que este agregado en particular necesita leer.
**Detección:**
- [pregunta] ¿este cálculo necesita ver filas de más de una entidad/usuario? ¿la policy actual se lo permite a algún rol?
**Fix canónico:** Una RPC `SECURITY DEFINER` dedicada que ve explícitamente todas las filas relevantes del scope correcto (sucursal/tenant), en vez de forzar la policy general.
**Regla:** Un agregado cross-entidad nunca se apoya en la policy pensada para acceso individual; tiene su propia RPC con su propio scope explícito.
**Severidad:** alta

### C-INT-04 — Import/bulk que sobreescribe filas no-matcheadas

**Síntoma:** Un import en modo "solo crear" termina pisando datos de filas que debían quedar intactas ("skip"), o le roba un identificador único a otra fila.
**Causa:** El modo create-only no excluye explícitamente las filas que matchean por otro criterio (ej. mismo código único) antes de escribir; el import bulk deliberadamente no-atómico agrava el efecto si además clobberea columnas no provistas.
**Detección:**
- [pregunta] en modo create-only/skip, ¿hay un filtro explícito que excluye toda fila matched ANTES del upsert, o el upsert corre sobre el dataset completo?
**Fix canónico:** Gate explícito: las filas skip/matched nunca entran al path de escritura; el upsert nunca clobberea columnas no provistas por la fila del import.
**Regla:** Un import create-only nunca sobreescribe una fila existente, ni directa ni indirectamente vía un identificador compartido.
**Severidad:** alta

### C-INT-05 — Truncar-antes-de-agregar en un reporte agrupado

**Síntoma:** Un top-N por grupo da totales incorrectos al consolidarse cross-grupo (ej. el "top 10" global no coincide con la suma de los top 10 por sucursal).
**Causa:** El truncado (LIMIT/top-N) se aplica ANTES de la agregación cross-grupo, descartando filas que sí debían sumar al total.
**Detección:**
- [pregunta] en un reporte con agrupación de dos niveles, ¿el LIMIT/top-N se aplica antes o después de consolidar el nivel superior?
**Fix canónico:** Agregar primero sobre el dataset completo; truncar (LIMIT/top-N) solo al final, sobre el resultado ya consolidado.
**Regla:** Ningún truncado ocurre antes de que la agregación relevante esté completa.
**Severidad:** media

### C-INT-06 — Valor derivado persistido como override explícito

**Síntoma:** Editar un campo que normalmente hereda de un padre (ej. precio, categoría) fija ese valor heredado como override permanente, aun cuando el usuario solo quería ver el valor vigente.
**Causa:** El formulario de edición expone el valor RESUELTO (heredado + override) en vez del override crudo, y guarda siempre lo que el usuario ve, sea o no una edición real.
**Detección:**
- [pregunta] ¿el input de edición muestra el valor resuelto o el override crudo (nullable)? ¿guardar sin tocar nada persiste igual un valor?
**Fix canónico:** Exponer el override nullable crudo en el formulario; persistir solo cuando el usuario efectivamente lo edita, nunca el valor heredado resuelto.
**Regla:** Solo se persiste un override cuando el usuario lo editó explícitamente, nunca el valor heredado de paso.
**Severidad:** media

### C-INT-07 — Expansión de enum en la misma transacción que su uso

**Síntoma:** Una migración que agrega un valor a un enum y lo usa en la misma transacción falla en tiempo de ejecución.
**Causa:** La expansión de un tipo enum no puede ejecutarse y consumirse dentro de la misma transacción en el motor de datos.
**Detección:**
- [grep] una sentencia de expansión de enum (`ALTER TYPE ... ADD VALUE`) y, en el mismo archivo de migración, un INSERT/UPDATE que use ese valor nuevo
**Fix canónico:** Aislar la expansión del enum en su propia migración/archivo, separado de cualquier uso del valor nuevo.
**Regla:** Ninguna migración usa en la misma transacción un valor de enum que ella misma acaba de crear.
**Severidad:** media

### C-INT-08 — Duplicación por doble-submit sin CAS ni unique compuesto

**Síntoma:** Un doble click o un reintento de red crea dos registros para la misma operación de negocio (ej. dos órdenes para el mismo checkout).
**Causa:** No hay una restricción de unicidad compuesta ni un update condicionado al estado esperado (CAS) que rechace la segunda escritura.
**Detección:**
- [pregunta] ¿existe un unique compuesto sobre las columnas que identifican la operación de negocio? ¿la transición de estado es un CAS (update `WHERE status = 'esperado'`) o un update incondicional?
**Fix canónico:** Defensa en capas: unique compuesto + CAS vía update condicionado al estado esperado + choke-point de máquina de estados + retry ante colisión.
**Regla:** Ninguna operación de negocio crítica se protege con un solo mecanismo; unique + CAS + choke-point, siempre los tres.
**Severidad:** alta

### C-INT-09 — Código de reserva con solo la mitad del flujo implementado

**Síntoma:** Una función de reserva de stock resta de una tabla de reservas, pero nunca hay un camino que inserte en ella; el contador de "reservado para vos" da siempre cero.
**Causa:** Se implementó el lado de consumo (restar reserva) sin implementar el lado de creación (reservar al agregar al carrito), dejando una ilusión de seguridad parcial.
**Detección:**
- [pregunta] la tabla de reservas, ¿tiene algún INSERT en el codebase además del/los DELETE/UPDATE que la consumen?
**Fix canónico:** Implementar reserve-on-add con expiración real, o eliminar el código muerto y documentar explícitamente que el stock solo se valida en checkout.
**Regla:** Una tabla de reservas sin un camino de inserción real es peor que no tenerla: da una falsa sensación de seguridad.
**Severidad:** alta

## 2.3 Plataforma de datos

### C-DB-01 — Tabla sin policy de UPDATE bajo RLS forzada

**Síntoma:** Una mutación sobre una tabla no lanza error, pero la fila simplemente no cambia.
**Causa:** RLS está forzada en la tabla pero nunca se agregó una policy de UPDATE; el motor de datos rechaza la escritura sin lanzar una excepción visible a la capa de aplicación.
**Detección:**
- [grep] tablas con RLS habilitada sin una policy `FOR UPDATE` correspondiente en el mismo conjunto de migraciones/policies
**Fix canónico:** Agregar la policy de UPDATE con el mismo scope que la de SELECT/INSERT ya vigente para esa tabla.
**Regla:** Toda tabla que necesita ser escrita en algún flujo tiene policy para cada operación que ese flujo ejecuta.
**Severidad:** alta

### C-DB-02 — Trigger de broadcast sin coalesce(NEW,OLD) ni orden de argumentos verificado

**Síntoma:** Un DELETE sobre la tabla dispara un error de referencia nula en el trigger de notificación en tiempo real; o el payload que llega al cliente tiene los campos en el orden equivocado.
**Causa:** El trigger asume que el registro nuevo siempre existe, pero en un DELETE ese valor es nulo; además la función que arma el mensaje de broadcast recibe los argumentos en un orden fácil de invertir sin que el tipo lo impida.
**Detección:**
- [grep] función de trigger que referencia el registro nuevo sin un `COALESCE(NEW, OLD)` previo, declarada para INSERT/UPDATE/DELETE combinados
**Fix canónico:** `COALESCE(NEW, OLD)` al inicio de la función de trigger; verificar explícitamente el orden de los argumentos posicionales de la función de envío.
**Regla:** Todo trigger que cubre DELETE maneja el registro nuevo nulo desde la primera línea.
**Severidad:** media

### C-DB-03 — Canal realtime privado sin policy de SELECT en la tabla de mensajes

**Síntoma:** El cliente recibe un error de canal al suscribirse a un canal privado, aunque el trigger que dispara el evento se ejecuta correctamente en el motor de datos.
**Causa:** El broadcast privado depende de una policy de SELECT sobre la tabla interna de mensajes de realtime, y esa policy nunca se agregó.
**Detección:**
- [pregunta] ¿existe una policy de SELECT sobre la tabla de mensajes de realtime, con un scope que autorice al actor esperado (staff con acceso a la sucursal, consumidor con sesión activa)?
**Fix canónico:** Agregar la policy de SELECT sobre la tabla de mensajes, con el mismo scope de negocio que protege los datos que el canal transmite.
**Regla:** Ningún canal privado de realtime funciona sin una policy de SELECT explícita sobre su tabla de mensajes.
**Severidad:** alta

### C-DB-04 — Orden de seed vs RLS forzada

**Síntoma:** Un script de seed falla o inserta datos incompletos apenas se fuerza RLS en el entorno.
**Causa:** El seed corre con un rol sujeto a RLS y la policy de INSERT exige condiciones que el propio proceso de seed no cumple; además, IDs hardcodeados no resuelven contra foreign keys reales en un reseed posterior.
**Detección:**
- [pregunta] ¿el script de seed corre antes de forzar RLS, o vía un rol que la bypassea (cliente con privilegios elevados/conexión directa)? ¿resuelve foreign keys por lookup o por id hardcodeado?
**Fix canónico:** Sembrar datos antes de forzar RLS, o explícitamente vía cliente con privilegios elevados/conexión directa; resolver siempre foreign keys por lookup idempotente, nunca por id fijo.
**Regla:** El seed nunca se bloquea a sí mismo por la misma RLS que protege los datos que crea.
**Severidad:** media

### C-DB-05 — Función con privilegios elevados sin search_path fijado

**Síntoma:** Una función con privilegios elevados es vulnerable a que un objeto con el mismo nombre en otro schema del search_path se resuelva en su lugar.
**Causa:** La función no fija el search_path explícitamente, por lo que hereda el de quien la invoca en vez de uno controlado por el autor de la función.
**Detección:**
- [grep] declaración de función con privilegios elevados (`SECURITY DEFINER`) sin una cláusula de search_path fijo en el mismo bloque
**Fix canónico:** Fijar el search_path explícito y acotado (ej. `pg_catalog, public`) en toda función con privilegios elevados.
**Regla:** Ninguna función con privilegios elevados corre sin un search_path explícito y acotado.
**Severidad:** alta

### C-DB-06 — Drift de schema entre definición ORM, migraciones SQL y tipos generados

**Síntoma:** Una query a una columna que "debería existir" explota en producción; en el caso extremo, el paso de build corrió generación de cliente pero nunca aplicó las migraciones, y el primer request post-deploy que toca la columna nueva falla.
**Causa:** Tres fuentes de verdad (definición del ORM, migraciones SQL, tipos generados) pueden divergir sin que nada las compare automáticamente; el pipeline de deploy separa "generar cliente" de "aplicar migraciones" y puede saltear el segundo paso silenciosamente.
**Detección:**
- [pregunta] ¿el paso de build/deploy aplica migraciones contra una conexión directa (no el pooler) en el mismo paso que regenera tipos? ¿hay un chequeo en CI que compare las tres fuentes?
**Fix canónico:** Generación automática de tipos en CI/pre-commit como fuente única derivada; el paso de build/deploy SIEMPRE aplica migraciones antes de servir tráfico nuevo; un error de columna faltante se clasifica y redirige a una página de error específica, no un 500 genérico.
**Regla:** Nunca hay más de un punto donde el schema real puede divergir de lo que el código asume, sin que CI lo detecte.
**Severidad:** media

### C-DB-07 — Tabla nueva org-scoped sin RLS y sin guard de CI que lo detecte

**Síntoma:** Una tabla agregada recientemente, que debería estar acotada por tenant, resulta legible o escribible cross-tenant.
**Causa:** RLS no se forzó en la tabla nueva al crearla, y no existe ningún chequeo automático que falle el build por esa omisión.
**Detección:**
- [pregunta] ¿existe un guard de CI que liste las tablas sin RLS habilitada y lo cruce contra un criterio de "org-scoped" (ej. tiene columna de tenant)?
**Fix canónico:** RLS forzada en toda tabla org-scoped desde su primera migración; un guard estático en CI falla el build si detecta una tabla nueva con columna de tenant sin RLS forzada.
**Regla:** Ninguna tabla con columna de tenant se mergea sin RLS forzada y sin que el guard de CI la haya visto.
**Severidad:** crítica

### C-DB-08 — Rol de conexión directa usado por error en el path de usuario en runtime

**Síntoma:** Una query del flujo de usuario en producción se ejecuta sin pasar por RLS, aunque el usuario tiene un JWT válido.
**Causa:** El código usa por error el rol/conexión directa (reservado para admin/migraciones, que bypassea RLS) en un path que debería ir siempre autenticado a través del cliente con JWT.
**Detección:**
- [pregunta] ¿algún camino de código que atiende requests de usuario usa la conexión/rol directo de base de datos, en vez de reservarla para scripts de migración/admin?
**Fix canónico:** El path de usuario en runtime SIEMPRE usa el cliente autenticado con JWT; el rol de conexión directa se reserva exclusivamente para admin/migraciones.
**Regla:** Ninguna request de usuario en runtime toca el motor de datos por un canal que bypassea RLS.
**Severidad:** crítica

### C-DB-09 — SQL dinámico más allá de un allowlist seguro

**Síntoma:** Una función construye SQL dinámico interpolando un nombre de tabla/columna que en teoría viene de un input controlado, pero sin restricción explícita contra una lista cerrada.
**Causa:** Se usa ejecución de SQL formateado dinámicamente para resolver un nombre de tabla/columna sin validarlo contra un allowlist hardcodeado, abriendo la puerta a inyección si el input deja de estar tan controlado como se asumió.
**Detección:**
- [grep] construcción de SQL dinámico (ej. `EXECUTE format`) sin una validación previa contra un array/enum fijo de nombres permitidos en la misma función
**Fix canónico:** Todo SQL dinámico de nombres de tabla/columna se valida contra un allowlist hardcodeado antes de interpolar; el resto de los valores va siempre parametrizado por el driver.
**Regla:** El único SQL dinámico permitido es el que resuelve un nombre contra un allowlist cerrado; ningún valor de dato se interpola nunca.
**Severidad:** alta

### C-DB-10 — TIMESTAMP sin timezone + timezone de sesión que deriva

**Síntoma:** El mismo instante persistido en dos momentos distintos muestra un offset distinto; una auditoría o un respaldo deja de ser confiable porque el "mismo momento" no es comparable entre filas.
**Causa:** Una columna se declaró como timestamp sin zona horaria, y el valor se interpreta contra la timezone de SESIÓN de la conexión en vez de una fija; si esa timezone de sesión cambia entre conexiones, el mismo instante queda persistido con offset distinto.
**Detección:**
- [pregunta] ¿hay columnas de timestamp sin zona horaria en tablas de auditoría/negocio? ¿la conexión nueva fija explícitamente su timezone, o hereda la de la sesión?
**Fix canónico:** Usar timestamp con timezone y fijar la timezone de la conexión a UTC de forma explícita; anclar los buckets de agregación diaria/mensual a la timezone de NEGOCIO solo en la capa de presentación, nunca en el motor de datos.
**Regla:** El motor de datos siempre persiste y compara en UTC; la timezone de negocio es una decisión de la vista, no del storage.
**Severidad:** media

### C-DB-11 — Cliente confía en el payload de un evento realtime en vez de refetchear el estado real

**Síntoma:** Un cliente recibe un evento de tiempo real (broadcast/pub-sub) y actualiza su UI directamente con los datos que vinieron en el payload del evento, en vez de usarlo solo como señal para refetchear el estado real; la UI puede quedar mostrando datos parciales, obsoletos, o inconsistentes con lo que autoriza el scope propio del cliente.
**Causa:** El payload de un evento de tiempo real no pasa necesariamente por la misma capa de autorización que una query normal; escribir ese payload directo al estado de UI asume una garantía de autorización y completitud que el canal realtime no ofrece.
**Detección:**
- [señal] un handler de evento de tiempo real que hace `setState(payload.datos)` (o equivalente) en vez de disparar un refetch/invalidación de query a través del mismo camino autorizado que usa la carga inicial de la página
**Fix canónico:** El payload de un evento en tiempo real lleva solo identificadores mínimos (qué cambió, no el valor); el cliente siempre refetchea el estado real a través del mismo camino autorizado que usa para cargar la página.
**Regla:** Ningún cliente confía en el valor de un payload de evento realtime como fuente de verdad — el evento es solo la señal para refetchear.
**Severidad:** media

## 2.4 Runtime (framework y librerías de UI)

Estas clases escapan al typecheck y al build porque viven en las costuras entre el modelo de
ejecución del framework (ciclo de vida del request, límite servidor→cliente, hidratación) y
supuestos que el código da por sentado. Dos clases del catálogo original de runtime pitfalls son,
en rigor, de plataforma de datos y viven en `C-DB` (con cross-ref desde acá, no duplicadas):
timezone de sesión del motor de datos que deriva sobre columnas sin timezone, y drift de schema al
desplegar que explota recién en la primera query que toca una columna nueva.

### C-RUN-01 — Helper de memoización por-request pierde su alcance fuera del render

**Síntoma:** un holder de estado que "vive por request" (ej. el scope de tenant activo) aparece vacío o con datos de otro request dentro de una acción de servidor o un route handler.
**Causa:** el helper de memoización "por request" del framework solo comparte instancias durante el render de componentes de servidor; en acciones de servidor y route handlers siempre devuelve una instancia fresca, aunque la firma de la función sea idéntica.
**Detección:**
- [pregunta] ¿el mismo holder de estado "por-request" se invoca tanto desde el render como desde una acción de servidor o un route handler? Si sí, verificar que no dependa de identidad de instancia entre ambos.
**Fix canónico:** reemplazar el holder por un contexto de ejecución asíncrono explícito (tipo AsyncLocalStorage) con `.run()` alrededor de todo el ciclo de vida del request, no solo del render.
**Regla:** un helper de memoización por-request del framework nunca sustituye a un contexto de ejecución asíncrono explícito fuera del árbol de render.
**Severidad:** alta

### C-RUN-02 — La entrada a un contexto de ejecución asíncrono no se propaga hacia arriba

**Síntoma:** un valor seteado dentro de una función anidada (ej. resolver el tenant activo) no está disponible para el caller después de un `await`, aunque sí lo esté dentro de la función anidada misma.
**Causa:** el "entrar en contexto" de un storage de ejecución asíncrono aplica solo al frame actual y sus descendientes directos; llamarlo dentro de una función que luego se await-ea no afecta al frame del caller una vez resuelta la promesa.
**Detección:**
- [pregunta] ¿el `.enterWith()` (o equivalente) del contexto asíncrono se llama dentro de una función auxiliar en vez de en el mismo frame que después hace las queries?
**Fix canónico:** envolver la operación completa con `.run(valor, callback)` en el mismo frame que necesita leerlo, o setear el contexto antes del primer await del propio caller.
**Regla:** un contexto de ejecución asíncrono se entra en el frame que lo necesita, nunca en un helper anidado que el caller simplemente await-ea.
**Severidad:** alta

### C-RUN-03 — Value de un Provider sin memoizar dispara loops de efectos o acciones

**Síntoma:** un componente consumidor entra en loop de renders, efectos o llamadas a acciones de servidor sin ningún cambio de estado real visible.
**Causa:** el `value` del Provider se arma como objeto/array inline en cada render, generando una nueva referencia aunque el contenido sea igual; cualquier efecto o callback que lo tenga en sus dependencias se dispara en cada render.
**Detección:**
- [grep] `<\w+\.Provider\s+value=\{\{`
**Fix canónico:** memoizar el `value` del provider (y los handlers que expone) con el hook de memoización correspondiente, con dependencias explícitas y estables.
**Regla:** ningún `value` de contexto se arma inline; si el objeto tiene más de una key, se memoiza.
**Severidad:** alta

### C-RUN-04 — Efecto con dependencia de función inestable entra en loop o roba el foco

**Síntoma:** loop de ejecución sin fin, o (variante) un input pierde el foco a cada tecla y no deja escribir la segunda letra.
**Causa:** el efecto depende de una función recreada en cada render; en la variante de foco, un modal hace foco inicial dentro de un efecto que depende de ese callback, así que cada tecla vuelve a disparar el "foco inicial".
**Detección:**
- [grep] `useEffect\(.*\[.*\b(on\w+|handle\w+)\b.*\]` — revisar a mano si la función en la dep list está memoizada.
**Fix canónico:** un efecto de "una vez al abrir" (foco inicial, animación de entrada) depende solo del flag de abierto/visible, nunca de un callback.
**Regla:** ninguna dependencia de efecto es una función sin memoizar cuando el efecto solo debe correr una vez.
**Severidad:** media

### C-RUN-05 — Estado inicializado desde un prop servido por el servidor queda congelado

**Síntoma:** la UI no refleja un valor actualizado tras un refresh de navegación o un cambio de query param en la misma ruta ("pestaña congelada").
**Causa:** `useState(prop)` solo lee el prop en el primer render/montaje; un refresh del router o un cambio de URL en la misma ruta no vuelve a montar el componente, así que el estado inicial nunca se recalcula.
**Detección:**
- [grep] `useState\((props?\.\w+|searchParams)`
**Fix canónico:** derivar el valor directamente del prop/URL en cada render (sin `useState` intermedio), o forzar remount con una `key` ligada al identificador que cambia.
**Regla:** un valor que viene del servidor o de la URL se lee derivado, nunca se copia una sola vez a `useState`.
**Severidad:** media

### C-RUN-05b — La invalidación de cache no cruza el límite de tenant en flujos cross-tenant

**Síntoma:** un actor con permiso para escribir en el espacio de otro tenant (ej. soporte/plataforma) no ve reflejado su cambio hasta que el afectado refresca manualmente.
**Causa:** la invalidación de cache dispara para el scope del actor que ejecuta la mutación, no para el scope del tenant afectado, cuando ambos son distintos.
**Detección:**
- [pregunta] ¿existe un flujo donde un rol de plataforma/soporte escribe en el tenant de otro? Si sí, ¿a qué tenant está scopeada la invalidación de cache?
**Fix canónico:** no se "arregla" en general — se documenta explícitamente como limitación conocida; si el flujo es crítico, invalidar el scope del tenant afectado, no el del actor.
**Regla:** una invalidación de cache cross-tenant es una limitación conocida y documentada, no un supuesto implícito.
**Severidad:** baja

### C-RUN-06 — Editor de fila no controlado escribe el valor de la fila anterior

**Síntoma:** el usuario abre el editor de una fila de una tabla/lista, no toca nada, guarda, y el valor persistido es el de la fila que editaba antes (corrupción silenciosa, sin error visible).
**Causa:** variante concreta de C-RUN-05: un input no controlado se inicializa con `useState(row.value)` sin remount por fila; al cambiar de fila el componente no se desmonta y conserva el estado interno de la fila previa.
**Detección:**
- [grep] `useState\(\s*(row|item|record)\.\w+\s*\)` sin un `key={` correspondiente en el elemento padre de la lista.
**Fix canónico:** `key={rowId}` en el elemento de fila (fuerza remount al cambiar de fila) + input controlado por el valor real de la fila, no por un snapshot inicial.
**Regla:** todo editor inline dentro de una lista lleva `key` por identificador de fila; ninguna fila comparte estado local con otra.
**Severidad:** crítica

### C-RUN-07 — Un flag de "aislamiento activo" en config no desactiva policies ya aplicadas en el motor de datos

**Síntoma:** apagar un flag de configuración (ej. `ISOLATION_ENFORCED=false`) no cambia nada observable — incluso el login se bloquea.
**Causa:** las reglas de aislamiento (policies a nivel de motor de datos) viven en el motor de datos, no en la app; un flag de aplicación no las retira. Sin el rol/bypass correcto configurado, cualquier acceso sigue evaluándose contra esas policies.
**Detección:**
- [pregunta] ¿existe un flag booleano de aplicación cuyo nombre sugiere controlar el aislamiento/las policies, sin un rol de bypass real detrás?
**Fix canónico:** para un "aislamiento off" real hace falta un rol de conexión con bypass explícito y auditado; un flag de config, si existe, debe ser puramente informativo.
**Regla:** el aislamiento de datos se desactiva en el motor de datos o no se desactiva; ningún flag de aplicación lo controla por sí solo.
**Severidad:** alta

### C-RUN-08 — Link a una ruta que redirige server-side cuelga el navegador por loop de prefetch

**Síntoma:** la pestaña se cuelga (deja de responder) sin ningún request de servidor visible en las herramientas de red — todo pasa client-side.
**Causa:** el framework prefetchea automáticamente los links visibles en pantalla; si el destino hace un `redirect()` server-side hacia una ruta que a su vez apunta de vuelta (directa o indirectamente), el prefetch entra en ciclo.
**Detección:**
- [grep] `redirect\(['"]` en un archivo de ruta, cruzado a mano contra `router\.push\(|<Link href=` apuntando a esa misma ruta desde otros archivos.
**Fix canónico:** los links internos apuntan siempre al destino final, nunca a una ruta que redirige; los redirects de compatibilidad usan una respuesta de redirect permanente cacheable.
**Regla:** al convertir una página en un simple redirect, se re-apuntan todos los links y navegaciones programáticas que apuntaban a ella.
**Severidad:** alta

### C-RUN-09 — Un archivo de acciones de servidor que exporta algo no-async rompe el BUILD

**Síntoma:** el build falla con un error de bundling; el typecheck había pasado limpio.
**Causa:** un archivo marcado como "solo acciones de servidor" solo puede exportar funciones async; exportar una constante, un objeto o un tipo desde ahí rompe el empaquetado porque el bundler trata ese módulo entero como una frontera server/client.
**Detección:**
- [grep] `^export (const|type|interface)` dentro de un archivo con la directiva de acciones de servidor en la cabecera.
**Fix canónico:** mover toda constante/tipo/objeto a un módulo normal de lógica pura; el archivo de acciones exporta únicamente funciones async.
**Regla:** un archivo de acciones de servidor exporta solo funciones async — cero excepciones, ni siquiera un tipo.
**Severidad:** media

### C-RUN-09b — Re-exportar un TIPO desde un archivo de acciones de servidor crashea en RUNTIME, no en build

**Síntoma:** typecheck y build pasan limpios; la ruta que usa esa acción crashea en producción (o en un test E2E) con un error de referencia indefinida.
**Causa:** variante distinta de C-RUN-09 (que cubre el crash de build por exportar una const/objeto): acá se hace `export type { X } from './modulo'` dentro del archivo de acciones. El tipo se borra en compilación como es esperable, pero el bundler igual emite una referencia runtime hacia ese nombre ya borrado porque no distingue ese re-export de uno de valor real; el crash ocurre recién cuando algo en runtime intenta resolverlo.
**Detección:**
- [grep] `^export type \{` o `^export \{ type ` dentro de un archivo con la directiva de acciones de servidor en la cabecera.
**Fix canónico:** los tipos viven siempre en el módulo de lógica pura y nunca se re-exportan (ni como tipo) desde el archivo de acciones.
**Regla:** un archivo de acciones de servidor no re-exporta nada de otro módulo, ni siquiera un tipo — se importa donde se necesita.
**Severidad:** crítica

### C-RUN-10 — CSP bloquea silenciosamente un host de storage de terceros

**Síntoma:** la subida de un archivo/imagen funciona, pero la imagen nunca se muestra (sin error visible en UI, solo en la consola del navegador).
**Causa:** el host de la URL firmada de storage está autorizado en la directiva de conexión de la CSP (por eso la subida funciona) pero no en la directiva de imágenes, así que el navegador bloquea el `<img>` en silencio.
**Detección:**
- [grep] `img-src` en la config de CSP, comparado a mano contra los hosts reales de storage usados por la app.
**Fix canónico:** al servir un recurso desde un host nuevo, agregarlo a todas las directivas de CSP relevantes para ese tipo de recurso, no solo `connect-src`; reiniciar el servidor de desarrollo tras cambiar la config de CSP.
**Regla:** cada host nuevo de recursos se audita contra cada directiva de CSP que aplica al tipo de recurso que sirve, no solo una.
**Severidad:** media

### C-RUN-11 — Avatar/imagen circular se deforma por object-fit + reflow de flex

**Síntoma:** una imagen que debería verse circular aparece ovalada o estirada, típicamente al cambiar el contenido de un hermano flex.
**Causa:** el contenedor de la imagen no tiene dimensiones fijas; usar solo `border-radius` + `object-fit` sobre un tamaño que depende del layout flex circundante hace que cualquier reflow cambie el aspect ratio real del contenedor.
**Detección:**
- [señal] revisión visual con contenido de longitud variable en los elementos flex hermanos de un avatar.
**Fix canónico:** contenedor cuadrado de tamaño fijo, `overflow: hidden`, `flex-shrink: 0`; la imagen adentro con `object-fit: cover` y `object-position: center`.
**Regla:** todo avatar/thumbnail circular vive en un contenedor cuadrado de tamaño fijo con no-shrink, nunca en un elemento cuyo tamaño depende del layout.
**Severidad:** baja

### C-RUN-12 — Librería de animación con estado final aplicado desde el montaje produce mismatch de hidratación

**Síntoma:** warning de hidratación en consola y/o un parpadeo visual al cargar una página pre-renderizada estáticamente.
**Causa:** la librería de animación aplica el estado "animate" (destino final) inmediatamente en el primer render, pero el HTML pre-renderizado en el servidor se generó con el estado inicial ("from"); el DOM del cliente no matchea el del servidor en el primer paint.
**Detección:**
- [grep] `animate=\{|initial=\{` en componentes usados dentro de páginas generadas estáticamente.
**Fix canónico:** gatear la animación con un flag `mounted` (placeholder estático hasta después del montaje) o disparar la animación al entrar en viewport en vez de al montar.
**Regla:** ninguna animación de entrada corre antes de confirmar que el componente ya está montado en el cliente, si la página se pre-renderiza estáticamente.
**Severidad:** media

### C-RUN-13 — Fetch a un servicio de terceros hecho desde el navegador en vez de server-side

**Síntoma:** el fetch nunca llega a destino (bloqueado por CSP) o, peor, sí llega — exponiendo en las herramientas de red la credencial/API key usada en el request.
**Causa:** el componente de UI hace la llamada directo al tercero; una CSP correctamente configurada excluye APIs de terceros del navegador, así que en el mejor caso el fetch se bloquea y en el peor caso la credencial nunca debió estar en el bundle del cliente.
**Detección:**
- [grep] `fetch\(['"]https?://` dentro de un archivo marcado como componente de cliente.
**Fix canónico:** todo fetch a un tercero vive server-side (acción de servidor o route handler); el componente de UI queda puramente presentacional.
**Regla:** ningún fetch a un dominio de terceros se origina en el navegador, sin excepción.
**Severidad:** alta

### C-RUN-14 — `crypto.randomInt` con un rango extremo explota al endurecerse el runtime

**Síntoma:** la generación de un token/código funciona en desarrollo y deja de funcionar (excepción en runtime) después de actualizar el runtime o el framework, sin ningún cambio en el código propio.
**Causa:** el rango pasado a la función nativa de enteros aleatorios (ej. `randomInt(0, 2**48)`) excede el límite que versiones más nuevas y endurecidas del runtime aceptan; versiones viejas lo toleraban en silencio.
**Detección:**
- [grep] `randomInt\(\s*\d+,\s*2\s*\*\*\s*\d{2,}`
**Fix canónico:** generar tokens opacos con `randomBytes(n).toString('base64url')` en vez de pedir un entero en un rango extremo.
**Regla:** ningún generador de tokens/códigos pide un entero aleatorio en un rango mayor al que el runtime garantiza soportar.
**Severidad:** alta

### C-RUN-15 — Logout como acción de servidor con redirect a través del middleware rompe el parseo de la respuesta

**Síntoma:** al hacer logout, la UI muestra un error genérico tipo "unexpected response" en vez de completar el logout y navegar.
**Causa:** el parser de respuesta de las acciones de servidor no sabe leer un redirect que atraviesa el middleware de la app; una acción de servidor no es equivalente a un route handler nativo para este flujo específico.
**Detección:**
- [grep] `'use server'` en el mismo archivo/función que dispara el sign-out o el redirect de logout, con middleware activo sobre esa ruta.
**Fix canónico:** implementar el logout como route handler nativo (POST que responde con un redirect atado directo a la respuesta HTTP), no como acción de servidor.
**Regla:** un flujo de logout con redirect a través del middleware se implementa como route handler, nunca como acción de servidor.
**Severidad:** media

### C-RUN-16 — Un componente de imagen con `src=""` (string vacío) crashea

**Síntoma:** la página crashea (no un simple ícono roto) cuando el dato de imagen es un string vacío.
**Causa:** el componente de imagen del framework trata `src=""` distinto de `null`/`undefined` — un string vacío no dispara el fallback, dispara una excepción.
**Detección:**
- [grep] `src=\{[\w.]+\}` sin normalización previa de vacío→null en el mismo archivo o en la capa de datos.
**Fix canónico:** normalizar el campo a `null` en la consulta/capa de datos cuando venga vacío, y renderizar el componente de imagen condicionalmente con placeholder cuando el valor es `null`.
**Regla:** un campo de imagen opcional se normaliza a `null` antes de llegar al componente de imagen — nunca se le pasa un string vacío.
**Severidad:** media

### C-RUN-17 — Un insert/mutación "fire-and-forget" no llega a completarse en un entorno serverless

**Síntoma:** una escritura best-effort (ej. un log de auditoría o un evento de analítica) se pierde de forma intermitente, sin ningún error visible.
**Causa:** la función serverless se congela/recicla apenas termina de responder al cliente; si esa escritura no tiene un `await` que la ate al ciclo de vida del handler, puede quedar en vuelo cuando el runtime la congela.
**Detección:**
- [grep] `\.insert\(|\.(insert|update)\(` sin un `await` inmediatamente antes en el mismo bloque, dentro de un handler serverless.
**Fix canónico:** aunque sea "best-effort" y no bloquee la respuesta al usuario, si es la última operación del handler se debe awaitear antes de retornar.
**Regla:** ninguna escritura, ni siquiera best-effort, queda sin `await` si es la última operación de un handler serverless.
**Severidad:** alta

### C-RUN-18 — Default multi-tenant a "la primera opción alfabética" aterriza al usuario en un scope vacío

**Síntoma:** un usuario nuevo (o una demo) entra al producto y ve todo vacío/roto, aunque haya datos reales en otros scopes a los que tiene acceso.
**Causa:** el selector de tenant/sucursal por defecto ordena las opciones alfabéticamente y toma la primera, en vez de resolver una con actividad real; el primer scope alfabético frecuentemente no es el que tiene datos.
**Detección:**
- [grep] `\.sort\(\)\[0\]` o `\[0\]\.\w+` cerca de la resolución del scope activo por defecto.
**Fix canónico:** selector funcional persistido (cookie/preferencia) + un resolver central que defaultea a un scope con actividad real, nunca al primero alfabético.
**Regla:** ningún default de scope/tenant se decide por orden alfabético — se resuelve por actividad real o preferencia explícita del usuario.
**Severidad:** media

### C-RUN-19 — Fechas serializadas a string antes de cruzar el borde servidor→cliente

**Síntoma:** warning/mismatch de hidratación en tablas o gráficos que muestran fechas, o un formato distinto entre el primer render y los siguientes.
**Causa:** un objeto de fecha nativo cruza el borde servidor→cliente sin serializar explícitamente; cada entorno puede formatearlo distinto según su configuración regional/de timezone por defecto.
**Detección:**
- [grep] `: Date\b` en el tipo de una prop de un componente cliente, o un valor de fecha nativo pasado directo a un componente marcado como cliente.
**Fix canónico:** serializar toda fecha a string (ISO) en el servidor antes de pasarla al componente cliente; formatear al string final ya del lado del cliente con el gate de formateo único del producto.
**Regla:** ninguna fecha cruza el borde servidor→cliente como objeto nativo — cruza como string ya serializado.
**Severidad:** baja

## 2.5 UX / producto

Clases donde el código "funciona" en el sentido estricto (no crashea, pasa el tipo) pero el
producto miente, esconde datos o pierde confianza. Se distinguen de los principios de baseline
(Parte 1 §1.7) en que acá el foco es el patrón de bug concreto y su detección, no la norma general.

### C-UX-01 — Números que el usuario ve dos veces se calculan en dos lugares distintos (drift de pricing)

**Síntoma:** el mismo valor (ej. el total a pagar) difiere entre dos pantallas del mismo flujo, aunque el usuario no cambió nada.
**Causa:** cada pantalla recalcula el número con su propia lógica ad-hoc en vez de llamar a una única función pura sobre los mismos inputs; cualquier ajuste (redondeo, un descuento, un cargo) se actualiza en un lugar y se olvida en el otro.
**Detección:**
- [grep] la misma fórmula de cálculo (ej. `precio.*\*.*cantidad|subtotal.*\+.*envio`) repetida en más de un archivo de UI/lógica de negocio.
**Fix canónico:** una sola función pura de pricing/cálculo, testeada, invocada desde todos los puntos donde el número se muestra o se persiste.
**Regla:** todo número que el usuario ve más de una vez sale de una única fuente de cálculo — nunca se duplica la fórmula.
**Severidad:** crítica

### C-UX-02 — Animaciones con reduced-motion respetado a medias dejan estados incompletos

**Síntoma:** con la preferencia de movimiento reducido activada, un elemento queda a mitad de una transición (semi-transparente, desplazado, oculto) en vez de en su estado final correcto.
**Causa:** el chequeo de la preferencia de movimiento reducido desactiva la animación pero no fuerza el estado final del elemento — el componente asume que la animación siempre corre para llegar a ese estado.
**Detección:**
- [grep] `prefers-reduced-motion` en el CSS/JS del proyecto, cruzado a mano contra si cada animación que matchea fija también un estado final explícito, no solo `animation: none`.
**Fix canónico:** todo elemento animado define su estado final completo de forma independiente de si la animación corrió; con movimiento reducido, se aplica ese estado final directo, sin paso intermedio.
**Regla:** la preferencia de movimiento reducido nunca es "apagar la animación" a secas — es "saltar directo al estado final visualmente completo".
**Severidad:** media

### C-UX-03 — Fechas de negocio agregadas con UTC crudo en vez de la zona horaria del negocio

**Síntoma:** un reporte o bucket diario/mensual muestra un registro en el día equivocado, típicamente desplazado unas horas cerca de la medianoche.
**Causa:** la agregación trunca la fecha con UTC crudo (ej. `toISOString().slice(0,10)`) en vez de anclarla primero a la zona horaria del negocio. La causa raíz a nivel de motor de datos (timezone de sesión/conexión) se documenta en C-DB; acá es la manifestación en la capa de presentación/agregación.
**Detección:**
- [grep] `toISOString\(\)\.slice\(0,\s*10\)` o `toISOString\(\)\.split\('T'\)\[0\]` en código de agregación/reportes.
**Fix canónico:** construir el "día" de negocio anclado explícitamente a la zona horaria del negocio antes de truncar, nunca sobre UTC crudo.
**Regla:** ningún bucket de fecha de negocio se calcula truncando UTC crudo — siempre se ancla primero a la zona horaria del negocio.
**Severidad:** alta

### C-UX-04 — Un valor de enum sin rama en un filtro de UI hace desaparecer el registro

**Síntoma:** un registro con un estado válido simplemente no aparece en ninguna vista filtrada — sin error, sin indicio de que existe.
**Causa:** el filtro de UI (o el mapeo de color/ícono/label por estado) cubre los valores conocidos al momento de escribirlo con un `if`/`switch` no exhaustivo; un valor de enum agregado después no matchea ninguna rama y cae en un default silencioso u omitido.
**Detección:**
- [grep] `switch\s*\(.*(status|estado)` sin un `default` que loguee/alerte, o un `if/else if` encadenado sobre un enum sin manejo final visible.
**Fix canónico:** un exhaustive-check (ej. una función que fuerza tipo `never` en el default) que falle en compilación si se agrega un valor de enum nuevo sin cubrirlo.
**Regla:** todo filtro/mapeo sobre un enum de dominio tiene cobertura exhaustiva verificada en compilación, nunca un default silencioso que descarta.
**Severidad:** alta

### C-UX-05 — Un error de query tragado se muestra como "sin datos"

**Síntoma:** una vista muestra un estado vacío (lista sin resultados) cuando en realidad la consulta falló (permiso denegado, timeout, error del motor de datos).
**Causa:** el código ignora el campo de error de la respuesta de la consulta y devuelve/renderiza un array vacío por default; un fallo real de autorización o del motor de datos es indistinguible de "no hay resultados".
**Detección:**
- [grep] `const \{ data \}` o `data ?? \[\]` sin desestructurar ni chequear `error` en el mismo bloque.
**Fix canónico:** chequear el campo de error explícitamente y renderizar un estado de error-con-retry distinto del estado vacío; boundary de error/loading por segmento de UI.
**Regla:** "vacío" y "error" son dos estados de UI distintos, nunca el mismo — un error nunca se degrada silenciosamente a lista vacía.
**Severidad:** alta

### C-UX-06 — Una acción de compliance/legal no persiste de verdad

**Síntoma:** el usuario ejecuta una acción con peso legal (ej. una retracción/derecho de arrepentimiento), el botón cambia de estado, pero un refresh de página la revierte por completo.
**Causa:** la acción solo actualiza estado local/en memoria del cliente (optimista) sin una escritura real al backend, típicamente porque el flujo se armó rápido como puramente visual y nunca se conectó a una mutación real.
**Detección:**
- [pregunta] para cada acción con implicancia legal/de compliance (retracción, consentimiento, baja de cuenta): ¿hay una fila persistida con timestamp que lo demuestre, o solo un cambio de estado en el cliente?
**Fix canónico:** toda acción legal/de compliance dispara una mutación real con registro persistido (quién, qué, cuándo), auditada igual que cualquier otra mutación sensible.
**Regla:** ninguna acción con peso legal se implementa como puramente optimista/cliente — si no persiste, no pasó.
**Severidad:** crítica

### C-UX-07 — Duplicación de eventos por churn de hardware sin debounce

**Síntoma:** una sola acción física (ej. un escaneo de código con la cámara) dispara el evento de negocio dos o más veces (doble alta, doble descuento de stock).
**Causa:** el sensor/cámara emite múltiples lecturas/frames para el mismo evento físico en un lapso corto; sin una referencia estable + debounce, cada lectura se procesa como un evento nuevo e independiente.
**Detección:**
- [pregunta] ¿el handler de un evento de hardware (cámara, sensor, lector) tiene una guarda de referencia estable + ventana de debounce antes de disparar la mutación de negocio?
**Fix canónico:** una referencia estable del último valor procesado + una ventana de debounce corta antes de disparar la mutación asociada al evento.
**Regla:** ningún evento originado en hardware dispara una mutación de negocio sin pasar antes por una guarda de debounce con referencia estable.
**Severidad:** media

## 2.6 Testing (clases de bug del testing)

Acá van solo clases de bug DEL testing (la suite miente sobre lo que protege). El estándar de
testing en sí — pirámide, extracción de lógica pura, tenants efímeros, guards estáticos — vive en
la Parte 4, no acá.

### C-TEST-01 — Test falso-verde contra una réplica local de la función, no el símbolo real

**Síntoma:** el test pasa en verde, pero un bug real en producción no lo detecta ni lo detectó nunca — el test "protegía" código que no es el que corre.
**Causa:** el test importa o reimplementa una copia manual de la lógica (ej. una función reescrita a mano dentro del propio archivo de test) en vez de invocar el símbolo real que usa el código de producción; cualquier divergencia entre ambos queda invisible.
**Detección:**
- [señal] el test define su propia versión de la función bajo prueba (una copia/paráfrasis) en vez de importarla del módulo real.
**Fix canónico:** importar e invocar el símbolo real desde su módulo de producción, mockeando solo las dependencias externas (ej. una función de cookies/red), nunca la lógica bajo prueba.
**Regla:** un test invoca siempre el símbolo real usado en producción — se mockea la dependencia externa, jamás la unidad bajo prueba.
**Severidad:** crítica

### C-TEST-02 — Assertion débil que no verifica el efecto observable real

**Síntoma:** el test pasa en verde incluso cuando el comportamiento que debería garantizar no ocurrió (ej. una invalidación de cache que nunca se llamó).
**Causa:** el test verifica una señal indirecta y débil (ej. solo el status code de la respuesta, o que la función no tiró excepción) en vez de afirmar el efecto observable específico que el fix garantiza.
**Detección:**
- [señal] el test tiene un solo `expect` genérico (status 200 / no-throw) para un caso que su propio nombre/descripción describe como un efecto específico.
**Fix canónico:** afirmar el efecto observable real y específico (ej. que la función de invalidación fue llamada con los argumentos correctos, o el estado final persistido), no un proxy genérico de "no crasheó".
**Regla:** una assertion prueba el efecto que el test dice probar en su nombre, no un proxy débil de que "algo pasó".
**Severidad:** alta

### C-TEST-03 — Un "aviso informativo" se implementa por error como gate bloqueante, y ningún test lo cubre

**Síntoma:** un flujo que debía solo advertir (ej. un aviso de expiración, un warning de plan) termina bloqueando la acción del usuario en producción; nadie lo detectó antes del deploy.
**Causa:** al implementar el aviso se usa el mismo mecanismo que un gate real (deshabilitar el botón, un `return` temprano) en vez de un mecanismo puramente informativo; la suite solo cubre "el aviso se muestra", nunca "la acción principal sigue siendo posible con el aviso mostrado".
**Detección:**
- [pregunta] para cada aviso informativo del producto: ¿existe un test que verifique explícitamente que la acción asociada sigue completándose con el aviso visible?
**Fix canónico:** un test dedicado por cada aviso informativo que asegure que la acción principal se completa igual con el aviso presente, además del test de que el aviso se muestra.
**Regla:** todo aviso informativo tiene un test de que NO bloquea, no solo un test de que se muestra.
**Severidad:** alta

### C-TEST-04 — Scripts de verificación manual ad-hoc como única cobertura de integración

**Síntoma:** la confianza de que un flujo crítico funciona depende de correr a mano un script suelto antes de cada release; nadie lo corre en CI, y regresa sin que nadie se entere.
**Causa:** el script nació como una forma rápida de verificar algo puntual durante el desarrollo y nunca se convirtió en un test de integración estructurado y reproducible; queda como la única cobertura real de ese camino.
**Detección:**
- [grep] carpeta de scripts sueltos (`scripts/verify-*`, `scripts/check-*`) que no se invocan desde ningún job de CI ni desde la suite de tests.
**Fix canónico:** convertir cada script de verificación ad-hoc en un test de integración estructurado que corre en CI; lo que queda en la carpeta de scripts es tooling (seeds, guards de auditoría), no cobertura de tests.
**Regla:** ningún camino crítico depende de un script manual como única red de seguridad — todo lo que verifica un comportamiento es un test reproducible en CI.
**Severidad:** media

### C-TEST-05 — Tipos generados a mano son una fuente de drift que ningún test detecta

**Síntoma:** el código compila y los tests pasan, pero en runtime una query falla porque el tipo usado en el código ya no coincide con el schema real (una columna renombrada, un enum extendido).
**Causa:** los tipos que describen el schema se escriben/editan a mano en vez de generarse automáticamente desde la fuente real; nada en la suite de tests compara el tipo a mano contra el schema real, así que el drift se acumula sin que ningún gate lo note.
**Detección:**
- [pregunta] ¿los tipos que describen las tablas/columnas del motor de datos se generan con una herramienta automática en CI/pre-commit, o se editan a mano en cada migración?
**Fix canónico:** generación automática de tipos como paso de CI/pre-commit, con el build fallando si el archivo generado difiere del comprometido en el repo.
**Regla:** ningún tipo que describe el schema real se edita a mano — se genera, y su generación es un gate verificado en CI.
**Severidad:** alta

## Parte 3 — Plantillas de ejecución

### 3.1 Esqueleto de plan de hardening por fases (F0-F10 + bloque post-hardening)

El esqueleto que sigue es un orden de fases reutilizable, no una checklist rígida: cada auditoría
decide cuántas de estas fases necesita y con qué alcance, pero conviene preservar la lógica de
dependencia entre ellas. No tiene sentido invertir en observabilidad (F5) mientras siguen expuestos
secretos (F0), ni cerrar compliance (F8) mientras el flujo crítico (F1) todavía corre sobre la
arquitectura vieja en vez de la nueva.

- **F0 — Higiene de entorno y secretos.** Antes de tocar código de producto: separar el entorno de
  desarrollo del de runtime real; rotar cualquier credencial que haya quedado expuesta (incluso si
  ya se borró del código — ver por qué en el catálogo de seguridad); pasar los secretos a un
  esquema fail-fast en vez de opcional; dejar de loguear secretos o PII.
- **F1 — Cerrar el flujo crítico de punta a punta** sobre la infraestructura ya sólida. Si conviven
  dos arquitecturas — una nueva, más segura, y un prototipo viejo que en la práctica sigue siendo
  el que corre el flujo de negocio real — esta fase es el recableo hacia la arquitectura buena, no
  lógica nueva. Es la fase donde suele aparecer la causa raíz arquitectónica de toda la auditoría.
- **F2 — Integraciones.** Definir explícitamente cuál sistema es la fuente de verdad y cuál es
  réplica; sincronizar primero lectura, escritura después; dejar un panel de estado de integración
  visible (última sincronización, errores, reintentos).
- **F3 — Tiempo real / vivo.** Qué eventos de negocio faltan emitir y qué canales faltan escuchar
  para que la UI en vivo refleje el estado real sin depender de un refresh manual.
- **F4 — Motion/UX.** Consolidar un módulo central de animación (constantes de easing/duración
  compartidas), garantizar reduced-motion en todo lado, eliminar implementaciones ad-hoc
  duplicadas de la misma animación.
- **F5 — Analítica y métricas.** Completar la taxonomía de eventos, mover la agregación pesada a la
  capa de datos en vez de calcularla en el cliente, y gatear cualquier tag de terceros detrás de un
  consentimiento explícito.
- **F6 — Seguridad restante.** Recorrer el checklist de severidad completo (Parte 5), ítem por
  ítem, hasta dejarlo en estado cerrado o diferido-con-gate.
- **F7 — Correctness.** Barrer las clases de bug conocidas (Parte 2 de este manual) contra el
  código real, con la misma disciplina grep-y-lectura de E2. El Apéndice A es el punto de partida
  práctico: la tabla de recetas `[grep]` lista para correr de punta a punta.
- **F8 — Compliance y UX estática.** Verificar que toda acción de compliance/legal persista de
  verdad (no solo en estado de cliente); unificar lógica de negocio duplicada que debería tener una
  única fuente de verdad (el caso típico es el cálculo de precios repetido en más de un lugar).
- **F9 — Portales/superficies.** Reemplazar datos simulados por datos reales en toda superficie que
  sea núcleo del negocio (no en superficies puramente decorativas o de demo).
- **F10 — Estructura y meta-modelo.** Instalar el set de documentos descrito en la Parte 5 y los
  guards estáticos de CI que detectan drift automáticamente (por ejemplo, generación de tipos
  fuera de sincronía con su fuente, o un cliente con privilegios elevados apareciendo fuera de su allowlist).
- **Bloque post-hardening ("Fase C").** Un conjunto de features estándar que no son hardening en sí
  pero que sistemáticamente aparecen después de él (emails transaccionales, generación de PDF,
  ciclo de vida completo de cuenta). Conviene darles un lugar explícito en el mapa de fases desde
  el arranque, para que no queden "colgadas" fuera del plan cuando aparezcan.

### 3.2 Buckets A-E + formato de finding individual

Los cinco buckets (definidos en E3, 0.2) son la unidad de triage: determinan quién puede resolver
cada finding y qué tipo de decisión requiere antes de entrar en una ola de ejecución.

| Bucket | Quién resuelve | Requiere decisión de alcance |
|---|---|---|
| A — Código | Ejecutor técnico, directo sobre el repo | No |
| B — Hardening/Seguridad | Ejecutor técnico | Sí (alcance de seguridad) |
| C — Externo/Infra | Dueño del proyecto (servicio de terceros) | Sí (elección de proveedor/plan) |
| D — Externo/Legal | Asesor legal / decisión de negocio | Sí (no técnica) |
| E — Marca | Dueño del proyecto / diseño | Sí (asset pendiente) |

Cada finding individual encontrado durante E2/F7 se registra con un formato fijo, distinto del
template de clase de bug de la Parte 2: el de la Parte 2 describe una CLASE reutilizable
(síntoma→causa→fix→regla, sin atarse a un archivo); este describe una INSTANCIA concreta de esa
clase (o una candidata a clase nueva) encontrada en este proyecto puntual.

```markdown
### F-<bucket><n> — <título corto>

**Ubicación:** archivo:línea (o superficie/flujo si no aplica a una línea única)
**Clase:** `C-XXX-NN` si matchea el catálogo | ad-hoc (candidata a clase nueva) si no
**Bucket:** A | B | C | D | E
**Severidad:** crítica | alta | media | baja
**Descripción:** qué se observó y por qué importa (1-3 líneas)
**Acción propuesta:** qué hacer y quién la ejecuta (ejecutor técnico / dueño del proyecto / legal)
```

Todo finding que no matchea ninguna clase existente del catálogo pero se repite o tiene severidad
alta es candidato a convertirse en una entrada nueva de la Parte 2 — ver el principio de "catalogar
por clase" en la Parte 5.

### 3.3 Plan por olas (ownership disjunto)

Solo los findings del **bucket A** pueden entrar directo a planificación de olas: no dependen de
una decisión de alcance pendiente. Los buckets B-E necesitan pasar primero por la ronda de decisión
(E4) — por eso esa ronda precede a la planificación de olas y no al revés.

**Ronda de decisión (artefacto de E4).** Para cada pendiente de los buckets B-E se resuelve una de
cuatro salidas, y esa tabla es la que autoriza el plan de olas a arrancar:

- **Avanzar YA**, con un alcance explícito acordado.
- **Dejar libre pero con el switch/flag ya preparado** para activarlo después sin rework (ver el
  patrón "listo-para-activar" en Parte 6).
- **Diferir explícitamente con su gate** de desbloqueo registrado (ver "diferido-con-gates",
  Parte 5).
- **Cambiar de alcance** por una decisión de producto (por ejemplo, no exponer un dato públicamente
  todavía aunque la funcionalidad técnica ya esté lista).

**Principios de la planificación de olas en sí** (desarrollados con más detalle en Parte 6):

- **Ownership de archivo disjunto entre ejecutores en paralelo dentro de una misma ola.** Cada
  ejecutor recibe un set de archivos que no se superpone con el de los demás.
- **Pre-agregación de archivos compartidos.** Antes de dividir el trabajo, quien orquesta consolida
  de antemano los cambios sobre archivos que varios ejecutores necesitarían tocar (tipos generados,
  allowlist de un guard, instalación de dependencias compartidas) — un solo ejecutor por archivo
  compartido por ronda, nunca dos en paralelo sobre el mismo archivo.
- **Foundation-first.** Una ola construye y CONGELA las primitivas compartidas; recién la siguiente
  paraleliza features, cada una en su propio subárbol con su propio mock o fixture.
- **Secuenciación por dependencia.** El orden de las olas sigue la dependencia entre fases (3.1) y
  la prioridad de buckets: el bucket A puede arrancar de inmediato; B-E se van sumando a medida que
  la ronda de decisión los desbloquea.

### 3.4 Checklist de corte a producción

El corte a producción es una decisión de go/no-go, no una fecha. Cada ítem del checklist se marca
como **bloqueante** (no hay corte sin esto) o **diferido-con-gate** (documentado en el tracker de la
Parte 5, con su condición de desbloqueo explícita). Algunos ítems tienen dependencias externas: por
ejemplo, un ítem de seguridad no puede cerrarse hasta que el bucket C correspondiente (DNS, email
transaccional) esté marcado como resuelto en el documento de configuración externa (3.5) — esa
dependencia debe quedar explícita en la tabla, no asumida.

Categorías típicas y ejemplos de ítems (adaptar según el producto, no es una lista cerrada):

- **Seguridad:** sin secretos en logs; rate-limiting activo en toda superficie pública (nativo o de
  respaldo); headers de seguridad desplegados; guard de autorización cubierto por test.
- **Integridad de datos:** escrituras concurrentes sobre el mismo recurso probadas bajo
  concurrencia real, no solo en el camino feliz; constraints de unicidad aplicados donde corresponde.
- **Entorno:** esquema de variables de entorno fail-fast; entorno de desarrollo separado del de
  runtime; cualquier credencial expuesta alguna vez, rotada.
- **Observabilidad:** monitoreo de errores conectado (aunque sea en modo no-op hasta tener
  credenciales reales); logging estructurado sin secretos ni PII.
- **Testing:** el flujo crítico cubierto por integración y E2E; el test de concurrencia del flujo
  más sensible del negocio en verde (ver Parte 4).
- **Legal/Compliance:** toda acción de compliance persiste de verdad; gate de consentimiento antes
  de cualquier tag de terceros.
- **Externo (bucket C):** documento de configuración externa (3.5) completo del lado del dueño;
  dominio y DNS en vivo; dominio de email transaccional verificado.
- **Marca (bucket E):** sin datos fabricados visibles en producción; assets de marca en su lugar o,
  si faltan, decisión explícita de placeholder documentada.

### 3.5 Spec del doc "configuración externa" (servicios que configura el dueño)

Un documento único —por ejemplo `EXTERNAL-CONFIG.md`— enumera los servicios de terceros que
dependen exclusivamente del dueño del proyecto, para que la auditoría técnica y la configuración
externa nunca se mezclen ni se pierdan entre sí. En la mayoría de los productos aparecen entre 8 y
10 entradas:

1. **Hosting / plataforma de despliegue.**
2. **DNS y dominio.**
3. **Proveedor de base de datos gestionada.**
4. **Email transaccional** (incluye verificación de dominio, SPF/DKIM).
5. **Monitoreo de errores** (error tracking).
6. **Analítica de producto/uso.**
7. **Rate-limiting gestionado** (si no alcanza con el nativo del hosting/proveedor).
8. **Identidad/OTP**, si el producto lo requiere (verificación telefónica, SMS, etc.).
9. **Legal** (términos, privacidad, marco regulatorio del rubro).
10. **Marca** (dominio de marca, favicons, assets de certificación/sellos).

Cada entrada sigue el mismo formato:

```markdown
### <Servicio>

**Qué configura:** <acciones concretas que el dueño debe realizar de su lado>
**Por qué importa / qué bloquea:** <qué ítem del checklist de corte depende de esto>
**Responsable:** dueño del proyecto | ejecutor técnico (si es un paso puramente técnico)
**Estado:** pendiente | en progreso | hecho
**Gate de activación:** <condición, env var o flag que "prende" la integración cuando esto se resuelve>
```

El campo "gate de activación" conecta directo con el patrón "listo-para-activar" (Parte 6): toda
integración que depende de un servicio de este documento debería estar construida completa, con
fallback no-op, y activarse con un solo flag cuando el dueño complete su parte — sin rework técnico
adicional en ese momento.

## Parte 4 — Estándar de testing

> Este estándar nace pensado para ser portable: no describe el testing de un proyecto puntual, sino
> el conjunto mínimo de capas y decisiones que cualquier proyecto nuevo debería adoptar el primer
> día en que empieza a escribir tests. Es, en ese sentido, tan "baseline" como la Parte 1 — solo que
> enfocado exclusivamente en cómo se verifica que el resto del baseline se sostiene con el tiempo.

## 4.1 La pirámide de 4 capas

El estándar define exactamente cuatro capas, cada una respondiendo una pregunta que las otras tres
no pueden responder de forma económica:

1. **Unit de lógica pura extraída.** Corre en milisegundos, sin red ni base de datos, sobre módulos
   que reciben sus dependencias como argumentos. Cubre reglas de negocio, cálculos, validaciones y
   máquinas de estado.
2. **Component con mocks de I/O.** Ejercita la UI (render, interacción, estados de carga/error) con
   timers falsos y las llamadas de red/datos mockeadas en el borde. Cubre comportamiento de
   componente sin pagar el costo de un navegador real.
3. **Integración con entorno/tenant efímero contra una base de datos real.** Corre contra el motor
   de datos real (no una réplica en memoria), con policies y constraints reales aplicados. Cubre
   todo lo que las capas 1 y 2 no pueden ver porque vive en la costura entre aplicación y motor de
   datos: RLS, triggers, funciones con privilegios elevados, concurrencia real.
4. **End-to-end en navegador real.** Ejercita el flujo completo tal como lo vive un usuario, en un
   navegador real, contra la aplicación desplegada o corriendo localmente. Cubre lo que solo se
   manifiesta en la integración de todas las piezas: hidratación, navegación, prefetch, CSP real.

Cada capa existe porque cubre una clase de defecto que las otras no detectan a un costo razonable;
ninguna reemplaza a las demás. Un proyecto que solo tiene la capa 1 y la capa 4 (todo o nada) se
queda ciego justo en la costura de seguridad/datos que suele ser la más peligrosa.

## 4.2 Extracción de lógica pura (la precondición de todo lo demás)

La condición que hace posible testear la capa 1 sin mockear la capa de datos es estructural, no de
testing: la lógica de negocio se extrae a módulos puros sin I/O, que reciben sus dependencias
(cliente de datos, reloj, generador de ids) como argumentos en vez de importarlas. La acción de
servidor o el handler que la invoca queda reducido a un shell fino: autenticar, autorizar, hacer el
I/O, y delegar el cálculo al módulo puro.

Esto no es una preferencia de estilo — es lo que evita tener que mockear la capa de datos completa
para poder unit-testear una regla de negocio. Sin esta extracción, cada test unitario de una regla
de negocio termina reimplementando o mockeando la capa de acceso a datos, lo cual empuja
naturalmente hacia el antipatrón descrito en 4.9 (testear una réplica en vez del símbolo real).

Convención sugerida: un sufijo de archivo dedicado (por ejemplo, un módulo `.logic` separado del
módulo de acciones) hace que la regla "la lógica pura vive separada de la acción" sea verificable
por convención de nombre, no solo por disciplina.

## 4.3 Fábrica de tenant/entorno efímero

Cada test de integración crea su propio tenant aislado, con credenciales reales (no
simuladas) que atraviesan la autenticación real, para que las policies del motor de datos se
ejerciten de verdad — no una versión relajada "para testing". Al terminar, el test limpia lo que
creó.

Dos piezas hacen esto sostenible en el tiempo:

- **Una fábrica reusable** que crea el tenant, sus credenciales y sus datos base con una función
  compartida, no copiada y pegada en cada archivo de test — de otro modo, la fábrica misma se
  vuelve una fuente de drift entre suites.
- **Un barredor de huérfanos** que corre periódicamente (o al inicio de la suite) y elimina
  tenants/entornos efímeros que quedaron de corridas que crashearon antes de llegar a su propia
  limpieza. Sin esto, una base de datos de desarrollo compartida termina llena de basura de
  ejecuciones interrumpidas.

## 4.4 Guards estáticos de seguridad en CI

Esta es la pieza de mayor apalancamiento de todo el estándar: un chequeo que corre en CI, sin
levantar ninguna base de datos ni servidor, y que parsea el schema/las policies/la lista de
archivos del propio repositorio para hacer cumplir invariantes de seguridad de forma mecánica.
Ejemplos del tipo de regla que un guard estático puede hacer cumplir:

- Toda tabla nueva con datos de tenant tiene RLS forzada — el guard falla el build si detecta una
  tabla org-scoped sin la policy correspondiente.
- El cliente con privilegios elevados (el que bypassea RLS) solo aparece importado dentro de un
  allowlist estático y documentado de archivos — el guard falla si aparece en cualquier otro lugar.

Es la pieza más valiosa porque no depende de que alguien recuerde escribir un test de integración
para cada tabla nueva: corre siempre, es instantáneo, y convierte una revisión manual ("¿alguien se
fijó si esta tabla tiene RLS?") en una regla mecánica que no se puede saltear sin que alguien la
apague a propósito y de forma visible en el diff.

## 4.5 Coverage con umbral ratchet

El umbral de cobertura no es un número fijo elegido a priori, sino un "ratchet": se calcula el
coverage medido en el momento y se fija el umbral en CI un poco por debajo de ese valor (el
margen). Cada mejora futura de cobertura puede subir el umbral; ninguna regresión puede bajarlo sin
una decisión explícita. Esto evita dos fallas típicas de un umbral fijo elegido a mano: uno
demasiado bajo que no previene nada, o uno demasiado alto que bloquea el día a día del equipo con
falsos rojos. El ratchet no exige que el equipo persiga un número arbitrario — exige que el
coverage nunca retroceda sin que alguien lo decida a propósito.

## 4.6 Impersonación de actores en tests de integración

Para probar autorización (¿este actor puede leer/escribir esto?, ¿un actor anónimo, no?) sin
necesitar una credencial real por cada combinación de rol y escenario, los tests de integración
impersonan al actor manipulando el contexto de sesión directamente a nivel de motor de datos —
seteando el claim correspondiente (identidad, rol, tenant) dentro de una transacción explícita que
se descarta al terminar el test, en vez de pasar por un flujo de login real. Esto permite cubrir
en segundos combinaciones que serían lentas o frágiles de armar con credenciales reales (un actor
sin sesión, un actor de un tenant ajeno, un actor con un rol específico), mientras las policies que
se ejercitan siguen siendo las reales, no una versión de prueba relajada.

## 4.7 Qué NO testear (y por qué)

Un estándar de testing maduro es tan explícito sobre lo que decide NO cubrir como sobre lo que
cubre — y documenta el motivo, para que la ausencia no se lea como un descuido:

- **No se mockean los frameworks internos del servidor para invocar una acción "directo".** Un
  mock de las primitivas internas del framework para poder llamar a una acción de servidor fuera de
  su ciclo de vida real crea un harness frágil, acoplado a detalles de implementación del framework
  que pueden cambiar entre versiones sin ningún aviso. En cambio, la cobertura se arma en capas:
  lógica extraída en unit, el borde motor-de-datos/RLS en integración con credenciales reales, y el
  cableado completo en end-to-end.
- **No se mockea la red de un proveedor externo para simular sus respuestas en detalle.** Reproducir
  el contrato completo de una API de terceros en un mock es trabajo continuo que se desactualiza
  solo, y además nunca prueba que la integración real sigue funcionando. Se prefiere un patrón de
  "no-op documentado" para lo que depende de una credencial de terceros (ver la nota de integración
  lista-para-activar en las plantillas de ejecución) y se reserva la verificación de la integración
  real para un smoke test explícito y aislado, no para la suite principal.
- **No se testea hardware real (cámara, sensor, lector físico) en end-to-end.** Un navegador real no
  puede ejercitar una cámara o un sensor físico de forma determinística. Los caminos de entrada
  manual/alternativa del producto cubren ese caso en end-to-end; la lógica de normalización del
  dato leído se cubre en unit, y el componente que la consume, en tests de componente.

La regla general detrás de las tres decisiones: se testea lo que el propio equipo controla y puede
mantener determinístico; lo que no, se aísla detrás de un límite claro y se decide conscientemente
no perseguir con el mismo nivel de detalle.

## 4.8 Forma de un pipeline de CI

El pipeline se ordena de más barato/rápido a más caro/lento, de forma que un fallo temprano evite
gastar tiempo de cómputo en pasos posteriores:

1. **Chequeos rápidos sin credenciales** — typecheck, lint, y los guards estáticos de seguridad
   (4.4). No necesitan ninguna credencial ni entorno externo, así que corren primero y rápido.
2. **Unit con cobertura** — toda la capa de lógica pura y de componente, con el umbral ratchet
   (4.5) aplicado.
3. **Build** — confirma que el artefacto de producción compila, incluyendo las clases de error que
   el typecheck no ve (ver la Parte 2, área de runtime).
4. **Gate de credenciales** — un paso explícito que verifica que las credenciales/entornos
   necesarios para la siguiente etapa (base de datos de integración, secretos de terceros) están
   presentes; si faltan, la etapa de integración se salta de forma visible en vez de fallar de
   forma confusa.
5. **Integración serial con concurrency group** — los tests de integración (4.3) corren en serie
   dentro de un grupo de concurrencia por rama/entorno, para que dos ejecuciones en paralelo no
   escriban sobre el mismo entorno compartido al mismo tiempo.
6. **End-to-end gateado** — corre al final, gateado (por ejemplo, solo en la rama principal o antes
   de un corte a producción), porque es la etapa más lenta y la que más falsos rojos produce por
   factores ambientales ajenos al código.

## 4.9 Protecciones anti-false-green

Un test que pasa sin proteger nada es peor que no tener test: da una falsa sensación de cobertura.
Dos disciplinas concretas previenen esto:

- **Testear el símbolo real, no una réplica.** Un test que reimplementa a mano una copia de la
  función bajo prueba y testea esa copia (en vez de importar y mockear solo la dependencia externa
  del símbolo real) puede pasar para siempre sin detectar que el símbolo real se rompió. La regla
  es: mockear la dependencia externa (una cookie, un reloj, un cliente de red), pero invocar
  siempre el símbolo que realmente corre en producción.
- **Afirmar el efecto observable, no solo el status.** Un test que solo verifica que una llamada no
  lanzó excepción o devolvió 200 no prueba que la función hizo lo que dice hacer. La assertion debe
  verificar el efecto real y específico que la función promete: que se llamó a la función de
  invalidación de caché, que el registro quedó en el estado esperado, que el evento se emitió con
  el payload correcto.

Ambas disciplinas se revisan explícitamente en cualquier revisión de un test nuevo, del mismo modo
que se revisa la lógica de producción: un test es código de producción del propio proceso de
verificación, y merece el mismo escrutinio.

## Parte 5 — Meta-modelo de documentación

### El set de documentos recomendado

El objetivo de este set no es documentar por documentar: es evitar que lo aprendido en una
auditoría se pierda apenas termina, y dejar instalado el sistema que hace que los mismos bugs no
vuelvan a aparecer sin que nadie se dé cuenta. El set completo es portable entre productos hermanos
vía auditoría cruzada (ver 0.1): es literalmente lo que un proyecto le entrega al siguiente cuando
este mismo proceso se repite sobre él.

- **Baseline auditable** (equivalente de la Parte 1 de este manual, pero propio del producto): la
  línea de base contra la que se van a contrastar futuras auditorías.
- **Catálogo de clases de bug** propio del producto (equivalente de la Parte 2): síntoma → causa →
  detección → fix canónico → regla, con severidad, para cada clase encontrada.
- **Tracker de diferido con gates**: todo pendiente que no se resolvió ahora, con su contexto y su
  condición de desbloqueo explícita, revisado al cierre de cada fase u ola.
- **Checklist de QA por ronda**: verificación humana versionada, no ad-hoc, ejecutada en cada
  release o ronda de cambios significativa.
- **Checklist de seguridad con severidad**: crítico/alto/medio/bajo, con estado abierto/cerrado por
  ítem, como fuente de verdad única (detalle abajo).
- **Convenciones**: el documento que un ejecutor nuevo lee antes de tocar el repo.
- **Estándar de testing** (Parte 4 de este manual, adaptado al producto).

### Catalogar por CLASE, no por instancia

Un catálogo de calidad describe la CLASE del bug, no el fix puntual de un archivo. El formato
mínimo por entrada es síntoma → causa → detección → fix canónico → regla, más la severidad y —
opcionalmente— dónde vive el fix una vez aplicado. La razón de fondo: estas clases de bug escapan
al typecheck, al análisis estático de la capa de datos y a los tests unitarios comunes, porque viven
en las costuras entre límites de runtime — el borde serverless, la conversión de zona horaria, la
capa de autorización, los internals del framework, el motor de datos. Solo un catálogo organizado
por clase (y no por la lista de fixes ya aplicados) permite auditar esas costuras de forma
sistemática, tanto dentro del mismo producto en el futuro como al aplicarse a un producto distinto.

### Checklist de severidad como fuente de verdad

El checklist de seguridad con severidad (crítico/alto/medio/bajo) es un documento vivo, no un
snapshot de auditoría: cada ítem tiene un estado (abierto/cerrado) que se actualiza a medida que se
resuelve o se re-abre, y es referenciado desde las convenciones y desde el tracker de diferidos en
vez de duplicarse en varios lugares. Es la única fuente que responde con autoridad "¿qué sigue
abierto en términos de seguridad hoy?".

### Diferido-con-gates

Nada se difiere "verbalmente" ni por omisión silenciosa. El tracker de diferido registra, para cada
ítem que no se ejecuta ahora: el contexto de por qué se decidió diferirlo y la condición explícita
que lo desbloquearía (un volumen de uso, una decisión de negocio pendiente, la disponibilidad de una
credencial de terceros). Se revisa al cierre de cada fase o de cada ola, para que un diferido no se
convierta en un olvido permanente por default.

### Inventario de "preservar"

Antes de tocar nada, se lista explícitamente qué patrones CORRECTOS ya están presentes en el
producto, para que el hardening posterior no los regrese sin querer. Ejemplos genéricos de lo que
suele entrar en este inventario: una operación atómica bajo concurrencia ya bien resuelta, una capa
de autorización ya forzada de manera consistente, un único choke-point para las transiciones de
estado de un recurso, un tipo de dato de precisión fija para valores monetarios, tipado estricto ya
aplicado, o una única función de cálculo ya centralizada para un valor que el usuario ve en más de
un lugar. El inventario se arma leyendo el código, no asumiendo — y su valor es tan alto como el de
la lista de bugs: una auditoría que solo reporta lo que está mal, sin blindar lo que está bien, deja
la puerta abierta a que el propio hardening rompa algo que ya funcionaba.

### Nombrar la causa raíz arquitectónica

El hallazgo más valioso de una auditoría suele ser arquitectónico, no una lista de bugs sueltos. El
ejemplo canónico es descubrir que conviven dos implementaciones distintas del mismo flujo de
negocio, y que la que realmente corre en producción no es la más nueva ni la más segura de las dos.
Nombrar esa causa raíz explícitamente —y no solo listar sus síntomas— es lo que le da dirección al
plan de fases completo (F1 en 3.1 existe justamente para atacar este tipo de hallazgo). El baseline
y el tracker de diferido de este set de documentos también funcionan como el artefacto de
comunicación hacia interlocutores no técnicos: cuando las primeras fases de un plan de hardening son
higiene de entorno y recableo del flujo crítico —trabajo sin impacto visual inmediato— conviene
enmarcarlo explícitamente como "fundación invisible" ante quien no audita código, para que la falta
de progreso visible en esas semanas se lea como lo que es (una secuencia deliberada) y no como una
señal de estancamiento.

## Parte 6 — Patrones de proceso y orquestación

### Olas disjuntas

Cuando varios ejecutores trabajan en paralelo sobre el mismo working tree, cada uno recibe un set de
archivos disjunto del de los demás dentro de la misma ola. Antes de repartir el trabajo, quien
orquesta pre-agrega los cambios sobre los archivos que varios ejecutores necesitarían tocar a la vez
— tipos generados, la allowlist de un guard estático, la instalación de una dependencia compartida —
para que nadie contienda sobre el mismo archivo en la misma ronda. La regla operativa es simple: un
solo ejecutor por archivo compartido, por ronda.

### Foundation-first

Antes de paralelizar features, una fase dedicada construye y CONGELA las primitivas compartidas
(tipos base, cliente de datos, primitivas de autorización, mocks/fixtures comunes). Recién ahí la
fase siguiente paraleliza: cada feature en su propio subárbol, con su propio mock cuando necesita
aislarse de una dependencia compartida todavía en construcción. Paralelizar antes de congelar la
base es la causa más común de conflictos de merge y de trabajo duplicado entre ejecutores.

### Revisión adversarial

El paso de cierre estándar de cada ola es una revisión adversarial del diff: N dimensiones de
revisión (seguridad, integridad de datos, UX, correctness, etc., según lo que tocó la ola), cada una
evaluada por al menos 2 revisores independientes cuyo mandato explícito es intentar REFUTAR cada
finding y cada por qué-está-bien, no simplemente confirmarlos. Este formato captura de forma
repetible bugs reales de severidad alta/media que una revisión de confirmación simple deja pasar, y
al mismo tiempo descarta correctamente los no-issues que un revisor único tiende a sobre-reportar
por precaución. Ninguna ola se da por cerrada sin pasar por este paso.

### Schemas de salida planos

Cuando la ejecución se orquesta con agentes que devuelven salida estructurada, los schemas de salida
deben mantenerse CHATOS. Un schema anidado grande incrementa la probabilidad de que un reintento de
salida estructurada falle silenciosamente; si eso ocurre, el contenido se recupera del log crudo del
ejecutor, nunca se descarta el trabajo ya hecho. En la misma línea, cualquier tipo o dato generado a
mano (en vez de generado automáticamente desde su fuente) es la causa número uno de drift entre lo
que dice el tipo y lo que hace el sistema real — conviene mover esa generación a CI o a un hook de
pre-commit en vez de dejarla como paso manual (ver F10, 3.1).

### Patrón "listo-para-activar"

Para toda integración que depende de una credencial de terceros o de una decisión comercial
todavía pendiente (sincronización con un partner, envío de emails, un conector con hardware local,
generación de documentos, rate-limiting gestionado), el patrón de oro es construir la integración
COMPLETA desde el día uno, con un fallback no-op mientras falta la credencial o la decisión. Se
entrega la plataforma entera funcionando en modo degradado explícito, y se "prende" con un solo flag
o variable de entorno cuando el bucket C/D correspondiente (ver 3.2, 3.5) se resuelve — cero rework
técnico en el momento de activarla. Es la respuesta técnica directa a la opción "dejar libre con
switch preparado" de la ronda de decisión (3.3).

### Paridad de entorno local

Un stack local completo y contenerizado es la separación REAL entre entorno de desarrollo y
runtime de producción — es una garantía más fuerte que "otro proyecto separado en el mismo
proveedor de nube", que sigue compartiendo cuenta, límites y, en más de un caso, terminando con un
script de desarrollo apuntando por error a la URL de runtime real. Como técnica de diagnóstico
relacionada: un error genérico u opaco conviene reproducirlo paso a paso en una ruta o script
descartable dedicado exclusivamente a aislar la causa, que se borra apenas se identifica — nunca se
diagnostica a fuerza de prueba y error directo sobre el flujo real.

### Disciplina de control de versiones

El árbol de trabajo en verde es el entregable de un ejecutor — nunca un commit ni un push por
cuenta propia. Quien controla el repositorio es siempre el dueño del proyecto: commitea desde su
propia rama de trabajo, y la rama de producción nunca recibe un push directo. Los puntos de
restauración se marcan con tags, no confiando en la memoria de "hasta dónde llegamos". La
integración continua, además, debe correr sobre la rama activa de desarrollo y no solo sobre la de
producción — de lo contrario, el problema que el CI debería atajar ya entró al código antes de que
alguien lo vea. Esta disciplina no es una preferencia de estilo: es la que mantiene la autoridad
sobre el historial del proyecto exclusivamente en manos de su dueño, sin importar cuántos ejecutores
paralelos hayan producido el trabajo.

## Apéndice A — Índice de detección rápida

Tabla única con todas las recetas `[grep]` del catálogo de la Parte 2, extraídas automáticamente
de cada entrada. Ordenada por área (mismo orden que la Parte 2) y, dentro de cada área, por
severidad (crítica primero). El prefijo del ID en la columna "Clase" ya identifica el área
(`C-SEC`, `C-INT`, `C-DB`, `C-RUN`, `C-UX`, `C-TEST`). Las entradas marcadas como patrón/defensa
a preservar (sin bug asociado) no tienen receta `[grep]` y no aparecen acá — ver Parte 2 para su
detección por `[señal]`/`[pregunta]`.

| Patrón `[grep]` | Clase | Severidad |
|---|---|---|
| `new Map\(\)` o una variable de módulo mutable en un archivo de ruta/handler, sin un chequeo de sesión antes del primer acceso a esa estructura | `C-SEC-01` | crítica |
| rutas bajo un path tipo `*/proxy/*` o `*/partner/*` que llaman `fetch\(` sin una función de auth invocada antes, en el mismo archivo | `C-SEC-02` | crítica |
| handlers donde el primer efecto es una query/`createAdminClient` y el chequeo de sesión aparece después, o donde `tenantId`/`storeId` viene de params sin cruzarlo contra la sesión | `C-SEC-03` | crítica |
| `console\.(log|error|debug)\(` cuyo argumento incluye un objeto/variable con nombre `token|password|email|dni` (case-insensitive) | `C-SEC-04` | alta |
| handler bajo un path que incluye `webhook`/`hook` que llama `JSON\.parse\(` o consume el body ya parseado por el framework ANTES de invocar una función de verificación de firma (`verify.*[Ss]ignature\|createHmac\|timingSafeEqual`); ausencia de una tabla/registro (`processed_events`/`webhook_events`/columna `event_id` única) consultado antes de aplicar el efecto | `C-SEC-19` | alta |
| handler de callback OAuth (path que incluye `callback`/`oauth`) que lee `code` de los query params e invoca el intercambio de token sin una comparación previa de `state` contra un valor leído de sesión/cookie firmada, en el mismo archivo | `C-SEC-20` | alta |
| `error\.message` devuelto directo al cliente en una ruta de login/reset, o dos ramas de `return` distintas según exista o no el usuario | `C-SEC-05` | media |
| bloque `catch` que termina en un `setError`/`toast` usando `.message` del error sin pasar por un traductor central | `C-SEC-06` | media |
| un formulario de alta de usuario con un campo `password` que no sea de invitación/token | `C-SEC-12` | media |
| marca de opcional en el schema de env (ej. `\.optional\(\)`), cruzada contra un módulo de integración que lee esa variable sin chequear si vino indefinida | `C-SEC-14` | media |
| un SELECT seguido de aritmética en el lenguaje de aplicación y luego un UPDATE con el valor ya calculado, en vez de `UPDATE ... SET x = x + delta` | `C-INT-01` | crítica |
| una sentencia de expansión de enum (`ALTER TYPE ... ADD VALUE`) y, en el mismo archivo de migración, un INSERT/UPDATE que use ese valor nuevo | `C-INT-07` | media |
| tablas con RLS habilitada sin una policy `FOR UPDATE` correspondiente en el mismo conjunto de migraciones/policies | `C-DB-01` | alta |
| declaración de función con privilegios elevados (`SECURITY DEFINER`) sin una cláusula de search_path fijo en el mismo bloque | `C-DB-05` | alta |
| construcción de SQL dinámico (ej. `EXECUTE format`) sin una validación previa contra un array/enum fijo de nombres permitidos en la misma función | `C-DB-09` | alta |
| función de trigger que referencia el registro nuevo sin un `COALESCE(NEW, OLD)` previo, declarada para INSERT/UPDATE/DELETE combinados | `C-DB-02` | media |
| `useState\(\s*(row|item|record)\.\w+\s*\)` sin un `key={` correspondiente en el elemento padre de la lista. | `C-RUN-06` | crítica |
| `^export type \{` o `^export \{ type ` dentro de un archivo con la directiva de acciones de servidor en la cabecera. | `C-RUN-09b` | crítica |
| `<\w+\.Provider\s+value=\{\{` | `C-RUN-03` | alta |
| `redirect\(['"]` en un archivo de ruta, cruzado a mano contra `router\.push\(|<Link href=` apuntando a esa misma ruta desde otros archivos. | `C-RUN-08` | alta |
| `fetch\(['"]https?://` dentro de un archivo marcado como componente de cliente. | `C-RUN-13` | alta |
| `randomInt\(\s*\d+,\s*2\s*\*\*\s*\d{2,}` | `C-RUN-14` | alta |
| `\.insert\(|\.(insert|update)\(` sin un `await` inmediatamente antes en el mismo bloque, dentro de un handler serverless. | `C-RUN-17` | alta |
| `useEffect\(.*\[.*\b(on\w+|handle\w+)\b.*\]` — revisar a mano si la función en la dep list está memoizada. | `C-RUN-04` | media |
| `useState\((props?\.\w+|searchParams)` | `C-RUN-05` | media |
| `^export (const|type|interface)` dentro de un archivo con la directiva de acciones de servidor en la cabecera. | `C-RUN-09` | media |
| `img-src` en la config de CSP, comparado a mano contra los hosts reales de storage usados por la app. | `C-RUN-10` | media |
| `animate=\{|initial=\{` en componentes usados dentro de páginas generadas estáticamente. | `C-RUN-12` | media |
| `'use server'` en el mismo archivo/función que dispara el sign-out o el redirect de logout, con middleware activo sobre esa ruta. | `C-RUN-15` | media |
| `src=\{[\w.]+\}` sin normalización previa de vacío→null en el mismo archivo o en la capa de datos. | `C-RUN-16` | media |
| `\.sort\(\)\[0\]` o `\[0\]\.\w+` cerca de la resolución del scope activo por defecto. | `C-RUN-18` | media |
| `: Date\b` en el tipo de una prop de un componente cliente, o un valor de fecha nativo pasado directo a un componente marcado como cliente. | `C-RUN-19` | baja |
| la misma fórmula de cálculo (ej. `precio.*\*.*cantidad|subtotal.*\+.*envio`) repetida en más de un archivo de UI/lógica de negocio. | `C-UX-01` | crítica |
| `toISOString\(\)\.slice\(0,\s*10\)` o `toISOString\(\)\.split\('T'\)\[0\]` en código de agregación/reportes. | `C-UX-03` | alta |
| `switch\s*\(.*(status|estado)` sin un `default` que loguee/alerte, o un `if/else if` encadenado sobre un enum sin manejo final visible. | `C-UX-04` | alta |
| `const \{ data \}` o `data ?? \[\]` sin desestructurar ni chequear `error` en el mismo bloque. | `C-UX-05` | alta |
| `prefers-reduced-motion` en el CSS/JS del proyecto, cruzado a mano contra si cada animación que matchea fija también un estado final explícito, no solo `animation: none`. | `C-UX-02` | media |
| carpeta de scripts sueltos (`scripts/verify-*`, `scripts/check-*`) que no se invocan desde ningún job de CI ni desde la suite de tests. | `C-TEST-04` | media |

*Total: 38 patrones `[grep]` extraídos de la Parte 2.*

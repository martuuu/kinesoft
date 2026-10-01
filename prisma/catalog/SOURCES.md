# Catálogo global de KineSoft: datos y fuentes

Datos oficiales del catálogo global (prestadoras, planes, especialidades y prácticas) en el formato del
"Contrato de CSV del catálogo" (B-pre, sesión B1.2). Los importa `scripts/catalog-import.ts` (B1.1): dry-run por
defecto, `--apply` para escribir, upsert por `slug`, nunca pisa filas con `curatedAt`. **El import contra prod lo
corre Martin**; ningún agente lo corre fuera del Docker local.

Fecha de consulta de todas las fuentes: **2026-09-30** (es el `sourceDate` de todas las filas). No se usó
drapp.com.ar ni su API.

## Archivos

| Archivo | Filas | Contenido |
|---|---|---|
| `payers.csv` | 780 | 329 `OBRA_SOCIAL` (305 nacionales + 24 provinciales), 282 `PREPAGA`, 163 `MUTUAL`, 6 `OTRA`. Por `source`: 366 `RNOS` (139 también en el RNEMP), 381 `RNEMP`, 24 `PROVINCIAL`, 9 `CURATED` |
| `payer-plans.csv` | 71 | Todos `CURATED`: 46 de webs oficiales (con `sourceUrl`) + 25 del benchmark |
| `specialties.csv` | 91 | 85 `REFEPS` (70 médicas Res. 1814/2015, 4 de kinesiología Res. 4187/2023, 11 profesiones REFEPS/Ley 24.317) + 6 `CURATED` |
| `practices.csv` | 70 | 13 `PMO` (con `code` del Nomenclador Nacional) + 57 `CURATED` (15 con código PAMI u OSEP en `aliases`/`sourceRef`) |
| `practice-specialties.csv` | 68 | Una fila por práctica; las consultas médicas genéricas 42.01.01 y 42.02.01 no tienen especialidad |
| `payers.seed-2026-09.csv` | 13 | Seed del benchmark (create-only): mismas filas y slugs que en `payers.csv`, con `source=CURATED` |
| `payer-plans.seed-2026-09.csv` | 25 | Planes del seed del benchmark, también presentes en `payer-plans.csv` |
| `tools/` | — | Generadores (ver "Cómo regenerar") |

Formato: UTF-8 sin BOM, coma, header obligatorio, comillas RFC 4180, `aliases` separados por `|`, fechas
`YYYY-MM-DD`, `sourceUrl` = una sola URL. `tests/unit/catalog-data.test.ts` valida todo eso sobre estos archivos, y
además corre el planner real del import (`lib/catalog/import-core.ts`) contra una base vacía: **cero conflictos**.

## Cómo se mapeó la investigación al contrato

- **`slug`**: kebab-case estable, derivado del nombre corto: la marca (`osde`, `swiss-medical`, `avalian`) o la
  sigla del registro (`osecac`, `osdepym`). Si no hay sigla, sale del nombre, cortado a 60 caracteres y sin la forma
  societaria. Cuando dos entidades comparten la base (siglas como `OSPA`, que usan 5 obras sociales), se agrega el
  código de registro (`ospa-000307`). Las marcas tienen prioridad sobre la base (`galeno` es Galeno Argentina S.A. y
  `galeno-120115` es Galeno S.R.L.). Los slugs de las provinciales y los curados se mantienen (`ioma`,
  `osep-mendoza`, `osfa`). **Un slug publicado no se cambia**: el generador reusa el slug previo por `registryCode`.
- **`kind`**: obras sociales nacionales y provinciales → `OBRA_SOCIAL` (las provinciales con `province` cargada y
  `source=PROVINCIAL`); prepagas, mutuales y otras se mantienen.
- **`name` / `legalName`**: en las 14 prepagas conocidas por la marca, `name` es la marca y `legalName` la razón
  social. En el resto de las filas de registro, `name` y `legalName` son la denominación normalizada. En las
  provinciales, `legalName` es el nombre sin la provincia.
- **`registryCode` / `sourceRef`**: el código de 6 dígitos del registro de la SSS. `sourceRef` lleva
  `RNOS 126205` o `RNEMP 1-1332-8`.
- **Crosswalk RNOS↔RNEMP**: 139 entidades figuran en los dos registros y quedaron en una sola fila con el código
  RNOS. El código RNEMP absorbido va en `sourceRef` (`RNOS 400800; RNEMP 6-1408-1`) y no como alias. Origen de los
  139 matches:
  - 123 por nombre normalizado exacto;
  - 8 a mano en la investigación: OSDE, Avalian, Swiss Medical, Galeno, Medifé, Sancor Salud, Omint y Federada;
  - 8 a mano en B1.2 (`MANUAL_MERGE` en `tools/build_payers.py`): Árbitros Deportivos, Agentes de Propaganda
    Médica de Córdoba, Trabajadores Viales, Talleristas a Domicilio, AMCI (Control Integral), Colegio Médico de
    San Juan, Personal Municipal de Tres de Febrero y Vitas. Los nombres difieren apenas ("Obra Social de…" contra
    "Obra Social…", "del" contra "de", "Vita\`s" contra "Vitas") y con el `matchKey` chocaban.
- **`source`**:

  | Origen en la investigación | `source` |
  |---|---|
  | SSS-RNOS / SSS-RNOS+SSS-RNEMP | `RNOS` |
  | SSS-RNEMP | `RNEMP` |
  | COSSPRA | `PROVINCIAL` |
  | Res. MS 1814/2015, Res. MS 4187/2023, REFEPS, Ley 24.317 (especialidades) | `REFEPS` |
  | Prácticas con código PMO | `PMO` |
  | PAMI, OSEP, web oficial, curado, curado-benchmark | `CURATED` |

  El detalle de cada fila (norma, código PAMI/OSEP, decreto) va en `sourceRef`.
- **`aliases`**: incluyen la sigla, las marcas y el nombre original del registro o de la norma cuando difiere del
  normalizado. La comparación distingue tildes, así que "CLINICA MEDICA" queda como alias de "Clínica Médica".
  Se sacaron alias por dos motivos:
  - Mandaban a la prestadora equivocada: `OSFA` en IOSFA, porque OSFA es la sucesora, y `OSEP` pelado en
    Catamarca y Mendoza. Quedan `OSEP Catamarca` y `OSEP Mendoza`.
  - Eran ambiguos: su `matchKey` también es el nombre o un alias de otra entidad. El import saltea como conflicto
    toda fila con un alias así. Se sacaron 37 en prestadoras, casi todos siglas compartidas: `OSPA` la usan 5 obras
    sociales, y además `OSPEP`, `OSPIT`, `OSPM`, etc. Esas obras sociales **no se encuentran por la sigla**; hay
    que buscarlas por nombre.
  - En prácticas, los alias genéricos compartidos quedaron solo en la práctica más específica:
    - `Electroterapia` → electroestimulación;
    - `Infrarrojo` → termoterapia;
    - `Sesión de kinesiología` → kinesioterapia;
    - `Gimnasia médica` → gimnasia terapéutica.
  - `NN 42.01.01`, que comparten las consultas de especialidad, pasó a `sourceRef` ("factura como NN 42.01.01").
- **Entidades distintas con la misma `matchKey`**: `Payer.matchKey` es UNIQUE y el `matchKey` saca "Obra
  Social", "Asociación Mutual", "Asociación Civil" y la forma societaria. Ejemplos de choque: "Galeno" / "Galeno
  S.R.L.", "Obra Social Ferroviaria" / "Asociación Mutual Ferroviaria", los dos "Medicina Privada S.R.L.".
  - Se queda con el nombre limpio la marca, y si no hay marca la fila del RNOS.
  - Al resto se le agrega el código de registro al `name`. Son 11, por ejemplo "Galeno S.R.L. (RNEMP 1-2011-5)".
  - `legalName` queda sin el código.
- **`aliases.csv`**: no se generó. El contrato no le fija header y los alias van en la columna `aliases` de cada
  archivo.
- **`cuit`**: vacío en todas las filas, porque ningún listado oficial consultado lo publica.

## Seed del benchmark (`*.seed-2026-09.csv`)

Lo pidió el dueño y solo trae nombres de prestadoras y planes (decisión 12 de B-pre). Contenido:
- **Avalian:** Plan Único (ex Aca Salud), Clásica Plan 2, PMO, Prepago, Selecta y Superior.
- **Boreal:** A2 y Magnun.
- **Confianza:** sin planes.
- **Federada Salud:** 7 y Plan Único.
- **GMA Salud:** sin planes.
- **Grupo Alianza Médica:** Todos los planes.
- **IAPOS:** Plan Único.
- **IOMA:** IO Plan A, IO Plan B y Plan 056.
- **OSAM:** No Mineros y Plan Único.
- **OSCHOCA:** Plan Único.
- **Osdepym:** Pyme 1000, 2000, 4000 y Visitar.
- **Osdop:** Plan Único.
- **OSECAC:** Azul y Carhue.

Asociaciones:
- "Aca Salud" → Avalian (RNOS `903101`): el RNEMP la registra como "AVALIAN … EX ACA SALUD", y "ACA Salud" va como
  alias.
- Federada Salud → `903200`, OSAM → `112400`, Osdepym → `401704`, Osdop → `106302`, OSCHOCA → `105804` y
  OSECAC → `126205`.
- IOMA e IAPOS → las filas provinciales.
- **Boreal, Confianza, GMA Salud y Grupo Alianza Médica** no aparecen con ese nombre ni en el RNOS ni en el RNEMP.
  Quedaron como `OTRA`/`CURATED`, sin `registryCode`. "Confianza" **no** se asoció a "Asociación Mutual CON-SER
  Confianza y Servicio" (RNEMP 3-1115-9), porque no hay evidencia de que sean la misma entidad.

## Fuentes

### Prestadoras
- **SSS, Registro Nacional de Agentes del Seguro (RNAS/RNOS):** 366 entidades, PAMI incluido (`500807`).
  - Listado: https://www.sssalud.gob.ar/?page=listRnosc&tipo=100
  - Se bajó con el export oficial: `POST https://www.sssalud.gob.ar/descargas/dump.php` con
    `obj=listRnosc&tipo=100`. Es un TSV latin-1 y queda en `tools/raw/rnos_dump_100.xls`.
  - Los códigos `9-xxxx` (Ley 23.660, art. 1 inc. i) se tipan como `PREPAGA` o `MUTUAL` según el nombre.
- **SSS, Registro Nacional de Entidades de Medicina Prepaga (RNEMP):** 520 entidades.
  - Buscador: https://www.sssalud.gob.ar/index.php?cat=consultas&page=bus_emp_padron
  - El buscador no lista todo con una búsqueda vacía. Se hicieron 31 consultas por subcadena y se unieron los
    resultados (`tools/fetch_rnemp.py`, que deja `tools/rnemp.json`).
- **COSSPRA (24 obras sociales provinciales):** https://cosspra.com.ar/nosotros/ y
  https://ipsst.gov.ar/prestaciones-de-salud/reciprocidad-de-servicios/obras-sociales-adheridas-a-cosspra/
  - OSER reemplazó a IOSPER, que queda como alias.
  - SEROS es el servicio de salud del ISSyS.
- **Fuerzas y regímenes fuera del RNOS (`CURATED`):**
  - IOSFA fue disuelto por el **Decreto 88/2026** y lo reemplazan OSFA y OSFFESEG
    (https://www.argentina.gob.ar/seguridad/nueva-obra-social, https://iosfa.gob.ar/novedades/463/osfa). IOSFA
    queda como fila histórica, para turnos viejos.
  - Policía Federal: https://www.supbienestar.gob.ar/
  - OSPJN: https://www.ospjn.gov.ar/

### Planes
Cada fila lleva su URL oficial en `sourceUrl`:
- **OSDE:** 210, 310, 410, 450, 510 y Flux.
- **Swiss Medical:** SMG02, 20, 30, 40, 50, 60 y 70. Cada PDF oficial existe; SMG01 y SMG10 dieron 404.
- **Galeno:** 220, 330, 440, 550 y Plan Joven 18-25.
- **Medifé:** Medifé+, Bronce Classic, Bronce, Plata, Oro, Platinum e Indie.
- **Omint:** Vos, Génesis, Clásico, Global, Premium y Comunidad.
- **Sancor Salud:** 1000 a 6000. Los planes **1000 y 1500 solo se vieron en el índice del buscador: hay que
  verificarlos.**
- **Prevención Salud:** A1, A2, A4, A5 y A6.

### Especialidades
- **Res. MS 1814/2015, Anexo I (70 médicas):**
  https://www.argentina.gob.ar/sites/default/files/8-resolucion-1814-especialidades-medicas.pdf. El texto
  oficial va como alias, con su error "MEDICINA PALITATIVA".
- **Res. MS 4187/2023, Anexo I (kinesiología):** Pediátrica y Neonatal, Cardiorrespiratoria, Cuidados Intensivos y
  Neurológica. https://www.boletinoficial.gob.ar/detalleAviso/primera/300981/20231218
- **Ley 24.317:** https://www.argentina.gob.ar/normativa/nacional/norma-716
- **REFEPS (CodeSystem "Profesiones REFEPS", DNSIS / HL7 Argentina):**
  https://guias.hl7.org.ar/site/CodeSystem-ProfesionesREFEPS.html. Los códigos de profesión van en `sourceRef`.
- **Curadas:**
  - Kinesiología General, en Traumatología/Ortopedia y Deporte, en Terapias Manuales y Dermatofuncional: según
    una fuente secundaria (AJRPT 2024, SciELO) están reconocidas en Mendoza por la Res. 534/2022 del MSDSyD, pero
    la norma no se encontró. **Hay que verificarlas.**
  - Osteopatía no está reconocida a nivel nacional.
  - Kinesiología Uroginecológica no tiene reconocimiento oficial; se agregó por el producto.

### Prácticas
- **PMO, Res. MS 201/2002, Anexo II:**
  https://www.argentina.gob.ar/normativa/recurso/73649/texactres201-2002MS-anexoII/htm
  - Son los únicos `code` del catálogo y siguen la numeración del Nomenclador Nacional (`250101` = 25.01.01; la
    forma con puntos va como alias).
  - `nomenclador` = "Nomenclador Nacional".
- **PAMI, Manual del Nomenclador (julio 2026):** https://www.pami.org.ar/pdf/manual_nomenclador.pdf
- **OSEP Mendoza, Nomenclador Único de Kinesiología y TO (Res. HD-2022-1237):** PDF oficial en osepmendoza.com.ar.
  - Los códigos de PAMI y OSEP son propios de cada financiador. Van en `aliases` (`PAMI 250120`) y en `sourceRef`,
    no en `code`.
- **Curadas:** las técnicas sueltas (agentes físicos, punción seca, taping, pilates, ATM), las evaluaciones, la
  osteopatía y las consultas de especialidad no tienen código nacional propio. Los nomencladores las incluyen dentro
  de la sesión 25.01.01/25.01.02 o de la consulta 42.01.01.
- `defaultDurationMin` es **curado en todas las filas**, porque ninguna fuente oficial fija duraciones.

## Licencia y atribución

- Los contenidos de argentina.gob.ar están bajo **CC BY 4.0**. Atribución: **"Fuente: Ministerio de Salud de la
  Nación / Superintendencia de Servicios de Salud (SSS)"**.
- Los listados de sssalud.gob.ar, el Boletín Oficial y la normativa son información pública y actos de gobierno, sin
  licencia explícita.
- De las webs de prepagas, COSSPRA, PAMI y OSEP solo se tomaron datos fácticos (nombres de planes y prácticas, y
  códigos), no textos.

## Limitaciones

- **Los registros cambian.** La SSS da de baja entidades del RNEMP con frecuencia (hubo bajas en septiembre de 2026),
  y las razones sociales cambian (ACA Salud → Avalian, IOSPER → OSER, IOSFA → OSFA/OSFFESEG). Hay que refrescar el
  catálogo periódicamente.
- **No se consiguió:**
  - el Nomenclador Nacional completo (capítulo 25): no hay versión oficial descargable;
  - catálogos de prácticas de los colegios de kinesiología: solo hay aranceles;
  - los listados de planes de OSDE, Sancor y Prevención, que se arman con JavaScript.
- **La normalización de nombres es automática** (Title Case, tildes por diccionario, siglas preservadas). Puede
  dejar detalles menores, por ejemplo "A.M.PARA la Ayuda Recíproca…". Se corrigen desde Plataforma: editar marca
  `curatedAt` y el import ya no pisa la fila.
- **Pares que no son duplicados**, aunque se parezcan: "Obra Social Asociación Mutual X" (RNOS) y "Asociación
  Mutual X" (RNEMP), en OSAMOC, Programas Médicos y Villa Constitución. Son entidades distintas, la obra social y la
  mutual, y se desambiguaron con el código.
- "Hominis S.A." (RNOS 901501) y "Medicina Prepaga Hominis S.A." (RNEMP 1-1143-8, marca `hominis`) **no se
  fusionaron**, porque las razones sociales difieren. Hay que confirmarlo.
- `tools/build_contract.py` tiene un port en Python de `matchKey`, solo para dejar los CSV sin conflictos. La fuente
  de verdad es `lib/catalog/normalize.ts`: si cambia, el test del planner lo detecta.

## Cómo regenerar

Los generadores escriben los CSV intermedios de la investigación en el directorio actual. Por eso se corren sobre una
copia de `tools/`, y `build_contract.py` escribe el formato del contrato en `prisma/catalog/`:

```sh
WORK=$(mktemp -d) && cp -R prisma/catalog/tools/. "$WORK" && (cd "$WORK" && \
  python3 build_payers.py && python3 build_clinical.py && \
  python3 build_contract.py --research . --out "$OLDPWD/prisma/catalog")
TZ=UTC npx vitest run tests/unit/catalog-data.test.ts
```

- Para refrescar los registros:
  - RNOS: bajar de nuevo el export (URL arriba) a `tools/raw/rnos_dump_100.xls`;
  - RNEMP: correr `python3 fetch_rnemp.py` dentro de `tools/` (hace POST al buscador de la SSS).
- Los PDFs y HTML de las normas no se versionan: las URLs están arriba.
- `build_contract.py` reusa los slugs del `payers.csv` existente, así que **regenerar no cambia slugs publicados**.
  Con los mismos insumos, el resultado es idéntico.

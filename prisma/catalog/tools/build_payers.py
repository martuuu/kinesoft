"""Construye payers.csv, payer_plans.csv y payer_crosswalk.csv a partir de:
- raw/rnos_dump_100.xls  (export oficial SSS, RNAS/RNOS, tipo=100 "Entidades inscriptas", 30-09-2026)
- rnemp.json             (scrape del buscador oficial SSS bus_emp_padron, 30-09-2026)
- listas curadas (provinciales COSSPRA, fuerzas, seed benchmark) definidas abajo.
"""
import csv, json, re, unicodedata

DATE = "2026-09-30"
RNOS_URL = "https://www.sssalud.gob.ar/?page=listRnosc&tipo=100"
RNEMP_URL = "https://www.sssalud.gob.ar/index.php?cat=consultas&page=bus_emp_padron"
COSSPRA_URL = "https://cosspra.com.ar/nosotros/"

ACC = {w.split(':')[0]: w.split(':')[1] for w in """
ASOCIACION:asociación REPUBLICA:república DIRECCION:dirección MEDICO:médico MEDICA:médica MEDICOS:médicos
MEDICAS:médicas CORDOBA:córdoba CIRCULO:círculo UNION:unión JERARQUICO:jerárquico JERARQUICOS:jerárquicos
ENERGIA:energía FEDERACION:federación RIOS:ríos TECNICOS:técnicos TECNICO:técnico METALURGICA:metalúrgica
METALURGICOS:metalúrgicos CONSTRUCCION:construcción ORGANIZACION:organización PROTECCION:protección RECIPROCA:recíproca
AEREAS:aéreas AERONAUTICO:aeronáutico NEUMATICO:neumático NEUMATICOS:neumáticos PETROLEO:petróleo
SUBTERRANEOS:subterráneos FARMACEUTICOS:farmacéuticos FARMACEUTICA:farmacéutica CLINICA:clínica CLINICAS:clínicas
FUNDACION:fundación GRAFICA:gráfica GRAFICO:gráfico ECONOMIA:economía PUBLICOS:públicos PUBLICO:público
PUBLICA:pública CONSTITUCION:constitución CATOLICOS:católicos ALIMENTACION:alimentación AZUCAR:azúcar
MARTIN:martín MECANICOS:mecánicos METALMECANICA:metalmecánica PETROQUIMICA:petroquímica PETROQUIMICAS:petroquímicas
QUIMICAS:químicas QUIMICOS:químicos QUIMICA:química BIOQUIMICOS:bioquímicos VITIVINICOLA:vitivinícola
SIDERURGICA:siderúrgica NICOLAS:nicolás CAPITALIZACION:capitalización PRESTAMO:préstamo CAMARA:cámara
AUTONOMA:autónoma CONSULTORIA:consultoría AERONAVEGACION:aeronavegación FOTOGRAFOS:fotógrafos FUTBOL:fútbol
MUSICOS:músicos BAHIA:bahía REFINERIAS:refinerías MAIZ:maíz EDUCACION:educación NACION:nación UNICO:único
PAIS:país PERFUMERIA:perfumería PRODUCCION:producción PARANA:paraná CIENTIFICA:científica ANONIMA:anónima
ALEMAN:alemán ADMINISTRACION:administración ATENCION:atención CREDITO:crédito POLICIA:policía LOTERIAS:loterías
CARBONIFEROS:carboníferos PREVENCION:prevención CINEMATOGRAFICO:cinematográfico CINEMATOGRAFICA:cinematográfica
CINEMATOGRAFICOS:cinematográficos CINEMATOGRAFICAS:cinematográficas CERAMICA:cerámica ESCRIBANIAS:escribanías
ESPECTACULO:espectáculo FRUTICOLA:frutícola EXPEDICION:expedición GASTRONOMICOS:gastronómicos GRUAS:grúas
MOVILES:móviles MAQUINA:máquina MARITIMOS:marítimos MARITIMO:marítimo OMNIBUS:ómnibus PANADERIAS:panaderías
CARTON:cartón PELUQUERIAS:peluquerías ESTETICAS:estéticas CIRCUNSCRIPCION:circunscripción FABRICAS:fábricas
PLASTICO:plástico RECOLECCION:recolección TUCUMAN:tucumán NEUQUEN:neuquén TELEGRAFOS:telégrafos
TECNOLOGICA:tecnológica ELECTRICA:eléctrica ELECTRICOS:eléctricos ARBITROS:árbitros DEMAS:demás LINEAS:líneas
LOPEZ:lópez LANUS:lanús ZARATE:zárate TUCUMANA:tucumana GENETICA:genética INFORMATICA:informática
OPTICA:óptica ODONTOLOGICA:odontológica ODONTOLOGICO:odontológico SANATORIO:sanatorio ESTETICA:estética
ASISTENCIA:asistencia CARDIOLOGICA:cardiológica PEDIATRICA:pediátrica DIAGNOSTICO:diagnóstico JOSE:josé
RAMON:ramón MARIA:maría GUEMES:güemes ROCIO:rocío CIRUGIA:cirugía TERAPEUTICA:terapéutica
CATOLICA:católica UNIVERSITARIA:universitaria ACADEMICA:académica PATAGONICA:patagónica PATAGONICO:patagónico
AGRICOLA:agrícola EMPRESARIA:empresaria INSTITUCION:institución PRESTACION:prestación PRESTACIONES:prestaciones
SOLIDARIA:solidaria MUTUO:mutuo HIPICA:hípica PARTICIPACION:participación AVIACION:aviación GESTION:gestión
FISICA:física COMUNICACION:comunicación INFORMACION:información CONCEPCION:concepción ASUNCION:asunción
REGION:región CORPORACION:corporación COOPERACION:cooperación POBLACION:población DISTRIBUCION:distribución
LEON:león GESTIÓN:gestión REPULICA:república CIRCULOS:círculos MEDICINAL:medicinal
""".split()}

PARTICLES = {"de", "del", "la", "las", "los", "y", "e", "el", "en", "para", "a", "al", "o", "u", "con", "por", "sin", "que"}
KEEP_UPPER = {"OSDE", "PAMI", "AMR", "CRS", "AMC", "GAM", "EME", "DOC", "AF", "SM", "YPF", "ACA", "UTEPLIM", "SMG",
              "UOCRA", "OSECAC", "OSPRERA", "INSSJP", "ISSN", "IOMA", "SEMPRE", "IV", "II", "III", "SPA", "SCIS",
              "ADOS", "AFIP", "UPCN", "UTA", "ATSA", "ART", "OSPE", "OSPA", "AMUR", "CEMIC", "TV", "SAMI", "ISJ", "OSEP"}
LEGAL = [(r"\bS\.?\s*A\.?\s*U\.?(?=\s|$|,)", "S.A.U."), (r"\bS\.?\s*R\.?\s*L\.?(?=\s|$|,)", "S.R.L."),
         (r"\bS\.?\s*A\.?\s*S\.?(?=\s|$|,)", "S.A.S."), (r"\bS\.\s*A\.?(?=\s|$|,|\))", "S.A."),
         (r"\bSA(?=\s|$|,)", "S.A."), (r"\bLTDA\.?(?=\s|$|,)", "Ltda.")]


def strip_acc(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def clean_spaces(s):
    s = re.sub(r"\s+", " ", s.replace(" ", " ")).strip()
    s = re.sub(r",(?=[^\s\d])", ", ", s)
    s = re.sub(r"\(\s+", "(", s)
    s = re.sub(r"\s+\)", ")", s)
    return s.strip(" .,-")


def nice(name):
    """Mayúsculas razonables tipo 'Obra Social de …', con tildes para palabras frecuentes."""
    s = clean_spaces(name)
    for pat, rep in LEGAL:
        s = re.sub(pat, rep, s, flags=re.I)
    out = []
    in_paren = False
    toks = s.split(" ")
    for i, tok in enumerate(toks):
        if tok.startswith("("):
            in_paren = True
        core = re.sub(r"[^\wÁÉÍÓÚÑÜáéíóúñü]", "", tok)
        up = core.upper()
        if tok in ("S.A.", "S.R.L.", "S.A.S.", "S.A.U.", "Ltda."):
            out.append(tok)
        elif in_paren and len(core) <= 12 and core.isupper():
            out.append(tok.upper())
        elif "." in tok.strip(".") or ":" in tok or up in KEEP_UPPER or (len(core) >= 2 and not re.search(r"[AEIOUÁÉÍÓÚaeiouáéíóú]", core)):
            out.append(tok.upper())
        else:
            low = tok.lower()
            low = re.sub(r"[a-záéíóúñü]+", lambda m: ACC.get(m.group(0).upper(), m.group(0)), low)
            if i > 0 and low in PARTICLES:
                out.append(low)
            else:
                # capitalizar primera letra alfabética (respetando '(' y comillas)
                out.append(re.sub(r"^([^a-záéíóúñü]*)([a-záéíóúñü])", lambda m: m.group(1) + m.group(2).upper(), low))
        if tok.endswith(")"):
            in_paren = False
    s = " ".join(out)
    s = re.sub(r"\s*-\s*$", "", s)
    return s


def key(name):
    s = strip_acc(name).upper()
    s = re.sub(r"\bEX\b.*$", "", s)
    s = re.sub(r"\bS\.?\s*A\.?\s*(U|S)?\.?\b|\bS\.?\s*R\.?\s*L\.?\b|\bLTDA\.?|\bLIMITADA\b|\bSOCIEDAD ANONIMA\b", " ", s)
    s = re.sub(r"[^A-Z0-9 ]", " ", s)
    s = s.replace("ANONLMA", "ANONIMA")
    return re.sub(r"\s+", " ", s).strip()


def slug(s):
    s = strip_acc(s).lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


# ---------------- RNOS (export oficial) ----------------
rnos = {}
lines = open("raw/rnos_dump_100.xls", encoding="latin1").read().splitlines()
hdr = lines[3].split("\t")
for l in lines[4:]:
    if not l.strip():
        continue
    r = [c.strip() for c in l.split("\t")]
    d = dict(zip(hdr, r))
    code = d["RNAS"].zfill(6)
    rnos[code] = {"code": code, "raw": clean_spaces(d["nombre"]), "sigla": clean_spaces(d["sigla"]).strip("( )"),
                  "web": d.get("web", "").strip()}

rnemp = json.load(open("rnemp.json"))
for v in rnemp.values():
    v["raw"] = clean_spaces(v["name"])

# ---------------- merge RNOS 9-xxxx (art.1 inc i) / OSDE con RNEMP ----------------
rnemp_by_key = {}
for c, v in rnemp.items():
    rnemp_by_key.setdefault(key(v["raw"]), []).append(c)
MANUAL_MERGE = {  # rnos -> rnemp, verificados a ojo por nombre exacto en ambos registros
    "400800": "614081",  # OSDE
    "903101": "211947",  # Avalian (ex ACA Salud)
    "900805": "113328",  # Swiss Medical S.A.
    "901105": "112851",  # Galeno Argentina S.A.
    "901402": "412258",  # Medifé Asociación Civil
    "902108": "311371",  # Asociación Mutual Sancor Salud
    "902900": "113366",  # Omint
    "903200": "311586",  # Mutual Federada 25 de Junio
    # B1.2: misma entidad en los dos registros, que el match por nombre exacto no agarró porque uno dice
    # "Obra Social de …" y el otro "Obra Social …"/"… de los …". Con matchKey (que saca "obra social de") chocaban.
    "125905": "616942",  # Obra Social (de) Árbitros Deportivos de la República Argentina (OSADRA)
    "118309": "610737",  # Obra Social (de) Agentes de Propaganda Médica de Córdoba (OSAPMCBA)
    "127307": "614357",  # Obra Social de (los) Trabajadores Viales y Afines de la República Argentina
    "123107": "610850",  # Obra Social (de) Talleristas a Domicilio (OSTAD)
    "904708": "313872",  # Asociación Mutual del/de Control Integral (AMCI)
    "906803": "420536",  # Colegio Médico de San Juan (Asociación Civil)
    "701002": "614937",  # Obra Social del/para el Personal Municipal de Tres de Febrero
    "906209": "112110",  # Vitas S.A. / Vita`s S.A.
}
merge = dict(MANUAL_MERGE)
for c, v in rnos.items():
    if c in merge:
        continue
    cands = rnemp_by_key.get(key(v["raw"]), [])
    if len(cands) == 1 and cands[0] not in merge.values():
        merge[c] = cands[0]

# ---------------- marcas conocidas: shortName/aliases (curado) ----------------
BRAND = {
    "400800": ("OSDE", ["OSDE", "Organización de Servicios Directos Empresarios"]),
    "903101": ("Avalian", ["Avalian", "ACA Salud", "Aca Salud", "ACA Salud Cooperativa"]),
    "900805": ("Swiss Medical", ["Swiss Medical", "SMG", "Swiss Medical Medicina Privada"]),
    "901105": ("Galeno", ["Galeno", "Galeno Salud"]),
    "901402": ("Medifé", ["Medifé", "Medife"]),
    "902108": ("Sancor Salud", ["Sancor Salud", "SanCor Salud"]),
    "902900": ("Omint", ["Omint"]),
    "903200": ("Federada Salud", ["Federada Salud", "Federada", "Mutual Federada 25 de Junio"]),
    "500807": ("PAMI", ["PAMI", "INSSJP", "Instituto Nacional de Servicios Sociales para Jubilados y Pensionados"]),
    "112400": ("OSAM", ["OSAM", "OSAM Salud", "Obra Social de la Actividad Minera"]),
    "401704": ("OSDEPYM", ["Osdepym", "OSDEPYM"]),
    "106302": ("OSDOP", ["Osdop", "OSDOP"]),
    "105804": ("OSCHOCA", ["OSCHOCA"]),
    "126205": ("OSECAC", ["OSECAC"]),
    "125707": ("OSPCN", ["OSPCN", "UPCN", "Unión Personal"]),
    "119302": ("OSPRERA", ["OSPRERA"]),
}
BRAND.update({
    "903507": ("Prevención Salud", ["Prevención Salud", "Prevencion Salud"]),
    "901006": ("Medicus", ["Medicus"]),
    "901204": ("Hospital Alemán", ["Hospital Alemán"]),
    "904203": ("Premedica", ["Premedica"]),
    "902702": ("Hospital Italiano", ["Hospital Italiano", "Plan de Salud Hospital Italiano", "Hospital Italiano de Buenos Aires"]),
})
RNEMP_BRAND = {
    "111438": ("Hominis", ["Hominis"]),
}

rows = []
cross = []


def rtype_rnos(code, raw):
    if code[0] != "9":
        return "OBRA_SOCIAL_NACIONAL"
    u = strip_acc(raw).upper()
    if "MUTUAL" in u or "SOCORROS MUTUOS" in u or "MUTUALIDAD" in u:
        return "MUTUAL"
    if u.startswith("OBRA SOCIAL"):
        return "OBRA_SOCIAL_NACIONAL"
    if re.search(r"\bS\.?\s*A\b|S\.?R\.?L|COOPERATIVA|SALUD|MEDIC", u):
        return "PREPAGA"
    return "OTRA"


def rtype_rnemp(raw):
    u = strip_acc(raw).upper()
    if u.startswith("OBRA SOCIAL"):
        return "OBRA_SOCIAL_NACIONAL"
    if "MUTUAL" in u or "SOCORROS MUTUOS" in u or "MUTUALIDAD" in u:
        return "MUTUAL"
    return "PREPAGA"


merged_rnemp = set(merge.values())
for c, v in sorted(rnos.items()):
    name = nice(v["raw"])
    aliases = []
    short = v["sigla"] if v["sigla"] and len(v["sigla"]) <= 20 else ""
    if c in BRAND:
        short = BRAND[c][0]
        aliases += BRAND[c][1]
    if v["sigla"]:
        aliases.append(v["sigla"])
    if v["raw"].upper() != name.upper():
        aliases.append(v["raw"])
    t = rtype_rnos(c, v["raw"])
    src, url = "SSS-RNOS", RNOS_URL
    if c in merge:
        e = rnemp[merge[c]]
        if c[0] == "9":
            t = "MUTUAL" if rtype_rnos(c, v["raw"]) == "MUTUAL" else "PREPAGA"
        if c == "400800":
            t = "PREPAGA"  # OSDE: obra social de personal de dirección + entidad de medicina prepaga (RNEMP 6-1408-1)
        if e["raw"].upper() != v["raw"].upper():
            aliases.append(e["raw"])
        src, url = "SSS-RNOS+SSS-RNEMP", RNOS_URL + " | " + RNEMP_URL
        cross.append({"code": c, "rnos": c, "rnemp": merge[c], "rnosName": v["raw"], "rnempName": e["raw"],
                      "method": "manual" if c in MANUAL_MERGE else "nombre-normalizado"})
    if c == "400800":
        name = "OSDE – Organización de Servicios Directos Empresarios"
    if c == "500807":
        name = "Instituto Nacional de Servicios Sociales para Jubilados y Pensionados (PAMI)"
    rows.append({"code": c, "name": name, "shortName": short, "type": t, "aliases": aliases, "source": src,
                 "sourceDate": DATE, "sourceUrl": url})

for c, v in sorted(rnemp.items()):
    if c in merged_rnemp:
        continue
    name = nice(v["raw"])
    aliases, short = [], ""
    if c in RNEMP_BRAND:
        short = RNEMP_BRAND[c][0]
        aliases += RNEMP_BRAND[c][1]
    if v["raw"].upper() != name.upper():
        aliases.append(v["raw"])
    rows.append({"code": c, "name": name, "shortName": short, "type": rtype_rnemp(v["raw"]), "aliases": aliases,
                 "source": "SSS-RNEMP", "sourceDate": DATE, "sourceUrl": RNEMP_URL})

# ---------------- 24 obras sociales provinciales (COSSPRA) ----------------
# (sigla, nombre completo, provincia, web oficial listada por COSSPRA, aliases extra)
PROV = [
    ("ISJ", "Instituto de Seguros de Jujuy", "Jujuy", "https://isj.gov.ar/", []),
    ("OSEP", "Obra Social de los Empleados Públicos", "Catamarca", "https://www.osep.gob.ar/osep/", ["OSEP Catamarca"]),
    ("IOSEP", "Instituto de Obra Social del Empleado Provincial", "Santiago del Estero", "https://www.iosep.gob.ar/", []),
    ("IPS", "Instituto Provincial de Salud de Salta", "Salta", "https://www.ipssalta.gov.ar/", ["IPS Salta"]),
    ("IPSST", "Instituto de Previsión y Seguridad Social de Tucumán", "Tucumán", "https://ipsst.gov.ar/", ["Subsidio de Salud Tucumán"]),
    ("APOS", "Administración Provincial de Obra Social", "La Rioja", "https://aposlr.gob.ar/", ["APOS La Rioja"]),
    ("OSER", "Obra Social de Entre Ríos", "Entre Ríos", "https://www.oser.gob.ar/", ["IOSPER", "Instituto de Obra Social de la Provincia de Entre Ríos"]),
    ("INSSSEP", "Instituto de Seguridad Social, Seguros y Préstamos", "Chaco", "https://www.insssep.gob.ar/", ["INSSSeP", "INSSEP"]),
    ("IPSM", "Instituto de Previsión Social de Misiones", "Misiones", "https://ipsmisiones.com.ar/", ["IPS Misiones"]),
    ("IOSCOR", "Instituto de Obra Social de Corrientes", "Corrientes", "https://ioscor.gob.ar/", []),
    ("IASEP", "Instituto de Asistencia Social para Empleados Públicos", "Formosa", "https://iasep.gob.ar/", []),
    ("ObSBA", "Obra Social de la Ciudad de Buenos Aires", "Ciudad Autónoma de Buenos Aires", "https://www.obsba.org.ar/", ["OBSBA"]),
    ("IOMA", "Instituto de Obra Médico Asistencial", "Buenos Aires", "https://www.ioma.gba.gob.ar/", ["Instituto de Obra Médica Asistencial"]),
    ("IAPOS", "Instituto Autárquico Provincial de Obra Social", "Santa Fe", "https://www.iapossantafe.gob.ar/", []),
    ("APROSS", "Administración Provincial del Seguro de Salud", "Córdoba", "https://www.apross.gov.ar/", ["Apross", "ex IPAM"]),
    ("OSEP", "Obra Social de Empleados Públicos", "Mendoza", "https://osepmendoza.com.ar/web/", ["OSEP Mendoza"]),
    ("DOSEP", "Dirección de Obra Social del Estado Provincial", "San Luis", "https://dosep.sanluis.gob.ar/", []),
    ("DOS", "Dirección de Obra Social", "San Juan", "https://www.obrasocial.sanjuan.gob.ar/", ["Obra Social Provincia San Juan", "DOS San Juan"]),
    ("SEMPRE", "SEMPRE – Instituto de Seguridad Social", "La Pampa", "https://www.isslapampa.gob.ar/sempre-inicio/", ["ISS La Pampa"]),
    ("ISSN", "Instituto de Seguridad Social del Neuquén", "Neuquén", "https://www.issn.gov.ar/", []),
    ("IPROSS", "Instituto Provincial del Seguro de Salud", "Río Negro", "https://ipross.rionegro.gov.ar/", []),
    ("CSS", "Caja de Servicios Sociales", "Santa Cruz", "https://css.gov.ar/", ["CSS Santa Cruz"]),
    ("OSEF", "Obra Social del Estado Fueguino", "Tierra del Fuego", "https://osef.gob.ar/", ["ex IPAUSS"]),
    ("SEROS", "Instituto de Seguridad Social y Seguros – SEROS", "Chubut", "https://www.issys.gov.ar/", ["ISSyS", "SEROS Chubut"]),
]
for sig, full, prov, web, extra in PROV:
    code = slug(f"{sig}-{prov}") if sig in ("OSEP", "IPS", "DOS", "CSS", "APOS", "SEMPRE") else slug(sig)
    rows.append({"code": code, "name": f"{full} ({prov})", "shortName": sig if sig not in ("OSEP", "IPS", "DOS") else f"{sig} {prov}",
                 "type": "OBRA_SOCIAL_PROVINCIAL", "aliases": [sig, full] + extra, "source": "COSSPRA",
                 "sourceDate": DATE, "sourceUrl": COSSPRA_URL + " | " + web})

# ---------------- fuerzas / regímenes nacionales fuera del RNOS (curado con fuente oficial) ----------------
OTHERS = [
    ("osfa", "Obra Social de las Fuerzas Armadas", "OSFA", "OBRA_SOCIAL_NACIONAL", ["OSFA", "ex IOSFA"],
     "curado", "https://iosfa.gob.ar/novedades/463/osfa"),
    ("osffeseg", "Obra Social de las Fuerzas Federales de Seguridad", "OSFFESEG", "OBRA_SOCIAL_NACIONAL",
     ["OSFFESEG", "Gendarmería", "Prefectura", "ex IOSFA"], "curado", "https://www.argentina.gob.ar/seguridad/nueva-obra-social"),
    ("iosfa", "Instituto de Obra Social de las Fuerzas Armadas y de Seguridad (disuelto, Decreto 88/2026)", "IOSFA",
     "OBRA_SOCIAL_NACIONAL", ["IOSFA", "OSFA"], "curado", "https://iosfa.gob.ar/novedades/463/osfa"),
    ("pfa-obra-social", "Obra Social de la Policía Federal Argentina (Superintendencia de Bienestar)", "PFA",
     "OBRA_SOCIAL_NACIONAL", ["Policía Federal", "Superintendencia de Bienestar", "OSPFA"], "curado", "https://www.supbienestar.gob.ar/"),
    ("ospjn", "Obra Social del Poder Judicial de la Nación", "OSPJN", "OBRA_SOCIAL_NACIONAL", ["OSPJN"],
     "curado", "https://www.ospjn.gov.ar/"),
]
for code, name, short, t, al, src, url in OTHERS:
    rows.append({"code": code, "name": name, "shortName": short, "type": t, "aliases": al, "source": src,
                 "sourceDate": DATE, "sourceUrl": url})

# ---------------- seed benchmark sin registro identificable ----------------
for code, name in [("boreal", "Boreal"), ("confianza", "Confianza"), ("gma-salud", "GMA Salud"),
                   ("grupo-alianza-medica", "Grupo Alianza Médica")]:
    rows.append({"code": code, "name": name, "shortName": name, "type": "OTRA", "aliases": [name],
                 "source": "curado-benchmark", "sourceDate": DATE, "sourceUrl": ""})

# dedupe aliases / ensure unique codes
seen = set()
for r in rows:
    assert r["code"] not in seen, r["code"]
    seen.add(r["code"])
    al, s2 = [], set()
    for a in r["aliases"]:
        a = clean_spaces(a)
        k = key(a)
        if a and k and k not in s2 and k != key(r["name"]):
            s2.add(k)
            al.append(a.replace("|", "/"))
    r["aliases"] = "|".join(al)

FIELDS = ["code", "name", "shortName", "type", "aliases", "source", "sourceDate", "sourceUrl"]
with open("payers.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=FIELDS, quoting=csv.QUOTE_MINIMAL)
    w.writeheader()
    for r in rows:
        w.writerow(r)
with open("payer_crosswalk.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=["code", "rnos", "rnemp", "rnosName", "rnempName", "method"])
    w.writeheader()
    for r in cross:
        w.writerow(r)

# ---------------- planes ----------------
P = []
SEED = {
    "903101": ["Plan Único", "Clásica Plan 2", "PMO", "Prepago", "Selecta", "Superior"],  # Aca Salud (Plan Único) + Avalian
    "boreal": ["A2", "Magnun"],
    "903200": ["7", "Plan Único"],
    "grupo-alianza-medica": ["Todos los planes"],
    "iapos": ["Plan Único"],
    "ioma": ["IO Plan A", "IO Plan B", "Plan 056"],
    "112400": ["No Mineros", "Plan Único"],
    "105804": ["Plan Único"],
    "401704": ["Pyme 1000", "Pyme 2000", "Pyme 4000", "Visitar"],
    "106302": ["Plan Único"],
    "126205": ["Azul", "Carhue"],
}
for pc, plans in SEED.items():
    for p in plans:
        P.append((pc, p, "curado-benchmark", DATE, ""))
WEB = [
    ("400800", ["210", "310", "410", "450", "510"], "https://www.osde.com.ar/novedades/te-gustaria-conocer-los-precios-de-cada-plan-de-osde"),
    ("400800", ["Flux"], "https://www.osde.com.ar/planes/flux"),
] + [("900805", [f"SMG{n}"], f"https://www.swissmedical.com.ar/smgnewsite/pag_internas/pdf/planes/SMG{n}.pdf")
       for n in ("02", "20", "30", "40", "50", "60", "70")] + [
    ("901105", ["220", "330", "440", "550", "Plan Joven 18-25"],
     "https://www.galeno.com.ar/blog/planes-galeno-cual-es-el-plan-de-salud-ideal-para-tu-familia/"),
    ("901402", ["Medifé+", "Bronce Classic", "Bronce", "Plata", "Oro", "Platinum", "Indie"], "https://www.medife.com.ar/planes"),
    ("902900", ["Omint Vos", "Génesis", "Clásico", "Global", "Premium", "Comunidad"], "https://www.omint.com.ar/PlanDeSalud/PlanesOmint"),
    ("902108", ["1000", "1500"], "https://sancorsalud.com.ar/planes"),
    ("902108", ["2500"], "https://repo.sancorsalud.com.ar/webinstitucional/assets/pdf/condiciones-supra-salud.pdf"),
    ("902108", ["2000", "3000", "3500", "4000", "4500", "5000", "6000"],
     "https://repo.sancorsalud.com.ar/webgen/assets/pdf/supra-salud/SCS-DR05232-SUF.pdf"),
    ("903507", ["A1"], "https://www.prevencionsalud.com.ar/blog/como-elegir-el-plan-de-prevencion-salud-que-mejor-se-adapte-a-vos"),
] + [("903507", [f"A{n}"], f"https://www.prevencionsalud.com.ar/planes/a{n}") for n in (2, 4, 5, 6)] + [
]
for pc, plans, url in WEB:
    for p in plans:
        P.append((pc, p, "web-oficial", DATE, url))
codes = {r["code"] for r in rows}
seenp = set()
with open("payer_plans.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["payerCode", "planName", "source", "sourceDate", "sourceUrl"])
    for pc, p, s, d, u in P:
        assert pc in codes, pc
        k = (pc, p.lower())
        if k in seenp:
            continue
        seenp.add(k)
        w.writerow([pc, p, s, d, u])

import collections
print("payers", len(rows), collections.Counter(r["type"] for r in rows), collections.Counter(r["source"] for r in rows))
print("merged", len(cross), "plans", len(seenp))

"""Construye specialties.csv y practices.csv."""
import csv, re, unicodedata

DATE = "2026-09-30"
U1814 = "https://www.argentina.gob.ar/sites/default/files/8-resolucion-1814-especialidades-medicas.pdf"
U4187 = "https://www.boletinoficial.gob.ar/detalleAviso/primera/300981/20231218"
U24317 = "https://www.argentina.gob.ar/normativa/nacional/norma-716"
UREFEPS = "https://guias.hl7.org.ar/site/CodeSystem-ProfesionesREFEPS.html"
UAJRPT = "https://www.scielo.org.ar/scielo.php?pid=S2618-40952024000300001&script=sci_arttext&tlng=es"
UPMO = "https://www.argentina.gob.ar/normativa/recurso/73649/texactres201-2002MS-anexoII/htm"
UPAMI = "https://www.pami.org.ar/pdf/manual_nomenclador.pdf"
UOSEP = "https://osepmendoza.com.ar/web/wp-content/uploads/2020/04/RS-HD-2022-1237-.pdf"


def slug(s):
    s = "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn").lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


# Res. MS 1814/2015 Anexo I, en el orden del PDF (texto oficial en mayúsculas sin tildes -> alias).
MED = [
    ("Clínica Médica", "CLINICA MEDICA"),
    ("Medicina General y/o Medicina de Familia", "MEDICINA GENERAL y/o MEDICINA DE FAMILIA|Medicina General|Medicina Familiar"),
    ("Alergia e Inmunología", "ALERGIA E INMUNOLOGIA"),
    ("Cardiología", "CARDIOLOGIA"),
    ("Angiología General y Hemodinamia", "ANGIOLOGIA GENERAL Y HEMODINAMIA"),
    ("Dermatología", "DERMATOLOGIA"),
    ("Endocrinología", "ENDOCRINOLOGIA"),
    ("Farmacología Clínica", "FARMACOLOGIA CLINICA"),
    ("Fisiatría (Medicina Física y Rehabilitación)", "FISIATRIA (MEDICINA FISICA Y REHABILITACION)|Fisiatría|Medicina Física y Rehabilitación"),
    ("Gastroenterología", "GASTROENTEROLOGIA"),
    ("Genética Médica", "GENETICA MEDICA"),
    ("Geriatría", "GERIATRIA"),
    ("Hematología", "HEMATOLOGIA"),
    ("Infectología", "INFECTOLOGIA"),
    ("Nefrología", "NEFROLOGIA"),
    ("Neumonología", "NEUMONOLOGIA|Neumología"),
    ("Neurología", "NEUROLOGIA"),
    ("Nutrición (médica)", "NUTRICION|Médico nutricionista"),
    ("Oncología", "ONCOLOGIA"),
    ("Reumatología", "REUMATOLOGIA"),
    ("Terapia Intensiva", "TERAPIA INTENSIVA"),
    ("Cirugía General", "CIRUGIA GENERAL"),
    ("Cirugía Cardiovascular", "CIRUGIA CARDIOVASCULAR"),
    ("Cirugía de Cabeza y Cuello", "CIRUGIA DE CABEZA Y CUELLO"),
    ("Cirugía de Tórax (Cirugía Torácica)", "CIRUGIA DE TORAX (CIRUGIA TORACICA)"),
    ("Cirugía Infantil (Cirugía Pediátrica)", "CIRUGIA INFANTIL (CIRUGIA PEDIATRICA)"),
    ("Cirugía Plástica y Reparadora", "CIRUGIA PLASTICA Y REPARADORA"),
    ("Cirugía Vascular Periférica", "CIRUGIA VASCULAR PERIFERICA"),
    ("Coloproctología", "COLOPROCTOLOGIA"),
    ("Ginecología", "GINECOLOGIA"),
    ("Neurocirugía", "NEUROCIRUGIA"),
    ("Obstetricia", "OBSTETRICIA"),
    ("Oftalmología", "OFTALMOLOGIA"),
    ("Ortopedia y Traumatología", "ORTOPEDIA Y TRAUMATOLOGIA|Traumatología y Ortopedia|Traumatología"),
    ("Otorrinolaringología", "OTORRINOLARINGOLOGIA"),
    ("Tocoginecología", "TOCOGINECOLOGIA"),
    ("Urología", "UROLOGIA"),
    ("Pediatría", "PEDIATRIA"),
    ("Cardiología Infantil", "CARDIOLOGO INFANTIL"),
    ("Endocrinología Infantil", "ENDOCRINOLOGO INFANTIL"),
    ("Gastroenterología Infantil", "GASTROENTEROLOGO INFANTIL"),
    ("Infectología Infantil", "INFECTOLOGO INFANTIL"),
    ("Nefrología Infantil", "NEFROLOGO INFANTIL"),
    ("Neonatología", "NEONATOLOGIA"),
    ("Neumonología Infantil", "NEUMONOLOGO INFANTIL"),
    ("Neurología Infantil", "NEUROLOGO INFANTIL"),
    ("Reumatología Infantil", "REUMATOLOGO INFANTIL"),
    ("Terapia Intensiva Infantil", "TERAPISTA INTENSIVO INFANTIL"),
    ("Psiquiatría", "PSIQUIATRIA"),
    ("Psiquiatría Infanto Juvenil", "PSIQUIATRIA INFANTO JUVENIL"),
    ("Anatomía Patológica", "ANATOMIA PATOLOGICA"),
    ("Anestesiología", "ANESTESIOLOGIA"),
    ("Diagnóstico por Imágenes", "DIAGNOSTICO POR IMAGENES"),
    ("Hemoterapia e Inmunohematología", "HEMOTERAPIA E INMUNOHEMATOLOGIA"),
    ("Medicina del Deporte", "MEDICINA DEL DEPORTE|Medicina Deportiva"),
    ("Medicina del Trabajo", "MEDICINA DEL TRABAJO|Medicina Laboral"),
    ("Medicina Legal", "MEDICINA LEGAL"),
    ("Medicina Nuclear", "MEDICINA NUCLEAR"),
    ("Radioterapia o Terapia Radiante", "RADIOTERAPIA O TERAPIA RADIANTE"),
    ("Toxicología", "TOXICOLOGIA"),
    ("Dermatología Pediátrica", "DERMATOLOGIA PEDIATRICA"),
    ("Emergentología", "EMERGENTOLOGIA"),
    ("Electrofisiología Cardíaca", "ELECTRO FISIOLOGIA CARDIACA"),
    ("Ortopedia y Traumatología Infantil", "ORTOPEDIA Y TRAUMATOLOGIA INFANTIL"),
    ("Hepatología", "HEPATOLOGIA"),
    ("Hepatología Pediátrica", "HEPATOLOGIA PEDIATRICA"),
    ("Alergia e Inmunología Pediátrica", "ALERGIA E INMUNOLOGIA PEDIATRICA"),
    ("Cirugía Cardiovascular Pediátrica", "CIRUGIA CARDIOVASCULAR PEDIATRICA"),
    ("Hemato-Oncología Pediátrica", "HEMATO-ONCOLOGIA PEDIÁTRICA"),
    ("Medicina Paliativa", "MEDICINA PALITATIVA|Cuidados Paliativos"),
]
MED_CODE = {
    "Nutrición (médica)": "med-nutricion",
    "Fisiatría (Medicina Física y Rehabilitación)": "med-fisiatria",
    "Medicina General y/o Medicina de Familia": "med-medicina-general-familia",
}

S = []
for name, al in MED:
    code = MED_CODE.get(name, "med-" + slug(re.sub(r"\s*\(.*\)", "", name)))
    S.append((code, name, al, "MSAL-Res1814/2015", DATE, U1814))

# Profesiones de la salud (REFEPS) + ley de ejercicio de la kinesiología.
PROF = [
    ("prof-kinesiologia", "Kinesiología y Fisioterapia",
     "Kinesiología y Fisiatría|Kinesiología|Fisioterapia|Fisiatría (kinesiólogo)|Kinesiólogo|Licenciado en Kinesiología|Licenciado en Kinesiología y Fisiatría|Terapia Física|Licenciado en Terapia Física|Fisioterapeuta|Terapista Físico",
     "Ley 24.317 + REFEPS (profesiones 9, 10, 11)", U24317 + " | " + UREFEPS),
    ("prof-terapia-ocupacional", "Terapia Ocupacional", "Terapista Ocupacional|Licenciado en Terapia Ocupacional|TO",
     "REFEPS (profesiones 13, 14)", UREFEPS),
    ("prof-fonoaudiologia", "Fonoaudiología", "Fonoaudiólogo|Licenciado en Fonoaudiología|Fono",
     "REFEPS (profesiones 18, 19)", UREFEPS),
    ("prof-nutricion", "Nutrición (Licenciatura)", "Nutricionista|Licenciado en Nutrición|Nutricionista Dietista|Dietista",
     "REFEPS (profesiones 20, 21, 22)", UREFEPS),
    ("prof-psicologia", "Psicología", "Psicólogo|Licenciado en Psicología", "REFEPS (profesiones 5, 6)", UREFEPS),
    ("prof-podologia", "Podología", "Podólogo|Podólogo Universitario|Pedicuro", "REFEPS (profesiones 127, 128, 129)", UREFEPS),
    ("prof-psicopedagogia", "Psicopedagogía", "Psicopedagogo|Licenciado en Psicopedagogía", "REFEPS (profesiones 7, 8)", UREFEPS),
    ("prof-psicomotricidad", "Psicomotricidad", "Psicomotricista|Licenciado en Psicomotricidad", "REFEPS (profesiones 17, 145)", UREFEPS),
    ("prof-musicoterapia", "Musicoterapia", "Musicoterapeuta|Licenciado en Musicoterapia", "REFEPS (profesiones 15, 16)", UREFEPS),
    ("prof-odontologia", "Odontología", "Odontólogo|Dentista", "REFEPS (profesión 2)", UREFEPS),
    ("prof-enfermeria", "Enfermería", "Enfermero|Licenciado en Enfermería", "REFEPS (profesiones 3, 62-65)", UREFEPS),
]
for code, name, al, src, url in PROF:
    S.append((code, name, al, src, DATE, url))

# Especialidades de la kinesiología reconocidas a nivel nacional (Res. MS 4187/2023, Anexo I).
KINE = [
    ("kine-pediatrica-neonatal", "Kinesiología Pediátrica y Neonatal", "Kinesiología Pediátrica|Kinesiología en Pediatría|Kinesiología Neonatal"),
    ("kine-cardiorrespiratoria", "Kinesiología Cardiorrespiratoria", "Kinesiología Respiratoria|Kinesiología Cardiovascular|Rehabilitación Cardiopulmonar"),
    ("kine-cuidados-intensivos", "Kinesiología en Cuidados Intensivos", "Kinesiología Intensivista|Kinesiología en UTI"),
    ("kine-neurologica", "Kinesiología Neurológica", "Neurorrehabilitación Kinésica|Neurokinesiología"),
]
for code, name, al in KINE:
    S.append((code, name, al, "MSAL-Res4187/2023", DATE, U4187))
# Reconocidas solo a nivel provincial (Mendoza, Res. 534/2022, citada por AJRPT 2024). No verificadas en la norma original.
for code, name, al in [
    ("kine-general", "Kinesiología General", "Kinesiología Clínica"),
    ("kine-traumato-deporte", "Kinesiología en Traumatología, Ortopedia y Deporte", "Kinesiología Deportiva|Kinesiología Traumatológica|Kinesiología Musculoesquelética"),
    ("kine-terapias-manuales", "Kinesiología en Terapias Manuales", "Terapia Manual|Terapia Manual Ortopédica"),
    ("kine-dermatofuncional", "Kinesiología Dermatofuncional y Estética", "Kinesiología Dermatofuncional|Kinesiología Estética"),
]:
    S.append((code, name, al, "curado", DATE, UAJRPT))
# Curadas para el producto (no reconocidas como especialidad oficial nacional).
S.append(("osteopatia", "Osteopatía", "Osteópata|Osteopatía Estructural|Osteopatía Visceral|Osteopatía Craneal|Terapia Craneosacral", "curado", DATE, ""))
S.append(("kine-uroginecologica", "Kinesiología Uroginecológica (Piso Pélvico)", "Kinesiología de Piso Pélvico|Rehabilitación de Piso Pélvico|Kinesiología Pelviperineal", "curado", DATE, ""))

codes = [s[0] for s in S]
assert len(codes) == len(set(codes)), [c for c in codes if codes.count(c) > 1]
with open("specialties.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["code", "name", "aliases", "source", "sourceDate", "sourceUrl"])
    for r in S:
        w.writerow(r)
SPEC = set(codes)

# ---------------- prácticas ----------------
K = "prof-kinesiologia"
O = "osteopatia"
P = []


def add(code, name, spec, dur, aliases, source, url):
    assert spec == "" or spec in SPEC, spec
    P.append((code, name, spec, dur, aliases, source, DATE, url))


# Códigos PMO / Nomenclador Nacional (Res. MS 201/2002 Anexo II, "Rehabilitación médica" y otros capítulos)
add("250101", "Fisioterapia por sesión (agentes físicos)", K, 30,
    "Fisioterapia|Agentes físicos|25.01.01|Electroterapia|Onda corta|Microondas|Ultravioleta|Infrarrojo|Iontoforesis|Tracción cervical o pelviana",
    "PMO-Res201/2002", UPMO + " | " + UPAMI)
add("250102", "Kinesioterapia por sesión", K, 45,
    "Sesión de kinesiología|Kinesiología|Kinesioterapia|25.01.02|Terapia física|Movilización pasiva o activa|Reeducación|Gimnasia médica|Fortalecimiento muscular",
    "PMO-Res201/2002", UPMO + " | " + UPAMI)
add("250103", "Terapia ocupacional por sesión", "prof-terapia-ocupacional", 45, "Sesión de terapia ocupacional|25.01.03|PAMI 123004",
    "PMO-Res201/2002", UPMO)
add("250104", "Rehabilitación del lenguaje por sesión", "prof-fonoaudiologia", 45, "Sesión de fonoaudiología|Terapia del lenguaje|25.01.04",
    "PMO-Res201/2002", UPMO)
add("250105", "Pilones para amputados (alineación)", "med-fisiatria", 30, "25.01.05", "PMO-Res201/2002", UPMO)
add("250106", "Kinesioterapia o fisiatría a domicilio", K, 60, "Kinesiología a domicilio|Atención kinésica domiciliaria|25.01.06|PAMI 250121",
    "PMO-Res201/2002", UPMO + " | " + UPAMI)
add("420101", "Consulta médica en consultorio", "", 20, "Consulta|Consulta en consultorio|42.01.01", "PMO-Res201/2002", UPMO)
add("420201", "Consulta médica en domicilio", "", 30, "Consulta a domicilio|42.02.01", "PMO-Res201/2002", UPMO)
add("330101", "Psicoterapia individual (niños o adultos)", "prof-psicologia", 50, "Sesión de psicoterapia|Sesión de psicología|33.01.01",
    "PMO-Res201/2002", UPMO)
add("330102", "Psicoterapia grupal o colectiva (niños o adultos)", "prof-psicologia", 90, "Terapia grupal|33.01.02", "PMO-Res201/2002", UPMO)
add("330103", "Psicoterapia de pareja o familia", "prof-psicologia", 60, "Terapia de pareja|Terapia familiar|33.01.03", "PMO-Res201/2002", UPMO)
add("310102", "Audiometría", "prof-fonoaudiologia", 30, "31.01.02", "PMO-Res201/2002", UPMO)
add("310103", "Logoaudiometría", "prof-fonoaudiologia", 30, "31.01.03", "PMO-Res201/2002", UPMO)

# Prácticas con nombre/código en nomencladores oficiales de financiadores (PAMI, OSEP Mendoza): el código de ese
# financiador va en aliases; el code del catálogo es slug porque no es un código del Nomenclador Nacional.
add("drenaje-linfatico-manual", "Drenaje linfático manual (sesión)", K, 45, "Drenaje linfático|DLM|Sesión de drenaje linfático|PAMI 250120",
    "PAMI-nomenclador", UPAMI)
add("rpg", "Reeducación Postural Global (RPG)", K, 60, "RPG|Reeducación postural|Rehabilitación postural global|PAMI 124001|OSEP 03-250116-00",
    "PAMI-nomenclador+OSEP-Mendoza", UPAMI + " | " + UOSEP)
add("rehabilitacion-vestibular", "Rehabilitación vestibular y/o laberíntica (sesión)", K, 45, "Rehabilitación vestibular|Rehabilitación del vértigo|PAMI 250114",
    "PAMI-nomenclador", UPAMI)
add("rehabilitacion-cardiopulmonar", "Rehabilitación cardiopulmonar (sesión de kinesioterapia)", "kine-cardiorrespiratoria", 60,
    "Rehabilitación cardíaca|Rehabilitación cardiovascular|PAMI 126002", "PAMI-nomenclador+OSEP-Mendoza", UPAMI + " | " + UOSEP)
add("hidroterapia", "Hidroterapia (sesión)", K, 45, "Hidrokinesioterapia|Kinesiología acuática|Rehabilitación en pileta|OSEP 10502-00",
    "OSEP-Mendoza", UOSEP)
add("rehabilitacion-venolinfatica", "Rehabilitación kinésica venolinfática", K, 45, "Rehabilitación veno-linfática|Linfedema|OSEP 10507-00",
    "OSEP-Mendoza", UOSEP)
add("rehabilitacion-dermatofuncional", "Rehabilitación kinésica dermatofuncional (sesión)", "kine-dermatofuncional", 45,
    "Kinesiología dermatofuncional|Rehabilitación postquirúrgica estética|Tratamiento de cicatrices", "OSEP-Mendoza", UOSEP)
add("neurorrehabilitacion-kinesica", "Neurorrehabilitación kinésica (sesión)", "kine-neurologica", 45,
    "Kinesiología neurológica|Neurorrehabilitación|OSEP 03-251002-00", "OSEP-Mendoza", UOSEP)
add("fisiokinesioterapia", "Fisiokinesioterapia (sesión combinada: agentes físicos + kinesioterapia)", K, 45,
    "Fisiokinesioterapia|FKT|Sesión de kinesiología|Fisio-kinesioterapia|OSEP 01-250101-00 / 10501-00",
    "OSEP-Mendoza", UOSEP)
add("rehabilitacion-neurocognitiva", "Rehabilitación neurocognitiva (sesión)", "prof-terapia-ocupacional", 45,
    "Estimulación cognitiva|PAMI 125001", "PAMI-nomenclador", UPAMI)
add("fono-deglucion-afasia", "Fonoaudiología: rehabilitación deglutoria y afasiología (sesión)", "prof-fonoaudiologia", 45,
    "Terapia de deglución|Afasia|PAMI 123005", "PAMI-nomenclador", UPAMI)
add("consulta-fisiatria", "Consulta con especialista en Fisiatría", "med-fisiatria", 30, "Consulta fisiátrica|PAMI 820135", "PAMI-nomenclador", UPAMI)
add("consulta-fonoaudiologia", "Consulta / evaluación fonoaudiológica", "prof-fonoaudiologia", 45, "Evaluación fonoaudiológica|PAMI 820137",
    "PAMI-nomenclador", UPAMI)
add("consulta-nutricion", "Consulta de nutrición (primera vez)", "prof-nutricion", 45, "Consulta nutricional|Evaluación nutricional|PAMI 820159",
    "PAMI-nomenclador", UPAMI)
add("consulta-nutricion-seguimiento", "Consulta de seguimiento con Lic. en Nutrición", "prof-nutricion", 30, "Control nutricional|PAMI 820153",
    "PAMI-nomenclador", UPAMI)

# Curadas (sin código oficial): kinesiología / fisioterapia
CK = [
    ("evaluacion-kinesica-inicial", "Evaluación kinésica inicial", K, 60, "Primera consulta kinésica|Evaluación funcional|Admisión kinésica"),
    ("reevaluacion-kinesica", "Reevaluación kinésica", K, 30, "Control kinésico|Evaluación de seguimiento"),
    ("rehabilitacion-postquirurgica", "Rehabilitación postquirúrgica (sesión)", K, 45, "Rehabilitación post operatoria|Postquirúrgico|Rehabilitación traumatológica"),
    ("kinesiologia-respiratoria", "Kinesiología respiratoria (sesión)", "kine-cardiorrespiratoria", 45, "Kinesioterapia respiratoria|Rehabilitación respiratoria|KTR"),
    ("kinesiologia-deportiva", "Kinesiología deportiva (sesión)", "kine-traumato-deporte", 45, "Rehabilitación deportiva|Readaptación deportiva"),
    ("piso-pelvico", "Rehabilitación de piso pélvico (sesión)", "kine-uroginecologica", 45, "Kinesiología uroginecológica|Reeducación perineal|Incontinencia"),
    ("gimnasia-terapeutica", "Gimnasia terapéutica / ejercicio terapéutico", K, 45, "Ejercicio terapéutico|Gimnasia médica|Gimnasia correctiva"),
    ("pilates-terapeutico", "Pilates terapéutico", K, 50, "Pilates clínico|Pilates reformer terapéutico"),
    ("terapia-manual", "Terapia manual (sesión)", "kine-terapias-manuales", 45, "Terapia manual ortopédica|Movilización articular|Manipulación"),
    ("masoterapia", "Masoterapia / masaje terapéutico", K, 30, "Masaje terapéutico|Masaje descontracturante|Masaje"),
    ("magnetoterapia", "Magnetoterapia", K, 30, "Magneto|Campos magnéticos pulsados"),
    ("electroestimulacion", "Electroestimulación (TENS / EMS)", K, 30, "TENS|EMS|Electroterapia|Corrientes interferenciales|Electroanalgesia"),
    ("ultrasonido-terapeutico", "Ultrasonido terapéutico", K, 20, "Ultrasonido|US terapéutico|Ultrasonoterapia"),
    ("laserterapia", "Laserterapia", K, 20, "Láser|Láser terapéutico|Laser de alta potencia"),
    ("ondas-de-choque", "Ondas de choque", K, 20, "Ondas de choque radiales|ESWT|Terapia de ondas de choque"),
    ("puncion-seca", "Punción seca", K, 30, "Dry needling|Punción seca de puntos gatillo"),
    ("vendaje-neuromuscular", "Vendaje neuromuscular (kinesiotaping)", K, 20, "Kinesiotaping|Kinesio tape|Taping"),
    ("crioterapia", "Crioterapia", K, 15, "Frío terapéutico|Hielo"),
    ("termoterapia", "Termoterapia / fomentación", K, 15, "Calor terapéutico|Compresas calientes|Infrarrojo"),
    ("traccion-vertebral", "Tracción cervical / lumbar", K, 20, "Tracción cervical|Tracción lumbar|Tracción vertebral"),
    ("presoterapia", "Presoterapia", K, 30, "Pressoterapia|Compresión neumática"),
    ("radiofrecuencia", "Radiofrecuencia / diatermia", K, 20, "Diatermia|Tecarterapia|Radiofrecuencia capacitiva-resistiva"),
    ("atm-kinesiologia", "Rehabilitación de ATM (articulación temporomandibular)", K, 45, "ATM|Bruxismo|Disfunción temporomandibular"),
    ("kinesiologia-pediatrica", "Kinesiología pediátrica (sesión)", "kine-pediatrica-neonatal", 45, "Kinesiología infantil|Estimulación motora"),
    ("kinesiologia-neurologica-adulto", "Kinesiología neurológica adultos (sesión)", "kine-neurologica", 45, "ACV|Parkinson|Rehabilitación neurológica"),
    ("rehabilitacion-escoliosis", "Rehabilitación de escoliosis (método específico)", K, 60, "Schroth|Escoliosis"),
]
for code, name, spec, dur, al in CK:
    add(code, name, spec, dur, al, "curado", "")

# Osteopatía (curado)
for code, name, dur, al in [
    ("evaluacion-osteopatica-inicial", "Evaluación osteopática inicial", 60, "Primera consulta osteopática"),
    ("sesion-osteopatia", "Sesión de osteopatía", 45, "Osteopatía|Tratamiento osteopático"),
    ("osteopatia-estructural", "Osteopatía estructural", 45, "Manipulación osteopática|Técnicas estructurales|OMT"),
    ("osteopatia-visceral", "Osteopatía visceral", 45, "Técnicas viscerales"),
    ("osteopatia-craneal", "Osteopatía craneal / craneosacral", 45, "Terapia craneosacral|Osteopatía craneosacral"),
    ("osteopatia-atm", "Osteopatía para ATM", 45, "ATM osteopática|Tratamiento osteopático de ATM"),
    ("osteopatia-pediatrica", "Osteopatía pediátrica", 45, "Osteopatía en bebés|Osteopatía infantil"),
]:
    add(code, name, O, dur, al, "curado", "")

# Consultas/evaluaciones genéricas de otras especialidades (curado; la consulta médica general es 420101)
for code, name, spec, dur, al in [
    ("consulta-traumatologia", "Consulta de traumatología", "med-ortopedia-y-traumatologia", 20, "Consulta traumatológica|Consulta ortopédica|NN 42.01.01"),
    ("consulta-medicina-deporte", "Consulta de medicina del deporte", "med-medicina-del-deporte", 30, "Consulta deportológica|NN 42.01.01"),
    ("apto-fisico-deportivo", "Apto físico deportivo", "med-medicina-del-deporte", 30, "Certificado de aptitud física|Apto médico"),
    ("consulta-reumatologia", "Consulta de reumatología", "med-reumatologia", 30, "Consulta reumatológica|NN 42.01.01"),
    ("consulta-neurologia", "Consulta de neurología", "med-neurologia", 30, "Consulta neurológica|NN 42.01.01"),
    ("evaluacion-terapia-ocupacional", "Evaluación de terapia ocupacional", "prof-terapia-ocupacional", 60, "Admisión TO|Evaluación funcional TO"),
    ("evaluacion-psicologica", "Evaluación psicológica / psicodiagnóstico (sesión)", "prof-psicologia", 50, "Psicodiagnóstico|Admisión psicológica"),
    ("consulta-podologia", "Consulta podológica", "prof-podologia", 30, "Atención podológica|Pedicuría"),
    ("tratamiento-podologico", "Tratamiento podológico (uñas / callosidades)", "prof-podologia", 45, "Onicocriptosis|Quiropodia"),
]:
    add(code, name, spec, dur, al, "curado", "")

pc = [p[0] for p in P]
assert len(pc) == len(set(pc))
with open("practices.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["code", "name", "specialtyCode", "defaultDurationMin", "aliases", "source", "sourceDate", "sourceUrl"])
    for r in P:
        w.writerow(r)
import collections
print("specialties", len(S), collections.Counter(s[3].split(" ")[0] for s in S))
print("practices", len(P), collections.Counter(p[5] for p in P))

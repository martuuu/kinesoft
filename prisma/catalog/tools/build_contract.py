"""B1.2 CAT-data: convierte la salida de la investigación (build_payers.py + build_clinical.py) al
"Contrato de CSV del catálogo" que parsea `scripts/catalog-import.ts` (B1.1).

Uso (desde una copia de esta carpeta, para no pisar los CSV del contrato con los intermedios):
    WORK=$(mktemp -d) && cp -R prisma/catalog/tools/. "$WORK" && (cd "$WORK" && \
      python3 build_payers.py && python3 build_clinical.py && \
      python3 build_contract.py --research . --out "$OLDPWD/prisma/catalog")

Por qué un paso aparte y no editar los build_*: la investigación quedó con su propio formato (code/type/source
libres) y se auditó así; este paso es la única capa que sabe del contrato (slug/kind/CatalogSource/sourceRef).

Estabilidad de slugs: si `--out` ya tiene un payers.csv, se reusa el slug de cada fila por `registryCode`
(o por slug, para las filas sin código). Un slug publicado no cambia aunque aparezca una entidad nueva con la misma
sigla: el import hace upsert por slug y cambiarlo duplicaría la prestadora.
"""
import argparse, csv, os, re, unicodedata

ap = argparse.ArgumentParser()
ap.add_argument("--research", required=True, help="carpeta con payers.csv, payer_plans.csv, specialties.csv, practices.csv")
ap.add_argument("--out", required=True, help="prisma/catalog")
args = ap.parse_args()

R = lambda f: os.path.join(args.research, f)
O = lambda f: os.path.join(args.out, f)

# rnemp.json y el dump RNOS dan el código "con guiones" (1-1332-8) para sourceRef.
import json
RNEMP_DISP = {c: v["disp"] for c, v in json.load(open(R("rnemp.json"), encoding="utf-8")).items()}


def strip_acc(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def slugify(s, maxlen=60):
    s = s.replace("+", " plus ")
    s = strip_acc(s).lower()
    # las formas societarias no aportan al slug ("medicina-privada-s-r-l")
    s = re.sub(r"\b(s\.?\s*a\.?\s*u\.?|s\.?\s*r\.?\s*l\.?|s\.?\s*a\.?\s*s\.?|s\.\s*a\.?|ltda\.?)(?=\s|$|,|\))", " ", s)
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    if len(s) > maxlen:
        s = s[:maxlen].rsplit("-", 1)[0]
    return s


def first_url(u):
    return u.split(" | ")[0].strip() if u else ""


def read(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write(path, header, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
        w.writerow(header)
        for r in rows:
            w.writerow([r.get(h, "") for h in header])


def join_aliases(aliases, *exclude):
    # Se compara sin distinguir mayúsculas pero CON tildes: el texto oficial ("CLINICA MEDICA") difiere del
    # normalizado ("Clínica Médica") y se conserva como alias, igual que en la investigación.
    seen, out = {e.lower() for e in exclude if e}, []
    for a in aliases:
        a = a.strip().replace("|", "/")
        k = a.lower()
        if a and k not in seen:
            seen.add(k)
            out.append(a)
    return "|".join(out)


# ── Port de `matchKey` (lib/catalog/normalize.ts, B1.1) ──
# El import rechaza como conflicto (y saltea) toda fila cuyo matchKey o alias choque con otra entidad. Este port
# permite dejar los CSV sin conflictos ANTES de publicarlos; la fuente de verdad sigue siendo el TS y
# tests/unit/catalog-data.test.ts corre el planner real del import sobre estos archivos (cero conflictos).
MK_PREFIXES = [(["obra", "social"], False), (["os"], False), (["instituto"], True), (["asociacion", "civil"], False),
               (["asociacion", "mutual"], False)]
MK_SUFFIXES = [["sociedad", "anonima"], ["asociacion", "civil"], ["sa"], ["sau"], ["sas"], ["srl"], ["ltda"],
               ["limitada"]]
MK_CONNECTORS = {"de", "del", "la", "el", "los", "las", "para"}


def match_key(value):
    s = "".join(c for c in unicodedata.normalize("NFD", value or "") if not unicodedata.category(c).startswith("M"))
    s = s.lower()
    s = re.sub(r"(\d)\.(?=\d)", r"\1", s)
    s = re.sub(r"['’`´]", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    if not s:
        return ""
    toks, out, run = s.split(" "), [], ""
    for t in toks:  # siglas de letras sueltas: "o s d e" -> "osde"
        if re.fullmatch(r"[a-z]", t):
            run += t
        else:
            if run:
                out.append(run)
                run = ""
            out.append(t)
    if run:
        out.append(run)
    cur, changed = out, True
    while changed:
        changed = False
        for pre, conn in MK_PREFIXES:
            if cur[:len(pre)] != pre:
                continue
            nxt = cur[len(pre):]
            if conn and not (nxt and nxt[0] in MK_CONNECTORS):
                continue
            while nxt and nxt[0] in MK_CONNECTORS:
                nxt = nxt[1:]
            if not nxt:
                continue
            cur, changed = nxt, True
            break
        for suf in MK_SUFFIXES:
            if len(cur) > len(suf) and cur[-len(suf):] == suf:
                cur, changed = cur[:-len(suf)], True
                break
    return " ".join(cur)


def drop_ambiguous_aliases(rows, key="slug"):
    """Saca de cada fila los alias cuya matchKey es (nombre o alias) de OTRA fila. Una sigla compartida ("OSPA" la
    usan 5 obras sociales) no identifica a ninguna: si se deja, el import saltea todas esas filas como conflicto."""
    owners = {}
    for r in rows:
        for k in [match_key(r["name"])] + [match_key(a) for a in r["aliases"].split("|") if a]:
            owners.setdefault(k, set()).add(r[key])
    dropped = []
    for r in rows:
        keep = []
        for a in [a for a in r["aliases"].split("|") if a]:
            if owners.get(match_key(a), set()) - {r[key]}:
                dropped.append((r[key], a))
            else:
                keep.append(a)
        r["aliases"] = "|".join(keep)
    return dropped


# ═════════════════════════════ Payers ═════════════════════════════
research_payers = read(R("payers.csv"))
crosswalk = {r["code"]: r for r in read(R("payer_crosswalk.csv"))}
prev = {}
if os.path.exists(O("payers.csv")):
    for r in read(O("payers.csv")):
        prev[r["registryCode"] or ("slug:" + r["slug"])] = r["slug"]

# Prepagas conocidas por la marca: el `name` es la marca y la razón social va a `legalName`.
BRAND_NAME = {"400800", "903101", "900805", "901105", "901402", "902108", "902900", "903200", "903507",
              "901006", "901204", "904203", "902702", "111438"}
KIND = {"OBRA_SOCIAL_NACIONAL": "OBRA_SOCIAL", "OBRA_SOCIAL_PROVINCIAL": "OBRA_SOCIAL",
        "PREPAGA": "PREPAGA", "MUTUAL": "MUTUAL", "OTRA": "OTRA"}
# Alias que apuntan a más de una prestadora y en la práctica mandan a la equivocada: "OSFA" es la sucesora,
# no IOSFA (disuelto); "OSEP" pelado es ambiguo entre Catamarca y Mendoza (quedan "OSEP Catamarca"/"OSEP Mendoza").
DROP_ALIAS = {"iosfa": {"OSFA"}, "osep-catamarca": {"OSEP"}, "osep-mendoza": {"OSEP"}}

payers = []
for r in research_payers:
    code, src = r["code"], r["source"]
    is_registry = src.startswith("SSS-")
    aliases = [a for a in r["aliases"].split("|") if a]
    row = {"sourceDate": r["sourceDate"], "sourceUrl": first_url(r["sourceUrl"]), "cuit": "", "province": "",
           "kind": KIND[r["type"]], "legalName": ""}
    if is_registry:
        row["registryCode"] = code
        if src == "SSS-RNEMP":
            row["source"], row["sourceRef"] = "RNEMP", f"RNEMP {RNEMP_DISP.get(code, code)}"
        else:
            row["source"] = "RNOS"
            ref = f"RNOS {code}"
            if code in crosswalk:  # entidad en los dos registros: el RNEMP absorbido queda en sourceRef
                rn = crosswalk[code]["rnemp"]
                ref += f"; RNEMP {RNEMP_DISP.get(rn, rn)}"
            row["sourceRef"] = ref
        name = r["name"]
        if code in BRAND_NAME:
            row["name"], row["legalName"] = r["shortName"], name
            aliases.append(name)
        else:
            row["name"], row["legalName"] = name, name
        base = r["shortName"] or name
    elif src == "COSSPRA":
        m = re.match(r"^(.*) \((.+)\)$", r["name"])
        row.update(name=r["name"], legalName=m.group(1), province=m.group(2), source="PROVINCIAL",
                   sourceRef="COSSPRA", registryCode="")
        base = code  # los slugs provinciales (ioma, osep-mendoza…) se mantienen
    else:  # curado (fuerzas, OSPJN) y curado-benchmark sin registro
        row.update(name=r["name"], source="CURATED", registryCode="",
                   sourceRef="Decreto 88/2026" if code in ("osfa", "osffeseg", "iosfa") else
                   ("benchmark 2026-09 (sin registro SSS identificable)" if src == "curado-benchmark" else ""))
        base = code
    aliases = [a for a in aliases if a not in DROP_ALIAS.get(code, set())]
    row["aliases"] = join_aliases(aliases, row["name"])
    row["_code"], row["_base"], row["_fixed"] = code, slugify(base), not is_registry
    payers.append(row)

# Entidades DISTINTAS con la misma matchKey ("Galeno" / "Galeno S.R.L.", "Obra Social Ferroviaria" / "Asociación
# Mutual Ferroviaria", dos "Medicina Privada S.R.L."): Payer.matchKey es UNIQUE. Se queda con el nombre limpio la
# marca, después la del RNOS; al resto se le agrega el código de registro al display. Las que eran la MISMA
# entidad en RNOS y RNEMP ya se fusionaron en build_payers.py (MANUAL_MERGE).
from collections import Counter
groups = {}
for p in payers:
    groups.setdefault(match_key(p["name"]), []).append(p)
for k, g in groups.items():
    if len(g) < 2:
        continue
    g.sort(key=lambda p: (p["_code"] not in BRAND_NAME, p["source"] != "RNOS", p["registryCode"]))
    for p in g[1:]:
        assert p["registryCode"], f"choque de matchKey sin código de registro: {p['name']}"
        p["name"] = f'{p["name"]} ({p["sourceRef"].split(";")[0]})'
dropped_payer_aliases = drop_ambiguous_aliases(payers, key="_code")

# Slugs: primero los fijos (provinciales/curados), después los previos, después la base; si choca, base-código.
used = set()
for p in payers:
    if p["_fixed"]:
        p["slug"] = p["_base"]
        used.add(p["slug"])
for p in payers:
    if p["_fixed"]:
        continue
    k = p["registryCode"]
    if k in prev:
        p["slug"] = prev[k]
        used.add(p["slug"])
# Las marcas (OSDE, Galeno, Hominis…) se quedan con el slug corto aunque haya otra razón social homónima.
for p in payers:
    if "slug" not in p and p["_code"] in BRAND_NAME and p["_base"] not in used:
        p["slug"] = p["_base"]
        used.add(p["slug"])
base_count = Counter(p["_base"] for p in payers if not p["_fixed"] and "slug" not in p)
for p in payers:
    if "slug" in p:
        continue
    s = p["_base"]
    if base_count[s] > 1 or s in used or not s:
        s = f'{s}-{p["registryCode"]}'.strip("-")
    assert s not in used, s
    p["slug"] = s
    used.add(s)

slug_by_code = {p["_code"]: p["slug"] for p in payers}
PAYER_H = ["slug", "name", "legalName", "kind", "registryCode", "cuit", "province", "aliases", "source", "sourceRef",
           "sourceDate", "sourceUrl"]
payers.sort(key=lambda p: p["slug"])
write(O("payers.csv"), PAYER_H, payers)

# ═════════════════════════════ Payer plans ═════════════════════════════
plans = []
for r in read(R("payer_plans.csv")):
    plans.append({"payerSlug": slug_by_code[r["payerCode"]], "slug": slugify(r["planName"]), "name": r["planName"],
                  "source": "CURATED", "sourceDate": r["sourceDate"], "sourceUrl": r["sourceUrl"],
                  "_bench": r["source"] == "curado-benchmark"})
PLAN_H = ["payerSlug", "slug", "name", "source", "sourceDate", "sourceUrl"]
write(O("payer-plans.csv"), PLAN_H, plans)

# Seed del benchmark (create-only, B1.1): las prestadoras y planes que pidió el dueño, MISMO slug que payers.csv.
SEED_CODES = ["903101", "boreal", "confianza", "903200", "gma-salud", "grupo-alianza-medica", "iapos", "ioma",
              "112400", "105804", "401704", "106302", "126205"]
by_code = {p["_code"]: p for p in payers}
seed_payers = [dict(by_code[c], source="CURATED") for c in SEED_CODES]
write(O("payers.seed-2026-09.csv"), PAYER_H, seed_payers)
write(O("payer-plans.seed-2026-09.csv"), PLAN_H, [p for p in plans if p["_bench"]])

# ═════════════════════════════ Specialties ═════════════════════════════
SPEC_REF = [
    (r"^MSAL-Res1814/2015$", "REFEPS", "Res. MS 1814/2015, Anexo I"),
    (r"^MSAL-Res4187/2023$", "REFEPS", "Res. MS 4187/2023, Anexo I"),
    (r"^Ley 24\.317 \+ REFEPS \((.+)\)$", "REFEPS", r"Ley 24.317; REFEPS \1"),
    (r"^REFEPS \((.+)\)$", "REFEPS", r"REFEPS \1"),
    (r"^curado$", "CURATED", ""),
]
CURATED_SPEC_REF = {
    "kine-general": "Mendoza Res. 534/2022 MSDSyD (vía AJRPT 2024; norma provincial no ubicada: verificar)",
    "kine-traumato-deporte": "Mendoza Res. 534/2022 MSDSyD (vía AJRPT 2024; norma provincial no ubicada: verificar)",
    "kine-terapias-manuales": "Mendoza Res. 534/2022 MSDSyD (vía AJRPT 2024; norma provincial no ubicada: verificar)",
    "kine-dermatofuncional": "Mendoza Res. 534/2022 MSDSyD (vía AJRPT 2024; norma provincial no ubicada: verificar)",
    "osteopatia": "sin reconocimiento nacional; curada por el producto",
    "kine-uroginecologica": "sin reconocimiento oficial; curada por el producto",
}


def map_source(src, table):
    for pat, enum, ref in table:
        if re.match(pat, src):
            return enum, re.sub(pat, ref, src) if ref else ""
    raise SystemExit(f"source sin mapeo: {src}")


specs = []
for r in read(R("specialties.csv")):
    enum, ref = map_source(r["source"], SPEC_REF)
    specs.append({"slug": r["code"], "name": r["name"], "aliases": join_aliases(r["aliases"].split("|"), r["name"]),
                  "source": enum, "sourceRef": CURATED_SPEC_REF.get(r["code"], ref), "sourceDate": r["sourceDate"],
                  "sourceUrl": first_url(r["sourceUrl"])})
write(O("specialties.csv"), ["slug", "name", "aliases", "source", "sourceRef", "sourceDate", "sourceUrl"], specs)

# ═════════════════════════════ Practices ═════════════════════════════
# Las de código PMO/Nomenclador Nacional llevan slug por nombre corto (el código va a `code`).
PMO_SLUG = {"250101": "fisioterapia", "250102": "kinesioterapia", "250103": "terapia-ocupacional",
            "250104": "rehabilitacion-del-lenguaje", "250105": "pilones-para-amputados",
            "250106": "kinesioterapia-a-domicilio", "420101": "consulta-medica-consultorio",
            "420201": "consulta-medica-domicilio", "330101": "psicoterapia-individual",
            "330102": "psicoterapia-grupal", "330103": "psicoterapia-pareja-familia", "310102": "audiometria",
            "310103": "logoaudiometria"}
# Alias genéricos que dos prácticas comparten: quedan en la práctica más específica.
PRACTICE_DROP_ALIAS = {"fisioterapia": {"Electroterapia", "Infrarrojo"},  # → electroestimulacion, termoterapia
                       "fisiokinesioterapia": {"Sesión de kinesiología"},  # → kinesioterapia (25.01.02)
                       "kinesioterapia": {"Gimnasia médica"}}  # → gimnasia-terapeutica
practices, links = [], []
for r in read(R("practices.csv")):
    code = r["code"]
    aliases = [a for a in r["aliases"].split("|") if a]
    if code.isdigit():
        slug, pcode, nom, src = PMO_SLUG[code], code, "Nomenclador Nacional", "PMO"
        ref = f"Res. MS 201/2002, Anexo II, {code[0:2]}.{code[2:4]}.{code[4:6]}"
    else:
        # PAMI/OSEP: sus códigos son propios de cada financiador; quedan en aliases ("PAMI 250120") y en sourceRef.
        slug, pcode, nom, src = code, "", "", "CURATED"
        ref = "; ".join(a for a in aliases if re.match(r"^(PAMI|OSEP) ", a))
    # "NN 42.01.01" lo comparten todas las consultas de especialidad: es cómo se factura, no un nombre.
    nn = [a for a in aliases if a.startswith("NN ")]
    if nn:
        aliases = [a for a in aliases if a not in nn]
        ref = "; ".join(filter(None, [ref, "factura como " + ", ".join(nn)]))
    aliases = [a for a in aliases if a not in PRACTICE_DROP_ALIAS.get(slug, set())]
    practices.append({"slug": slug, "name": r["name"], "code": pcode, "nomenclador": nom,
                      "defaultDurationMin": r["defaultDurationMin"], "aliases": join_aliases(aliases, r["name"]),
                      "source": src, "sourceRef": ref, "sourceDate": r["sourceDate"],
                      "sourceUrl": first_url(r["sourceUrl"])})
    if r["specialtyCode"]:
        links.append({"practiceSlug": slug, "specialtySlug": r["specialtyCode"]})
dropped_practice_aliases = drop_ambiguous_aliases(practices)
assert not dropped_practice_aliases, dropped_practice_aliases  # los de prácticas se curan a mano (arriba)
assert not drop_ambiguous_aliases(specs), "alias ambiguo en especialidades"
for name, rows in (("payers", payers), ("specialties", specs), ("practices", practices)):
    keys = Counter(match_key(r["name"]) for r in rows)
    assert all(n == 1 for n in keys.values()), (name, [k for k, n in keys.items() if n > 1])
write(O("practices.csv"), ["slug", "name", "code", "nomenclador", "defaultDurationMin", "aliases", "source",
                           "sourceRef", "sourceDate", "sourceUrl"], practices)
write(O("practice-specialties.csv"), ["practiceSlug", "specialtySlug"], links)

print(f"payers={len(payers)} plans={len(plans)} seedPayers={len(seed_payers)} "
      f"seedPlans={sum(p['_bench'] for p in plans)} specialties={len(specs)} practices={len(practices)} "
      f"practiceSpecialties={len(links)}")
print(Counter(p["kind"] for p in payers), Counter(p["source"] for p in payers))
print(f"alias ambiguos sacados de prestadoras: {len(dropped_payer_aliases)}")

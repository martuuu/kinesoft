/**
 * B1.1 CAT-import: `matchKey` es la clave persistida en
 * Specialty/Practice/Payer.matchKey (@unique) y la que usa "vincular al
 * catálogo" (lib/catalog.ts). Estos casos fijan la salida EXACTA: si alguien
 * cambia el algoritmo, este test se rompe y obliga a re-correr el import en
 * dry-run antes de tocar prod (las claves guardadas dejarían de coincidir).
 */
import { describe, it, expect } from "vitest";
import { isCatalogSlug, matchKey, splitAliases } from "@/lib/catalog/normalize";

describe("matchKey", () => {
  it.each([
    // minúsculas, sin acentos, espacios colapsados
    ["Unión Personal", "union personal"],
    ["  Kinesioterapia   por  sesión ", "kinesioterapia por sesion"],
    ["Ñandú", "nandu"],
    // puntuación → espacio; siglas punteadas se unen
    ["O.S.D.E.", "osde"],
    ["O. S. D. E.", "osde"],
    ["Kinesiología / Fisiatría", "kinesiologia fisiatria"],
    ["D'Amico", "damico"],
    // punto entre dígitos se borra: el código con puntos = el código pelado
    ["25.01.02", "250102"],
    // prefijos genéricos
    ["Obra Social de Empleados de Comercio y Actividades Civiles", "empleados de comercio y actividades civiles"],
    [
      "Obra Social del Personal de la Industria Gráfica de la Provincia de Córdoba",
      "personal de la industria grafica de la provincia de cordoba",
    ],
    ["O.S. de Petroleros", "petroleros"],
    ["OS Petroleros", "petroleros"],
    ["Instituto de Obra Social de las Fuerzas Armadas (IOSFA)", "fuerzas armadas iosfa"],
    ["Asociación Civil Hospital Alemán", "hospital aleman"],
    ["Asociación Mutual Sancor Salud", "sancor salud"],
    // formas jurídicas al final
    ["Osde S.A.", "osde"],
    // la forma jurídica deletreada no se pega a la sigla ("osdesa")
    ["O.S.D.E. S.A.", "osde"],
    ["O. S. D. E. S. A.", "osde"],
    ["Medicus S. A.", "medicus"],
    ["Galeno Argentina S.R.L.", "galeno argentina"],
    ["Swiss Medical Sociedad Anónima", "swiss medical"],
  ])("%j → %j", (input, expected) => {
    expect(matchKey(input)).toBe(expected);
  });

  it("no saca lo que es parte del nombre", () => {
    // "instituto" sin conector, "mutual"/"salud" y siglas que EMPIEZAN con "os"
    expect(matchKey("Instituto Universitario Italiano")).toBe("instituto universitario italiano");
    expect(matchKey("Salud Total")).toBe("salud total");
    expect(matchKey("OSPE")).toBe("ospe");
    expect(matchKey("Osteopatía")).toBe("osteopatia");
    expect(matchKey("La Segunda")).toBe("la segunda");
  });

  it("nunca deja la clave vacía por sacar prefijos/sufijos", () => {
    expect(matchKey("Obra Social")).toBe("obra social");
    expect(matchKey("O.S.")).toBe("os");
    expect(matchKey("S.A.")).toBe("sa");
  });

  it("sin letras ni números → vacío", () => {
    expect(matchKey("")).toBe("");
    expect(matchKey("   ")).toBe("");
    expect(matchKey("...-/")).toBe("");
  });

  it("es estable: aplicarla dos veces da lo mismo", () => {
    for (const s of ["O.S.D.E. S.A.", "Obra Social de la Unión Obrera Metalúrgica", "25.01.02 Kinesio", "Instituto de X"]) {
      expect(matchKey(matchKey(s))).toBe(matchKey(s));
    }
  });

  it("variantes de la misma prestadora dan la misma clave", () => {
    const variants = ["OSDE", "O.S.D.E.", "osde s.a.", "Osde S. A.", " OSDE  "];
    expect(new Set(variants.map(matchKey))).toEqual(new Set(["osde"]));
  });
});

describe("splitAliases", () => {
  it("separa por |, trimea, colapsa espacios y deduplica por matchKey", () => {
    expect(splitAliases(" OSDE | O.S.D.E. |  Osde   Binario ||")).toEqual(["OSDE", "Osde Binario"]);
  });

  it("excluye las claves pedidas (la del propio nombre)", () => {
    expect(splitAliases("OSDE|Binario", ["osde"])).toEqual(["Binario"]);
  });

  it("celda vacía o null → []", () => {
    expect(splitAliases("")).toEqual([]);
    expect(splitAliases(null)).toEqual([]);
  });
});

describe("isCatalogSlug", () => {
  it.each(["osde", "prof-kinesiologia", "med-clinica-medica", "a1-b2"])("acepta %j", (s) => {
    expect(isCatalogSlug(s)).toBe(true);
  });
  it.each(["", "OSDE", "con espacio", "-x", "x-", "a--b", "ñandu", "a".repeat(121)])("rechaza %j", (s) => {
    expect(isCatalogSlug(s)).toBe(false);
  });
});

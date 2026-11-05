/**
 * Iniciales para los avatares (canal no cromático de una persona o de un consultorio, AGENTS §5). Puro y SIN imports a
 * propósito: lo bajan el turnero (`PractitionerPhoto`, bundle público), la sede (server), el directorio y el shell de la
 * app (`Avatar`, en /agenda y /pacientes, al límite de bundle). Cualquier import que se sume acá viaja a todos.
 *
 * CF3 (ZF4b): antes había 4 copias de la regla de persona (la foto del profesional, la sede, el directorio y el `Avatar`)
 * y no decían lo mismo: el `Avatar` tomaba las dos primeras palabras («Lic. Ana Pérez» → «LA») y la foto, nombre y
 * apellido sin el título («AP»); en la misma pantalla de Mi agenda se veían las dos. Y la de consultorio estaba copiada
 * en el selector y en /elegir-consultorio.
 *
 * Fuera de alcance (otra regla, a propósito): las chips de la agenda (`practitionerInitials` de `lib/agenda-layout.ts`,
 * que distingue nombre/apellido estructurados y desempata por columna) y las copias locales por bundle del turnero y de
 * la TV (`clinicInitials`).
 */

/**
 * Títulos que no son parte del nombre: los de `HONORIFIC_OPTIONS` (Lic., Klgo./Klga., Dr./Dra.), las abreviaturas
 * cortas que se ven escritas a mano en el nombre (Kgo./Kga.) y Prof./Profa. Se comparan por PALABRA entera (con o sin
 * punto), así «Licia» o «Drago» no se recortan.
 */
const HONORIFICS = new Set(["lic", "dr", "dra", "klgo", "klga", "kgo", "kga", "prof", "profa"]);

/**
 * Palabras del nombre, normalizadas: NFC (una «Á» descompuesta en A + tilde combinable cuenta como una letra), separadas
 * por espacios y por puntos («Dra.Lucía» = «Dra.» + «Lucía»), sin signos («(Kine)» → «Kine», «·» → nada), sin los
 * títulos y sin las que quedan vacías.
 */
function nameWords(name: string): string[] {
  return name
    .normalize("NFC")
    .split(/[\s.]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((w) => w !== "" && !HONORIFICS.has(w.toLowerCase()));
}

/** Primera letra (por code point: una letra fuera del plano básico no se parte) en mayúsculas, con reglas del español. */
function firstLetter(w: string): string {
  return (Array.from(w)[0] ?? "").toLocaleUpperCase("es-AR");
}

/**
 * Persona: primera letra del nombre y del apellido (primera y última palabra), sin el título. «Lic. Ana María Pérez» →
 * «AP», «Dra. Lucía» → «L». Vacío si no queda ninguna palabra: quien lo muestra pone el nombre al lado o en el label
 * (el directorio cae a «?»).
 */
export function personInitials(name: string): string {
  const w = nameWords(name);
  if (w.length === 0) return "";
  return w.length === 1 ? firstLetter(w[0]) : firstLetter(w[0]) + firstLetter(w[w.length - 1]);
}

/**
 * Consultorio: primeras letras de las dos primeras palabras («Centro Kinésico Movare» → «CK»): en el nombre de un
 * consultorio lo que identifica va adelante. Sin el título, porque muchos consultorios de un solo profesional llevan su
 * nombre («Lic. Ana Pérez» → «AP», no «LA»). «?» si no queda nada (la caja del selector nunca queda vacía).
 */
export function tenantInitials(name: string): string {
  const w = nameWords(name);
  return w.slice(0, 2).map(firstLetter).join("") || "?";
}

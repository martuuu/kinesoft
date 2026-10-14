/**
 * «María González» → «María G.» (nombre + inicial). El nombre llega armado
 * como `firstName lastName` (sin separar): se toma la primera palabra y la
 * inicial de la siguiente que empieza en mayúscula, así las partículas en
 * minúscula («de», «del», «la») no dan una inicial «d.». Una sola palabra
 * queda entera. Es un anuncio que se lee en la sala: alcanza con que el
 * paciente se reconozca, sin exponer el apellido completo.
 *
 * Fuente ÚNICA del nombre corto (SV): la usan `/sala` (`sala-board-state`) y
 * los avisos (`arrival-alert-state`). Vive en su propio módulo sin
 * dependencias porque los avisos se montan en TODAS las rutas del workspace:
 * importarla desde `sala-board-state` arrastraba al first-load los módulos
 * del tablero.
 */
export function shortPatientName(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const [first, ...rest] = words;
  const next = rest.find((w) => /^\p{Lu}/u.test(w));
  return next ? `${first} ${next.charAt(0)}.` : first;
}

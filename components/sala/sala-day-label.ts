/**
 * «Miércoles, 14 de octubre»: la fecha del día AR en el header de /sala, tanto del Tablero (`SalaHeader`) como del
 * escritorio de Recepción (`DeskHeader`). Un solo lugar (RX-Z): antes el escritorio tenía su copia, en minúscula.
 *
 * VX0-b R1: antes el CSS hacía `capitalize` y salía «Miércoles, 14 De Octubre»; se capitaliza solo la primera letra.
 * Mediodía AR del día: ningún huso del host lo corre de fecha; `timeZone` explícito igual (AGENTS §4). Módulo sin
 * "use client" ni dependencias: lo importan el cliente de /sala, el header del escritorio y los tests.
 */
export function salaDayLabel(dayKey: string): string {
  const s = new Date(`${dayKey}T12:00:00-03:00`).toLocaleDateString("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "America/Argentina/Buenos_Aires",
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * [AS-0d · sala-canoperate-ui-vs-server, plan §21.4 punto 8] ¿Este actor puede marcar Llegó / Llamar / En atención /
 * Atendido / Ausente / Deshacer en ESTA fila? Misma regla que `markReceptionAction` (lib/bookings.ts), que deja pasar
 * con `agenda.reception` y además:
 *
 *   `agenda.manageBlocks` ∨ el turno es del profesional del actor (`isActorPractitioner`) ∨ acceso full al paciente
 *   (guest: `guestOperable`).
 *
 * El `canOperate` del DTO (S07sb) es `full ∨ agenda.operateAll` (guest: `guestOperable`) y `agenda.operateAll` va a los
 * mismos roles que `agenda.manageBlocks` (OWNER, ADMIN, ASSISTANT; `lib/capabilities.ts`), así que la única diferencia
 * era el turno PROPIO con paciente `basic` (paciente de otro profesional atendido en un turno mío): el server lo
 * acepta y la UI escondía los botones. Más angosta que el server es «seguro» pero el profesional quedaba sin poder
 * marcar su propio turno desde Recepción.
 *
 * `agenda.reception` lo sigue chequeando la vista (`canOperate` de la vista). Sin el campo en el DTO (proyecciones
 * viejas) se asume operable: el server decide igual.
 */
export function receptionRowOperable(
  row: { practitionerId: string; canOperate?: boolean },
  viewerPractitionerId: string | null | undefined
): boolean {
  if (row.canOperate !== false) return true;
  return viewerPractitionerId != null && viewerPractitionerId !== "" && row.practitionerId === viewerPractitionerId;
}

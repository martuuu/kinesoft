"use client";

import { Button } from "@/components/ui/button";

/**
 * BO-Z C7: «Probar de nuevo» recarga la página en la que estaba el usuario. El middleware REESCRIBE (no redirige) a
 * /mantenimiento, así que la URL sigue siendo la original (/agenda, el turnero de un consultorio…). Antes era un
 * `<Link href="/">`: al terminar el mantenimiento lo dejaba en la landing y tenía que volver a navegar, y un paciente
 * del turnero perdía el link de su consultorio.
 */
export function ReloadButton() {
  return (
    <Button type="button" variant="primary" size="md" block onClick={() => window.location.reload()}>
      Probar de nuevo
    </Button>
  );
}

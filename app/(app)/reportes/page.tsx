import { redirect } from "next/navigation";

/**
 * PL-F1c (regla de Martin del 16-oct: «todo lo que quede sin funcionalidad, se quita»): /reportes era una Card
 * placeholder («Pendiente para una iteración posterior»). PL-F1b la saca del nav (y con eso del sidebar, la barra
 * superior y ⌘K); acá cubrimos los links viejos y la URL directa mandando a Inicio. El módulo `reportes` sigue en la
 * matriz de planes (no se ve: `MODULE_UI_LABEL`/`MODULE_LABEL` lo filtran) para cuando haya reportes de verdad.
 */
export default function ReportesPage(): never {
  redirect("/dashboard");
}

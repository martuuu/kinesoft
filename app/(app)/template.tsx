/**
 * Entrada de página del workspace (PF-0c).
 *
 * Next re-monta `template.tsx` en cada cambio de segmento (a diferencia del
 * `layout.tsx`, que persiste), así que un fade acá cubre todas las páginas sin
 * tocarlas. Hasta PF-0c era un `motion.div` de framer (fade + subida de 8 px,
 * 220 ms) y un client component: sumaba framer al camino de cada navegación y
 * la animación arrancaba recién al hidratar. Ahora es un server component con
 * la clase `.k-page-in` de `app/globals.css`: solo opacidad, 120 ms, sin
 * desplazamiento, y nada con `prefers-reduced-motion`.
 *
 * ¿Sacarlo? Se evaluó: el re-montaje no pierde estado que importe (envuelve
 * solo a `{children}` del layout de `(app)`, que es la página que cambia de
 * todos modos; el shell, la sidebar y los providers viven en el layout), y la
 * key es el segmento hijo de `(app)`: cambiar solo los searchParams (semana de
 * la agenda) o entrar a `/pacientes/[id]` desde `/pacientes` no lo re-monta.
 * Con CSS el costo es un `<div>` más. Se queda porque da la confirmación visual del click
 * (el esqueleto de `loading.tsx` entra con el fade).
 */
export default function WorkspaceTemplate({ children }: { children: React.ReactNode }) {
  return (
    <div className="k-page-in" style={{ height: "100%" }}>
      {children}
    </div>
  );
}

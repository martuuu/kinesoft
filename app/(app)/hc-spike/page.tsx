import { notFound } from "next/navigation";
import { SpikeEditor } from "./spike-editor";

/**
 * FC-1c · página spike del editor (§24.10 T4a). **Temporal**: la borra FC-3a (T4d) junto con `spike-editor.tsx`
 * cuando exista `components/hc/editor/*`.
 *
 * Solo mide una cosa: que Tiptap 3 (`@tiptap/react` + `@tiptap/pm` + `@tiptap/starter-kit`) y mammoth quedan en
 * chunks propios que bajan por `import()` y no en el first load de la ruta (`scripts/measure-hc-chunks.mjs`). El
 * server es lo único que decide si existe: `HC_SPIKE=1` y nunca en Vercel (Preview usa variables de prod).
 */
export const dynamic = "force-dynamic";

export default function HcSpikePage() {
  if (process.env.HC_SPIKE !== "1" || process.env.VERCEL_ENV) notFound();
  return (
    <main style={{ padding: 24, maxWidth: 760 }}>
      <h1>Spike del editor de fichas</h1>
      <p>Solo local. El editor se carga diferido; el textarea funciona antes de que llegue.</p>
      <SpikeEditor />
    </main>
  );
}

"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

/**
 * FC-1c · cliente del spike del editor. **Temporal** (lo borra FC-3a con la página).
 *
 * Tiptap entra SOLO por `import()` dentro de `next/dynamic` con `ssr:false`: es el patrón que FC-3a usa en
 * `HcEditorField` (§24.7) y lo que el spike tiene que demostrar en el build (chunk aparte, fuera del first load).
 * `immediatelyRender:false` porque con SSR apagado igual evita el warning de hidratación de Tiptap 3.
 * mammoth va detrás de un botón para medir su chunk también (§24.9: esperado ~110-170 kB gz, todo diferido).
 */
const SpikeTiptap = dynamic(
  () =>
    Promise.all([import("@tiptap/react"), import("@tiptap/starter-kit")]).then(([tiptap, starterKit]) => {
      function SpikeTiptapEditor() {
        const editor = tiptap.useEditor({
          extensions: [starterKit.default],
          content: "<p>Flexión ≤ 110° → extensión. ¿Dolor? Sí, β.</p>",
          immediatelyRender: false,
        });
        return <tiptap.EditorContent editor={editor} />;
      }
      return SpikeTiptapEditor;
    }),
  { ssr: false, loading: () => <textarea aria-label="Ficha" rows={6} style={{ width: "100%" }} /> },
);

export function SpikeEditor() {
  const [mammothInfo, setMammothInfo] = useState<string>("");
  return (
    <div>
      <SpikeTiptap />
      <button
        type="button"
        onClick={async () => {
          const mammoth = await import("mammoth");
          setMammothInfo(typeof mammoth.convertToHtml === "function" ? "Lector de Word cargado" : "Lector de Word sin convertToHtml");
        }}
      >
        Cargar lector de Word
      </button>
      <output>{mammothInfo}</output>
    </div>
  );
}

# Fuentes del PDF de la historia clínica (FC-1c, FC-UI-D4)

El PDF de las fichas (react-pdf, `lib/hc-pdf/render-internal.tsx`) **no usa Helvetica**: las 14 fuentes estándar de PDF
no tienen `≤ ≥ → β` y una ficha de kine los usa (rangos de movilidad, «flexión → extensión», ángulos). Las fuentes se
commitean en el repo (no se bajan en runtime) y viajan a la función serverless por `outputFileTracingIncludes`
(`next.config.mjs`), porque el renderer las abre con `path.join(process.cwd(), "lib/hc-pdf/fonts/…")` y eso el trazado
estático de Next no lo ve.

## Qué hay y de dónde salió

| Archivo | Familia / cara | Origen oficial |
|---|---|---|
| `NotoSans-Regular.ttf` | Noto Sans 400 normal | release `NotoSans-v2.015` de [notofonts/latin-greek-cyrillic](https://github.com/notofonts/latin-greek-cyrillic/releases/tag/NotoSans-v2.015), `NotoSans/unhinted/ttf/` |
| `NotoSans-Bold.ttf` | Noto Sans 700 normal | ídem |
| `NotoSans-Italic.ttf` | Noto Sans 400 italic | ídem |
| `NotoSans-BoldItalic.ttf` | Noto Sans 700 italic | ídem |
| `NotoSansMath-Regular.ttf` | Noto Sans Math 400 (fallback) | release `NotoSansMath-v3.000` de [notofonts/math](https://github.com/notofonts/math/releases/tag/NotoSansMath-v3.000), `NotoSansMath/unhinted/ttf/` |
| `OFL.txt` | licencia de Noto Sans | el `OFL.txt` del zip de Noto Sans |
| `OFL-NotoSansMath.txt` | licencia de Noto Sans Math | el `OFL.txt` del zip de Noto Sans Math |

Zips bajados el 18-oct-2026 (sha256 del zip, por si hay que re-verificar contra el release):

- `NotoSans-v2.015.zip` → `0c34df072a3fa7efbb7cbf34950e1f971a4447cffe365d3a359e2d4089b958f5`
- `NotoSansMath-v3.000.zip` → `ac351837b41f8a897f020b97fb0f075ad574c1e9669fb5839ada1f92fd748356`

Se eligió la variante **unhinted** (≈430 kB por cara contra ≈620 kB la hinted): el hinting es para rasterizar en
pantalla a tamaños chicos y en un PDF no aporta; react-pdf además embebe solo el subconjunto de glifos usados, así que
el peso del PDF no depende de esto, solo el del bundle de la función. Fontsource (`@fontsource/noto-sans`) se descartó:
publica WOFF partidos por rango Unicode y el subconjunto `latin` no trae los símbolos.

## Por qué hay una segunda familia (hallazgo de FC-1c)

**Noto Sans no tiene `≤` (U+2264), `≥` (U+2265) ni `→` (U+2192)**: se verificó con fontkit en las 4 caras, en las
variantes `unhinted`, `hinted` y `full` del release 2.015 (sí trae `á ñ ¿ ° β`). Esos glifos están en Noto Sans Math
(misma familia de diseño, mismo proyecto, misma licencia). El renderer registra las dos y usa
`fontFamily: ["NotoSans", "NotoSansMath"]`: react-pdf 4 resuelve la fuente **por carácter** en el orden del array
(`@react-pdf/layout`, `fontFamilies.map(...)`), así que el texto sale en Noto Sans y solo los símbolos que faltan caen
en Noto Sans Math. Noto Sans Math tiene una sola cara (400 normal): se registra la misma para 700 e italic, y un `≤`
dentro de una negrita sale en peso normal (aceptado; no hay Noto Sans Math Bold).

## Verificación (sha256)

`SHA256SUMS` es la fuente de verdad y la chequea `tests/unit/hc-heavy-deps.test.ts`:

```
87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9  NotoSans-Bold.ttf
3d367743f371f28671d2764e911a53d7c20ec9b6aa8791d059e7090389fc52a5  NotoSans-BoldItalic.ttf
678288f868807d4d64a6f3b51466871d117d915780381ce9d0ed4b3bcbd06d37  NotoSans-Italic.ttf
f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8  NotoSans-Regular.ttf
b127e84699212b6b2ef50aff58e0ebebeec04ffe6db1b9eb9e209c8c3d97b4aa  NotoSansMath-Regular.ttf
c9c63b8ed6cf76b2ce0c58b241acfc1195c2c928334c989c7047cbdac58773d9  OFL-NotoSansMath.txt
cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a  OFL.txt
```

A mano: `cd lib/hc-pdf/fonts && shasum -a 256 -c SHA256SUMS`.

## Licencia

SIL Open Font License 1.1 (`OFL.txt`, `OFL-NotoSansMath.txt`). Permite usar, embeber en documentos y redistribuir con
el software; las fuentes no se venden solas y la licencia viaja con ellas (por eso los dos `OFL*.txt` están acá). No se
modificaron los archivos (sin subset propio ni renombre), así que no aplica la cláusula de «Reserved Font Name».

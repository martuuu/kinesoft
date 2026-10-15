/**
 * VX F-d (C-F3): features de framer-motion que carga `LazyMotion` en `components/providers/ui-providers.tsx`.
 *
 * Va en su propio módulo para que el `import()` dinámico lo parta en un chunk aparte: el bundle inicial de las
 * superficies con `UIProviders` solo lleva el núcleo de `m` (~5 kB) y las features (animaciones, gestos, layout)
 * llegan después del primer pintado. Las superficies públicas (C-F7) no lo importan nunca (lo verifica
 * `tests/unit/public-surface-imports.test.ts`).
 *
 * `domMax` y no `domAnimation`: los segmented usan `layoutId` y el toast usa `layout` (reacomoda la pila cuando un
 * aviso cambia de alto); `domAnimation` no trae las animaciones de layout.
 */
import { domMax } from "framer-motion";

export default domMax;

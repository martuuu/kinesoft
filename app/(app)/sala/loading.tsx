import { SalaBoardSkeleton } from "@/components/sala/sala-skeleton";

/**
 * Esqueleto de /sala mientras resuelve el server (SV10a; FX2a). El markup vive en `components/sala/sala-skeleton.tsx`
 * desde PF1.1-sala: es el mismo que pintan los `next/dynamic` de `SalaClient` al cambiar a la cara Tablero.
 */
export default function SalaLoading() {
  return <SalaBoardSkeleton />;
}

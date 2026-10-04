/**
 * Pill de estado del encabezado del drawer. Desde P0-S04b es el mismo
 * `StatusTag` de Lista, perfil y semana (`components/ui/status-tag.tsx`, paleta
 * `--st-*`): antes el drawer tenía su propia paleta y "Ausente" salía rojo acá
 * y ámbar en la Lista (statustag-tres-paletas). Se re-exporta para que
 * `patient-header.tsx` siga importando de `./status-tag`.
 */
export { StatusTag } from "@/components/ui/status-tag";

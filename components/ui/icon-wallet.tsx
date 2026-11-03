import { Icon, VX, type IconProps } from "./icons";

/**
 * CF2 (D-CF2-17): «Caja» del nav. Billetera con la solapa del broche, mismo trazo VX que `IconTag` (Cobros) al lado.
 *
 * [CF2-ZF4] En su propio módulo y no en `icons.tsx`: webpack decide qué exports de un módulo compartido quedan mirando
 * TODA la app, así que un ícono más en `icons.tsx` viaja en cada chunk que lo incluye (landing, login, turnero, portal:
 * ~0,08 kB gz cada una) aunque solo lo use el sidebar del equipo.
 */
export const IconWallet = (p: IconProps) => (
  <Icon {...VX} {...p}>
    <path d="M19 7V5.5A1.5 1.5 0 0 0 17.5 4h-12A2.5 2.5 0 0 0 3 6.5v11A2.5 2.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
    <path d="M3 6.5A2.5 2.5 0 0 0 5.5 9H20a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a3 3 0 0 1 0-6" />
    <circle cx="16" cy="12" r=".6" fill="currentColor" />
  </Icon>
);

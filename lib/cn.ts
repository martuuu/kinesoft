import { clsx, type ClassValue } from "clsx";

/**
 * Une clases condicionales (clsx). Antes pasaba además por `twMerge` (tailwind-merge, 6,7 kB gz en el piso del
 * shell, AUDIT pf1-shell-137). Se sacó en MB (16-oct) porque era la identidad: ningún llamador mezcla utilidades de
 * Tailwind que choquen. Todo lo que entra son clases del design system (`k-*`), hashes de CSS modules o nombres
 * sueltos ("ppe", "pse"), y twMerge las deja intactas (verificado contra tailwind-merge 2.5 con los mismos inputs).
 * Si algún día un primitivo necesita que el `className` del llamador PISE una utilidad Tailwind propia, eso se
 * resuelve en ese primitivo, no volviendo a meter tailwind-merge en el shell.
 */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

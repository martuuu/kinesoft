"use client";

/**
 * Contador de no leídos del ítem «Mensajes» del nav de Plataforma (PL-2d). Se pide al montar y en cada cambio de ruta
 * (`pathname`): así baja al volver de abrir un hilo, sin tocar el layout ni el shell (que no se re-renderizan en la
 * navegación suave). Un error (red, rate limit, sesión vencida) deja el último valor: el contador es ayuda visual, la
 * bandeja es la verdad.
 *
 * Import DINÁMICO de la action: el nav lo montan el shell y sus render tests en node, y un import estático arrastra
 * `lib/session` (React `cache`, Prisma) a esos tests. Con el `import()` adentro del efecto, nada de eso se evalúa
 * hasta que el efecto corre en el browser (Next transforma igual el módulo `"use server"` en una referencia de action).
 */
import { useEffect, useState } from "react";

export function useInboxUnread(pathname: string | null, initial: number | null = null): number | null {
  const [n, setN] = useState<number | null>(initial);
  useEffect(() => {
    let alive = true;
    import("@/lib/platform-inbox")
      .then((m) => m.countInboxUnread())
      .then((v) => {
        if (alive) setN(v);
      })
      .catch(() => {
        /* se queda el último valor */
      });
    return () => {
      alive = false;
    };
  }, [pathname]);
  return n;
}

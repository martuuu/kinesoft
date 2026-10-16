"use client";

import { useEffect } from "react";

/**
 * [MB-0a · C-MB5] Registra el service worker de instalación (`public/sw.js`). Se monta en `AppShell` y en
 * `PlatformShell`, nunca en el root ni en superficies públicas: la instalación se ofrece con sesión (MB-D5) y así el
 * registro no suma bytes a landing/turnero/portal.
 * - En dev no registra: un SW sobre `next dev` se mete con el HMR y deja respuestas viejas.
 * - `NEXT_PUBLIC_PWA=off` es el interruptor de emergencia (MB-D6): desregistra todos los SW en el próximo load (se lee
 *   literal para que Next lo inline en el build).
 * - `updateViaCache: "none"`: el navegador siempre revalida `/sw.js` contra la red (junto con su `no-store`), para que
 *   un deploy nunca quede pegado a un SW viejo.
 * Los errores van a la consola y nunca al usuario: sin SW la app funciona igual.
 */
export function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const sw = navigator.serviceWorker;
    const job =
      process.env.NEXT_PUBLIC_PWA === "off"
        ? sw.getRegistrations().then((regs) => Promise.all(regs.map((r) => r.unregister())))
        : sw.register("/sw.js", { scope: "/", updateViaCache: "none" });
    job.catch((err: unknown) => console.error("[pwa] service worker:", err));
  }, []);
  return null;
}

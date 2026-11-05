"use client";

/**
 * CF3b PH-U1 (M24, contrato FOTO) — la foto PROPIA del usuario para el avatar del workspace.
 *
 * - Valor: `/api/me/photo?v=<ms>` (la arma el layout `(app)` con `ownPhotoUrlFor`, PH-S) o null sin foto. Llega al
 *   `AppShell` como prop `userPhotoUrl` y se publica acá: la leen el menú de cuenta de la barra superior y de la barra
 *   móvil (`TopbarAccountMenu`) y el `ProfileMenu` del dashboard (chrome «Barra lateral") sin pasar props por `TopBar`
 *   ni por el dashboard. `TenantBrand` NO cambia (contrato): la foto es de la persona, no del consultorio.
 * - Setter: «Tu foto» (Configuración › Mi agenda) lo llama al subir o quitar la foto para que el avatar cambie al toque.
 *   El layout solo se vuelve a pintar si la action revalida (o en la próxima carga completa); cuando llega un valor
 *   nuevo del server, manda ese.
 * - Fuera del provider (tests, render suelto): null y un setter que no hace nada → el avatar de siempre (iniciales).
 *
 * El layout es server: desde ahí solo se importa el TIPO de este módulo, nunca un valor (ver `tenant-brand-context`).
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Avatar } from "@/components/ui/avatar";

type UserPhotoValue = { url: string | null; setUrl: (url: string | null) => void };

const NOOP = () => {};
const UserPhotoContext = createContext<UserPhotoValue>({ url: null, setUrl: NOOP });

export function UserPhotoProvider({ value, children }: { value: string | null; children: ReactNode }) {
  const [url, setUrl] = useState<string | null>(value);
  // El layout re-renderiza en cada carga y después de una action que revalida: el valor del server manda.
  useEffect(() => setUrl(value), [value]);
  const v = useMemo<UserPhotoValue>(() => ({ url, setUrl }), [url]);
  return <UserPhotoContext.Provider value={v}>{children}</UserPhotoContext.Provider>;
}

export function useUserPhotoUrl(): string | null {
  return useContext(UserPhotoContext).url;
}

export function useSetUserPhotoUrl(): (url: string | null) => void {
  return useContext(UserPhotoContext).setUrl;
}

/**
 * Avatar del usuario: su foto si tiene, si no las iniciales de siempre (`Avatar`). Decorativo (`alt=""`): el botón que lo
 * envuelve ya dice «Menú de cuenta de …». Fondo blanco (un PNG sin fondo queda sobre blanco, como en `PractitionerPhoto`)
 * y sin el marco con logo: a 36 px el logo del consultorio no se distingue.
 *
 * Si la imagen no carga (foto borrada en otra pestaña, sesión vencida), vuelve a las iniciales. El `onError` de React
 * no se entera de un error ANTERIOR a la hidratación (la imagen del HTML del server pudo fallar antes): por eso además
 * se mira `complete && naturalWidth === 0` al montar.
 */
export function UserAvatar({ name, size = 36 }: { name: string; size?: number }) {
  const src = useUserPhotoUrl();
  const [failed, setFailed] = useState<string | null>(null);
  const ref = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (src && el && el.complete && el.naturalWidth === 0) setFailed(src);
  }, [src]);
  if (!src || failed === src) return <Avatar name={name} size={size} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- ruta privada con cookie de sesión: `next/image` la pediría desde el server sin la sesión.
    <img
      ref={ref}
      src={src}
      alt=""
      width={size}
      height={size}
      decoding="async"
      data-user-photo
      onError={() => setFailed(src)}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        objectFit: "cover",
        background: "#fff",
        display: "block",
        flexShrink: 0,
        boxShadow: "0 1px 2px rgba(15,30,51,0.12), 0 0 0 1px rgba(15,30,51,0.06)",
      }}
    />
  );
}

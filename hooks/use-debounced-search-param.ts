"use client";

/**
 * Two-way binding between an `<input>` value and a URL search param,
 * with debouncing.
 *
 * UX contract:
 *   - The input is fully controlled (every keystroke updates local state).
 *   - The URL only updates after `delayMs` of silence (default 300 ms).
 *   - Pressing Enter fires immediately and skips the debounce.
 *   - Hitting back/forward in the browser re-syncs the input.
 *
 * Returns `[value, setValue, flushNow]`.
 */
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

export function useDebouncedSearchParam(
  paramName: string,
  delayMs = 300,
  // PV W3a: params que una búsqueda nueva tiene que borrar (p. ej. `page` en /pacientes: buscar desde la página 3
  // dejaba `page=3` y el resultado no arrancaba desde arriba).
  resetParams: readonly string[] = []
): [string, (v: string) => void, () => void] {
  const resetKey = resetParams.join(",");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const urlValue = params.get(paramName) ?? "";

  const [value, setValue] = useState(urlValue);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the URL value the hook synced from, so back/forward navigation
  // (which changes `urlValue` from outside) overrides the local state.
  const lastSyncedFromUrl = useRef(urlValue);

  useEffect(() => {
    if (urlValue !== lastSyncedFromUrl.current) {
      setValue(urlValue);
      lastSyncedFromUrl.current = urlValue;
    }
  }, [urlValue]);

  const pushToUrl = useCallback(
    (next: string) => {
      const sp = new URLSearchParams(params.toString());
      if (next) sp.set(paramName, next);
      else sp.delete(paramName);
      for (const k of resetKey ? resetKey.split(",") : []) sp.delete(k);
      lastSyncedFromUrl.current = next;
      const qs = sp.toString();
      router.replace(`${pathname}${qs ? "?" + qs : ""}`, { scroll: false });
    },
    [params, paramName, pathname, router, resetKey]
  );

  const flushNow = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    pushToUrl(value);
  }, [pushToUrl, value]);

  const set = useCallback(
    (next: string) => {
      setValue(next);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => pushToUrl(next), delayMs);
    },
    [pushToUrl, delayMs]
  );

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  return [value, set, flushNow];
}

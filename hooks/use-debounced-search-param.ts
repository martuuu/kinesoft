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
  delayMs = 300
): [string, (v: string) => void, () => void] {
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
      lastSyncedFromUrl.current = next;
      const qs = sp.toString();
      router.replace(`${pathname}${qs ? "?" + qs : ""}`, { scroll: false });
    },
    [params, paramName, pathname, router]
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

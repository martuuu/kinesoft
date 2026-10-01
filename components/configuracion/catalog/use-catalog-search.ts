"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * Búsqueda con debounce (250 ms) y guarda de secuencia para los pickers del
 * catálogo global: solo se aplica la respuesta de la última consulta, así una
 * respuesta lenta de "os" no pisa la de "osde". Mismo patrón que
 * `components/ui/exercise-search-picker.tsx`.
 */
export function useCatalogSearch<T>(
  fetcher: (q: string) => Promise<T[]>,
  q: string,
  enabled = true
): { results: T[]; loading: boolean; error: boolean } {
  const [results, setResults] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const seqRef = useRef(0);
  // El fetcher es una server action (referencia estable), pero no lo metemos
  // en las deps para que un caller con lambda inline no dispare en loop.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    const seq = ++seqRef.current;
    const t = setTimeout(async () => {
      try {
        const rows = await fetcherRef.current(q.trim());
        if (seq !== seqRef.current) return;
        setResults(rows);
        setError(false);
      } catch {
        if (seq !== seqRef.current) return;
        setResults([]);
        setError(true);
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, enabled]);

  return { results, loading, error };
}

export const searchInputStyle: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 12,
  border: "1px solid rgba(15,30,51,0.08)",
  background: "rgba(255,255,255,0.7)",
  fontSize: 14,
};

"use client";

import Link from "next/link";
import { useDebouncedSearchParam } from "@/hooks/use-debounced-search-param";
import { Card } from "@/components/ui/card";
import { IconSearch } from "@/components/ui/icons";

type Filter = "all" | "active" | "no-program" | "archived";

export function PatientsSearchBar({
  filter,
  totals,
}: {
  filter: Filter;
  totals: { all: number; withProgram: number; withoutProgram: number };
}) {
  const [q, setQ, flush] = useDebouncedSearchParam("q", 300);
  return (
    <Card glass style={{ padding: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          gap: 8,
          minWidth: 240,
        }}
      >
        <span style={{ color: "var(--navy-300)" }}>
          <IconSearch size={15} />
        </span>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              flush();
            }
          }}
          placeholder="Buscar por nombre, email o DNI…"
          aria-label="Buscar paciente"
          // DB search — suppress the browser's own name/email autofill (Chrome
          // ignores autoComplete="off" here, so "new-password" is used).
          autoComplete="new-password"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            background: "transparent",
            fontSize: 14,
            color: "var(--navy-900)",
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          gap: 4,
          padding: 3,
          borderRadius: 999,
          background: "rgba(15,30,51,0.04)",
        }}
      >
        {(
          [
            ["all", `Todos · ${totals.all}`],
            ["active", `Con plan · ${totals.withProgram}`],
            ["no-program", `Sin plan · ${totals.withoutProgram}`],
          ] as const
        ).map(([key, label]) => {
          const on = key === filter;
          return (
            <Link
              key={key}
              href={`/pacientes?filter=${key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
              scroll={false}
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 600,
                textDecoration: "none",
                background: on ? "#fff" : "transparent",
                color: on ? "var(--navy-900)" : "var(--navy-500)",
                boxShadow: on ? "0 2px 6px rgba(15,30,51,0.08)" : "none",
              }}
            >
              {label}
            </Link>
          );
        })}
      </div>
    </Card>
  );
}

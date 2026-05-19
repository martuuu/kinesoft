"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { submitCheckIn } from "@/lib/portal";

/**
 * Pre-session check-in for the patient portal.
 *
 * EVA pain slider (0..10) + free-form notes. The data lands in the
 * practitioner's HC notes + a sourced `EvaScore` so they see the
 * pre-visit state when they open the patient profile.
 */
export function PortalCheckInForm({
  slug,
  sessionId,
}: {
  slug: string;
  sessionId: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [pain, setPain] = useState(4);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    start(async () => {
      const r = await submitCheckIn({
        tenantSlug: slug,
        sessionId,
        pain,
        notes: notes.trim() || undefined,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  };

  const colour =
    pain <= 3 ? "var(--lime-400)" : pain <= 6 ? "var(--sky-500)" : "#E14B4B";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div
          style={{
            fontSize: 11,
            color: "var(--navy-300)",
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          Check-in pre-sesión
        </div>
        <div style={{ fontSize: 12.5, color: "var(--navy-500)", marginTop: 2 }}>
          ¿Cómo estás llegando? Tu kinesiólogo lo va a ver antes de la sesión.
        </div>
      </div>
      <label style={{ fontSize: 12, color: "var(--navy-500)", fontWeight: 600 }}>
        Dolor ahora · <span style={{ color: colour, fontWeight: 800 }}>{pain}/10</span>
        <input
          type="range"
          min={0}
          max={10}
          value={pain}
          onChange={(e) => setPain(Number(e.target.value))}
          style={{ width: "100%", marginTop: 6 }}
        />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(11, 1fr)",
            gap: 2,
            marginTop: 6,
            height: 6,
          }}
          aria-hidden
        >
          {Array.from({ length: 11 }).map((_, i) => (
            <span
              key={i}
              style={{
                height: 6,
                borderRadius: 2,
                background:
                  i <= 3 ? "var(--lime-400)" : i <= 6 ? "var(--sky-500)" : "#E14B4B",
                opacity: i <= pain ? 1 : 0.25,
              }}
            />
          ))}
        </div>
      </label>
      <label style={{ fontSize: 12, color: "var(--navy-500)", fontWeight: 600 }}>
        Notas (opcional)
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="¿Hubo algo distinto esta semana? ¿Algún ejercicio que te molestó?"
          style={{
            marginTop: 6,
            width: "100%",
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid rgba(15,30,51,0.08)",
            background: "rgba(255,255,255,0.7)",
            fontSize: 13,
          }}
        />
      </label>
      {error && (
        <div
          style={{
            padding: 10,
            borderRadius: 10,
            background: "rgba(228,70,70,0.1)",
            color: "#9F1F1F",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}
      <Button variant="primary" onClick={submit} disabled={pending}>
        {pending ? "Enviando…" : "Enviar check-in"}
      </Button>
    </div>
  );
}

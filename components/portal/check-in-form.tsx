"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TenantVertical } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { submitCheckIn } from "@/lib/portal";
import { portalCheckInCopy } from "@/lib/portal-copy";

/**
 * Pre-session check-in for the patient portal.
 *
 * EVA pain slider (0..10) + free-form notes. The data lands in the
 * practitioner's HC notes + a sourced `EvaScore` so they see the
 * pre-visit state when they open the patient profile.
 *
 * VX2-f (D-VX28): copy por vertical (`lib/portal-copy.ts`: «Check-in pre-sesión» y el ejemplo de ejercicios solo en
 * Kinesiología), notas con `Field` + `.k-input` (label real, 16 px: iOS no hace zoom al enfocar), error con
 * `.k-alert role="alert"`, rojo del EVA con el token `--danger-solid` en vez del literal. Mismos datos que antes.
 */
const painColour = (v: number) => (v <= 3 ? "var(--lime-400)" : v <= 6 ? "var(--sky-500)" : "var(--danger-solid)");

export function PortalCheckInForm({
  slug,
  sessionId,
  // Default Kinesiología: el check-in cuelga de un plan, y los planes son de Kinesiología (lib/tenant-modules.ts);
  // la page lo pasa siempre con la vertical de la ficha.
  vertical = "KINESIOLOGY",
}: {
  slug: string;
  sessionId: string;
  vertical?: TenantVertical;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [pain, setPain] = useState(4);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const copy = portalCheckInCopy(vertical);
  const ids = { title: `checkin-${sessionId}-title`, pain: `checkin-${sessionId}-pain`, notes: `checkin-${sessionId}-notes` };

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

  const colour = painColour(pain);

  return (
    <section aria-labelledby={ids.title} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <h2
          id={ids.title}
          style={{
            fontSize: 12,
            color: "var(--navy-500)",
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            margin: 0,
          }}
        >
          {copy.title}
        </h2>
        <p style={{ fontSize: 14, color: "var(--navy-500)", margin: "2px 0 0" }}>{copy.lead}</p>
      </div>
      <div className="k-field">
        <label htmlFor={ids.pain} className="k-label">
          {copy.painLabel} · <span style={{ color: colour, fontWeight: 800 }}>{pain}/10</span>
        </label>
        <input
          id={ids.pain}
          type="range"
          min={0}
          max={10}
          value={pain}
          aria-valuetext={`${pain} de 10`}
          onChange={(e) => setPain(Number(e.target.value))}
          style={{ width: "100%", minHeight: 44 }}
        />
        <div
          style={{ display: "grid", gridTemplateColumns: "repeat(11, 1fr)", gap: 2, height: 6 }}
          aria-hidden
        >
          {Array.from({ length: 11 }).map((_, i) => (
            <span
              key={i}
              style={{ height: 6, borderRadius: 2, background: painColour(i), opacity: i <= pain ? 1 : 0.25 }}
            />
          ))}
        </div>
      </div>
      <Field id={ids.notes} label={copy.notesLabel} optional>
        <textarea
          className="k-input"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder={copy.notesPlaceholder}
          style={{ minHeight: 96 }}
        />
      </Field>
      {error && (
        <div role="alert" className="k-alert">
          {error}
        </div>
      )}
      <Button variant="primary" size="md" block onClick={submit} disabled={pending}>
        {pending ? copy.pending : copy.submit}
      </Button>
    </section>
  );
}

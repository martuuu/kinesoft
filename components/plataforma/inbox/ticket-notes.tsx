"use client";

/**
 * «Notas internas» de un ticket (PV §27, TK-U1: «anotá cómo seguiste»). Las ve solo Plataforma: viven en
 * `SupportTicketNote` (SERVICE_ONLY, M19), nunca en el hilo que ve el consultorio. Solo inserción (no hay editar ni
 * borrar, así queda la historia de cómo se siguió).
 *
 * Patrón de mutación de la bandeja (PF-0d): `usePlatformAction` y SIN `router.refresh()`; `addInboxNote` hace
 * `revalidatePath("/plataforma/mensajes", "layout")` y la respuesta ya trae el detalle con la nota nueva.
 * El texto va como texto (React escapa) con `pre-wrap`. Las propias dicen «Vos» (el server calcula `mine`).
 * El tope (`TICKET_NOTE_MAX`, espejo del CHECK de M19) se corta en el cliente y se muestra con contador: así nunca
 * llega un 23514 del CHECK.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { useToast } from "@/components/ui/toast";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import { addInboxNote } from "@/lib/platform-inbox";
import { TICKET_NOTE_MAX, messageWhen, type TicketNoteView } from "@/lib/support-threads-types";

const GENERIC_ERROR = "No pudimos guardar. Probá de nuevo en unos minutos.";
export const TICKET_NOTES_HINT = "Solo las ve el equipo de Plataforma. Ej.: “Lo llamé por WhatsApp el 30/10, quedó en mandar los datos”.";

export function TicketNotes({ threadId, notes }: { threadId: string; notes: TicketNoteView[] }) {
  const runPlatform = usePlatformAction();
  const toast = useToast();
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending || body.trim() === "") return;
    setPending(true);
    setError(null);
    try {
      const r = await runPlatform(() => addInboxNote({ threadId, body }));
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setBody("");
      toast.success("Nota guardada");
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby={`notes-${threadId}`} style={{ display: "grid", gap: 12 }}>
      <div>
        <h2 id={`notes-${threadId}`} style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--navy-900)" }}>
          Notas internas
        </h2>
        <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--navy-500)" }}>{TICKET_NOTES_HINT}</p>
      </div>

      {notes.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--navy-500)" }}>Todavía no hay notas.</p>
      ) : (
        <ol aria-label="Notas internas" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
          {notes.map((n) => (
            <li
              key={n.id}
              data-mine={n.mine ? "true" : undefined}
              style={{
                padding: "10px 14px",
                borderRadius: 12,
                background: "var(--bg-panel)",
                border: "1px solid rgba(15,30,51,0.08)",
              }}
            >
              <div style={{ fontSize: 12, color: "var(--navy-500)", marginBottom: 4 }}>
                <strong style={{ color: "var(--navy-700)", fontWeight: 600 }}>{n.mine ? "Vos" : n.authorName}</strong>
                {" · "}
                <time dateTime={n.createdAt}>{messageWhen(n.createdAt)}</time>
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--navy-900)" }}>
                {n.body}
              </div>
            </li>
          ))}
        </ol>
      )}

      <form onSubmit={onSubmit} style={{ display: "grid", gap: 8 }}>
        <FormField
          as="textarea"
          label="Nueva nota"
          name="note"
          rows={3}
          value={body}
          onChange={(v) => setBody(v.slice(0, TICKET_NOTE_MAX))}
          error={error ?? undefined}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
          <span aria-live="polite" style={{ fontSize: 12, color: body.length >= TICKET_NOTE_MAX ? "var(--danger-fg)" : "var(--navy-500)" }}>
            {body.length} / {TICKET_NOTE_MAX}
          </span>
          <Button type="submit" variant="ghost" disabled={pending || body.trim() === ""}>
            {pending ? "Guardando…" : "Agregar nota"}
          </Button>
        </div>
      </form>
    </section>
  );
}

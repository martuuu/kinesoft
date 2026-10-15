import type { SupportMessageView } from "@/lib/support-threads-types";
import { messageWhen } from "@/lib/support-threads-types";

/**
 * Lista de mensajes de una conversación de soporte (PL-2d). Presentacional y sin estado: la usan el panel del
 * consultorio (Configuración → Soporte) y el hilo de /plataforma → Mensajes, cada uno con su punto de vista (`mine`
 * lo calcula el server: lo escribió quien mira). Vive acá y no en `components/ui/` porque es de este dominio.
 *
 * El texto va como texto (React escapa) con `white-space: pre-wrap`: los saltos de línea del mensaje se respetan y
 * nada se interpreta como HTML. Lo propio a la derecha en sky, lo ajeno a la izquierda en blanco: el canal no es solo
 * el color, también el lado y el nombre arriba.
 */
export function SupportMessageList({ messages }: { messages: SupportMessageView[] }) {
  if (messages.length === 0) {
    return <p style={{ margin: 0, fontSize: 13.5, color: "var(--navy-500)" }}>Todavía no hay mensajes.</p>;
  }
  return (
    <ol aria-label="Mensajes" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
      {messages.map((m) => (
        <li
          key={m.id}
          data-author={m.authorKind}
          style={{ display: "flex", flexDirection: "column", alignItems: m.mine ? "flex-end" : "flex-start" }}
        >
          <div style={{ fontSize: 12, color: "var(--navy-500)", marginBottom: 4 }}>
            <strong style={{ color: "var(--navy-700)", fontWeight: 600 }}>{m.authorName}</strong>
            {" · "}
            <time dateTime={m.createdAt}>{messageWhen(m.createdAt)}</time>
          </div>
          <div
            style={{
              maxWidth: "min(520px, 100%)",
              padding: "10px 14px",
              borderRadius: 14,
              fontSize: 14,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              color: "var(--navy-900)",
              background: m.mine ? "var(--sky-50)" : "#fff",
              border: `1px solid ${m.mine ? "var(--sky-200)" : "rgba(15,30,51,0.08)"}`,
            }}
          >
            {m.body}
          </div>
        </li>
      ))}
    </ol>
  );
}

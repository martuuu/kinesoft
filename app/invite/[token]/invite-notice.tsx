/**
 * Aviso de la página de invitación (antes `Notice` local de `page.tsx`; ahora lo usan también el formulario de
 * activación y el botón de unirse). Presentacional, sin estado: sirve en server y client components.
 */
export function InviteNotice({
  children,
  tone,
  role,
}: {
  children: React.ReactNode;
  tone: "info" | "success" | "error" | "warning";
  role?: "alert" | "status";
}) {
  const bg =
    tone === "success"
      ? "rgba(200,245,100,0.18)"
      : tone === "error"
        ? "var(--danger-bg)"
        : tone === "warning"
          ? "rgba(255,176,32,0.15)"
          : "rgba(31,79,190,0.08)";
  const color = tone === "error" ? "var(--danger-fg)" : tone === "warning" ? "var(--warn-fg)" : "var(--navy-700)";
  return (
    <div role={role} style={{ padding: 14, borderRadius: 12, background: bg, color, fontSize: 13, lineHeight: 1.45 }}>
      {children}
    </div>
  );
}

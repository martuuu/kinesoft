/**
 * Aviso de la página de invitación (antes `Notice` local de `page.tsx`; ahora lo usan también el formulario de
 * activación y el botón de unirse). Presentacional, sin estado: sirve en server y client components.
 *
 * VX2-b1: error y éxito usan `.k-alert` / `.k-alert-success` de C-F2 (tokens de estado, con borde); info y aviso no
 * tienen clase en C-F2 y van con los tokens `--warn-*` / `--sky-*`. Antes eran rgba sueltos (el verde lima de éxito
 * no llegaba a contraste con el texto navy-700). El contenido va envuelto: `.k-alert` es flex y partiría en columnas
 * un texto con `<strong>` adentro.
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
  if (tone === "error" || tone === "success") {
    return (
      <div role={role} className={tone === "error" ? "k-alert" : "k-alert k-alert-success"}>
        <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>{children}</div>
      </div>
    );
  }
  const style =
    tone === "warning"
      ? { background: "var(--warn-bg)", color: "var(--warn-fg)" }
      : { background: "var(--sky-100)", color: "var(--navy-700)" };
  return (
    <div
      role={role}
      style={{ ...style, padding: "12px 14px", borderRadius: 12, fontSize: 14, lineHeight: 1.45, overflowWrap: "anywhere" }}
    >
      {children}
    </div>
  );
}

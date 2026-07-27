import Link from "next/link";

export const metadata = { title: "Página no encontrada · KineSoft" };

/** Root 404 — Spanish, on-brand, with a way back. */
export default function NotFound() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-app, #f5f7fb)",
        color: "var(--navy-900, #0f1e33)",
        padding: 24,
      }}
    >
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        <div
          className="k-display"
          style={{ fontSize: 64, fontWeight: 800, color: "var(--sky-700, #1f4fbe)", lineHeight: 1 }}
        >
          404
        </div>
        <h1 style={{ fontSize: 22, margin: "12px 0 8px" }}>No encontramos esta página</h1>
        <p style={{ fontSize: 14, color: "var(--navy-500, #51617a)", margin: "0 0 24px" }}>
          El enlace puede estar roto o la página fue movida.
        </p>
        <Link
          href="/dashboard"
          style={{
            display: "inline-block",
            padding: "10px 20px",
            borderRadius: 10,
            background: "var(--sky-700, #1f4fbe)",
            color: "#fff",
            fontSize: 14,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Volver al inicio
        </Link>
      </div>
    </div>
  );
}

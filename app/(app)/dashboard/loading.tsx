/** Segment loading state for the dashboard while server data resolves. */
export default function DashboardLoading() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 360,
        color: "var(--navy-300, #94a3bd)",
        fontSize: 14,
      }}
    >
      Cargando tablero…
    </div>
  );
}

/** Segment loading state for the agenda while server data resolves. */
export default function AgendaLoading() {
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
      Cargando agenda…
    </div>
  );
}

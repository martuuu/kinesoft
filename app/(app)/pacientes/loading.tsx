/** Segment loading state for the patients list while server data resolves. */
export default function PacientesLoading() {
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
      Cargando pacientes…
    </div>
  );
}

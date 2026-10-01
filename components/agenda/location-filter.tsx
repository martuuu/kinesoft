"use client";

/**
 * Filtro de sede de la agenda (B4.3, plan §11.3). Presentacional y
 * controlado: `value` = `agendaPrefs.locationId` (null = todas) y `onChange`
 * lo persiste el caller (`updateAgendaViewPrefs`) y refresca la
 * disponibilidad de la semana para esa sede.
 *
 * Con una sola sede no se dibuja nada: el consultorio de un profesional ve la
 * agenda igual que siempre.
 */
export function LocationFilter({
  locations,
  value,
  onChange,
}: {
  locations: ReadonlyArray<{ id: string; name: string; isPrimary: boolean }>;
  value: string | null;
  onChange: (locationId: string | null) => void;
}) {
  if (locations.length <= 1) return null;
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label="Filtrar por sede"
      style={{
        height: 36,
        padding: "0 12px",
        borderRadius: 999,
        fontSize: 12.5,
        fontWeight: 600,
        border: value ? "1px solid var(--navy-700)" : "1px solid rgba(15,30,51,0.08)",
        background: "rgba(255,255,255,0.7)",
        color: "var(--navy-700)",
        maxWidth: 220,
      }}
    >
      <option value="">Todas las sedes</option>
      {locations.map((l) => (
        <option key={l.id} value={l.id}>
          {l.name}
          {l.isPrimary ? " (principal)" : ""}
        </option>
      ))}
    </select>
  );
}

type Props = { size?: number; light?: boolean; markOnly?: boolean };

export function KineLogo({ size = 28, light = false, markOnly = false }: Props) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.32,
          background: "linear-gradient(135deg, var(--sky-700), var(--sky-500))",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "white",
          boxShadow:
            "0 4px 12px rgba(31,79,190,0.35), inset 0 1px 0 rgba(255,255,255,0.4)",
        }}
      >
        <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none">
          <circle cx="7" cy="6" r="2.5" fill="currentColor" />
          <path
            d="M6 9.5C6 12 7.5 13 8 14.5L6 21"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <path
            d="M9 11.5L13 12.5L16 10.5L19 16"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="17.5" cy="6.5" r="1.6" fill="var(--lime-300)" />
        </svg>
      </span>
      {!markOnly && (
        <span
          style={{
            fontWeight: 700,
            fontSize: size * 0.62,
            letterSpacing: "-0.02em",
            color: light ? "#fff" : "var(--navy-900)",
          }}
        >
          KineSoft
        </span>
      )}
    </span>
  );
}

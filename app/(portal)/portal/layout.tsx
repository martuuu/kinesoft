/**
 * Patient portal layout — mobile-first, lightweight.
 *
 * The brief explicitly calls for `< 150kB` JS and a clean data footprint
 * here. So no Tweaks panel, no sidebar — just a glass nav and a stack.
 */
import Link from "next/link";
import { KineLogo } from "@/components/ui/kine-logo";

export const metadata = { title: "Mi portal · KineSoft" };

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="k-app"
      style={{
        minHeight: "100vh",
        background: "var(--bg-app)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: -120,
          right: -80,
          width: 360,
          height: 360,
          borderRadius: "50%",
          background: "radial-gradient(circle, var(--sky-300), transparent 70%)",
          opacity: 0.5,
          filter: "blur(10px)",
          pointerEvents: "none",
        }}
      />
      <header
        className="k-glass"
        style={{
          position: "sticky",
          top: 12,
          margin: "12px 16px 0",
          padding: "10px 16px",
          borderRadius: 999,
          display: "flex",
          alignItems: "center",
          gap: 16,
          zIndex: 20,
        }}
      >
        <Link href="/portal" style={{ textDecoration: "none" }}>
          <KineLogo size={24} />
        </Link>
        <span style={{ fontSize: 12, color: "var(--navy-300)" }}>· para pacientes</span>
        <div style={{ flex: 1 }} />
        <Link
          href="/portal/me"
          style={{ fontSize: 12.5, color: "var(--sky-700)", fontWeight: 600, textDecoration: "none" }}
        >
          Mi cuenta
        </Link>
      </header>
      <main style={{ padding: "24px 16px 48px", maxWidth: 720, margin: "0 auto" }}>{children}</main>
    </div>
  );
}

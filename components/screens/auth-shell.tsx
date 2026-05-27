/**
 * Shared brand-panel + card layout used by login / signup / forgot /
 * reset. Keeps the visual treatment in one place so the small auth
 * flows don't have to copy the gradients + KineLogo positioning.
 */
import Link from "next/link";
import { KineLogo } from "@/components/ui/kine-logo";
import { Tag } from "@/components/ui/tag";

export function AuthShell({
  eyebrow,
  heading,
  blurb,
  footerLinks,
  children,
}: {
  eyebrow: string;
  heading: string;
  blurb: string;
  footerLinks?: { label: string; href: string }[];
  children: React.ReactNode;
}) {
  return (
    <div
      className="k-app"
      style={{
        minHeight: "100vh",
        background: "var(--bg-app)",
        position: "relative",
        overflow: "hidden",
        display: "flex",
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: -120,
          right: -80,
          width: 460,
          height: 460,
          borderRadius: "50%",
          background: "radial-gradient(circle, var(--sky-300), transparent 70%)",
          opacity: 0.7,
          filter: "blur(10px)",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          bottom: -160,
          left: -120,
          width: 520,
          height: 520,
          borderRadius: "50%",
          background: "radial-gradient(circle, var(--lime-300), transparent 65%)",
          opacity: 0.45,
          filter: "blur(20px)",
        }}
      />

      <div
        className="login-brand"
        style={{
          flex: 1,
          padding: 56,
          display: "flex",
          flexDirection: "column",
          position: "relative",
          zIndex: 2,
        }}
      >
        <KineLogo size={32} />
        <div style={{ marginTop: "auto", maxWidth: 460 }}>
          <Tag tone="lime" className="mb-6">
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--navy-900)" }} />
            {eyebrow}
          </Tag>
          <h1 className="k-display" style={{ fontSize: 48, lineHeight: 1.05, margin: "0 0 18px" }}>
            {heading}
          </h1>
          <p style={{ fontSize: 15, lineHeight: 1.55, color: "var(--navy-500)", margin: 0, maxWidth: 420 }}>
            {blurb}
          </p>
        </div>
        <div style={{ marginTop: 28, display: "flex", gap: 14, fontSize: 12, color: "var(--navy-300)" }}>
          <span>© 2026 KineSoft</span>
          {footerLinks?.map((l) => (
            <Link key={l.href} href={l.href} style={{ color: "var(--sky-700)", fontWeight: 600 }}>
              {l.label}
            </Link>
          ))}
        </div>
      </div>

      <div
        className="login-form-wrap"
        style={{
          width: 540,
          padding: "56px 56px 56px 0",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          zIndex: 2,
        }}
      >
        <div
          className="k-glass-strong"
          style={{
            padding: 40,
            borderRadius: "var(--r-2xl)",
            width: "100%",
            maxWidth: 460,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

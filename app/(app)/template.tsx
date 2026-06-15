"use client";

/**
 * Per-navigation transition for the workspace.
 *
 * Next.js re-mounts a `template.tsx` on every route change (unlike
 * `layout.tsx`, which persists), so wrapping children in a `motion.div`
 * here gives every page a smooth enter animation without touching each
 * page component. Kept subtle (fade + small rise) so navigation feels
 * fluid, not theatrical. Honours reduced-motion via the global
 * MotionConfig.
 */
import { motion } from "framer-motion";
import { pageVariants } from "@/lib/motion";

export default function WorkspaceTemplate({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      variants={pageVariants}
      initial="initial"
      animate="animate"
      style={{ height: "100%" }}
    >
      {children}
    </motion.div>
  );
}

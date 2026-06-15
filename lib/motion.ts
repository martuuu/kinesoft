/**
 * Shared motion vocabulary for KineSoft.
 *
 * One source of truth for easing + durations + variants so every animated
 * surface (page transitions, modals, drawers, toasts, lists) feels like it
 * belongs to the same system. Values are intentionally subtle and quick —
 * the UI should feel alive, never sluggish.
 *
 * These are plain data objects (no JSX), safe to import from any client
 * component. `framer-motion` honours the user's `prefers-reduced-motion`
 * globally via the `<MotionConfig reducedMotion="user">` in ui-providers.
 */
import type { Transition, Variants } from "framer-motion";

/** The house easing curve — matches the Drawer's original cubic-bezier. */
export const EASE_OUT: [number, number, number, number] = [0.2, 0.8, 0.2, 1];
export const EASE_IN_OUT: [number, number, number, number] = [0.4, 0, 0.2, 1];

export const DUR = {
  fast: 0.15,
  base: 0.22,
  slow: 0.3,
} as const;

export const springSoft: Transition = {
  type: "spring",
  stiffness: 520,
  damping: 38,
  mass: 0.9,
};

/** Page-level transition used by the workspace `template.tsx`. */
export const pageVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: DUR.slow, ease: EASE_OUT } },
  exit: { opacity: 0, y: -6, transition: { duration: DUR.fast, ease: EASE_IN_OUT } },
};

/** Centered modal card. */
export const modalVariants: Variants = {
  initial: { opacity: 0, scale: 0.96, y: 10 },
  animate: { opacity: 1, scale: 1, y: 0, transition: { duration: DUR.base, ease: EASE_OUT } },
  exit: { opacity: 0, scale: 0.97, y: 6, transition: { duration: DUR.fast, ease: EASE_IN_OUT } },
};

/** Shared backdrop fade for modals + drawers. */
export const backdropVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: DUR.base, ease: EASE_OUT } },
  exit: { opacity: 0, transition: { duration: DUR.fast, ease: EASE_IN_OUT } },
};

/** Right-side drawer panel. `custom` = panel width (+gap) in px. */
export const drawerVariants: Variants = {
  initial: (offset: number) => ({ x: offset, opacity: 0.6 }),
  animate: { x: 0, opacity: 1, transition: { duration: DUR.slow, ease: EASE_OUT } },
  exit: (offset: number) => ({ x: offset, opacity: 0.4, transition: { duration: DUR.base, ease: EASE_IN_OUT } }),
};

/** Toast / snackbar — slides in from the right, springs into the stack. */
export const toastVariants: Variants = {
  initial: { opacity: 0, x: 40, scale: 0.96 },
  animate: { opacity: 1, x: 0, scale: 1, transition: springSoft },
  exit: { opacity: 0, x: 40, scale: 0.9, transition: { duration: DUR.base, ease: EASE_IN_OUT } },
};

/**
 * List container + item for staggered reveals (patient directory, agenda
 * lists). Use `staggerList` on the wrapper and `staggerItem` on each child.
 */
export const staggerList: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.035, delayChildren: 0.02 } },
};

export const staggerItem: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: DUR.base, ease: EASE_OUT } },
};

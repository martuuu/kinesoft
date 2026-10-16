/**
 * Carga diferida del panel «Apariencia» (PF1.0-a, C-PF2). Módulo aparte para que el AppShell (que lo monta) y los
 * disparadores (pie del sidebar, menú de cuenta del topbar) compartan el MISMO `import()` sin importarse entre sí.
 */
export const loadTweaksPanel = () => import("./tweaks-panel");

/** `import()` sin await: deja el chunk en camino en el hover/foco del disparador, así el clic no espera red. */
export function preloadAppearance(): void {
  void loadTweaksPanel();
}

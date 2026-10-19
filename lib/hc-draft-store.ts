/**
 * [FC-3c] Borrador de la ficha EN MEMORIA (§24.7 «Formulario único», FC-UI-D2).
 *
 * Por qué en memoria y nunca en disco: la ficha es un dato de salud. `localStorage`/`sessionStorage`/IndexedDB/Cache
 * sobreviven al cierre de sesión y quedan legibles para cualquiera que use la misma computadora (la PC de la
 * recepción, la del consultorio compartido); un borrador clínico ahí es una filtración que nadie ve. En memoria vive
 * lo que dura la pestaña: alcanza para el caso real (FC-UI-D2: ir a Resumen o a la Agenda y volver sin perder lo
 * escrito) y se va solo al recargar o cerrar, con el aviso de `beforeunload`. Lo verifica un guard estático
 * (`tests/unit/fc3c-ficha-form.test.ts`): este archivo no puede nombrar ninguna de esas APIs.
 *
 * - Clave: usuario + consultorio + paciente. Un mismo navegador con dos usuarios (cambio de cuenta sin recargar) o un
 *   profesional en dos consultorios no ve el borrador del otro.
 * - TTL 12 h desde la última escritura: un borrador de ayer a la tarde no aparece en el paciente de hoy como si fuera
 *   nuevo (la pestaña de la agenda queda abierta días).
 * - LRU 20: la Secretaria o un profesional con agenda densa puede abrir decenas de pacientes; sin tope, la memoria
 *   crece con fichas que nunca se van a guardar. Leer cuenta como uso.
 * - La clave de idempotencia viaja DENTRO del borrador (`FichaDraft.idempotencyKey`): si se restaura y el primer envío
 *   ya había llegado al server, el reintento es replay y no una ficha duplicada. Al guardar, el formulario borra el
 *   borrador y arranca uno con clave nueva (la clave «rota»).
 * - Nunca escribe en el server: este módulo también se evalúa en el SSR, donde el estado de módulo es COMPARTIDO entre
 *   requests de usuarios distintos. `isBrowser` falso → escribir es un no-op.
 */
import type { FichaDraft, FichaDraftScope } from "@/components/fichas/fichas-ui-types";

export const HC_DRAFT_TTL_MS = 12 * 60 * 60 * 1000;
export const HC_DRAFT_MAX = 20;

type Entry = { draft: FichaDraft; savedAt: number };

/** Lo mínimo de `window` que usa el store (inyectable en los tests, que corren en Node sin DOM). */
export type HcDraftWindow = {
  addEventListener: (type: "beforeunload", fn: (e: HcBeforeUnloadEvent) => void) => void;
};
export type HcBeforeUnloadEvent = { preventDefault: () => void; returnValue?: unknown };

export type HcDraftStore = {
  read: (scope: FichaDraftScope, now?: number) => FichaDraft | null;
  write: (scope: FichaDraftScope, draft: FichaDraft, now?: number) => void;
  clear: (scope: FichaDraftScope) => void;
  has: (scope: FichaDraftScope, now?: number) => boolean;
  /** Borradores vivos (no vencidos) de cualquier alcance: decide el aviso de `beforeunload`. */
  liveCount: (now?: number) => number;
  /** Avisa cuando cambia el conjunto de borradores (el punto de «sin guardar» en la pestaña, FC-3d). */
  subscribe: (fn: () => void) => () => void;
  /** Handler de `beforeunload` (exportado para el test): con borradores vivos pide confirmar la salida. */
  onBeforeUnload: (e: HcBeforeUnloadEvent) => void;
  /** Solo tests. */
  size: () => number;
};

/** Clave estable. JSON y no `a:b:c`: un id con «:» no puede chocar con otro alcance. */
export function hcDraftKey(scope: FichaDraftScope): string {
  return JSON.stringify([scope.tenantId, scope.userId, scope.patientId]);
}

export function createHcDraftStore(opts: { isBrowser: boolean; win?: HcDraftWindow | null }): HcDraftStore {
  // Map conserva el orden de inserción: borrar y volver a insertar = «usado recién»; el primero es el menos usado.
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let unloadInstalled = false;

  const emit = () => {
    for (const fn of listeners) fn();
  };
  const expired = (e: Entry, now: number) => now - e.savedAt >= HC_DRAFT_TTL_MS;
  const sweep = (now: number) => {
    let changed = false;
    for (const [k, e] of entries) {
      if (expired(e, now)) {
        entries.delete(k);
        changed = true;
      }
    }
    return changed;
  };
  const liveCount = (now = Date.now()) => {
    let n = 0;
    for (const e of entries.values()) if (!expired(e, now)) n++;
    return n;
  };
  const onBeforeUnload = (e: HcBeforeUnloadEvent) => {
    if (liveCount() === 0) return;
    // Los dos: `preventDefault` es el estándar; `returnValue` lo siguen pidiendo Chrome/Edge viejos y Safari.
    e.preventDefault();
    e.returnValue = "";
  };
  // Se instala recién con el primer borrador (no en el import): una pestaña que nunca escribió una ficha no paga un
  // listener de `beforeunload`, que además saca la página del bfcache en algunos navegadores.
  const installUnload = () => {
    if (unloadInstalled || !opts.win) return;
    opts.win.addEventListener("beforeunload", onBeforeUnload);
    unloadInstalled = true;
  };

  return {
    read(scope, now = Date.now()) {
      const k = hcDraftKey(scope);
      const e = entries.get(k);
      if (!e) return null;
      if (expired(e, now)) {
        entries.delete(k);
        emit();
        return null;
      }
      entries.delete(k);
      entries.set(k, e);
      return e.draft;
    },
    write(scope, draft, now = Date.now()) {
      if (!opts.isBrowser) return;
      const k = hcDraftKey(scope);
      const had = entries.has(k);
      entries.delete(k);
      entries.set(k, { draft, savedAt: now });
      sweep(now);
      while (entries.size > HC_DRAFT_MAX) {
        const oldest = entries.keys().next().value as string;
        entries.delete(oldest);
      }
      installUnload();
      // Solo cambia el conjunto (no cada tecla): el punto de la pestaña no necesita re-render por letra.
      if (!had) emit();
    },
    clear(scope) {
      if (entries.delete(hcDraftKey(scope))) emit();
    },
    has(scope, now = Date.now()) {
      const e = entries.get(hcDraftKey(scope));
      return Boolean(e && !expired(e, now));
    },
    liveCount,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    onBeforeUnload,
    size: () => entries.size,
  };
}

/** El store de la app (uno por pestaña). En el SSR no hay `window`: queda inerte. */
export const hcDraftStore: HcDraftStore = createHcDraftStore({
  isBrowser: typeof window !== "undefined",
  win: typeof window !== "undefined" ? (window as unknown as HcDraftWindow) : null,
});

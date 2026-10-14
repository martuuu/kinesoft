/**
 * Chime de los avisos de la sala de espera (SV11b, plan §18.5 «Sonido»).
 *
 * WebAudio puro, sin asset: dos tonos 880 → 1174 Hz (una sexta mayor
 * ascendente, se lee como «llegó alguien» y no como error), 180 ms cada uno,
 * ganancia 0,12 (se oye en un consultorio sin sobresaltar al paciente).
 *
 * Política de autoplay: el `AudioContext` nace `suspended` si no hubo gesto del
 * usuario, y crearlo antes del gesto deja un warning en la consola de Chrome.
 * Por eso se crea LAZY en el primer `pointerdown`/`keydown` (una sola vez) y ahí
 * mismo se `resume()`. Si al sonar sigue `suspended`, `play()` devuelve `false`
 * y el toast suma la nota «El sonido se activa después del primer clic en la
 * página» (degrada a visual, nunca tira). Con el contexto ya `running`, Chrome y
 * Firefox lo dejan sonar con la pestaña oculta (Martin, 13-oct: «si el navegador
 * lo permite»).
 *
 * `createChime(deps)` con deps inyectables para el unit test; la app usa el
 * singleton de abajo (`installChimeUnlock`, `playChime`, `previewChime`).
 */

export const CHIME = { freqs: [880, 1174], toneMs: 180, gain: 0.12 } as const;

/** Lo que usa el chime de `AudioContext` (el test lo falsea a mano). */
export type ChimeAudioContext = {
  state: string;
  currentTime: number;
  destination: unknown;
  resume(): Promise<void>;
  createOscillator(): {
    type: string;
    frequency: { setValueAtTime(v: number, t: number): unknown };
    connect(n: unknown): unknown;
    start(t?: number): void;
    stop(t?: number): void;
  };
  createGain(): {
    gain: {
      setValueAtTime(v: number, t: number): unknown;
      linearRampToValueAtTime(v: number, t: number): unknown;
      exponentialRampToValueAtTime(v: number, t: number): unknown;
    };
    connect(n: unknown): unknown;
  };
};

type GestureTarget = {
  addEventListener(type: string, fn: () => void, opts?: AddEventListenerOptions | boolean): void;
  removeEventListener(type: string, fn: () => void, opts?: EventListenerOptions | boolean): void;
};

export type ChimeDeps = {
  /** null = no hay WebAudio (SSR, navegador viejo). */
  createContext: () => ChimeAudioContext | null;
  target: GestureTarget | null;
};

export type Chime = {
  /** Escucha el primer gesto para crear y reanudar el contexto. Idempotente. */
  installUnlock(): void;
  /** Suena si el contexto está `running`; si no, `false` (el toast lo aclara). */
  play(): boolean;
  /** «Probar sonido»: corre DENTRO del clic, así que puede crear y reanudar él mismo. */
  preview(): Promise<boolean>;
};

const GESTURES = ["pointerdown", "keydown"] as const;

export function createChime(deps: ChimeDeps): Chime {
  let ctx: ChimeAudioContext | null = null;
  let installed = false;

  const ensure = (): ChimeAudioContext | null => {
    if (ctx) return ctx;
    try {
      ctx = deps.createContext();
    } catch {
      ctx = null;
    }
    return ctx;
  };

  const resume = (c: ChimeAudioContext): Promise<void> => {
    if (c.state === "running") return Promise.resolve();
    // Un resume rechazado (permiso del sitio) deja el contexto suspended: play() lo informa.
    return c.resume().catch(() => {});
  };

  return {
    installUnlock() {
      if (installed || !deps.target) return;
      installed = true;
      const target = deps.target;
      const unlock = () => {
        for (const g of GESTURES) target.removeEventListener(g, unlock, true);
        const c = ensure();
        if (c) void resume(c);
      };
      for (const g of GESTURES) target.addEventListener(g, unlock, { capture: true, passive: true });
    },

    play() {
      const c = ctx;
      if (!c || c.state !== "running") return false;
      try {
        const step = CHIME.toneMs / 1000;
        const t0 = c.currentTime;
        CHIME.freqs.forEach((freq, i) => {
          const start = t0 + i * step;
          const osc = c.createOscillator();
          const gain = c.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(freq, start);
          // Envolvente corta: sin ataque/caída el corte del seno hace «clic».
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.linearRampToValueAtTime(CHIME.gain, start + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + step);
          osc.connect(gain);
          gain.connect(c.destination);
          osc.start(start);
          osc.stop(start + step + 0.02);
        });
        return true;
      } catch {
        return false;
      }
    },

    async preview() {
      const c = ensure();
      if (!c) return false;
      await resume(c);
      return this.play();
    },
  };
}

let singleton: Chime | null = null;

function appChime(): Chime {
  if (singleton) return singleton;
  singleton = createChime({
    createContext: () => {
      if (typeof window === "undefined") return null;
      const w = window as unknown as {
        AudioContext?: new () => ChimeAudioContext;
        webkitAudioContext?: new () => ChimeAudioContext;
      };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      return Ctor ? new Ctor() : null;
    },
    target: typeof window === "undefined" ? null : window,
  });
  return singleton;
}

export function installChimeUnlock(): void {
  appChime().installUnlock();
}

export function playChime(): boolean {
  return appChime().play();
}

export function previewChime(): Promise<boolean> {
  return appChime().preview();
}

"use client";

/**
 * TV (T7, §26.4 C-TV): la pantalla de la sala de espera (`/tv`, ya vinculada). Grilla del prototype
 * `design_source/vx0/sala-tv.html`: 16:9 medida en `--u = min(1vw, 1.78vh)`, se lee a 4-5 m.
 *
 * Layouts (`DisplayConfig.mediaLayout`, solo si hay video y `youtube-pip` lo está mostrando):
 * - sin video (o el reproductor se ocultó por error): el del prototype — hero a la izquierda; «Próximos» y «Recién
 *   llamados» en la columna.
 * - SIDE: la columna lleva el recuadro de video 16:9 arriba y «Próximos» abajo; «Recién llamados» pasa a una línea
 *   bajo el hero.
 * - HERO_IDLE: el video ocupa el hero mientras no hay llamado; un llamado NUEVO lo tapa `HERO_IDLE_CALL_MS` y vuelve
 *   el video. El reproductor es SIEMPRE el mismo nodo (cambia su `grid-area` por CSS): moverlo en el árbol de React
 *   remontaría el iframe y el video arrancaría de cero en cada llamado.
 *
 * Llamado nuevo (`isNewCall`, nunca el del feed inicial): anima el hero (≤ 600 ms, solo transform/opacity; con
 * reduced motion se ve el estado final de una), suena el chime si el sonido ya se desbloqueó, y se anuncia en un
 * `aria-live` aparte (el hero no es live: si no, cada poll re-anunciaría al mismo paciente).
 *
 * Superficie pública (guard `public-surface-imports`): sin framer, toast, drawer ni modal. PHI: solo lo que trae
 * `DisplayFeed` (nombre corto u hora del turno, consultorio, profesional).
 */
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { BRAND_NAME } from "@/lib/brand";
import { playChime } from "@/lib/arrival-chime";
import { MEDIA_REF_RE, type YouTubeMedia } from "@/lib/youtube";
import {
  HERO_IDLE_CALL_MS,
  type DisplayConfig,
  type DisplayFeed,
  type DisplayFeedItem,
} from "@/lib/reception-displays-types";
import type { RealtimeBootstrap } from "@/lib/realtime-events";
import { useDisplayLive } from "./use-display-live";
import { useKiosk } from "./use-kiosk";
import styles from "./tv.module.css";

const AR_TZ = "America/Argentina/Buenos_Aires";
const CLOCK_TICK_MS = 5_000;

export type TvScreenProps = { initialFeed: DisplayFeed; bootstrap: RealtimeBootstrap | null };

// Solo el tipo (se borra al compilar): el componente entra por `import()` más abajo.
type PipProps = import("./youtube-pip").YouTubePipProps;

export type ScreenLayout = "none" | "side" | "hero-idle";
export type HeroMode = "call" | "idle" | "media";

/** El video de la config, o `null` si no hay (o la ref no cumple el CHECK de M17: no se embebe basura). */
export function mediaOf(config: DisplayConfig): YouTubeMedia | null {
  if (config.mediaKind === "NONE" || !config.mediaRef) return null;
  const re = MEDIA_REF_RE[config.mediaKind];
  return re && re.test(config.mediaRef) ? { kind: config.mediaKind, ref: config.mediaRef } : null;
}

export function screenLayout(config: DisplayConfig, mediaVisible: boolean): ScreenLayout {
  if (!mediaVisible || !mediaOf(config)) return "none";
  return config.mediaLayout === "HERO_IDLE" ? "hero-idle" : "side";
}

export function heroModeFor(layout: ScreenLayout, hero: DisplayFeedItem | null, callInterrupting: boolean): HeroMode {
  if (layout === "hero-idle") return hero && callInterrupting ? "call" : "media";
  return hero ? "call" : "idle";
}

/** «Pasá al consultorio 2.» / «Pasá al gimnasio.» / «Pasá a Sala B.» (sin sala: lo dice el profesional o recepción). */
export function destinationPhrase(item: Pick<DisplayFeedItem, "room" | "practitioner">): string {
  if (item.room) {
    const lower = item.room.toLowerCase();
    if (/^(consultorio|box|gimnasio|sal[oó]n)\b/.test(lower)) return `Pasá al ${lower}.`;
    return `Pasá a ${item.room}.`;
  }
  if (item.practitioner) return `Te espera ${item.practitioner}.`;
  return "Acercate a recepción.";
}

/** «recién» / «hace 12 min» desde el `calledAt` con el reloj corregido. */
export function agoLabel(calledAt: string | null, nowMs: number): string {
  if (!calledAt) return "";
  const min = Math.floor((nowMs - Date.parse(calledAt)) / 60_000);
  return min < 1 ? "recién" : `hace ${min} min`;
}

const timeFmt = new Intl.DateTimeFormat("es-AR", { timeZone: AR_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dateFmt = new Intl.DateTimeFormat("es-AR", { timeZone: AR_TZ, weekday: "long", day: "numeric", month: "long" });

export function clockText(nowMs: number): { time: string; date: string } {
  const d = new Date(nowMs);
  return { time: timeFmt.format(d), date: dateFmt.format(d).replace(",", "") };
}

/** Iniciales del consultorio para el sello (no hay logo en /tv: img-src sin Storage, handoff TV-1c). */
export function clinicInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => /^\p{L}/u.test(w));
  const letters = words.slice(0, 2).map((w) => w[0]!.toUpperCase());
  return letters.join("") || "·";
}

/** Tamaño de arranque del nombre (SSR, antes de medir): los nombres largos arrancan más chicos. */
function nameLen(label: string): "s" | "m" | "l" {
  return label.length <= 10 ? "s" : label.length <= 16 ? "m" : "l";
}

export function callAnnouncement(item: DisplayFeedItem): string {
  // «Laura P.» ya termina en punto: no se le agrega otro.
  const label = item.label.endsWith(".") ? item.label : `${item.label}.`;
  return [`Llamado: ${label}`, destinationPhrase(item), item.room && item.practitioner ? `Con ${item.practitioner}.` : ""]
    .filter(Boolean)
    .join(" ");
}

const DoorIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 21V4.5A1.5 1.5 0 0 1 6.5 3h8A1.5 1.5 0 0 1 16 4.5V21M3 21h18M12.5 12.5h.01M16 7h3v14" />
  </svg>
);
const WalkIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
const InfoIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9.5" />
    <path d="M12 11v5.5" />
    <circle cx="12" cy="7.8" r=".6" fill="currentColor" />
  </svg>
);
const SoundIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </svg>
);

/** El nombre nunca se corta: si no entra en una línea, se achica (prototype `fit()`). */
function useFitText(dep: string | null) {
  const ref = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.fontSize = "";
      const max = el.parentElement?.clientWidth ?? 0;
      let size = parseFloat(getComputedStyle(el).fontSize);
      while (max > 0 && el.scrollWidth > max && size > 24) {
        size -= 4;
        el.style.fontSize = `${size}px`;
      }
    };
    fit();
    window.addEventListener("resize", fit);
    void document.fonts?.ready.then(fit).catch(() => {});
    return () => window.removeEventListener("resize", fit);
  }, [dep]);
  return ref;
}

/** Una fila a medias en una TV se lee como error: se esconden las que no entran enteras (prototype `trim()`). */
function useTrimList(dep: unknown) {
  const ref = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    const ol = ref.current;
    if (!ol) return;
    const trim = () => {
      const items = Array.from(ol.children) as HTMLElement[];
      for (const li of items) li.hidden = false;
      const limit = ol.getBoundingClientRect().bottom + 1;
      for (const li of items) if (li.getBoundingClientRect().bottom > limit) li.hidden = true;
    };
    trim();
    window.addEventListener("resize", trim);
    return () => window.removeEventListener("resize", trim);
  }, [dep]);
  return ref;
}

export function TvScreen({ initialFeed, bootstrap }: TvScreenProps) {
  const { feed, callSeq, now, live } = useDisplayLive(initialFeed, bootstrap);
  const { cursorHidden, soundUnlocked } = useKiosk({ now });
  const config = feed.config;
  const media = useMemo(() => mediaOf(config), [config]);

  // Reloj: hasta montar, el `serverNow` del SSR (así el HTML del server y el primer render del cliente coinciden).
  const [nowMs, setNowMs] = useState(() => Date.parse(initialFeed.serverNow));
  useEffect(() => {
    setNowMs(now());
    const t = window.setInterval(() => setNowMs(now()), CLOCK_TICK_MS);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // El reproductor entra por import() (YouTube es opcional y pesa: fuera del first-load del grupo `display`).
  const [Pip, setPip] = useState<ComponentType<PipProps> | null>(null);
  const [mediaVisible, setMediaVisible] = useState(true);
  useEffect(() => {
    if (!media || Pip) return;
    let cancelled = false;
    import("./youtube-pip")
      .then((m) => {
        if (!cancelled) setPip(() => m.YouTubePip);
      })
      .catch(() => {
        if (!cancelled) setMediaVisible(false);
      });
    return () => {
      cancelled = true;
    };
  }, [media, Pip]);

  // Llamado nuevo: animación + chime + anuncio + (HERO_IDLE) interrupción del video.
  const [interruptUntil, setInterruptUntil] = useState<number>(() => {
    const h = initialFeed.hero;
    if (!h?.calledAt) return 0;
    // Recién cargada con un llamado de hace segundos: se muestra lo que le queda de los 15 s.
    return Date.parse(h.calledAt) + HERO_IDLE_CALL_MS;
  });
  const [announce, setAnnounce] = useState("");
  const [animKey, setAnimKey] = useState<string | null>(null);
  const soundRef = useRef(soundUnlocked);
  soundRef.current = soundUnlocked;
  useEffect(() => {
    if (callSeq === 0 || !feed.hero) return;
    setAnimKey(feed.hero.key);
    setAnnounce(callAnnouncement(feed.hero));
    setInterruptUntil(now() + HERO_IDLE_CALL_MS);
    // La política de autoplay: sin gesto el AudioContext no existe y `playChime` devuelve false (no tira).
    if (soundRef.current) playChime();
    // Solo cuando entra un llamado nuevo (callSeq); el feed llega en el mismo render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callSeq]);

  // Vuelta al video al vencer la interrupción (el tick de 5 s del reloj la atrasaría).
  useEffect(() => {
    const left = interruptUntil - now();
    if (left <= 0) return;
    const t = window.setTimeout(() => setNowMs(now()), left + 50);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interruptUntil]);

  const layout = screenLayout(config, mediaVisible);
  const hero = feed.hero;
  const mode = heroModeFor(layout, hero, nowMs < interruptUntil);
  const clock = clockText(nowMs);
  const nameRef = useFitText(mode === "call" && hero ? `${hero.key}:${layout}` : null);
  const nextRef = useTrimList(`${feed.waiting.map((w) => w.key).join()}:${layout}`);
  const recentRef = useTrimList(`${feed.recent.map((w) => w.key).join()}:${layout}`);

  const sub = feed.locationName ? `${feed.locationName} · Sala de espera` : "Sala de espera";

  return (
    <div
      className={styles.tv}
      data-theme={config.theme === "LIGHT" ? "light" : "dark"}
      data-cursor={cursorHidden ? "hidden" : "shown"}
    >
      <header className={styles.top}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            {clinicInitials(feed.clinicName)}
          </span>
          <div>
            <h1 className={styles.brandName}>{feed.clinicName}</h1>
            <div className={styles.brandSub}>{sub}</div>
          </div>
        </div>
        <div className={styles.time} aria-hidden="true">
          <div className={styles.timeH} suppressHydrationWarning>
            {clock.time}
          </div>
          <div className={styles.timeD} suppressHydrationWarning>
            {clock.date}
          </div>
        </div>
      </header>

      <main className={styles.main} data-layout={layout} data-hero={mode}>
        {mode === "call" && hero ? (
          <section
            key={hero.key}
            className={styles.hero}
            data-state="call"
            data-anim={animKey === hero.key ? "new" : undefined}
            aria-label="Llamado"
          >
            <div className={styles.heroTop}>
              <span className={styles.eyebrow}>
                <i aria-hidden="true" />
                Llamado
              </span>
              {hero.calledAt ? (
                <span className={styles.heroAt} suppressHydrationWarning>
                  {clockText(Date.parse(hero.calledAt)).time}
                </span>
              ) : null}
            </div>
            <div className={styles.heroBody}>
              <p ref={nameRef} className={styles.heroName} data-len={nameLen(hero.label)}>
                {hero.label}
              </p>
              <div className={styles.heroDest}>
                {hero.room ? (
                  <span className={styles.room}>
                    <DoorIcon />
                    {hero.room}
                  </span>
                ) : null}
                {hero.practitioner ? <span className={styles.pro}>{hero.practitioner}</span> : null}
              </div>
            </div>
            <p className={styles.heroFoot}>
              <WalkIcon />
              {destinationPhrase(hero)}
            </p>
          </section>
        ) : mode === "idle" ? (
          <section className={styles.hero} data-state="idle" aria-label="Sala de espera">
            <div className={styles.heroTop}>
              <span className={styles.eyebrow} data-tone="neutral">
                Sala de espera
              </span>
            </div>
            <div className={styles.heroBody}>
              <p className={styles.heroName}>Te damos la bienvenida.</p>
              <p className={styles.idleSub}>
                Cuando sea tu turno, vas a ver tu nombre en esta pantalla con el consultorio al que pasás.
              </p>
            </div>
            <p className={styles.heroFoot}>Si tenés dudas, preguntá en recepción.</p>
          </section>
        ) : null}

        {media ? (
          <div className={styles.media} data-visible={layout !== "none" ? "true" : "false"} aria-hidden="true">
            {Pip ? (
              <Pip
                media={media}
                muted={config.mediaMuted}
                soundUnlocked={soundUnlocked}
                callSeq={callSeq}
                duringCall={config.mediaDuringCall}
                onVisible={setMediaVisible}
              />
            ) : null}
          </div>
        ) : null}

        <section className={`${styles.panel} ${styles.next}`} aria-labelledby="tv-h-next">
          <h2 id="tv-h-next" className={styles.panelH}>
            Próximos{" "}
            {feed.waitingCount > 0 ? (
              <span data-testid="tv-waiting-count">{feed.waitingCount} esperando</span>
            ) : null}
          </h2>
          <ol ref={nextRef} className={styles.list}>
            {feed.waiting.length === 0 ? (
              <li className={styles.empty}>Nadie más esperando.</li>
            ) : (
              feed.waiting.map((w, i) => (
                <li key={w.key} className={styles.q}>
                  <span className={styles.qN} aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className={styles.qName}>{w.label}</span>
                  {w.practitioner ? <span className={styles.qPro}>{w.practitioner}</span> : <span />}
                </li>
              ))
            )}
          </ol>
        </section>

        {feed.recent.length > 0 || layout !== "side" ? (
          <section className={`${styles.panel} ${styles.recent}`} aria-labelledby="tv-h-recent">
            <h2 id="tv-h-recent" className={styles.panelH}>
              Recién llamados
            </h2>
            <ol ref={recentRef} className={styles.list}>
              {feed.recent.length === 0 ? (
                <li className={styles.empty}>Todavía no hubo llamados.</li>
              ) : (
                feed.recent.map((r) => (
                  <li key={r.key} className={styles.r}>
                    <span className={styles.rName}>
                      {r.label}
                      {r.room ? <span> · {r.room}</span> : null}
                    </span>
                    <span className={styles.rAgo} suppressHydrationWarning>
                      {agoLabel(r.calledAt, nowMs)}
                    </span>
                  </li>
                ))
              )}
            </ol>
          </section>
        ) : null}
      </main>

      <footer className={styles.foot}>
        <span className={styles.info}>
          <InfoIcon />
          ¿Llegaste y no te anunciaste? Acercate a recepción.
        </span>
        <span className={styles.by}>
          <span className={styles.live} data-live={live ? "true" : "false"}>
            <i aria-hidden="true" />
            {live ? "En vivo" : "Reconectando…"}
          </span>
          <span>
            con <b>{BRAND_NAME}</b>
          </span>
        </span>
      </footer>

      {!soundUnlocked ? (
        <div className={styles.soundHint} role="note" data-testid="tv-sound-hint">
          <SoundIcon />
          <span>
            Tocá <b>OK</b> para activar el sonido
          </span>
        </div>
      ) : null}

      <p className="k-sr-only" role="status" aria-live="assertive" aria-atomic="true">
        {announce}
      </p>
    </div>
  );
}

export default TvScreen;

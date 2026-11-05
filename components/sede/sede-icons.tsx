/**
 * CF3 (SD-U): íconos de la sede como sprite `<symbol>` inline, una vez por página (los del prototipo
 * `design_source/sede/sede-a.html`). Sin librería ni JS; decorativos (`aria-hidden`): el texto al lado dice qué es.
 */
import s from "./sede.module.css";

export type SedeIconId = "cal" | "clock" | "pin" | "phone" | "chat";

export function SedeIconSprite() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <symbol id="sede-i-cal" viewBox="0 0 24 24">
        <rect x="3" y="4.5" width="18" height="16" rx="3" />
        <path d="M3 9.5h18M8 3v3M16 3v3" />
      </symbol>
      <symbol id="sede-i-clock" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </symbol>
      <symbol id="sede-i-pin" viewBox="0 0 24 24">
        <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" />
        <circle cx="12" cy="9.5" r="2.5" />
      </symbol>
      <symbol id="sede-i-phone" viewBox="0 0 24 24">
        <path d="M5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 7.5 7.5l1.5-2 4 1.5v3a2 2 0 0 1-2 2A17 17 0 0 1 3 5.5a2 2 0 0 1 2-2z" />
      </symbol>
      <symbol id="sede-i-chat" viewBox="0 0 24 24">
        <path d="M4 20l1.3-3.9A8 8 0 1 1 8 18.8z" />
        <path d="M9 10.5c.5 1.7 1.8 3 3.5 3.5" />
      </symbol>
    </svg>
  );
}

export function SedeIcon({ id }: { id: SedeIconId }) {
  return (
    <svg className={s.i} aria-hidden="true" focusable="false">
      <use href={`#sede-i-${id}`} />
    </svg>
  );
}

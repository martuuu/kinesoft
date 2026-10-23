/**
 * TV-1a · `lib/youtube.ts` (C-TV «YouTube», plan §26.4).
 *
 * El staff pega un link de YouTube en el drawer «Pantallas»; la base guarda SOLO `mediaKind` + `mediaRef` (el id
 * canónico) y la TV arma el iframe con `youtubeEmbedUrl`. Por eso el parser es la única puerta: si deja pasar algo
 * que no cumple el CHECK `ReceptionDisplay_media_check` de M17, el alta revienta con un 500 en vez de un error con
 * copy; si deja pasar un host ajeno o un `javascript:`, la TV embebería cualquier cosa. El test de paridad lee el SQL
 * REAL de la migración (no una copia) para que un cambio de un lado sin el otro se vea acá.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MEDIA_REF_RE, mediaKindLabel, parseYouTubeUrl, youtubeEmbedUrl } from "@/lib/youtube";

const VID = "dQw4w9WgXcQ";
const PL = "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG";
const UC = "UCuAXFkgsw1L7xaCfnd5JJOw";
const HANDLE_ERR =
  "Pegá el link del video en vivo (youtube.com/live/…) o del canal (youtube.com/channel/UC…)";

function okMedia(s: string) {
  const r = parseYouTubeUrl(s);
  if (!r.ok) throw new Error(`esperaba ok para ${s}: ${r.error}`);
  return r.media;
}

describe("[TV-1a] parseYouTubeUrl", () => {
  it("[TV-1a] entiende watch, youtu.be, embed, shorts, /v/ y los hosts m., music., nocookie y sin esquema", () => {
    const cases = [
      `https://www.youtube.com/watch?v=${VID}`,
      `https://youtube.com/watch?v=${VID}&t=42s`,
      `http://m.youtube.com/watch?feature=share&v=${VID}`,
      `https://music.youtube.com/watch?v=${VID}`,
      `https://youtu.be/${VID}`,
      `https://youtu.be/${VID}?si=abc123&t=10`,
      `https://www.youtube.com/embed/${VID}`,
      `https://www.youtube-nocookie.com/embed/${VID}?autoplay=1`,
      `https://youtube-nocookie.com/embed/${VID}`,
      `https://www.youtube.com/shorts/${VID}`,
      `https://www.youtube.com/v/${VID}`,
      `www.youtube.com/watch?v=${VID}`,
      `youtu.be/${VID}`,
      `  https://WWW.YouTube.com/watch?v=${VID}  `,
    ];
    for (const c of cases) expect(okMedia(c), c).toEqual({ kind: "VIDEO", ref: VID });
  });

  it("[TV-1a] /live/<id> es LIVE (sin loop)", () => {
    expect(okMedia(`https://www.youtube.com/live/${VID}`)).toEqual({ kind: "LIVE", ref: VID });
    expect(okMedia(`https://m.youtube.com/live/${VID}?feature=share`)).toEqual({ kind: "LIVE", ref: VID });
  });

  it("[TV-1a] listas: playlist?list=, embed/videoseries y watch con list= válida", () => {
    expect(okMedia(`https://www.youtube.com/playlist?list=${PL}`)).toEqual({ kind: "PLAYLIST", ref: PL });
    expect(okMedia(`https://www.youtube.com/embed/videoseries?list=${PL}`)).toEqual({ kind: "PLAYLIST", ref: PL });
    expect(okMedia(`https://www.youtube.com/watch?v=${VID}&list=${PL}&index=3`)).toEqual({ kind: "PLAYLIST", ref: PL });
    expect(okMedia(`https://youtu.be/${VID}?list=${PL}`)).toEqual({ kind: "PLAYLIST", ref: PL });
    // Un mix automático (RD…) no cumple el CHECK: se queda con el video.
    expect(okMedia(`https://www.youtube.com/watch?v=${VID}&list=RD${VID}`)).toEqual({ kind: "VIDEO", ref: VID });
  });

  it("[TV-1a] vivo del canal: channel/UC…, channel/UC…/live y live_stream?channel=", () => {
    for (const c of [
      `https://www.youtube.com/channel/${UC}`,
      `https://www.youtube.com/channel/${UC}/live`,
      `https://www.youtube.com/channel/${UC}/streams`,
      `https://www.youtube.com/embed/live_stream?channel=${UC}`,
      `https://www.youtube.com/live_stream?channel=${UC}`,
    ]) {
      expect(okMedia(c), c).toEqual({ kind: "CHANNEL_LIVE", ref: UC });
    }
  });

  it("[TV-1a] @handle/live (y @handle, /c/, /user/) da el error con copy", () => {
    for (const c of [
      "https://www.youtube.com/@canal/live",
      "https://www.youtube.com/@canal",
      "https://www.youtube.com/c/Canal/live",
      "https://www.youtube.com/user/Canal",
    ]) {
      expect(parseYouTubeUrl(c), c).toEqual({ ok: false, error: HANDLE_ERR });
    }
  });

  it("[TV-1a] rechaza javascript:, data:, hosts ajenos, credenciales, puertos, >2048 e ids malformados", () => {
    const bad = [
      "",
      "   ",
      `javascript:alert(1)//youtube.com/watch?v=${VID}`,
      `JaVaScRiPt:alert('${VID}')`,
      `data:text/html,https://youtu.be/${VID}`,
      `ftp://www.youtube.com/watch?v=${VID}`,
      `https://evil.com/watch?v=${VID}`,
      `https://youtube.com.evil.com/watch?v=${VID}`,
      `https://notyoutube.com/watch?v=${VID}`,
      `https://www.youtube.com@evil.com/watch?v=${VID}`,
      `https://user:pass@www.youtube.com/watch?v=${VID}`,
      `https://www.youtube.com:8443/watch?v=${VID}`,
      `https://www.youtube.com/watch?v=${VID}x`,
      `https://www.youtube.com/watch?v=short`,
      `https://www.youtube.com/watch?v=${VID.slice(0, 10)}%22`,
      `https://www.youtube.com/watch`,
      `https://www.youtube.com/playlist?list=XX${"a".repeat(20)}`,
      `https://www.youtube.com/channel/UCshort`,
      `https://youtu.be/`,
      `https://www.youtube.com/watch?v=${VID}&` + "a".repeat(2048),
      "no es un link",
    ];
    for (const b of bad) {
      const r = parseYouTubeUrl(b);
      expect(r.ok, b.slice(0, 80)).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });

  it("[TV-1a] todo lo que acepta cumple MEDIA_REF_RE de su tipo", () => {
    for (const c of [
      `https://youtu.be/${VID}`,
      `https://www.youtube.com/live/${VID}`,
      `https://www.youtube.com/playlist?list=${PL}`,
      `https://www.youtube.com/channel/${UC}/live`,
    ]) {
      const m = okMedia(c);
      expect(MEDIA_REF_RE[m.kind].test(m.ref), c).toBe(true);
    }
  });
});

describe("[TV-1a] MEDIA_REF_RE ↔ CHECK ReceptionDisplay_media_check (M17)", () => {
  it("[TV-1a] las regex son literalmente las del SQL de la migración", () => {
    const sql = readFileSync(
      join(process.cwd(), "prisma/migrations/20261023120000_reception_displays/migration.sql"),
      "utf8",
    );
    const check = sql.slice(sql.indexOf('"ReceptionDisplay_media_check"'));
    const block = check.slice(0, check.indexOf("false))") + 1);
    const grab = (kindExpr: RegExp) => {
      const m = block.match(new RegExp(kindExpr.source + String.raw`\s+AND\s+"mediaRef"\s+~\s+'([^']+)'`));
      if (!m) throw new Error(`no encontré la regex para ${kindExpr}`);
      return m[1];
    };
    const videoLive = grab(/"mediaKind"\s+IN\s+\('VIDEO',\s*'LIVE'\)/);
    expect(MEDIA_REF_RE.VIDEO.source).toBe(videoLive);
    expect(MEDIA_REF_RE.LIVE.source).toBe(videoLive);
    expect(MEDIA_REF_RE.PLAYLIST.source).toBe(grab(/"mediaKind"\s+=\s+'PLAYLIST'/));
    expect(MEDIA_REF_RE.CHANNEL_LIVE.source).toBe(grab(/"mediaKind"\s+=\s+'CHANNEL_LIVE'/));
    // Sin flags: Postgres `~` es sensible a mayúsculas, igual que una RegExp sin `i`.
    for (const re of Object.values(MEDIA_REF_RE)) expect(re.flags).toBe("");
    // El SQL cubre exactamente estos cuatro tipos más NONE.
    expect(Object.keys(MEDIA_REF_RE).sort()).toEqual(["CHANNEL_LIVE", "LIVE", "PLAYLIST", "VIDEO"]);
  });
});

describe("[TV-1a] youtubeEmbedUrl", () => {
  const origin = "https://app.kinesoft.test";
  const common = {
    autoplay: "1",
    mute: "1",
    playsinline: "1",
    controls: "0",
    rel: "0",
    enablejsapi: "1",
    origin,
  };
  function parts(u: string | null) {
    expect(u).not.toBeNull();
    const url = new URL(u as string);
    return { host: url.host, path: url.pathname, q: Object.fromEntries(url.searchParams) };
  }

  it("[TV-1a] VIDEO: nocookie con loop=1&playlist=<id>", () => {
    const p = parts(youtubeEmbedUrl({ kind: "VIDEO", ref: VID }, { origin }));
    expect(p.host).toBe("www.youtube-nocookie.com");
    expect(p.path).toBe(`/embed/${VID}`);
    expect(p.q).toEqual({ ...common, loop: "1", playlist: VID });
  });

  it("[TV-1a] LIVE: sin loop", () => {
    const p = parts(youtubeEmbedUrl({ kind: "LIVE", ref: VID }, { origin }));
    expect(p.path).toBe(`/embed/${VID}`);
    expect(p.q).toEqual(common);
  });

  it("[TV-1a] PLAYLIST: videoseries?list=", () => {
    const p = parts(youtubeEmbedUrl({ kind: "PLAYLIST", ref: PL }, { origin }));
    expect(p.path).toBe("/embed/videoseries");
    expect(p.q).toEqual({ ...common, list: PL });
  });

  it("[TV-1a] CHANNEL_LIVE: live_stream?channel=", () => {
    const p = parts(youtubeEmbedUrl({ kind: "CHANNEL_LIVE", ref: UC }, { origin }));
    expect(p.path).toBe("/embed/live_stream");
    expect(p.q).toEqual({ ...common, channel: UC });
  });

  it("[TV-1a] origin se normaliza al origen (sin path) y se codifica", () => {
    const u = youtubeEmbedUrl({ kind: "LIVE", ref: VID }, { origin: "https://app.kinesoft.test/tv?x=1" }) as string;
    expect(new URL(u).searchParams.get("origin")).toBe("https://app.kinesoft.test");
    expect(u).toContain("origin=https%3A%2F%2Fapp.kinesoft.test");
  });

  it("[TV-1a] ref que no cumple el CHECK u origin no http(s) → null (nunca un iframe con basura)", () => {
    expect(youtubeEmbedUrl({ kind: "VIDEO", ref: `${VID}"><script>` }, { origin })).toBeNull();
    expect(youtubeEmbedUrl({ kind: "PLAYLIST", ref: VID }, { origin })).toBeNull();
    expect(youtubeEmbedUrl({ kind: "VIDEO", ref: VID }, { origin: "javascript:alert(1)" })).toBeNull();
    expect(youtubeEmbedUrl({ kind: "VIDEO", ref: VID }, { origin: "nada" })).toBeNull();
  });
});

describe("[TV-1a] mediaKindLabel", () => {
  it("[TV-1a] copy de cada tipo", () => {
    expect(mediaKindLabel("VIDEO")).toBe("Video · se repite");
    expect(mediaKindLabel("LIVE")).toBe("En vivo");
    expect(mediaKindLabel("PLAYLIST")).toBe("Lista");
    expect(mediaKindLabel("CHANNEL_LIVE")).toBe("En vivo del canal");
    expect(mediaKindLabel("NONE")).toBe("Sin video");
  });
});

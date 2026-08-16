import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ExerciseMediaType } from "@prisma/client";
import { getExercise } from "@/lib/exercises";
import { resolveMediaUrl } from "@/lib/exercise-media";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Markdown } from "@/components/ui/markdown";

export const dynamic = "force-dynamic";

/**
 * "Ejercicio completo" READER — a blogpost / multimedia long-form page for a
 * single exercise. Server Component: pulls the plan-gated exercise (with its
 * article + ordered media + condition links) and resolves each media item's
 * renderable URL server-side. Degrades gracefully to a rich exercise detail
 * when the article / media are empty.
 */
export default async function Page({ params }: { params: { slug: string } }) {
  const ex = await getExercise(params.slug);
  if (!ex) notFound();

  // Resolve every media row to a renderable src (embed URL / signed URL /
  // null in dev-stub). Keeps ordering; nulls fall back to a placeholder.
  const media: ResolvedMedia[] = await Promise.all(
    ex.media.map(async (m) => ({
      id: m.id,
      type: m.type,
      caption: m.caption,
      src: await resolveMediaUrl(m.type, m.url),
    })),
  );

  const title = ex.article?.title || ex.name;
  const subtitle = ex.article?.subtitle ?? null;
  const isManual = ex.kind === "MANUAL_THERAPY";
  const backHref = isManual ? "/terapia-manual" : "/biblioteca";
  const backLabel = isManual ? "Volver a Terapia Manual" : "Volver a Ejercicios";

  // Meta chips — skip any whose value is null.
  const chips: ReactNode[] = [<Tag key="lvl" tone="soft">Nivel {ex.difficulty}</Tag>];
  if (ex.defaultSets != null && ex.defaultReps != null) {
    chips.push(
      <Tag key="sr" tone="soft">
        {ex.defaultSets}×{ex.defaultReps}
      </Tag>,
    );
  } else if (ex.durationSeconds != null) {
    chips.push(
      <Tag key="dur" tone="soft">
        {ex.durationSeconds >= 60 ? `${Math.round(ex.durationSeconds / 60)} min` : `${ex.durationSeconds}s`}
      </Tag>,
    );
  }
  if (ex.article?.focus) chips.push(<Tag key="focus" tone="soft">Enfoque: {ex.article.focus}</Tag>);
  if (ex.article?.readingMinutes != null) {
    chips.push(<Tag key="read" tone="soft">{ex.article.readingMinutes} min de lectura</Tag>);
  }
  if (isManual) chips.push(<Tag key="man" tone="lime">Maniobra</Tag>);
  chips.push(
    <Tag key="basic" tone={ex.isBasic ? "soft" : "sky"}>
      {ex.isBasic ? "Común" : "Pro"}
    </Tag>,
  );

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>
      <Link
        href={backHref}
        style={{ fontSize: 13, fontWeight: 600, color: "var(--sky-700)", textDecoration: "none" }}
      >
        ← {backLabel}
      </Link>

      {/* 2. Header */}
      <header>
        <h1 className="k-display" style={{ fontSize: 32, lineHeight: 1.15, margin: 0, color: "var(--navy-900)" }}>
          {title}
        </h1>
        {subtitle && (
          <p style={{ fontSize: 16, lineHeight: 1.5, color: "var(--navy-500)", margin: "10px 0 0" }}>{subtitle}</p>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 14 }}>{chips}</div>
      </header>

      {/* 3. Media */}
      {media.length > 0 && (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <SectionLabel>Media</SectionLabel>
          {renderMediaBlocks(media)}
        </section>
      )}

      {/* 4. Article body */}
      {ex.article?.bodyMarkdown && (
        <article style={{ fontSize: 16, color: "var(--navy-700)" }}>
          <Markdown text={ex.article.bodyMarkdown} />
        </article>
      )}

      {/* 5. Descripción / Cues / Instrucciones */}
      {ex.description && (
        <LabeledCard label="Descripción">
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "var(--navy-700)" }}>{ex.description}</p>
        </LabeledCard>
      )}
      {ex.cues && (
        <LabeledCard label="Cues / coaching">
          <div style={{ fontSize: 14, color: "var(--navy-700)" }}>
            <Markdown text={ex.cues} />
          </div>
        </LabeledCard>
      )}
      {ex.instructions && (
        <LabeledCard label="Instrucciones">
          <div style={{ fontSize: 14, color: "var(--navy-700)" }}>
            <Markdown text={ex.instructions} />
          </div>
        </LabeledCard>
      )}

      {/* 6. Referencias */}
      {ex.article?.references && (
        <LabeledCard label="Referencias" muted>
          <div style={{ fontSize: 13.5, color: "var(--navy-500)" }}>
            <Markdown text={ex.article.references} />
          </div>
        </LabeledCard>
      )}

      {/* 7. Aparece en diagnósticos */}
      {ex.conditions.length > 0 && (
        <LabeledCard label="Aparece en diagnósticos">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {ex.conditions.map((c) => (
              <div
                key={c.conditionId + c.relation}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  padding: "8px 12px",
                  background: "rgba(255,255,255,0.6)",
                  borderRadius: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>{c.condition.name}</span>
                  <Tag tone={c.relation === "DIRECT" ? "sky" : "lime"}>{c.relation}</Tag>
                </div>
                {c.rationale && (
                  <span style={{ fontSize: 12, color: "var(--navy-500)", lineHeight: 1.5 }}>{c.rationale}</span>
                )}
              </div>
            ))}
          </div>
        </LabeledCard>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Media rendering
// ──────────────────────────────────────────────────────────────────────

type ResolvedMedia = {
  id: string;
  type: ExerciseMediaType;
  caption: string | null;
  src: string | null;
};

const captionStyle: CSSProperties = { fontSize: 12, color: "var(--navy-500)", margin: "6px 0 0", lineHeight: 1.5 };

function MediaPlaceholder() {
  return (
    <div
      style={{
        padding: "18px 14px",
        borderRadius: 12,
        background: "rgba(15,30,51,0.04)",
        color: "var(--navy-300)",
        fontSize: 12,
        textAlign: "center",
      }}
    >
      Media no disponible en este entorno
    </div>
  );
}

/**
 * Walk the ordered media list, coalescing consecutive IMAGE/GIF items into a
 * single expandable grid while VIDEO / YOUTUBE each render full-column. This
 * preserves the authored order and still yields a proper image gallery.
 */
function renderMediaBlocks(media: ResolvedMedia[]): ReactNode[] {
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < media.length) {
    const m = media[i];
    if (m.type === "IMAGE" || m.type === "GIF") {
      const group: ResolvedMedia[] = [];
      while (i < media.length && (media[i].type === "IMAGE" || media[i].type === "GIF")) {
        group.push(media[i]);
        i++;
      }
      blocks.push(
        <div
          key={`imgs-${group[0].id}`}
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}
        >
          {group.map((g) => (
            <figure key={g.id} style={{ margin: 0 }}>
              {g.src ? (
                <a href={g.src} target="_blank" rel="noopener noreferrer" style={{ display: "block" }}>
                  <Card style={{ padding: 6, overflow: "hidden" }}>
                    <img
                      src={g.src}
                      alt={g.caption ?? ""}
                      loading="lazy"
                      style={{ width: "100%", height: "auto", maxWidth: "100%", borderRadius: 8, display: "block" }}
                    />
                  </Card>
                </a>
              ) : (
                <MediaPlaceholder />
              )}
              {g.caption && <figcaption style={captionStyle}>{g.caption}</figcaption>}
            </figure>
          ))}
        </div>,
      );
      continue;
    }

    // VIDEO or YOUTUBE — full-column block.
    blocks.push(
      <figure key={m.id} style={{ margin: 0 }}>
        {m.src == null ? (
          <MediaPlaceholder />
        ) : m.type === "YOUTUBE" ? (
          <div
            style={{
              position: "relative",
              width: "100%",
              paddingBottom: "56.25%",
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            <iframe
              src={m.src}
              title={m.caption ?? "Video"}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
            />
          </div>
        ) : (
          <video
            controls
            preload="metadata"
            src={m.src}
            style={{ width: "100%", maxWidth: "100%", borderRadius: 12 }}
          />
        )}
        {m.caption && <figcaption style={captionStyle}>{m.caption}</figcaption>}
      </figure>,
    );
    i++;
  }
  return blocks;
}

// ──────────────────────────────────────────────────────────────────────
// Layout helpers
// ──────────────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--navy-300)",
      }}
    >
      {children}
    </div>
  );
}

function LabeledCard({ label, muted, children }: { label: string; muted?: boolean; children: ReactNode }) {
  return (
    <Card style={muted ? { padding: 18, background: "rgba(246,249,253,0.7)" } : { padding: 18 }}>
      <SectionLabel>{label}</SectionLabel>
      <div style={{ marginTop: 10 }}>{children}</div>
    </Card>
  );
}

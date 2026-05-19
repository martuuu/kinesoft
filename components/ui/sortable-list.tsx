"use client";

import { useState, type ReactNode } from "react";

/**
 * Minimal vertical drag-and-drop list using native HTML5 DnD.
 *
 * Zero dependencies. Each row has a drag handle on the left; grabbing
 * the handle reorders the row, dropping fires `onReorder(nextIds)`.
 *
 * `renderRow` is fully owned by the caller — that's where inline
 * editors live (sets/reps/notes/etc.). The list only manages order.
 */
export type SortableItem = { id: string };

export function SortableList<T extends SortableItem>({
  items,
  onReorder,
  renderRow,
  emptyLabel = "Sin elementos",
}: {
  items: T[];
  onReorder: (nextIds: string[]) => void;
  renderRow: (item: T, index: number) => ReactNode;
  emptyLabel?: string;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  if (items.length === 0) {
    return (
      <div
        style={{
          padding: 24,
          textAlign: "center",
          color: "var(--navy-300)",
          fontSize: 13,
          border: "1px dashed rgba(15,30,51,0.12)",
          borderRadius: 14,
        }}
      >
        {emptyLabel}
      </div>
    );
  }

  const reorder = (from: number, to: number) => {
    if (from === to) return;
    const next = items.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onReorder(next.map((x) => x.id));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((item, i) => {
        const isDragging = dragIndex === i;
        const isOver = overIndex === i && dragIndex !== null && dragIndex !== i;
        const dropAbove = isOver && (dragIndex ?? -1) > i;
        const dropBelow = isOver && (dragIndex ?? -1) < i;
        return (
          <div
            key={item.id}
            onDragOver={(e) => {
              if (dragIndex === null) return;
              e.preventDefault();
              setOverIndex(i);
            }}
            onDrop={(e) => {
              if (dragIndex === null) return;
              e.preventDefault();
              reorder(dragIndex, i);
              setDragIndex(null);
              setOverIndex(null);
            }}
            style={{
              position: "relative",
              borderTop: dropAbove ? "2px solid var(--sky-700)" : "2px solid transparent",
              borderBottom: dropBelow ? "2px solid var(--sky-700)" : "2px solid transparent",
              opacity: isDragging ? 0.4 : 1,
              transition: "opacity 120ms",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "stretch",
                gap: 10,
                padding: "8px 10px",
                borderRadius: 12,
                background: "rgba(255,255,255,0.72)",
                border: "1px solid rgba(15,30,51,0.06)",
              }}
            >
              <button
                type="button"
                draggable
                onDragStart={(e) => {
                  setDragIndex(i);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", item.id);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                aria-label="Reordenar"
                title="Arrastrá para reordenar"
                style={{
                  width: 22,
                  background: "transparent",
                  border: "none",
                  cursor: "grab",
                  color: "var(--navy-300)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  touchAction: "none",
                }}
              >
                ⋮⋮
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>{renderRow(item, i)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * VX-Z: el placeholder de `.k-input` era `--navy-300`, que sobre blanco no llega a 4.5:1 (AA para texto). Se pasó a
 * `--navy-400` (el de `.k-hint`). Este test lee el CSS real y calcula el contraste con el valor del token.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("app/globals.css", "utf8");

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe(".k-input::placeholder", () => {
  it("usa --navy-400 y llega a AA (4.5:1) sobre blanco", () => {
    const rule = /\.k-input::placeholder\s*\{\s*color:\s*var\((--[a-z0-9-]+)\);/.exec(css);
    expect(rule?.[1]).toBe("--navy-400");
    const hex = new RegExp(`${rule![1]}:\\s*(#[0-9a-fA-F]{6});`).exec(css)![1];
    const ratio = (1 + 0.05) / (luminance(hex) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});

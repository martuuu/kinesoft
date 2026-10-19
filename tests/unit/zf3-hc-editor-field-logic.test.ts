/**
 * [T4-Z ZF3] Alto compacto con autogrow (revisión b A1) y contador con anuncio por escalones («Composer (baja)»).
 * Lógica pura de `components/fichas/hc-editor-field-logic.ts` (el lado estático del editor, first load).
 */
import { describe, expect, it } from "vitest";
import {
  counterBucket,
  counterText,
  editorGrowMaxPx,
  editorHeightPx,
  textareaGrowHeight,
  type CounterCopy,
} from "@/components/fichas/hc-editor-field-logic";
import { HC_EDITOR_COPY } from "@/components/fichas/fichas-copy";

const COPY: CounterCopy = {
  counter: HC_EDITOR_COPY.counter,
  charsLeft: HC_EDITOR_COPY.charsLeft,
  overBy: (n) => `Te pasaste por ${n.toLocaleString("es-AR")} ${n === 1 ? "carácter" : "caracteres"}`,
};

describe("[T4-Z ZF3] alto del editor", () => {
  it("[T4-Z ZF3] alto de N líneas reales (24 px) + padding y borde; 4 filas = 122 px, 10 = 266 px", () => {
    expect(editorHeightPx(4)).toBe(122);
    expect(editorHeightPx(10)).toBe(266);
  });

  it("[T4-Z ZF3] solo el compacto (< 10 filas) crece, y hasta 10 líneas", () => {
    expect(editorGrowMaxPx(4)).toBe(266);
    expect(editorGrowMaxPx(10)).toBeNull();
    expect(editorGrowMaxPx(12)).toBeNull();
  });

  it("[T4-Z ZF3] autogrow: nunca baja de 4 filas, crece con el texto y a partir de 10 hace scroll adentro", () => {
    expect(textareaGrowHeight(60, 4)).toEqual({ height: 122, overflow: false });
    expect(textareaGrowHeight(170, 4)).toEqual({ height: 172, overflow: false });
    expect(textareaGrowHeight(264, 4)).toEqual({ height: 266, overflow: false });
    expect(textareaGrowHeight(900, 4)).toEqual({ height: 266, overflow: true });
  });
});

describe("[T4-Z ZF3] contador", () => {
  it("[T4-Z ZF3] lejos del tope «n / max»; desde 500 restantes «Te quedan …»; arriba «Te pasaste por …»", () => {
    expect(counterText(10, 20000, COPY)).toEqual({ text: "10 / 20.000", tone: "muted" });
    expect(counterText(19500, 20000, COPY)).toEqual({ text: "Te quedan 500 caracteres", tone: "warn" });
    expect(counterText(19999, 20000, COPY)).toEqual({ text: "Te quedan 1 carácter", tone: "warn" });
    expect(counterText(20001, 20000, COPY)).toEqual({ text: "Te pasaste por 1 carácter", tone: "danger" });
    expect(counterText(21500, 20000, COPY).text).toBe("Te pasaste por 1.500 caracteres");
  });

  it("[T4-Z ZF3] escalones del anuncio: nada lejos del tope, 500/250/100/50/0 y «over»", () => {
    expect(counterBucket(0, 20000)).toBeNull();
    expect(counterBucket(19499, 20000)).toBeNull();
    expect(counterBucket(19500, 20000)).toBe(500);
    expect(counterBucket(19600, 20000)).toBe(500);
    expect(counterBucket(19760, 20000)).toBe(250);
    expect(counterBucket(19900, 20000)).toBe(100);
    expect(counterBucket(19960, 20000)).toBe(50);
    expect(counterBucket(20000, 20000)).toBe(0);
    expect(counterBucket(20001, 20000)).toBe("over");
  });
});

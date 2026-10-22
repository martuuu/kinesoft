/**
 * [TP-P5] Ratchet de vocabulario de T5 (cobros online) · tabla literal de §25.10 + TP-UI-D1:
 *
 *   | seña | lo que se paga antes |  | pago | lo que hace el paciente |  | cobro | lo que registra el consultorio |
 *   | link de pago | nunca «cupón» ni «preferencia» |  | reintegro | nunca «reembolso» |
 *   | Mercado Pago | siempre completo |  | Secretaría | con tilde, como en la app |
 *
 * Por qué un ratchet y no solo una constante: T5 son ~38 sesiones en paralelo escribiendo copy (drawer, /cobros,
 * /pagar, turnero, Configuración, emails, campana). Sin un guard, cada una escribe «reembolso», «cupón», «MP» o
 * «preferencia» (la jerga de la API de Mercado Pago se filtra sola desde el código) y el paciente lee tres palabras para
 * lo mismo. Hallazgo 17 de §25.2: el webhook legado ya dice «revisá el reembolso».
 *
 * Dos alcances:
 *  1. **Global** (`app`, `components`, `lib`, `hooks`; código SIN comentarios): «reembolso/reembolsar» y «cupón» no
 *     aparecen en ningún lado salvo la allow-list EXACTA de abajo (el legado de `lib/mercadopago.ts`, intacto por
 *     AUDIT §5.4: «solo cambia el copy nuevo»). Si se barre una línea, se borra su entrada (así no vuelve).
 *  2. **Archivos de T5** (§25.12; se miran solo los que existen, porque las sesiones aterrizan en tandas): en los
 *     literales de string y el texto JSX tampoco van «preferencia», «enlace de pago», «Mercado pago»/«MercadoPago»,
 *     «MP» suelto (salvo el badge «Pagado MP» de TP-UI-D4) ni «Secretaria» sin tilde.
 *
 * Los comentarios no cuentan: ahí la jerga explica el código («la preferencia de MP vence con el link»).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import {
  BOOKING_MONEY_COPY,
  CHARGE_STATUS_LABEL,
  MONEY_BADGE_COPY,
  ONLINE_PAYMENTS_VOCAB,
  PAYMENT_LINK_COPY,
  defaultLinkConcept,
  missingMpAccountsNotice,
} from "@/lib/online-payments-copy";

const ROOT = process.cwd();
const rel = (abs: string) => relative(ROOT, abs).split(sep).join("/");
const SCAN_ROOTS = ["app", "components", "lib", "hooks"];
const SKIP_DIRS = new Set(["node_modules", ".next"]);
const EXTS = [".ts", ".tsx", ".mjs"];

// ── Lexer mínimo: separa comentarios, literales de string y código ──────────────────────────────────────────────────

type Lexed = { code: string; literals: { text: string; line: number }[] };

/**
 * Recorre TS/TSX y devuelve el código con los comentarios en blanco (conserva los saltos de línea, así los números de
 * línea siguen valiendo) más el contenido de cada literal ('…', "…", `…` sin las interpolaciones). Las regex literales
 * se detectan por el carácter anterior (heurística suficiente para este repo: el guard no compila código, busca
 * palabras).
 */
function lexSource(src: string): Lexed {
  let out = "";
  const literals: Lexed["literals"] = [];
  let line = 1;
  let i = 0;
  const n = src.length;
  /** Profundidad de llaves dentro de cada `${…}` abierto: el `}` que la deja en -1 reabre el template. */
  const tplStack: number[] = [];
  let lastSignificant = "";

  /** Lee el cuerpo de un template desde `i` (ya pasada la comilla o el `}` de una interpolación). */
  const readTemplateRest = (): void => {
    const startLine = line;
    let text = "";
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        text += src.slice(i, i + 2);
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        literals.push({ text, line: startLine });
        out += "${";
        i += 2;
        tplStack.push(0);
        return;
      }
      if (c === "`") {
        out += c;
        i++;
        literals.push({ text, line: startLine });
        return;
      }
      if (c === "\n") line++;
      text += c;
      out += c;
      i++;
    }
    literals.push({ text, line: startLine });
  };

  /** Lee un string de comillas simples o dobles desde la comilla de apertura. */
  const readQuoted = (quote: string): void => {
    const startLine = line;
    let text = "";
    out += quote;
    i++;
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        text += src.slice(i, i + 2);
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === quote || c === "\n") break; // un salto de línea sin cerrar no debería pasar: se corta ahí
      text += c;
      out += c;
      i++;
    }
    if (src[i] === quote) {
      out += quote;
      i++;
    }
    literals.push({ text, line: startLine });
  };

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") {
          out += "\n";
          line++;
        } else out += " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === "\n") {
      out += c;
      line++;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      readQuoted(c);
      lastSignificant = c;
      continue;
    }
    if (c === "`") {
      out += c;
      i++;
      readTemplateRest();
      lastSignificant = c;
      continue;
    }
    if (c === "/" && (lastSignificant === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSignificant))) {
      // Regex literal: se copia tal cual hasta la `/` de cierre fuera de una clase `[…]`.
      out += c;
      i++;
      let inClass = false;
      while (i < n && src[i] !== "\n") {
        const r = src[i];
        out += r;
        i++;
        if (r === "\\") {
          out += src[i] ?? "";
          i++;
          continue;
        }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
      }
      // Una regex cierra una expresión: la próxima `/` es división.
      lastSignificant = ")";
      continue;
    }
    if (tplStack.length > 0 && c === "{") tplStack[tplStack.length - 1]++;
    if (tplStack.length > 0 && c === "}") {
      if (tplStack[tplStack.length - 1] === 0) {
        tplStack.pop();
        out += c;
        i++;
        readTemplateRest();
        lastSignificant = "`";
        continue;
      }
      tplStack[tplStack.length - 1]--;
    }
    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return { code: out, literals };
}

/** Texto JSX: lo que queda entre `>` y `<` en el código sin comentarios (heurística; sobra para buscar palabras). */
function jsxTexts(code: string): { text: string; line: number }[] {
  const res: { text: string; line: number }[] = [];
  const re = />([^<>{}"'`]*[A-Za-zÁÉÍÓÚáéíóúñÑ][^<>{}"'`]*)</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    res.push({ text: m[1], line: code.slice(0, m.index).split("\n").length });
  }
  return res;
}

// ── Reglas ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Alcance global: palabras que no van en ningún copy (código sin comentarios). */
const GLOBAL_FORBIDDEN: { id: string; re: RegExp }[] = [
  { id: "reembolso (es «reintegro»)", re: /reembols/i },
  { id: "cupón (es «link de pago»)", re: /cup[oó]n/i },
];

/** Alcance T5: en literales y texto JSX de los archivos de T5. */
const T5_FORBIDDEN: { id: string; re: RegExp }[] = [
  ...GLOBAL_FORBIDDEN,
  { id: "preferencia (es «link de pago»)", re: /preferencia/i },
  { id: "enlace de pago (es «link de pago», TP-UI-D1)", re: /enlace de pago/i },
  { id: "Mercado Pago incompleto o pegado", re: /Mercado\s?pago|MercadoPago|Mercadopago|MERCADOPAGO|Mercado Pag\b/ },
  // «MP» suelto en copy. `\b` no corta en `MP_CONNECT_MODE` (el `_` es carácter de palabra) ni en `mp` minúscula de
  // rutas e ids. Única excepción literal: el badge «Pagado MP» de TP-UI-D4.
  { id: "«MP» suelto (es «Mercado Pago»)", re: /\bMP\b/ },
  { id: "Secretaria sin tilde (es «Secretaría»)", re: /\b[Ss]ecretaria\b/ },
];

/** Literales que contienen una palabra «prohibida» a propósito (exactos). */
const T5_LITERAL_OK = new Set<string>(["Pagado MP"]);

function violationsIn(
  src: string,
  rules: { id: string; re: RegExp }[],
  scope: "code" | "copy",
): { id: string; line: number; text: string }[] {
  const lexed = lexSource(src);
  const found: { id: string; line: number; text: string }[] = [];
  if (scope === "code") {
    lexed.code.split("\n").forEach((ln, idx) => {
      for (const r of rules) if (r.re.test(ln)) found.push({ id: r.id, line: idx + 1, text: ln.trim() });
    });
    return found;
  }
  for (const piece of [...lexed.literals, ...jsxTexts(lexed.code)]) {
    if (T5_LITERAL_OK.has(piece.text.trim())) continue;
    for (const r of rules) if (r.re.test(piece.text)) found.push({ id: r.id, line: piece.line, text: piece.text.trim() });
  }
  return found;
}

/**
 * Allow-list EXACTA del alcance global: archivo → líneas recortadas. El legado de MP (AUDIT §5.4) conserva su texto;
 * no puede aparecer una nueva ni sobrar una vieja.
 */
const GLOBAL_ALLOW: Record<string, string[]> = {
  "lib/mercadopago.ts": [
    "body = `${booking.service.name} · ${who}. El turno ya estaba pagado: revisá el reembolso.`;",
    "body = `${booking.service.name} · ${who}. El turno no se reactivó: revisá si corresponde reembolsar.`;",
  ],
};

/**
 * Archivos de T5 (§25.12, los nuevos con `*`): por basename (las sesiones de UI pueden ubicarlos en una subcarpeta
 * distinta de la del brief) y por carpeta entera para los módulos nuevos. Los que no existen todavía se saltean.
 */
const T5_BASENAMES = new Set<string>([
  "online-payments-copy.ts",
  "mp-receipt.ts",
  "booking-money-view.ts",
  "online-charge-logic.ts",
  "secret-box.ts",
  "online-payments-types.ts",
  "mp-connect-types.ts",
  "payment-links-types.ts",
  "booking-payment-policy-types.ts",
  "mp-connect-actions.ts",
  "booking-payment-policy.ts",
  "payment-links.ts",
  "payment-links-internal.ts",
  "public-payment-link.ts",
  "online-charges-read.ts",
  "booking-copago-internal.ts",
  "public-booking-charge-internal.ts",
  "online-payments-panel.tsx",
  "my-mp-panel.tsx",
  "clinic-mp-account-card.tsx",
  "booking-money-section.tsx",
  "payment-link-drawer.tsx",
  "payment-link-share.tsx",
  "mp-receipt-view.tsx",
  "payments-ui-types.ts",
  "patient-links-list.tsx",
  "payment-link-form.ts",
  "cobros-view.ts",
  "payment-choice.tsx",
  "pay-link-view.tsx",
  "pay-link-poller.tsx",
  "templates-payments.ts",
]);
const T5_DIRS = ["lib/mp-connect/", "app/api/mp/", "components/payments/", "components/cobros/", "app/(app)/cobros/", "app/(booking)/pagar/"];

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (EXTS.some((e) => p.endsWith(e))) acc.push(p);
  }
  return acc;
}

const ALL_FILES = SCAN_ROOTS.flatMap((r) => walk(join(ROOT, r)));
const T5_FILES = ALL_FILES.filter((abs) => {
  const r = rel(abs);
  return T5_BASENAMES.has(basename(r)) || T5_DIRS.some((d) => r.startsWith(d)) || /^lib\/email\/templates-payments/.test(r);
});

describe("[TP-P5] ratchet de copy sin «reembolso» ni «cupón»", () => {
  it("el detector ve la palabra en un literal y la ignora en un comentario (anti-false-green)", () => {
    const src = [
      "// la preferencia vence; revisá el reembolso",
      "/* cupón en un comentario */",
      'const a = "Revisá el reembolso";',
      "const b = `Tu cupón ${x} de MP`;",
      "const c = <p>Enlace de pago para la Secretaria</p>;",
      'const d = "Pagado MP";',
      "const e = /reembolso/.test(s) ? 1 : 2;",
      'const f = process.env.MP_CONNECT_MODE ?? "/api/webhooks/mercadopago";',
    ].join("\n");
    const code = violationsIn(src, GLOBAL_FORBIDDEN, "code");
    expect(code.map((v) => v.line)).toEqual([3, 4, 7]);
    const copy = violationsIn(src, T5_FORBIDDEN, "copy").map((v) => `${v.line}:${v.id}`);
    expect(copy).toContain("3:reembolso (es «reintegro»)");
    expect(copy).toContain("4:cupón (es «link de pago»)");
    expect(copy).toContain("4:«MP» suelto (es «Mercado Pago»)");
    expect(copy).toContain("5:enlace de pago (es «link de pago», TP-UI-D1)");
    expect(copy).toContain("5:Secretaria sin tilde (es «Secretaría»)");
    expect(copy.some((v) => v.startsWith("1:") || v.startsWith("2:") || v.startsWith("6:") || v.startsWith("8:"))).toBe(false);
  });

  it("global: «reembolso» y «cupón» solo en la allow-list exacta del legado", () => {
    const seen: Record<string, string[]> = {};
    for (const abs of ALL_FILES) {
      const v = violationsIn(readFileSync(abs, "utf8"), GLOBAL_FORBIDDEN, "code");
      if (v.length) seen[rel(abs)] = v.map((x) => x.text);
    }
    expect(seen).toEqual(GLOBAL_ALLOW);
  });

  it("archivos de T5 (los que existen): vocabulario de §25.10 en literales y texto JSX", () => {
    expect(T5_FILES.map(rel)).toContain("lib/online-payments-copy.ts");
    const bad: string[] = [];
    for (const abs of T5_FILES) {
      for (const v of violationsIn(readFileSync(abs, "utf8"), T5_FORBIDDEN, "copy")) {
        bad.push(`${rel(abs)}:${v.line} ${v.id} → «${v.text}»`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("[TP-P5] copy de T5", () => {
  it("vocabulario de la tabla de §25.10", () => {
    expect(ONLINE_PAYMENTS_VOCAB).toEqual({
      deposit: "seña",
      payment: "pago",
      charge: "cobro",
      paymentLink: "link de pago",
      refund: "reintegro",
      mercadoPago: "Mercado Pago",
      secretary: "Secretaría",
    });
  });

  it("estados del cobro y textos del turno", () => {
    expect(CHARGE_STATUS_LABEL).toEqual({
      ACTIVE: "Pendiente de pago",
      AUTHORIZED: "En proceso",
      PAID: "Pagado",
      REFUNDED: "Reintegrado",
      EXPIRED: "Vencido",
      CANCELLED: "Anulado",
    });
    expect(MONEY_BADGE_COPY.deposit.label).toBe("Seña");
    expect(MONEY_BADGE_COPY.paidMp.label).toBe("Pagado MP");
    expect(BOOKING_MONEY_COPY.paidOnline).toBe("Pagado por Mercado Pago");
    expect(BOOKING_MONEY_COPY.refundedOnline).toBe("Reintegrado por Mercado Pago");
  });

  it("copy literal de C-TP9", () => {
    expect(PAYMENT_LINK_COPY.notDelegated("Ana")).toBe("Ana no autorizó links de pago a su Mercado Pago.");
    expect(PAYMENT_LINK_COPY.conceptWarning).toBe(
      "No pongas datos clínicos en el concepto: lo ven el paciente y Mercado Pago.",
    );
    expect(PAYMENT_LINK_COPY.liveLinkExists).toBe(
      "Ya hay un link de pago activo para este turno: anulalo antes de generar otro.",
    );
  });

  it("concepto por default (TP-UI-D12) en hora AR y aviso de profesionales sin cuenta", () => {
    // lun 19/10/2026 10:00 AR = 13:00 UTC (el ejemplo de TP-UI-D12, «lun 20/10», es de 2025).
    expect(defaultLinkConcept("2026-10-19T13:00:00.000Z")).toBe("Turno del lun 19/10 a las 10:00");
    // 23:30 AR del martes 20/10 = 02:30 UTC del miércoles 21: el concepto sigue diciendo martes 20/10.
    expect(defaultLinkConcept(new Date("2026-10-21T02:30:00.000Z"))).toBe("Turno del mar 20/10 a las 23:30");
    expect(missingMpAccountsNotice(1)).toBe("1 profesional sin Mercado Pago conectado");
    expect(missingMpAccountsNotice(3)).toBe("3 profesionales sin Mercado Pago conectado");
  });
});

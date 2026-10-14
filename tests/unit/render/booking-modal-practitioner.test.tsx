import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// IAM-4b — profesional del turno nuevo cuando el usuario no atiende
// (Secretaria / Facturación: `Actor.practitionerId` null desde IAM-4a). Sin
// filtro de chips, `defaultPractitionerId` llega null y el modal caía en
// silencio al PRIMERO de la lista: la Secretaria le cargaba el turno a
// cualquiera. Ahora, con más de un profesional, obliga a elegir. Render real
// (sin jsdom, como el resto de `tests/unit/render`); se mockean solo las
// server actions y los hooks de toast/confirm (mismo set que
// booking-modal-room.test.tsx).
const { proxy } = vi.hoisted(() => ({
  proxy: () =>
    new Proxy(
      {},
      {
        get: (_t: object, k: string | symbol) =>
          k === "__esModule" ? true : k === "then" ? undefined : async () => ({ ok: true, data: {} }),
      }
    ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/lib/bookings", () => proxy());
vi.mock("@/lib/plans-move", () => proxy());
vi.mock("@/lib/plans-read", () => proxy());
vi.mock("@/lib/plans-adopt", () => proxy());
vi.mock("@/lib/plans-edit", () => proxy());
vi.mock("@/lib/sessions", () => proxy());
vi.mock("@/lib/patients", () => proxy());
vi.mock("@/lib/diagnosis", () => proxy());
vi.mock("@/lib/availability-actions", () => proxy());
vi.mock("@/lib/time-blocks", () => proxy());
vi.mock("@/lib/session", () => proxy());

import { BookingModal } from "@/components/agenda/booking-modal";
import { initialPractitionerId, NO_BOOKABLE_PRACTITIONERS_COPY } from "@/components/agenda/booking-modal/service-section";
import { capabilitiesFor } from "@/lib/capabilities";

const ASSISTANT = [...capabilitiesFor("ASSISTANT")];
const TWO = [
  { id: "p1", name: "Ana Pérez" },
  { id: "p2", name: "Beto Ruiz" },
];

const base = {
  services: [{ id: "s1", name: "Kinesio", durationMin: 45, priceCents: 0, color: null }],
  patients: [{ id: "pt1", name: "Juana Gómez" }],
  insurers: [],
  onClose: () => {},
  onSaved: () => {},
  defaultISO: "2026-10-05T12:00:00.000Z",
  capabilities: ASSISTANT,
};

/** Value del `<option … selected>` del select `name` (React marca el elegido con `selected=""`). */
const selectedValue = (html: string, name: string) => {
  const sel = html.match(new RegExp(`<select name="${name}"[^>]*>([\\s\\S]*?)</select>`))?.[1] ?? "";
  return sel.match(/<option[^>]*value="([^"]*)"[^>]*selected=""/)?.[1] ?? null;
};

describe("[IAM-4b] initialPractitionerId", () => {
  it("el default si es de la lista; si no, el único; si hay varios, ninguno (obliga a elegir)", () => {
    expect(initialPractitionerId("p2", TWO)).toBe("p2");
    expect(initialPractitionerId(null, TWO)).toBe("");
    expect(initialPractitionerId(undefined, TWO)).toBe("");
    // Un id que no está (p. ej. la columna «Otros» o un profesional que dejó de ser reservable).
    expect(initialPractitionerId("secretaria", TWO)).toBe("");
    expect(initialPractitionerId(null, [TWO[0]])).toBe("p1");
    expect(initialPractitionerId(null, [])).toBe("");
  });
});

describe("[IAM-4b] modal de turno nuevo sin profesional por defecto", () => {
  it("con varios profesionales y sin default, el select arranca en «Elegí un profesional» (no en el primero)", () => {
    const html = renderToStaticMarkup(<BookingModal {...base} practitioners={TWO} defaultPractitionerId={null} />);
    expect(selectedValue(html, "practitionerId")).toBe("");
    expect(html).toContain("Elegí un profesional");
    // Sin profesional no se piden horarios libres.
    expect(html).toContain("Elegí el profesional y el servicio para ver los horarios libres.");
  });

  it("con default (filtro o profesional del usuario) queda ese, sin placeholder", () => {
    const html = renderToStaticMarkup(<BookingModal {...base} practitioners={TWO} defaultPractitionerId="p2" />);
    expect(selectedValue(html, "practitionerId")).toBe("p2");
    expect(html).not.toContain("Elegí un profesional");
  });

  it("con un solo profesional no hay nada que elegir: queda ese", () => {
    const html = renderToStaticMarkup(<BookingModal {...base} practitioners={[TWO[0]]} defaultPractitionerId={null} />);
    expect(selectedValue(html, "practitionerId")).toBe("p1");
  });

  it("sin profesionales reservables, mensaje claro", () => {
    const html = renderToStaticMarkup(<BookingModal {...base} practitioners={[]} defaultPractitionerId={null} />);
    expect(html).toContain(NO_BOOKABLE_PRACTITIONERS_COPY);
  });
});

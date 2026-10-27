import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [LG-U] La actividad de seguridad de la cuenta nombra el evento `legal.accepted` (lo escribe LG-S en el alta, el
 * onboarding y las invitaciones). Sin la etiqueta caía en el genérico «Cambio de seguridad». Render real; se mockean
 * solo las server actions (red) y el router, como `plz-fx4-account.test.tsx`.
 */
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
vi.mock("next/navigation", () => ({
  usePathname: () => "/cuenta/seguridad",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/lib/two-factor", () => proxy());

import { SecuritySettings } from "@/components/account/security-settings";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";

describe("[LG-U] actividad de seguridad", () => {
  it("«Aceptaste los Términos y la Política de privacidad» para `legal.accepted`", () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <ConfirmProvider>
          <SecuritySettings
            overview={{
              methods: { totp: false, email: false },
              updatedAt: null,
              recoveryCodesLeft: 0,
              events: [{ id: "e1", kind: "legal.accepted", createdAt: "2026-10-31T15:00:00.000Z", ip: null }],
            }}
            emailMasked="m***@x.test"
            backHref="/dashboard"
          />
        </ConfirmProvider>
      </ToastProvider>
    );
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Aceptaste los Términos y la Política de privacidad");
    expect(text).not.toContain("Cambio de seguridad");
  });
});

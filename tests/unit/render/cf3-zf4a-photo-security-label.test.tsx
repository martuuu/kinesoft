import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [CF3-ZF4a7] La actividad de seguridad de la cuenta nombra los eventos de la foto (`photo.updated` / `photo.removed`,
 * los escribe `writeOwnPhotoInTx` de lib/user-photo-internal.ts). Sin la etiqueta caían en el genérico «Cambio de
 * seguridad». Render real; se mockean solo las server actions (red) y el router, como `lg-u-security-label.test.tsx`.
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

describe("[CF3-ZF4a7] actividad de seguridad · foto", () => {
  it("«Cambiaste tu foto» para `photo.updated` y «Borraste tu foto» para `photo.removed`", () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <ConfirmProvider>
          <SecuritySettings
            overview={{
              methods: { totp: false, email: false },
              updatedAt: null,
              recoveryCodesLeft: 0,
              events: [
                { id: "e1", kind: "photo.updated", createdAt: "2026-11-05T15:00:00.000Z", ip: null },
                { id: "e2", kind: "photo.removed", createdAt: "2026-11-05T16:00:00.000Z", ip: null },
              ],
            }}
            emailMasked="m***@x.test"
            backHref="/dashboard"
          />
        </ConfirmProvider>
      </ToastProvider>
    );
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Cambiaste tu foto");
    expect(text).toContain("Borraste tu foto");
    expect(text).not.toContain("Cambio de seguridad");
  });
});

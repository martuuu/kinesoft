/**
 * [FC-3g] `BackupSetup` (§24.6, FC-D13): aviso de datos de salud, casilla OBLIGATORIA «Esta computadora la uso solo
 * yo» (sin tildar, «Elegir carpeta» deshabilitado), estados y el mensaje de descarga fuera de Chromium.
 * `renderToStaticMarkup` en node: sin efectos, así que el primer render es «Revisando…» y los estados se prueban en la
 * vista presentacional.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BackupSetup, BackupSetupView, type BackupSetupViewProps } from "@/components/fichas/backup-setup";
import { BACKUP_COPY } from "@/components/fichas/fichas-copy";

const noop = () => {};
const view = (p: Partial<BackupSetupViewProps>) =>
  renderToStaticMarkup(
    <BackupSetupView
      variant="dialog"
      phase="unconfigured"
      folderName={null}
      soloUser={false}
      busy={false}
      error={null}
      onSoloUserChange={noop}
      onChoose={noop}
      onGrant={noop}
      onForget={noop}
      {...p}
    />
  );
const chooseButton = (html: string, label: string) => new RegExp(`<button[^>]*>${label}</button>`).exec(html)?.[0] ?? "";
const esc = (s: string) => s.replace(/"/g, "&quot;");

describe("[FC-3g] BackupSetup", () => {
  it("primer render (SSR / antes de detectar): «Revisando…», sin ofrecer la carpeta", () => {
    const html = renderToStaticMarkup(<BackupSetup scope={{ tenantId: "t", userId: "u" }} variant="panel" />);
    expect(html).toContain(BACKUP_COPY.checking);
    expect(html).toContain(BACKUP_COPY.title);
    expect(html).not.toContain(BACKUP_COPY.choose);
  });

  it("fuera de Chrome/Edge de escritorio: dice que se descarga y no ofrece elegir", () => {
    const html = view({ phase: "unsupported", onClose: noop });
    expect(html).toContain(esc(BACKUP_COPY.unsupported));
    expect(html).not.toContain(BACKUP_COPY.choose);
    expect(html).not.toContain(BACKUP_COPY.soloUser);
    expect(html).toContain(BACKUP_COPY.close);
  });

  it("sin carpeta: aviso de datos de salud + casilla destildada → «Elegir carpeta» habilitado (el click explica la casilla)", () => {
    const html = view({});
    expect(html).toContain(esc(BACKUP_COPY.soloUserHint));
    expect(html).toMatch(/<input[^>]*type="checkbox"(?![^>]*checked)[^>]*>/);
    expect(html).toContain(BACKUP_COPY.soloUser);
    // T4-Z: habilitado; sin la casilla, el click muestra `soloUserRequired` (el contenedor no llama al selector).
    expect(chooseButton(html, BACKUP_COPY.choose)).not.toContain("disabled");
    expect(view({ error: BACKUP_COPY.soloUserRequired })).toContain(BACKUP_COPY.soloUserRequired);
  });

  it("con la casilla tildada se habilita; con carpeta, «Cambiar» y «Dejar de usar»", () => {
    expect(chooseButton(view({ soloUser: true }), BACKUP_COPY.choose)).not.toContain("disabled");
    const ready = view({ phase: "ready", folderName: "Respaldo HC", soloUser: true });
    expect(ready).toContain(BACKUP_COPY.ready("Respaldo HC"));
    expect(chooseButton(ready, BACKUP_COPY.change)).not.toContain("disabled");
    expect(ready).toContain(BACKUP_COPY.forget);
  });

  it("permiso caducado: lo explica y ofrece darlo ahora", () => {
    const html = view({ phase: "needs-permission", folderName: "Respaldo HC" });
    expect(html).toContain(esc(BACKUP_COPY.needsPermission));
    expect(html).toContain(BACKUP_COPY.grant);
  });
});

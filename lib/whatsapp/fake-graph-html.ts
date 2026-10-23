/**
 * WA-P3 (T6, C-WA5, brief §26.5) · HTML del simulador de Meta: el popup del Embedded Signup y el panel. Funciones puras
 * (reciben la vista, devuelven el string) para que `tests/unit/wa-p3-fake.test.ts` pruebe el copy y el escapado sin
 * levantar el router. Mismo criterio que el simulador de MP (TP-UI-D10): 0 kB de bundle, estilo inline, banner
 * amarillo arriba de todo para que nadie lo confunda con Meta real, botones de 44 px y foco visible.
 *
 * Nada de teléfonos enteros en el HTML: los destinatarios salen enmascarados (`toMasked`) y el panel elige a quién
 * «responde» el paciente por el id del mensaje, no por el número.
 */

export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** JSON para meter adentro de un `<script>`: `<` escapado para que un `</script>` en un valor no corte el bloque. */
function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export const FAKE_META_TITLE = "Simulador de Meta (solo desarrollo)";

const BANNER =
  `<div class="banner"><strong>${FAKE_META_TITLE}</strong>` +
  "<p>Nada de esto toca Meta ni WhatsApp real. Los avisos vuelven por el webhook de verdad, firmados con el secreto de prueba.</p></div>";

const STYLE = `
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:720px;margin:0 auto;padding:16px;color:#0f1f33;background:#f6f8fb;line-height:1.4}
.banner{background:#fff4d6;border:1px solid #e8c766;border-radius:8px;padding:12px;margin-bottom:16px}.banner p{margin:4px 0 0;font-size:14px}
h1{font-size:20px;margin:8px 0 12px;overflow-wrap:anywhere}h2{font-size:16px;margin:20px 0 8px}
form{margin:8px 0;display:inline-block}p{margin:8px 0}
button{min-height:44px;padding:0 16px;font-size:15px;border-radius:8px;border:1px solid #9fb3c8;background:#fff;color:#0f1f33;cursor:pointer;max-width:100%}
button.primary{background:#25d366;border-color:#1da851;color:#0f1f33}button:disabled{opacity:.5;cursor:not-allowed}
:focus-visible{outline:3px solid #0f1f33;outline-offset:2px}
.card{background:#fff;border:1px solid #dde4ec;border-radius:8px;padding:12px;margin:12px 0}.muted{color:#5b6b7d;font-size:14px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:end}
label{display:grid;gap:4px;font-size:14px}
input,select{min-height:44px;font-size:15px;padding:0 8px;border:1px solid #9fb3c8;border-radius:6px;max-width:100%}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid #dde4ec;padding:6px 4px;text-align:left;vertical-align:top}
.flash{background:#e7f6ec;border:1px solid #9bd3ad;border-radius:8px;padding:8px 12px}
.err{background:#fdecec;border:1px solid #e8a0a0;border-radius:8px;padding:8px 12px}
@media (prefers-reduced-motion:no-preference){button{transition:background-color .15s}}
`;

export function fakeMetaPage(title: string, body: string): string {
  return `<!doctype html><html lang="es-AR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><header>${BANNER}</header><main>${body}</main></body></html>`;
}

// ── Popup del Embedded Signup ──────────────────────────────────────────────────────────────────────────────────

export type FakeSignupGrant = "both" | "management_only" | "messaging_only" | "other_waba";

export const FAKE_SIGNUP_GRANTS: { value: FakeSignupGrant; label: string }[] = [
  { value: "both", label: "Los dos permisos sobre la cuenta nueva (lo normal)" },
  { value: "management_only", label: "Solo administración (falta el de mensajes)" },
  { value: "messaging_only", label: "Solo mensajes (falta el de administración)" },
  { value: "other_waba", label: "Permisos sobre OTRA cuenta de WhatsApp Business" },
];

export function signupPageHtml(v: { action: string; appId: string; configId: string; error?: string | null }): string {
  if (v.error) {
    return fakeMetaPage(
      "Alta de WhatsApp · simulador",
      `<h1>No se puede abrir el alta</h1><p class="err">${esc(v.error)}</p>`
    );
  }
  const grants = FAKE_SIGNUP_GRANTS.map(
    (g, i) => `<label><span><input type="radio" name="grant" value="${esc(g.value)}"${i === 0 ? " checked" : ""}> ${esc(g.label)}</span></label>`
  ).join("");
  return fakeMetaPage(
    "Alta de WhatsApp · simulador",
    `<h1>Conectar un número de WhatsApp</h1>
<p class="muted">Así se ve, simplificado, el alta de Meta: el consultorio elige su cuenta de WhatsApp Business y su número. Acá se crean una cuenta y un número de prueba.</p>
<div class="card"><form method="post" action="${esc(v.action)}">
<input type="hidden" name="app_id" value="${esc(v.appId)}"><input type="hidden" name="config_id" value="${esc(v.configId)}">
<fieldset style="border:0;padding:0;margin:0 0 12px"><legend>Permisos que concede</legend>${grants}</fieldset>
<div class="row"><button class="primary" type="submit" name="decision" value="finish">Conectar número de prueba</button>
<button type="submit" name="decision" value="cancel">Cancelar</button></div></form></div>`
  );
}

/**
 * Cierre del popup: `postMessage` al opener con la forma de Meta (`{type:"WA_EMBEDDED_SIGNUP", event, data}`, como
 * string JSON, que es como lo manda Meta) y, solo en el simulador, el `code` en el mismo mensaje (en Meta real llega por
 * el callback de `FB.login`). `targetOrigin` = el origen de la app: el mensaje no le llega a otra ventana.
 */
export function signupDoneHtml(v: { message: Record<string, unknown>; targetOrigin: string; cancelled: boolean }): string {
  const script = `<script>(function(){var m=${scriptJson(JSON.stringify(v.message))};var o=${scriptJson(v.targetOrigin)};try{if(window.opener){window.opener.postMessage(m,o);setTimeout(function(){window.close()},400);}}catch(e){}})();</script>`;
  const text = v.cancelled
    ? "<h1>Alta cancelada</h1><p>Podés cerrar esta ventana.</p>"
    : "<h1>Número conectado en el simulador</h1><p>Se avisó a la ventana de Configuración. Si no se cierra sola, cerrala.</p>";
  return fakeMetaPage("Alta de WhatsApp · simulador", `${text}${script}`);
}

// ── Panel ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type FakePanelView = {
  base: string;
  flash: string | null;
  approval: "auto" | "manual";
  autoStatuses: boolean;
  wabas: {
    id: string;
    subscribed: boolean;
    phones: { id: string; displayPhone: string; qualityRating: string; registered: boolean }[];
    templates: { name: string; language: string; status: string }[];
  }[];
  messages: { wamid: string; toMasked: string; label: string; status: string; hasButtons: boolean }[];
  hooks: { at: string; field: string; status: number; result: string | null }[];
};

const QUALITY_EVENTS = [
  { value: "FLAGGED", label: "Calidad baja (FLAGGED)" },
  { value: "UNFLAGGED", label: "Calidad recuperada (UNFLAGGED)" },
  { value: "DOWNGRADE", label: "Baja de límite (DOWNGRADE)" },
];

function postForm(base: string, action: string, fields: Record<string, string>, label: string, cls = ""): string {
  const hidden = Object.entries(fields)
    .map(([k, val]) => `<input type="hidden" name="${esc(k)}" value="${esc(val)}">`)
    .join("");
  return `<form method="post" action="${esc(`${base}/panel/${action}`)}">${hidden}<button type="submit"${cls ? ` class="${cls}"` : ""}>${esc(label)}</button></form>`;
}

export function panelHtml(v: FakePanelView): string {
  const b = v.base;
  const flash = v.flash ? `<p class="flash" role="status">${esc(v.flash)}</p>` : "";

  const accounts = v.wabas.length
    ? v.wabas
        .map((w) => {
          const phones = w.phones
            .map(
              (p) => `<div class="row"><span>Número ${esc(p.displayPhone)} · calidad ${esc(p.qualityRating)}${p.registered ? "" : " · sin registrar"}</span>
<form method="post" action="${esc(`${b}/panel/quality`)}"><input type="hidden" name="phone_number_id" value="${esc(p.id)}">
<label>Calidad<select name="event">${QUALITY_EVENTS.map((q) => `<option value="${esc(q.value)}">${esc(q.label)}</option>`).join("")}</select></label>
<button type="submit">Mandar aviso de calidad</button></form></div>`
            )
            .join("");
          const tpls = w.templates
            .map((t) => {
              const decide =
                t.status === "PENDING"
                  ? postForm(b, "template", { waba_id: w.id, name: t.name, language: t.language, decision: "APPROVED" }, "Aprobar", "primary") +
                    postForm(b, "template", { waba_id: w.id, name: t.name, language: t.language, decision: "REJECTED" }, "Rechazar")
                  : t.status === "APPROVED"
                    ? postForm(b, "template", { waba_id: w.id, name: t.name, language: t.language, decision: "PAUSED" }, "Pausar")
                    : "";
              return `<tr><td>${esc(t.name)}</td><td>${esc(t.language)}</td><td>${esc(t.status)}</td><td>${decide}</td></tr>`;
            })
            .join("");
          return `<div class="card"><h2>Cuenta de WhatsApp Business ${esc(w.id)}</h2>
<p class="muted">${w.subscribed ? "Webhooks activos" : "Sin webhooks (la app no está suscripta)"}</p>${phones}
<table><thead><tr><th>Plantilla</th><th>Idioma</th><th>Estado</th><th></th></tr></thead><tbody>${tpls}</tbody></table>
${postForm(b, "partner-removed", { waba_id: w.id }, "Simular PARTNER_REMOVED (el consultorio sacó la app)")}</div>`;
        })
        .join("")
    : '<p class="muted">Todavía no hay cuentas conectadas. Conectá una desde Configuración → WhatsApp.</p>';

  const msgs = v.messages.length
    ? `<table><thead><tr><th>Mensaje</th><th>Para</th><th>Estado</th><th>Responder como el paciente</th></tr></thead><tbody>${v.messages
        .map((m) => {
          const actions =
            (m.hasButtons
              ? postForm(b, "button", { wamid: m.wamid, kind: "c" }, "Confirmo", "primary") + postForm(b, "button", { wamid: m.wamid, kind: "x" }, "No puedo ir")
              : "") +
            postForm(b, "inbound", { wamid: m.wamid, text: "BAJA" }, "BAJA") +
            postForm(b, "inbound", { wamid: m.wamid, text: "ALTA" }, "ALTA") +
            `<form method="post" action="${esc(`${b}/panel/inbound`)}"><input type="hidden" name="wamid" value="${esc(m.wamid)}"><label>Texto<input name="text" maxlength="200" value="Hola, ¿puedo cambiar el horario?"></label><button type="submit">Mandar texto</button></form>` +
            (m.status !== "read" && m.status !== "failed" ? postForm(b, "status", { wamid: m.wamid }, "Avanzar estado") : "");
          return `<tr><td>${esc(m.label)}</td><td>${esc(m.toMasked)}</td><td>${esc(m.status)}</td><td>${actions}</td></tr>`;
        })
        .join("")}</tbody></table>`
    : '<p class="muted">Todavía no salió ningún mensaje.</p>';

  const hooks = v.hooks.length
    ? `<table><thead><tr><th>Hora</th><th>Aviso</th><th>Webhook</th></tr></thead><tbody>${v.hooks
        .map((h) => `<tr><td>${esc(h.at)}</td><td>${esc(h.field)}</td><td>Webhook enviado · respuesta ${esc(h.status)} · ${esc(h.result ?? "sin resultado")}</td></tr>`)
        .join("")}</tbody></table>`
    : '<p class="muted">Todavía no se mandó ningún webhook.</p>';

  return fakeMetaPage(
    "Panel · simulador de Meta",
    `<h1>Panel del simulador de Meta</h1>${flash}
<div class="card"><div class="row">
${postForm(b, "approval", { mode: v.approval === "auto" ? "manual" : "auto" }, v.approval === "auto" ? "Plantillas: aprobación automática (pasar a manual)" : "Plantillas: aprobación manual (pasar a automática)")}
${postForm(b, "auto-statuses", { on: v.autoStatuses ? "0" : "1" }, v.autoStatuses ? "Estados automáticos: prendidos (apagar)" : "Estados automáticos: apagados (prender)")}
</div></div>
<h2>Cuentas</h2>${accounts}
<h2>Mensajes</h2>${msgs}
<h2>Webhooks</h2>${hooks}`
  );
}

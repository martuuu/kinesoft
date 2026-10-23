"use client";

/**
 * [TV-2w1] Drawer «Pantallas» de /sala (§26.4): las TVs de la sala de espera del consultorio.
 *
 * Qué tiene:
 *   - lista de pantallas vivas con chip de estado (`displayStatus`: En línea / Sin conexión / Esperando el código /
 *     Sin vincular), sede, y las acciones «Editar», «Nuevo código» y «Desvincular» (esta con `useConfirm`);
 *   - «Agregar pantalla» con el tope visible («3 de 10 pantallas»; en el tope se deshabilita con el copy del server);
 *   - el formulario (`DisplayForm`) en el mismo drawer, con dirty-guard;
 *   - el código de vínculo (`PairingCodeCard`) arriba de la lista, UNA sola vez: solo existe en el estado de este
 *     componente (lo devolvió el alta o «Nuevo código»). Con un código vivo a la vista el drawer también pide
 *     confirmación antes de cerrarse, porque después no hay forma de volver a verlo.
 *
 * Datos: `getDisplaysPanel` al abrir y después de cada escritura (TV-2s no revalida rutas: handoff). Mientras hay un
 * código a la vista se re-pide cada 15 s para enterarse de que la TV vinculó (el chip pasa a «En línea» y la tarjeta se
 * va sola, ver `pairingAfterPanel`). Sin código no hay polling: el estado de una TV caída no justifica tráfico.
 *
 * Diferido: lo monta TV-2w2 con `next/dynamic` desde /sala; no importa nada pesado (las actions son referencias de
 * server action, `lib/youtube.ts` y `lib/display-feed-state.ts` son puros y chicos).
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Drawer } from "@/components/ui/drawer";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { displayStatus } from "@/lib/display-feed-state";
import {
  createReceptionDisplay,
  getDisplaysPanel,
  regenerateDisplayPairingCode,
  revokeReceptionDisplay,
  updateReceptionDisplay,
} from "@/lib/reception-displays";
import type { DisplayListItem, DisplaysPanel, DisplayStatus } from "@/lib/reception-displays-types";
import type { ActionResult } from "@/lib/validation";
import { DisplayForm, buildDisplayInput, displayFormInitial, isDisplayFormDirty, type DisplayFormState } from "./display-form";
import { PairingCodeCard } from "./pairing-code-card";

const AR_TZ = "America/Argentina/Buenos_Aires";

export const DISPLAY_STATUS_LABEL: Record<DisplayStatus, string> = {
  online: "En línea",
  offline: "Sin conexión",
  pairing: "Esperando el código",
  unpaired: "Sin vincular",
};

export const REVOKE_CONFIRM_MESSAGE = "La pantalla deja de mostrar la sala. Para volver a usarla hay que vincularla de nuevo.";

export const DISPLAYS_COPY = {
  title: "Pantallas",
  editTitle: "Editar pantalla",
  newTitle: "Agregar pantalla",
  loading: "Cargando pantallas…",
  loadFailed: "No pudimos cargar las pantallas. Probá de nuevo.",
  retry: "Reintentar",
  unexpected: "Algo salió mal. Probá de nuevo.",
  intro: "Mostrá en una TV de la sala a quién se llama y quién sigue. Solo se ve el nombre abreviado o la hora del turno.",
  empty: "Todavía no vinculaste ninguna pantalla. Abrí /tv en el navegador de la TV y cargá el código que te damos acá.",
  add: "Agregar pantalla",
  count: (n: number, max: number) => `${n} de ${max} pantallas`,
  atCap: (max: number) => `Llegaste al tope de ${max} pantallas. Desvinculá una para sumar otra.`,
  allLocations: "Todas las sedes",
  lastSeen: (when: string) => `Última conexión: ${when}`,
  edit: "Editar",
  newCode: "Nuevo código",
  revoke: "Desvincular",
  revokeTitle: (name: string) => `¿Desvincular «${name}»?`,
  revoked: (name: string) => `«${name}» quedó desvinculada.`,
  created: (name: string) => `«${name}» quedó creada. Cargá el código en la TV.`,
  saved: "Cambios guardados. La TV los toma en unos segundos.",
  paired: (name: string) => `«${name}» quedó vinculada.`,
  dirtyForm: "Tenés cambios sin guardar en la pantalla. Si cerrás, se pierden.",
  dirtyCode: "El código no se vuelve a mostrar. Si cerrás antes de cargarlo en la TV, vas a tener que generar otro.",
} as const;

const REFRESH_WHILE_PAIRING_MS = 15_000;

/** El código en claro que se está mostrando (solo en memoria; ver cabecera). */
export type ShownPairing = { displayId: string; displayName: string; code: string; expiresAt: string };

type ConfirmFn = ReturnType<typeof useConfirm>;

/** Confirmación + desvinculación. `null` = la persona canceló (no se llamó al server). */
export async function revokeWithConfirm(
  confirm: ConfirmFn,
  revoke: (input: { id: string }) => Promise<ActionResult>,
  item: Pick<DisplayListItem, "id" | "name">,
): Promise<ActionResult | null> {
  const ok = await confirm({
    title: DISPLAYS_COPY.revokeTitle(item.name),
    message: REVOKE_CONFIRM_MESSAGE,
    confirmLabel: DISPLAYS_COPY.revoke,
    cancelLabel: "Cancelar",
    tone: "danger",
  });
  if (!ok) return null;
  return revoke({ id: item.id });
}

/**
 * ¿Sigue sirviendo el código que se ve, con el panel recién traído? Se descarta si la pantalla ya no está (se
 * desvinculó), si vinculó (el server limpia `pairingExpiresAt`) o si tiene otro código (otra pestaña generó uno nuevo:
 * el vencimiento ya no coincide y el que se ve fue reemplazado en la base).
 */
export function pairingAfterPanel(shown: ShownPairing | null, panel: DisplaysPanel): ShownPairing | null {
  if (!shown) return null;
  const d = panel.displays.find((x) => x.id === shown.displayId);
  if (!d || !d.pairingExpiresAt) return null;
  return new Date(d.pairingExpiresAt).getTime() === new Date(shown.expiresAt).getTime() ? shown : null;
}

/** Dirty-guard del drawer: el form con cambios, o un código vivo a la vista (uno vencido ya no se pierde nada). */
export function drawerDirty(o: { formDirty: boolean; pairing: ShownPairing | null; now: number }): boolean {
  if (o.formDirty) return true;
  return o.pairing != null && new Date(o.pairing.expiresAt).getTime() > o.now;
}

/** «hoy 09:00» / «20/10 18:30», en hora AR aunque el navegador esté en otra zona. */
function lastSeenLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const day = (x: Date) => new Intl.DateTimeFormat("es-AR", { timeZone: AR_TZ, day: "2-digit", month: "2-digit" }).format(x);
  const time = new Intl.DateTimeFormat("es-AR", { timeZone: AR_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return day(d) === day(now) ? `hoy ${time}` : `${day(d)} ${time}`;
}

const rowStyle: CSSProperties = {
  display: "grid",
  gap: 8,
  padding: "12px 14px",
  borderRadius: 12,
  border: "1px solid rgba(15, 30, 51, 0.12)",
  background: "var(--card-bg)",
};
const noteStyle: CSSProperties = { margin: 0, fontSize: 13, color: "var(--navy-500)" };

function StatusChip({ status }: { status: DisplayStatus }) {
  // Color + texto: el chip nunca depende solo del color (el texto es el estado).
  return (
    <span data-status={status} style={{ display: "inline-flex", flexShrink: 0 }}>
      <Tag tone={status === "online" ? "lime" : status === "pairing" ? "sky" : "soft"} variant={status === "online" || status === "pairing" ? "fill" : "outline"}>
        {DISPLAY_STATUS_LABEL[status]}
      </Tag>
    </span>
  );
}

// ── Vista de la lista (presentacional; exportada para el render test) ─────────────────────────────────────────────

export type DisplaysPanelViewProps = {
  panel: DisplaysPanel;
  now: Date;
  pairing: ShownPairing | null;
  origin: string;
  /** Pantalla con una acción en curso (deshabilita sus botones). */
  busyId: string | null;
  onAdd: () => void;
  onEdit: (item: DisplayListItem) => void;
  onRegenerate: (item: Pick<DisplayListItem, "id" | "name">) => void;
  onRevoke: (item: DisplayListItem) => void;
  onDismissPairing: () => void;
};

export function DisplaysPanelView(p: DisplaysPanelViewProps) {
  const C = DISPLAYS_COPY;
  const { displays, maxLive } = p.panel;
  const atCap = displays.length >= maxLive;
  return (
    <div style={{ display: "grid", gap: 16 }} data-testid="displays-panel">
      <p style={{ ...noteStyle, color: "var(--navy-700)" }}>{C.intro}</p>

      {p.pairing && (
        <PairingCodeCard
          // Una tarjeta por código: un «Nuevo código» reinicia la cuenta regresiva y el estado de vencido.
          key={`${p.pairing.displayId}:${p.pairing.expiresAt}`}
          code={p.pairing.code}
          expiresAt={p.pairing.expiresAt}
          displayName={p.pairing.displayName}
          origin={p.origin}
          now={p.now.getTime()}
          regenerating={p.busyId === p.pairing.displayId}
          onRegenerate={() => p.onRegenerate({ id: p.pairing!.displayId, name: p.pairing!.displayName })}
          onDismiss={p.onDismissPairing}
        />
      )}

      {displays.length === 0 ? (
        <p style={{ margin: 0, fontSize: 14, color: "var(--navy-700)" }} data-testid="displays-empty">
          {C.empty}
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {displays.map((d) => {
            const status = displayStatus(d, p.now);
            const busy = p.busyId === d.id;
            return (
              <li key={d.id} style={rowStyle} data-display={d.id}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
                    <strong style={{ fontSize: 15, color: "var(--navy-900)", overflowWrap: "anywhere" }}>{d.name}</strong>
                    <span style={noteStyle}>{d.locationName ?? C.allLocations}</span>
                    {status === "offline" && d.lastSeenAt && <span style={noteStyle}>{C.lastSeen(lastSeenLabel(d.lastSeenAt, p.now))}</span>}
                  </div>
                  <StatusChip status={status} />
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <Button type="button" variant="ghost" size="sm" onClick={() => p.onEdit(d)} disabled={busy}>
                    {C.edit}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => p.onRegenerate(d)} disabled={busy}>
                    {C.newCode}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => p.onRevoke(d)} disabled={busy}>
                    {C.revoke}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <span style={{ ...noteStyle, fontVariantNumeric: "tabular-nums" }} data-testid="displays-count">
          {C.count(displays.length, maxLive)}
        </span>
        <Button type="button" onClick={p.onAdd} disabled={atCap}>
          {C.add}
        </Button>
      </div>
      {atCap && <p style={noteStyle}>{C.atCap(maxLive)}</p>}
    </div>
  );
}

// ── Drawer ──────────────────────────────────────────────────────────────────────────────────────────────────────────

type PanelState = { status: "loading" } | { status: "ready"; panel: DisplaysPanel } | { status: "error"; error: string };
type View = { kind: "list" } | { kind: "create" } | { kind: "edit"; item: DisplayListItem };

export function DisplaysDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const C = DISPLAYS_COPY;
  const confirm = useConfirm();
  const toast = useToast();
  const [panelState, setPanelState] = useState<PanelState>({ status: "loading" });
  const [view, setView] = useState<View>({ kind: "list" });
  const [form, setForm] = useState<DisplayFormState>(() => displayFormInitial(null));
  const [baseline, setBaseline] = useState<DisplayFormState>(() => displayFormInitial(null));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[] | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pairing, setPairing] = useState<ShownPairing | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [origin, setOrigin] = useState("");
  // Candado síncrono contra el doble click (el `pending` de React llega un render tarde).
  const inFlight = useRef(false);
  const pairingRef = useRef(pairing);
  pairingRef.current = pairing;

  useEffect(() => setOrigin(window.location.origin), []);

  const load = useCallback(async () => {
    try {
      const r = await getDisplaysPanel();
      if (!r.ok) {
        setPanelState({ status: "error", error: r.error });
        return;
      }
      setPanelState({ status: "ready", panel: r.data });
      setNow(new Date());
      const prev = pairingRef.current;
      const next = pairingAfterPanel(prev, r.data);
      if (prev && !next) {
        const d = r.data.displays.find((x) => x.id === prev.displayId);
        if (d?.pairedAt && !d.pairingExpiresAt) toast.success(C.paired(d.name));
      }
      setPairing(next);
    } catch {
      setPanelState({ status: "error", error: C.loadFailed });
    }
  }, [toast, C]);

  useEffect(() => {
    if (!open) return;
    setPanelState({ status: "loading" });
    void load();
  }, [open, load]);

  // El reloj de los chips (un código que vence pasa a «Sin vincular»; una TV que deja de latir, a «Sin conexión»).
  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(t);
  }, [open]);

  const waitingPair = pairing != null;
  useEffect(() => {
    if (!open || !waitingPair) return;
    const t = window.setInterval(() => void load(), REFRESH_WHILE_PAIRING_MS);
    return () => window.clearInterval(t);
  }, [open, waitingPair, load]);

  const inForm = view.kind !== "list";
  const formDirty = inForm && isDisplayFormDirty(baseline, form);
  const dirty = drawerDirty({ formDirty, pairing, now: now.getTime() });

  function openForm(next: View) {
    const initial = displayFormInitial(next.kind === "edit" ? next.item : null);
    setForm(initial);
    setBaseline(initial);
    setFieldErrors({});
    setFormError(null);
    setView(next);
  }

  async function backToList() {
    if (formDirty) {
      const ok = await confirm({
        title: "¿Descartar los cambios?",
        message: C.dirtyForm,
        confirmLabel: "Descartar",
        cancelLabel: "Seguir editando",
        tone: "danger",
      });
      if (!ok) return;
    }
    setView({ kind: "list" });
  }

  async function guarded<T>(fn: () => Promise<T>): Promise<T | null> {
    if (inFlight.current) return null;
    inFlight.current = true;
    try {
      return await fn();
    } finally {
      inFlight.current = false;
    }
  }

  async function submit() {
    const built = buildDisplayInput(form);
    if (!built.ok) {
      setFieldErrors(built.fieldErrors);
      return;
    }
    await guarded(async () => {
      setPending(true);
      setFormError(null);
      try {
        if (view.kind === "edit") {
          const r = await updateReceptionDisplay({ ...built.input, id: view.item.id, expectedUpdatedAt: view.item.updatedAt });
          if (!r.ok) return fail(r);
          toast.success(C.saved);
        } else {
          const r = await createReceptionDisplay(built.input);
          if (!r.ok) return fail(r);
          setPairing({ displayId: r.data.display.id, displayName: r.data.display.name, ...r.data.pairing });
          toast.success(C.created(r.data.display.name));
        }
        setView({ kind: "list" });
        await load();
      } catch {
        setFormError(C.unexpected);
      } finally {
        setPending(false);
      }
    });
  }

  function fail(r: { error: string; fieldErrors?: Record<string, string[]> }) {
    const fe = r.fieldErrors ?? {};
    setFieldErrors(fe);
    // Si el error ya se ve bajo su campo, no se repite arriba del botón.
    const shown = Object.values(fe).some((m) => m?.includes(r.error));
    setFormError(shown ? null : r.error);
  }

  async function regenerate(item: Pick<DisplayListItem, "id" | "name">) {
    await guarded(async () => {
      setBusyId(item.id);
      try {
        const r = await regenerateDisplayPairingCode({ id: item.id });
        if (!r.ok) {
          toast.error(r.error);
          return;
        }
        setPairing({ displayId: item.id, displayName: item.name, ...r.data });
        await load();
      } catch {
        toast.error(C.unexpected);
      } finally {
        setBusyId(null);
      }
    });
  }

  async function revoke(item: DisplayListItem) {
    if (inFlight.current) return;
    setBusyId(item.id);
    try {
      const r = await guarded(() => revokeWithConfirm(confirm, revokeReceptionDisplay, item));
      if (!r) return;
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(C.revoked(item.name));
      await load();
    } catch {
      toast.error(C.unexpected);
    } finally {
      setBusyId(null);
    }
  }

  const title = view.kind === "edit" ? C.editTitle : view.kind === "create" ? C.newTitle : C.title;

  return (
    <Drawer open={open} onClose={onClose} title={title} dirty={dirty} dirtyMessage={formDirty ? C.dirtyForm : C.dirtyCode}>
      {panelState.status === "loading" ? (
        <p style={noteStyle} aria-live="polite">
          {C.loading}
        </p>
      ) : panelState.status === "error" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <p className="k-alert" role="alert" style={{ margin: 0 }}>
            {panelState.error}
          </p>
          <div>
            <Button type="button" variant="ghost" onClick={() => void load()}>
              {C.retry}
            </Button>
          </div>
        </div>
      ) : inForm ? (
        <DisplayForm
          mode={view.kind === "edit" ? "edit" : "create"}
          state={form}
          onChange={(patch) => {
            setForm((s) => ({ ...s, ...patch }));
            // El error de un campo se va cuando se lo toca (el del link pasa a la lectura en vivo).
            setFieldErrors((fe) => {
              const keys = Object.keys(patch).filter((k) => fe[k]);
              if (!keys.length) return fe;
              const next = { ...fe };
              for (const k of keys) delete next[k];
              return next;
            });
          }}
          locations={panelState.panel.locations}
          origin={origin}
          fieldErrors={fieldErrors}
          error={formError}
          pending={pending}
          onSubmit={() => void submit()}
          onCancel={() => void backToList()}
        />
      ) : (
        <DisplaysPanelView
          panel={panelState.panel}
          now={now}
          pairing={pairing}
          origin={origin}
          busyId={busyId}
          onAdd={() => openForm({ kind: "create" })}
          onEdit={(item) => openForm({ kind: "edit", item })}
          onRegenerate={(item) => void regenerate(item)}
          onRevoke={(item) => void revoke(item)}
          onDismissPairing={() => setPairing(null)}
        />
      )}
    </Drawer>
  );
}

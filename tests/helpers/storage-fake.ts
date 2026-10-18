/**
 * T4 FC-2f · Storage fake en memoria para los tests de integración (subida firmada, logo y firma; lo puede reusar
 * FC-2i para la integración cruzada).
 *
 * Reemplaza SOLO la red: el admin client de supabase-js (`getSupabaseAdminClient`) y el `fetch` de la URL firmada que
 * usa `storageReadHead`. Las funciones de `lib/storage-internal.ts`, `lib/files.ts` y `lib/practice-assets.ts` corren
 * de verdad. Imita lo que importa de Supabase Storage:
 *  - `upload`/`move` no pisan un objeto existente (upsert false / destino ocupado → `{ error }`);
 *  - `info()` de un objeto ausente → `{ error }` con status 404;
 *  - el PUT del navegador a la URL firmada (`clientPut`) guarda los bytes con el Content-Type que mande el cliente;
 *  - la URL firmada de lectura respeta `Range: bytes=a-b` (206).
 *
 * Uso:
 *   vi.mock("@/lib/supabase/admin", async () => {
 *     const { storageFake } = await import("@/tests/helpers/storage-fake");
 *     return { getSupabaseAdminClient: () => storageFake.client() };
 *   });
 *   beforeAll(() => storageFake.installFetch()); afterAll(() => storageFake.uninstallFetch());
 */
type Obj = { bytes: Uint8Array; contentType: string; createdAt: Date };
type Call = { op: string; bucket: string; args: unknown[] };

const ORIGIN = "https://storage.fake";

function err(message: string, status = 400) {
  return { data: null, error: { message, status, statusCode: String(status) } };
}

class StorageFake {
  enabled = true;
  objects = new Map<string, Obj>();
  calls: Call[] = [];
  /** Operaciones que fallan con `{ error }` (p. ej. "move") para probar la limpieza. */
  failOps = new Set<string>();
  private origFetch: typeof fetch | null = null;
  private seq = 0;

  reset(): void {
    this.enabled = true;
    this.objects.clear();
    this.calls = [];
    this.failOps.clear();
  }

  id(bucket: string, key: string): string {
    return `${bucket}/${key}`;
  }

  get(bucket: string, key: string): Obj | undefined {
    return this.objects.get(this.id(bucket, key));
  }

  put(bucket: string, key: string, bytes: Uint8Array, contentType: string): void {
    this.objects.set(this.id(bucket, key), { bytes, contentType, createdAt: new Date() });
  }

  keys(bucket: string): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(`${bucket}/`)).map((k) => k.slice(bucket.length + 1));
  }

  /** El PUT del navegador a la URL de `createSignedUploadUrl` (lo que hace el XHR de FC-4b). */
  clientPut(signedUrl: string, bytes: Uint8Array, contentType: string): void {
    const u = new URL(signedUrl);
    const m = /^\/upload\/([^/]+)\/(.+)$/.exec(u.pathname);
    if (!m || !u.searchParams.get("token")) throw new Error(`[storage-fake] URL de subida inválida: ${signedUrl}`);
    const [, bucket, key] = m;
    if (this.get(bucket, decodeURIComponent(key))) throw new Error("[storage-fake] el objeto ya existe");
    this.put(bucket, decodeURIComponent(key), bytes, contentType);
  }

  client(): unknown {
    if (!this.enabled) return null;
    return {
      storage: {
        from: (bucket: string) => {
          const rec = (op: string, args: unknown[]) => {
            this.calls.push({ op, bucket, args });
            return this.failOps.has(op);
          };
          return {
            upload: async (key: string, body: Uint8Array, opts: { contentType?: string; upsert?: boolean }) => {
              if (rec("upload", [key])) return err("boom", 500);
              if (this.get(bucket, key) && !opts?.upsert) return err("The resource already exists", 409);
              this.put(bucket, key, new Uint8Array(body), opts?.contentType ?? "application/octet-stream");
              return { data: { path: key }, error: null };
            },
            createSignedUploadUrl: async (key: string) => {
              if (rec("createSignedUploadUrl", [key])) return err("boom", 500);
              const token = `up-${++this.seq}`;
              return {
                data: { signedUrl: `${ORIGIN}/upload/${bucket}/${encodeURIComponent(key)}?token=${token}`, token, path: key },
                error: null,
              };
            },
            info: async (key: string) => {
              if (rec("info", [key])) return err("boom", 500);
              const o = this.get(bucket, key);
              if (!o) return err("Object not found", 404);
              return { data: { name: key, size: o.bytes.length, contentType: o.contentType }, error: null };
            },
            createSignedUrl: async (key: string, ttl: number) => {
              if (rec("sign", [key, ttl])) return err("boom", 500);
              if (!this.get(bucket, key)) return err("Object not found", 404);
              return { data: { signedUrl: `${ORIGIN}/object/${bucket}/${encodeURIComponent(key)}?ttl=${ttl}` }, error: null };
            },
            download: async (key: string) => {
              if (rec("download", [key])) return err("boom", 500);
              const o = this.get(bucket, key);
              if (!o) return err("Object not found", 404);
              return { data: new Blob([new Uint8Array(o.bytes)], { type: o.contentType }), error: null };
            },
            move: async (from: string, to: string) => {
              if (rec("move", [from, to])) return err("boom", 500);
              const o = this.get(bucket, from);
              if (!o) return err("Object not found", 404);
              if (this.get(bucket, to)) return err("The resource already exists", 409);
              this.objects.delete(this.id(bucket, from));
              this.objects.set(this.id(bucket, to), o);
              return { data: { message: "Successfully moved" }, error: null };
            },
            remove: async (keys: string[]) => {
              if (rec("remove", [keys])) return err("boom", 500);
              for (const k of keys) this.objects.delete(this.id(bucket, k));
              return { data: [], error: null };
            },
            list: async (prefix: string) => {
              rec("list", [prefix]);
              const p = `${prefix}/`;
              const names = new Map<string, Obj | null>();
              for (const k of this.keys(bucket)) {
                if (!k.startsWith(p)) continue;
                const rest = k.slice(p.length);
                const slash = rest.indexOf("/");
                if (slash >= 0) names.set(rest.slice(0, slash), null);
                else names.set(rest, this.get(bucket, k)!);
              }
              return {
                data: [...names].map(([name, o]) =>
                  o ? { name, id: name, created_at: o.createdAt.toISOString() } : { name, id: null },
                ),
                error: null,
              };
            },
          };
        },
      },
    };
  }

  installFetch(): void {
    if (this.origFetch) return;
    this.origFetch = globalThis.fetch;
    const orig = this.origFetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith(`${ORIGIN}/object/`)) return orig(input, init);
      const u = new URL(url);
      const [, bucket, key] = /^\/object\/([^/]+)\/(.+)$/.exec(u.pathname) ?? [];
      const o = bucket ? this.get(bucket, decodeURIComponent(key)) : undefined;
      this.calls.push({ op: "fetch", bucket: bucket ?? "", args: [decodeURIComponent(key ?? ""), init?.headers] });
      if (!o) return new Response("not found", { status: 404 });
      const range = new Headers(init?.headers).get("range");
      const m = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
      if (m) return new Response(o.bytes.slice(Number(m[1]), Number(m[2]) + 1), { status: 206 });
      return new Response(new Uint8Array(o.bytes), { status: 200 });
    }) as typeof fetch;
  }

  uninstallFetch(): void {
    if (this.origFetch) globalThis.fetch = this.origFetch;
    this.origFetch = null;
  }
}

export const storageFake = new StorageFake();

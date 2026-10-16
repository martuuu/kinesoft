#!/usr/bin/env node
/**
 * DIR-Z-F1 · smoke HTTP del directorio contra un server corriendo (`next start`, preview o prod). Sin dependencias.
 *
 * Por qué: el 404 de las fichas ISR (`/consultorios/[slug]`, `/profesionales/[nombreId]`) daba 500 en `next start`
 * porque pintaba el `not-found` del root, que lee la cookie de sesión. Los unit no lo ven (no corren el runtime de
 * Next): esto sí. Ver `app/(directory)/not-found.tsx`.
 *
 * Uso:
 *   node scripts/smoke-directory.mjs [baseUrl] [--mode=preview|public|off] [--alias=slugViejo] [--listed=slugListado]
 *   baseUrl por defecto http://127.0.0.1:3000. Con --mode=off espera 404 en todas las rutas del directorio.
 * Sale con 1 si algún código no es el esperado.
 */
const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const base = (args.find((a) => !a.startsWith("--")) ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const mode = flag("mode") ?? "preview";
const alias = flag("alias");
const listed = flag("listed");
const on = mode !== "off";

/** [ruta, código esperado o lista de aceptables]. `redirect: "manual"` para ver el 308 del alias y no seguirlo. */
const cases = [
  ["/profesionales", on ? 200 : 404],
  ["/consultorios/no-existe", 404],
  ["/consultorios/movare", 404],
  ["/consultorios/..%2Fx", 404],
  ["/consultorios/UPPER_raro", 404],
  ["/profesionales/ana-perez-clxyz", 404],
  ["/profesionales/sin-id", 404],
  // URI mal formada: Next la corta antes de la app con 400. Lo que importa es que no sea 500.
  ["/profesionales/%E0%A4%A", [400, 404]],
];
if (listed) cases.push([`/consultorios/${listed}`, on ? 200 : 404]);
if (alias) cases.push([`/consultorios/${alias}`, on ? 308 : 404]);

let failed = 0;
for (const [path, want] of cases) {
  let got;
  let extra = "";
  try {
    const res = await fetch(base + path, { redirect: "manual" });
    got = res.status;
    if (got >= 300 && got < 400) extra = ` → ${res.headers.get("location")}`;
    await res.arrayBuffer();
  } catch (e) {
    got = `ERR ${e.cause?.code ?? e.message}`;
  }
  const ok = Array.isArray(want) ? want.includes(got) : got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${String(got).padEnd(4)} (esperado ${[want].flat().join("|")}) ${path}${extra}`);
}
console.log(failed ? `\n${failed} fallaron` : `\nTodo OK (${cases.length} rutas, modo ${mode})`);
process.exit(failed ? 1 : 0);

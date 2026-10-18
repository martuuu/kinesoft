/**
 * WA-0 (§21.6): celular argentino → E.164 (`+549…`) para el link `wa.me` del drawer del turno.
 *
 * Puro y sin dependencias a propósito: el plan original pedía `libphonenumber-js`, pero la regla de la tanda B es
 * «nada de librerías nuevas» y acá solo hace falta AR (≈ 140 KB de metadata para resolver un caso). Lo que se necesita
 * es chico y está bien definido por el plan de numeración argentino:
 *
 *   - Número nacional significativo (NSN) = área + abonado = **10 dígitos**. El área es `11` (AMBA, la única de 2
 *     dígitos) o arranca con 2 o 3 (3-4 dígitos: `351`, `221`, `2202`, `3543`…). Ninguna área arranca con 0, 1 (salvo
 *     11) ni 4-9: eso es lo que permite separar `15` (prefijo de celular) del área sin una tabla de áreas.
 *   - Formato nacional de un celular: `0` + área + `15` + abonado (`011 15 2345-6789`, `0351 155 123456`). El `15` va
 *     entre el área y el abonado, así que con el `15` son 12 dígitos después del `0`.
 *   - Formato internacional de un celular: `+54 9` + NSN (sin `0` ni `15`). Es el que usa WhatsApp: `549` + 10.
 *   - Un fijo es `0` + área + abonado (o `+54` + NSN sin el `9`). WhatsApp no tiene cuentas en fijos argentinos (salvo
 *     WhatsApp Business sobre un fijo, rarísimo en un consultorio): mandarlo a `wa.me/54…` abre «el número no está en
 *     WhatsApp». Por eso un fijo → `null` con motivo, y el drawer cae al `wa.me/?text=` sin destinatario.
 *
 * Decisión con default: un número de 10 dígitos SIN `0` y sin `15` (`11 2345 6789`, `351 512 3456`) se toma como
 * celular. Es como la gente carga el celular en un formulario (y como lo devuelve la agenda del teléfono); un fijo
 * cargado así no se distingue y el peor caso es el mismo aviso de WhatsApp. Con el `0` adelante sin `15`, en cambio,
 * es la forma de escribir un fijo y se rechaza.
 *
 * Números extranjeros (`+598…`, `+56…`) → `not_ar`: el consultorio es argentino y sin metadata no hay forma de saber
 * si son celulares. Si aparece el caso, se suma acá (y se dice en el reporte), no con una librería.
 */

export type ArPhoneRejectReason =
  /** Vacío o sin dígitos. */
  | "empty"
  /** Fijo (con `0` de larga distancia y sin `15`, o `+54` sin el `9`). */
  | "landline"
  /** 8 dígitos o `15` + 8: celular o fijo local sin código de área (no se adivina el área). */
  | "missing_area_code"
  /** Internacional de otro país. */
  | "not_ar"
  /** Cualquier otra cosa: largo imposible, área inexistente, dos números en el mismo campo. */
  | "invalid";

export type ArMobileResult = { ok: true; e164: string } | { ok: false; reason: ArPhoneRejectReason };

/** ¿Estos 10 dígitos son un NSN argentino posible? (área 11, o que arranca con 2 o 3). */
function isNsn(d: string): boolean {
  if (!/^\d{10}$/.test(d)) return false;
  if (d[0] === "1") return d[1] === "1";
  return d[0] === "2" || d[0] === "3";
}

/**
 * Saca el `15` que va entre el área y el abonado en un número de 12 dígitos (sin el `0`). Devuelve el NSN o null.
 * Área de 2 = solo `11`; de 3 o 4 = arranca con 2 o 3. Con esas reglas el corte es único: `15` en la posición 3 y en
 * la 4 a la vez exigiría que el mismo dígito fuera 1 y 5.
 */
function strip15(d: string): string | null {
  if (d.length !== 12) return null;
  for (const areaLen of [2, 3, 4]) {
    if (d.slice(areaLen, areaLen + 2) !== "15") continue;
    const area = d.slice(0, areaLen);
    const okArea = areaLen === 2 ? area === "11" : area[0] === "2" || area[0] === "3";
    if (!okArea) continue;
    const nsn = area + d.slice(areaLen + 2);
    if (isNsn(nsn)) return nsn;
  }
  return null;
}

const mobile = (nsn: string): ArMobileResult => ({ ok: true, e164: `+549${nsn}` });

/**
 * Normaliza un teléfono cargado a mano a celular E.164. Acepta espacios, guiones, puntos, paréntesis y `+`/`00`.
 *
 *   `011 15 2345-6789`   → `+5491123456789`
 *   `+54 9 11 2345 6789` → `+5491123456789`
 *   `0351 155 123456`    → `+5493515123456`
 *   `11 2345 6789`       → `+5491123456789` (ver la decisión con default de arriba)
 *   `011 4321-5678`      → `{ ok: false, reason: "landline" }`
 */
export function normalizeArMobile(raw: string | null | undefined): ArMobileResult {
  const s = (raw ?? "").trim();
  let d = s.replace(/\D/g, "");
  if (!d) return { ok: false, reason: "empty" };

  // Internacional: `+…`, `00…` o el `54` pelado con largo de internacional (12-13). Un nacional nunca arranca con
  // `54`: no hay área que empiece con 5.
  const plus = s.startsWith("+");
  const viaZeros = !plus && d.startsWith("00");
  if (viaZeros) d = d.slice(2);
  const intl = plus || viaZeros || (d.startsWith("54") && d.length >= 12);
  if (intl) {
    if (!d.startsWith("54")) return { ok: false, reason: "not_ar" };
    let rest = d.slice(2);
    if (rest.startsWith("9")) {
      rest = rest.slice(1);
      // `+54 9 011 15…`: hay quien mezcla los dos formatos; el `0` y el `15` sobran.
      if (rest.startsWith("0")) rest = rest.slice(1);
      if (isNsn(rest)) return mobile(rest);
      const nsn = strip15(rest);
      return nsn ? mobile(nsn) : { ok: false, reason: "invalid" };
    }
    if (rest.startsWith("0")) rest = rest.slice(1);
    // `+54 11 15 2345-6789`: el `15` dice que es celular aunque falte el `9`.
    const nsn = strip15(rest);
    if (nsn) return mobile(nsn);
    return isNsn(rest) ? { ok: false, reason: "landline" } : { ok: false, reason: "invalid" };
  }

  // Nacional.
  const trunk = d.startsWith("0");
  if (trunk) d = d.slice(1);
  // `9 11 2345 6789` (el 9 del internacional sin el 54).
  if (!trunk && d.length === 11 && d.startsWith("9") && isNsn(d.slice(1))) return mobile(d.slice(1));
  if (d.length === 12) {
    const nsn = strip15(d);
    return nsn ? mobile(nsn) : { ok: false, reason: "invalid" };
  }
  if (d.length === 10) {
    // `15 2345 6789`: celular sin área. El área `15` no existe, así que no es un NSN.
    if (d.startsWith("15")) return { ok: false, reason: "missing_area_code" };
    if (!isNsn(d)) return { ok: false, reason: "invalid" };
    return trunk ? { ok: false, reason: "landline" } : mobile(d);
  }
  if (!trunk && (d.length === 8 || d.length === 7 || d.length === 6)) return { ok: false, reason: "missing_area_code" };
  return { ok: false, reason: "invalid" };
}

/** Atajo: el E.164 o null (el motivo, con `normalizeArMobile`). */
export function toArMobileE164(raw: string | null | undefined): string | null {
  const r = normalizeArMobile(raw);
  return r.ok ? r.e164 : null;
}

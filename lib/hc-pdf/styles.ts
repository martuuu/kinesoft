/**
 * Estilos del PDF de la historia clínica (C-FC5). Objetos planos, SIN importar `@react-pdf/renderer`: `lib/hc-pdf/`
 * está en la allow-list del portal y react-pdf solo puede vivir en archivos `server-only` (`hc-heavy-deps`, regla 7);
 * `render-internal.tsx` los pasa por `StyleSheet.create` (que es la identidad).
 *
 * Paleta en grises y un acento navy (el `--navy-*` del design system): el PDF se imprime en blanco y negro casi siempre,
 * así que nada depende del color para leerse (la anulación dice «Anulada» en texto, no solo en rojo).
 */

/** Familias registradas por `render-internal.tsx`: Noto Sans y Noto Sans Math como fallback por carácter (≤ ≥ →). */
export const HC_PDF_FONT_FAMILY = ["NotoSans", "NotoSansMath"];

const INK = "#1f2937";
const MUTED = "#6b7280";
const RULE = "#d1d5db";
const ACCENT = "#1e3a5f";
const DANGER = "#991b1b";

export const HC_PDF_LOGO_MAX = { width: 140, height: 56 } as const;
export const HC_PDF_SIGNATURE_MAX = { width: 160, height: 56 } as const;

export const hcPdfStyles = {
  page: {
    paddingTop: 36,
    paddingHorizontal: 40,
    paddingBottom: 56,
    fontFamily: HC_PDF_FONT_FAMILY,
    fontSize: 10,
    lineHeight: 1.4,
    color: INK,
  },
  letterhead: { flexDirection: "row" as const, alignItems: "center" as const, marginBottom: 10 },
  logo: { marginRight: 12, objectFit: "contain" as const },
  tenantName: { fontSize: 14, fontWeight: 700, color: ACCENT },
  tenantMeta: { fontSize: 9, color: MUTED },
  rule: { borderBottomWidth: 1, borderBottomColor: RULE, marginBottom: 10 },
  docTitle: { fontSize: 12, fontWeight: 700, marginBottom: 2 },
  patient: { fontSize: 10, marginBottom: 2 },
  notice: { fontSize: 9, fontStyle: "italic" as const, color: MUTED, marginBottom: 6 },
  ficha: { marginTop: 12, paddingTop: 8, borderTopWidth: 1, borderTopColor: RULE },
  amendment: { marginTop: 8, marginLeft: 12, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: RULE },
  entryTitle: { fontSize: 11, fontWeight: 700, color: ACCENT },
  entryMeta: { fontSize: 9, color: MUTED, marginBottom: 4 },
  voided: { fontSize: 9, fontWeight: 700, color: DANGER, marginBottom: 4 },
  p: { marginBottom: 4 },
  h2: { fontSize: 11, fontWeight: 700, marginTop: 4, marginBottom: 2 },
  h3: { fontSize: 10, fontWeight: 700, marginTop: 3, marginBottom: 2 },
  li: { flexDirection: "row" as const, marginBottom: 2 },
  liMarker: { width: 16 },
  liBody: { flex: 1 },
  bold: { fontWeight: 700 },
  italic: { fontStyle: "italic" as const },
  underline: { textDecoration: "underline" as const },
  dxTitle: { fontSize: 9, fontWeight: 700, marginTop: 4 },
  dx: { fontSize: 9 },
  // T4-Z (B-1): la URI de la entidad CIE-11, chica y en gris debajo del código. Con la URI el diagnóstico se puede
  // verificar en la OMS sin depender de la versión del título (los títulos cambian entre releases, la entidad no).
  dxUri: { fontSize: 7, color: MUTED, marginBottom: 1 },
  signature: { marginTop: 8, alignItems: "flex-start" as const },
  signatureImage: { objectFit: "contain" as const, marginBottom: 2 },
  signatureLine: { fontSize: 9, borderTopWidth: 1, borderTopColor: INK, paddingTop: 2 },
  attribution: { marginTop: 14, fontSize: 7, color: MUTED },
  footer: { position: "absolute" as const, bottom: 24, left: 40, right: 40, fontSize: 7, color: MUTED, textAlign: "center" as const },
};

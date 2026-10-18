/**
 * Diagnósticos de la ficha (T4, contrato C-FC2; brief §24.4). Puro: lo importan el selector del cliente, las actions
 * de `lib/diagnoses.ts` y el server de las fichas.
 *
 * Prefijo `diagnoses-*` (plural) a propósito: `lib/diagnosis-*.ts` ya es el asistente de diagnóstico (modelo
 * `Diagnosis`, brief §24.2 hallazgo 10) y mezclar los dos nombres confundía grep y el export.
 *
 * Licencia CIE-11 (CC BY-ND 3.0 IGO, §1.2.1-1.2.5): en la ficha se guarda código + título oficial + URI sin tocar el
 * título; la atribución va literal en el selector y en el PDF. Las condiciones de Kinesiología van sin `cie10`
 * (FC-D25): su `code` queda null.
 */

export const DIAGNOSES_MAX = 5; export const DIAGNOSIS_TEXT_MIN = 2; export const DIAGNOSIS_TEXT_MAX = 120;
export const DIAGNOSIS_SEARCH_LIMIT = 20; export const DIAGNOSIS_FAVORITES_MAX = 200; export const DIAGNOSIS_RECENTS_MAX = 8;
export const ACTIVE_DIAGNOSIS_TITLE_MAX = 80;
export const ICD11_ATTRIBUTION = "International Classification of Diseases, Eleventh Revision (ICD-11), World Health Organization (WHO) 2019 https://icd.who.int/browse11. Licensed under CC BY-ND 3.0 IGO";
export const ICD11_SHORT_ATTRIBUTION = "CIE-11 © OMS · CC BY-ND 3.0 IGO";
export type DiagnosisSource = "icd11" | "tenant" | "kine" | "text";
export const DIAGNOSIS_SOURCE_LABEL: Record<DiagnosisSource, string> = { icd11: "CIE-11 (OMS)", tenant: "Propios del consultorio", kine: "Kinesiología", text: "Texto libre" };
/**
 * Lo que manda la UI (FC-D27): nunca código ni título. El server re-lee cada ref (`resolveDiagnosesInTx`) y congela
 * el snapshot, así un cliente no puede inventar un código CIE-11 ni usar un propio de otro consultorio.
 */
export type DiagnosisRef = { kind: "icd11"; id: string } | { kind: "tenant"; id: string } | { kind: "kine"; id: string } | { kind: "text"; text: string };
/**
 * Lo que queda congelado en la ficha (y en sus revisiones). `v` versiona el formato del JSON; `uri` y `release` solo
 * en CIE-11 (la licencia pide código + título + URI). Un código retirado se conserva tal cual al editar.
 */
export type DiagnosisSnapshot = { v: 1; source: DiagnosisSource; refId: string | null; code: string | null; title: string; uri: string | null; release: string | null };
export type DiagnosisOption = { ref: DiagnosisRef; source: DiagnosisSource; code: string | null; title: string; retired: boolean; favorite: boolean };
export type DiagnosisSearchResult = { query: string; groups: { source: Exclude<DiagnosisSource, "text">; label: string; options: DiagnosisOption[] }[]; canCreateOwn: boolean; icdCatalogLoaded: boolean };
export type DiagnosisPickerHome = { favorites: DiagnosisOption[]; recents: DiagnosisOption[]; icdCatalogLoaded: boolean };
export type TenantDiagnosisRow = { id: string; title: string; code: string | null; archived: boolean; createdByMe: boolean; canManage: boolean; updatedAt: string };
export const DIAGNOSIS_COPY = {
  notAvailable: "Uno de los diagnósticos ya no está disponible. Elegilo de nuevo.",
  retired: "Ese código ya no está vigente en la CIE-11. Elegí el actual.",
  tooMany: "Podés cargar hasta 5 diagnósticos.",
  textLength: "El diagnóstico escrito tiene que tener entre 2 y 120 caracteres.",
  duplicateTitle: "Ya existe un diagnóstico propio con ese nombre.",
  forbidden: "No podés editar este diagnóstico del consultorio.",
  catalogEmpty: "El catálogo CIE-11 todavía no está cargado: usá un diagnóstico propio o escribilo.",
  activeNeedsPrincipal: "Elegí un diagnóstico para usarlo como diagnóstico activo.",
  favoritesFull: "Llegaste al máximo de 200 favoritos.",
} as const;

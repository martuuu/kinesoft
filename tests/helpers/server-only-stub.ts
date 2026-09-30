// `server-only` throws unless bundled under the `react-server` condition,
// which vitest doesn't use. Aliased to this no-op in both vitest configs so
// the real `*-internal.ts` modules (billing, visibility, notifications…) can
// be exercised by integration tests.
export {};

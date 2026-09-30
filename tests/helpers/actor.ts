/**
 * Who the mocked Supabase session says is logged in, per test.
 *
 * Integration tests drive the REAL `getActor()` (lib/session.ts): only the
 * external dependency is mocked — the Supabase `auth.getUser()` call and the
 * Next request APIs (see integration-setup.ts). `buildActor` then runs its
 * real membership/practitioner queries against the database, so a test for
 * "a PRACTITIONER without access" exercises the same code path prod does.
 */
let current: { id: string; email: string } | null = null;

export function asUser(userId: string): void {
  current = { id: userId, email: `${userId}@test.local` };
}

export function asAnonymous(): void {
  current = null;
}

export function currentTestUser(): { id: string; email: string; email_confirmed_at: string } | null {
  return current ? { ...current, email_confirmed_at: new Date(0).toISOString() } : null;
}

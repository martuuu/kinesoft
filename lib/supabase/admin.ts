import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/**
 * Admin Supabase client — only safe on the server. Uses the
 * `SUPABASE_SERVICE_ROLE_KEY` which **bypasses RLS**, so never let this
 * import touch a client bundle. The `import "server-only"` guard at the
 * top makes a Next.js bundler error any leak.
 *
 * Use cases (today):
 *   - `auth.admin.inviteUserByEmail` for sending team invitations.
 *
 * Returns null when service-role + URL aren't both configured (eg.
 * local dev without Supabase). Callers should treat null as "skip
 * email send, fall back to manual share-URL".
 */
let _client: SupabaseClient | null | undefined;

export function getSupabaseAdminClient(): SupabaseClient | null {
  if (_client !== undefined) return _client;
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    _client = null;
    return _client;
  }
  _client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _client;
}

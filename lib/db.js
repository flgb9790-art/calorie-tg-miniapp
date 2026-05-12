import { createClient } from "@supabase/supabase-js";
import ws from "ws";

let supabaseClient = null;
let supabaseCacheKey = "";

export function getSupabase() {
  const url = process.env.SUPABASE_URL?.trim();
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key) return null;

  const cacheKey = `${url}::${key}`;
  if (supabaseClient && supabaseCacheKey === cacheKey) {
    return supabaseClient;
  }

  supabaseClient = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      transport: ws,
    },
  });
  supabaseCacheKey = cacheKey;
  return supabaseClient;
}

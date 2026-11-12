/* The React stack talks to the same API with the same identity contract
   as the vanilla frontend: per-tab workspace session from
   sessionStorage, API key and tenant from localStorage. A user can cross
   stacks mid-session without losing their workspace. */

export function sessionId(): string {
  let s = sessionStorage.getItem("slatematch_session_id");
  if (!s) {
    s =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
          });
    sessionStorage.setItem("slatematch_session_id", s);
  }
  return s;
}

export function authHeaders(): Record<string, string> {
  const tn = localStorage.getItem("slate-tenant") || "";
  const k = localStorage.getItem("slate-key") || "";
  return {
    "Content-Type": "application/json",
    "X-Workspace-Session": sessionId(),
    ...(tn ? { "X-Tenant-Id": tn } : {}),
    ...(k ? { "X-API-Key": k } : {}),
  };
}

export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(path, { headers: authHeaders(), ...opts });
  if (!r.ok) throw new Error((await r.text()).slice(0, 300));
  return r.json() as Promise<T>;
}

/** Cents to dollars, identical formatting to the vanilla money(). */
export function money(c: number | null | undefined): string {
  const v = Math.abs(c || 0) / 100;
  const s = v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (c || 0) < 0 ? "-$" + s : "$" + s;
}

/** Mirrors aiModeLabel() in the vanilla state.js. */
export function aiModeLabel(configured: boolean, lastErr: string | null | undefined): string {
  if (!configured) return "Deterministic Verifier Fallback Active (No AI Key)";
  if (lastErr)
    return /429|quota|rate limit/i.test(lastErr)
      ? "Deterministic Verifier Fallback Active (Quota-Safe Mode)"
      : "Gemini configured - last call failed (see diagnostics)";
  return "Gemini live";
}

export interface RunSummary {
  run_id: string;
  created_at?: string;
  status?: string;
  matches?: number;
  payments?: number;
  auto_posted?: number;
  exceptions?: number;
}

export interface MatchLine {
  net_cents: number;
  invoice_id?: string;
}

export interface MatchRecord {
  payment_id: string;
  status: string;
  residual_cents: number;
  result?: {
    lines?: MatchLine[];
    latency_ms?: number;
    auto_posted?: boolean;
    deduction?: {
      autonomous_action?: string;
      expected_recovery_value_usd?: number;
    };
  };
}

export interface WorkspaceState {
  run_status?: string;
  staged_payments?: number;
  staged_payment_total_cents?: number;
  case?: unknown;
  latest_run?: unknown;
}

export interface Health {
  status: string;
  gemini_configured: boolean;
  gemini_last_error?: string | null;
}

import { useEffect, useState } from "react";
import { api, sessionId } from "../lib/api";

/* Stage 6 (Item 5): the demo workspace block - vanilla's bar1r
   tenant selector and session chip (insight.js loadTenants,
   livecube.css .tenantsel / .sesschip). In vanilla's wide layout
   the topbar becomes the left rail and this block sits in it,
   under the brand; Stage 5C had the tenant select in the casebar
   instead, and Harsha's Stage 6 order puts the workspace back in
   the sidebar. The casebar keeps only the case selector.
   Measured vanilla values (Stage 6 probe): the select is a 999px
   pill, background #1c1c1c, border --line2, JetBrains Mono 600
   11px, colour --mut, padding 5px 9px; the chip reads
   "SESSION " + the session id's first 8 characters, uppercased,
   mono 600 10.5px in --mut. Tenant switching keeps its existing
   semantics exactly: the choice is stored and the app reloads,
   because every view caches its own reads. */

interface TenantInfo {
  tenants: { id: string; name: string; erp: string }[];
  active: string;
  switching_enabled: boolean;
  session?: string;
}

export default function WorkspaceBlock({
  toast,
}: {
  toast: (m: string) => void;
}) {
  const [tenants, setTenants] = useState<TenantInfo | null>(null);

  useEffect(() => {
    api<TenantInfo>("/api/v1/tenants/demo")
      .then(setTenants)
      .catch(() => setTenants(null));
  }, []);

  const switchTenant = (id: string) => {
    if (!id) return;
    try {
      localStorage.setItem("slate-tenant", id);
    } catch {
      /* ignore */
    }
    toast(
      "Tenant switched - each tenant has its own database, so this workspace shows only that tenant's data"
    );
    // The React views cache their own reads; a reload is the honest
    // way to guarantee no surface keeps the old tenant's figures.
    setTimeout(() => window.location.reload(), 350);
  };

  const tenantVal =
    tenants?.active ||
    (typeof localStorage !== "undefined"
      ? localStorage.getItem("slate-tenant") || ""
      : "");
  const chip =
    "SESSION " +
    (tenants?.session || sessionId()).slice(0, 8).toUpperCase();

  return (
    <div className="px-4 pt-1 pb-3">
      <label className="flex items-center gap-[7px] font-mono text-[10.5px] font-semibold tracking-[0.06em] text-mut">
        TENANT
        <select
          className="flex-1 min-w-0 bg-[#1c1c1c] border border-line2 rounded-[999px] px-[9px] py-[5px] font-mono text-[11px] font-semibold text-mut cursor-pointer"
          aria-label="Tenant"
          value={tenantVal}
          disabled={tenants ? !tenants.switching_enabled : false}
          title={
            tenants && !tenants.switching_enabled
              ? "Tenant switching is off when API keys are issued - the key decides the tenant"
              : "Tenant - every tenant has its own database; nothing crosses"
          }
          onChange={(e) => switchTenant(e.target.value)}
        >
          {(tenants?.tenants || []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} - {t.erp}
            </option>
          ))}
          {!tenants && (
            <option value="demo">Demo workspace - US - SAP S/4HANA</option>
          )}
        </select>
      </label>
      <div className="font-mono text-[10.5px] font-semibold tracking-[0.06em] text-mut mt-[7px]">
        {chip}
      </div>
    </div>
  );
}

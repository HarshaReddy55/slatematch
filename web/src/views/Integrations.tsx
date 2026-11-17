import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useWsRefresh } from "../lib/chrome";
import Panel from "../ui/Panel";
import Pill from "../ui/Pill";
import DataTable, { Row, Td, Th } from "../ui/DataTable";
import ViewHead, { LoadError } from "../ui/ViewHead";
import ViewSkeleton from "../ui/Skeleton";
import { Rise } from "../ui/motion";
import { GhostBtn } from "../ui/Stage3";

/* Integrations (15): every connection the platform has to the
   outside world in one place - the SAP write-back connection
   and its transmission log, outbound webhooks with their
   delivery record, the inbound feeds, and the payer portal
   links. Moved out of Agent Health and the SAP view so each
   connection can be seen, set and audited on its own page. */

interface Transmission {
  transmission_id: string;
  payment_id: string;
  document_number: string;
  mode: string;
  status: string;
  sap_document_number: string | null;
  detail: string;
  created_at: string;
}
interface WebhookRow { webhook_id: string; url: string; events: string; active: boolean }
interface DeliveryRow {
  id: number; webhook_id: string; event: string;
  status_code: number | null; ok: boolean; error: string; created_at: string;
}
interface FeedEventRow { id: number; kind: string; summary: string; created_at: string }
interface PortalLink { link_id: string; customer: string; revoked: boolean }

interface Settings { sap_mode: string; sap_endpoint: string; erp_target: string }
interface VaRow { customer: string; virtual_account: string; instruction: string }

export default function Integrations() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mode, setMode] = useState("simulated");
  const [endpoint, setEndpoint] = useState("");
  const [target, setTarget] = useState("sap");
  const [slackUrl, setSlackUrl] = useState("");
  const [teamsUrl, setTeamsUrl] = useState("");
  const [chatNote, setChatNote] = useState("");
  const [vaRows, setVaRows] = useState<VaRow[]>([]);
  const [pullUrl, setPullUrl] = useState("");
  const [pullNote, setPullNote] = useState("");
  const [settingsNote, setSettingsNote] = useState("");
  const [transmissions, setTransmissions] = useState<Transmission[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [feedEvents, setFeedEvents] = useState<FeedEventRow[]>([]);
  const [portalLinks, setPortalLinks] = useState<PortalLink[]>([]);
  const [error, setError] = useState("");
  const [hookUrl, setHookUrl] = useState("");
  const [hookEvents, setHookEvents] = useState("run.completed");
  const [hookNote, setHookNote] = useState("");
  const [portalCustomer, setPortalCustomer] = useState("");
  const [portalUrl, setPortalUrl] = useState("");
  const [portalNote, setPortalNote] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    setError("");
    Promise.all([
      api<Settings>("/api/v1/integrations/settings"),
      api<{ transmissions: Transmission[] }>("/api/v1/erp/transmissions"),
      api<{ webhooks: WebhookRow[]; deliveries: DeliveryRow[] }>("/api/v1/webhooks"),
      api<{ events: FeedEventRow[] }>("/api/v1/feeds/events"),
      api<{ links: PortalLink[] }>("/api/v1/portal-links"),
      api<{ slack_url: string; teams_url: string }>("/api/v1/integrations/chat").catch(() => ({ slack_url: "", teams_url: "" })),
      api<{ accounts: VaRow[] }>("/api/v1/virtual-accounts").catch(() => ({ accounts: [] })),
    ])
      .then(([s, t, w, f, p, ch, va]) => {
        setSettings(s);
        setMode(s.sap_mode);
        setEndpoint(s.sap_endpoint || "");
        setTarget(s.erp_target || "sap");
        setTransmissions(t.transmissions || []);
        setWebhooks(w.webhooks || []);
        setDeliveries(w.deliveries || []);
        setFeedEvents(f.events || []);
        setPortalLinks(p.links || []);
        setSlackUrl(ch.slack_url || "");
        setTeamsUrl(ch.teams_url || "");
        setVaRows(va.accounts || []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);
  useWsRefresh(load);

  const saveSettings = async () => {
    setSettingsNote("");
    try {
      const s = await api<Settings>(
        "/api/v1/integrations/settings",
        { method: "PUT", body: JSON.stringify({ sap_mode: mode, sap_endpoint: endpoint, erp_target: target }) }
      );
      setSettings(s);
      setSettingsNote("Saved.");
    } catch (e) {
      setSettingsNote(e instanceof Error ? e.message : String(e));
    }
  };

  const saveChat = async () => {
    setChatNote("");
    try {
      await api("/api/v1/integrations/chat",
        { method: "PUT", body: JSON.stringify({ slack_url: slackUrl, teams_url: teamsUrl }) });
      setChatNote("Saved. Held payments will be summarised there after each run.");
    } catch (e) {
      setChatNote(e instanceof Error ? e.message : String(e));
    }
  };

  const testChat = async () => {
    setChatNote("");
    try {
      const r = await api<{ sent_to: string[] }>("/api/v1/integrations/chat/test", { method: "POST" });
      setChatNote("Test message sent to: " + (r.sent_to || []).join(", ") + ".");
    } catch (e) {
      setChatNote(e instanceof Error ? e.message : String(e));
    }
  };

  const pullBank = async () => {
    setPullNote("");
    try {
      const r = await api<{ format: string; imported: number }>("/api/v1/feeds/bank/pull",
        { method: "POST", body: JSON.stringify({ url: pullUrl }) });
      setPullNote(`Pulled a ${r.format} file: ${r.imported} payment(s) staged and run.`);
      load();
    } catch (e) {
      setPullNote(e instanceof Error ? e.message : String(e));
    }
  };

  const copyPortal = () => {
    if (!portalUrl) return;
    navigator.clipboard?.writeText(portalUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  if (error) return <LoadError error={error} />;
  if (!settings) return <ViewSkeleton kind="panels" />;

  return (
    <>
      <ViewHead
        eyebrow="CONNECTIONS - 15 / INTEGRATIONS"
        title="Integrations"
        purpose="Every connection to the outside world: the SAP write-back connection and its transmission log, outbound webhooks with their delivery record, the inbound remittance feed, and the payer portal links."
        onRefresh={load}
      />

      <Rise i={0}>
        <Panel
          title="ERP write-back connection"
          sub="One balanced journal, three envelopes: SAP BAPI, Oracle journal import, NetSuite journal entry. Simulated mode validates the payload the way the target system would (balanced lines above all) and assigns a target-prefixed simulated number - labelled simulated everywhere, no real ERP claimed. HTTP mode posts the payload to your endpoint and records the real answer, failures included. Transmit individual documents from the SAP view (05)."
        >
          <div className="flex items-end gap-2 flex-wrap mt-2">
            <label className="flex flex-col gap-1 text-[12px] text-mut">
              Target system
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="bg-panel2 border border-line text-ink text-[13px] px-2.5 py-1.5"
              >
                <option value="sap">SAP (BAPI)</option>
                <option value="oracle">Oracle ERP</option>
                <option value="netsuite">NetSuite</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-mut">
              Mode
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                className="bg-panel2 border border-line text-ink text-[13px] px-2.5 py-1.5"
              >
                <option value="simulated">Simulated connection</option>
                <option value="http">HTTP endpoint</option>
              </select>
            </label>
            {mode === "http" && (
              <label className="flex flex-col gap-1 text-[12px] text-mut">
                Endpoint URL
                <input
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://sap-gateway.example/post"
                  className="bg-panel2 border border-line text-ink text-[13px] px-2.5 py-1.5 w-[320px]"
                />
              </label>
            )}
            <GhostBtn onClick={saveSettings}>Save connection</GhostBtn>
            {settings.sap_mode === "http" ? (
              <Pill kind="info">HTTP - {settings.sap_endpoint}</Pill>
            ) : (
              <Pill kind="warn">SIMULATED CONNECTION</Pill>
            )}
            {settingsNote && <span className="text-[12.5px] text-mut">{settingsNote}</span>}
          </div>
          {transmissions.length > 0 ? (
            <DataTable
              head={
                <>
                  <Th>Payment</Th>
                  <Th>Document</Th>
                  <Th>Mode</Th>
                  <Th>Status</Th>
                  <Th>SAP document</Th>
                  <Th>Detail</Th>
                </>
              }
            >
              {transmissions.map((t) => (
                <Row key={t.transmission_id}>
                  <Td className="font-mono text-[12px]">{t.payment_id}</Td>
                  <Td className="font-mono text-[12px]">{t.document_number}</Td>
                  <Td>{t.mode}</Td>
                  <Td>
                    <Pill kind={t.status === "FAILED" ? "bad" : t.status === "SENT" ? "ok" : "warn"}>
                      {t.status}
                    </Pill>
                  </Td>
                  <Td className="font-mono text-[12px]">{t.sap_document_number || "-"}</Td>
                  <Td className="text-[12px] text-mut">{t.detail}</Td>
                </Row>
              ))}
            </DataTable>
          ) : (
            <p className="text-sm text-mut mb-0 mt-3">
              No transmissions yet. Clear a payment, then transmit it from the SAP view.
            </p>
          )}
        </Panel>
      </Rise>

      <Rise i={1}>
        <Panel
          title="Webhooks - tell your other systems"
          sub="Fires on run completion, approval decisions, dispute transitions and reversals. Delivery is asynchronous and best-effort - a webhook can never block or fail the operation that fired it - and every attempt is logged with its real outcome. Private and loopback URLs are refused."
        >
          <div className="flex items-end gap-2 flex-wrap mt-2">
            <label className="flex flex-col gap-1 text-[12px] text-mut">
              Webhook URL
              <input
                value={hookUrl}
                onChange={(e) => setHookUrl(e.target.value)}
                placeholder="https://your-system.example/hook"
                className="bg-panel2 border border-line text-ink text-[13px] px-2.5 py-1.5 w-[300px]"
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-mut">
              Events
              <select
                value={hookEvents}
                onChange={(e) => setHookEvents(e.target.value)}
                className="bg-panel2 border border-line text-ink text-[13px] px-2.5 py-1.5"
              >
                <option value="run.completed">Run completed</option>
                <option value="approval.decided">Approval decided</option>
                <option value="dispute.transitioned">Dispute transitioned</option>
                <option value="match.reversed">Match reversed</option>
                <option value="all">All events</option>
              </select>
            </label>
            <GhostBtn
              onClick={async () => {
                setHookNote("");
                try {
                  await api("/api/v1/webhooks", {
                    method: "POST",
                    body: JSON.stringify({ url: hookUrl, events: hookEvents }),
                  });
                  setHookUrl("");
                  load();
                } catch (e) {
                  setHookNote(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              Add webhook
            </GhostBtn>
            {hookNote && <span className="text-[12.5px] text-mut">{hookNote}</span>}
          </div>
          {webhooks.length > 0 && (
            <DataTable
              head={
                <>
                  <Th>URL</Th>
                  <Th>Events</Th>
                  <Th>{""}</Th>
                </>
              }
            >
              {webhooks.map((w) => (
                <Row key={w.webhook_id}>
                  <Td className="font-mono text-[12px]">{w.url}</Td>
                  <Td>{w.events}</Td>
                  <Td>
                    <GhostBtn
                      onClick={async () => {
                        await api(`/api/v1/webhooks/${w.webhook_id}`, { method: "DELETE" }).catch(() => {});
                        load();
                      }}
                    >
                      Remove
                    </GhostBtn>
                  </Td>
                </Row>
              ))}
            </DataTable>
          )}
          {deliveries.length > 0 && (
            <>
              <p className="text-[13px] m-0 mt-4 mb-1"><b>Recent deliveries</b></p>
              <DataTable
                head={
                  <>
                    <Th>Event</Th>
                    <Th>HTTP</Th>
                    <Th>Outcome</Th>
                    <Th>When</Th>
                  </>
                }
              >
                {deliveries.slice(0, 8).map((d) => (
                  <Row key={d.id}>
                    <Td>{d.event}</Td>
                    <Td>{d.status_code ?? "-"}</Td>
                    <Td>
                      <Pill kind={d.ok ? "ok" : "bad"}>{d.ok ? "DELIVERED" : "FAILED"}</Pill>
                      {d.error ? <span className="block text-[11.5px] text-mut mt-1">{d.error}</span> : null}
                    </Td>
                    <Td className="font-mono text-[11.5px]">{d.created_at.slice(0, 19).replace("T", " ")}</Td>
                  </Row>
                ))}
              </DataTable>
            </>
          )}
          {!webhooks.length && (
            <p className="text-sm text-mut mb-0 mt-2">No webhooks registered yet.</p>
          )}
        </Panel>
      </Rise>

      <Rise i={2}>
        <Panel
          title="Inbound feed - remittance mailbox"
          sub="An inbound-email service posts advices to POST /api/v1/feeds/remittance; each one is parsed, staged into the workspace and reconciled on the next run. Portal activity (remittance, promises, dispute responses) arrives on the same feed."
        >
          {feedEvents.length > 0 ? (
            feedEvents.slice(0, 10).map((f) => (
              <p key={f.id} className="text-[12.5px] text-mut m-0 mt-1.5">
                <span className="font-mono text-[11.5px]">{f.created_at.slice(0, 19).replace("T", " ")}</span>{" "}
                - {f.kind} - {f.summary}
              </p>
            ))
          ) : (
            <p className="text-sm text-mut mb-0 mt-2">No feed events yet.</p>
          )}
        </Panel>
      </Rise>

      <Rise i={3}>
        <Panel
          title="Payer portal links"
          sub="A portal link shows one customer only their own open invoices, payment statuses and disputes, and lets them send remittance advice, promise a payment date, and respond to a deduction claim. The token is stored hashed and the full link is shown once - share it only with that customer. Revoking is immediate."
        >
          <div className="flex items-end gap-2 flex-wrap mt-2">
            <label className="flex flex-col gap-1 text-[12px] text-mut">
              Customer name (exactly as on their invoices)
              <input
                value={portalCustomer}
                onChange={(e) => setPortalCustomer(e.target.value)}
                placeholder="e.g. BluePeak Electronics"
                className="bg-panel2 border border-line text-ink text-[13px] px-2.5 py-1.5 w-[300px]"
              />
            </label>
            <GhostBtn
              onClick={async () => {
                setPortalNote("");
                setPortalUrl("");
                try {
                  const d = await api<{ url: string }>("/api/v1/portal-links", {
                    method: "POST",
                    body: JSON.stringify({ customer: portalCustomer }),
                  });
                  setPortalUrl(window.location.origin + d.url);
                  setPortalCustomer("");
                  load();
                } catch (e) {
                  setPortalNote(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              Create portal link
            </GhostBtn>
            {portalNote && <span className="text-[12.5px] text-mut">{portalNote}</span>}
          </div>
          {portalUrl && (
            <div className="mt-3 border border-line bg-panel2 px-3 py-2.5">
              <p className="text-[13px] m-0">
                <b>Portal link created</b> (shown once):{" "}
                <span className="font-mono text-[12px] break-all">{portalUrl}</span>
              </p>
              <div className="flex gap-2 flex-wrap mt-2">
                <GhostBtn onClick={() => window.open(portalUrl, "_blank")}>
                  Open portal
                </GhostBtn>
                <GhostBtn onClick={copyPortal}>
                  {copied ? "Copied" : "Copy link"}
                </GhostBtn>
              </div>
            </div>
          )}
          {portalLinks.length > 0 && (
            <DataTable
              head={
                <>
                  <Th>Link</Th>
                  <Th>Customer</Th>
                  <Th>Status</Th>
                  <Th>{""}</Th>
                </>
              }
            >
              {portalLinks.map((l) => (
                <Row key={l.link_id}>
                  <Td className="font-mono text-[12px]">{l.link_id}</Td>
                  <Td>{l.customer}</Td>
                  <Td>
                    <Pill kind={l.revoked ? "bad" : "ok"}>
                      {l.revoked ? "REVOKED" : "ACTIVE"}
                    </Pill>
                  </Td>
                  <Td>
                    {!l.revoked && (
                      <GhostBtn
                        onClick={async () => {
                          await api(`/api/v1/portal-links/${l.link_id}`, { method: "DELETE" }).catch(() => {});
                          load();
                        }}
                      >
                        Revoke
                      </GhostBtn>
                    )}
                  </Td>
                </Row>
              ))}
            </DataTable>
          )}
        </Panel>
      </Rise>

      <Rise i={4}>
        <Panel
          title="Chat approvals - Slack and Teams"
          sub="Register an incoming-webhook URL per channel. After any run that leaves payments waiting, the held items are summarised in chat with a pointer back here - the decision itself stays in the console (interactive chat buttons need a vendor app registration, which this does not pretend to be). Private and loopback URLs are refused."
        >
          <div className="flex items-end gap-2 flex-wrap mt-2">
            <label className="flex flex-col gap-1 text-[12px] text-mut">
              Slack webhook URL
              <input
                value={slackUrl}
                onChange={(e) => setSlackUrl(e.target.value)}
                placeholder="https://hooks.slack.com/services/..."
                className="bg-panel2 border border-line text-ink text-[13px] px-2.5 py-1.5 w-[320px]"
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-mut">
              Teams webhook URL
              <input
                value={teamsUrl}
                onChange={(e) => setTeamsUrl(e.target.value)}
                placeholder="https://outlook.office.com/webhook/..."
                className="bg-panel2 border border-line text-ink text-[13px] px-2.5 py-1.5 w-[320px]"
              />
            </label>
            <GhostBtn onClick={saveChat}>Save chat targets</GhostBtn>
            <GhostBtn onClick={testChat}>Send a test message</GhostBtn>
            {chatNote && <span className="text-[12.5px] text-mut">{chatNote}</span>}
          </div>
        </Panel>
      </Rise>

      <Rise i={5}>
        <Panel
          title="Virtual accounts and the bank feed"
          sub="One virtual account number per customer - print it on the invoice and the payer is identified the second money lands. The numbers are derived per customer and stable across calls; a bank issues the underlying accounts, this registry is the instruction sheet. The feed pull fetches a BAI2, MT940 or camt.054 file from a URL and runs it through the lockbox import - a scheduler calls it on a cadence."
        >
          {vaRows.length > 0 ? (
            <DataTable
              head={<><Th>Customer</Th><Th>Virtual account</Th><Th>Instruction</Th></>}
            >
              {vaRows.map((v) => (
                <Row key={v.customer}>
                  <Td><b>{v.customer}</b></Td>
                  <Td><span className="font-mono">{v.virtual_account}</span></Td>
                  <Td>{v.instruction}</Td>
                </Row>
              ))}
            </DataTable>
          ) : (
            <p className="text-[13px] text-mut m-0 mt-2">No customers yet - virtual accounts appear with the ledger.</p>
          )}
          <div className="flex items-end gap-2 flex-wrap mt-3">
            <label className="flex flex-col gap-1 text-[12px] text-mut">
              Bank feed URL
              <input
                value={pullUrl}
                onChange={(e) => setPullUrl(e.target.value)}
                placeholder="https://bank.example/feeds/lockbox.bai2"
                className="bg-panel2 border border-line text-ink text-[13px] px-2.5 py-1.5 w-[320px]"
              />
            </label>
            <GhostBtn onClick={pullBank}>Pull the feed now</GhostBtn>
            {pullNote && <span className="text-[12.5px] text-mut">{pullNote}</span>}
          </div>
        </Panel>
      </Rise>
    </>
  );
}

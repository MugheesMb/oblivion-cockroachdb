import { useState, useEffect, useRef, useCallback } from "react";
import {
  Shield, ShieldCheck, ShieldAlert, Clock, Link2, Unlink,
  Database, Server, HardDrive, Search, Send, ChevronRight,
  AlertTriangle, CheckCircle2, XCircle, Lock, Zap, Cpu, Cloud
} from "lucide-react";

const TENANT_COLOR = {
  "Vueling Ops": "#E8B339",
  "Northwind Retail": "#6E8BFF",
  "Halden Health": "#5EEAD4",
};

function initials(name) {
  return name.split(" ").map(p => p[0]).join("").slice(0, 2).toUpperCase();
}

function tsNow(offsetSec = 0) {
  return new Date(Date.now() - offsetSec * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

/* ---------------------------------------------------------
   OBLIVION — Compliance Control Tower for Agentic Memory
   Design tokens
   bg-ink      #0A0E14   deep near-black, cool
   bg-panel    #10151E   panel surface
   bg-panel-2  #161C28   raised panel
   line        #232B3A   hairline borders
   text-hi     #E6EAF2
   text-lo     #7C8598
   verified    #3DDC97   (teal-green, "confirmed purged")
   pending     #E8B339   (amber, "SLA at risk")
   breach      #E8546B   (rose, "violation / tamper")
   held        #6E8BFF   (periwinkle, "legal hold / retained")
   accent      #5EEAD4   (signature cyan — the ledger chain)
   mono font for data, Inter-ish sans for UI
--------------------------------------------------------- */

const TENANTS = ["Vueling Ops", "Northwind Retail", "Halden Health"];

const INITIAL_USERS = [
  { id: "usr_4471", name: "M. Ferreira", tenant: "Vueling Ops", touchpoints: 5, status: "active" },
  { id: "usr_2290", name: "K. Solberg", tenant: "Northwind Retail", touchpoints: 4, status: "active" },
  { id: "usr_8813", name: "R. Okonjo", tenant: "Halden Health", touchpoints: 6, status: "held" },
];

const TOUCHPOINT_TYPES = [
  { key: "convo", label: "Conversation log", icon: Database },
  { key: "embed", label: "Vector embedding", icon: Zap },
  { key: "s3", label: "S3 artifact", icon: HardDrive },
  { key: "billing", label: "Billing record", icon: Server },
  { key: "contract", label: "Co-signed contract", icon: Link2 },
];

function makeTouchpoints(user) {
  const base = [
    { type: "convo", status: "active", note: "3 support sessions" },
    { type: "embed", status: "active", note: "12 vectors, C-SPANN idx" },
    { type: "s3", status: "active", note: "2 transcripts" },
  ];
  if (user.touchpoints >= 4) base.push({ type: "billing", status: "active", note: "refund #4471" });
  if (user.touchpoints >= 5) base.push({ type: "contract", status: user.status === "held" ? "held" : "active", note: "co-signed w/ usr_2290" });
  if (user.touchpoints >= 6) base.push({ type: "billing", status: "held", note: "7yr statutory retention" });
  return base;
}

function hashLike(seed) {
  let h = 0;
  const s = String(seed) + Date.now();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0").slice(0, 8);
}

const INITIAL_CHAIN = [
  { id: 1, hash: "9f2a1c04", prev: "00000000", event: "cluster.init", tampered: false, ts: tsNow(41 * 60) },
  { id: 2, hash: "3b8e77d1", prev: "9f2a1c04", event: "retention_policy.applied · billing:7y", tampered: false, ts: tsNow(33 * 60) },
  { id: 3, hash: "c14a90ef", prev: "3b8e77d1", event: "user.usr_1190 · purge.complete", tampered: false, ts: tsNow(19 * 60) },
];

const ANN_CORPUS = [
  { id: "v_1", label: "usr_4471 · support transcript", dist: 0.041 },
  { id: "v_2", label: "usr_2290 · refund note", dist: 0.089 },
  { id: "v_3", label: "usr_7712 · onboarding chat", dist: 0.114 },
  { id: "v_4", label: "usr_8813 · intake form", dist: 0.132 },
  { id: "v_5", label: "usr_4471 · booking change", dist: 0.157 },
];

const API_BASE = "http://localhost:8000";

async function apiGet(path) {
  try {
    const r = await fetch(`${API_BASE}${path}`);
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  } catch (e) {
    console.warn(`API unreachable (${path}), using mock data:`, e.message);
    return null;
  }
}

async function apiPost(path, body) {
  try {
    const r = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  } catch (e) {
    console.warn(`API unreachable (${path}), using mock logic:`, e.message);
    return null;
  }
}

export default function ObliviondDashboard() {
  const [tenant, setTenant] = useState(TENANTS[0]);
  const [users, setUsers] = useState(INITIAL_USERS);
  const [selectedId, setSelectedId] = useState(INITIAL_USERS[0].id);
  const [touchpoints, setTouchpoints] = useState(() =>
    Object.fromEntries(INITIAL_USERS.map(u => [u.id, makeTouchpoints(u)]))
  );
  const [phase, setPhase] = useState("idle"); // idle | running | done
  const [cascadeStep, setCascadeStep] = useState(-1);
  const [chain, setChain] = useState(INITIAL_CHAIN);
  const [annBefore, setAnnBefore] = useState(ANN_CORPUS);
  const [annAfter, setAnnAfter] = useState(null);
  const [tamperedBlock, setTamperedBlock] = useState(null);
  const [refusal, setRefusal] = useState(null);
  const [chat, setChat] = useState([
    { role: "system", text: "Ledger online. Ask about any user, request, or SLA state." }
  ]);
  const [chatInput, setChatInput] = useState("");
  const [slaNow, setSlaNow] = useState(Date.now());
  const logRef = useRef(null);

  const selectedUser = users.find(u => u.id === selectedId);
  const tps = touchpoints[selectedId] || [];

  const [slaQueue, setSlaQueue] = useState([
    { id: "req_9001", user: "usr_4471", deadline: Date.now() + 1000 * 46, tenant: "Vueling Ops" },
    { id: "req_9002", user: "usr_2290", deadline: Date.now() + 1000 * 118, tenant: "Northwind Retail" },
    { id: "req_9003", user: "usr_8813", deadline: Date.now() + 1000 * 210, tenant: "Halden Health" },
  ]);

  useEffect(() => {
    const t = setInterval(() => setSlaNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [chat]);

  const [liveMode, setLiveMode] = useState(false);

  useEffect(() => {
    (async () => {
      const liveUsers = await apiGet("/users");
      const liveChain = await apiGet("/chain");
      const liveQueue = await apiGet("/sla-queue");

      if (liveUsers && liveChain && liveQueue) {
        setLiveMode(true);

        setUsers(liveUsers.map(u => ({
          id: u.id, name: u.name, tenant: u.tenant,
          touchpoints: u.touchpoints.length,
          status: u.touchpoints.every(t => t.status === "purged" || t.status === "held")
            && u.touchpoints.some(t => t.status === "purged")
            && !u.touchpoints.some(t => t.status === "active")
            ? "purged" : (u.touchpoints.some(t => t.status === "held") ? "held" : "active"),
        })));

        setTouchpoints(Object.fromEntries(
          liveUsers.map(u => [u.id, u.touchpoints.map(t => ({
            type: t.type, status: t.status, note: t.note,
          }))])
        ));

        setChain(liveChain.map(b => ({
          id: b.id, hash: b.hash.slice(0, 8), prev: b.prev_hash.slice(0, 8),
          event: b.event, tampered: false,
          ts: new Date(b.ts).toISOString().replace("T", " ").slice(0, 19) + "Z",
        })));

        setSlaQueue(liveQueue.map(r => ({
          id: r.id.slice(0, 8), user: r.user_id,
          deadline: new Date(r.deadline).getTime(),
          tenant: liveUsers.find(u => u.id === r.user_id)?.tenant || "",
        })));
      }
    })();
  }, []);

  const refreshLedgerState = useCallback(async () => {
    const liveChain = await apiGet("/chain");
    const liveQueue = await apiGet("/sla-queue");
    if (liveChain) {
      setChain(liveChain.map(b => ({
        id: b.id, hash: b.hash.slice(0, 8), prev: b.prev_hash.slice(0, 8),
        event: b.event, tampered: false,
        ts: new Date(b.ts).toISOString().replace("T", " ").slice(0, 19) + "Z",
      })));
    }
    if (liveQueue) {
      setSlaQueue(liveQueue.map(r => ({
        id: r.id.slice(0, 8), user: r.user_id,
        deadline: new Date(r.deadline).getTime(),
        tenant: users.find(u => u.id === r.user_id)?.tenant || "",
      })));
    }
  }, [users]);

  const runPurge = useCallback(async () => {
    if (phase === "running" || !selectedUser) return;

    if (liveMode) {
      setPhase("running");
      setCascadeStep(0);
      setAnnAfter(null);
      const steps = [0, 1, 2, 3];
      for (const s of steps) {
        await new Promise(res => setTimeout(res, 500));
        setCascadeStep(s);
      }
      const result = await apiPost(`/purge/${selectedUser.id}`);
      if (result?.status === "refused") {
        setRefusal({ user: selectedUser.id, reason: result.reason });
        setPhase("idle");
        setCascadeStep(-1);
        await refreshLedgerState();
        return;
      }
      setRefusal(null);
      const liveUsers = await apiGet("/users");
      if (liveUsers) {
        const u = liveUsers.find(x => x.id === selectedUser.id);
        if (u) {
          setTouchpoints(prev => ({
            ...prev,
            [selectedUser.id]: u.touchpoints.map(t => ({ type: t.type, status: t.status, note: t.note })),
          }));
          const done = u.touchpoints.every(t => t.status !== "active");
          setUsers(us => us.map(x => x.id === selectedUser.id ? { ...x, status: done ? "purged" : x.status } : x));
        }
      }
      const liveAnn = await apiGet(`/ann?exclude_user=${selectedUser.id}`);
      if (liveAnn) setAnnAfter(liveAnn.map(v => ({ id: `${v.user_id}-${v.type}`, label: `${v.user_id} · ${v.note}`, dist: v.dist })));
      await refreshLedgerState();
      setPhase("done");
      return;
    }

    // --- mock fallback path (API not reachable) ---
    if (selectedUser.status === "held") {
      setRefusal({
        user: selectedUser.id,
        reason: "Legal hold: billing record under 7-year statutory retention (retention_policies.class = 'financial')",
      });
      setChain(c => [...c, {
        id: c.length + 1,
        hash: hashLike(c.length + 1),
        prev: c[c.length - 1].hash,
        event: `deletion.refused · ${selectedUser.id} · retention_hold`,
        tampered: false,
        ts: tsNow(0),
      }]);
      return;
    }

    setRefusal(null);
    setPhase("running");
    setCascadeStep(0);
    setAnnAfter(null);

    const steps = [0, 1, 2, 3];
    steps.forEach((s, i) => {
      setTimeout(() => {
        setCascadeStep(s);
        setTouchpoints(prev => {
          const list = [...(prev[selectedUser.id] || [])];
          const targetType = ["convo", "embed", "s3", "billing"][s];
          return {
            ...prev,
            [selectedUser.id]: list.map(t =>
              t.type === targetType && t.status !== "held" ? { ...t, status: "purged" } : t
            ),
          };
        });
        if (s === 1) {
          setAnnAfter(ANN_CORPUS.filter(v => !v.label.startsWith(selectedUser.id)));
        }
        if (s === 3) {
          setTimeout(() => {
            setChain(c => [...c, {
              id: c.length + 1,
              hash: hashLike(c.length + 1),
              prev: c[c.length - 1].hash,
              event: `user.${selectedUser.id} · purge.complete · 4/4 legs verified`,
              tampered: false,
              ts: tsNow(0),
            }]);
            setPhase("done");
            setSlaQueue(q => q.filter(r => r.user !== selectedUser.id));
            setUsers(u => u.map(x => x.id === selectedUser.id ? { ...x, status: "purged" } : x));
          }, 500);
        }
      }, i * 700);
    });
  }, [phase, selectedUser, liveMode, refreshLedgerState]);

  const toggleTamper = (id) => {
    setChain(c => c.map(b => b.id === id ? { ...b, tampered: !b.tampered } : b));
    setTamperedBlock(prev => prev === id ? null : id);
  };

  const brokenFrom = chain.findIndex(b => b.tampered);

  const askLedger = async () => {
    if (!chatInput.trim()) return;
    const q = chatInput.trim();
    setChat(c => [...c, { role: "user", text: q }]);
    setChatInput("");

    if (liveMode) {
      const result = await apiPost("/ask", { query: q });
      setChat(c => [...c, { role: "system", text: result?.answer || "Ledger query failed — check the API connection." }]);
      return;
    }

    setTimeout(() => {
      let answer;
      const lower = q.toLowerCase();
      const target = users.find(u => lower.includes(u.id.replace("usr_", "")) || lower.includes(u.name.split(" ")[1]?.toLowerCase() || "___"));
      if (lower.includes("breach") || lower.includes("sla")) {
        const risky = slaQueue.filter(r => r.deadline - slaNow < 60000);
        answer = risky.length
          ? `${risky.length} request(s) inside 60s of SLA breach: ${risky.map(r => r.id).join(", ")}.`
          : "No requests currently inside SLA breach risk window.";
      } else if (target) {
        const tp = touchpoints[target.id] || [];
        const purged = tp.filter(t => t.status === "purged").length;
        const held = tp.filter(t => t.status === "held").length;
        answer = target.status === "purged"
          ? `${target.id} is fully purged. ${purged}/${tp.length} touchpoints cleared, 0 recoverable vectors.`
          : held > 0
            ? `${target.id} has ${held} record(s) under legal hold — cannot be purged until retention expires. ${purged}/${tp.length} other touchpoints clear.`
            : `${target.id} still has ${tp.length - purged}/${tp.length} active touchpoints.`;
      } else if (lower.includes("chain") || lower.includes("hash") || lower.includes("tamper")) {
        answer = brokenFrom >= 0
          ? `Chain integrity BROKEN at block #${chain[brokenFrom].id}. All blocks after this point are unverifiable.`
          : `Chain integrity verified. ${chain.length} blocks, hashes link cleanly.`;
      } else {
        answer = "I can answer questions about a specific user (e.g. \"is usr_4471 purged?\"), SLA breach risk, or chain integrity.";
      }
      setChat(c => [...c, { role: "system", text: answer }]);
    }, 450);
  };

  const statusColor = (s) =>
    s === "purged" ? "#3DDC97" : s === "held" ? "#6E8BFF" : s === "pending" ? "#E8B339" : "#7C8598";

  return (
    <div style={{ background: "#0A0E14", color: "#E6EAF2", fontFamily: "'Inter', ui-sans-serif, system-ui", minHeight: "100%" }} className="w-full min-h-screen text-sm">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap');
        html, body, #root { margin: 0; padding: 0; width: 100%; min-height: 100vh; background: #0A0E14; }
        * { box-sizing: border-box; }
        .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
        .hairline { border-color: #232B3A; }
        @keyframes pulseRing { 0% { box-shadow: 0 0 0 0 rgba(94,234,212,0.5);} 100% { box-shadow: 0 0 0 8px rgba(94,234,212,0);} }
        .pulse { animation: pulseRing 1.4s ease-out infinite; }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(4px);} to { opacity:1; transform: translateY(0);} }
        .fade-up { animation: fadeUp .35s ease-out; }
      `}</style>

      {/* Topbar */}
      <div className="flex items-center justify-between px-6 py-3 border-b hairline" style={{ background: "#10151E" }}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-md flex items-center justify-center" style={{ background: "#161C28", border: "1px solid #232B3A" }}>
            <Shield size={16} color="#5EEAD4" />
          </div>
          <div>
            <div className="font-semibold tracking-tight" style={{ fontSize: 15 }}>OBLIVION</div>
            <div className="mono" style={{ fontSize: 10, color: "#7C8598" }}>agentic memory · deletion ledger</div>
          </div>
          <div className="flex items-center gap-1 ml-4">
            {TENANTS.map(t => (
              <button
                key={t}
                onClick={() => setTenant(t)}
                className="px-2.5 py-1 rounded-md text-xs transition-colors"
                style={{
                  background: tenant === t ? "#1B2333" : "transparent",
                  color: tenant === t ? "#E6EAF2" : "#7C8598",
                  border: tenant === t ? "1px solid #2E3A52" : "1px solid transparent",
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded mono" style={{ fontSize: 10, background: "#141B2A", border: "1px solid #232B3A", color: "#7C8598" }}>
            <Cpu size={11} color="#5EEAD4" /> Ollama · llama3.1:8b
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1 rounded mono" style={{ fontSize: 10, background: "#141B2A", border: "1px solid #232B3A", color: "#7C8598" }}>
            <Cloud size={11} color="#E8B339" /> Lambda + S3 · eu-central-1
          </div>
          <div className="flex items-center gap-2 mono" style={{ fontSize: 11, color: "#7C8598" }}>
            <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: liveMode ? "#3DDC97" : "#E8B339" }} />
            crdb-basic-7f2a · {liveMode ? "live" : "demo data"}
          </div>
        </div>
      </div>

      {/* SLA heatmap strip */}
      <div className="px-6 py-3 border-b hairline flex items-center gap-3 overflow-x-auto" style={{ background: "#0D1219" }}>
        <div className="flex items-center gap-1.5 mono shrink-0" style={{ fontSize: 10, color: "#7C8598" }}>
          <Clock size={12} /> SLA QUEUE
        </div>
        {slaQueue.length === 0 && (
          <span className="mono" style={{ fontSize: 11, color: "#3DDC97" }}>queue clear — 0 pending requests</span>
        )}
        {slaQueue.map(r => {
          const remaining = Math.max(0, r.deadline - slaNow);
          const secs = Math.floor(remaining / 1000);
          const risk = secs < 30 ? "#E8546B" : secs < 90 ? "#E8B339" : "#3DDC97";
          return (
            <div
              key={r.id}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-md shrink-0 cursor-pointer"
              style={{ background: "#141B2A", border: `1px solid ${risk}55` }}
              onClick={() => setSelectedId(r.user)}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: risk }} />
              <span className="mono" style={{ fontSize: 11 }}>{r.id}</span>
              <span style={{ fontSize: 11, color: "#7C8598" }}>{r.user}</span>
              <span className="mono" style={{ fontSize: 11, color: risk }}>{secs}s</span>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-12 gap-4 p-6">
        {/* Left: user list + memory graph */}
        <div className="col-span-4 flex flex-col gap-4">
          <div className="rounded-lg border hairline p-3" style={{ background: "#10151E" }}>
            <div className="mono mb-2" style={{ fontSize: 10, color: "#7C8598" }}>USERS · {tenant}</div>
            <div className="flex flex-col gap-1">
              {users.filter(u => u.tenant === tenant).map(u => (
                <button
                  key={u.id}
                  onClick={() => setSelectedId(u.id)}
                  className="flex items-center justify-between px-2.5 py-2 rounded-md text-left transition-colors"
                  style={{
                    background: selectedId === u.id ? "#1B2333" : "transparent",
                    border: selectedId === u.id ? "1px solid #2E3A52" : "1px solid transparent",
                  }}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mono"
                      style={{ background: `${TENANT_COLOR[u.tenant]}22`, color: TENANT_COLOR[u.tenant], fontSize: 9.5, border: `1px solid ${TENANT_COLOR[u.tenant]}55` }}
                    >
                      {initials(u.name)}
                    </div>
                    <div>
                      <div style={{ fontSize: 12.5 }}>{u.name}</div>
                      <div className="mono" style={{ fontSize: 10, color: "#7C8598" }}>{u.id}</div>
                    </div>
                  </div>
                  {u.status === "purged" && <CheckCircle2 size={14} color="#3DDC97" />}
                  {u.status === "held" && <Lock size={14} color="#6E8BFF" />}
                  {u.status === "active" && <ChevronRight size={14} color="#7C8598" />}
                </button>
              ))}
            </div>
          </div>

          {/* Memory graph */}
          <div className="rounded-lg border hairline p-4 flex-1" style={{ background: "#10151E" }}>
            <div className="flex items-center justify-between mb-3">
              <div className="mono" style={{ fontSize: 10, color: "#7C8598" }}>MEMORY GRAPH · {selectedUser?.id}</div>
              {selectedUser?.status === "held" && (
                <span className="flex items-center gap-1 mono" style={{ fontSize: 10, color: "#6E8BFF" }}>
                  <Lock size={10} /> legal hold
                </span>
              )}
            </div>
            <div className="relative flex flex-col items-center py-4">
              <div className="w-10 h-10 rounded-full flex items-center justify-center mb-6" style={{ background: "#1B2333", border: "1px solid #2E3A52" }}>
                <span className="mono" style={{ fontSize: 9 }}>{selectedUser?.id.slice(-4)}</span>
              </div>
              <div className="grid grid-cols-2 gap-3 w-full">
                {tps.map((t, i) => {
                  const meta = TOUCHPOINT_TYPES.find(x => x.key === t.type);
                  const Icon = meta?.icon || Database;
                  const c = statusColor(t.status);
                  return (
                    <div
                      key={i}
                      className="fade-up flex flex-col gap-1 px-2.5 py-2 rounded-md"
                      style={{
                        background: "#141B2A",
                        border: `1px solid ${c}44`,
                        opacity: t.status === "purged" ? 0.45 : 1,
                      }}
                    >
                      <div className="flex items-center gap-1.5">
                        <Icon size={11} color={c} />
                        <span style={{ fontSize: 10.5 }}>{meta?.label}</span>
                      </div>
                      <span className="mono" style={{ fontSize: 9, color: "#7C8598", textDecoration: t.status === "purged" ? "line-through" : "none" }}>
                        {t.note}
                      </span>
                      <span className="mono" style={{ fontSize: 9, color: c, textTransform: "uppercase" }}>{t.status}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {selectedUser?.status !== "purged" && (
              <div className="flex items-center gap-1.5 mt-3 mb-1.5 mono" style={{ fontSize: 9.5, color: "#7C8598" }}>
                <Cpu size={10} color="#5EEAD4" />
                blast-radius check via Ollama: {tps.some(t => t.type === "contract") ? "1 dependency found — redact, don't hard-delete" : "no cross-user dependencies"}
              </div>
            )}
            <button
              onClick={runPurge}
              disabled={phase === "running" || selectedUser?.status === "purged"}
              className="w-full mt-1 py-2 rounded-md font-medium transition-colors"
              style={{
                background: selectedUser?.status === "purged" ? "#141B2A" : "#5EEAD4",
                color: selectedUser?.status === "purged" ? "#7C8598" : "#0A0E14",
                fontSize: 12,
                cursor: phase === "running" || selectedUser?.status === "purged" ? "not-allowed" : "pointer",
                opacity: phase === "running" ? 0.6 : 1,
              }}
            >
              {selectedUser?.status === "purged" ? "Purge complete" : phase === "running" ? "Cascading…" : "Execute deletion cascade"}
            </button>

            {refusal && refusal.user === selectedId && (
              <div className="fade-up mt-2 flex items-start gap-2 px-2.5 py-2 rounded-md" style={{ background: "#6E8BFF14", border: "1px solid #6E8BFF44" }}>
                <ShieldAlert size={13} color="#6E8BFF" className="mt-0.5 shrink-0" />
                <span style={{ fontSize: 10.5, color: "#B8C4E8" }}>Deletion refused — {refusal.reason}</span>
              </div>
            )}
          </div>
        </div>

        {/* Right: ANN proof + hash chain */}
        <div className="col-span-8 flex flex-col gap-4">
          {/* ANN before/after */}
          <div className="rounded-lg border hairline p-4" style={{ background: "#10151E" }}>
            <div className="flex items-center gap-1.5 mb-3 mono" style={{ fontSize: 10, color: "#7C8598" }}>
              <Search size={11} /> NEAREST-NEIGHBOR PROOF · same query, before vs. after purge
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="mono mb-2" style={{ fontSize: 9.5, color: "#7C8598" }}>BEFORE</div>
                <div className="flex flex-col gap-1.5">
                  {annBefore.map(v => (
                    <div key={v.id} className="flex items-center justify-between px-2.5 py-1.5 rounded" style={{ background: "#141B2A" }}>
                      <span style={{ fontSize: 11 }}>{v.label}</span>
                      <span className="mono" style={{ fontSize: 10, color: "#7C8598" }}>{v.dist.toFixed(3)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="mono mb-2" style={{ fontSize: 9.5, color: annAfter ? "#3DDC97" : "#7C8598" }}>
                  AFTER {annAfter && "· recomputed live"}
                </div>
                <div className="flex flex-col gap-1.5">
                  {(annAfter || annBefore).map(v => {
                    const removed = annAfter && !annAfter.find(x => x.id === v.id);
                    return null;
                  })}
                  {annAfter ? (
                    annAfter.length ? annAfter.map(v => (
                      <div key={v.id} className="fade-up flex items-center justify-between px-2.5 py-1.5 rounded" style={{ background: "#141B2A" }}>
                        <span style={{ fontSize: 11 }}>{v.label}</span>
                        <span className="mono" style={{ fontSize: 10, color: "#7C8598" }}>{v.dist.toFixed(3)}</span>
                      </div>
                    )) : (
                      <div className="px-2.5 py-3 rounded text-center mono" style={{ background: "#141B2A", fontSize: 10, color: "#3DDC97" }}>
                        0 results — target vectors unrecoverable
                      </div>
                    )
                  ) : (
                    <div className="px-2.5 py-3 rounded text-center mono" style={{ background: "#141B2A", fontSize: 10, color: "#7C8598" }}>
                      run a purge to recompute
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Hash chain */}
          <div className="rounded-lg border hairline p-4" style={{ background: "#10151E" }}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-1.5 mono" style={{ fontSize: 10, color: "#7C8598" }}>
                <Link2 size={11} /> AUDIT LEDGER · hash-chained
              </div>
              <div className="flex items-center gap-1.5 mono" style={{ fontSize: 10, color: brokenFrom >= 0 ? "#E8546B" : "#3DDC97" }}>
                {brokenFrom >= 0 ? <XCircle size={12} /> : <ShieldCheck size={12} />}
                {brokenFrom >= 0 ? "chain broken" : "chain verified"}
              </div>
            </div>
            <div className="flex items-center gap-1 overflow-x-auto pb-2">
              {chain.map((b, i) => {
                const broken = brokenFrom >= 0 && i >= brokenFrom;
                return (
                  <div key={b.id} className="flex items-center shrink-0">
                    <button
                      onClick={() => toggleTamper(b.id)}
                      className="fade-up flex flex-col gap-1 px-3 py-2 rounded-md text-left"
                      style={{
                        background: broken ? "#E8546B14" : "#141B2A",
                        border: `1px solid ${broken ? "#E8546B77" : "#232B3A"}`,
                        minWidth: 150,
                      }}
                      title="Click to toggle tamper simulation"
                    >
                      <div className="flex items-center justify-between">
                        <span className="mono" style={{ fontSize: 9, color: "#7C8598" }}>#{b.id}</span>
                        <span className="mono" style={{ fontSize: 8.5, color: "#4A5468" }}>{b.ts}</span>
                      </div>
                      <span className="mono" style={{ fontSize: 11, color: broken ? "#E8546B" : "#5EEAD4" }}>
                        {b.tampered ? "??????ff" : b.hash}
                      </span>
                      <span style={{ fontSize: 9.5, color: "#7C8598" }}>{b.event}</span>
                    </button>
                    {i < chain.length - 1 && (
                      <Unlink size={12} color={broken ? "#E8546B" : "#2E3A52"} className="mx-0.5 shrink-0" />
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-2 mono" style={{ fontSize: 9.5, color: "#7C8598" }}>
              click any block to simulate tampering — downstream links invalidate instantly
            </div>
          </div>

          {/* MCP chat */}
          <div className="rounded-lg border hairline flex flex-col flex-1" style={{ background: "#10151E", minHeight: 200 }}>
            <div className="px-4 py-2.5 border-b hairline mono flex items-center gap-1.5" style={{ fontSize: 10, color: "#7C8598" }}>
              <Server size={11} /> ASK THE LEDGER · via CockroachDB Managed MCP Server
            </div>
            <div ref={logRef} className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2" style={{ maxHeight: 160 }}>
              {chat.map((m, i) => (
                <div key={i} className="fade-up flex" style={{ justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                  <div
                    className="px-3 py-1.5 rounded-lg"
                    style={{
                      background: m.role === "user" ? "#1B2333" : "#141B2A",
                      border: "1px solid #232B3A",
                      maxWidth: "80%",
                      fontSize: 12,
                    }}
                  >
                    {m.text}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 px-3 py-2.5 border-t hairline">
              <input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && askLedger()}
                placeholder='e.g. "is usr_4471 fully purged?"'
                className="flex-1 px-3 py-1.5 rounded-md outline-none"
                style={{ background: "#0D1219", border: "1px solid #232B3A", color: "#E6EAF2", fontSize: 12 }}
              />
              <button
                onClick={askLedger}
                className="p-2 rounded-md"
                style={{ background: "#5EEAD4", color: "#0A0E14" }}
              >
                <Send size={13} />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between px-6 py-2 border-t hairline mono" style={{ fontSize: 9.5, color: "#4A5468", background: "#0D1219" }}>
        <span>oblivion · build 0.9.2 · schema v4 · region eu-central-1</span>
        <span>session {hashLike("session").slice(0, 6)} · {tsNow(0)}</span>
      </div>
    </div>
  );
}

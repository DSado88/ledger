// ledger-components.jsx
// Shared helpers + components for the Ledger app.
// Exposes everything to window so the main app file can use it.
import "./networth.js"; // registers globalThis.partitionNetWorth for the bundle
import "./spending.js"; // registers globalThis.splitBySpending / isNonSpendingCategory

const { useState, useEffect, useMemo, useRef, useCallback } = React;

// ─── time / app today ───────────────────────────────────────────────────

const TODAY = new Date();

const WEEKDAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

const _parseYMD = (s) => {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
};

const computeWeekday = (dateStr) => {
  if (!dateStr || typeof dateStr !== "string") return "";
  const iso = _parseYMD(dateStr);
  if (iso) {
    const dt = new Date(iso.y, iso.m - 1, iso.d);
    return isNaN(dt.getTime()) ? "" : WEEKDAYS[dt.getDay()];
  }
  const parts = dateStr.split("/").map(s => s.trim());
  if (parts.length < 2) return "";
  const m = parseInt(parts[0], 10);
  const d = parseInt(parts[1], 10);
  if (isNaN(m) || isNaN(d)) return "";
  let y = parts[2] ? parseInt(parts[2], 10) : TODAY.getFullYear();
  if (y < 100) y += 2000;
  const dt = new Date(y, m - 1, d);
  if (isNaN(dt.getTime())) return "";
  return WEEKDAYS[dt.getDay()];
};

const parseDate = (dateStr, fallbackYear = TODAY.getFullYear()) => {
  if (!dateStr) return null;
  const iso = _parseYMD(dateStr);
  if (iso) return new Date(iso.y, iso.m - 1, iso.d);
  const parts = dateStr.split("/").map(s => s.trim());
  if (parts.length < 2) return null;
  const m = parseInt(parts[0], 10);
  const d = parseInt(parts[1], 10);
  if (isNaN(m) || isNaN(d)) return null;
  let y = parts[2] ? parseInt(parts[2], 10) : fallbackYear;
  if (y < 100) y += 2000;
  return new Date(y, m - 1, d);
};

const fmtDate = (dateStr) => {
  const dt = parseDate(dateStr);
  if (!dt) return dateStr || "";
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
};

const fmtMoney = (n, opts = {}) => {
  if (n == null || Number.isNaN(n)) return "—";
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: opts.minFrac ?? 2, maximumFractionDigits: 2 });
  return (n < 0 ? "−" : "") + "$" + s;
};

const fmtCompact = (n) => {
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (a >= 999.5) return sign + "$" + (a / 1000).toFixed(a >= 9999.5 ? 0 : 1) + "k";
  return sign + "$" + a.toFixed(0);
};

const relTime = (mins) => {
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.round(d / 30)}mo ago`;
};

let __nextId = 9000;
const nextId = (prefix = "b") => `${prefix}_${(++__nextId).toString(36)}`;

const normalizeDate = (s) => {
  if (!s) return s;
  const parts = String(s).split("/").map(p => p.trim());
  if (parts.length < 2) return s;
  return `${parseInt(parts[0], 10)}/${parseInt(parts[1], 10)}`;
};

// ─── period helpers ────────────────────────────────────────────────────

const PERIODS = [
  { key: "ytd",    label: "YTD",       desc: "year to date" },
  { key: "month",  label: "Month",     desc: "this month" },
  { key: "30d",    label: "30 days",   desc: "last 30 days" },
  { key: "90d",    label: "90 days",   desc: "last 90 days" },
  { key: "all",    label: "All",       desc: "all time" },
];
const periodLabel = (key, customRange) => {
  if (key === "custom" && customRange) {
    const f = `${customRange.from.getMonth()+1}/${customRange.from.getDate()}`;
    const t = `${customRange.to.getMonth()+1}/${customRange.to.getDate()}`;
    return `${f} – ${t}`;
  }
  return (PERIODS.find(p => p.key === key) || PERIODS[0]).desc;
};

const inPeriod = (dateStr, period, today = TODAY, customRange) => {
  if (period === "all") return true;
  if (period === "custom" && customRange) {
    const dt = parseDate(dateStr, today.getFullYear());
    if (!dt) return false;
    const from = new Date(customRange.from.getFullYear(), customRange.from.getMonth(), customRange.from.getDate());
    const to = new Date(customRange.to.getFullYear(), customRange.to.getMonth(), customRange.to.getDate(), 23, 59, 59);
    return dt >= from && dt <= to;
  }
  const dt = parseDate(dateStr, today.getFullYear());
  if (!dt) return false;
  if (period === "ytd")  return dt.getFullYear() === today.getFullYear() && dt <= today;
  if (period === "month")return dt.getMonth() === today.getMonth() && dt.getFullYear() === today.getFullYear() && dt <= today;
  if (period === "30d") {
    const ago = new Date(today); ago.setDate(ago.getDate() - 30);
    return dt >= ago && dt <= today;
  }
  if (period === "90d") {
    const ago = new Date(today); ago.setDate(ago.getDate() - 90);
    return dt >= ago && dt <= today;
  }
  return true;
};

const aggregateByCode = (txns, period, today = TODAY, customRange) => {
  const byCode = {};
  txns.forEach(t => {
    if (!inPeriod(t.date, period, today, customRange)) return;
    if (t.splits && t.splits.length) {
      t.splits.forEach(s => {
        if (!s.code) return;
        if (!byCode[s.code]) byCode[s.code] = { total: 0, count: 0 };
        byCode[s.code].total += Number(s.amount) || 0;
        byCode[s.code].count++;
      });
    } else if (t.lineCode) {
      if (!byCode[t.lineCode]) byCode[t.lineCode] = { total: 0, count: 0 };
      byCode[t.lineCode].total += Number(t.amount) || 0;
      byCode[t.lineCode].count++;
    }
  });
  return byCode;
};

const uncodedInPeriod = (txns, period, today = TODAY, customRange) =>
  txns.filter(t => inPeriod(t.date, period, today, customRange) && !t.lineCode && !(t.splits && t.splits.length));

// ─── line code catalog ─────────────────────────────────────────────────

let LINE_CODES = [];
let CODE_BY_NUM = {};
let CATEGORIES_ORDER = [];

function setLineCodes(codes) {
  LINE_CODES = codes.map(c => ({
    code: String(c.code),
    category: c.category,
    label: c.label,
    categoryCode: c.category_code,
    spending: c.spending !== 0 && c.spending !== false, // 0/false = income/transfer
  }));
  CODE_BY_NUM = Object.fromEntries(LINE_CODES.map(c => [c.code, c]));
  const seen = new Set();
  CATEGORIES_ORDER = [];
  for (const c of LINE_CODES) {
    if (!seen.has(c.category)) {
      seen.add(c.category);
      CATEGORIES_ORDER.push(c.category);
    }
  }
}

const _apiToken = document.body.dataset.apiToken || "";

async function fetchApi(path, opts = {}) {
  const headers = { ...(opts.headers || {}), "X-Ledger-Token": _apiToken };
  const resp = await fetch(path, { ...opts, headers });
  if (!resp.ok) throw new Error(`${path}: ${resp.status}`);
  return resp.json();
}

function mapTransaction(t) {
  let meta = null;
  try { if (t.metadata) meta = typeof t.metadata === "string" ? JSON.parse(t.metadata) : t.metadata; } catch {}
  return {
    id: t.id,
    date: t.date,
    vendor: t.vendor,
    description: t.description,
    amount: t.amount,
    account: t.account_label || "",
    lineCode: t.line_code || null,
    plaidTxId: t.plaid_tx_id,
    amazonOrderId: t.amazon_order_id,
    source: t.source,
    metadata: meta,
    seen: t.seen !== 0,
    codedBy: t.coded_by || null,
    splits: (t.splits || []).map(s => ({
      code: s.line_code,
      amount: s.amount,
      description: s.description,
    })),
  };
}

function mapInstitution(inst) {
  return {
    id: inst.id,
    name: inst.name,
    monogram: inst.monogram || inst.name.charAt(0).toUpperCase(),
    color: inst.color || "#1A1814",
    status: inst.status || "ok",
    plaidItemId: inst.plaid_item_id || null,
    connectedAt: inst.connected_at,
    lastSyncMin: 0,
    accounts: (inst.accounts || []).map(a => ({
      id: a.id,
      name: a.name,
      nickname: a.nickname,
      subtype: a.subtype,
      category: a.category ?? null,
      mask: a.mask || "····",
      balance: Number(a.balance) || 0,
      available: a.available,
      limit: a.credit_limit,
      apr: a.apr,
      apy: a.apy,
      rate: a.rate,
      costBasis: a.cost_basis,
      nextPayment: a.next_payment,
      nextAmount: a.next_amount,
      loan_origination_date: a.loan_origination_date,
      loan_origination_amount: a.loan_origination_amount,
      loan_term_months: a.loan_term_months,
      metadata: a.metadata,
    })),
  };
}

function mapBill(b) {
  return {
    id: b.id,
    date: b.date,
    name: b.name,
    account: b.account_label || "",
    amount: b.amount,
    kind: b.kind || "",
    hidden: !!b.hidden,
    weekday: computeWeekday(b.date),
  };
}

async function loadLedgerData() {
  const [codes, insts, txns, billsData, blocks] = await Promise.all([
    fetchApi("/api/line-codes"),
    fetchApi("/api/institutions"),
    fetchApi("/api/transactions?limit=1000"),
    fetchApi("/api/bills"),
    fetchApi("/api/account-blocks"),
  ]);
  setLineCodes(codes);
  const mappedInsts = insts.map(mapInstitution);
  const acctLookup = {};
  for (const inst of mappedInsts) {
    for (const a of inst.accounts) {
      acctLookup[a.id] = a.nickname || a.name;
    }
  }
  return {
    accountBlocks: blocks,
    institutions: mappedInsts,
    transactions: txns.map(t => {
      const mt = mapTransaction(t);
      if (t.account_id && acctLookup[t.account_id]) {
        mt.accountDisplay = acctLookup[t.account_id];
      }
      return mt;
    }),
    bills: billsData.map(mapBill).sort((a, b) => {
      const pa = (s) => { const [m, d] = String(s).split("/").map(n => parseInt(n, 10)); return (m || 0) * 100 + (d || 0); };
      return pa(a.date) - pa(b.date);
    }),
  };
}

// ─── icon ──────────────────────────────────────────────────────────────

function Icon({ name, size = 14, ...rest }) {
  const c = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", ...rest };
  if (name === "plus")       return <svg {...c}><path d="M12 5v14M5 12h14"/></svg>;
  if (name === "search")     return <svg {...c}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>;
  if (name === "arrow-right")return <svg {...c}><path d="M5 12h14M13 6l6 6-6 6"/></svg>;
  if (name === "x")          return <svg {...c}><path d="M6 6l12 12M18 6 6 18"/></svg>;
  if (name === "warn")       return <svg {...c} strokeWidth="1.8"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.7 2.5 17a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/></svg>;
  if (name === "check")      return <svg {...c} strokeWidth="2"><path d="M20 6 9 17l-5-5"/></svg>;
  if (name === "shield")     return <svg {...c}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/></svg>;
  if (name === "lock")       return <svg {...c}><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>;
  if (name === "sync")       return <svg {...c}><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>;
  if (name === "split")      return <svg {...c}><path d="M14 4h6v6M10 20H4v-6M14 4l6 6-7 7M10 20L4 14l7-7"/></svg>;
  if (name === "spark")      return <svg {...c}><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M5.6 18.4l2-2M16.4 7.6l2-2"/><circle cx="12" cy="12" r="3"/></svg>;
  if (name === "overview")   return <svg {...c}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>;
  if (name === "calendar")   return <svg {...c}><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M9 3v4M15 3v4"/></svg>;
  if (name === "list")       return <svg {...c}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>;
  if (name === "link")       return <svg {...c}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>;
  if (name === "columns")    return <svg {...c}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/></svg>;
  if (name === "grip-vertical") return <svg {...c}><circle cx="9" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="19" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="19" r="1" fill="currentColor" stroke="none"/></svg>;
  return null;
}

// ─── logo ──────────────────────────────────────────────────────────────

function Logo({ inst, size = 32, radius = 8 }) {
  const c = inst.color;
  return (
    <div style={{
      width: size, height: size, borderRadius: radius,
      display: "grid", placeItems: "center",
      fontFamily: "var(--serif)", fontStyle: "italic",
      fontSize: size * 0.58, color: "#fff",
      background: `linear-gradient(135deg, ${c}, color-mix(in oklab, ${c} 65%, #000))`,
      boxShadow: "inset 0 0 0 1px rgba(255,255,255,.18)",
      flexShrink: 0,
    }}>
      {inst.monogram}
    </div>
  );
}

// ─── code picker (autocomplete) ────────────────────────────────────────

function CodePicker({ value, onChange, autoFocus = false, placeholder = "Pick a line code…", compact = false, onSubmit }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [focusIdx, setFocusIdx] = useState(0);
  const [listPos, setListPos] = useState(null);
  const inputRef = useRef(null);
  const containerRef = useRef(null);
  const listRef = useRef(null);
  const current = value ? CODE_BY_NUM[value] : null;

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [...LINE_CODES].sort((a, b) => (b.freq || 0) - (a.freq || 0) || a.code.localeCompare(b.code));
    return LINE_CODES.filter(c =>
      c.code.toLowerCase().includes(term) ||
      c.label.toLowerCase().includes(term) ||
      c.category.toLowerCase().includes(term)
    );
  }, [q]);

  useEffect(() => { if (autoFocus) { setOpen(true); setTimeout(() => inputRef.current?.focus(), 50); } }, [autoFocus]);

  useEffect(() => {
    if (!open) { setListPos(null); return; }
    const updatePos = () => {
      if (!containerRef.current) return;
      const r = containerRef.current.getBoundingClientRect();
      setListPos({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    updatePos();
    const onClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target) &&
          listRef.current && !listRef.current.contains(e.target)) setOpen(false);
    };
    const onScroll = () => updatePos();
    setTimeout(() => document.addEventListener("mousedown", onClick), 0);
    window.addEventListener("scroll", onScroll, true);
    return () => { document.removeEventListener("mousedown", onClick); window.removeEventListener("scroll", onScroll, true); };
  }, [open]);

  const groups = useMemo(() => {
    const m = new Map();
    filtered.forEach(c => { if (!m.has(c.category)) m.set(c.category, []); m.get(c.category).push(c); });
    return Array.from(m.entries());
  }, [filtered]);

  const pick = (code) => { onChange(code); setOpen(false); setQ(""); };

  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setFocusIdx(i => Math.min(filtered.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocusIdx(i => Math.max(0, i - 1)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (open && filtered[focusIdx]) pick(filtered[focusIdx].code);
      else if (!open && onSubmit) onSubmit();
    }
    else if (e.key === "Escape") setOpen(false);
  };

  if (compact) {
    return (
      <div className="code-picker" ref={containerRef}>
        <div className="scode" onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0); }}>
          <span className={`num ${current ? "" : "empty"}`}>{current ? current.code : "—"}</span>
          <span className="lbl">{current ? current.label : "Pick code"}</span>
        </div>
        {open && listPos && ReactDOM.createPortal(
          <div className="code-list" ref={listRef} style={{ position:"fixed", top:listPos.top, left:listPos.left, width:listPos.width }}>
            <div style={{ padding:6, borderBottom:"1px solid var(--line)", background:"var(--surface)", position:"sticky", top:0, zIndex:1 }}>
              <input ref={inputRef} placeholder="Search by number or name…"
                value={q} onChange={(e) => { setQ(e.target.value); setFocusIdx(0); }} onKeyDown={onKey}
                style={{ width:"100%", border:0, outline:0, background:"transparent", fontSize:12.5, color:"var(--ink)", padding:"4px 4px" }} />
            </div>
            {filtered.length === 0 ? (
              <div style={{ padding:"16px 10px", textAlign:"center", color:"var(--muted)", fontSize:12 }}>No codes match "{q}".</div>
            ) : groups.map(([cat, items]) => (
              <div key={cat}>
                <div className="code-group">{cat}</div>
                {items.map(c => {
                  const idx = filtered.indexOf(c);
                  return (
                    <div key={c.code} className={`code-option ${idx === focusIdx ? "focus" : ""}`} onClick={() => pick(c.code)}>
                      <span className="num">{c.code}</span>
                      <span className="lbl">{c.label}</span>
                      {c.freq != null && <span className="freq">{c.freq}/yr</span>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>,
          document.body
        )}
      </div>
    );
  }

  return (
    <div className="code-picker" ref={containerRef}>
      <div className="code-input" onClick={() => { setOpen(true); inputRef.current?.focus(); }}>
        <span className={`num ${current ? "" : "empty"}`}>{current ? current.code : "—"}</span>
        <input ref={inputRef} placeholder={current ? current.label : placeholder}
          value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); setFocusIdx(0); }}
          onKeyDown={onKey} onFocus={() => setOpen(true)} />
        {current && <span className="cat">{current.category}</span>}
        {current && <button className="clear" onClick={(e) => { e.stopPropagation(); onChange(null); setQ(""); }}><Icon name="x" size={11}/></button>}
      </div>
      {open && listPos && ReactDOM.createPortal(
        <div className="code-list" ref={listRef} style={{ position:"fixed", top:listPos.top, left:listPos.left, width:listPos.width }}>
          {filtered.length === 0 ? (
            <div style={{ padding:"16px 10px", textAlign:"center", color:"var(--muted)", fontSize:12 }}>No codes match "{q}".</div>
          ) : groups.map(([cat, items]) => (
            <div key={cat}>
              <div className="code-group">{cat}</div>
              {items.map(c => {
                const idx = filtered.indexOf(c);
                return (
                  <div key={c.code} className={`code-option ${idx === focusIdx ? "focus" : ""}`} onClick={() => pick(c.code)}>
                    <span className="num">{c.code}</span>
                    <span className="lbl">{c.label}</span>
                    {c.freq != null && <span className="freq">{c.freq}/yr</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

// ─── transaction more info ────────────────────────────────────────────

function TxnMoreInfo({ txn }) {
  const [open, setOpen] = useState(false);
  const m = txn.metadata;
  const hasInfo = m && (m.category || m.location || m.logoUrl || m.website || m.counterparties || m.paymentChannel);
  if (!hasInfo && !txn.plaidTxId && !txn.amazonOrderId) return null;

  const rows = [];
  if (m?.category) rows.push(["Category", m.category.replace(/_/g, " ").toLowerCase()]);
  if (m?.subcategory && m.subcategory !== m.category) rows.push(["Subcategory", m.subcategory.replace(/_/g, " ").toLowerCase()]);
  if (m?.paymentChannel) rows.push(["Channel", m.paymentChannel.replace(/_/g, " ")]);
  if (m?.location) {
    const l = m.location;
    const parts = [l.address, l.city, l.region, l.postalCode].filter(Boolean);
    if (parts.length) rows.push(["Location", parts.join(", ") + (l.storeNumber ? ` (#${l.storeNumber})` : "")]);
  }
  if (m?.website) rows.push(["Website", m.website]);
  if (m?.counterparties?.length) {
    for (const cp of m.counterparties) {
      rows.push(["Merchant", `${cp.name || "—"}${cp.type ? ` · ${cp.type}` : ""}`]);
      if (cp.website && cp.website !== m.website) rows.push(["", cp.website]);
    }
  }
  if (txn.plaidTxId) rows.push(["Plaid ID", txn.plaidTxId]);
  if (txn.amazonOrderId) rows.push(["Amazon Order", txn.amazonOrderId]);
  if (txn.source) rows.push(["Source", txn.source]);

  return (
    <div className="more-info">
      <button className="more-toggle" onClick={() => setOpen(o => !o)}>
        {open ? "▾" : "▸"} More info
      </button>
      {open && (
        <div className="more-grid">
          {rows.map(([k, v], i) => (
            <React.Fragment key={i}>
              <div className="mk">{k}</div>
              <div className="mv">{v}</div>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── transaction inline expand ─────────────────────────────────────────

function TxnExpand({ txn, onClose, onSave, focusField }) {
  const [open, setOpen] = useState(false);
  const [desc, setDesc] = useState(txn.description || "");
  const descRef = useRef(null);
  const [splits, setSplits] = useState(() => {
    if (txn.splits && txn.splits.length) return txn.splits.map(s => ({ ...s }));
    return [{ code: txn.lineCode || null, amount: txn.amount, description: "" }];
  });

  const total = txn.amount;
  const sumSplits = splits.reduce((a, s) => a + (Number(s.amount) || 0), 0);
  const diff = +(total - sumSplits).toFixed(2);
  const balanced = Math.abs(diff) < 0.005;

  const updateSplit = (idx, patch) => setSplits(prev => prev.map((s, i) => i === idx ? { ...s, ...patch } : s));
  const removeSplit = (idx) => setSplits(prev => prev.filter((_, i) => i !== idx));
  const addSplit = () => setSplits(prev => [...prev, { code: null, amount: diff, description: "" }]);

  const doSave = () => {
    if (!balanced) return;
    onSave({
      ...txn, description: desc || undefined,
      ...(splits.length === 1
        ? { lineCode: splits[0].code || undefined, splits: undefined }
        : { lineCode: undefined, splits: splits.map(s => ({ ...s, amount: Number(s.amount) })) })
    });
  };

  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    if (!focusField) return;
    const t = setTimeout(() => {
      if (focusField === "description" && descRef.current) {
        descRef.current.focus();
        descRef.current.select();
      }
    }, 80);
    return () => clearTimeout(t);
  }, [focusField]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={`expand ${open ? "open" : ""}`}>
      <div className="expand-inner">
        <div className="expand-content">
          <button className="close-x" onClick={onClose}><Icon name="x" size={11}/></button>

          <div className="field">
            <div className="lbl">
              <span>Description</span>
              <span className="hint">Your own note · stays private</span>
            </div>
            <textarea ref={descRef} placeholder={`e.g. "Work lunch with Sarah"`} value={desc} onChange={(e) => setDesc(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  doSave();
                }
              }} />
          </div>

          <div className="field">
            <div className="lbl">
              <span>Line {splits.length > 1 ? "items" : "code"}</span>
              <span className="hint">{splits.length > 1 ? `${splits.length} splits · must sum to ${fmtMoney(total)}` : "Tag with a code from your catalog"}</span>
            </div>

            {splits.length === 1 ? (
              <>
                <CodePicker value={splits[0].code} onChange={(code) => updateSplit(0, { code })} autoFocus={focusField === "line"} onSubmit={doSave} />
                <button onClick={addSplit}
                  style={{ marginTop:10, color:"var(--accent)", fontSize:12.5, fontWeight:500, display:"inline-flex", gap:6, alignItems:"center" }}>
                  <Icon name="split" size={12}/> Split this transaction
                </button>
              </>
            ) : (
              <div className="splits">
                <div className="split-head">
                  <div>Code</div>
                  <div>Note</div>
                  <div className="ta-r">Amount</div>
                  <div></div>
                </div>
                {splits.map((s, i) => (
                  <div className="split-row" key={i}>
                    <CodePicker value={s.code} onChange={(code) => updateSplit(i, { code })} compact />
                    <input className="snote" placeholder="What was this part for?"
                      value={s.description || ""} onChange={(e) => updateSplit(i, { description: e.target.value })} />
                    <div className="samt">
                      <span className="ccy">$</span>
                      <input type="text" value={s.amount === "" ? "" : s.amount}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "" || v === "-") updateSplit(i, { amount: v });
                          else if (!isNaN(Number(v))) updateSplit(i, { amount: Number(v) });
                        }} />
                    </div>
                    <button className="rm" onClick={() => removeSplit(i)} title="Remove split"><Icon name="x" size={12}/></button>
                  </div>
                ))}
                <div className="splits-foot">
                  <div className="label"><b>Subtotal</b><span>of {fmtMoney(total)} total</span></div>
                  <div className={`total ${balanced ? "ok" : "bad"}`}>{fmtMoney(sumSplits)}</div>
                  <div></div>
                  <a className="add" onClick={addSplit}><Icon name="plus" size={11}/> Add split</a>
                  {!balanced && (
                    <div className="balance-warn">
                      {diff > 0 ? `+${fmtMoney(diff)}` : fmtMoney(diff)} unallocated.{" "}
                      <a style={{ color:"var(--accent)" }} onClick={() => updateSplit(splits.length - 1, { amount: +(((Number(splits[splits.length-1].amount) || 0) + diff).toFixed(2)) })}>
                        Add to last split
                      </a>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <TxnMoreInfo txn={txn} />

          <div className="expand-foot">
            <div className="left">Esc to close · click row again to collapse</div>
            <div style={{ display:"flex", gap:8 }}>
              <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary btn-sm" disabled={!balanced} style={{ opacity: balanced ? 1 : .5 }}
                onClick={doSave}>Save</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── account inline expand ─────────────────────────────────────────────

function AcctExpand({ inst, acct, blocks, onClose, onSave }) {
  const [open, setOpen] = useState(false);
  const [nickname, setNickname] = useState(acct.nickname || "");
  const [note, setNote] = useState(acct.note || "");
  const [category, setCategory] = useState(acct.category || "");
  // The dropdown lists every block grouped by kind. Include the account's current
  // category even if its block was since deleted, so we never silently drop it.
  const assetOpts = (blocks || []).filter(b => (b.kind || "asset") === "asset").map(b => b.name);
  const liabOpts = (blocks || []).filter(b => b.kind === "liability").map(b => b.name);
  const known = new Set([...assetOpts, ...liabOpts]);
  const orphan = acct.category && !known.has(acct.category) ? acct.category : null;

  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={`expand ${open ? "open" : ""}`}>
      <div className="expand-inner">
        <div className="expand-content">
          <button className="close-x" onClick={onClose}><Icon name="x" size={11}/></button>

          <div className="field">
            <div className="lbl">
              <span>Nickname</span>
              <span className="hint">how you refer to this account · optional</span>
            </div>
            <input type="text"
              placeholder={`e.g. "Main Checking" or "Emergency Fund"`}
              value={nickname} onChange={(e) => setNickname(e.target.value)} />
            {nickname && nickname !== acct.name && (
              <div style={{ marginTop:6, fontSize:11, color:"var(--muted)", fontFamily:"var(--mono)" }}>
                Original: {acct.name}
              </div>
            )}
          </div>

          <div className="field">
            <div className="lbl">
              <span>Block</span>
              <span className="hint">which net-worth group it counts toward</span>
            </div>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">— Unsorted —</option>
              {assetOpts.length > 0 && (
                <optgroup label="Assets">
                  {assetOpts.map(b => <option key={b} value={b}>{b}</option>)}
                </optgroup>
              )}
              {liabOpts.length > 0 && (
                <optgroup label="Liabilities">
                  {liabOpts.map(b => <option key={b} value={b}>{b}</option>)}
                </optgroup>
              )}
              {orphan && <option value={orphan}>{orphan}</option>}
            </select>
          </div>

          <div className="field">
            <div className="lbl"><span>Note</span><span className="hint">private to you</span></div>
            <textarea placeholder="Joint owner, purpose, statement day…"
              value={note} onChange={(e) => setNote(e.target.value)} />
          </div>

          <div className="field">
            <div className="lbl"><span>Details</span><span className="hint">from {inst.name}</span></div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", border:"1px solid var(--line)", borderRadius:7, overflow:"hidden", background:"var(--surface)" }}>
              {[
                ["Type", acct.category],
                ["Subtype", acct.subtype],
                ["Mask", "····" + acct.mask],
                ["Balance", fmtMoney(acct.balance)],
                acct.available != null ? ["Available", fmtMoney(acct.available)] : null,
                acct.limit ? ["Credit limit", fmtMoney(acct.limit)] : null,
                acct.apy != null ? ["APY", acct.apy + "%"] : null,
                acct.apr != null ? ["APR", acct.apr + "%"] : null,
                acct.rate != null ? ["Rate", acct.rate + "% fixed"] : null,
                acct.nextPayment ? ["Next payment", `${acct.nextPayment} · ${fmtMoney(acct.nextAmount)}`] : null,
                acct.costBasis ? ["Cost basis", fmtMoney(acct.costBasis)] : null,
                ["Last sync", relTime(inst.lastSyncMin)],
              ].filter(Boolean).map(([k,v], i) => (
                <div key={k} style={{ padding:"7px 11px", borderBottom:"1px solid var(--line)", borderRight: i % 2 === 0 ? "1px solid var(--line)" : "0", fontSize:12 }}>
                  <div style={{ fontSize:10, color:"var(--muted)", letterSpacing:".06em", textTransform:"uppercase", marginBottom:1 }}>{k}</div>
                  <div className="mono" style={{ fontSize:12.5 }}>{v}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="expand-foot">
            <div className="left">Esc to close · click row again to collapse</div>
            <div style={{ display:"flex", gap:8 }}>
              <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary btn-sm"
                onClick={() => onSave({ nickname: nickname.trim() || undefined, note: note.trim() || undefined, category })}>Save</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── add institution modal ─────────────────────────────────────────────

function AddModal({ onClose, onConnect, reconnect = null }) {
  const isReconnect = !!reconnect;
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);
  const [stage, setStage] = useState(0);
  const [instName, setInstName] = useState(reconnect?.institutionName || "");
  const csrfRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tokenPath = isReconnect
          ? `/api/plaid/update-link-token?item_id=${encodeURIComponent(reconnect.itemId)}`
          : "/api/plaid/link-token";
        const data = await fetchApi(tokenPath);
        if (cancelled) return;
        if (!data.ok || !data.linkToken) {
          setError(data.error || data.details || "Failed to create link token");
          setStatus("error");
          return;
        }
        const csrfMatch = document.cookie.match(/__ledger_csrf=([a-f0-9]+)/);
        csrfRef.current = csrfMatch ? csrfMatch[1] : "";
        setStatus("ready");

        const handler = window.Plaid.create({
          token: data.linkToken,
          onSuccess: async (publicToken, metadata) => {
            setInstName(metadata.institution?.name || reconnect?.institutionName || "Institution");
            setStatus("exchanging");
            setStage(0);
            const t1 = setTimeout(() => setStage(1), 800);
            const t2 = setTimeout(() => setStage(2), 1600);

            // Reconnect (update mode): the existing access token is repaired —
            // no public-token exchange. Just confirm the Item is healthy again.
            if (isReconnect) {
              try {
                const rcResp = await fetch("/api/plaid/reconnect-complete", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "X-CSRF-Token": csrfRef.current,
                    "X-Ledger-Token": _apiToken,
                  },
                  body: JSON.stringify({ item_id: reconnect.itemId }),
                });
                clearTimeout(t1);
                clearTimeout(t2);
                const rcData = await rcResp.json();
                if (rcResp.ok && rcData.ok && rcData.healthy) {
                  setStage(3);
                  setStatus("done");
                  setTimeout(() => onConnect({ reconnected: true }), 1200);
                } else {
                  setError(rcData.healthy === false
                    ? `Still needs attention (${rcData.errorCode}). Try the reconnect again.`
                    : (rcData.error || "Reconnect verification failed"));
                  setStatus("error");
                }
              } catch (e) {
                clearTimeout(t1);
                clearTimeout(t2);
                setError(e.message || "Network error during reconnect");
                setStatus("error");
              }
              return;
            }

            try {
              const exResp = await fetch("/api/plaid/exchange", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-CSRF-Token": csrfRef.current,
                  "X-Ledger-Token": _apiToken,
                },
                body: JSON.stringify({
                  public_token: publicToken,
                  institution_name: metadata.institution?.name || "Unknown",
                  accounts: (metadata.accounts || []).map(a => ({
                    id: a.id, name: a.name, type: a.type,
                  })),
                }),
              });
              clearTimeout(t1);
              clearTimeout(t2);
              const exData = await exResp.json();
              if (exResp.ok && exData.ok) {
                setStage(3);
                setStatus("done");
                setTimeout(() => {
                  onConnect({
                    institutionName: metadata.institution?.name || "Unknown",
                    accounts: (metadata.accounts || []).map(a => ({
                      id: a.id, name: a.name, type: a.type,
                    })),
                  });
                }, 1200);
              } else {
                setError(exData.error || "Token exchange failed");
                setStatus("error");
              }
            } catch (e) {
              clearTimeout(t1);
              clearTimeout(t2);
              setError(e.message || "Network error during exchange");
              setStatus("error");
            }
          },
          onExit: (err) => {
            if (err) {
              setError("Plaid Link exited with an error. Try again.");
              setStatus("error");
            } else {
              onClose();
            }
          },
        });
        handler.open();
      } catch (e) {
        if (!cancelled) {
          setError(e.message || "Failed to initialize Plaid Link");
          setStatus("error");
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const steps = [
    { t: "Authenticate", d: "Verifying credentials with your institution via OAuth." },
    { t: "Exchange token", d: "Securing a persistent read-only access token." },
    { t: "Store securely", d: "Saving credentials to 1Password vault." },
  ];

  return (
    <div className="scrim" onClick={status === "error" || status === "loading" ? onClose : undefined}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        {status === "loading" && (
          <>
            <div className="modal-head">
              <div><h3>Link an account</h3><p>Initializing Plaid Link...</p></div>
              <button className="modal-x" onClick={onClose}><Icon name="x"/></button>
            </div>
            <div className="modal-body" style={{ textAlign:"center", padding:"32px 22px" }}>
              <div className="spin" style={{ width:24, height:24, margin:"0 auto" }}/>
            </div>
          </>
        )}

        {status === "ready" && (
          <>
            <div className="modal-head">
              <div><h3>Link an account</h3><p>Plaid Link is open — complete the flow in the popup.</p></div>
              <button className="modal-x" onClick={onClose}><Icon name="x"/></button>
            </div>
            <div className="modal-body" style={{ textAlign:"center", padding:"32px 22px" }}>
              <p style={{ color:"var(--muted)", fontSize:13 }}>Select your institution and sign in.<br/>This window will update automatically.</p>
            </div>
            <div className="modal-foot">
              <div><Icon name="shield" size={11} style={{ verticalAlign:"-1px", marginRight:4 }}/>Credentials encrypted end-to-end via Plaid</div>
              <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {(status === "exchanging" || status === "done") && (
          <>
            <div className="link-hero">
              <div className="inst-logo" style={{ background:"var(--accent)", width:48, height:48, borderRadius:10, display:"grid", placeItems:"center", color:"#fff", fontFamily:"var(--serif)", fontStyle:"italic", fontSize:22 }}>
                {instName.charAt(0)}
              </div>
              <div>
                <h3>Connecting to {instName}</h3>
                <p style={{ margin:"3px 0 0", color:"var(--muted)", fontSize:12 }}>Establishing a secure read-only connection.</p>
              </div>
            </div>
            <div className="steps">
              {steps.map((s, i) => {
                const state = stage > i ? "done" : stage === i ? "active" : "";
                return (
                  <div key={i} className={`step ${state}`}>
                    <div className="num">{stage > i ? <Icon name="check" size={11}/> : i+1}</div>
                    <div className="body" style={{ flex:1 }}>
                      <div className="title">{s.t}</div>
                      <div className="desc">{s.d}</div>
                    </div>
                    {stage === i && <div className="spinner"/>}
                  </div>
                );
              })}
            </div>
            <div className="modal-foot">
              <div><Icon name="lock" size={11} style={{ verticalAlign:"-1px", marginRight:4 }}/>Stored in 1Password</div>
              {status === "done"
                ? <span style={{ color:"var(--positive)", fontWeight:500, fontSize:12.5 }}>Connected!</span>
                : <button className="btn btn-ghost btn-sm" disabled>Working...</button>}
            </div>
          </>
        )}

        {status === "error" && (
          <>
            <div className="modal-head">
              <div><h3>Connection failed</h3></div>
              <button className="modal-x" onClick={onClose}><Icon name="x"/></button>
            </div>
            <div className="modal-body">
              <div style={{ padding:"16px", background:"color-mix(in oklab, var(--danger) 8%, var(--surface))", borderRadius:8, fontSize:12.5, color:"var(--danger)", fontFamily:"var(--mono)", lineHeight:1.5 }}>
                {error}
              </div>
            </div>
            <div className="modal-foot">
              <div/>
              <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── inline bill add (Excel-style) ─────────────────────────────────────

function BillAddRow({ onAdd, onCancel, autoFocus }) {
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const dateRef = useRef(null);
  const nameRef = useRef(null);
  const amtRef = useRef(null);
  const rowRef = useRef(null);

  useEffect(() => { if (autoFocus) setTimeout(() => dateRef.current?.focus(), 0); }, [autoFocus]);
  useEffect(() => {
    const onClick = (e) => { if (rowRef.current && !rowRef.current.contains(e.target)) onCancel?.(); };
    setTimeout(() => document.addEventListener("mousedown", onClick), 0);
    return () => document.removeEventListener("mousedown", onClick);
  }, [onCancel]);

  const reset = () => { setDate(""); setName(""); setAmount(""); };
  const cancel = () => { reset(); onCancel?.(); };

  const commit = () => {
    const amt = parseFloat(amount);
    if (!date || !name || isNaN(amt)) {
      if (!date) dateRef.current?.focus();
      else if (!name) nameRef.current?.focus();
      else if (isNaN(amt)) amtRef.current?.focus();
      return;
    }
    onAdd({ date: normalizeDate(date), name: name.trim(), account: "", amount: amt });
    reset();
  };

  const onCellKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
    else if (e.key === "Enter") { e.preventDefault(); commit(); }
  };
  const onAmountKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
    else if (e.key === "Enter") { e.preventDefault(); commit(); }
  };

  const wd = date ? computeWeekday(date) : "";
  const amtNum = parseFloat(amount);
  const amtClass = isNaN(amtNum) ? "" : amtNum < 0 ? "neg" : "pos";

  return (
    <div className="bill-add editing" ref={rowRef}>
      <div className="b-date">
        <input ref={dateRef} placeholder="M/D" value={date}
          onChange={(e) => setDate(e.target.value)} onKeyDown={onCellKey} />
        <div className="wd">{wd || " "}</div>
      </div>
      <div className="b-main">
        <input ref={nameRef} className="name" placeholder="Name"
          value={name} onChange={(e) => setName(e.target.value)} onKeyDown={onCellKey} />
      </div>
      <div className="b-amt">
        <input ref={amtRef} type="text" placeholder="-0.00" className={amtClass}
          title="Negative = money out (bills) · Positive = money in (income)"
          value={amount} onChange={(e) => setAmount(e.target.value)} onKeyDown={onAmountKey} />
      </div>
    </div>
  );
}

// ─── AI bill bar ───────────────────────────────────────────────────────

function AiBillBar({ accounts, onAddMany }) {
  const [q, setQ] = useState("");
  const [thinking, setThinking] = useState(false);
  const [suggestions, setSuggestions] = useState(null);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const submit = async () => {
    const text = q.trim();
    if (!text || thinking) return;
    setThinking(true); setError(null); setSuggestions(null);

    const todayStr = `${TODAY.getMonth() + 1}/${TODAY.getDate()}/${TODAY.getFullYear().toString().slice(-2)}`;
    const accountList = accounts.map(a => `- "${a}"`).join("\n");

    const prompt = `You parse natural-language requests into upcoming bill entries for a personal finance ledger.

Today is: ${todayStr}
Available accounts:
${accountList}

User request: """${text}"""

Return ONLY a JSON array of bill objects. Each object MUST have:
- "date":    "M/D" string (e.g. "6/15") — interpret relative dates relative to today
- "name":    short bill name (e.g. "Mortgage", "Payday")
- "account": one of the available accounts above EXACTLY as written, or "" if unclear
- "amount":  number — NEGATIVE for outflows/bills/expenses, POSITIVE for income/inflows
- "kind":    one of "", "payday", "transfer", "due-soon" (use "payday" for income, "transfer" for inter-account, "due-soon" for items due within 5 days of today)

Output ONLY the JSON array. No markdown, no prose, no code fences. Example:
[{"date":"6/15","name":"Mortgage","account":"Main Checking ····0142","amount":-2869,"kind":""}]`;

    try {
      const raw = await window.claude.complete(prompt);
      const clean = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      const parsed = JSON.parse(clean);
      if (!Array.isArray(parsed)) throw new Error("Expected array");
      if (parsed.length === 0) setError("Couldn't find any bills in that. Try being more specific.");
      else setSuggestions(parsed);
    } catch (e) {
      setError("Couldn't understand that. Try: \"add water bill for $138 on the 18th from Main Checking\".");
    } finally {
      setThinking(false);
    }
  };

  const accept = () => {
    onAddMany(suggestions);
    setSuggestions(null);
    setQ("");
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <div className="ai-bar-wrap">
      <div className={`ai-bar ${thinking ? "thinking" : ""}`}>
        <div className="spark"><Icon name="spark" size={14}/></div>
        <input ref={inputRef}
          placeholder="Add bills in plain English — e.g. “water $138 on the 18th, internet $90 on the 6th”"
          value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          disabled={thinking} />
        {thinking ? <div className="spin"/> :
          <button className="send" onClick={submit} disabled={!q.trim()}>↵ Parse</button>}
      </div>

      {error && <div className="ai-error">{error}</div>}

      {suggestions && (
        <div className="ai-suggest">
          <div className="head">
            <span>{suggestions.length} bill{suggestions.length === 1 ? "" : "s"} parsed</span>
            <span style={{ color:"var(--muted)" }}>review & confirm</span>
          </div>
          {suggestions.map((s, i) => (
            <div className="item" key={i}>
              <div className="d">{s.date}<span>{computeWeekday(s.date) || " "}</span></div>
              <div className="n">{s.name}<span>{s.account || "(no account)"}</span></div>
              <div className={`a ${s.amount < 0 ? "neg" : "pos"}`}>{fmtMoney(s.amount)}</div>
            </div>
          ))}
          <div className="actions">
            <button className="btn btn-ghost btn-sm" onClick={() => setSuggestions(null)}>Discard</button>
            <button className="btn btn-primary btn-sm" onClick={accept}>Add {suggestions.length} bill{suggestions.length === 1 ? "" : "s"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── empty state (cold-start handoff to Claude) ─────────────────────────
// On a fresh clone there's no data yet. Rather than a dead-end, point the user
// at the thing that actually populates Ledger: Claude. The `ask` is a literal
// phrase they can say.

function EmptyState({ icon = "spark", title, body, ask }) {
  return (
    <div className="empty-state">
      <div className="empty-ico"><Icon name={icon} size={20}/></div>
      <div className="empty-title">{title}</div>
      {body && <div className="empty-body">{body}</div>}
      {ask && (
        <div className="empty-ask">
          Ask Claude: <span className="empty-cmd">“{ask}”</span>
        </div>
      )}
    </div>
  );
}

// ─── API peek modal ────────────────────────────────────────────────────

function ApiModal({ onClose }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const code =
`// Everything below renders immediately. State updates are synchronous.

// ─── Bills ──────────────────────────────────────────────────────────
window.Ledger.bills.list()
window.Ledger.bills.add({ date: "6/15", name: "Mortgage",
                          account: "Main Checking ····0142",
                          amount: -2869, kind: "" })
window.Ledger.bills.addMany([ { ... }, { ... } ])
window.Ledger.bills.update(id, { amount: -2900 })
window.Ledger.bills.remove(id)
window.Ledger.bills.clear()

// ─── Transactions ──────────────────────────────────────────────────
window.Ledger.transactions.list()
window.Ledger.transactions.update(id, {
  description: "Work lunch",
  lineCode:    "1001",
  // OR splits to spread one txn across codes:
  splits: [
    { code: "1003", amount: -184.20, description: "Groceries" },
    { code: "1004", amount: -42.20,  description: "Wine" }
  ]
})
window.Ledger.transactions.codeMatching(/Spotify/, "3008")  // bulk-code by regex

// ─── Accounts ──────────────────────────────────────────────────────
window.Ledger.accounts.list()
window.Ledger.accounts.setNickname(acctId, "Main Checking")

// ─── Institutions ──────────────────────────────────────────────────
window.Ledger.institutions.list()

// ─── Line codes ────────────────────────────────────────────────────
window.Ledger.lineCodes.list()

// ─── Summary helpers ───────────────────────────────────────────────
window.Ledger.summary.netWorth()
window.Ledger.summary.totalsByCode("ytd")    // "ytd" | "month" | "30d" | "90d" | "all"
window.Ledger.summary.netForPeriod("ytd")`;

  const copy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  const highlighted = code
    .replace(/(\/\/[^\n]*)/g, '<span class="c">$1</span>')
    .replace(/("[^"]*")/g, '<span class="s">$1</span>')
    .replace(/\b(-?\d+(?:\.\d+)?)\b/g, '<span class="n">$1</span>')
    .replace(/\b(window|Ledger|bills|institutions|accounts|transactions|lineCodes|summary|list|add|addMany|update|remove|clear|setNickname|codeMatching|netWorth|totalsByCode|netForPeriod)\b/g, '<span class="k">$1</span>');

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal api-modal" style={{ width:"min(680px, calc(100vw - 32px))" }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3>Ledger API</h3>
            <p>Everything in this app is programmatically addressable.</p>
          </div>
          <button className="modal-x" onClick={onClose}><Icon name="x"/></button>
        </div>
        <div className="modal-body">
          <div style={{ position:"relative" }}>
            <button className="copy" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
            <pre dangerouslySetInnerHTML={{ __html: highlighted }}/>
          </div>
        </div>
        <div className="modal-foot">
          <div>Try it: <span style={{ fontFamily:"var(--mono)", color:"var(--ink)" }}>window.Ledger.summary.totalsByCode("ytd")</span></div>
          <button className="btn btn-primary btn-sm" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ─── date range picker ────────────────────────────────────────────────

const CAL_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const CAL_DAYS = ["Su","Mo","Tu","We","Th","Fr","Sa"];

function daysForMonth(year, month) {
  const first = new Date(year, month, 1);
  const startDay = first.getDay();
  const cells = [];
  for (let i = 0; i < startDay; i++) {
    const d = new Date(year, month, -startDay + i + 1);
    cells.push({ date: d, other: true });
  }
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let i = 1; i <= daysInMonth; i++) cells.push({ date: new Date(year, month, i), other: false });
  while (cells.length < 42) {
    const d = new Date(year, month + 1, cells.length - startDay - daysInMonth + 1);
    cells.push({ date: d, other: true });
  }
  return cells;
}

function sameDay(a, b) {
  return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function DateRangePicker({ from, to, onChange, align = "right" }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [viewYear, setViewYear] = useState(() => (from || TODAY).getFullYear());
  const [viewMonth, setViewMonth] = useState(() => (from || TODAY).getMonth());
  const [picking, setPicking] = useState(null);
  const [hoverDate, setHoverDate] = useState(null);
  const triggerRef = useRef(null);
  const calRef = useRef(null);

  useEffect(() => {
    if (!open) { setPos(null); return; }
    const updatePos = () => {
      if (!triggerRef.current) return;
      const r = triggerRef.current.getBoundingClientRect();
      const p = { top: r.bottom + 4 };
      if (align === "right") p.right = window.innerWidth - r.right;
      else p.left = r.left;
      setPos(p);
    };
    updatePos();
    const onDown = (e) => {
      if (triggerRef.current?.contains(e.target) || calRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    window.addEventListener("scroll", updatePos, true);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("scroll", updatePos, true); };
  }, [open, align]);

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  };

  const pickDay = (d) => {
    if (!picking) {
      setPicking(d);
      setHoverDate(null);
    } else {
      const a = d < picking ? d : picking;
      const b = d < picking ? picking : d;
      setPicking(null);
      onChange(a, b);
      setOpen(false);
    }
  };

  const clear = (e) => {
    e.stopPropagation();
    setPicking(null);
    onChange(null, null);
    setOpen(false);
  };

  const rangeStart = picking || from;
  const rangeEnd = picking ? hoverDate : to;
  const rLo = rangeStart && rangeEnd ? (rangeStart < rangeEnd ? rangeStart : rangeEnd) : null;
  const rHi = rangeStart && rangeEnd ? (rangeStart < rangeEnd ? rangeEnd : rangeStart) : null;

  const hasValue = from || to;
  const label = from && to
    ? `${from.getMonth()+1}/${from.getDate()} – ${to.getMonth()+1}/${to.getDate()}`
    : from ? `${from.getMonth()+1}/${from.getDate()} –` : "";

  const renderMonth = (y, m) => {
    const cells = daysForMonth(y, m);
    return (
      <div className="cal-month">
        <div className="cal-month-label">{CAL_MONTHS[m]} {y}</div>
        <div className="cal-grid">
          {CAL_DAYS.map(d => <div key={d} className="cal-dow">{d}</div>)}
          {cells.map((c, i) => {
            const isStart = sameDay(c.date, rLo);
            const isEnd = sameDay(c.date, rHi);
            const inRange = rLo && rHi && c.date > rLo && c.date < rHi;
            const isToday = sameDay(c.date, TODAY);
            const cls = ["cal-day",
              c.other && "other",
              isToday && "today",
              isStart && "range-start",
              isEnd && "range-end",
              inRange && "in-range",
            ].filter(Boolean).join(" ");
            return (
              <div key={i} className={cls}
                onClick={() => pickDay(c.date)}
                onMouseEnter={() => picking && setHoverDate(c.date)}>
                {c.date.getDate()}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const m2 = viewMonth === 11 ? 0 : viewMonth + 1;
  const y2 = viewMonth === 11 ? viewYear + 1 : viewYear;

  return (
    <>
      <div ref={triggerRef}
        className={`f-date cal-trigger ${hasValue ? "has-value" : ""}`}
        onClick={() => { setOpen(o => !o); if (!open && from) { setViewYear(from.getFullYear()); setViewMonth(from.getMonth()); } }}>
        <span className="lbl">Date</span>
        {hasValue
          ? <span className="cal-label">{label}</span>
          : <span className="cal-label cal-placeholder">Select</span>}
        {hasValue && <span className="cal-clear" onClick={clear}>×</span>}
      </div>
      {open && pos && ReactDOM.createPortal(
        <div ref={calRef} className="cal-drop" style={{ ...pos }}>
          <div className="cal-nav">
            <button onClick={prevMonth}>‹</button>
            <div />
            <button onClick={nextMonth}>›</button>
          </div>
          <div className="cal-months" onMouseLeave={() => setHoverDate(null)}>
            {renderMonth(viewYear, viewMonth)}
            {renderMonth(y2, m2)}
          </div>
          {picking && <div className="cal-hint">Select end date</div>}
        </div>,
        document.body
      )}
    </>
  );
}

// ─── export to window ──────────────────────────────────────────────────

Object.assign(window, {
  // helpers
  TODAY, WEEKDAYS, fmtMoney, fmtCompact, fmtDate, relTime, computeWeekday, parseDate, nextId, normalizeDate,
  PERIODS, periodLabel, inPeriod, aggregateByCode, uncodedInPeriod,
  // data loading
  loadLedgerData, fetchApi, mapTransaction, mapInstitution, mapBill, setLineCodes,
  // components
  Icon, Logo, CodePicker, DateRangePicker, TxnMoreInfo, TxnExpand, AcctExpand,
  AddModal, BillAddRow, AiBillBar, ApiModal, EmptyState,
});

// Mutable catalog vars — must be defineProperty so cross-module reads
// see updates after setLineCodes() runs (Object.assign copies values, not getters)
for (const [key, get] of [
  ["LINE_CODES", () => LINE_CODES],
  ["CODE_BY_NUM", () => CODE_BY_NUM],
  ["CATEGORIES_ORDER", () => CATEGORIES_ORDER],
]) {
  Object.defineProperty(window, key, { get, configurable: true });
}

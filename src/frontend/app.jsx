// ledger-app.jsx — Ledger main app
// Tabs: Overview · Cashflow · Transactions · Accounts
// Data loaded from local API (Bun + SQLite)

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "hideBalances": false,
  "accent": "#1F4F4A"
}/*EDITMODE-END*/;




// ─── overview tab ──────────────────────────────────────────────────────

function computeAmortization(principal, annualRate, termMonths, startDate) {
  const monthlyRate = annualRate / 100 / 12;
  const payment = monthlyRate === 0
    ? principal / termMonths
    : principal * monthlyRate / (1 - Math.pow(1 + monthlyRate, -termMonths));
  const schedule = [];
  let balance = principal;
  const start = new Date(startDate);
  for (let i = 1; i <= termMonths; i++) {
    const interest = balance * monthlyRate;
    const principalPmt = payment - interest;
    balance -= principalPmt;
    const d = new Date(start);
    d.setMonth(d.getMonth() + i);
    schedule.push({
      month: i,
      date: d.toISOString().slice(0, 7),
      payment: Math.round(payment * 100) / 100,
      principal: Math.round(principalPmt * 100) / 100,
      interest: Math.round(interest * 100) / 100,
      balance: Math.max(0, Math.round(balance * 100) / 100),
    });
  }
  return { payment: Math.round(payment * 100) / 100, schedule };
}

function AmortizationModal({ account, onClose }) {
  const { loan_origination_amount: orig, rate, loan_term_months: term, loan_origination_date: startDate, balance } = account;
  const { payment, schedule } = useMemo(
    () => computeAmortization(orig, rate, term, startDate),
    [orig, rate, term, startDate]
  );

  const today = new Date().toISOString().slice(0, 7);
  const currentIdx = schedule.findIndex(s => s.date > today);
  const paid = currentIdx >= 0 ? currentIdx : schedule.length;
  const remaining = term - paid;
  const totalInterest = schedule.reduce((s, r) => s + r.interest, 0);
  const interestPaid = schedule.slice(0, paid).reduce((s, r) => s + r.interest, 0);
  const principalPaid = orig - Math.abs(balance);
  const maturity = schedule[schedule.length - 1]?.date || "—";

  const listRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (listRef.current) {
      const row = listRef.current.querySelector(".amort-current");
      if (row) row.scrollIntoView({ block: "center" });
    }
  }, []);

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal amort-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3>Mortgage amortization</h3>
            <p>{fmtMoney(orig)} · {rate}% fixed · {term / 12}yr</p>
          </div>
          <button className="modal-x" onClick={onClose}><Icon name="x"/></button>
        </div>
        <div className="modal-body" style={{ padding: "0 22px 12px" }}>
          <div className="amort-stats">
            <div><span className="label">Monthly P&I</span><span className="val">{fmtMoney(payment)}</span></div>
            <div><span className="label">Payments made</span><span className="val">{paid} of {term}</span></div>
            <div><span className="label">Remaining</span><span className="val">{remaining} ({(remaining / 12).toFixed(1)}y)</span></div>
            <div><span className="label">Maturity</span><span className="val">{maturity}</span></div>
            <div><span className="label">Principal paid</span><span className="val">{fmtMoney(principalPaid)}</span></div>
            <div><span className="label">Interest paid</span><span className="val">{fmtMoney(interestPaid)}</span></div>
            <div><span className="label">Total interest</span><span className="val">{fmtMoney(totalInterest)}</span></div>
            <div><span className="label">Interest saved</span><span className="val">{fmtMoney(totalInterest - interestPaid)}</span></div>
          </div>
          <div className="amort-table" ref={listRef}>
            <table>
              <thead><tr><th>#</th><th>Date</th><th>Payment</th><th>Principal</th><th>Interest</th><th>Balance</th></tr></thead>
              <tbody>
                {schedule.map(r => {
                  const isCurrent = r.date === today;
                  const isPast = r.date < today && !isCurrent;
                  return (
                    <tr key={r.month} className={isCurrent ? "amort-current" : isPast ? "amort-past" : ""}>
                      <td>{r.month}</td>
                      <td>{r.date}</td>
                      <td>{fmtMoney(r.payment)}</td>
                      <td>{fmtMoney(r.principal)}</td>
                      <td>{fmtMoney(r.interest)}</td>
                      <td>{fmtMoney(r.balance)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function BalanceChart({ accountId }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetchApi(`/api/balance-history?account_id=${accountId}`).then(setData);
  }, [accountId]);

  if (!data || data.length < 2) return (
    <div className="bal-chart-empty">Not enough history yet — chart builds with each sync</div>
  );

  const W = 400, H = 100, PAD = 4;
  const balances = data.map(d => d.balance);
  const min = Math.min(...balances), max = Math.max(...balances);
  const range = max - min || 1;
  const pts = data.map((d, i) => {
    const x = PAD + (i / (data.length - 1)) * (W - PAD * 2);
    const y = PAD + (1 - (d.balance - min) / range) * (H - PAD * 2);
    return { x, y, date: d.recorded_at, balance: d.balance };
  });
  const line = pts.map(p => `${p.x},${p.y}`).join(" ");
  const areaPath = `M${pts[0].x},${H} L${line} L${pts[pts.length-1].x},${H} Z`;
  const change = balances[balances.length - 1] - balances[0];
  const color = change >= 0 ? "var(--accent)" : "#c44";

  return (
    <div className="bal-chart">
      <div className="bal-chart-header">
        <span>{data[0].recorded_at} → {data[data.length - 1].recorded_at}</span>
        <span style={{ color }}>{change >= 0 ? "+" : ""}{fmtMoney(change)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="bal-chart-svg">
        <path d={areaPath} fill={color} opacity="0.08" />
        <polyline points={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={pts[pts.length-1].x} cy={pts[pts.length-1].y} r="3" fill={color} />
      </svg>
      <div className="bal-chart-range">
        <span>{fmtMoney(min)}</span>
        <span>{fmtMoney(max)}</span>
      </div>
    </div>
  );
}

function AccountDetailModal({ category, accounts, onClose }) {
  const total = accounts.reduce((s, a) => s + a.balance, 0);
  const sorted = [...accounts].sort((a, b) => b.balance - a.balance);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal acct-detail-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3>{category}</h3>
            <p>{accounts.length} account{accounts.length > 1 ? "s" : ""} · {fmtMoney(total)} total</p>
          </div>
          <button className="modal-x" onClick={onClose}><Icon name="x"/></button>
        </div>
        <div className="modal-body" style={{ padding: "0 22px 18px" }}>
          <div className="acct-detail-list">
            {sorted.map((a, i) => (
              <div key={i} className={`acct-detail-item${expanded === i ? " is-expanded" : ""}`}>
                <div className="acct-detail-row" onClick={() => setExpanded(expanded === i ? null : i)}>
                  <div className="acct-detail-main">
                    <div className="acct-detail-name">{a.name}</div>
                    <div className="acct-detail-meta">
                      {a.institution}
                      {a.subtype ? ` · ${a.subtype}` : ""}
                      {a.mask && a.mask !== "····" ? ` · ····${a.mask}` : ""}
                    </div>
                  </div>
                  <div className="acct-detail-bal">
                    <div className="acct-detail-amount">{fmtMoney(a.balance)}</div>
                  </div>
                </div>
                {expanded === i && <BalanceChart accountId={a.id} />}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// Asset and liability blocks are both user-customizable (served from
// /api/account-blocks); these are only the fallbacks used before they load.
// Mortgage / Auto Loan / Credit render as bespoke liability cells (amortization,
// payoff, utilization); any other liability block renders as a generic cell.
const DEFAULT_ASSET_CATS = ["Checking", "Savings", "Retirement", "Brokerage", "Real Estate"];
const LIAB_CATS = ["Mortgage", "Auto Loan", "Loan", "Credit"];

function NetWorthPanel({ institutions, accountBlocks, hide, onReload }) {
  const [showAmort, setShowAmort] = useState(false);
  const [detailCat, setDetailCat] = useState(null);
  const [manageOpen, setManageOpen] = useState(false);

  // Asset blocks come from the customizable catalog; fall back to defaults
  // until it loads. Order is preserved from the API (sort_order).
  const assetCats = useMemo(() => {
    const names = (accountBlocks || [])
      .filter(b => (b.kind || "asset") === "asset")
      .map(b => b.name);
    return names.length ? names : DEFAULT_ASSET_CATS;
  }, [accountBlocks]);

  const liabCats = useMemo(() => {
    const names = (accountBlocks || [])
      .filter(b => b.kind === "liability")
      .map(b => b.name);
    return names.length ? names : LIAB_CATS;
  }, [accountBlocks]);

  const [included, setIncluded] = useState(() => {
    let saved = {};
    try {
      const parsed = JSON.parse(localStorage.getItem("nw-included"));
      if (parsed && typeof parsed === "object") saved = parsed;
    } catch {}
    return saved;
  });
  // A block is included unless the user explicitly turned it off, so blocks
  // added after this preference was first saved default to "on".
  const isOn = (k) => included[k] !== false;
  const toggleIncluded = (k, e) => {
    e.stopPropagation();
    setIncluded(prev => {
      const next = { ...prev, [k]: !(prev[k] !== false) };
      localStorage.setItem("nw-included", JSON.stringify(next));
      return next;
    });
  };

  // Single partition so the cells (blocks + Unsorted) always reconcile to the
  // headline totals — no account silently dropped from the breakdown.
  const part = useMemo(() => {
    const flat = institutions.flatMap(i => i.accounts.map(a => ({
      id: a.id, name: a.nickname || a.name, category: a.category, balance: a.balance,
      institution: i.name, subtype: a.subtype, mask: a.mask, available: a.available,
      apy: a.apy, limit: a.limit, metadata: a.metadata,
      rate: a.rate, loan_origination_date: a.loan_origination_date, loan_term_months: a.loan_term_months,
    })));
    return partitionNetWorth(flat, assetCats, liabCats);
  }, [institutions, assetCats, liabCats]);

  const cats = useMemo(() => ({
    c: part.assetCells,
    unsorted: part.unsortedAssets,
    unsortedSum: part.unsortedAssetSum,
    assets: part.assets, debts: part.debts, net: part.net,
  }), [part]);

  const liab = useMemo(() => {
    const sums = {};
    liabCats.forEach(k => { sums[k] = (part.liabCells[k] || []).reduce((s, a) => s + a.balance, 0); });
    const all = [...Object.values(part.liabCells).flat(), ...part.unsortedLiabs];
    const mortgageAcct = all.find(a => a.category === "Mortgage") || null;
    const autoAcct = all.find(a => a.category === "Auto Loan") || null;
    const creditLimit = all.filter(a => a.category === "Credit" && a.limit).reduce((s, a) => s + a.limit, 0);
    return { sums, creditLimit, total: part.debts, mortgageAcct, autoAcct,
             unsorted: part.unsortedLiabs, unsortedSum: part.unsortedLiabSum };
  }, [part, liabCats]);

  const mortgageSub = useMemo(() => {
    const a = liab.mortgageAcct;
    if (!a || !a.rate) return "—";
    if (a.loan_origination_date && a.loan_term_months) {
      const start = new Date(a.loan_origination_date);
      const now = new Date();
      const elapsed = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
      const remaining = a.loan_term_months - elapsed;
      const yrsLeft = Math.round(remaining / 12);
      return `${a.rate}% fixed · ${yrsLeft}y left`;
    }
    return `${a.rate}% fixed`;
  }, [liab.mortgageAcct]);

  const autoSub = useMemo(() => {
    const a = liab.autoAcct;
    if (!a) return "—";
    const rate = a.rate ? `${a.rate}%` : "";
    const bal = Math.abs(a.balance);
    if (bal > 0 && bal <= 600) {
      const pmts = Math.ceil(bal / 530);
      return rate ? `${rate} · ${pmts} pmt${pmts > 1 ? "s" : ""} left` : `${pmts} pmt${pmts > 1 ? "s" : ""} left`;
    }
    return rate || "—";
  }, [liab.autoAcct]);

  const allIncluded = assetCats.every(isOn) && liabCats.every(isOn);
  const filtered = useMemo(() => {
    // Unsorted buckets are always counted (they're "everything else" — excluding
    // them would re-open the reconciliation gap the partition closes).
    let assets = cats.unsortedSum, debts = liab.unsortedSum;
    assetCats.forEach(k => {
      if (isOn(k)) assets += cats.c[k].reduce((s, a) => s + a.balance, 0);
    });
    liabCats.forEach(k => {
      if (isOn(k)) debts += liab.sums[k] || 0;
    });
    return { assets, debts, net: assets + debts };
  }, [cats, liab, included, assetCats, liabCats]);

  const displayAssets = allIncluded ? cats.assets : filtered.assets;
  const displayDebts = allIncluded ? liab.total : filtered.debts;
  const displayNet = allIncluded ? cats.net : filtered.net;
  const pct = (v) => displayAssets > 0 ? Math.round(v / displayAssets * 100) : 0;
  const blur = hide ? "nw-bal-hidden" : "";

  return (
    <div className="nw">
      <div className="nw-head">
        <div className="left">
          <div className="label">Current account balance · net worth{!allIncluded ? " (filtered)" : ""}</div>
          <div className={`total ${blur}`}>{fmtMoney(displayNet)}</div>
          <div className="delta">
            <b>{fmtMoney(displayAssets)}</b> assets
            <span style={{ margin:"0 8px", color:"var(--muted-2)" }}>·</span>
            <b className="neg">{fmtMoney(displayDebts)}</b> liabilities
            <span style={{ margin:"0 8px", color:"var(--muted-2)" }}>·</span>
            across {institutions.reduce((n, i) => n + i.accounts.length, 0)} accounts
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => setManageOpen(true)}>
          <Icon name="grip-vertical" size={11} style={{ verticalAlign:"-1px", marginRight:5 }}/>
          Edit blocks
        </button>
      </div>

      <div className="nw-assets">
        <div className="cell hero">
          <div className="h">Total assets</div>
          <div className={`v ${blur}`}>{fmtMoney(displayAssets)}</div>
        </div>
        {assetCats.map(k => {
          const sum = cats.c[k].reduce((s, a) => s + a.balance, 0);
          const hasAccounts = cats.c[k].length > 0;
          const on = isOn(k);
          return (
            <div className={`cell${hasAccounts ? " clickable" : ""}${!on ? " nw-excluded" : ""}`} key={k}
              onClick={hasAccounts ? () => setDetailCat(k) : undefined}>
              <input type="checkbox" className="nw-check" checked={on}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => toggleIncluded(k, e)} />
              <div className="h">{k}</div>
              <div className={`v ${blur}`}>{fmtMoney(sum, {minFrac:0})}</div>
              <div className={`accts ${blur}`}>
                {cats.c[k].map((a, i) => (
                  <div key={i}>
                    <span>{a.name}</span>
                    <span>{fmtCompact(a.balance)}</span>
                  </div>
                ))}
                {cats.c[k].length === 0 && <div style={{ color:"var(--muted-2)" }}>—</div>}
              </div>
            </div>
          );
        })}
        {cats.unsorted.length > 0 && (
          <div className="cell clickable" onClick={() => setDetailCat("__unsorted_asset__")}
               title="Accounts not assigned to a block — assign them from the Accounts tab">
            <div className="h">Unsorted</div>
            <div className={`v ${blur}`}>{fmtMoney(cats.unsortedSum, {minFrac:0})}</div>
            <div className={`accts ${blur}`}>
              {cats.unsorted.map((a, i) => (
                <div key={i}><span>{a.name}</span><span>{fmtCompact(a.balance)}</span></div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="nw-liab">
        <div className="cell hero">
          <div className="h">Total liabilities</div>
          <div className={`v ${blur}`}>{fmtMoney(displayDebts)}</div>
        </div>
        {liabCats.map(k => {
          const sum = liab.sums[k] || 0;
          const on = isOn(k);
          const excl = on ? "" : " nw-excluded";
          const check = (
            <input type="checkbox" className="nw-check" checked={on}
              onClick={e => e.stopPropagation()} onChange={e => toggleIncluded(k, e)} />
          );
          if (k === "Mortgage") {
            return (
              <div className={`cell clickable${excl}`} key={k}
                onClick={() => liab.mortgageAcct?.loan_origination_date && setShowAmort(true)}>
                {check}
                <div className="h">Mortgage</div>
                <div className={`v ${blur}`}>{fmtMoney(sum)}</div>
                <div className="sub">{mortgageSub}</div>
              </div>
            );
          }
          if (k === "Auto Loan") {
            return (
              <div className={`cell${excl}`} key={k}>
                {check}
                <div className="h">Auto loan</div>
                <div className={`v ${blur}`}>{fmtMoney(sum)}</div>
                <div className="sub">{autoSub}</div>
              </div>
            );
          }
          if (k === "Credit") {
            return (
              <div className={`cell${excl}`} key={k}>
                {check}
                <div className="h">Credit balance</div>
                <div className={`v ${blur}`}>{fmtMoney(sum)}</div>
                <div className="sub">of {fmtCompact(liab.creditLimit)} · {liab.creditLimit > 0 ? ((Math.abs(sum)/liab.creditLimit)*100).toFixed(0) : 0}% utl</div>
              </div>
            );
          }
          return (
            <div className={`cell${excl}`} key={k}>
              {check}
              <div className="h">{k}</div>
              <div className={`v ${blur}`}>{fmtMoney(sum)}</div>
            </div>
          );
        })}
        {liab.unsorted.length > 0 && (
          <div className="cell clickable" onClick={() => setDetailCat("__unsorted_liab__")}
               title="Debts not assigned to a block — assign them from the Accounts tab">
            <div className="h">Unsorted</div>
            <div className={`v ${blur}`}>{fmtMoney(liab.unsortedSum)}</div>
          </div>
        )}
      </div>
      {showAmort && liab.mortgageAcct && (
        <AmortizationModal account={liab.mortgageAcct} onClose={() => setShowAmort(false)} />
      )}
      {detailCat === "__unsorted_asset__" && (
        <AccountDetailModal category="Unsorted" accounts={cats.unsorted} onClose={() => setDetailCat(null)} />
      )}
      {detailCat === "__unsorted_liab__" && (
        <AccountDetailModal category="Unsorted" accounts={liab.unsorted} onClose={() => setDetailCat(null)} />
      )}
      {detailCat && !detailCat.startsWith("__unsorted") && cats.c[detailCat] && (
        <AccountDetailModal category={detailCat} accounts={cats.c[detailCat]} onClose={() => setDetailCat(null)} />
      )}
      {manageOpen && (
        <ManageBlocksModal accountBlocks={accountBlocks} onClose={() => setManageOpen(false)} onChanged={onReload} />
      )}
    </div>
  );
}


function OverviewTab({ institutions, transactions, accountBlocks, period, setPeriod, customRange, setCustomRange, hideEmpty, setHideEmpty, hide, onJumpToUncoded, onReload }) {
  const byCode = useMemo(() => aggregateByCode(transactions, period, TODAY, customRange), [transactions, period, customRange]);
  const uncoded = useMemo(() => uncodedInPeriod(transactions, period, TODAY, customRange), [transactions, period, customRange]);
  const uncodedTotal = uncoded.reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const [collapsed, setCollapsed] = useState({});
  const [manageCodes, setManageCodes] = useState(false);

  const catTotals = {};
  CATEGORIES_ORDER.forEach(cat => {
    catTotals[cat] = LINE_CODES.filter(c => c.category === cat).reduce((sum, c) => sum + (byCode[c.code]?.total || 0), 0);
  });
  // "Net for period" is a spend figure — income and transfers (spending:false)
  // are excluded deterministically so they can't flip the number's meaning.
  const netForPeriod = splitBySpending(byCode, LINE_CODES).spend;
  const spendingCats = CATEGORIES_ORDER.filter(cat => !isNonSpendingCategory(cat, LINE_CODES));
  const nonSpendingCats = CATEGORIES_ORDER.filter(cat => isNonSpendingCategory(cat, LINE_CODES));

  const renderCategory = (cat) => {
    const codes = LINE_CODES.filter(c => c.category === cat);
    const catSum = catTotals[cat];
    const isCollapsed = collapsed[cat];
    return (
      <div className="cat" key={cat}>
        <div className="cat-head" onClick={() => setCollapsed(p => ({ ...p, [cat]: !p[cat] }))} style={{ cursor:"default" }}>
          <div className="name">{cat} <em>{codes.length} codes</em></div>
          <div className={`sum ${catSum > 0 ? "pos" : catSum < 0 ? "neg" : ""} ${hide ? "private" : ""}`}>
            {fmtMoney(catSum)}
          </div>
        </div>
        {!isCollapsed && codes.map(c => {
          const data = byCode[c.code];
          const total = data?.total || 0;
          const count = data?.count || 0;
          if (hideEmpty && total === 0) return null;
          return (
            <div className="code-row" key={c.code}>
              <span className="code">{c.code}</span>
              <span className="lbl">{c.label}</span>
              <span className="count">{count > 0 ? `${count}×` : ""}</span>
              <span className={`amt ${total > 0 ? "pos" : total < 0 ? "neg" : "zero"} ${hide ? "private" : ""}`}>
                {total === 0 ? "—" : fmtMoney(total)}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <>
      {institutions.length === 0 && (
        <div className="coldstart-banner">
          <Icon name="spark" size={14}/>
          <span>
            This is the empty shape — your net-worth blocks and chart of accounts,
            waiting for data. Link a bank in <b>Accounts</b>, or ask Claude:
            <span className="cmd">“set up ledger”</span>
          </span>
        </div>
      )}

      <NetWorthPanel institutions={institutions} accountBlocks={accountBlocks} hide={hide} onReload={onReload} />

      <div className="topsheet-head">
        <h2>Topsheet <em>· {periodLabel(period, customRange)}</em></h2>
        <div className="period-picker">
          <button onClick={() => setManageCodes(true)} title="Add or edit expense categories">Edit categories</button>
          <span className="period-sep" />
          <button className={hideEmpty ? "on" : ""} onClick={() => setHideEmpty(h => { localStorage.setItem("topsheet-active-only", JSON.stringify(!h)); return !h; })}>Active only</button>
          <span className="period-sep" />
          {PERIODS.map(p => (
            <button key={p.key} className={period === p.key ? "on" : ""} onClick={() => { setPeriod(p.key); setCustomRange(null); }}>
              {p.label}
            </button>
          ))}
          <span className="period-sep" />
          <DateRangePicker
            from={customRange?.from || null}
            to={customRange?.to || null}
            onChange={(from, to) => {
              if (from && to) { setPeriod("custom"); setCustomRange({ from, to }); }
              else { setPeriod("ytd"); setCustomRange(null); }
            }}
          />
        </div>
      </div>

      <div className="panel topsheet">
        {spendingCats.map(renderCategory)}

        {uncoded.length > 0 && (
          <div className="topsheet-uncoded">
            <span><b>{uncoded.length} uncoded</b> transactions in this period totaling {fmtMoney(uncodedTotal)}</span>
            <a onClick={onJumpToUncoded}>Code them →</a>
          </div>
        )}

        <div className="net-period">
          <div className="name">Net for {periodLabel(period)} <em style={{ fontStyle:"normal", color:"var(--muted-2)", fontSize:11 }}>· spending only</em></div>
          <div className={`val ${hide ? "private" : ""}`}>{fmtMoney(netForPeriod)}</div>
        </div>

        {nonSpendingCats.length > 0 && (
          <div className="nonspend-section">
            <div className="nonspend-head" style={{ fontSize:10.5, textTransform:"uppercase", letterSpacing:".07em", color:"var(--muted)", margin:"18px 0 4px" }}>
              Income & transfers <span style={{ textTransform:"none", letterSpacing:0 }}>· not counted in net</span>
            </div>
            {nonSpendingCats.map(renderCategory)}
          </div>
        )}
      </div>
      {manageCodes && (
        <ManageCodesModal onClose={() => setManageCodes(false)} onChanged={onReload} />
      )}
    </>
  );
}

// ─── transactions tab ──────────────────────────────────────────────────

const TXN_COLUMNS = [
  { key: "date",        label: "Date",        defaultW: 82,  min: 60, required: true },
  { key: "vendor",      label: "Vendor",      defaultW: 190, min: 80, required: true },
  { key: "description", label: "Description", defaultW: 190, min: 80 },
  { key: "source",      label: "Source",      defaultW: 140, min: 80 },
  { key: "line",        label: "Line",        defaultW: 150, min: 80 },
  { key: "amount",      label: "Amount",      defaultW: 100, min: 70, required: true, align: "right" },
];
const DEFAULT_TXN_COLS = ["description", "source", "line"];
const DEFAULT_COL_WIDTHS = Object.fromEntries(TXN_COLUMNS.map(c => [c.key, c.defaultW]));

function ColumnsPopover({ columns, visible, onChange, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    const t = setTimeout(() => document.addEventListener("mousedown", onClick), 0);
    document.addEventListener("keydown", onKey);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", onClick); document.removeEventListener("keydown", onKey); };
  }, []);

  const toggle = (key) => {
    onChange(visible.includes(key) ? visible.filter(k => k !== key) : [...visible, key]);
  };
  const optionalKeys = columns.filter(c => !c.required).map(c => c.key);
  const allOn = optionalKeys.every(k => visible.includes(k));

  return (
    <div className="col-pop" ref={ref}>
      <div className="ph">
        <span>Show columns</span>
        <a onClick={() => onChange(allOn ? [] : optionalKeys)}>{allOn ? "Hide all" : "Show all"}</a>
      </div>
      {columns.map(c => {
        const on = c.required || visible.includes(c.key);
        return (
          <div key={c.key} className={`col-tog ${on ? "on" : ""} ${c.required ? "disabled" : ""}`}
               onClick={() => !c.required && toggle(c.key)}>
            <div className="check">{on ? <Icon name="check" size={10}/> : null}</div>
            <div className="lbl">{c.label}</div>
            {c.required && <span className="key">required</span>}
          </div>
        );
      })}
    </div>
  );
}

function renderTxnCell(col, tx, hide, { onOpenEdit, onTapField } = {}) {
  const isSplit = tx.splits && tx.splits.length > 0;
  const code = tx.lineCode ? CODE_BY_NUM[tx.lineCode] : null;
  const tapField = (field) => (e) => { e.stopPropagation(); onTapField && onTapField(tx.id, field); };
  switch (col.key) {
    case "date":
      return <div key="date" className="txn-date">{fmtDate(tx.date)}<span className="wd"> {computeWeekday(tx.date).slice(0,3)}</span></div>;
    case "vendor":
      return <div key="vendor" className="txn-vendor" title={tx.vendor}>{tx.vendor}</div>;
    case "description":
      return <div key="description" className={`txn-desc tappable ${tx.description ? "" : "empty"}`} title={tx.description || ""} onClick={tapField("description")}>{tx.description || "—"}</div>;
    case "source":
      return <div key="source" className="txn-source" title={tx.accountDisplay || tx.account}>{tx.accountDisplay || tx.account}</div>;
    case "line":
      return (
        <div key="line" className="tappable" onClick={tapField("line")}>
          {isSplit ? (
            <span className="txn-code split">
              <span className="num">⟍ {tx.splits.length}</span>
              <span className="lbl">{tx.splits.map(s => s.code || "?").join(" / ")}</span>
            </span>
          ) : code ? (
            <span className="txn-code">
              <span className="num">{code.code}</span>
              <span className="lbl">{code.label}</span>
            </span>
          ) : (
            <span className="txn-code empty">+ assign code</span>
          )}
        </div>
      );
    case "amount":
      return (
        <div key="amount" className={`txn-amt ${tx.amount < 0 ? "neg" : "pos"} ${hide ? "private" : ""}`}>
          {fmtMoney(tx.amount)}
        </div>
      );
  }
  return null;
}

function CsvExportModal({ institutions, onClose, onToast }) {
  const sectionLabel = { fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--muted)", fontWeight: 500 };
  const allAccounts = useMemo(() =>
    (institutions || []).flatMap(i => i.accounts.map(a => ({
      id: a.id, label: a.nickname || a.name, institution: i.name, category: a.category,
    }))).filter(a => !["IRA","401K","529","Brokerage","Historical","Real Estate"].includes(a.category)),
    [institutions]);

  const [selected, setSelected] = useState(() => new Set(allAccounts.map(a => a.id)));
  const [exportPeriod, setExportPeriod] = useState("ytd");
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);
  const [includeTopsheet, setIncludeTopsheet] = useState(true);
  const [includeTransactions, setIncludeTransactions] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggle = (id) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allOn = allAccounts.every(a => selected.has(a.id));
  const toggleAll = () => setSelected(allOn ? new Set() : new Set(allAccounts.map(a => a.id)));

  const fmtD = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

  const resolvedRange = useMemo(() => {
    if (exportPeriod === "custom") return { from, to };
    if (exportPeriod === "all") return { from: null, to: null };
    const today = new Date();
    const to = today;
    let f;
    if (exportPeriod === "ytd") f = new Date(today.getFullYear(), 0, 1);
    else if (exportPeriod === "month") f = new Date(today.getFullYear(), today.getMonth(), 1);
    else if (exportPeriod === "30d") { f = new Date(today); f.setDate(f.getDate() - 30); }
    else if (exportPeriod === "90d") { f = new Date(today); f.setDate(f.getDate() - 90); }
    else f = null;
    return { from: f, to: f ? to : null };
  }, [exportPeriod, from, to]);

  const doExport = async (format) => {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (resolvedRange.from) params.set("from", fmtD(resolvedRange.from));
      if (resolvedRange.to) params.set("to", fmtD(resolvedRange.to));
      if (!allOn) params.set("accounts", [...selected].join(","));
      const isXlsx = format === "xlsx";
      if (isXlsx) {
        params.set("topsheet", String(includeTopsheet));
        params.set("transactions", String(includeTransactions));
      }
      const endpoint = isXlsx ? "/api/transactions/export" : "/api/transactions/csv";
      const ext = isXlsx ? "xlsx" : "csv";
      const resp = await fetch(`${endpoint}?${params}`, {
        headers: { "X-Ledger-Token": document.body.dataset.apiToken || "" },
      });
      if (!resp.ok) throw new Error(`Export failed: ${resp.status}`);
      const filename = `ledger-${new Date().toISOString().slice(0, 10)}.${ext}`;
      const blobUrl = URL.createObjectURL(await resp.blob());
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
      onClose();
      onToast(`Exported ${filename} to Downloads`);
    } catch (e) {
      console.error(e);
      onToast("Export failed — check console");
    } finally {
      setExporting(false);
    }
  };

  const byInst = useMemo(() => {
    const m = new Map();
    allAccounts.forEach(a => {
      if (!m.has(a.institution)) m.set(a.institution, []);
      m.get(a.institution).push(a);
    });
    return [...m.entries()];
  }, [allAccounts]);

  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal-head">
          <div>
            <h3>Export</h3>
            <p>Download as Excel workbook (.xlsx)</p>
          </div>
          <button className="modal-x" onClick={onClose}><Icon name="x"/></button>
        </div>
        <div className="modal-body">
          <div style={{ marginBottom: 16 }}>
            <div style={{ ...sectionLabel, marginBottom: 10 }}>Include sheets</div>
            <div style={{ display: "flex", gap: 20 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "default" }}
                onClick={() => setIncludeTopsheet(v => !v)}>
                <input type="checkbox" checked={includeTopsheet} readOnly style={{ accentColor: "var(--ink)" }} />
                Topsheet <span style={{ fontSize: 11, color: "var(--muted)" }}>(summary)</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "default" }}
                onClick={() => setIncludeTransactions(v => !v)}>
                <input type="checkbox" checked={includeTransactions} readOnly style={{ accentColor: "var(--ink)" }} />
                Transactions <span style={{ fontSize: 11, color: "var(--muted)" }}>(per account)</span>
              </label>
            </div>
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={{ ...sectionLabel, marginBottom: 8 }}>Date range</div>
            <div className="period-picker">
              {PERIODS.map(p => (
                <button key={p.key} className={exportPeriod === p.key ? "on" : ""} onClick={() => { setExportPeriod(p.key); setFrom(null); setTo(null); }}>
                  {p.label}
                </button>
              ))}
              <span className="period-sep" />
              <DateRangePicker from={exportPeriod === "custom" ? from : null} to={exportPeriod === "custom" ? to : null} align="left"
                onChange={(f, t) => { if (f && t) { setExportPeriod("custom"); setFrom(f); setTo(t); } else { setExportPeriod("ytd"); setFrom(null); setTo(null); } }} />
            </div>
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={sectionLabel}>Accounts</span>
              <button style={{ fontSize: 11, color: "var(--muted)", textDecoration: "underline" }} onClick={toggleAll}>
                {allOn ? "Deselect all" : "Select all"}
              </button>
            </div>
            <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, padding: "4px 0" }}>
              {byInst.map(([inst, accts]) => (
                <div key={inst}>
                  <div style={{ padding: "6px 14px 2px", fontSize: 10, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--muted)", fontWeight: 600 }}>
                    {inst}
                  </div>
                  {accts.map(a => (
                    <label key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 14px", cursor: "default", fontSize: 13 }}
                      onClick={() => toggle(a.id)}>
                      <input type="checkbox" checked={selected.has(a.id)} readOnly style={{ accentColor: "var(--ink)" }} />
                      {a.label}
                      <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--muted)", fontFamily: "var(--mono)" }}>{a.category}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <span>
            {selected.size} of {allAccounts.length} accounts
            {` · ${periodLabel(exportPeriod, exportPeriod === "custom" && from && to ? { from, to } : null)}`}
            {includeTopsheet && includeTransactions ? " · topsheet + transactions"
              : includeTopsheet ? " · topsheet only"
              : includeTransactions ? " · transactions only" : ""}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => doExport("csv")}
              disabled={exporting || selected.size === 0}>
              {exporting ? "…" : "↓ .csv"}
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => doExport("xlsx")}
              disabled={exporting || selected.size === 0 || (!includeTopsheet && !includeTransactions)}>
              {exporting ? "Exporting…" : "↓ .xlsx"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TxnsTab({ transactions, institutions, openTxnId, setOpenTxnId, onSaveTxn, hide, focusUncoded, onMarkSeen }) {
  const [sortBy, setSortBy] = useState("date");
  const [sortDir, setSortDir] = useState("desc");
  const [filterUncoded, setFilterUncoded] = useState(false);
  const [filterNew, setFilterNew] = useState(false);
  const [fVendor, setFVendor] = useState("");
  const [fCode, setFCode] = useState("");
  const [fSource, setFSource] = useState("");
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");
  const [visibleCols, setVisibleCols] = useState(DEFAULT_TXN_COLS);
  const [colsOpen, setColsOpen] = useState(false);
  const [colWidths, setColWidths] = useState(DEFAULT_COL_WIDTHS);
  const [focusField, setFocusField] = useState(null);

  const activeColumns = useMemo(() =>
    TXN_COLUMNS.filter(c => c.required || visibleCols.includes(c.key)),
    [visibleCols]);
  const txCols = useMemo(() => activeColumns.map(c => colWidths[c.key] + "px").join(" "), [activeColumns, colWidths]);

  const startResize = useCallback((key, e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const col = TXN_COLUMNS.find(c => c.key === key);
    const startW = colWidths[key];
    const minW = col?.min || 50;
    document.body.classList.add("resizing-col");
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const newW = Math.max(minW, startW + dx);
      setColWidths(prev => prev[key] === newW ? prev : { ...prev, [key]: newW });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing-col");
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [colWidths]);

  useEffect(() => {
    if (focusUncoded) setFilterUncoded(true);
  }, [focusUncoded]);

  const sources = useMemo(() => {
    const set = new Set();
    transactions.forEach(t => {
      const label = t.accountDisplay || t.account;
      if (label) set.add(label);
    });
    if (institutions) {
      institutions.forEach(i => i.accounts.forEach(a => {
        set.add(a.nickname || a.name);
      }));
    }
    return Array.from(set).sort();
  }, [transactions, institutions]);

  const view = useMemo(() => {
    let arr = transactions;
    if (filterUncoded) arr = arr.filter(t => !t.lineCode && !(t.splits && t.splits.length));
    if (filterNew) arr = arr.filter(t => !t.seen);
    if (fVendor) {
      const q = fVendor.toLowerCase();
      arr = arr.filter(t =>
        (t.vendor || "").toLowerCase().includes(q) ||
        (t.description || "").toLowerCase().includes(q)
      );
    }
    if (fCode) {
      arr = arr.filter(t =>
        t.lineCode === fCode ||
        (t.splits && t.splits.some(s => s.code === fCode))
      );
    }
    if (fSource) {
      arr = arr.filter(t => (t.accountDisplay || t.account) === fSource);
    }
    if (fFrom || fTo) {
      const fromDate = fFrom ? parseDate(fFrom) : null;
      const toDate = fTo ? parseDate(fTo) : null;
      arr = arr.filter(t => {
        const d = parseDate(t.date);
        if (!d) return false;
        if (fromDate && d < fromDate) return false;
        if (toDate && d > toDate) return false;
        return true;
      });
    }
    arr = [...arr];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortBy === "date") {
        const da = parseDate(a.date), db = parseDate(b.date);
        cmp = (da?.getTime() || 0) - (db?.getTime() || 0);
      } else if (sortBy === "vendor") {
        cmp = (a.vendor || "").localeCompare(b.vendor || "");
      } else if (sortBy === "lineCode") {
        const ac = a.lineCode || (a.splits?.[0]?.code) || "~uncoded";
        const bc = b.lineCode || (b.splits?.[0]?.code) || "~uncoded";
        cmp = ac.localeCompare(bc);
      } else if (sortBy === "amount") {
        cmp = (a.amount || 0) - (b.amount || 0);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [transactions, sortBy, sortDir, filterUncoded, filterNew, fVendor, fCode, fSource, fFrom, fTo]);

  const setSort = (col) => {
    if (sortBy === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortBy(col); setSortDir(col === "date" ? "desc" : col === "amount" ? "desc" : "asc"); }
  };

  const uncodedCount = transactions.filter(t => !t.lineCode && !(t.splits && t.splits.length)).length;
  const newCount = transactions.filter(t => !t.seen).length;
  const activeFilters = [filterUncoded, filterNew, fVendor, fCode, fSource, fFrom || fTo].filter(Boolean).length;
  const clearAll = () => {
    setFilterUncoded(false); setFilterNew(false); setFVendor(""); setFCode("");
    setFSource(""); setFFrom(""); setFTo("");
  };

  return (
    <div className="section">
      <div className="sort-bar">
        <span className="label">Sort</span>
        <div className="pills">
          {[["date","Date"],["vendor","Vendor"],["lineCode","Line"],["amount","Amount"]].map(([key, label]) => (
            <button key={key} className={sortBy === key ? "on" : ""} onClick={() => setSort(key)}>
              {label}{sortBy === key && <span className={`arrow ${sortDir === "asc" ? "arrow-up" : "arrow-down"}`}/>}
            </button>
          ))}
        </div>

        <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--muted)", fontFamily:"var(--mono)" }}>
          {view.length} of {transactions.length}
        </span>

        <div style={{ position: "relative" }}>
          <button className="col-btn" onClick={() => setColsOpen(o => !o)}>
            <Icon name="columns" size={11}/> Columns
            <span className="count">{activeColumns.length}/{TXN_COLUMNS.length}</span>
          </button>
          {colsOpen && (
            <ColumnsPopover columns={TXN_COLUMNS} visible={visibleCols}
              onChange={setVisibleCols} onClose={() => setColsOpen(false)} />
          )}
        </div>
      </div>

      <div className="filter-bar">
        <span className="filter-label">Filter</span>

        <div className={`f-input ${fVendor ? "has-value" : ""}`}>
          <Icon name="search" size={12} className="ico"/>
          <input placeholder="Vendor or description…"
            value={fVendor} onChange={(e) => setFVendor(e.target.value)} />
          {fVendor && <button className="x" onClick={() => setFVendor("")}><Icon name="x" size={10}/></button>}
        </div>

        <div className={`f-select ${fCode ? "has-value" : ""}`}>
          <span className="lbl">Line</span>
          <select value={fCode} onChange={(e) => setFCode(e.target.value)}>
            <option value="">All</option>
            {CATEGORIES_ORDER.map(cat => (
              <optgroup key={cat} label={cat}>
                {LINE_CODES.filter(c => c.category === cat).map(c => (
                  <option key={c.code} value={c.code}>{c.code} · {c.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className={`f-select ${fSource ? "has-value" : ""}`}>
          <span className="lbl">Source</span>
          <select value={fSource} onChange={(e) => setFSource(e.target.value)}>
            <option value="">All</option>
            {sources.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        <DateRangePicker
          from={fFrom ? parseDate(fFrom) : null}
          to={fTo ? parseDate(fTo) : null}
          align="right"
          onChange={(from, to) => {
            setFFrom(from ? `${from.getFullYear()}-${String(from.getMonth()+1).padStart(2,"0")}-${String(from.getDate()).padStart(2,"0")}` : "");
            setFTo(to ? `${to.getFullYear()}-${String(to.getMonth()+1).padStart(2,"0")}-${String(to.getDate()).padStart(2,"0")}` : "");
          }}
        />

        {uncodedCount > 0 && (
          <button
            className={`f-pill ${filterUncoded ? "active" : ""}`}
            onClick={() => setFilterUncoded(f => !f)}
            style={filterUncoded ? {} : { color:"var(--warning)", borderColor:"color-mix(in oklab, var(--warning) 35%, var(--line))" }}>
            {filterUncoded ? "✓ " : ""}Uncoded ({uncodedCount})
          </button>
        )}

        {newCount > 0 && (
          <div className={`pill-compound ${filterNew ? "active" : ""}`}>
            <button className="pill-label" onClick={() => setFilterNew(f => !f)}>
              {filterNew ? "✓ " : ""}{newCount} new
            </button>
            <button className="pill-action" onClick={onMarkSeen} title="Mark all as seen">✓</button>
          </div>
        )}

        {activeFilters > 0 && (
          <>
            <span className="active-count">{activeFilters} active</span>
            <button className="clear-all" onClick={clearAll}>Clear all</button>
          </>
        )}
      </div>

      <div className="panel txn-table" style={{ "--tx-cols": txCols }}>
        <div className="txn-head">
          {activeColumns.map((c, i) => (
            <div key={c.key} className={c.align === "right" ? "ta-r" : ""}>
              {c.label}
              <div className="col-resize" onMouseDown={(e) => startResize(c.key, e)} />
            </div>
          ))}
        </div>

        {view.length === 0 ? (
          transactions.length === 0 ? (
            <EmptyState
              title="No transactions yet"
              body="Once your accounts are linked, Claude pulls transactions from Plaid and codes them to your chart of accounts."
              ask="sync my latest transactions" />
          ) : (
            <div style={{ padding:"40px 20px", textAlign:"center", color:"var(--muted)" }}>
              No transactions match the current filter.
            </div>
          )
        ) : view.map(tx => {
          const isSplit = tx.splits && tx.splits.length > 0;
          const uncoded = !tx.lineCode && !isSplit;
          const isThisOpen = openTxnId === tx.id;
          const isNew = !tx.seen;
          return (
            <React.Fragment key={tx.id}>
              <div className={`txn-row ${uncoded ? "uncoded" : ""} ${isNew ? "is-new" : ""} ${isThisOpen ? "is-open" : ""}`}
                   onClick={() => { setOpenTxnId(prev => prev === tx.id ? null : tx.id); setFocusField(null); }}>
                {activeColumns.map(c => renderTxnCell(c, tx, hide, {
                  onTapField: (id, field) => { setOpenTxnId(id); setFocusField(field); }
                }))}
              </div>
              {isThisOpen && (
                <TxnExpand txn={tx} onClose={() => { setOpenTxnId(null); setFocusField(null); }} onSave={onSaveTxn} focusField={focusField} />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

// ─── bills tab ─────────────────────────────────────────────────────────

function BillAmtCell({ bill, onUpdate, hide }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const ref = useRef(null);

  const start = () => {
    setVal(String(bill.amount || ""));
    setEditing(true);
    setTimeout(() => { ref.current?.focus(); ref.current?.select(); }, 0);
  };
  const save = () => {
    setEditing(false);
    const n = parseFloat(val);
    if (!isNaN(n) && n !== bill.amount) onUpdate(bill.id, { amount: n });
  };

  if (editing) {
    return (
      <div className="b-amt" style={{ display:"flex", alignItems:"center", justifyContent:"flex-end", gap:3, paddingRight:28 }}>
        <span style={{ color:"var(--muted)", fontSize:11, fontFamily:"var(--mono)" }}>$</span>
        <input ref={ref} type="text" value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
          style={{
            width:90, border:0, outline:0, background:"transparent",
            textAlign:"right", fontFamily:"var(--mono)", fontFeatureSettings:"'tnum'",
            fontSize:13.5, fontWeight:500, color: bill.amount < 0 ? "var(--danger)" : "var(--positive)",
            borderBottom:"1.5px solid var(--accent)", padding:"0 2px",
          }} />
      </div>
    );
  }

  return (
    <div className={`b-amt ${bill.amount < 0 ? "neg" : "pos"} ${hide ? "private" : ""}`}
         onDoubleClick={start} style={{ cursor:"default" }}>
      {fmtMoney(bill.amount)}
    </div>
  );
}

function BillsTab({ bills, institutions, addBill, removeBill, updateBill, hide }) {
  const [showHidden, setShowHidden] = useState(false);
  const [adding, setAdding] = useState(false);
  const [cashAccts, setCashAccts] = useState(() => {
    try { return JSON.parse(localStorage.getItem("bills-cash-accts")) || []; } catch { return []; }
  });
  const [showAcctPicker, setShowAcctPicker] = useState(false);
  const acctPickerRef = useRef(null);

  const cashEligible = useMemo(() =>
    (institutions || []).flatMap(i => i.accounts.filter(a =>
      ["Checking", "HY Savings"].includes(a.category)
    ).map(a => ({ id: a.id, label: a.nickname || a.name, balance: a.balance, institution: i.name }))),
    [institutions]);

  const startingBalance = useMemo(() =>
    cashAccts.reduce((sum, id) => {
      const a = cashEligible.find(x => x.id === id);
      return sum + (a ? a.balance : 0);
    }, 0),
    [cashAccts, cashEligible]);

  const toggleAcct = (id) => {
    setCashAccts(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      localStorage.setItem("bills-cash-accts", JSON.stringify(next));
      return next;
    });
  };

  useEffect(() => {
    if (!showAcctPicker) return;
    const onDown = (e) => {
      if (acctPickerRef.current && !acctPickerRef.current.contains(e.target)) setShowAcctPicker(false);
    };
    setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showAcctPicker]);

  const hiddenCount = bills.filter(b => b.hidden).length;
  const visible = showHidden ? bills : bills.filter(b => !b.hidden);

  const runningBalances = useMemo(() => {
    if (cashAccts.length === 0) return null;
    let bal = startingBalance;
    return visible.map(b => {
      bal += Number(b.amount) || 0;
      return bal;
    });
  }, [visible, cashAccts, startingBalance]);

  const zeroIdx = runningBalances ? runningBalances.findIndex(b => b < 0) : -1;

  const toggleHidden = (id, currently) => {
    updateBill(id, { hidden: currently ? 0 : 1 });
  };

  const handleAdd = (b) => {
    addBill(b);
    setAdding(false);
  };

  return (
    <div className="section">
      <div className="section-head">
        <h2>Upcoming <em>{visible.length}{hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ""}</em>
          <span className="sign-legend" title="Amounts are signed: positive adds to cash, negative spends it">
            <span className="pos">+ income</span> · <span className="neg">− bills / outflow</span>
          </span>
        </h2>
        <div className="actions">
          <div style={{ position: "relative" }} ref={acctPickerRef}>
            <button className="api-pill" onClick={() => setShowAcctPicker(s => !s)}
              style={cashAccts.length > 0 ? { color:"var(--ink)", borderColor:"var(--ink)", background:"var(--highlight)" } : {}}>
              {cashAccts.length > 0
                ? `Running balance · ${fmtMoney(startingBalance)}`
                : "Running balance"}
            </button>
            {showAcctPicker && (
              <div className="cashflow-picker">
                <div className="cashflow-picker-title">Plan against</div>
                {cashEligible.map(a => (
                  <label key={a.id} className="cashflow-acct" onClick={() => toggleAcct(a.id)}>
                    <input type="checkbox" checked={cashAccts.includes(a.id)} readOnly style={{ accentColor: "var(--ink)" }} />
                    <span>{a.label}</span>
                    <span className="cashflow-bal">{fmtMoney(a.balance)}</span>
                  </label>
                ))}
                {cashAccts.length > 0 && (
                  <div className="cashflow-total">
                    Starting balance: <b>{fmtMoney(startingBalance)}</b>
                  </div>
                )}
              </div>
            )}
          </div>
          {hiddenCount > 0 && (
            <button className="api-pill" onClick={() => setShowHidden(s => !s)}
              style={showHidden ? { color:"var(--ink)", borderColor:"var(--ink)", background:"var(--highlight)" } : {}}>
              {showHidden ? "✓ " : ""}{showHidden ? "Showing hidden" : "Show hidden"}
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}>
            <Icon name="plus" size={11}/> Add
          </button>
        </div>
      </div>
      <div className={`panel ${runningBalances ? "has-cashflow" : ""}`}>
        {adding && <BillAddRow onAdd={handleAdd} onCancel={() => setAdding(false)} autoFocus />}
        {visible.length === 0 && !adding && (
          <EmptyState
            icon="calendar"
            title="No upcoming cashflow"
            body="Track recurring inflows and outflows (paydays, mortgage, utilities) to project your running balance. Add one above, or ask Claude."
            ask="add my recurring bills and paydays" />
        )}
        {visible.map((b, i) => (
          <React.Fragment key={b.id}>
            {zeroIdx === i && (
              <div className="cashflow-zero">
                <span>Out of cash</span>
              </div>
            )}
            <div className={`bill-row ${b.kind || ""} ${b.hidden ? "is-hidden" : ""} ${runningBalances && runningBalances[i] < 0 ? "past-zero" : ""}`}>
              <div className="b-date">
                <b>{b.date}</b>
                <span>{b.weekday || computeWeekday(b.date)}</span>
              </div>
              <div className="b-name">
                {b.name}
                <span>{b.account}</span>
              </div>
              <BillAmtCell bill={b} onUpdate={updateBill} hide={hide} />
              {runningBalances && (
                <div className={`b-running ${runningBalances[i] < 0 ? "neg" : ""} ${hide ? "private" : ""}`}>
                  {fmtMoney(runningBalances[i])}
                </div>
              )}
              <button className="rm" onClick={() => removeBill(b.id)} title="Remove"><Icon name="x" size={11}/></button>
              <button className="hide-toggle" onClick={() => toggleHidden(b.id, b.hidden)}
                title={b.hidden ? "Unhide" : "Hide"}>
                {b.hidden ? "◉" : "○"}
              </button>
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

// ─── accounts tab ──────────────────────────────────────────────────────

// ─── manage net-worth blocks ────────────────────────────────────────────
// Add / rename / reorder / delete / re-kind the customizable net-worth blocks.
// Assets and liabilities are shown as separate groups (mirroring the two columns
// on the Overview). Items are tracked as {key, name, kind}: `key` is the
// persisted name (the URL/PATCH target), `name` is the in-progress rename edit.
function ManageBlocksModal({ accountBlocks, onClose, onChanged }) {
  const toItems = (rows) => (rows || []).map(b => ({ key: b.name, name: b.name, kind: b.kind === "liability" ? "liability" : "asset", investment: b.investment === 1 || b.investment === true }));
  const [items, setItems] = useState(() => toItems(accountBlocks));
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState("asset");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const refresh = async () => {
    try { setItems(toItems(await fetchApi("/api/account-blocks"))); }
    catch (e) { console.error("reload blocks failed:", e); }
    onChanged && onChanged();
  };

  const run = async (fn) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await fn(); await refresh(); }
    catch (e) { setError(String(e.message || e).replace(/^.*?: \d+$/, "Request failed")); }
    finally { setBusy(false); }
  };

  const addBlock = () => {
    const name = newName.trim();
    if (!name) return;
    run(async () => {
      await fetchApi("/api/account-blocks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, kind: newKind }),
      });
      setNewName("");
    });
  };

  const renameBlock = (key, name) => {
    const next = name.trim();
    if (!next || next === key) { setItems(prev => prev.map(it => it.key === key ? { ...it, name: key } : it)); return; }
    run(() => fetchApi(`/api/account-blocks/${encodeURIComponent(key)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: next }),
    }));
  };

  const changeKind = (key, kind) => run(() => fetchApi(`/api/account-blocks/${encodeURIComponent(key)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind }),
  }));

  const setInvestment = (key, investment) => run(() => fetchApi(`/api/account-blocks/${encodeURIComponent(key)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ investment }),
  }));

  const deleteBlock = (key) => {
    if (!confirm(`Delete "${key}"? Accounts in this block become unsorted until you reassign them.`)) return;
    run(() => fetchApi(`/api/account-blocks/${encodeURIComponent(key)}`, { method: "DELETE" }));
  };

  const persistOrder = (next) => run(() => fetchApi("/api/reorder", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blocks: next.map((it, i) => ({ name: it.key, order: i })) }),
  }));

  // Drag-to-reorder within a group (kind). Dropping never changes kind — use the
  // per-row Asset/Liability selector for that. Only the grip handle is draggable
  // so the name input stays editable.
  const dragRef = useRef(null); // { kind, idx }
  const [dropTarget, setDropTarget] = useState(null); // { kind, idx, edge }
  const getDropEdge = (e, el) => {
    const rect = el.getBoundingClientRect();
    return (e.clientY - rect.top) < rect.height / 2 ? "before" : "after";
  };
  const onRowDrop = (kind, toIdx, e) => {
    e.preventDefault();
    const d = dragRef.current;
    dragRef.current = null;
    setDropTarget(null);
    if (!d || d.kind !== kind) return;
    const sub = items.filter(it => it.kind === kind);
    let insertIdx = getDropEdge(e, e.currentTarget) === "after" ? toIdx + 1 : toIdx;
    if (d.idx < insertIdx) insertIdx--;
    if (d.idx === insertIdx) return;
    const [moved] = sub.splice(d.idx, 1);
    sub.splice(insertIdx, 0, moved);
    const assets = kind === "asset" ? sub : items.filter(it => it.kind === "asset");
    const liabs = kind === "liability" ? sub : items.filter(it => it.kind === "liability");
    const next = [...assets, ...liabs];
    setItems(next);
    persistOrder(next);
  };
  const showDrop = (kind, idx, edge) => dropTarget?.kind === kind && dropTarget.idx === idx && dropTarget.edge === edge;

  const renderGroup = (kind, label) => {
    const sub = items.filter(it => it.kind === kind);
    return (
      <div style={{ marginBottom: 14 }}>
        <div className="grp-label">{label}</div>
        <div className="block-list" style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {sub.map((it, idx) => (
            <React.Fragment key={it.key}>
              {showDrop(kind, idx, "before") && <div className="drop-bar drop-bar-sm"/>}
              <div className="block-row" style={{ display:"flex", alignItems:"center", gap:8 }}
                onDragOver={(e) => { if (dragRef.current?.kind !== kind) return; e.preventDefault(); setDropTarget({ kind, idx, edge: getDropEdge(e, e.currentTarget) }); }}
                onDrop={(e) => onRowDrop(kind, idx, e)}>
                <div className="drag-handle" draggable
                  onDragStart={(e) => { dragRef.current = { kind, idx }; e.currentTarget.closest(".block-row")?.classList.add("dragging"); }}
                  onDragEnd={(e) => { dragRef.current = null; setDropTarget(null); e.currentTarget.closest(".block-row")?.classList.remove("dragging"); }}
                  title="Drag to reorder">
                  <Icon name="grip-vertical" size={12}/>
                </div>
                <input type="text" value={it.name} disabled={busy}
                  style={{ flex:1 }}
                  onChange={(e) => setItems(prev => prev.map(p => p.key === it.key ? { ...p, name: e.target.value } : p))}
                  onBlur={() => renameBlock(it.key, it.name)}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
                <select value={it.kind} disabled={busy} title="Asset or liability"
                  onChange={(e) => changeKind(it.key, e.target.value)}>
                  <option value="asset">Asset</option>
                  <option value="liability">Liability</option>
                </select>
                <label className="invest" title="Investment — keep its account activity out of the spending feed">
                  <input type="checkbox" checked={!!it.investment} disabled={busy}
                    onChange={(e) => setInvestment(it.key, e.target.checked)} />
                  Invest
                </label>
                <button className="row-x" disabled={busy}
                  onClick={() => deleteBlock(it.key)} title="Delete block"><Icon name="x" size={13}/></button>
              </div>
              {showDrop(kind, idx, "after") && <div className="drop-bar drop-bar-sm"/>}
            </React.Fragment>
          ))}
          {sub.length === 0 && <div style={{ color:"var(--muted-2)", fontSize:12.5 }}>None yet.</div>}
        </div>
      </div>
    );
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal manage-modal" style={{ width:"min(500px, calc(100vw - 32px))" }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3>Net-worth blocks</h3>
            <p>The groups your accounts roll up into on the Overview. Assign accounts from each account's row.</p>
          </div>
          <button className="modal-x" onClick={onClose}><Icon name="x"/></button>
        </div>
        <div className="modal-body">
          {error && <div style={{ color:"var(--danger)", fontSize:12.5, marginBottom:10 }}>{error}</div>}
          {renderGroup("asset", "Assets")}
          {renderGroup("liability", "Liabilities")}
        </div>
        <div className="modal-foot" style={{ flexWrap:"wrap" }}>
          <div className="grp-label" style={{ flexBasis:"100%", margin:0 }}>Add a block</div>
          <input type="text" placeholder="New block name…" value={newName} disabled={busy}
            style={{ flex:1, marginRight:8 }}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addBlock(); }} />
          <select value={newKind} disabled={busy} style={{ marginRight:8 }}
            onChange={(e) => setNewKind(e.target.value)}>
            <option value="asset">Asset</option>
            <option value="liability">Liability</option>
          </select>
          <button className="btn btn-primary btn-sm" disabled={busy || !newName.trim()} onClick={addBlock}>
            <Icon name="plus" size={11} style={{ verticalAlign:"-1px", marginRight:4 }}/>Add
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── manage expense categories + line codes ─────────────────────────────
// Add / rename / delete line codes, grouped by category. Adding a code under a
// new category name *is* how a category is created (a category is just the set
// of codes that share a name + category_code). Code (the number) is the stable
// key transactions reference, so it's never editable — only label/category.
function ManageCodesModal({ onClose, onChanged }) {
  const [codes, setCodes] = useState([]); // {code, category, categoryCode, label}
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newCat, setNewCat] = useState("");        // existing category name, or "__new__"
  const [newCatName, setNewCatName] = useState("");
  const [newSpending, setNewSpending] = useState(true);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const refresh = async () => {
    try {
      const rows = await fetchApi("/api/line-codes");
      setCodes(rows.map(r => ({ code: r.code, category: r.category, categoryCode: r.category_code, label: r.label, spending: r.spending !== 0 })));
    } catch (e) { console.error("reload codes failed:", e); }
    onChanged && onChanged();
  };
  useEffect(() => { refresh(); }, []);

  const run = async (fn, failMsg) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await fn(); await refresh(); }
    catch (e) { setError(failMsg || "Something went wrong — try again."); }
    finally { setBusy(false); }
  };

  const groups = useMemo(() => {
    const m = new Map();
    [...codes]
      .sort((a, b) => a.categoryCode - b.categoryCode || a.code.localeCompare(b.code))
      .forEach(c => {
        if (!m.has(c.category)) m.set(c.category, { category: c.category, categoryCode: c.categoryCode, items: [] });
        m.get(c.category).items.push(c);
      });
    return Array.from(m.values());
  }, [codes]);

  const maxCatCode = codes.reduce((mx, c) => Math.max(mx, c.categoryCode), 0);
  const categoryNames = groups.map(g => g.category);

  const addCode = () => {
    const code = newCode.trim();
    const label = newLabel.trim();
    const cat = newCat === "__new__" ? newCatName.trim() : newCat;
    if (!code || !label || !cat) return;
    const existing = groups.find(g => g.category === cat);
    const categoryCode = existing ? existing.categoryCode : Math.ceil((maxCatCode + 1) / 1000) * 1000;
    run(async () => {
      await fetchApi("/api/line-codes", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, label, category: cat, categoryCode, spending: newSpending }),
      });
      setNewCode(""); setNewLabel("");
      if (newCat === "__new__") { setNewCat(cat); setNewCatName(""); }
    }, "Couldn’t add — that code may already exist.");
  };

  const editLabel = (code, value) => {
    const v = value.trim();
    const cur = codes.find(c => c.code === code);
    if (!v || !cur || v === cur.label) return;
    run(() => fetchApi(`/api/line-codes/${encodeURIComponent(code)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: v }),
    }));
  };

  const renameCat = (oldName, value) => {
    const v = value.trim();
    if (!v || v === oldName) return;
    run(() => fetchApi(`/api/categories/${encodeURIComponent(oldName)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: v }),
    }));
  };

  const setSpending = (code, spending) => {
    run(() => fetchApi(`/api/line-codes/${encodeURIComponent(code)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spending }),
    }));
  };

  const deleteCode = (code) => {
    if (!confirm(`Delete code ${code}? Only works if no transactions use it.`)) return;
    run(() => fetchApi(`/api/line-codes/${encodeURIComponent(code)}`, { method: "DELETE" }),
      `Couldn’t delete ${code} — recode its transactions first, then try again.`);
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal manage-modal" style={{ width:"min(560px, calc(100vw - 32px))" }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3>Expense categories</h3>
            <p>Your line-code catalog. Edit a label, rename a category, or add a code — a new category name creates the category.</p>
          </div>
          <button className="modal-x" onClick={onClose}><Icon name="x"/></button>
        </div>
        <div className="modal-body" style={{ maxHeight:"56vh", overflowY:"auto" }}>
          {error && <div style={{ color:"var(--danger)", fontSize:12.5, marginBottom:10 }}>{error}</div>}
          {groups.map(g => (
            <div key={g.category} style={{ marginBottom: 14 }}>
              <input className="cat-name-edit" key={`cat-${g.category}`} defaultValue={g.category} disabled={busy}
                style={{ fontSize:10.5, textTransform:"uppercase", letterSpacing:".07em", color:"var(--muted)", marginBottom:6, border:0, background:"transparent", width:"100%", padding:"2px 0", fontWeight:600 }}
                title="Rename category"
                onBlur={(e) => renameCat(g.category, e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
              <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
                {g.items.map(c => (
                  <div key={c.code} style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span className="mono" style={{ fontSize:11.5, color:"var(--muted)", minWidth:54 }}>{c.code}</span>
                    <input key={`lbl-${c.code}`} defaultValue={c.label} disabled={busy} style={{ flex:1 }}
                      onBlur={(e) => editLabel(c.code, e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
                    <select value={c.spending ? "spend" : "nonspend"} disabled={busy}
                      title="Spending counts toward 'Net for period'; Income / Transfer is excluded"
                      onChange={(e) => setSpending(c.code, e.target.value === "spend")}>
                      <option value="spend">Spending</option>
                      <option value="nonspend">Income / Transfer</option>
                    </select>
                    <button className="row-x" disabled={busy}
                      onClick={() => deleteCode(c.code)} title="Delete code"><Icon name="x" size={13}/></button>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {groups.length === 0 && <div style={{ color:"var(--muted-2)", fontSize:12.5 }}>No codes yet — add your first one below.</div>}
        </div>
        <div className="modal-foot" style={{ display:"flex", flexWrap:"wrap", gap:8, alignItems:"center" }}>
          <div className="grp-label" style={{ flexBasis:"100%", margin:0 }}>Add a code</div>
          <input type="text" placeholder="Code (e.g. 1001)" value={newCode} disabled={busy}
            style={{ width:120 }} onChange={(e) => setNewCode(e.target.value)} />
          <input type="text" placeholder="Label" value={newLabel} disabled={busy}
            style={{ flex:1, minWidth:120 }} onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addCode(); }} />
          <select value={newCat} disabled={busy} onChange={(e) => setNewCat(e.target.value)}>
            <option value="">Category…</option>
            {categoryNames.map(c => <option key={c} value={c}>{c}</option>)}
            <option value="__new__">+ New category…</option>
          </select>
          {newCat === "__new__" && (
            <input type="text" placeholder="New category name" value={newCatName} disabled={busy}
              style={{ width:160 }} onChange={(e) => setNewCatName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addCode(); }} />
          )}
          <select value={newSpending ? "spend" : "nonspend"} disabled={busy}
            title="Spending counts toward the net; Income / Transfer is excluded"
            onChange={(e) => setNewSpending(e.target.value === "spend")}>
            <option value="spend">Spending</option>
            <option value="nonspend">Income / Transfer</option>
          </select>
          <button className="btn btn-primary btn-sm"
            disabled={busy || !newCode.trim() || !newLabel.trim() || !(newCat === "__new__" ? newCatName.trim() : newCat)}
            onClick={addCode}>
            <Icon name="plus" size={11} style={{ verticalAlign:"-1px", marginRight:4 }}/>Add
          </button>
        </div>
      </div>
    </div>
  );
}

function AccountsTab({ institutions, setInstitutions, openAcct, setOpenAcct, onSaveAcct, accountBlocks, hide, onAddInst, onReconnect }) {
  const [expanded, setExpanded] = useState({});
  const [dropTarget, setDropTarget] = useState(null);
  const totalAccts = institutions.reduce((n, i) => n + i.accounts.length, 0);
  const dragRef = useRef(null);

  const persistOrder = (insts) => {
    const payload = {
      institutions: insts.map((inst, i) => ({ id: inst.id, order: i })),
      accounts: insts.flatMap(inst => inst.accounts.map((a, i) => ({ id: a.id, order: i }))),
    };
    fetchApi("/api/reorder", { method: "POST", body: JSON.stringify(payload) }).catch(() => {});
  };

  const getDropEdge = (e, el) => {
    const rect = el.getBoundingClientRect();
    return (e.clientY - rect.top) < rect.height / 2 ? "before" : "after";
  };

  const onInstDragStart = (e, idx) => {
    dragRef.current = { type: "inst", idx };
    e.dataTransfer.effectAllowed = "move";
    e.currentTarget.closest(".inst").classList.add("dragging");
  };
  const onInstDragEnd = (e) => {
    e.currentTarget.closest(".inst")?.classList.remove("dragging");
    dragRef.current = null;
    setDropTarget(null);
  };
  const onInstDragOver = (e, idx) => {
    if (!dragRef.current || dragRef.current.type !== "inst") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const edge = getDropEdge(e, e.currentTarget);
    setDropTarget({ type: "inst", idx, edge });
  };
  const onInstDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDropTarget(prev => prev?.type === "inst" ? null : prev);
    }
  };
  const onInstDrop = (e, toIdx) => {
    e.preventDefault();
    setDropTarget(null);
    if (!dragRef.current || dragRef.current.type !== "inst") return;
    const fromIdx = dragRef.current.idx;
    const edge = getDropEdge(e, e.currentTarget);
    let insertIdx = edge === "after" ? toIdx + 1 : toIdx;
    if (fromIdx < insertIdx) insertIdx--;
    if (fromIdx === insertIdx) return;
    setInstitutions(prev => {
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(insertIdx, 0, moved);
      persistOrder(next);
      return next;
    });
  };

  const onAcctDragStart = (e, instId, acctIdx) => {
    dragRef.current = { type: "acct", instId, idx: acctIdx };
    e.dataTransfer.effectAllowed = "move";
    e.currentTarget.classList.add("dragging");
  };
  const onAcctDragEnd = (e) => {
    e.currentTarget.classList.remove("dragging");
    dragRef.current = null;
    setDropTarget(null);
  };
  const onAcctDragOver = (e, instId, acctIdx) => {
    if (!dragRef.current || dragRef.current.type !== "acct" || dragRef.current.instId !== instId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const edge = getDropEdge(e, e.currentTarget);
    setDropTarget({ type: "acct", instId, idx: acctIdx, edge });
  };
  const onAcctDragLeave = (e, instId) => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDropTarget(prev => prev?.type === "acct" && prev.instId === instId ? null : prev);
    }
  };
  const onAcctDrop = (e, instId, toIdx) => {
    e.preventDefault();
    setDropTarget(null);
    if (!dragRef.current || dragRef.current.type !== "acct" || dragRef.current.instId !== instId) return;
    const fromIdx = dragRef.current.idx;
    const edge = getDropEdge(e, e.currentTarget);
    let insertIdx = edge === "after" ? toIdx + 1 : toIdx;
    if (fromIdx < insertIdx) insertIdx--;
    if (fromIdx === insertIdx) return;
    setInstitutions(prev => {
      const next = prev.map(inst => {
        if (inst.id !== instId) return inst;
        const accts = [...inst.accounts];
        const [moved] = accts.splice(fromIdx, 1);
        accts.splice(insertIdx, 0, moved);
        return { ...inst, accounts: accts };
      });
      persistOrder(next);
      return next;
    });
  };

  const instDrop = (idx, edge) => dropTarget?.type === "inst" && dropTarget.idx === idx && dropTarget.edge === edge;
  const acctDrop = (instId, idx, edge) => dropTarget?.type === "acct" && dropTarget.instId === instId && dropTarget.idx === idx && dropTarget.edge === edge;

  return (
    <div className="section">
      <div className="section-head">
        <h2>Linked accounts <em>{institutions.length} institutions · {totalAccts} accounts</em></h2>
      </div>
      <div className="panel" onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropTarget(null); }}>
        {institutions.map((inst, instIdx) => {
          const isOpen = expanded[inst.id] === true;
          const net = inst.accounts.reduce((n, a) => n + a.balance, 0);
          return (
            <div className="inst" key={inst.id}
                 onDragOver={(e) => onInstDragOver(e, instIdx)}
                 onDragLeave={onInstDragLeave}
                 onDrop={(e) => onInstDrop(e, instIdx)}>
              {instDrop(instIdx, "before") && <div className="drop-bar"/>}
              <div className="inst-row" onClick={() => setExpanded(e => ({ ...e, [inst.id]: !isOpen }))}>
                <div className="drag-handle"
                     draggable
                     onClick={(e) => e.stopPropagation()}
                     onDragStart={(e) => onInstDragStart(e, instIdx)}
                     onDragEnd={onInstDragEnd}>
                  <Icon name="grip-vertical" size={12}/>
                </div>
                <div className="inst-logo" style={{
                  background:`linear-gradient(135deg, ${inst.color}, color-mix(in oklab, ${inst.color} 65%, #000))`
                }}>{inst.monogram}</div>
                <div>
                  <div className="inst-name">{inst.name}</div>
                  <div className="inst-meta">
                    <span className={`dot ${inst.status === "ok" ? "ok" : "reauth"}`}/>
                    <span>{inst.status === "ok" ? "Healthy" : "Needs reauth"}</span>
                    <span className="sep">·</span>
                    <span>Synced {relTime(inst.lastSyncMin)}</span>
                    <span className="sep">·</span>
                    <span>{inst.accounts.length} {inst.accounts.length === 1 ? "account" : "accounts"}</span>
                  </div>
                </div>
                {inst.status !== "ok" && inst.plaidItemId && (
                  <button className="btn btn-sm reconnect-btn"
                          onClick={(e) => { e.stopPropagation(); onReconnect(inst); }}>
                    <Icon name="sync" size={11} style={{ verticalAlign:"-1px", marginRight:4 }}/>
                    Reconnect
                  </button>
                )}
                <div className={`inst-bal ${hide ? "private" : ""}`}
                     style={{ color: net < 0 ? "var(--danger)" : "var(--ink)" }}>
                  {fmtMoney(net)}
                </div>
              </div>
              {instDrop(instIdx, "after") && <div className="drop-bar"/>}

              {isOpen && (
                <div className="acct-list">
                  {inst.accounts.map((a, acctIdx) => {
                    const isAcctOpen = openAcct && openAcct.instId === inst.id && openAcct.acctId === a.id;
                    return (
                      <React.Fragment key={a.id}>
                        {acctDrop(inst.id, acctIdx, "before") && <div className="drop-bar drop-bar-sm"/>}
                        <div className={`acct-line ${isAcctOpen ? "is-open" : ""}`}
                             onDragOver={(e) => onAcctDragOver(e, inst.id, acctIdx)}
                             onDragLeave={(e) => onAcctDragLeave(e, inst.id)}
                             onDrop={(e) => onAcctDrop(e, inst.id, acctIdx)}
                             onClick={() => setOpenAcct(prev => prev && prev.instId === inst.id && prev.acctId === a.id ? null : { instId: inst.id, acctId: a.id })}>
                          <div className="drag-handle drag-handle-sm"
                               draggable
                               onClick={(e) => e.stopPropagation()}
                               onDragStart={(e) => onAcctDragStart(e, inst.id, acctIdx)}
                               onDragEnd={onAcctDragEnd}>
                            <Icon name="grip-vertical" size={10}/>
                          </div>
                          <div className="acct-glyph">{(a.subtype || "?").slice(0,3).toUpperCase()}</div>
                          <div>
                            <div className="acct-name">{a.nickname || a.name}</div>
                            <div className="acct-sub">
                              <span>{a.category}</span>
                              <span className="sep">·</span>
                              <span className="acct-mask">····{a.mask}</span>
                              {a.nickname && (<><span className="sep">·</span><span style={{ fontStyle:"italic" }}>{a.name}</span></>)}
                            </div>
                          </div>
                          <div className={`acct-bal ${a.balance < 0 ? "neg" : ""} ${hide ? "private" : ""}`}>
                            {fmtMoney(a.balance)}
                          </div>
                        </div>
                        {acctDrop(inst.id, acctIdx, "after") && <div className="drop-bar drop-bar-sm"/>}
                        {isAcctOpen && (
                          <AcctExpand inst={inst} acct={a} blocks={accountBlocks}
                            onClose={() => setOpenAcct(null)}
                            onSave={(patch) => onSaveAcct(inst.id, a.id, patch)} />
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {institutions.length === 0 && (
          <EmptyState
            icon="link"
            title="No accounts linked yet"
            body="Link a bank, card, brokerage, or loan through Plaid below — or have Claude walk you through it."
            ask="set up ledger" />
        )}

        <div className="add-row" onClick={onAddInst}>
          <div className="ico"><Icon name="plus" size={12}/></div>
          <div><b>{institutions.length === 0 ? "Link your first institution" : "Link another institution"}</b> — bank, card, brokerage, or loan</div>
          <div className="sp"/>
          <Icon name="arrow-right" size={13}/>
        </div>
      </div>
    </div>
  );
}

// ─── app ───────────────────────────────────────────────────────────────

const { useState, useEffect, useMemo, useRef, useCallback } = React;

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [tab, setTab] = useState(() => {
    const h = location.hash.replace("#", "");
    const key = h === "bills" ? "cashflow" : h; // legacy #bills bookmarks → Cashflow
    return ["overview", "cashflow", "txns", "accounts"].includes(key) ? key : "overview";
  });
  const [period, _setPeriod] = useState(() => {
    try { return localStorage.getItem("topsheet-period") || "ytd"; } catch { return "ytd"; }
  });
  const setPeriod = (p) => { localStorage.setItem("topsheet-period", p); _setPeriod(p); };
  const [customRange, setCustomRange] = useState(null);
  const [hideEmpty, setHideEmpty] = useState(() => {
    try { return JSON.parse(localStorage.getItem("topsheet-active-only")) || false; } catch { return false; }
  });
  const [loading, setLoading] = useState(true);
  const [institutions, setInstitutions] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [bills, setBills] = useState([]);
  const [accountBlocks, setAccountBlocks] = useState([]);
  const [openTxnId, setOpenTxnId] = useState(null);
  const [openAcct, setOpenAcct] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [reconnectInst, setReconnectInst] = useState(null);
  const [apiOpen, setApiOpen] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);
  const [focusUncoded, setFocusUncoded] = useState(0);
  const [toast, setToast] = useState(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    location.hash = tab;
  }, [tab]);

  useEffect(() => {
    document.body.dataset.theme = t.theme;
    document.documentElement.style.setProperty("--accent", t.accent);
  }, [t.theme, t.accent]);

  useEffect(() => {
    loadLedgerData()
      .then(data => {
        setInstitutions(data.institutions);
        setTransactions(data.transactions);
        setBills(data.bills);
        setAccountBlocks(data.accountBlocks);
        setLoading(false);
      })
      .catch(err => {
        console.error("Failed to load data:", err);
        setLoading(false);
      });
  }, []);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2400); };

  // refs for window.Ledger reads
  const instsRef = useRef(institutions);
  const txnsRef = useRef(transactions);
  const billsRef = useRef(bills);
  instsRef.current = institutions;
  txnsRef.current = transactions;
  billsRef.current = bills;

  // ─── bill actions ─────────────────────────────────────────────
  const sortBills = (a, b) => {
    const parse = (s) => {
      const [m, d] = String(s.date).split("/").map(n => parseInt(n, 10));
      return (m || 0) * 100 + (d || 0);
    };
    return parse(a) - parse(b);
  };
  const normalizeBill = (b) => {
    const date = normalizeDate(String(b.date || ""));
    return {
      id: b.id || nextId("b"),
      date, weekday: computeWeekday(date),
      name: String(b.name || "").trim(),
      account: String(b.account || "").trim(),
      amount: Number(b.amount) || 0,
      kind: b.kind || "",
    };
  };
  const addBill = useCallback((b) => {
    const n = normalizeBill(b);
    setBills(prev => [...prev, n].sort(sortBills));
    fetchApi("/api/bills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: n.date, name: n.name, account_label: n.account, amount: n.amount, kind: n.kind }),
    }).then(resp => {
      if (resp.id) setBills(prev => prev.map(x => x.id === n.id ? { ...x, id: resp.id } : x));
    }).catch(e => console.error("Failed to save bill:", e));
    return n;
  }, []);
  const addManyBills = useCallback((arr) => {
    const items = arr.map(normalizeBill);
    setBills(prev => [...prev, ...items].sort(sortBills));
    for (const n of items) {
      fetchApi("/api/bills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: n.date, name: n.name, account_label: n.account, amount: n.amount, kind: n.kind }),
      }).then(resp => {
        if (resp.id) setBills(prev => prev.map(x => x.id === n.id ? { ...x, id: resp.id } : x));
      }).catch(e => console.error("Failed to save bill:", e));
    }
    return items;
  }, []);
  const removeBill = useCallback((id) => {
    // Deletion is irreversible — confirm, like block/code deletion does, so a
    // stray click can't silently destroy a bill.
    const b = billsRef.current.find(x => x.id === id);
    if (!confirm(`Delete ${b?.name ? `"${b.name}"` : "this bill"}? This can't be undone.`)) return;
    setBills(prev => prev.filter(b => b.id !== id));
    fetchApi(`/api/bills/${id}`, { method: "DELETE" }).catch(e => console.error("Failed to delete bill:", e));
  }, []);
  const updateBill = useCallback((id, patch) => {
    setBills(prev => prev.map(b => b.id === id ? { ...b, ...patch } : b));
    fetchApi(`/api/bills/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(e => console.error("Failed to update bill:", e));
  }, []);

  // ─── txn actions ──────────────────────────────────────────────
  const updateTxn = useCallback((id, patch) => {
    setTransactions(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
    fetchApi(`/api/transactions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(e => console.error("Failed to save:", e));
  }, []);
  const handleSaveTxn = (updated) => {
    setTransactions(prev => prev.map(t => t.id === updated.id ? updated : t));
    setOpenTxnId(null);
    const patch = { codedBy: "manual" };
    if (updated.description !== undefined) patch.description = updated.description || null;
    if (updated.lineCode !== undefined) patch.lineCode = updated.lineCode || null;
    if (updated.splits && updated.splits.length > 0) {
      patch.lineCode = null;
      patch.splits = updated.splits.map(s => ({ code: s.code, amount: s.amount, description: s.description }));
    }
    fetchApi(`/api/transactions/${updated.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(e => console.error("Failed to save:", e));
    showToast(`Saved ${updated.vendor}`);
  };
  const codeMatching = useCallback((pattern, code) => {
    const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), "i");
    let count = 0;
    setTransactions(prev => prev.map(t => {
      if (t.amount == null) return t;
      if (re.test(t.vendor || "") || re.test(t.description || "")) {
        count++;
        fetchApi(`/api/transactions/${t.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lineCode: code, codedBy: "manual" }),
        }).catch(e => console.error("codeMatching save failed:", e));
        return { ...t, lineCode: code, codedBy: "manual", splits: undefined };
      }
      return t;
    }));
    return count;
  }, []);

  // ─── account actions ──────────────────────────────────────────
  const handleSaveAcct = (instId, acctId, patch) => {
    const nextCategory = patch.category ? patch.category : null;
    const prevAcct = instsRef.current.find(i => i.id === instId)?.accounts.find(a => a.id === acctId);
    setInstitutions(prev => prev.map(i => i.id === instId
      ? { ...i, accounts: i.accounts.map(a => a.id === acctId ? { ...a, ...patch, category: nextCategory } : a) }
      : i));
    setOpenAcct(null);
    fetchApi(`/api/accounts/${acctId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: patch.nickname || null, category: nextCategory }),
    }).then(() => showToast("Saved")).catch((e) => {
      // The save failed — don't claim success. Roll back the optimistic edit so
      // the UI doesn't show an unsaved change as if it persisted.
      console.error("Failed to save account:", e);
      if (prevAcct) setInstitutions(prev => prev.map(i => i.id === instId
        ? { ...i, accounts: i.accounts.map(a => a.id === acctId ? prevAcct : a) }
        : i));
      showToast("Couldn’t save — check your connection and try again");
    });
  };
  const setNickname = useCallback((acctId, nickname) => {
    setInstitutions(prev => prev.map(i => ({
      ...i,
      accounts: i.accounts.map(a => a.id === acctId ? { ...a, nickname: nickname || undefined } : a),
    })));
    fetchApi(`/api/accounts/${acctId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: nickname || null }),
    }).catch(e => console.error("Failed to save nickname:", e));
  }, []);

  // ─── reload all data from API ─────────────────────────────────
  const reloadAll = useCallback(async () => {
    const data = await loadLedgerData();
    setInstitutions(data.institutions);
    setTransactions(data.transactions);
    setBills(data.bills);
    setAccountBlocks(data.accountBlocks);
  }, []);

  // ─── sync from Plaid ────────────────────────────────────────
  const handleSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const result = await fetchApi("/api/plaid/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      await reloadAll();
      const parts = [];
      if (result.synced > 0) parts.push(`${result.synced} transactions`);
      if (result.auto_coded > 0) parts.push(`${result.auto_coded} auto-coded`);
      if (result.accounts_updated > 0) parts.push(`${result.accounts_updated} balances`);
      showToast(parts.length ? `Synced ${parts.join(", ")}` : "Already up to date");
    } catch (e) {
      console.error("Sync failed:", e);
      showToast("Sync failed — check console");
    } finally {
      setSyncing(false);
    }
  }, [syncing, reloadAll]);

  // ─── mark transactions as seen ──────────────────────────────
  const handleMarkSeen = useCallback(async () => {
    try {
      await fetchApi("/api/transactions/mark-seen", { method: "POST" });
      setTransactions(prev => prev.map(t => ({ ...t, seen: true })));
      showToast("All marked as seen");
    } catch (e) {
      console.error("Mark seen failed:", e);
    }
  }, []);

  // ─── connect institution (via Plaid Link) ─────────────────────
  const handleConnect = useCallback(async (result) => {
    if (result.reconnected) {
      setReconnectInst(null);
      showToast("Reconnected · connection restored");
    } else {
      const name = result.institutionName || "Institution";
      const accts = result.accounts || [];
      setShowAdd(false);
      showToast(`${name} linked · ${accts.length} account${accts.length !== 1 ? "s" : ""} found`);
    }
    // Refresh institutions from API (1Password now has the new/repaired token)
    try {
      const insts = await fetchApi("/api/institutions");
      setInstitutions(insts.map(mapInstitution));
    } catch (e) {
      console.error("Failed to refresh institutions:", e);
    }
  }, []);

  // ─── expose window.Ledger ─────────────────────────────────────
  useEffect(() => {
    window.Ledger = {
      bills: {
        list:    () => billsRef.current.map(b => ({ ...b })),
        add:     (b) => addBill(b),
        addMany: (arr) => addManyBills(arr),
        update:  (id, patch) => updateBill(id, {
          ...patch,
          ...(patch.date ? { date: normalizeDate(patch.date), weekday: computeWeekday(normalizeDate(patch.date)) } : {}),
        }),
        remove:  (id) => removeBill(id),
        clear:   () => { for (const b of billsRef.current) fetchApi(`/api/bills/${b.id}`, { method: "DELETE" }).catch(() => {}); setBills([]); },
      },
      transactions: {
        list:   () => txnsRef.current.map(t => ({ ...t })),
        get:    (id) => txnsRef.current.find(t => t.id === id),
        update: (id, patch) => updateTxn(id, patch),
        codeMatching: (pattern, code) => codeMatching(pattern, code),
      },
      accounts: {
        list: () => instsRef.current.flatMap(i => i.accounts.map(a => ({
          institutionId: i.id, institutionName: i.name,
          id: a.id, name: a.nickname || a.name, originalName: a.name,
          mask: a.mask, category: a.category, subtype: a.subtype,
          balance: a.balance, available: a.available,
        }))),
        setNickname: (acctId, name) => setNickname(acctId, name),
      },
      institutions: { list: () => instsRef.current.map(i => ({ ...i, accounts: i.accounts.map(a => ({ ...a })) })) },
      lineCodes:    { list: () => LINE_CODES.map(c => ({ ...c })) },
      summary: {
        netWorth: () => instsRef.current.reduce((n, i) => n + i.accounts.reduce((m, a) => m + a.balance, 0), 0),
        totalsByCode: (p = "ytd") => aggregateByCode(txnsRef.current, p),
        netForPeriod: (p = "ytd") => {
          const by = aggregateByCode(txnsRef.current, p);
          return Object.values(by).reduce((s, x) => s + x.total, 0);
        },
      },
    };
    if (!window.__ledgerHinted) {
      console.log("%cLedger API ready", "color:#1F4F4A;font-weight:600",
        "→ try window.Ledger.summary.totalsByCode('ytd')");
      window.__ledgerHinted = true;
    }
  }, [addBill, addManyBills, removeBill, updateTxn, codeMatching, setNickname]);

  // ─── derived ──────────────────────────────────────────────────
  const accountLabels = useMemo(() =>
    institutions.flatMap(i => i.accounts.map(a => `${a.nickname || a.name} ····${a.mask}`)),
    [institutions]);

  const tabs = [
    { key: "overview",  label: "Overview",     icon: "overview" },
    { key: "cashflow",  label: "Cashflow",     icon: "calendar", count: bills.length },
    { key: "txns",      label: "Transactions", icon: "list",     count: transactions.length },
    { key: "accounts",  label: "Accounts",     icon: "link",     count: institutions.length },
  ];

  if (loading) {
    return (
      <div style={{ display:"grid", placeItems:"center", minHeight:"100vh", fontFamily:"var(--serif)", fontSize:22, color:"var(--muted)" }}>
        <div style={{ textAlign:"center" }}>
          <div style={{ fontStyle:"italic", marginBottom:8 }}>Ledger</div>
          <div className="spin" style={{ width:20, height:20, margin:"0 auto" }}/>
        </div>
      </div>
    );
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="wordmark"><span className="dot"/>Ledger</div>
          <div className="topbar-spacer"/>
          <button className="api-pill" onClick={handleSync} disabled={syncing} style={{ marginRight:6 }}>
            {syncing ? <div className="spin" style={{ width:11, height:11 }}/> : <Icon name="sync" size={11}/>}
            {syncing ? "Syncing…" : "Sync"}
          </button>
          <button className="api-pill" onClick={() => setCsvOpen(true)} style={{ marginRight:6 }}>
            ↓ Export
          </button>
        </div>
      </header>

      <main className="page">
        <div className="tab-bar">
          {tabs.map(tb => (
            <button key={tb.key} className={tab === tb.key ? "on" : ""} onClick={() => setTab(tb.key)}>
              <Icon name={tb.icon} size={13}/>
              {tb.label}
              {tb.count != null && <span className="count">{tb.count}</span>}
            </button>
          ))}
        </div>

        {tab === "overview" && (
          <OverviewTab
            institutions={institutions}
            transactions={transactions}
            accountBlocks={accountBlocks}
            period={period} setPeriod={setPeriod}
            customRange={customRange} setCustomRange={setCustomRange}
            hideEmpty={hideEmpty} setHideEmpty={setHideEmpty}
            hide={t.hideBalances}
            onJumpToUncoded={() => { setTab("txns"); setFocusUncoded(n => n + 1); }}
            onReload={reloadAll}
          />
        )}

        {tab === "cashflow" && (
          <BillsTab
            bills={bills}
            institutions={institutions}
            addBill={addBill}
            removeBill={removeBill}
            updateBill={updateBill}
            hide={t.hideBalances}
          />
        )}

        {tab === "txns" && (
          <TxnsTab
            transactions={transactions}
            institutions={institutions}
            openTxnId={openTxnId} setOpenTxnId={setOpenTxnId}
            onSaveTxn={handleSaveTxn}
            hide={t.hideBalances}
            focusUncoded={focusUncoded}
            onMarkSeen={handleMarkSeen}
          />
        )}

        {tab === "accounts" && (
          <AccountsTab
            institutions={institutions} setInstitutions={setInstitutions}
            openAcct={openAcct} setOpenAcct={setOpenAcct}
            onSaveAcct={handleSaveAcct}
            accountBlocks={accountBlocks}
            hide={t.hideBalances}
            onAddInst={() => setShowAdd(true)}
            onReconnect={(inst) => setReconnectInst({ itemId: inst.plaidItemId, institutionName: inst.name })}
          />
        )}
      </main>

      <footer className="footer">
        <div className="mark">Ledger · one source of truth for personal finance</div>
        <div className="right">
          <span>Localhost only · 127.0.0.1</span>
          <span>v{document.body.dataset.appVersion || "0.0.0"}</span>
        </div>
      </footer>

      <TweaksPanel>
        <TweakSection label="Appearance"/>
        <TweakRadio label="Theme" value={t.theme} options={["light","dark"]} onChange={v => setTweak("theme", v)}/>
        <TweakColor label="Accent" value={t.accent}
          options={["#1F4F4A","#2D5F8E","#7A5A2B","#5C3A6B","#1A1814"]}
          onChange={v => setTweak("accent", v)}/>
        <TweakSection label="Privacy"/>
        <TweakToggle label="Hide balances" value={t.hideBalances} onChange={v => setTweak("hideBalances", v)}/>
      </TweaksPanel>

      {showAdd && <AddModal onClose={() => setShowAdd(false)} onConnect={handleConnect}/>}
      {reconnectInst && <AddModal reconnect={reconnectInst} onClose={() => setReconnectInst(null)} onConnect={handleConnect}/>}
      {apiOpen && <ApiModal onClose={() => setApiOpen(false)}/>}
      {csvOpen && <CsvExportModal institutions={institutions} onClose={() => setCsvOpen(false)} onToast={showToast}/>}

      {toast && (
        <div className="toast-wrap">
          <div className="toast"><span className="dot"/>{toast}</div>
        </div>
      )}
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);

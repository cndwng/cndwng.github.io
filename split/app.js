import {
  CURRENCIES, DEFAULT_RATES, toMinor, format, toInputString, convertMinor,
  shares, balances, settleUp, splitEvenly,
} from './settle.js';
import { openStore, newId } from './store.js';

const app = document.getElementById('app');
const sheetRoot = document.getElementById('sheet-root');
const sheetBody = document.getElementById('sheet-body');
const CUR_CODES = Object.keys(CURRENCIES);

const S = {
  store: null,
  tripId: new URLSearchParams(location.search).get('t'),
  trip: undefined, // undefined = loading, null = not found
  expenses: [],
  tab: 'expenses', // expenses | settle | trip
  sheetOpen: false, // add/edit sheet over the current tab
  sheetPushed: false, // we added a history entry for the sheet, so Back closes it
  sheetReturn: '',
  flash: null, // { id, at } row to highlight after saving
  draft: null,
  editingId: null,
  errors: {},
  me: null,
  meAsked: false, // picked someone or skipped on this device
  error: null,
};

// ---------- small helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const ls = {
  get(k, fallback = null) {
    try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ }
  },
};

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function prettyDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (y !== new Date().getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString(undefined, opts);
}

function people() {
  return Object.entries(S.trip?.people || {})
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
}
const personName = (id) => S.trip?.people?.[id]?.name ?? 'someone (removed)';
const rates = () => ({ ...DEFAULT_RATES, ...(S.trip?.rates || {}) });
const settleCur = () => S.trip?.settleCurrency || 'USD';

const clip = (str, n = 28) => (str.length > n ? `${str.slice(0, n - 1).trimEnd()}…` : str);

let toastTimer;
function toast(msg, action) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) {
    el.querySelector('button').onclick = () => { action.fn(); el.classList.remove('show'); };
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 6000 : 3000);
}

async function fetchUsdRates() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    if (data.result !== 'success') return null;
    return Object.fromEntries(CUR_CODES.map((c) => [c, data.rates[c]]).filter(([, v]) => v));
  } catch {
    return null;
  }
}

// ---------- draft (the add/edit form) ----------

function blankDraft() {
  const lastCur = ls.get(`split:cur:${S.tripId}`);
  return {
    kind: 'expense',
    amount: '',
    currency: CURRENCIES[lastCur] ? lastCur : (S.trip?.defaultCurrency || 'JPY'),
    merchant: '',
    paidBy: S.me && S.trip?.people?.[S.me] ? S.me : null,
    mode: 'equal',
    participants: null, // null = everyone currently on the trip
    exact: {},
    date: today(),
    note: '',
  };
}

function draftFromExpense(e) {
  return {
    kind: e.kind || 'expense',
    amount: toInputString(e.amount, e.currency),
    currency: e.currency,
    merchant: e.merchant,
    paidBy: e.paidBy,
    mode: e.split.mode,
    participants: e.split.mode === 'equal'
      ? [...e.split.participants]
      : Object.keys(e.split.amounts),
    exact: e.split.mode === 'exact'
      ? Object.fromEntries(Object.entries(e.split.amounts).map(([k, v]) => [k, toInputString(v, e.currency)]))
      : {},
    date: e.date,
    note: e.note || '',
    createdAt: e.createdAt,
  };
}

const draftParticipants = () => {
  const ids = people().map((p) => p.id);
  return S.draft.participants ? S.draft.participants.filter((id) => ids.includes(id)) : ids;
};

function exactTotals() {
  const d = S.draft;
  const amount = toMinor(d.amount || 0, d.currency);
  let assigned = 0;
  for (const id of draftParticipants()) {
    const v = toMinor(d.exact[id] || 0, d.currency);
    if (Number.isFinite(v)) assigned += v;
  }
  return { amount, assigned, left: amount - assigned };
}

function validate() {
  const d = S.draft;
  const errors = {};
  const amount = toMinor(d.amount, d.currency);
  if (!d.amount || !Number.isFinite(amount) || amount <= 0) errors.amount = 'Enter an amount';
  if (!d.merchant.trim()) errors.merchant = 'Where was this?';
  if (!d.paidBy || !S.trip.people[d.paidBy]) errors.paidBy = 'Who paid?';
  const ids = draftParticipants();
  if (!ids.length) errors.split = 'Pick at least one person';
  else if (d.mode === 'exact' && !errors.amount) {
    const { left } = exactTotals();
    if (left !== 0) {
      errors.split = left > 0
        ? `${format(left, d.currency)} still unassigned`
        : `${format(-left, d.currency)} more than the total`;
    }
  }
  return errors;
}

function draftToExpense(id) {
  const d = S.draft;
  const ids = draftParticipants();
  const split = d.mode === 'equal'
    ? { mode: 'equal', participants: ids }
    : {
      mode: 'exact',
      amounts: Object.fromEntries(
        ids.map((pid) => [pid, toMinor(d.exact[pid] || 0, d.currency)]).filter(([, v]) => v > 0),
      ),
    };
  return {
    id,
    kind: d.kind,
    merchant: d.merchant.trim(),
    amount: toMinor(d.amount, d.currency),
    currency: d.currency,
    paidBy: d.paidBy,
    split,
    date: d.date || today(),
    note: d.note.trim(),
    createdAt: d.createdAt || Date.now(),
  };
}

// ---------- rendering ----------

function render() {
  // Re-rendering replaces the DOM, so carry focus (and any half-typed text in
  // non-draft inputs) across. Draft inputs re-render from S.draft instead.
  const a = document.activeElement;
  const keep = a && a.id && (app.contains(a) || sheetRoot.contains(a))
    ? { id: a.id, value: a.value, s: a.selectionStart, e: a.selectionEnd, restoreValue: a.matches('input:not([data-bind]):not([data-exact]), textarea:not([data-bind])') }
    : null;

  const sheetScroll = sheetBody.querySelector('.sheet-scroll')?.scrollTop || 0;

  if (!S.tripId) app.innerHTML = landingHTML();
  else if (S.trip === undefined) app.innerHTML = '<p class="loading">loading trip…</p>';
  else if (S.trip === null) app.innerHTML = notFoundHTML();
  else app.innerHTML = tripHTML();
  renderSheet(sheetScroll);
  applyFlash();

  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) {
      if (keep.restoreValue && el.value !== keep.value) el.value = keep.value;
      el.focus({ preventScroll: true });
      try { el.setSelectionRange(keep.s, keep.e); } catch { /* not a text input */ }
    }
  }
  if (S.sheetOpen) updateDerived();
}

let sheetTimer;
function renderSheet(scrollTop) {
  if (S.sheetOpen && S.trip) {
    sheetBody.innerHTML = sheetHTML();
    const scroller = sheetBody.querySelector('.sheet-scroll');
    if (scroller) scroller.scrollTop = scrollTop;
    clearTimeout(sheetTimer);
    if (sheetRoot.hidden) {
      sheetRoot.hidden = false;
      void sheetRoot.offsetHeight; // start the slide-up from the closed position
    }
    sheetRoot.classList.add('open');
    sheetRoot.inert = false;
    app.inert = true;
    document.documentElement.classList.add('sheet-open');
  } else if (!sheetRoot.hidden) {
    sheetRoot.classList.remove('open');
    sheetRoot.inert = true;
    app.inert = false;
    document.documentElement.classList.remove('sheet-open');
    clearTimeout(sheetTimer);
    sheetTimer = setTimeout(() => {
      if (S.sheetOpen) return;
      sheetRoot.hidden = true;
      sheetBody.innerHTML = '';
    }, 320);
  }
}

// Highlight a just-saved row. Re-renders (e.g. the server confirming the
// write) rebuild the row, so offset the animation by the time already spent.
const FLASH_MS = 1800;
function applyFlash() {
  if (!S.flash) return;
  const elapsed = Date.now() - S.flash.at;
  if (elapsed > FLASH_MS) { S.flash = null; return; }
  const row = app.querySelector(`[data-row="${S.flash.id}"]`);
  if (!row) return;
  row.classList.add('flash');
  row.style.animationDelay = `-${elapsed}ms`;
  if (!S.flash.scrolled) {
    S.flash.scrolled = true;
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function errorBanner() {
  return S.error ? `<div class="banner error">${esc(S.error)}</div>` : '';
}

function landingHTML() {
  const recent = ls.get('split:recent', []);
  return `
    <header class="top"><button type="button" class="wordmark" data-act="home">split</button></header>
    ${errorBanner()}
    ${recent.length ? `
      <h3>Your trips</h3>
      <div class="card"><ul class="list">
        ${recent.map((t) => `<li><button type="button" class="item" data-act="open-trip" data-id="${esc(t.id)}">
          <span class="main"><span class="title">${esc(t.name)}</span></span><span class="muted">→</span></button></li>`).join('')}
      </ul></div>` : `
      <h1>split</h1>
      <p class="muted">Track who paid for what on a trip, then settle up in as few payments as possible.</p>`}
    <h3>New trip</h3>
    <form class="card" id="new-trip">
      <label class="field"><span class="label">Trip name</span>
        <input id="nt-name" name="name" placeholder="Japan 2026" required autocomplete="off"></label>
      <label class="field"><span class="label">Your name</span>
        <input id="nt-me" name="me" placeholder="Cindy" required autocomplete="off"></label>
      <label class="field"><span class="label">Who else is going? <span class="opt">one per line or commas</span></span>
        <textarea id="nt-others" name="others" rows="3" placeholder="Alex, Sam, Jordan"></textarea></label>
      <div class="field"><span class="label">Most spending will be in</span>
        <div class="seg" id="nt-cur">${CUR_CODES.map((c) => `<button type="button" data-act="nt-cur" data-cur="${c}" aria-pressed="${c === 'JPY'}">${c}</button>`).join('')}</div>
      </div>
      <button class="btn primary block" type="submit">Create trip</button>
    </form>
    ${S.store && !S.store.shared ? localModeNote() : ''}
  `;
}

function localModeNote() {
  return `<p class="small muted">Running in local-only mode: data stays in this browser. Add a Firebase config in <span class="mono">split/config.js</span> to share trips with friends.</p>`;
}

function notFoundHTML() {
  return `
    <header class="top"><button type="button" class="wordmark" data-act="home">split</button></header>
    ${errorBanner()}
    <div class="empty"><p>Couldn't find that trip.</p><button type="button" class="btn" data-act="home">All trips</button></div>`;
}

function tripHTML() {
  const tabs = [
    ['expenses', '≡', 'Expenses'],
    ['settle', '⇄', 'Settle up'],
    ['trip', '⚙', 'Trip'],
  ];
  const view = { expenses: expensesHTML, settle: settleHTML, trip: tripSettingsHTML }[S.tab]();
  return `
    <header class="top">
      <button type="button" class="wordmark" data-act="home" aria-label="All trips">split</button>
      <span class="trip-name">${esc(S.trip.name)}</span>
      <button class="me-chip" type="button" data-act="tab" data-tab="trip">${S.me && S.trip.people[S.me] ? esc(personName(S.me)) : 'who are you?'}</button>
    </header>
    ${errorBanner()}
    <main>${view}</main>
    ${S.tab !== 'trip' ? '<button type="button" class="fab" id="fab" data-act="open-add"><span class="plus" aria-hidden="true">+</span>Add expense</button>' : ''}
    <nav class="tabs"><div class="inner">
      ${tabs.map(([id, ic, label]) => `<button type="button" id="tab-${id}" data-act="tab" data-tab="${id}" ${S.tab === id ? 'aria-current="page"' : ''}><span class="ic" aria-hidden="true">${ic}</span>${label}</button>`).join('')}
    </div></nav>`;
}

function chip(id, label, pressed, act, extra = '') {
  return `<button type="button" class="chip" id="${id}" data-act="${act}" ${extra} aria-pressed="${pressed}">${esc(label)}</button>`;
}

function whoAreYouHTML(ppl) {
  if (S.me || S.meAsked || !ppl.length) return '';
  return `
    <div class="card">
      <div class="field" style="margin:0"><span class="label">Who are you? <span class="opt">sets the default payer on this device</span></span>
        <div class="chips">${ppl.map((p) => chip(`me-${p.id}`, p.name, false, 'set-me', `data-id="${p.id}"`)).join('')}
          <button type="button" class="chip link" data-act="set-me" data-id="-">skip</button></div>
      </div>
    </div>`;
}

function sheetHTML() {
  const ppl = people();
  const d = S.draft;
  const title = !S.editingId ? 'Add expense' : d.kind === 'payment' ? 'Edit payment' : 'Edit expense';
  const head = `
    <div class="sheet-head" id="sheet-head">
      <span class="grab" aria-hidden="true"></span>
      <h2 id="sheet-title">${title}</h2>
      <button type="button" class="icon-btn" id="sheet-close" data-act="close-sheet" aria-label="Close">✕</button>
    </div>`;
  if (!ppl.length) {
    return `${head}<div class="sheet-scroll"><div class="empty"><p>Add the people on this trip first.</p><button type="button" class="btn" data-act="tab" data-tab="trip">Add people</button></div></div>`;
  }
  const e = S.errors;
  const cur = CURRENCIES[d.currency];
  const parts = draftParticipants();
  const everyone = parts.length === ppl.length;

  return `${head}
    <form id="expense-form" class="sheet-scroll" novalidate>

      <div class="field ${e.amount ? 'invalid' : ''}">
        <span class="label"><label for="f-amount">Amount</label></span>
        <div class="amount-row">
          <div class="amount-wrap">
            <span class="sym" aria-hidden="true">${cur.symbol}</span>
            <input id="f-amount" data-bind="amount" value="${esc(d.amount)}" inputmode="${cur.decimals ? 'decimal' : 'numeric'}" placeholder="0" autocomplete="off" enterkeyhint="next">
          </div>
          <div class="seg" role="group" aria-label="Currency">
            ${CUR_CODES.map((c) => `<button type="button" id="cur-${c}" data-act="currency" data-cur="${c}" aria-pressed="${d.currency === c}">${CURRENCIES[c].symbol}</button>`).join('')}
          </div>
        </div>
        ${e.amount ? `<div class="err">${e.amount}</div>` : ''}
        <div class="small muted" id="converted"></div>
      </div>

      <label class="field ${e.merchant ? 'invalid' : ''}">
        <span class="label">Where / what</span>
        <input id="f-merchant" data-bind="merchant" value="${esc(d.merchant)}" placeholder="Ichiran, 7-Eleven, taxi…" autocomplete="off" enterkeyhint="next">
        ${e.merchant ? `<div class="err">${e.merchant}</div>` : ''}
      </label>

      <div class="field">
        <span class="label">Paid by</span>
        <div class="chips">${ppl.map((p) => chip(`paid-${p.id}`, p.name, d.paidBy === p.id, 'paid-by', `data-id="${p.id}"`)).join('')}</div>
        ${e.paidBy ? `<div class="err">${e.paidBy}</div>` : ''}
      </div>

      <div class="field">
        <div class="label split-head">
          <span>Split between <span class="opt" id="split-summary"></span></span>
          <span class="seg" role="group" aria-label="Split mode">
            <button type="button" id="mode-equal" data-act="mode" data-mode="equal" aria-pressed="${d.mode === 'equal'}">Equally</button>
            <button type="button" id="mode-exact" data-act="mode" data-mode="exact" aria-pressed="${d.mode === 'exact'}">Amounts</button>
          </span>
        </div>
        <div class="chips">
          ${ppl.map((p) => chip(`part-${p.id}`, p.name, parts.includes(p.id), 'toggle-part', `data-id="${p.id}"`)).join('')}
          ${everyone ? '' : '<button type="button" class="chip link" id="part-all" data-act="all-parts">everyone</button>'}
        </div>
        ${d.mode === 'exact' ? `
          <div class="exact-list">
            ${parts.map((pid) => `
              <label class="exact-row"><span class="who">${esc(personName(pid))}</span>
                <input id="exact-${pid}" data-exact="${pid}" value="${esc(d.exact[pid] || '')}" inputmode="${cur.decimals ? 'decimal' : 'numeric'}" placeholder="${cur.symbol}0" autocomplete="off"></label>`).join('')}
            <div class="remaining" id="remaining"></div>
          </div>` : ''}
        ${e.split ? `<div class="err" id="split-err">${e.split}</div>` : ''}
      </div>

      <div class="row-2">
        <label class="field"><span class="label">Date</span>
          <input id="f-date" type="date" data-bind="date" value="${esc(d.date)}"></label>
        <label class="field"><span class="label">Note <span class="opt">optional</span></span>
          <input id="f-note" data-bind="note" value="${esc(d.note)}" placeholder="e.g. dinner w/ sake" autocomplete="off" enterkeyhint="done"></label>
      </div>

      <div class="sheet-foot">
        ${S.editingId
    ? '<button type="button" class="btn danger" data-act="delete-expense">Delete</button><button type="submit" class="btn primary grow">Save</button>'
    : '<button type="submit" class="btn primary grow">Add expense</button>'}
      </div>
    </form>`;
}

// Text that depends on what's being typed, updated without a full re-render.
function updateDerived() {
  const d = S.draft;
  if (!d) return;
  const amount = toMinor(d.amount || 0, d.currency);
  const valid = Number.isFinite(amount) && amount > 0;

  const conv = document.getElementById('converted');
  if (conv) {
    const other = d.currency === settleCur() ? CUR_CODES.find((c) => c !== d.currency) : settleCur();
    conv.textContent = valid && other
      ? `≈ ${format(Math.round(convertMinor(amount, d.currency, other, rates())), other)}`
      : '';
  }

  const summary = document.getElementById('split-summary');
  const parts = draftParticipants();
  if (summary) {
    if (d.mode === 'equal' && valid && parts.length) {
      const each = splitEvenly(amount, parts);
      const vals = Object.values(each);
      const lo = Math.min(...vals);
      summary.textContent = `· ${format(lo, d.currency)}${Math.max(...vals) !== lo ? '+' : ''} each`;
    } else {
      summary.textContent = parts.length ? `· ${parts.length} ${parts.length === 1 ? 'person' : 'people'}` : '';
    }
  }

  const rem = document.getElementById('remaining');
  if (rem) {
    const { left } = exactTotals();
    if (!valid) rem.textContent = '';
    else if (left === 0) { rem.textContent = '✓ adds up'; rem.className = 'remaining pos'; }
    else if (left > 0) { rem.textContent = `${format(left, d.currency)} left to assign`; rem.className = 'remaining muted'; }
    else { rem.textContent = `${format(-left, d.currency)} over`; rem.className = 'remaining neg'; }
  }
}

function sortedExpenses() {
  return [...S.expenses].sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
}

function expensesHTML() {
  const list = sortedExpenses();
  const who = whoAreYouHTML(people());
  if (!list.length) {
    return `${who}<div class="empty"><p>No expenses yet.</p><p class="small">Tap <b>Add expense</b> to log the first one.</p></div>`;
  }
  const sc = settleCur();
  const r = rates();
  const conv = (e, m) => Math.round(convertMinor(m, e.currency, sc, r));
  const real = list.filter((e) => e.kind !== 'payment');
  const total = real.reduce((t, e) => t + conv(e, e.amount), 0);
  const myShare = S.me ? real.reduce((t, e) => t + conv(e, shares(e)[S.me] || 0), 0) : null;

  const byDate = new Map();
  for (const e of list) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }

  const row = (e) => {
    const sh = shares(e);
    const n = Object.keys(sh).length;
    const mine = S.me ? sh[S.me] : 0;
    if (e.kind === 'payment') {
      const to = Object.keys(sh)[0];
      return `<li data-row="${e.id}"><button type="button" class="item payment" data-act="edit" data-id="${e.id}">
        <span class="main"><span class="title">${esc(personName(e.paidBy))} paid ${esc(personName(to))}</span>
        <span class="sub">settle-up payment${e.note ? ` · ${esc(e.note)}` : ''}</span></span>
        <span class="right amt">${format(e.amount, e.currency)}</span></button></li>`;
    }
    const splitDesc = e.split.mode === 'exact' ? 'custom split' : n === 1 ? `for ${esc(personName(Object.keys(sh)[0]))}` : `split ${n} ways`;
    return `<li data-row="${e.id}"><button type="button" class="item" data-act="edit" data-id="${e.id}">
      <span class="main"><span class="title">${esc(e.merchant)}</span>
      <span class="sub">${esc(personName(e.paidBy))} paid · ${splitDesc}${e.note ? ` · ${esc(e.note)}` : ''}</span></span>
      <span class="right"><span class="amt">${format(e.amount, e.currency)}</span>
      ${mine ? `<br><span class="small muted amt">you ${format(mine, e.currency)}</span>` : e.currency !== sc ? `<br><span class="small muted amt">≈${format(conv(e, e.amount), sc)}</span>` : ''}</span>
      </button></li>`;
  };

  return `${who}
    <div class="card">
      <div class="stat"><span>Trip total</span><span class="big">${format(total, sc)}</span></div>
      ${myShare !== null && S.trip.people[S.me] ? `<div class="stat small muted"><span>Your share</span><span class="amt">${format(myShare, sc)}</span></div>` : ''}
    </div>
    ${[...byDate].map(([date, items]) => `
      <h3>${esc(prettyDate(date))}</h3>
      <div class="card flush"><ul class="list">${items.map(row).join('')}</ul></div>`).join('')}`;
}

function settleHTML() {
  const ppl = people();
  const sc = settleCur();
  const r = rates();
  const { net, paid, owed } = balances(S.expenses, ppl.map((p) => p.id), sc, r);
  const transfers = settleUp(net);
  const other = CUR_CODES.find((c) => c !== sc);

  const rateNote = CUR_CODES.filter((c) => c !== 'USD').map((c) => `1 USD = ${r[c]} ${c}`).join(' · ');

  return `
    <div class="split-head" style="margin-top:12px">
      <h2 style="margin:0">${transfers.length ? `${transfers.length} payment${transfers.length === 1 ? '' : 's'} to settle up` : 'Settle up'}</h2>
      <span class="seg" role="group" aria-label="Settle currency">
        ${CUR_CODES.map((c) => `<button type="button" id="sc-${c}" data-act="settle-cur" data-cur="${c}" aria-pressed="${sc === c}">${c}</button>`).join('')}
      </span>
    </div>
    <div class="card">
      ${transfers.length ? `<ul class="list">${transfers.map((t) => `
        <li class="transfer ${S.me && (t.from === S.me || t.to === S.me) ? 'mine' : ''}">
          <span class="main"><span class="names">${esc(personName(t.from))}<span class="arrow">→</span>${esc(personName(t.to))}</span><br>
            <span class="amt">${format(t.amount, sc)}</span>
            ${other ? `<span class="small muted amt"> ≈${format(Math.round(convertMinor(t.amount, sc, other, r)), other)}</span>` : ''}</span>
          <button type="button" class="btn sm" data-act="mark-paid" data-from="${t.from}" data-to="${t.to}" data-amount="${t.amount}">Mark paid</button>
        </li>`).join('')}</ul>`
    : `<p class="empty" style="padding:8px">${S.expenses.length ? 'Everyone’s square.' : 'Nothing to settle yet.'}</p>`}
    </div>
    <p class="small muted">Fewest possible payments. Converted at ${esc(rateNote)} (edit in Trip).</p>

    <h3>Balances</h3>
    <div class="card flush">
      <ul class="list">${ppl.map((p) => `
        <li class="bal-row">
          <span class="main"><span class="title">${esc(p.name)}${p.id === S.me ? ' <span class="muted">(you)</span>' : ''}</span>
            <span class="sub"><span class="nowrap">paid <span class="amt">${format(paid[p.id], sc)}</span></span> · <span class="nowrap">share <span class="amt">${format(owed[p.id], sc)}</span></span></span></span>
          <span class="amt net ${net[p.id] > 0 ? 'pos' : net[p.id] < 0 ? 'neg' : ''}">${format(net[p.id], sc, { sign: true })}</span>
        </li>`).join('')}
      </ul>
    </div>
    <p class="small muted">+ means they're owed money, − means they owe. Includes payments already marked paid.</p>`;
}

function tripSettingsHTML() {
  const ppl = people();
  const r = rates();
  const link = `${location.origin}${location.pathname}?t=${S.tripId}`;
  return `
    <h3>Share</h3>
    <div class="card">
      ${S.store.shared
    ? '<p class="small" style="margin-top:0">Anyone with this link can view and add expenses.</p>'
    : '<div class="banner" style="margin-top:0">Local-only mode: this trip lives in this browser and the link won’t work for friends yet. See <span class="mono">split/README.md</span> to turn on sharing.</div>'}
      <div class="share-box">
        <input id="share-link" readonly value="${esc(link)}" aria-label="Trip link">
        <button type="button" class="btn" data-act="share">${navigator.share ? 'Share' : 'Copy'}</button>
      </div>
    </div>

    <h3>You are</h3>
    <div class="card"><div class="chips">
      ${ppl.map((p) => chip(`iam-${p.id}`, p.name, S.me === p.id, 'set-me', `data-id="${p.id}"`)).join('')}
    </div><p class="small muted" style="margin-bottom:0">Only saved on this device. Used as the default payer and to highlight what you owe.</p></div>

    <h3>People</h3>
    <div class="card">
      ${ppl.map((p) => `
        <div class="person-row">
          <input id="person-${p.id}" data-change="rename" data-id="${p.id}" value="${esc(p.name)}" aria-label="Name" autocomplete="off">
          ${S.confirmRemove === p.id
    ? `<button type="button" class="btn sm danger" id="rm-${p.id}" data-act="remove-person" data-id="${p.id}">Remove</button>`
    : `<button type="button" class="icon-btn" id="rm-${p.id}" data-act="remove-person" data-id="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button>`}
        </div>`).join('')}
      <form class="person-row" id="add-person">
        <input id="new-person" placeholder="Add someone" autocomplete="off" enterkeyhint="done">
        <button type="submit" class="btn">Add</button>
      </form>
    </div>

    <h3>Currency</h3>
    <div class="card">
      ${CUR_CODES.filter((c) => c !== 'USD').map((c) => `
        <label class="field rate-row" style="margin-top:0">
          <span>1 USD =</span>
          <input id="rate-${c}" data-change="rate" data-cur="${c}" value="${r[c]}" inputmode="decimal" aria-label="${c} per USD">
          <span>${c}</span>
        </label>`).join('')}
      <button type="button" class="btn sm" data-act="fetch-rate">Use today’s rate</button>
      <p class="small muted" style="margin-bottom:0">One rate for the whole trip. Changing it updates every balance.</p>
    </div>

    <h3>Trip</h3>
    <div class="card">
      <label class="field" style="margin-top:0"><span class="label">Name</span>
        <input id="trip-name" data-change="trip-name" value="${esc(S.trip.name)}" autocomplete="off"></label>
      <button type="button" class="btn sm" data-act="home">All trips</button>
    </div>`;
}

// ---------- actions ----------

// The hash is the deep link for what's on screen: '' (expenses), 'settle',
// 'trip', 'add', or 'edit-<expenseId>'. The trip itself is ?t=<tripId>.
const currentHash = () => decodeURIComponent(location.hash.slice(1));
const baseHash = () => (S.tab === 'expenses' ? '' : S.tab);
const urlFor = (hash) => `${location.pathname}${location.search}${hash ? `#${hash}` : ''}`;

function replaceRoute(hash) {
  try { history.replaceState(null, '', urlFor(hash)); } catch { /* sandboxed frame */ }
  applyRoute(hash);
}

function openSheet(hash) {
  document.getElementById('toast').classList.remove('show');
  S.sheetReturn = baseHash();
  try {
    history.pushState(null, '', urlFor(hash));
    S.sheetPushed = true;
  } catch {
    S.sheetPushed = false;
  }
  applyRoute(hash);
}

function closeSheet() {
  document.activeElement?.blur(); // drop the phone keyboard
  if (S.sheetPushed) {
    S.sheetPushed = false;
    history.back(); // popstate -> applyRoute closes it
  } else {
    replaceRoute(baseHash());
  }
}

function applyRoute(hash) {
  if (!S.trip) { render(); return; }
  const wasOpen = S.sheetOpen;
  if (hash === 'add') {
    if (S.editingId) resetDraft(); // an unsaved add draft survives close/reopen
    S.sheetOpen = true;
  } else if (hash.startsWith('edit-')) {
    const id = hash.slice(5);
    const e = S.expenses.find((x) => x.id === id);
    if (!e) {
      toast('That expense was deleted.');
      replaceRoute(baseHash());
      return;
    }
    if (S.editingId !== id) {
      S.editingId = id;
      S.draft = draftFromExpense(e);
      S.errors = {};
    }
    S.sheetOpen = true;
  } else {
    S.sheetOpen = false;
    S.sheetPushed = false;
    if (S.editingId) resetDraft();
    const tab = ['settle', 'trip'].includes(hash) ? hash : 'expenses';
    if (tab !== S.tab) window.scrollTo(0, 0);
    S.tab = tab;
  }
  render();
  if (S.sheetOpen && !wasOpen && !S.editingId) {
    document.getElementById('f-amount')?.focus({ preventScroll: true });
  }
}

function resetDraft() {
  S.editingId = null;
  S.draft = blankDraft();
  S.errors = {};
}

function saveDraft() {
  S.errors = validate();
  if (Object.keys(S.errors).length) {
    render();
    const first = document.querySelector('.invalid input, .err');
    first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  const wasEditing = S.editingId;
  const expense = draftToExpense(S.editingId || newId());
  const before = wasEditing ? S.expenses.find((x) => x.id === wasEditing) : null;
  S.store.saveExpense(S.tripId, expense);
  ls.set(`split:cur:${S.tripId}`, expense.currency);
  resetDraft();
  S.draft.currency = expense.currency;

  // Close onto the expense list so the new row and the toast are visible.
  S.flash = { id: expense.id, at: Date.now() };
  const backToList = S.sheetPushed && S.sheetReturn === '';
  S.tab = 'expenses';
  if (backToList) closeSheet();
  else { document.activeElement?.blur(); S.sheetPushed = false; replaceRoute(''); }

  if (wasEditing) {
    toast(`Saved ${expense.kind === 'payment' ? 'payment' : clip(expense.merchant)}`, before && { label: 'Undo', fn: () => S.store.saveExpense(S.tripId, before) });
  } else {
    toast(`Added ${format(expense.amount, expense.currency)} · ${clip(expense.merchant)}`, {
      label: 'Undo', fn: () => S.store.deleteExpense(S.tripId, expense.id),
    });
  }
}

const actions = {
  tab: ({ tab }) => replaceRoute(tab === 'expenses' ? '' : tab),
  'open-add': () => openSheet('add'),
  'close-sheet': () => closeSheet(),
  currency: ({ cur }) => { S.draft.currency = cur; render(); },
  'paid-by': ({ id }) => { S.draft.paidBy = id; delete S.errors.paidBy; render(); },
  mode: ({ mode }) => {
    S.draft.mode = mode;
    delete S.errors.split;
    render();
    if (mode === 'exact') document.querySelector('[data-exact]')?.focus();
  },
  'toggle-part': ({ id }) => {
    const cur = draftParticipants();
    S.draft.participants = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    delete S.errors.split;
    render();
  },
  'all-parts': () => { S.draft.participants = null; render(); },
  'set-me': ({ id }) => {
    S.me = id === '-' ? null : id;
    S.meAsked = true;
    ls.set(`split:me:${S.tripId}`, id);
    if (S.draft && !S.editingId && (!S.draft.paidBy || id !== '-')) S.draft.paidBy = S.me;
    render();
  },
  'delete-expense': () => {
    const e = S.expenses.find((x) => x.id === S.editingId);
    S.store.deleteExpense(S.tripId, S.editingId);
    closeSheet();
    if (e) toast(`Deleted ${e.kind === 'payment' ? 'payment' : clip(e.merchant)}`, { label: 'Undo', fn: () => S.store.saveExpense(S.tripId, e) });
  },
  edit: ({ id }) => openSheet(`edit-${id}`),
  home: () => go(null),
  'open-trip': ({ id }) => go(id),
  'settle-cur': ({ cur }) => S.store.updateTrip(S.tripId, { settleCurrency: cur }),
  'mark-paid': ({ from, to, amount }) => {
    const cur = settleCur();
    const e = {
      id: newId(),
      kind: 'payment',
      merchant: 'Payment',
      amount: Number(amount),
      currency: cur,
      paidBy: from,
      split: { mode: 'exact', amounts: { [to]: Number(amount) } },
      date: today(),
      note: '',
      createdAt: Date.now(),
    };
    S.store.saveExpense(S.tripId, e);
    toast(`Recorded ${personName(from)} → ${personName(to)}`, { label: 'Undo', fn: () => S.store.deleteExpense(S.tripId, e.id) });
  },
  'remove-person': ({ id }) => {
    const used = S.expenses.filter((e) => e.paidBy === id || id in shares(e)).length;
    if (used) {
      toast(`${personName(id)} is on ${used} expense${used === 1 ? '' : 's'}. Edit or delete those first.`);
      return;
    }
    if (S.confirmRemove !== id) {
      S.confirmRemove = id;
      render();
      setTimeout(() => { if (S.confirmRemove === id) { S.confirmRemove = null; render(); } }, 3000);
      return;
    }
    S.confirmRemove = null;
    S.store.removePerson(S.tripId, id);
    if (S.me === id) { S.me = null; ls.set(`split:me:${S.tripId}`, null); }
  },
  share: async () => {
    const link = document.getElementById('share-link').value;
    if (navigator.share) {
      try { await navigator.share({ title: S.trip.name, url: link }); } catch { /* cancelled */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copied');
    } catch {
      document.getElementById('share-link').select();
    }
  },
  'fetch-rate': async () => {
    const fresh = await fetchUsdRates();
    if (!fresh) { toast('Couldn’t fetch rates. Enter it manually.'); return; }
    S.store.updateTrip(S.tripId, { rates: { ...rates(), ...fresh } });
    toast(`Updated: 1 USD = ${CUR_CODES.filter((c) => c !== 'USD').map((c) => `${fresh[c]} ${c}`).join(', ')}`);
  },
  'nt-cur': ({ cur }, el) => {
    el.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === el));
  },
};

const changes = {
  rename: ({ id }, el) => {
    const name = el.value.trim();
    if (!name) { el.value = personName(id); return; }
    if (name !== personName(id)) S.store.setPerson(S.tripId, id, { ...S.trip.people[id], name });
  },
  rate: ({ cur }, el) => {
    const v = Number(el.value.replace(/,/g, ''));
    if (!(v > 0)) { el.value = rates()[cur]; return; }
    S.store.updateTrip(S.tripId, { rates: { ...rates(), [cur]: v } });
  },
  'trip-name': (_, el) => {
    const name = el.value.trim();
    if (name && name !== S.trip.name) S.store.updateTrip(S.tripId, { name });
  },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  ev.preventDefault();
  actions[el.dataset.act]?.(el.dataset, el);
});

document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (!S.draft) return;
  const clean = (v) => v.replace(CURRENCIES[S.draft.currency].decimals ? /[^\d.,]/g : /[^\d,]/g, '');
  if (el.dataset.bind) {
    if (el.dataset.bind === 'amount') {
      const c = clean(el.value);
      if (c !== el.value) el.value = c;
    }
    if (S.errors[el.dataset.bind]) {
      delete S.errors[el.dataset.bind];
      const field = el.closest('.field');
      field.classList.remove('invalid');
      field.querySelector('.err')?.remove();
    }
    S.draft[el.dataset.bind] = el.value;
    updateDerived();
  } else if (el.dataset.exact) {
    const c = clean(el.value);
    if (c !== el.value) el.value = c;
    S.draft.exact[el.dataset.exact] = el.value;
    if (S.errors.split) { delete S.errors.split; document.getElementById('split-err')?.remove(); }
    updateDerived();
  }
});

document.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-change]');
  if (el) changes[el.dataset.change]?.(el.dataset, el);
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && S.sheetOpen) { closeSheet(); return; }
  // Enter on a change-bound input commits it instead of submitting anything.
  if (ev.key === 'Enter' && ev.target.dataset?.change) {
    ev.preventDefault();
    ev.target.blur();
  }
});

document.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  if (form.id === 'expense-form') saveDraft();
  else if (form.id === 'add-person') {
    const input = form.querySelector('input');
    const name = input.value.trim();
    if (!name) return;
    input.value = '';
    S.store.setPerson(S.tripId, newId(8), { name, order: Date.now() });
  } else if (form.id === 'new-trip') {
    const f = new FormData(form);
    const myName = f.get('me').trim();
    const tripName = f.get('name').trim();
    if (!myName || !tripName) return;
    const names = [myName, ...f.get('others').split(/[,\n]/).map((s) => s.trim()).filter(Boolean)];
    const now = Date.now();
    const ppl = {};
    let meId;
    names.forEach((name, i) => {
      const id = newId(8);
      if (i === 0) meId = id;
      ppl[id] = { name, order: now + i };
    });
    const defaultCurrency = form.querySelector('#nt-cur [aria-pressed=true]').dataset.cur;
    form.querySelector('button[type=submit]').disabled = true;
    const fresh = await fetchUsdRates();
    const id = S.store.createTrip({
      name: tripName,
      people: ppl,
      settleCurrency: 'USD',
      defaultCurrency,
      rates: { ...DEFAULT_RATES, ...(fresh || {}) },
    });
    ls.set(`split:me:${id}`, meId);
    // Stay on this page (no reload) so the pending write isn't cut off.
    go(id);
  }
});

// Swipe the sheet's header down to close it.
let drag = null;
document.addEventListener('pointerdown', (ev) => {
  const head = ev.target.closest('#sheet-head');
  if (!head || ev.target.closest('button')) return;
  const sheet = head.closest('.sheet');
  drag = { y: ev.clientY, dy: 0, sheet };
  head.setPointerCapture?.(ev.pointerId);
  sheet.style.transition = 'none';
});
document.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  drag.dy = Math.max(0, ev.clientY - drag.y);
  drag.sheet.style.transform = `translateY(${drag.dy}px)`;
});
function endDrag() {
  if (!drag) return;
  const { sheet, dy } = drag;
  drag = null;
  sheet.style.transition = '';
  sheet.style.transform = '';
  if (dy > 80) closeSheet();
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

// Keep the sheet above the on-screen keyboard (iOS doesn't resize the page).
const vv = window.visualViewport;
if (vv) {
  const onViewport = () => {
    const root = document.documentElement.style;
    root.setProperty('--kb', `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`);
    root.setProperty('--vvh', `${vv.height}px`);
  };
  vv.addEventListener('resize', onViewport);
  vv.addEventListener('scroll', onViewport);
  onViewport();
}

// ---------- boot ----------

function rememberTrip() {
  const recent = ls.get('split:recent', []).filter((t) => t.id !== S.tripId);
  recent.unshift({ id: S.tripId, name: S.trip.name });
  ls.set('split:recent', recent.slice(0, 10));
}

let unsubscribe = null;

// Switch trips without a page load (also keeps any pending write alive).
function go(id) {
  try { history.pushState(null, '', id ? `?t=${id}` : location.pathname); } catch { /* sandboxed frame */ }
  openTrip(id);
  window.scrollTo(0, 0);
}

function openTrip(id) {
  unsubscribe?.();
  Object.assign(S, {
    tripId: id, trip: undefined, expenses: [], tab: 'expenses', sheetOpen: false, sheetPushed: false,
    flash: null, draft: null, editingId: null, errors: {},
  });
  if (!id) { render(); return; }

  const savedMe = ls.get(`split:me:${id}`);
  S.me = savedMe && savedMe !== '-' ? savedMe : null;
  S.meAsked = savedMe != null;
  let first = true;
  render();
  unsubscribe = S.store.subscribe(id, ({ trip, expenses }) => {
    S.trip = trip;
    S.expenses = expenses;
    if (trip) {
      if (S.me && !trip.people?.[S.me]) S.me = null;
      if (first) {
        S.draft = blankDraft();
        document.title = `${trip.name} • split`;
        rememberTrip();
        first = false;
        applyRoute(currentHash()); // honor deep links like #add or #edit-<id>
        return;
      }
      if (S.sheetOpen && S.editingId && !expenses.some((e) => e.id === S.editingId)) {
        toast('Someone else deleted this expense.');
        closeSheet();
        return;
      }
    }
    render();
  });
}

async function boot() {
  S.store = await openStore((err) => {
    S.error = `Sync problem: ${err.message || err}. Changes are kept on this device and will retry.`;
    render();
  });
  window.addEventListener('popstate', () => {
    const t = new URLSearchParams(location.search).get('t');
    if (t !== S.tripId) openTrip(t);
    else applyRoute(currentHash());
  });
  openTrip(S.tripId);
}

boot();

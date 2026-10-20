// Pure money math: currencies, splitting, balances, and settle-up.
// No DOM or storage here so it can be tested in node.

// To add a currency: add it here and give it a default rate in DEFAULT_RATES.
export const CURRENCIES = {
  USD: { symbol: '$', decimals: 2, locale: 'en-US' },
  JPY: { symbol: '¥', decimals: 0, locale: 'ja-JP' },
};

// Units of each currency per 1 USD.
export const DEFAULT_RATES = { USD: 1, JPY: 150 };

const factor = (cur) => 10 ** CURRENCIES[cur].decimals;

// "12.34" -> 1234 (USD) ; "1,200" -> 1200 (JPY). Returns NaN if unparseable.
export function toMinor(input, cur) {
  const n = Number(String(input).replace(/[,\s$¥]/g, ''));
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * factor(cur));
}

export function toMajor(minor, cur) {
  return minor / factor(cur);
}

export function format(minor, cur, { sign = false } = {}) {
  const c = CURRENCIES[cur];
  const abs = Math.abs(minor) / factor(cur);
  const s = abs.toLocaleString(c.locale, {
    minimumFractionDigits: c.decimals,
    maximumFractionDigits: c.decimals,
  });
  const prefix = minor < 0 ? '−' : sign && minor > 0 ? '+' : '';
  return `${prefix}${c.symbol}${s}`;
}

// Plain number for prefilling inputs: 1234 USD -> "12.34".
export function toInputString(minor, cur) {
  return toMajor(minor, cur).toFixed(CURRENCIES[cur].decimals);
}

export function convertMinor(minor, from, to, rates) {
  if (from === to) return minor;
  const major = toMajor(minor, from) / rates[from] * rates[to];
  return major * factor(to); // float; caller rounds
}

// Split `amount` (minor units) evenly across ids; leftover units go to the
// first ids so the parts always sum to the total.
export function splitEvenly(amount, ids) {
  const n = ids.length;
  if (!n) return {};
  const base = Math.trunc(amount / n);
  let rem = amount - base * n;
  const out = {};
  for (const id of ids) {
    out[id] = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
  }
  return out;
}

// What each participant owes for one expense, in the expense's own currency.
export function shares(expense) {
  const { split } = expense;
  if (split.mode === 'exact') {
    return Object.fromEntries(
      Object.entries(split.amounts || {}).filter(([, v]) => v),
    );
  }
  return splitEvenly(expense.amount, split.participants || []);
}

// Net balance per person in `settleCur` minor units (integers summing to 0).
// Positive = they are owed money; negative = they owe.
export function balances(expenses, peopleIds, settleCur, rates) {
  const raw = Object.fromEntries(peopleIds.map((id) => [id, 0]));
  const paid = { ...raw };
  const owed = { ...raw };
  for (const e of expenses) {
    const conv = (m) => convertMinor(m, e.currency, settleCur, rates);
    if (e.paidBy in raw) {
      raw[e.paidBy] += conv(e.amount);
      if (e.kind !== 'payment') paid[e.paidBy] += conv(e.amount);
    }
    for (const [id, m] of Object.entries(shares(e))) {
      if (!(id in raw)) continue;
      raw[id] -= conv(m);
      if (e.kind !== 'payment') owed[id] += conv(m);
    }
  }
  return {
    net: roundToZeroSum(raw),
    paid: mapValues(paid, Math.round),
    owed: mapValues(owed, Math.round),
  };
}

function mapValues(obj, fn) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
}

// Round floats to integers, then push any rounding drift onto the largest
// balance so the result still sums to exactly zero.
function roundToZeroSum(floats) {
  const out = mapValues(floats, Math.round);
  const drift = Object.values(out).reduce((a, b) => a + b, 0);
  if (drift) {
    const [biggest] = Object.keys(out).sort(
      (a, b) => Math.abs(out[b]) - Math.abs(out[a]),
    );
    out[biggest] -= drift;
  }
  return out;
}

// Fewest transfers that zero out `net` ({id: integer}, summing to 0).
//
// With n people who aren't settled, n-1 transfers always suffices. Every
// subgroup whose balances already sum to zero can settle among itself, saving
// one transfer. So the minimum is n - (max number of disjoint zero-sum
// groups). Finding that is a subset DP, exact up to ~18 people; beyond that we
// fall back to plain greedy, which is usually optimal or close.
export function settleUp(net) {
  const people = Object.entries(net).filter(([, v]) => v !== 0);
  const n = people.length;
  if (n === 0) return [];
  if (n > 18) return greedy(people);

  const vals = people.map(([, v]) => v);
  const full = (1 << n) - 1;
  const sum = new Array(full + 1).fill(0);
  const dp = new Array(full + 1).fill(0);
  const from = new Array(full + 1).fill(-1);
  for (let mask = 1; mask <= full; mask++) {
    const low = mask & -mask;
    sum[mask] = sum[mask ^ low] + vals[31 - Math.clz32(low)];
    let best = -1;
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      if (dp[mask ^ (1 << i)] > best) {
        best = dp[mask ^ (1 << i)];
        from[mask] = i;
      }
    }
    dp[mask] = best + (sum[mask] === 0 ? 1 : 0);
  }

  // Walk back from the full set. Each time the remaining set sums to zero,
  // the people peeled off since the last such point form one closed group.
  const groups = [];
  let mask = full;
  let group = [];
  while (mask) {
    const i = from[mask];
    group.push(people[i]);
    mask ^= 1 << i;
    if (sum[mask] === 0) {
      groups.push(group);
      group = [];
    }
  }
  return groups.flatMap(greedy);
}

// Largest debtor pays largest creditor until everyone is square. Within a
// zero-sum group of k people this takes at most k-1 transfers.
function greedy(entries) {
  const debtors = entries.filter(([, v]) => v < 0).map(([id, v]) => ({ id, v: -v }));
  const creditors = entries.filter(([, v]) => v > 0).map(([id, v]) => ({ id, v }));
  const out = [];
  while (debtors.length && creditors.length) {
    debtors.sort((a, b) => b.v - a.v);
    creditors.sort((a, b) => b.v - a.v);
    const d = debtors[0];
    const c = creditors[0];
    const amt = Math.min(d.v, c.v);
    out.push({ from: d.id, to: c.id, amount: amt });
    d.v -= amt;
    c.v -= amt;
    if (!d.v) debtors.shift();
    if (!c.v) creditors.shift();
  }
  return out;
}

// The kinds a Budget line can be, in statement order. The server builds the
// subtotals from these (net income = income + tax; discretionary income takes
// off the committed yearly costs; normal month takes off the living costs; net
// result the one-offs); `excluded` is shown but never summed.
export const KINDS = [
  { id: 'income', label: 'Income', hint: 'Salary, invoices, anything that comes in.' },
  { id: 'tax', label: 'Taxes & social', hint: 'What the state takes: income tax, social security, VAT.' },
  { id: 'committed', label: 'Committed yearly costs', hint: 'Big costs you know are coming every year: school fees, building administration, flights home.' },
  { id: 'fixed', label: 'Fixed costs', hint: 'Every month, about the same: rent, utilities, subscriptions.' },
  { id: 'periodic', label: 'Periodic costs', hint: 'Expected, but not monthly: school terms, insurance, car service, holidays.' },
  { id: 'variable', label: 'Variable costs', hint: 'Every month, never the same: groceries, eating out, shopping.' },
  { id: 'extraordinary', label: 'Extraordinary', hint: 'Out of the normal month: renovations, a car, a one-off bill.' },
  { id: 'excluded', label: 'Excluded', hint: 'Not income or spending: transfers between your own accounts.' },
];

export const KIND_LABEL = Object.fromEntries([...KINDS.map((k) => [k.id, k.label]), ['unassigned', 'Unassigned']]);

// How a row reached its line, as the drill-down says it.
export const VIA_LABEL = {
  pin: 'pinned',
  hashtag: 'hashtag',
  subcategory: 'subcategory',
  category: 'category',
  hidden: 'hidden category',
  unmapped: 'category not on a line',
  uncategorized: 'uncategorized',
};

const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

// Statement cells are whole units: a P&L of averages reads badly in cents.
export function amount(cents) {
  return whole.format(Math.round(cents / 100) || 0); // `|| 0`: never "-0"
}

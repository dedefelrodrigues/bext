// Best-effort guessing of a CSV template's columns from detected headers and a
// few sample rows. Matches common English / Portuguese / Polish header terms so
// the user starts from a sensible mapping instead of a blank form. Everything is
// a suggestion the user can override.

// Lowercase + strip diacritics (incl. Polish ł) so "Szczegóły"/"Descrição" match.
function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

const includesAny = (h, terms) => terms.some((t) => h.includes(t));

// Terms that mark the account-currency (canonical) side vs. the operation
// (foreign) side of a two-amount export like Alior.
const ACCOUNT_HINTS = ['rachunku', 'account', 'conta'];
const FOREIGN_HINTS = ['operacji', 'operation', 'operacao', 'transakcji waluta'];

const DATE_TERMS = ['date', 'data', 'fecha'];
const DATE_PREFER = ['transakcji', 'transaction', 'transacao', 'started', 'lancamento'];
const DATE_DEMOTE = ['ksiegowania', 'posting', 'booking', 'completed', 'valuta', 'value date'];

const AMOUNT_TERMS = ['amount', 'kwota', 'valor', 'value', 'montante', 'importe', 'quantia', 'wartosc'];
const FEE_TERMS = ['fee', 'prowizja', 'taxa', 'oplata', 'comissao', 'commission'];
const CURRENCY_TERMS = ['currency', 'waluta', 'moeda', 'divisa'];
const DESC_TERMS = [
  'description', 'descricao', 'descripcion', 'opis', 'szczegoly', 'details', 'detalhes', 'detalle',
  'memo', 'historico', 'narrative', 'narrativa', 'payee', 'favorecido', 'beneficiario', 'odbiorcy',
  'merchant', 'concept', 'concepto', 'title', 'tytul', 'reference', 'referencia', 'note', 'tresc',
];
// Never treat an account number / IBAN / balance column as a description, even
// when it shares a word with a description term (e.g. "Numer rachunku odbiorcy").
const DESC_EXCLUDE = ['numer', 'number', 'iban', 'rachunku', 'account', 'saldo', 'balance'];

// Pick the best single header for a role, scored by term match then hints.
function pickScored(headers, terms, { prefer = [], demote = [], require = null } = {}) {
  let best = null;
  let bestScore = -Infinity;
  for (const h of headers) {
    const n = norm(h);
    if (!includesAny(n, terms)) continue;
    if (require && !includesAny(n, require)) continue;
    let score = 0;
    if (includesAny(n, prefer)) score += 2;
    if (includesAny(n, demote)) score -= 2;
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return best;
}

export function guessTemplate(headers = [], sampleRows = []) {
  const out = {
    dateColumn: '',
    dateFormat: '',
    descriptionColumns: [],
    amountColumns: [],
    currencyColumn: '',
    foreignAmountColumn: '',
    foreignCurrencyColumn: '',
  };
  if (!headers.length) return out;

  // Date column — prefer the transaction date over posting/completed.
  out.dateColumn = pickScored(headers, DATE_TERMS, { prefer: DATE_PREFER, demote: DATE_DEMOTE }) ?? '';
  if (out.dateColumn) out.dateFormat = guessDateFormat(sampleRows.map((r) => r[out.dateColumn]));

  // Amount columns — account-currency amount is canonical; a fee column is summed
  // in; a distinct operation-currency amount becomes foreign metadata.
  const amountCandidates = headers.filter((h) => includesAny(norm(h), AMOUNT_TERMS));
  const primaryAmount = pickScored(headers, AMOUNT_TERMS, { prefer: ACCOUNT_HINTS, demote: FOREIGN_HINTS });
  if (primaryAmount) {
    out.amountColumns = [primaryAmount];
    const fee = headers.find((h) => includesAny(norm(h), FEE_TERMS));
    if (fee && fee !== primaryAmount) out.amountColumns.push(fee);
    const foreignAmount = amountCandidates.find((h) => h !== primaryAmount && includesAny(norm(h), FOREIGN_HINTS));
    if (foreignAmount) out.foreignAmountColumn = foreignAmount;
  }

  // Currency — account currency is canonical; the operation currency is foreign.
  const currencyCandidates = headers.filter((h) => includesAny(norm(h), CURRENCY_TERMS));
  const primaryCurrency = pickScored(headers, CURRENCY_TERMS, { prefer: ACCOUNT_HINTS, demote: FOREIGN_HINTS });
  if (primaryCurrency) {
    out.currencyColumn = primaryCurrency;
    const foreignCurrency = currencyCandidates.find((h) => h !== primaryCurrency && includesAny(norm(h), FOREIGN_HINTS));
    if (foreignCurrency) out.foreignCurrencyColumn = foreignCurrency;
  }

  // Description — every column matching a description term, in header order,
  // excluding the columns already claimed for date/amount/currency.
  const claimed = new Set(
    [out.dateColumn, out.currencyColumn, out.foreignAmountColumn, out.foreignCurrencyColumn, ...out.amountColumns].filter(Boolean),
  );
  out.descriptionColumns = headers.filter(
    (h) => !claimed.has(h) && includesAny(norm(h), DESC_TERMS) && !includesAny(norm(h), DESC_EXCLUDE),
  );

  return out;
}

// Infer a date format string from sample values (first non-empty wins).
export function guessDateFormat(values = []) {
  const v = values.map((x) => String(x ?? '').trim()).find((x) => x !== '');
  if (!v) return '';
  const hasTime = /\d{1,2}:\d{2}/.test(v);
  const patterns = [
    [/^\d{4}-\d{2}-\d{2}/, 'YYYY-MM-DD'],
    [/^\d{4}\/\d{2}\/\d{2}/, 'YYYY/MM/DD'],
    [/^\d{2}-\d{2}-\d{4}/, 'DD-MM-YYYY'],
    [/^\d{2}\/\d{2}\/\d{4}/, 'DD/MM/YYYY'],
    [/^\d{2}\.\d{2}\.\d{4}/, 'DD.MM.YYYY'],
  ];
  for (const [re, fmt] of patterns) {
    if (re.test(v)) return hasTime && fmt.startsWith('YYYY') ? `${fmt} HH:mm:ss` : fmt;
  }
  return '';
}

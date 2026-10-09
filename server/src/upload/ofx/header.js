import iconv from 'iconv-lite';

// OFX comes in two dialects and both announce their own encoding:
//
//   OFX 1.x — a plain-text preamble of `KEY:VALUE` lines before `<OFX>`, e.g.
//             `ENCODING:USASCII` + `CHARSET:1252`.
//   OFX 2.x — real XML, so an `<?xml … encoding="…"?>` declaration.
//
// Both preambles are pure ASCII, so we can sniff them from a latin1 read of the
// first bytes and only then decode the whole buffer for real.

const SNIFF_BYTES = 2048;

// CHARSET values seen in the wild, mapped to iconv-lite names.
function charsetToEncoding(charset, encoding) {
  const cs = String(charset ?? '').trim().toUpperCase();
  const enc = String(encoding ?? '').trim().toUpperCase();
  if (enc === 'UTF-8' || enc === 'UTF8') return 'utf8';
  if (cs === '1252' || cs === 'WINDOWS-1252' || cs === 'CP1252') return 'windows-1252';
  if (cs === '8859-1' || cs === 'ISO-8859-1' || cs === 'LATIN1') return 'iso-8859-1';
  if (cs === '8859-2' || cs === 'ISO-8859-2') return 'iso-8859-2';
  if (cs === 'UTF-8' || cs === 'UTF8') return 'utf8';
  // CHARSET:NONE (and anything unknown) with a non-UTF-8 ENCODING: windows-1252
  // is a superset of US-ASCII, so it decodes ASCII files unchanged while still
  // rescuing the stray accented byte banks emit despite declaring USASCII.
  return 'windows-1252';
}

// Read the declared encoding without committing to a decode yet.
export function sniffEncoding(buffer) {
  const head = buffer.subarray(0, SNIFF_BYTES).toString('latin1');

  const xml = head.match(/<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i);
  if (xml) return /^utf-?8$/i.test(xml[1]) ? 'utf8' : xml[1].toLowerCase();
  if (/<\?xml/i.test(head)) return 'utf8'; // XML defaults to UTF-8

  const charset = head.match(/^\s*CHARSET\s*:\s*(\S+)/im)?.[1];
  const encoding = head.match(/^\s*ENCODING\s*:\s*(\S+)/im)?.[1];
  if (charset || encoding) return charsetToEncoding(charset, encoding);
  return 'utf8';
}

// Decode an OFX buffer to text using its own declared encoding, dropping the
// preamble so only the markup (from `<OFX>` / `<?xml`) is returned.
export function decodeOfx(buffer) {
  const encoding = sniffEncoding(buffer);
  let text;
  try {
    text = encoding === 'utf8' ? buffer.toString('utf8') : iconv.decode(buffer, encoding);
  } catch {
    text = buffer.toString('utf8');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
  const start = text.search(/<(\?xml|OFX\b)/i);
  return { text: start > 0 ? text.slice(start) : text, encoding };
}

// Is this buffer an OFX/QFX file? Content-based (a `.qfx`, `.ofx` or mislabeled
// `.txt` all work), and deliberately cheap: the CSV path stays the default.
export function looksLikeOfx(buffer) {
  const head = buffer.subarray(0, SNIFF_BYTES).toString('latin1');
  if (/^\s*OFXHEADER\s*:/im.test(head)) return true;
  if (/<OFX>/i.test(head)) return true;
  return false;
}

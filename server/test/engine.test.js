import { describe, expect, test } from 'vitest';
import { classify, classifyDescription, levenshtein, prepareKeywords, tokenize } from '../src/engine/classify.js';

// Convenience: prepare then classify a single description.
function match(description, keywords, globalDistance) {
  return classifyDescription(description, prepareKeywords(keywords, globalDistance));
}

describe('tokenize', () => {
  test('lowercases, strips diacritics, and splits on non-alphanumerics + letter/digit boundaries', () => {
    expect(tokenize('Żabka  Płatność, ŁÓDŹ')).toEqual(['zabka', 'platnosc', 'lodz']);
    expect(tokenize('Café Restauração — Ação')).toEqual(['cafe', 'restauracao', 'acao']);
    expect(tokenize('BILET 24H #A1')).toEqual(['bilet', '24', 'h', 'a', '1']);
    // Merchant glued to a date splits so the name is its own token.
    expect(tokenize('PIX TRANSF BEATRIZ11/05')).toEqual(['pix', 'transf', 'beatriz', '11', '05']);
    expect(tokenize('')).toEqual([]);
  });
});

describe('levenshtein', () => {
  test('basic distances', () => {
    expect(levenshtein('zabka', 'zabka')).toBe(0);
    expect(levenshtein('zabka', 'zapka')).toBe(1);
    expect(levenshtein('zabka', 'zapkax')).toBe(2);
  });
  test('honors the early-exit budget', () => {
    expect(levenshtein('abcdef', 'uvwxyz', 1)).toBeGreaterThan(1);
  });
});

describe('fuzzy matching', () => {
  test('żabka ≈ zapka at distance 1 (diacritics folded first)', () => {
    const kws = [{ id: 1, categoryId: 10, subcategoryId: 2, text: 'żabka' }];
    expect(match('platnosc zapka centrum', kws, 1)?.id).toBe(1);
    expect(match('platnosc zapka centrum', kws, 0)).toBeNull(); // exact only
  });

  test('a keyword matches a name glued to a trailing number (BEATRIZ11/05)', () => {
    const kws = [{ id: 1, categoryId: 10, subcategoryId: null, text: 'beatriz' }];
    expect(match('PIX TRANSF BEATRIZ11/05', kws, 0)?.id).toBe(1);
  });

  test('substring containment catches a name run into other text (SUPERMERCADO)', () => {
    const kws = [{ id: 1, categoryId: 10, subcategoryId: null, text: 'mercado' }];
    // "supermercado" is one token, so the token path misses it; substring matches.
    expect(match('COMPRA SUPERMERCADO LTDA', kws, 0)?.id).toBe(1);
    expect(match('AMAZONPRIME SUBSCRIPTION', [{ id: 2, categoryId: 1, subcategoryId: null, text: 'amazon' }], 0)?.id).toBe(2);
  });

  test('substring matching is gated to keywords ≥5 chars (no short-string noise)', () => {
    // "car" must not match inside "oscar"; "ikea" (4 chars) not inside "bikeall".
    expect(match('OSCAR WILDE', [{ id: 1, categoryId: 1, subcategoryId: null, text: 'car' }], 0)).toBeNull();
    expect(match('BIKEALL STORE', [{ id: 2, categoryId: 1, subcategoryId: null, text: 'ikea' }], 0)).toBeNull();
    // But a ≥5-char substring is fine.
    expect(match('CARREFOURCITY', [{ id: 3, categoryId: 1, subcategoryId: null, text: 'carrefour' }], 0)?.id).toBe(3);
  });

  test('the <5-char guard forces exact match (zus ≉ bus)', () => {
    const kws = [{ id: 1, categoryId: 10, subcategoryId: null, text: 'zus' }];
    // Even with a generous distance, a 3-char keyword must match exactly.
    expect(match('oplata bus miejski', kws, 2)).toBeNull();
    expect(match('przelew zus skladka', kws, 2)?.id).toBe(1);
  });

  test('per-keyword distance override beats the global setting', () => {
    const kws = [{ id: 1, categoryId: 10, subcategoryId: null, text: 'carrefour', distance: 2 }];
    // "carefour" is distance 1; "carfour" is distance 2 — allowed by override even though global is 0.
    expect(match('zakupy carfour', kws, 0)?.id).toBe(1);
  });
});

describe('multi-token keywords', () => {
  test('an N-token keyword matches an N-token window anywhere', () => {
    const kws = [{ id: 1, categoryId: 10, subcategoryId: null, text: 'orlen stacja' }];
    expect(match('platnosc orlen stacja paliwo', kws, 0)?.id).toBe(1);
    expect(match('orlen sklep', kws, 0)).toBeNull();
  });
});

describe('conflict resolution', () => {
  const kws = [
    { id: 5, categoryId: 1, subcategoryId: null, text: 'zabka' },
    { id: 6, categoryId: 2, subcategoryId: null, text: 'zabka sklep' },
  ];
  test('the longest matching keyword wins', () => {
    expect(match('zabka sklep centrum', kws, 0)?.id).toBe(6);
    expect(match('zabka centrum', kws, 0)?.id).toBe(5);
  });

  test('ties break to the lowest keyword id', () => {
    const tie = [
      { id: 9, categoryId: 1, subcategoryId: null, text: 'orlen' },
      { id: 3, categoryId: 2, subcategoryId: null, text: 'orlen' }, // same length, distance 1
    ];
    expect(match('platnosc orlen', tie, 1)?.id).toBe(3);
  });
});

describe('determinism', () => {
  test('classifying the same input twice yields identical assignments', () => {
    const kws = [
      { id: 1, categoryId: 10, subcategoryId: 2, text: 'zabka' },
      { id: 2, categoryId: 11, subcategoryId: null, text: 'orlen stacja' },
      { id: 3, categoryId: 12, subcategoryId: null, text: 'zus' },
    ];
    const txns = [
      { id: 100, description: 'platnosc zabka warszawa' },
      { id: 101, description: 'orlen stacja paliwo' },
      { id: 102, description: 'przelew zus' },
      { id: 103, description: 'nieznany sklep' },
    ];
    const a = classify(txns, kws, 1);
    const b = classify(txns, kws, 1);
    expect([...a].map(([id, k]) => [id, k?.id ?? null])).toEqual([...b].map(([id, k]) => [id, k?.id ?? null]));
    expect(a.get(103)).toBeNull();
    expect(a.get(100).categoryId).toBe(10);
  });
});

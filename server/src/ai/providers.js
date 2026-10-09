import Anthropic from '@anthropic-ai/sdk';

// The AI engines the categorizer can run on.
//
// Every adapter answers the same question — "given this merchant description and
// this category list, which keyword and category?" — and returns the same shape:
// `{ text, sources }`, where `text` is the model's raw answer (JSON, per the
// prompt) and `sources` are whatever web pages it cited.
//
// Two deliberate uniformities across the four providers:
//
//   - **JSON comes from the prompt, not from a provider's schema mode.** Each
//     provider constrains JSON differently, and two of them (Claude, Gemini)
//     have their own rules about combining a schema with the server-side web
//     search tool. One prompt contract plus one tolerant parser (`parse.js`)
//     behaves the same everywhere and never 400s on a feature interaction.
//   - **A provider declares whether it can search the web** (`supportsWebSearch`).
//     DeepSeek's API has no search tool, so the switch is disabled for it and
//     its proposals are logged as ungrounded rather than silently downgraded.
//
// `engineKey` — `${provider}:${model}` — is the identity a proposal is logged
// under, so "free Gemini" and "paid Gemini" are genuinely different engines even
// when they name the same model.

const TIMEOUT_MS = 180_000; // a web-searching turn is slow; a hung one is worse

async function postJson(url, { headers, body, signal }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* a proxy or an outage can answer with HTML — the raw text is the better error */
  }
  if (!res.ok) {
    const message = data?.error?.message ?? data?.error ?? data?.message ?? text.slice(0, 300);
    throw new Error(`${res.status} ${message || res.statusText}`);
  }
  return data;
}

// --- Anthropic --------------------------------------------------------------

async function completeAnthropic({ apiKey, model, webSearch, system, user }) {
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS });
  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    // Classification of one merchant is not hard work; low effort keeps a run
    // of 25 merchants cheap without costing accuracy on the answer shape.
    output_config: { effort: 'low' },
    system,
    messages: [{ role: 'user', content: user }],
    ...(webSearch ? { tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }] } : {}),
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('The model declined to answer for this merchant.');
  }

  const parts = [];
  const sources = [];
  for (const block of response.content) {
    if (block.type === 'text') parts.push(block.text);
    // A web search *error* comes back as HTTP 200 with an object (not a list)
    // in `content` — the search failing is not the request failing, so the
    // answer still counts, just ungrounded.
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const result of block.content) {
        if (result?.url) sources.push({ title: result.title ?? result.url, url: result.url });
      }
    }
  }
  return { text: parts.join('\n'), sources };
}

// --- OpenAI -----------------------------------------------------------------

async function completeOpenai({ apiKey, model, webSearch, system, user }) {
  const data = await postJson('https://api.openai.com/v1/responses', {
    headers: { authorization: `Bearer ${apiKey}` },
    body: {
      model,
      input: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      ...(webSearch ? { tools: [{ type: 'web_search' }] } : {}),
    },
  });

  const parts = [];
  const sources = [];
  for (const item of data?.output ?? []) {
    for (const block of item?.content ?? []) {
      if (typeof block?.text === 'string') parts.push(block.text);
      for (const note of block?.annotations ?? []) {
        if (note?.url) sources.push({ title: note.title ?? note.url, url: note.url });
      }
    }
  }
  return { text: parts.join('\n') || (data?.output_text ?? ''), sources };
}

// --- Google Gemini ----------------------------------------------------------

async function completeGemini({ apiKey, model, webSearch, system, user }) {
  const data = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      headers: { 'x-goog-api-key': apiKey },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        ...(webSearch ? { tools: [{ google_search: {} }] } : {}),
      },
    },
  );

  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((p) => p?.text ?? '')
    .join('')
    .trim();
  const sources = (candidate?.groundingMetadata?.groundingChunks ?? [])
    .map((chunk) => chunk?.web)
    .filter((web) => web?.uri)
    .map((web) => ({ title: web.title ?? web.uri, url: web.uri }));
  return { text, sources };
}

// --- DeepSeek ---------------------------------------------------------------

async function completeDeepseek({ apiKey, model, system, user }) {
  const data = await postJson('https://api.deepseek.com/chat/completions', {
    headers: { authorization: `Bearer ${apiKey}` },
    body: {
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
  });
  return { text: data?.choices?.[0]?.message?.content ?? '', sources: [] };
}

// --- Registry ---------------------------------------------------------------
//
// A plain object rather than a frozen map on purpose: the tests replace a
// provider's `complete` with a stub, which is the only way to exercise the
// runner, the proposal log and the accept paths without spending money on every
// `npm test`.

export const PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    keySource: 'user',
    keyLabel: 'Anthropic API key',
    keyPlaceholder: 'sk-ant-…',
    defaultModel: 'claude-opus-5',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    supportsWebSearch: true,
    complete: completeAnthropic,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    keySource: 'user',
    keyLabel: 'OpenAI API key',
    keyPlaceholder: 'sk-…',
    defaultModel: 'gpt-5',
    models: ['gpt-5', 'gpt-5-mini'],
    supportsWebSearch: true,
    complete: completeOpenai,
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini (your key)',
    keySource: 'user',
    keyLabel: 'Google AI Studio API key',
    keyPlaceholder: 'AIza…',
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    supportsWebSearch: true,
    complete: completeGemini,
  },
  'gemini-free': {
    id: 'gemini-free',
    label: 'Google Gemini (free)',
    // Supplied by the server, never by the browser and never stored per user.
    // Unset = the engine is simply not offered, which is the honest default: a
    // key committed to the repository would be a published secret.
    keySource: 'server',
    keyEnv: 'BEXT_GEMINI_FREE_KEY',
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash'],
    supportsWebSearch: true,
    complete: completeGemini,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    keySource: 'user',
    keyLabel: 'DeepSeek API key',
    keyPlaceholder: 'sk-…',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    // DeepSeek's API has no web search tool. The switch is disabled for it
    // rather than quietly ignored, so a DeepSeek re-run of a merchant another
    // engine looked up is an honest second opinion.
    supportsWebSearch: false,
    complete: completeDeepseek,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export function providerOf(id) {
  return PROVIDERS[id] ?? null;
}

// The key a provider will actually use, or null when it has none.
export function serverKeyFor(provider) {
  return provider.keySource === 'server' ? (process.env[provider.keyEnv] ?? null) : null;
}

export function engineKeyOf(provider, model) {
  return `${provider}:${model}`;
}

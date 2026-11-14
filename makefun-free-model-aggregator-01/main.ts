// free-model-aggregator-01: rating-ranked failover aggregator.
//
// Routing: every free model meeting a request's requirements is ranked by
//   score = rating_milli - PENALTY * callsMade[provider]
// (desc; ties: provider brief order, then model id asc). Attempts walk the
// ranked list; a failed call is retried on the SAME provider once, then the
// next candidate; at most 6 attempts per request; stop at the first 200.
// A provider is skipped after 2 consecutive failures unless it is the only
// candidate left. Upstream calls are strictly sequential, one at a time.
// OpenAI-client JSON requests (r07) are never sent to an anthropic-wire
// provider: that wire always echoes json_mode=false.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  authHeaders,
  buildCatalog,
  capabilitiesOf,
  isRecord,
  joinBase,
  meetsRequirements,
  modelFree,
  probeProvider,
  ratingOfModel,
  readBrief,
  type CatalogReport,
  type Json,
  type Probe,
  type ProbedModel,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicJsonFromParsed,
  anthropicModelList,
  anthropicSSEFromParsed,
  anthropicToGemini,
  anthropicToOpenAI,
  geminiPath,
  openAIError,
  openAIJsonFromParsed,
  openAISSEFromParsed,
  openAIModelList,
  openAIToAnthropicUpstream,
  openAIToGemini,
  parseAnthropicAnswer,
  parseGeminiAnswer,
  parseOpenAIAnswer,
  type ParsedAnswer,
  type ServedModel,
} from './lib/wire.ts';

const PROTOCOL_VERSION = 1;
const POLL_INTERVAL_MS = 100;
const PROBE_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Load penalty per prior call to a provider; tuned with grade-local (0/8/12/20). */
const PENALTY = 12;
/** Per-provider-call timeout, in milliseconds. */
const CALL_TIMEOUT_MS = 10000;
/** Most upstream attempts for one client request. */
const MAX_ATTEMPTS = 6;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';

const brief = readBrief(PROMPT_FILE);
let probes: Probe[] = [];
let catalog: CatalogReport = { providers: [] };
/** How many client API requests have arrived: the manifest is in arrival order. */
let manifestIndex = 0;
/** Every upstream attempt naming a valid free model, per provider. */
const callsMade = new Map<string, number>();
/** Consecutive upstream failures per provider (a success resets it). */
const consecutiveFailures = new Map<string, number>();

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

async function load(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  probes = await Promise.all(brief.directory.providers.map((provider) => probeProvider(ENV_URL, provider, PROBE_TIMEOUT_MS)));
  for (const probe of probes) if (!probe.ok && probe.error !== null) log(probe.error);
  catalog = buildCatalog(ENV_URL, probes, brief.ratings);
}

const byId = (a: ProbedModel, b: ProbedModel): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The free models served, deduplicated by id across providers (brief order kept). */
function servedModels(): ServedModel[] {
  const out: ServedModel[] = [];
  const seen = new Set<string>();
  for (const probe of probes) {
    if (!probe.ok) continue;
    for (const model of [...probe.models].sort(byId)) {
      const row = ratingOfModel(brief.ratings, probe.provider.id, model.id);
      if (!modelFree(model, row)) continue;
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      out.push({ id: model.id, provider: probe.provider.id, display_name: model.display_name });
    }
  }
  return out;
}

interface Candidate {
  probe: Probe;
  providerOrder: number;
  model: ProbedModel;
  rating: number;
}

/**
 * All free models meeting the requirements, ranked by rating minus the load
 * penalty. An OpenAI client asking for JSON mode excludes anthropic-wire
 * providers (their echo always says json_mode=false).
 */
function rankCandidates(requires: Requirement, clientApi: 'openai' | 'anthropic', body: Json): Candidate[] {
  const jsonOpenAI = clientApi === 'openai' && isRecord(body.response_format) && (body.response_format.type === 'json_object' || body.response_format.type === 'json_schema');
  const out: Candidate[] = [];
  probes.forEach((probe, providerOrder) => {
    if (!probe.ok) return;
    if (jsonOpenAI && probe.provider.wire === 'anthropic') return;
    for (const model of [...probe.models].sort(byId)) {
      const row = ratingOfModel(brief.ratings, probe.provider.id, model.id);
      if (!modelFree(model, row)) continue;
      if (row === null) continue;
      if (!meetsRequirements(requires, capabilitiesOf(model, row))) continue;
      out.push({ probe, providerOrder, model, rating: row.rating_milli });
    }
  });
  out.sort((a, b) => {
    const scoreA = a.rating - PENALTY * (callsMade.get(a.probe.provider.id) ?? 0);
    const scoreB = b.rating - PENALTY * (callsMade.get(b.probe.provider.id) ?? 0);
    if (scoreB !== scoreA) return scoreB - scoreA;
    if (a.providerOrder !== b.providerOrder) return a.providerOrder - b.providerOrder;
    return a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0;
  });
  return out;
}

/** The requirements of the request now arriving: the manifest's row by arrival order. */
function requirementsFor(body: Json): Requirement {
  const manifest = brief.workload?.manifest ?? [];
  const entry = manifest[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  return requirementsFromBody(body);
}

/** Requirements read off a request body, when the manifest has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}

interface UpstreamResult {
  ok: boolean;
  status: number;
  parsed: ParsedAnswer | null;
  wire: 'openai' | 'anthropic' | 'gemini';
  model: string;
}

/** One upstream call for a candidate, translated to the provider's wire. */
async function callUpstream(candidate: Candidate, clientApi: 'openai' | 'anthropic', body: Json): Promise<UpstreamResult> {
  const provider = candidate.probe.provider;
  const base = joinBase(ENV_URL, provider.base);
  const stream = body.stream === true;
  let url: string;
  let upstreamBody: Json;
  const headers: Record<string, string> = { 'content-type': 'application/json', ...authHeaders(provider.auth, provider.key) };
  if (provider.wire === 'openai') {
    url = `${base}/v1/chat/completions`;
    if (clientApi === 'anthropic') {
      upstreamBody = anthropicToOpenAI(body, candidate.model.id);
    } else {
      upstreamBody = { ...body, model: candidate.model.id };
      if (stream) upstreamBody.stream_options = { include_usage: true };
    }
    if (stream) headers.accept = 'text/event-stream';
  } else if (provider.wire === 'anthropic') {
    url = `${base}/v1/messages`;
    headers['anthropic-version'] = '2023-06-01';
    if (clientApi === 'anthropic') {
      upstreamBody = { ...body, model: candidate.model.id };
    } else {
      upstreamBody = openAIToAnthropicUpstream(body, candidate.model.id);
    }
    if (stream) headers.accept = 'text/event-stream';
  } else {
    url = `${base}${geminiPath(candidate.model.id, stream)}`;
    upstreamBody = clientApi === 'anthropic' ? anthropicToGemini(body, candidate.model.id) : openAIToGemini(body, candidate.model.id);
    if (stream) headers.accept = 'text/event-stream';
  }
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(upstreamBody), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch {
    return { ok: false, status: 0, parsed: null, wire: provider.wire, model: candidate.model.id };
  }
  if (!res.ok) {
    try {
      await res.text();
    } catch {
      // The error body does not matter; the status is the signal.
    }
    return { ok: false, status: res.status, parsed: null, wire: provider.wire, model: candidate.model.id };
  }
  const raw = await res.text();
  const parsed =
    provider.wire === 'openai' ? parseOpenAIAnswer(raw, stream) : provider.wire === 'anthropic' ? parseAnthropicAnswer(raw, stream) : parseGeminiAnswer(raw, stream);
  if (parsed === null) return { ok: false, status: 502, parsed: null, wire: provider.wire, model: candidate.model.id };
  return { ok: true, status: 200, parsed, wire: provider.wire, model: candidate.model.id };
}

/**
 * Serve one client request: walk the ranked candidates, retry the same
 * provider once on failure, then the next candidate; stop at the first 200.
 */
async function serve(clientApi: 'openai' | 'anthropic', body: Json): Promise<UpstreamResult | null> {
  const requires = requirementsFor(body);
  const ranked = rankCandidates(requires, clientApi, body);
  let attempts = 0;
  let pos = 0;
  const sameRetries = new Map<string, number>();
  while (attempts < MAX_ATTEMPTS && pos < ranked.length) {
    const candidate = ranked[pos];
    const providerId = candidate.probe.provider.id;
    if ((consecutiveFailures.get(providerId) ?? 0) >= 2) {
      const hasOther = ranked.slice(pos + 1).some((c) => (consecutiveFailures.get(c.probe.provider.id) ?? 0) < 2);
      if (hasOther) {
        pos += 1;
        continue;
      }
    }
    attempts += 1;
    callsMade.set(providerId, (callsMade.get(providerId) ?? 0) + 1);
    const result = await callUpstream(candidate, clientApi, body);
    if (result.ok && result.parsed !== null) {
      consecutiveFailures.set(providerId, 0);
      return result;
    }
    consecutiveFailures.set(providerId, (consecutiveFailures.get(providerId) ?? 0) + 1);
    const key = `${providerId}/${candidate.model.id}`;
    const same = sameRetries.get(key) ?? 0;
    if (same < 1) {
      sameRetries.set(key, same + 1);
    } else {
      pos += 1;
    }
  }
  return null;
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type, null));
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by the best free model. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const result = await serve('openai', body);
  if (result === null || result.parsed === null) {
    return sendError(res, 'openai', 503, 'no_free_model', 'no free model on the directory answered this request');
  }
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.end(openAISSEFromParsed(result.parsed, result.model));
    return;
  }
  sendJson(res, 200, openAIJsonFromParsed(result.parsed, result.model));
}

/** POST /v1/messages: an Anthropic-shaped client, answered by the best free model. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const requested = typeof body.model === 'string' && body.model !== '' ? body.model : '';
  const result = await serve('anthropic', body);
  if (result === null || result.parsed === null) {
    return sendError(res, 'anthropic', 503, 'overloaded_error', 'no free model on the directory answered this request');
  }
  if (body.stream === true) {
    const inputStart = result.wire === 'gemini' ? 0 : result.parsed.input;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.end(anthropicSSEFromParsed(result.parsed, requested !== '' ? requested : result.model, inputStart));
    return;
  }
  sendJson(res, 200, anthropicJsonFromParsed(result.parsed, requested !== '' ? requested : result.model));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the workload's size. */
async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the workload holds ${reply.requests} requests`);
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  await load();
  if (process.argv.includes('--list')) {
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${catalog.providers.length} answered providers and ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}

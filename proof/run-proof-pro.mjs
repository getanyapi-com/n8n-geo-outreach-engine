#!/usr/bin/env node
// Runs the shipped PRO workflow for real, outside n8n.
//
// Same contract as run-proof.mjs, one tier up. It reads geo-outreach-prospector.workflow.json,
// pulls the jsCode straight out of every Code node, evaluates the IF conditions straight out of
// every IF node, calls the same AnyAPI endpoints with the same bodies the HTTP nodes would send,
// and calls OpenRouter with the same model id, the same system message and the same rendered
// prompt the three chainLlm nodes would send.
//
// What it does that the lite harness does not: the two google.search discovery lanes, the
// email.find contact step, and the three model steps. Those five nodes have no lite equivalent,
// so nothing about them was proven by the lite run.
//
// Three things it cannot do. Data Table nodes are skipped, because state persistence has no
// effect on any published number. Gmail draft:create is not called, because it needs an
// interactive OAuth consent; every draft that passes the gate is written to
// proof/artifacts-pro/drafts instead, exactly as the node would have sent it. And n8n's own
// LangChain plumbing is not in the loop: this sends the node's system message and rendered prompt
// to the same model over OpenRouter's REST API, and enforces the output parser's schema itself.
//
// Usage: ANYAPI_API_KEY=... OPENROUTER_API_KEY=... node proof/run-proof-pro.mjs

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const artifacts = join(here, 'artifacts-pro');
const workflow = JSON.parse(readFileSync(join(root, 'geo-outreach-prospector.workflow.json'), 'utf8'));

const API_KEY = process.env.ANYAPI_API_KEY;
if (!API_KEY) { console.error('Set ANYAPI_API_KEY'); process.exit(1); }
const OR_KEY = process.env.OPENROUTER_API_KEY;
if (!OR_KEY) { console.error('Set OPENROUTER_API_KEY'); process.exit(1); }

const FORM = JSON.parse(readFileSync(join(here, 'proof-input.json'), 'utf8'));
const RUN_ID = process.env.PROOF_RUN_ID || 'pro-1';

const nodeByName = new Map(workflow.nodes.map((n) => [n.name, n]));
const outputs = new Map();
const httpLog = [];
const modelLog = [];
const started = Date.now();

const wrap = (items) => items.map((i) => (i && i.json !== undefined ? i : { json: i }));
const concat = (...lists) => lists.flat();

function runCode(name, inputItems) {
  const node = nodeByName.get(name);
  if (!node || node.type !== 'n8n-nodes-base.code') throw new Error('not a Code node: ' + name);
  const items = wrap(inputItems);
  const $input = { all: () => items, first: () => items[0], last: () => items[items.length - 1] };
  const $ = (ref) => {
    if (!outputs.has(ref)) throw new Error("No execution data found for node '" + ref + "'");
    const stored = outputs.get(ref);
    return { all: () => stored, first: () => stored[0], last: () => stored[stored.length - 1] };
  };
  const fn = new Function('$input', '$', '$execution', node.parameters.jsCode);
  const result = wrap(fn($input, $, { id: RUN_ID }) || []);
  outputs.set(name, result);
  console.log('  ' + name + ' -> ' + result.length + ' item' + (result.length === 1 ? '' : 's'));
  return result;
}

// Evaluates the IF node's own condition expression, so the harness branches exactly where the
// workflow branches.
function runIf(name, inputItems) {
  const node = nodeByName.get(name);
  const expression = node.parameters.conditions.conditions[0].leftValue;
  const inner = expression.replace(/^=\{\{/, '').replace(/\}\}$/, '');
  const predicate = new Function('$json', 'return (' + inner + ');');
  const items = wrap(inputItems);
  const yes = items.filter((i) => predicate(i.json) === true);
  const no = items.filter((i) => predicate(i.json) !== true);
  outputs.set(name, yes);
  outputs.set(name + '::false', no);
  console.log('  ' + name + ' -> ' + yes.length + ' yes / ' + no.length + ' no');
  return [yes, no];
}

// A fetch-level failure means nothing reached the network: no status, no charge, no evidence.
// Run 16 died on one of these after burning its whole retry budget in 62 seconds against a drop
// that lasted minutes. Retrying on a timer is the wrong shape - wait for the network itself, then
// let the caller retry. Bounded so a genuinely dead link still ends the run instead of hanging.
const OFFLINE_PROBE_MS = 15000;
const OFFLINE_MAX_MS = 900000;

async function waitForNetwork(where) {
  const t0 = Date.now();
  let announced = false;
  while (Date.now() - t0 < OFFLINE_MAX_MS) {
    try {
      const res = await fetch('https://api.getanyapi.com/v1/apis/web.scrape', {
        headers: { Authorization: 'Bearer ' + API_KEY },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        if (announced) console.log('    network back after ' + Math.round((Date.now() - t0) / 1000) + 's');
        return true;
      }
    } catch (e) { /* still down */ }
    if (!announced) {
      console.log('    ' + where + ': nothing reaching the network, waiting for it to come back');
      announced = true;
    }
    await new Promise((r) => setTimeout(r, OFFLINE_PROBE_MS));
  }
  return false;
}

async function callAnyApi(nodeName, item) {
  const node = nodeByName.get(nodeName);
  const url = node.parameters.url;
  const bodyField = node.parameters.jsonBody.match(/\$json\.(\w+)/)[1];
  const body = item.json[bodyField];
  // Every header the node declares, not just the first. A durable SKU carries `Prefer: wait=N`
  // alongside the idempotency key, and dropping it means the gateway applies its 10s default,
  // answers 202, and this harness reads a 2xx with no result.
  const declared = node.parameters.headerParameters.parameters || [];
  const headers = {};
  let idem = '';
  for (const h of declared) {
    const ref = String(h.value).match(/\$json\.(\w+)/);
    const value = ref ? item.json[ref[1]] : String(h.value).replace(/^=/, '');
    if (value === undefined || value === null) continue;
    headers[h.name] = String(value);
    if (h.name.toLowerCase() === 'idempotency-key') idem = String(value);
  }
  const timeout = node.parameters.options.timeout;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const t0 = Date.now();
  let statusCode = 0;
  let parsed = {};
  // A failure is only diagnosable if the body and the server that sent it survive the run.
  let rawSnippet;
  let server;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: Object.assign({
        Authorization: 'Bearer ' + API_KEY,
        'Content-Type': 'application/json',
      }, headers),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    statusCode = res.status;
    const text = await res.text();
    if (statusCode < 200 || statusCode >= 300) {
      rawSnippet = text.slice(0, 300);
      server = res.headers.get('server') || undefined;
    }
    try { parsed = JSON.parse(text); } catch (e) { parsed = { error: { code: 'unparseable', message: text.slice(0, 200) } }; }
  } catch (e) {
    statusCode = 0;
    parsed = { error: { code: 'transport', message: String(e.message || e) } };
    rawSnippet = String(e.message || e).slice(0, 300);
  } finally {
    clearTimeout(timer);
  }

  httpLog.push({
    node: nodeName,
    url,
    at: new Date(t0).toISOString(),
    statusCode,
    ms: Date.now() - t0,
    rawSnippet,
    server,
    costUsd: statusCode >= 200 && statusCode < 300 ? Number(parsed.costUsd || 0) : 0,
    found: (parsed.output || {}).found,
    errorCode: statusCode >= 400 ? String(((parsed.error || {}).code) || statusCode) : undefined,
    replayed: parsed.replayed === true,
    idempotencyKey: idem,
  });
  return { json: { statusCode, headers: {}, body: parsed } };
}

async function runHttp(nodeName, inputItems) {
  const node = nodeByName.get(nodeName);
  // n8n retries a node only when it throws or when the FIRST output item carries an error, so
  // retryOnFail is only set on single-item nodes here. The harness mirrors exactly that.
  const maxTries = node.retryOnFail ? Math.min(5, Math.max(2, node.maxTries || 3)) : 1;
  const waitMs = node.retryOnFail ? Math.min(5000, node.waitBetweenTries || 1000) : 0;
  // n8n's own request batching: batchSize calls, then batchInterval ms of quiet before the next
  // batch. web.scrape rate limits a burst, so the shipped node carries this and the harness has to
  // honour it or the proof runs a faster workflow than the one in the file.
  const batch = (node.parameters.options || {}).batching?.batch || {};
  const batchSize = Number(batch.batchSize) > 0 ? Number(batch.batchSize) : 0;
  const batchInterval = Number(batch.batchInterval) || 0;
  const items = wrap(inputItems);

  // HttpRequestV3.node.js pushes one promise per item and settles them together at line 561, so
  // every item's request is in flight at once; batchInterval only sleeps between LAUNCH groups
  // (line 187). Awaiting each call in turn, as this harness used to, measures a workflow that
  // does not exist and inflated every wall time reported before run 18.
  const attempt = async (item) => {
    let result = await callAnyApi(nodeName, item);
    // statusCode 0 is a fetch-level failure, not an answer. n8n would surface it as a node error;
    // here it is worth waiting out, because the alternative is a run that quietly proceeds on
    // missing data and reports the gap as a provider result.
    if (result.json.statusCode === 0 && await waitForNetwork(nodeName)) {
      result = await callAnyApi(nodeName, item);
    }
    for (let tries = 1; tries < maxTries && result.json.statusCode >= 400; tries += 1) {
      await new Promise((r) => setTimeout(r, waitMs));
      result = await callAnyApi(nodeName, item);
    }
    return result;
  };

  const pending = [];
  for (const [index, item] of items.entries()) {
    if (batchSize && index > 0 && index % batchSize === 0) {
      await new Promise((r) => setTimeout(r, batchInterval));
    }
    pending.push(attempt(item));
  }
  const results = await Promise.all(pending);
  outputs.set(nodeName, results);
  const spent = httpLog.filter((h) => h.node === nodeName).reduce((s, h) => s + h.costUsd, 0);
  console.log('  ' + nodeName + ' -> ' + results.length + ' call' + (results.length === 1 ? '' : 's') + ', $' + spent.toFixed(5));
  return results;
}

// --- the three model steps ------------------------------------------------------------------

// n8n expressions are {{ ... }} holes in a template string. Scanned rather than regexed, because
// the ownership prompt interpolates an arrow function whose body contains braces.
function renderTemplate(template, json) {
  const src = String(template).replace(/^=/, '');
  let out = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{{', i);
    if (open === -1) { out += src.slice(i); break; }
    out += src.slice(i, open);
    let j = open + 2;
    let depth = 0;
    let close = -1;
    while (j < src.length) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') {
        if (depth > 0) depth -= 1;
        else if (src[j + 1] === '}') { close = j; break; }
      }
      j += 1;
    }
    if (close === -1) { out += src.slice(open); break; }
    const expr = src.slice(open + 2, close);
    const value = new Function('$json', 'return (' + expr + ');')(json);
    out += value === null || value === undefined ? '' : String(value);
    i = close + 2;
  }
  return out;
}

// The structured output parser is configured from a JSON example. This derives the same schema
// shape from that example, and every key in the example is required.
function schemaFromExample(value) {
  if (Array.isArray(value)) {
    return { type: 'array', items: schemaFromExample(value.length ? value[0] : {}) };
  }
  if (value && typeof value === 'object') {
    const properties = {};
    Object.keys(value).forEach((k) => { properties[k] = schemaFromExample(value[k]); });
    return { type: 'object', properties, required: Object.keys(value) };
  }
  if (typeof value === 'number') return { type: 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  return { type: 'string' };
}

function formatInstructions(schema) {
  return [
    'You must format your output as a JSON value that adheres to a given "JSON Schema" instance.',
    '',
    'Here is the JSON Schema instance your output must adhere to. Return the JSON object and',
    'nothing else. Every key is required.',
    '```json',
    JSON.stringify(schema),
    '```',
  ].join('\n');
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const trimmed = candidate.trim();
  try { return JSON.parse(trimmed); } catch (e) { /* fall through */ }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first === -1 || last <= first) throw new Error('no JSON object in model output');
  return JSON.parse(trimmed.slice(first, last + 1));
}

async function callOpenRouter(chainName, modelNode, system, user, schema) {
  const model = modelNode.parameters.model;
  const options = modelNode.parameters.options || {};
  const maxRetries = Number(options.maxRetries || 2);
  const timeout = Number(options.timeout || 60000);

  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const t0 = Date.now();
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + OR_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: Number(options.temperature ?? 0),
          usage: { include: true },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user + '\n\n' + formatInstructions(schema) },
          ],
        }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error('openrouter ' + res.status + ': ' + text.slice(0, 300));
      const payload = JSON.parse(text);
      const content = ((payload.choices || [])[0] || {}).message || {};
      const parsed = extractJson(String(content.content || ''));
      const usage = payload.usage || {};
      modelLog.push({
        node: chainName,
        model,
        served: payload.model,
        attempt,
        ms: Date.now() - t0,
        promptChars: user.length,
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        costUsd: Number(usage.cost || 0),
      });
      return parsed;
    } catch (e) {
      lastError = e;
      modelLog.push({
        node: chainName,
        model,
        attempt,
        ms: Date.now() - t0,
        promptChars: user.length,
        error: String(e.message || e).slice(0, 300),
        costUsd: 0,
      });
      if (attempt > maxRetries) break;
      // Exponential, because the failure that ended run 11 was a local network drop: one
      // connection terminated and then five retries failed in 12 to 34 milliseconds each, never
      // reaching the network. Linear 1-2-3-4-5s spends the whole retry budget inside a blip.
      // A sub-second failure never reached the network at all, so wait for the link rather than
      // spending attempts against it - that is what ended run 16 after 62 seconds of retries.
      if (Date.now() - t0 < 1000) await waitForNetwork(chainName);
      await new Promise((r) => setTimeout(r, Math.min(32000, 2000 * (2 ** (attempt - 1)))));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

// Runs a chainLlm node: its system message, its prompt template rendered against the input item,
// and its output parser's schema. One output item per input item, in order, which is what the
// Code node downstream indexes against.
async function runChain(chainName, modelName, parserName, inputItems) {
  const chain = nodeByName.get(chainName);
  const modelNode = nodeByName.get(modelName);
  const parserNode = nodeByName.get(parserName);
  const example = JSON.parse(parserNode.parameters.jsonSchemaExample);
  // n8n's structured parser wraps the configured shape under an "output" key, which is why every
  // Code node downstream reads $json.output.
  const schema = { type: 'object', properties: { output: schemaFromExample(example) }, required: ['output'] };
  const system = chain.parameters.messages.messageValues[0].message;

  const items = wrap(inputItems);

  // ChainLlm.node.js:59-65 runs items in concurrent groups of batchSize, settling each group
  // before starting the next, with delayBetweenBatches in between. Its own default is 5, and the
  // parallel path only engages above 1 - which is why this harness has to read the number off the
  // node rather than assume, and why the shipped nodes carry 5 rather than 1.
  const chainBatch = chain.parameters.batching || {};
  const groupSize = Number(chainBatch.batchSize) > 1 ? Number(chainBatch.batchSize) : 1;
  const groupDelay = Number(chainBatch.delayBetweenBatches) || 0;

  mkdirSync(join(artifacts, 'prompts'), { recursive: true });
  const stem = chainName.replace(/\W+/g, '-');
  const runOne = async (item, index) => {
    const user = renderTemplate(chain.parameters.text, item.json);
    // Kept so a stalled model call can be replayed exactly instead of guessed at.
    writeFileSync(
      join(artifacts, 'prompts', stem + '-' + index + '.txt'),
      '### SYSTEM\n' + system + '\n\n### USER\n' + user + '\n\n### SCHEMA\n' + JSON.stringify(schema),
    );
    const parsed = await callOpenRouter(chainName, modelNode, system, user, schema);
    const output = parsed && parsed.output !== undefined ? parsed.output : parsed;
    // Kept alongside the prompt so a verdict can be read back without re-running the model.
    writeFileSync(
      join(artifacts, 'prompts', stem + '-' + index + '.response.json'),
      JSON.stringify(output, null, 2),
    );
    return { json: { output } };
  };

  const results = [];
  for (let i = 0; i < items.length; i += groupSize) {
    const group = items.slice(i, i + groupSize);
    results.push(...await Promise.all(group.map((item, j) => runOne(item, i + j))));
    if (i + groupSize < items.length && groupDelay > 0) {
      await new Promise((r) => setTimeout(r, groupDelay));
    }
  }
  outputs.set(chainName, results);
  const spent = modelLog.filter((m) => m.node === chainName).reduce((s, m) => s + m.costUsd, 0);
  console.log('  ' + chainName + ' -> ' + results.length + ' model call' + (results.length === 1 ? '' : 's') + ', $' + spent.toFixed(6));
  return results;
}

// --- the run --------------------------------------------------------------------------------

(async () => {
  rmSync(join(artifacts, 'drafts'), { recursive: true, force: true });
  mkdirSync(join(artifacts, 'drafts'), { recursive: true });
  console.log('GEO Prospector (pro), executed from the shipped workflow JSON\n');

  console.log('Band 1 Onboard and profile');
  // Both of these are read by name out of Normalize Onboarding Input, and neither is something the
  // harness can execute: the form trigger has no submission here, and the Gmail profile lookup needs
  // the Gmail credential. So both are seeded from the same fixture the run is driven by.
  outputs.set('Start Your GEO Outreach', [{ json: FORM }]);
  outputs.set('Read Your Connected Inbox', [{ json: { emailAddress: FORM.connected_inbox } }]);
  const config = runCode('Normalize Onboarding Input', [{ json: FORM }]);
  const siteScrape = await runHttp('AnyAPI Scrape Your Website', config);
  const readSite = runCode('Verify Your Website Was Read', siteScrape);
  await runChain('Profile Your Business', 'Business Profile Model', 'Business Profile Parser', readSite);
  const profile = runCode('Confirm Your Business Profile', outputs.get('Profile Your Business'));
  console.log('  buyer prompts: ' + JSON.stringify(profile[0].json.buyer_prompts) + '\n');

  console.log('Band 2 Ask the engines');
  const calls = runCode('Build Visibility Calls', profile);
  // Read off the workflow rather than listed here, so a change to the engine set cannot leave the
  // harness measuring a shape the shipped file no longer has.
  const engineNodes = workflow.nodes
    .filter((n) => /^AnyAPI Ask /.test(n.name))
    .map((n) => n.name);
  const engineResults = [];
  for (const n of engineNodes) engineResults.push(await runHttp(n, calls));
  runCode('Verify Engine Answers', concat(...engineResults));
  console.log('');

  console.log('Band 3 Harvest, widen, and filter');
  runCode('Harvest Cited URLs', outputs.get('Verify Engine Answers'));
  const named = runCode('Name Every Brand In The Answers', outputs.get('Harvest Cited URLs'));

  // Two discovery lanes the lite tier does not have at all.
  const competitorQueries = runCode('Build Competitor Domain Queries', named);
  const competitorSearches = await runHttp('AnyAPI Resolve Competitor Domains', competitorQueries);
  const competitorLane = runCode('Verify Competitor Domains', competitorSearches);

  const serpQueries = runCode('Build SERP Discovery Queries', named);
  const serpSearches = await runHttp('AnyAPI Rank Buyer Prompts On Google', serpQueries);
  const serpLane = runCode('Read SERP Discovery Results', serpSearches);

  const merged = concat(competitorLane, serpLane);
  outputs.set('Merge Discovery Lanes', merged);
  const filtered = runCode('Drop Pages You Or Your Rivals Own', merged);
  await runChain('Judge Page Ownership', 'Ownership Model', 'Ownership Parser', filtered);
  const narrowed = runCode('Verify Ownership Decisions', outputs.get('Judge Page Ownership'));
  const ranked = runCode('Score And Rank Pitchable Pages', narrowed);

  // Who runs the site, judged from the site's own home page rather than from the article that
  // was cited. A vendor's blog post reads like editorial; its home page sells.
  const homeCalls = runCode('Build Publisher Home Scrape Calls', ranked);
  const homeScrapes = await runHttp('AnyAPI Scrape The Publisher Home', homeCalls);
  const bundles = runCode('Bundle Sites For Judgement', homeScrapes);
  await runChain('Judge Who Runs The Site', 'Publisher Model', 'Publisher Parser', bundles);
  const independent = runCode('Keep Only Independent Publishers', outputs.get('Judge Who Runs The Site'));

  const [pitchable, noPages] = runIf('Did Any Pitchable Pages Survive?', independent);
  if (pitchable.length === 0) {
    console.log('\nNo pitchable page survived the ownership filter. Stopping.');
    const record = runCode('Build Run Record', noPages);
    writeFileSync(join(artifacts, 'run-record.json'), JSON.stringify(record[0].json, null, 2));
    return;
  }
  console.log('');

  console.log('Band 4 Read the page');
  const scrapeCalls = runCode('Build Page Scrape Calls', pitchable);
  const pageScrapes = await runHttp('AnyAPI Scrape The Page', scrapeCalls);
  const firstAttempt = runCode('Verify The Page Is A Real Roundup', pageScrapes);
  const [failedPages, readPages] = runIf('Did A Page Scrape Fail?', firstAttempt);
  let rescraped = [];
  if (failedPages.length) {
    const rescrapeCalls = runCode('Build Page Rescrape Calls', failedPages);
    const rescrapes = await runHttp('AnyAPI Scrape The Page Again', rescrapeCalls);
    rescraped = runCode('Verify The Rescraped Page', rescrapes);
  }
  const scrapeAttempts = concat(rescraped, readPages);
  outputs.set('Merge Page Scrape Attempts', scrapeAttempts);
  const contacts = runCode('Extract Author And Contacts', scrapeAttempts);
  console.log('');

  console.log('Band 5 Find the human');
  const [needsContactPage, hasContactAlready] = runIf('Do We Need To Read A Contact Page?', contacts);
  let contactPathItems = [];
  if (needsContactPage.length) {
    const contactCalls = runCode('Build Contact Page Calls', needsContactPage);
    const contactScrapes = await runHttp('AnyAPI Scrape The Contact Page', contactCalls);
    contactPathItems = runCode('Extract Email From The Contact Page', contactScrapes);
  }
  const mergedContacts = concat(contactPathItems, hasContactAlready);
  outputs.set('Merge Contact Paths', mergedContacts);

  // The paid lookup ladder step, which lite does not have.
  const triaged = runCode('Decide Who Still Needs An Email', mergedContacts);
  const [needsFind, noFindNeeded] = runIf('Do We Still Need An Email?', triaged);
  let foundItems = [];
  if (needsFind.length) {
    const findCalls = runCode('Build Email Find Calls', needsFind);
    const findResults = await runHttp('AnyAPI Find The Author Email', findCalls);
    foundItems = runCode('Read The Email Find Result', findResults);
  }
  const mergedEmails = concat(foundItems, noFindNeeded);
  outputs.set('Merge Email Paths', mergedEmails);

  // The domain-editor ladder step. The name-based finder needs a byline; this one needs only the
  // publisher's domain, which is the whole point: it reaches the pages that named nobody.
  const domainTriaged = runCode('Decide Who Needs A Domain Editor', mergedEmails);
  const [needsEditor, noEditorNeeded] = runIf('Do We Need A Domain Editor?', domainTriaged);
  let editorItems = [];
  if (needsEditor.length) {
    const editorCalls = runCode('Build Domain Editor Calls', needsEditor);
    const editorResults = await runHttp('AnyAPI Find The Domain Editor', editorCalls);
    editorItems = runCode('Read The Domain Editor Result', editorResults);
  }
  const mergedEditors = concat(editorItems, noEditorNeeded);
  outputs.set('Merge Domain Editor Paths', mergedEditors);

  const cleaned = runCode('Reject Free And Off-Domain Addresses', mergedEditors);
  const [toVerify, unverifiable] = runIf('Is There An Address To Verify?', cleaned);
  let verified = [];
  if (toVerify.length) {
    const verifyCalls = runCode('Build Email Verify Calls', toVerify);
    const verifyResults = await runHttp('AnyAPI Verify The Email', verifyCalls);
    verified = runCode('Accept Only Deliverable Addresses', verifyResults);
  }
  const allProspects = concat(verified, unverifiable);
  outputs.set('Merge Verification Paths', allProspects);
  console.log('');

  console.log('Band 6 Write the pitch, then refuse to send it');
  const withContext = runCode('Build Pitch Context', allProspects);
  const [pitchThese, notPitchable] = runIf('Do We Have A Verified Contact?', withContext);
  let gated = [];
  if (pitchThese.length) {
    await runChain('Write The Pitch', 'Pitch Model', 'Pitch Parser', pitchThese);
    runCode('Compose The Pitch', outputs.get('Write The Pitch'));
    gated = runCode('Verify The Pitch Quotes The Page', outputs.get('Compose The Pitch'));
  }
  const [passed, rejected] = runIf('Did The Pitch Pass Every Gate?', gated);

  // Gmail draft:create is the next node. It is not called here; this is what it would send.
  const draftNode = nodeByName.get('Draft It In Your Gmail');
  passed.forEach((item) => {
    const p = item.json;
    const payload = {
      node: draftNode.name,
      resource: draftNode.parameters.resource,
      operation: draftNode.parameters.operation,
      to: p.contact_email,
      subject: p.subject,
      emailType: draftNode.parameters.emailType,
      message: p.body,
      quoted_snippet: p.quoted_snippet,
      quote_is_on_page: p.pitch_context.replace(/\s+/g, ' ').includes(p.quoted_snippet.replace(/\s+/g, ' ')),
      page_url: p.page_url,
    };
    writeFileSync(join(artifacts, 'drafts', p.prospect_id + '.json'), JSON.stringify(payload, null, 2));
    writeFileSync(join(artifacts, 'drafts', p.prospect_id + '.txt'), 'To: ' + p.contact_email + '\nSubject: ' + p.subject + '\n\n' + p.body + '\n');
  });
  console.log('  Draft It In Your Gmail -> not executed, ' + passed.length + ' payload(s) written to proof/artifacts-pro/drafts\n');

  console.log('Band 7 Account for the run');
  const mergedDrafts = concat(passed, rejected, notPitchable);
  outputs.set('Merge Draft Paths', mergedDrafts);
  const record = runCode('Build Run Record', mergedDrafts);
  const rows = runCode('Build Prospect Workbook Rows', record);

  const runtime = Number(((Date.now() - started) / 1000).toFixed(3));
  const measuredCost = Number(httpLog.reduce((s, h) => s + h.costUsd, 0).toFixed(6));
  const modelCost = Number(modelLog.reduce((s, m) => s + (m.costUsd || 0), 0).toFixed(6));

  writeFileSync(join(artifacts, 'run-record.json'), JSON.stringify(record[0].json, null, 2));
  writeFileSync(join(artifacts, 'http-log.json'), JSON.stringify(httpLog, null, 2));
  writeFileSync(join(artifacts, 'model-log.json'), JSON.stringify(modelLog, null, 2));
  writeFileSync(join(artifacts, 'workbook-rows.json'), JSON.stringify(rows.map((r) => r.json), null, 2));
  writeFileSync(join(artifacts, 'prospects.json'), JSON.stringify(mergedDrafts.map((i) => {
    const p = Object.assign({}, i.json);
    delete p.pitch_context;
    delete p.raw_html;
    return p;
  }), null, 2));

  const excerptAround = (text, quote) => {
    const flat = String(text || '').replace(/\s+/g, ' ');
    const needle = String(quote || '').replace(/\s+/g, ' ');
    const at = flat.indexOf(needle);
    if (at === -1) return flat.slice(0, 1200);
    return flat.slice(Math.max(0, at - 400), at + needle.length + 400);
  };
  const maskEmails = (text) => String(text || '').replace(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '[address]@$1');

  const sample = {
    run: {
      workflow: 'GEO Prospector (pro)',
      executed_by: 'proof/run-proof-pro.mjs, which runs the Code nodes out of the shipped workflow JSON and calls the chainLlm nodes\' model over OpenRouter',
      gmail_executed: false,
      run_id: RUN_ID,
      started_at: new Date(started).toISOString(),
      harness_wall_seconds: runtime,
      anyapi_calls: httpLog.length,
      anyapi_cost_usd: measuredCost,
      model_calls: modelLog.filter((m) => !m.error).length,
      model_failed_attempts: modelLog.filter((m) => m.error).length,
      model_cost_usd: modelCost,
      total_cost_usd: Number((measuredCost + modelCost).toFixed(6)),
    },
    inputs: {
      website: FORM.website,
      brand: FORM.brand,
      category: FORM.category,
      competitors: FORM.competitors.split('\n').filter(Boolean),
      spend_ceiling_usd: FORM.spend_ceiling_usd,
    },
    buyer_prompts: record[0].json.buyer_prompts,
    funnel: {
      prompts_count: record[0].json.prompts_count,
      engine_calls: record[0].json.engine_calls,
      engine_calls_empty: record[0].json.engine_calls_empty,
      engine_calls_failed: record[0].json.engine_calls_failed,
      visibility_checks: record[0].json.visibility_checks,
      visibility_mentioned: record[0].json.visibility_mentioned,
      visibility_cited: record[0].json.visibility_cited,
      citations_harvested: record[0].json.citations_harvested,
      pages_considered: record[0].json.pages_considered,
      pages_after_ownership_filter: record[0].json.pages_after_ownership_filter,
      ownership_counts: record[0].json.ownership_counts,
      publisher_verdicts: record[0].json.publisher_verdicts,
      ownership_narrowed_by_model: record[0].json.ownership_narrowed_by_model,
      pages_scraped: record[0].json.pages_scraped,
      pages_rejected_not_roundup: record[0].json.pages_rejected_not_roundup,
      pages_already_listing_you: record[0].json.pages_already_listing_you,
      contacts_from_page: record[0].json.contacts_from_page,
      contacts_from_contact_page: record[0].json.contacts_from_contact_page,
      contacts_from_email_find: record[0].json.contacts_from_email_find,
      contacts_none: record[0].json.contacts_none,
      emails_rejected: record[0].json.emails_rejected,
      emails_verified: record[0].json.emails_verified,
      drafts_passed_verify: record[0].json.drafts_passed_verify,
      drafts_rejected_verify: record[0].json.drafts_rejected_verify,
      drafts_created_in_gmail: null,
    },
    costs: {
      anyapi_usd: measuredCost,
      openrouter_usd: modelCost,
      spend_ceiling_usd: record[0].json.spend_ceiling_usd,
      by_node: httpLog.reduce((acc, h) => {
        acc[h.node] = Number(((acc[h.node] || 0) + h.costUsd).toFixed(6));
        return acc;
      }, {}),
      by_model_node: modelLog.reduce((acc, m) => {
        acc[m.node] = Number(((acc[m.node] || 0) + (m.costUsd || 0)).toFixed(6));
        return acc;
      }, {}),
    },
    drafts: passed.map((i) => ({
      page_url: i.json.page_url,
      publisher: i.json.page_domain,
      page_title: i.json.page_title,
      cited_pairs: i.json.cited_pairs,
      engines: i.json.engines,
      prompts: i.json.prompts,
      discovery_source: i.json.discovery_source,
      recipient_domain: i.json.page_domain,
      contact_source: i.json.contact_source,
      email_status: i.json.email_status,
      subject: maskEmails(i.json.subject),
      quoted_snippet: maskEmails(i.json.quoted_snippet),
      page_text_excerpt: maskEmails(excerptAround(i.json.pitch_context, i.json.quoted_snippet)),
    })),
    refusals: mergedDrafts
      .map((i) => i.json)
      .filter((p) => p.reject_reason)
      .map((p) => ({ page_url: p.page_url, publisher: p.page_domain, status: p.status, reject_reason: p.reject_reason })),
  };
  mkdirSync(join(root, 'samples'), { recursive: true });
  writeFileSync(join(root, 'samples', 'measured-output-pro.json'), JSON.stringify(sample, null, 2) + '\n');

  console.log('\nAnyAPI charged:    $' + measuredCost.toFixed(6));
  console.log('OpenRouter spent:  $' + modelCost.toFixed(6));
  console.log('Run record cost:   $' + Number(record[0].json.anyapi_cost_usd || 0).toFixed(6));
  console.log('Harness wall time: ' + runtime + 's');
})().catch((e) => {
  // A run that dies still has to leave its evidence behind, or the next question is unanswerable.
  console.error('\nRUN FAILED: ' + String(e && e.message ? e.message : e));
  try {
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, 'http-log.json'), JSON.stringify(httpLog, null, 2));
    writeFileSync(join(artifacts, 'model-log.json'), JSON.stringify(modelLog, null, 2));
    console.error('Logs written to proof/artifacts-pro. '
      + httpLog.length + ' AnyAPI calls, $' + httpLog.reduce((s, h) => s + h.costUsd, 0).toFixed(6)
      + '; ' + modelLog.length + ' model attempts.');
  } catch (writeError) {
    console.error('could not write logs: ' + String(writeError.message || writeError));
  }
  process.exitCode = 1;
});

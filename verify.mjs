#!/usr/bin/env node
// Checks the package before anyone imports it: the exports are sanitised, the graph is whole, the
// safety invariants that make this thing publishable are actually in the JSON, and every number in
// the README and PROOF.md traces back to samples/measured-output.json.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, ...p), 'utf8');
const parse = (...p) => JSON.parse(read(...p));

let failed = 0;
const fail = (m) => { console.error('FAIL: ' + m); failed += 1; };
const pass = (m) => console.log('PASS: ' + m);

const FILES = [
  'geo-outreach-prospector.workflow.json',
  'geo-outreach-prospector-lite.workflow.json',
  'geo-outreach-followup.workflow.json',
];
const workflows = FILES.map((f) => ({ file: f, wf: parse(f) }));
const sample = parse('samples', 'measured-output.json');

// ---------------------------------------------------------------- 1. sanitised exports
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /aa_live_[A-Za-z0-9]{8,}/,
  /AIza[A-Za-z0-9_-]{20,}/,
  /Bearer\s+[A-Za-z0-9._-]{16,}/i,
  /[a-z0-9-]+\.app\.n8n\.cloud/i,
  /[A-Za-z0-9._%+-]+@(gmail|googlemail|outlook|hotmail|yahoo|proton|icloud)\.[a-z.]{2,}/i,
];
let clean = true;
for (const { file, wf } of workflows) {
  const serialized = JSON.stringify(wf);
  ['"credentials"', '"pinData"', '"webhookId"'].forEach((k) => {
    if (serialized.includes(k)) { fail(file + ' still contains ' + k); clean = false; }
  });
  const hit = SECRET_PATTERNS.find((re) => re.test(serialized));
  if (hit) { fail(file + ' matches a secret pattern: ' + hit); clean = false; }
  if (wf.active !== false) { fail(file + ' is not inactive'); clean = false; }
  const tables = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.dataTable');
  if (tables.length && !tables.every((n) => JSON.stringify(n.parameters.dataTableId).includes('YOUR_DATA_TABLE_ID'))) {
    fail(file + ' has a real Data Table id'); clean = false;
  }
}
if (clean) pass('all three exports are inactive, sanitised, and use the Data Table placeholder');

// ---------------------------------------------------------------- 2. the graph is whole
let whole = true;
for (const { file, wf } of workflows) {
  const names = wf.nodes.map((n) => n.name);
  const set = new Set(names);
  if (set.size !== names.length) { fail(file + ' has duplicate node names'); whole = false; }

  const edges = [];
  for (const [from, types] of Object.entries(wf.connections)) {
    if (!set.has(from)) { fail(file + ' connects from missing node ' + from); whole = false; }
    for (const outputs of Object.values(types)) {
      for (const output of outputs) {
        for (const edge of output || []) {
          if (!set.has(edge.node)) { fail(file + ' connects to missing node ' + edge.node); whole = false; }
          edges.push([from, edge.node]);
        }
      }
    }
  }

  for (const node of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
    try { new Function(node.parameters.jsCode); } catch (e) {
      fail(file + ' / ' + node.name + ' does not parse: ' + e.message); whole = false;
    }
    const refs = [...node.parameters.jsCode.matchAll(/(?:\$|safeAll|safeFirst)\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
    for (const ref of refs) {
      if (!set.has(ref)) { fail(file + ' / ' + node.name + ' reads missing node ' + JSON.stringify(ref)); whole = false; }
    }
  }

  for (const m of JSON.stringify(wf).matchAll(/\$\(\\"([^"\\]+)\\"\)/g)) {
    if (!set.has(m[1])) { fail(file + ' expression reads missing node ' + JSON.stringify(m[1])); whole = false; }
  }

  for (const node of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.merge')) {
    const wired = new Set();
    for (const types of Object.values(wf.connections)) {
      for (const outputs of Object.values(types)) {
        for (const output of outputs) {
          for (const edge of output || []) if (edge.node === node.name) wired.add(edge.index);
        }
      }
    }
    for (let i = 0; i < node.parameters.numberInputs; i += 1) {
      if (!wired.has(i)) { fail(file + ' / ' + node.name + ' input ' + i + ' is not wired'); whole = false; }
    }
  }

  const graph = new Map(names.map((n) => [n, new Set()]));
  edges.forEach(([a, b]) => { graph.get(a).add(b); graph.get(b).add(a); });
  const functional = wf.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote');
  const start = functional.find((n) => /formTrigger|scheduleTrigger/.test(n.type));
  const seen = new Set();
  const queue = start ? [start.name] : [];
  while (queue.length) {
    const n = queue.shift();
    if (seen.has(n)) continue;
    seen.add(n);
    for (const next of graph.get(n) || []) queue.push(next);
  }
  const orphans = functional.map((n) => n.name).filter((n) => !seen.has(n));
  if (!start || orphans.length) { fail(file + ' has disconnected nodes: ' + orphans.join(', ')); whole = false; }
}
if (whole) pass('every Code node parses, every node reference resolves, every merge input is wired, nothing is orphaned');

// ---------------------------------------------------------------- 3. it never sends to a prospect
let draftsOnly = true;
for (const { file, wf } of workflows) {
  for (const node of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.gmail')) {
    const p = node.parameters;
    const isDraft = p.resource === 'draft' && p.operation === 'create';
    const isThreadRead = p.resource === 'thread' && p.operation === 'get';
    const isOperatorDigest = p.resource === 'message' && p.operation === 'send'
      && String(p.sendTo || '').includes('operator_email');
    if (!isDraft && !isThreadRead && !isOperatorDigest) {
      fail(file + ' / ' + node.name + ' is a Gmail node that could send to somebody who is not you');
      draftsOnly = false;
    }
    if (isDraft && String(p.options?.sendTo || '').indexOf('contact_email') === -1) {
      fail(file + ' / ' + node.name + ' drafts to an unexpected recipient field');
      draftsOnly = false;
    }
  }
}
if (draftsOnly) pass('no Gmail node in the package can send an email to a prospect');

// ---------------------------------------------------------------- 4. paid calls are guarded
const N8N_DEFAULT_TIMEOUT_MS = 10000;
let guarded = true;
for (const { file, wf } of workflows) {
  for (const node of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest')) {
    const p = node.parameters;
    if (!String(p.url).startsWith('https://api.getanyapi.com/v1/run/')) {
      fail(file + ' / ' + node.name + ' calls something other than AnyAPI'); guarded = false;
    }
    const header = (p.headerParameters?.parameters || []).find((h) => h.name === 'Idempotency-Key');
    if (!header) { fail(file + ' / ' + node.name + ' has no Idempotency-Key'); guarded = false; }
    else if (!/^=\{\{\s*\$json\.\w+\s*\}\}$/.test(header.value)) {
      // An inline expression is re-evaluated on retry. A data field is not.
      fail(file + ' / ' + node.name + ' computes its Idempotency-Key inline instead of reading a data field');
      guarded = false;
    }
    if (!(p.options?.timeout > N8N_DEFAULT_TIMEOUT_MS)) {
      fail(file + ' / ' + node.name + ' would use the default ' + N8N_DEFAULT_TIMEOUT_MS + 'ms timeout'); guarded = false;
    }
    const response = p.options?.response?.response || {};
    if (response.fullResponse !== true) {
      fail(file + ' / ' + node.name + ' does not read the full response'); guarded = false;
    }
    // neverError lets the workflow read a status code, but it also switches n8n's retryOnFail off,
    // because retry only fires on a thrown node or an error in the first output item. A node may
    // have one or the other. A node claiming both has a retry that will never run.
    if (response.neverError === true && node.retryOnFail === true) {
      fail(file + ' / ' + node.name + ' sets retryOnFail next to neverError, so the retry is dead');
      guarded = false;
    }
    if (response.neverError !== true && node.retryOnFail !== true) {
      fail(file + ' / ' + node.name + ' neither reads status codes nor retries'); guarded = false;
    }
  }
}
if (guarded) pass('every paid call carries an Idempotency-Key data field, a real timeout, and a readable status code');

// ---------------------------------------------------------------- 5. the measured drafts quote the page
let quoted = true;
if (!sample.drafts.length) fail('the measured run produced no draft to check');
for (const draft of sample.drafts) {
  const haystack = draft.page_text_excerpt.replace(/\s+/g, ' ');
  const needle = draft.quoted_snippet.replace(/\s+/g, ' ');
  if (!needle || haystack.indexOf(needle) === -1) {
    fail('a measured draft quotes something that is not in the recorded page text: ' + draft.page_url);
    quoted = false;
  }
  if (draft.recipient_domain !== draft.publisher) {
    fail('a measured draft is addressed off the page domain: ' + draft.page_url);
    quoted = false;
  }
}
if (quoted) pass(sample.drafts.length + ' measured draft(s) quote text that is literally in the recorded page');

// ---------------------------------------------------------------- 6. the funnel reconciles
const f = sample.funnel;
const checks = [
  [f.engine_calls === f.prompts_count * 4, 'engine calls equal prompts times four engines'],
  [f.drafts_passed_verify + f.drafts_rejected_verify <= f.emails_verified + f.emails_rejected + f.contacts_none, 'pitch outcomes cannot exceed the contacts that reached them'],
  [f.pages_after_ownership_filter <= f.pages_considered, 'pitchable pages cannot exceed pages considered'],
  [f.visibility_cited <= f.visibility_checks, 'citations of you cannot exceed visibility checks'],
  [sample.costs.anyapi_usd <= sample.costs.spend_ceiling_usd, 'measured cost is inside the submitted ceiling'],
];
let reconciled = true;
checks.forEach(([ok, label]) => { if (!ok) { fail('funnel does not reconcile: ' + label); reconciled = false; } });
if (reconciled) pass('the measured funnel reconciles');

// ---------------------------------------------------------------- 7. no unexplained number in the prose
// Everything the prose is allowed to say that is not a measured value. Each one is a published
// price, a verified platform constant, or a shape of this package.
const ALLOWED = new Map([
  [0.0045, 'published price of one brand visibility call'],
  [0.00163, 'published ceiling price of google.ai_overview'],
  [0.00126, 'published ceiling price of google.search'],
  [0.00099, 'published price of the cheaper google.search lane'],
  [0.0005, 'published price of a cheap-lane web.scrape'],
  [0.0221, 'published price of email.find'],
  [0.00084, 'published price of email.verify'],
  [0.1, 'the free credit a new AnyAPI key starts with'],
  [44, 'email.find divided by web.scrape, rounded down'],
  [100, 'requests the free credit covers, as published'],
  [71, 'upstream timeout in seconds on brand visibility'],
  [125, 'upstream timeout in seconds on the ai_overview rescue lane and email.find'],
  [10000, 'n8n httpRequest default timeout in ms'],
  [30000, 'timeout in ms on the fast SKUs'],
  [60000, 'timeout in ms on web.scrape'],
  [90000, 'timeout in ms on brand visibility'],
  [150000, 'timeout in ms on ai_overview and email.find'],
  [24, 'idempotency replay window in hours'],
  [2, 'workflows, tiers, vendor minimum for a roundup, and other small shape numbers'],
  [3, 'workflow JSONs in this repo, and engines that answer a brand visibility call'],
  [4, 'engines asked per prompt'],
  [5, 'Data Tables'],
  [12, 'checks in the Verify The Pitch gate'],
  [40, 'minimum characters in a quoted snippet'],
  [1, 'small shape number'],
  [2026, 'the year'],
  [2.2, 'Gmail node typeVersion'],
  [1.2, 'the gmailTrigger typeVersion above which SENT mail is discarded'],
  [6000, 'characters of page text the pitch step is shown'],
  [89, 'nodes in the pro prospector'],
  [66, 'nodes in the lite prospector'],
  [15, 'nodes in the follow-up drafter'],
  // Development measurements. These come from the runs that found the bugs described in the
  // README and PROOF.md, not from the published run, and PROOF.md lists them under the run that
  // produced them.
  [28, 'pages the first development run tried to scrape'],
  [19, 'of those that came back 502 in the same minute'],
  [9, 'pages that first development run kept'],
  [502, 'the status those scrapes returned'],
  [409, 'the idempotency status code'],
  [400, 'the status a bad request body returns'],
  [8, 'anonymous drafts the greeting regex wrongly rejected'],
  [7, 'drafts the earlier quote selection lost, and other small measured counts'],
  [0, 'zero'],
  [23, 'minutes, rounded down from the measured 1381.213 second wall time'],
  [33, 'pages the run-5 development run scored as pitchable'],
  [22, 'of those that the reverted mention-dominance rule wrongly rejected'],
  [108, 'the smallest cited-URL count across the six development runs'],
  [142, 'the largest cited-URL count across the six development runs'],
  [6, 'runs it took, and other small measured counts'],
  [70, 'milliseconds each of those 502s took to come back'],
  [200, 'HTTP success, and the minimum characters of site text the run requires'],
]);

const measuredNumbers = new Set();
(function collect(v) {
  if (typeof v === 'number') { measuredNumbers.add(v); return; }
  if (Array.isArray(v)) { v.forEach(collect); return; }
  if (v && typeof v === 'object') { Object.values(v).forEach(collect); }
}(sample));

const stripCodeAndLinks = (text) => text
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/`[^`]*`/g, ' ')
  .replace(/\]\([^)]*\)/g, '] ')
  .replace(/https?:\/\/\S+/g, ' ')
  // Ordered-list and numbered-heading markers are structure, not claims.
  .replace(/^\s{0,3}#{0,6}\s*\d+\.\s/gm, ' ');

let prosePasses = true;
for (const doc of ['README.md', 'PROOF.md', 'REDDIT_DRAFT.md']) {
  const raw = read(doc);
  if (/\{\{|\[TODO\]|XXX/.test(raw)) { fail(doc + ' still contains a placeholder'); prosePasses = false; }
  const text = stripCodeAndLinks(raw);
  const seen = new Set();
  for (const m of text.matchAll(/(?<![\w.])\$?(\d[\d,]*(?:\.\d+)?)(?![\w])/g)) {
    const value = Number(m[1].replace(/,/g, ''));
    if (seen.has(value)) continue;
    seen.add(value);
    if (measuredNumbers.has(value) || ALLOWED.has(value)) continue;
    fail(doc + ' states ' + m[1] + ', which is neither measured nor an explained constant');
    prosePasses = false;
  }
}
if (prosePasses) pass('every number in README.md and PROOF.md is measured or explained');

if (failed) { console.error('\n' + failed + ' check(s) failed.'); process.exit(1); }
console.log('\nVerification complete.');

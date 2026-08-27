#!/usr/bin/env node
// Checks the package before anyone imports it: the exports are sanitised, the graph is whole, the
// safety invariants that make this thing publishable are actually in the JSON, and every number in
// the README and PROOF.md traces back to samples/measured-output-pro.json.

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
  'geo-outreach-followup.workflow.json',
];
const workflows = FILES.map((f) => ({ file: f, wf: parse(f) }));
// One prospector, one measured run. The lite tier is gone: the publisher filter that keeps this
// package from emailing your competitors is a model step, so a tier without a model was a tier
// that pitched rivals.
const samples = [
  { tier: 'pro', sample: parse('samples', 'measured-output-pro.json') },
];

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

// ------------------------------------- 3b. the summary goes to the inbox that holds the drafts
// The drafts are created in whichever account the Gmail credential belongs to, so that account is
// the only place they can be read from. It used to be an unrelated address typed on the form, and on
// the first real run the two were different accounts: eleven drafts in one inbox, the email
// describing them in another. Two independent values with no mechanism making them agree will
// disagree, so the form no longer asks.
{
  let sameInbox = true;
  for (const { file, wf } of workflows) {
    const form = wf.nodes.find((n) => n.type === 'n8n-nodes-base.formTrigger');
    if (!form) continue;
    const fields = form.parameters.formFields?.values || [];
    const asks = fields.filter((f) => f.fieldType === 'email' || /email/i.test(f.fieldName || ''));
    if (asks.length) {
      fail(file + ' / the form asks for an email address: ' + asks.map((f) => f.fieldName).join(', '));
      sameInbox = false;
    }
    const normalize = wf.nodes.find((n) => n.name === 'Normalize Onboarding Input');
    if (normalize && normalize.parameters.jsCode.indexOf("$('Read Your Connected Inbox')") === -1) {
      fail(file + ' / Normalize Onboarding Input does not take the recipient from the connected inbox');
      sameInbox = false;
    }
  }
  if (sameInbox) pass('the summary is emailed to the connected Gmail account, never to a typed-in address');
}

// ------------------------------------------------- 3c. no two nodes sit on the same coordinates
// A layout-only property, and the only reader of the layout is a human opening the canvas, so
// nothing else in this file would ever notice. Measured: 'Create Prospect Workbook' was pushed at
// column 63 instead of 74 and landed exactly on top of 'Do We Have A Verified Contact?', which the
// published screenshot rendered as one unreadable smear of two node labels. The workflow ran
// correctly the whole time, which is precisely why it survived every other check here.
{
  let spread = true;
  for (const { file, wf } of workflows) {
    const seen = new Map();
    for (const node of wf.nodes) {
      if (node.type === 'n8n-nodes-base.stickyNote') continue;
      const key = node.position.join(',');
      if (seen.has(key)) {
        fail(file + ' / ' + node.name + ' sits on top of ' + seen.get(key) + ' at ' + key);
        spread = false;
      }
      seen.set(key, node.name);
    }
  }
  if (spread) pass('no two nodes are stacked on the same canvas coordinates');
}

// ---------------------------------------------------------------- 4. paid calls are guarded
const N8N_DEFAULT_TIMEOUT_MS = 10000;
let guarded = true;
for (const { file, wf } of workflows) {
  for (const node of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest')) {
    const p = node.parameters;
    // The one HTTP node in the package that is not a paid AnyAPI call: it asks Gmail which account
    // the credential belongs to, so the summary is sent to the inbox that holds the drafts instead
    // of to an address typed on a form beside it. Free, a GET, no body, so none of the paid-call
    // guards below mean anything for it. It is exempted by name and then pinned, because "the URL
    // is not an AnyAPI one" is also exactly what an unguarded call smuggled into this package would
    // look like, and a blanket skip would wave that through.
    if (node.name === 'Read Your Connected Inbox') {
      const pinned = p.url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile'
        && p.method === 'GET' && p.nodeCredentialType === 'gmailOAuth2'
        && p.authentication === 'predefinedCredentialType' && !p.sendBody
        && Number(p.options?.timeout) > 0;
      if (!pinned) { fail(file + ' / ' + node.name + ' is not the free Gmail profile read it is exempted as'); guarded = false; }
      continue;
    }
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

// ------------------------- 4c. no Code node reads $input straight out of a Data Table node
// A Data Table insert returns the ROW IT WROTE, not the item it was handed, so a Code node reading
// $input immediately downstream gets that row's columns instead of its own input. The first real
// n8n run died on it: "Missing required field: Your website URL", because the form submission had
// been replaced by a geo_runs row three nodes earlier.
//
// The proof harness cannot see this - it skips Data Table nodes, so $input still carries the
// original item and every one of these reads looks correct. That is exactly why it is checked here
// against the graph rather than by running.
{
  let reads = true;
  for (const file of FILES) {
    const wf = parse('.', file);
    const type = new Map(wf.nodes.map((n) => [n.name, n.type]));
    const jsCode = new Map(wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code').map((n) => [n.name, n.parameters.jsCode]));
    const op = new Map(wf.nodes.map((n) => [n.name, n.parameters?.operation]));
    const parents = new Map();
    for (const [from, conns] of Object.entries(wf.connections)) {
      for (const output of conns.main || []) {
        for (const edge of output || []) {
          if (!parents.has(edge.node)) parents.set(edge.node, []);
          parents.get(edge.node).push(from);
        }
      }
    }
    for (const [name, code] of jsCode) {
      // Only writes are the hazard. A `get` returns the rows you asked for, which is precisely what
      // a downstream Code node wants; an insert or update returns the row it just wrote.
      const fedByWrite = (parents.get(name) || []).some(
        (p) => type.get(p) === 'n8n-nodes-base.dataTable' && op.get(p) !== 'get',
      );
      // Comments are stripped first: the note explaining this very rule contains the word it looks
      // for, and a check that flags its own documentation is a check nobody will keep.
      const live = code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
      if (fedByWrite && /\$input\b/.test(live)) {
        fail(file + ' / ' + name + ' reads $input directly after a Data Table write');
        reads = false;
      }
    }
  }
  if (reads) pass('no Code node reads $input straight out of a Data Table write');
}

// --------------------- 4d. no Code node depends on a global the n8n sandbox does not provide
// n8n Code nodes run in a task-runner sandbox, not in Node. `URL` is not defined there. Both of the
// helpers that used `new URL` caught the ReferenceError and returned '', so every hostname came out
// empty and the whole domain layer - brand, ownership, publisher, recipient - silently blanked.
// Nothing failed loudly; the run just produced nothing, and the harness could not see it because
// Node has URL as a global.
const SANDBOX_MISSING = ['URL', 'URLSearchParams', 'fetch', 'require', 'process', '__dirname'];
{
  let sandboxed = true;
  for (const file of FILES) {
    const wf = parse('.', file);
    for (const node of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
      const live = node.parameters.jsCode
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^\s*\/\/.*$/gm, ' ')
        .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, ' ');
      for (const g of SANDBOX_MISSING) {
        if (new RegExp('(?<![\\w.$])' + g + '(?![\\w$])').test(live)) {
          fail(file + ' / ' + node.name + ' uses `' + g + '`, which the n8n Code sandbox does not define');
          sandboxed = false;
        }
      }
    }
  }
  if (sandboxed) pass('no Code node depends on a global the n8n Code sandbox does not define');
}

// ------------------------------------------- 4b. the run record counts every paid node, by name
// The reported spend sits next to the operator's ceiling, so a node missing from that list is money
// spent and not shown. Measured on run 5, before the fix: $0.3623 reported against $0.4624 charged,
// because pages dropped as "not a roundup" were scraped and charged but carried no surviving row.
// This check exists because the failure is silent - the arithmetic is right, the input is short.
{
  let counted = true;
  for (const file of FILES) {
    const wf = parse('.', file);
    const record = wf.nodes.find((n) => n.name === 'Build Run Record');
    if (!record) continue;
    const paid = wf.nodes.filter((n) => n.name.startsWith('AnyAPI ')).map((n) => n.name);
    const missing = paid.filter((name) => !record.parameters.jsCode.includes("'" + name + "'"));
    if (missing.length) {
      fail(file + ' / Build Run Record does not count ' + missing.join(', '));
      counted = false;
    }
  }
  if (counted) pass('the run record adds up every AnyAPI node in the workflow, so reported spend cannot undercount');
}

// ---------------------------------------------------------------- 5. the measured drafts quote the page
let quoted = true;
let draftCount = 0;
for (const { tier, sample } of samples) {
  if (!sample.drafts.length) fail('the measured ' + tier + ' run produced no draft to check');
  draftCount += sample.drafts.length;
  for (const draft of sample.drafts) {
    const haystack = draft.page_text_excerpt.replace(/\s+/g, ' ');
    const needle = draft.quoted_snippet.replace(/\s+/g, ' ');
    if (!needle || haystack.indexOf(needle) === -1) {
      fail('a measured ' + tier + ' draft quotes something that is not in the recorded page text: ' + draft.page_url);
      quoted = false;
    }
    if (draft.recipient_domain !== draft.publisher) {
      fail('a measured ' + tier + ' draft is addressed off the page domain: ' + draft.page_url);
      quoted = false;
    }
  }
}
if (quoted) pass(draftCount + ' measured draft(s) quote text that is literally in the recorded page');

// ---------------------------------------------------------------- 6. the funnel reconciles
let reconciled = true;
for (const { tier, sample } of samples) {
  const f = sample.funnel;
  const checks = [
    [f.engine_calls === f.prompts_count * 3, 'engine calls equal prompts times three engines'],
    [f.drafts_passed_verify + f.drafts_rejected_verify <= f.emails_verified + f.emails_rejected + f.contacts_none, 'pitch outcomes cannot exceed the contacts that reached them'],
    [f.pages_after_ownership_filter <= f.pages_considered, 'pitchable pages cannot exceed pages considered'],
    [f.visibility_cited <= f.visibility_checks, 'citations of you cannot exceed visibility checks'],
    [sample.costs.anyapi_usd <= sample.costs.spend_ceiling_usd, 'measured cost is inside the submitted ceiling'],
  ];
  checks.forEach(([ok, label]) => { if (!ok) { fail(tier + ' funnel does not reconcile: ' + label); reconciled = false; } });
}
if (reconciled) pass('the measured funnel reconciles');

// ------------------------------------------------- 7. the pitch gate refuses a bare foreign domain
// Executed, not grepped. The gate's own jsCode is run out of each shipped workflow against a draft
// that is clean except for naming somebody else's domain without a scheme. A model wrote exactly
// that ("AnyAPI (anyapi.com)") in the first pro run and the gate passed it, because check 4 only
// matched https?:// links.
// The fixture is shaped like what Compose The Pitch now emits: the quote is carried on the record
// as proof of reading and is not printed, the page is named by title, and the offer back is a
// verbatim line the composer placed from the form.
const gateFixture = (extraSentence, { reciprocity = '', reciprocityLine = '', vendorMentioned = 'Apify', vendorsOnPage = [] } = {}) => {
  const quote = 'Apify is the fastest way to get structured data out of a page.';
  const context = 'Roundup of scraping tools. ' + quote + ' We rank them below for teams.';
  const title = 'The best scraping tools';
  const body = 'Hi there,\n\n'
    + "I'm Kevin Wang from AnyAPI, one key and one wallet across hundreds of scraping and data APIs.\n\n"
    + 'I came across your piece "' + title + '" and thought AnyAPI could be a relevant addition for '
    + 'your readers - you already cover Apify there, and we do the same job without a subscription. '
    + extraSentence
    + (reciprocityLine ? '\n\n' + reciprocityLine : '')
    + '\n\nWould this be something you would be open to?\n\n'
    + 'Best,\nKevin Wang\nFounder @ AnyAPI\nhttps://getanyapi.com';
  return {
    json: {
      pitch: {
        subject: 'AnyAPI for your scraping tools roundup',
        body,
        quotedSnippet: quote,
        vendorMentioned,
        pageTitleShort: title,
        reciprocityLine,
      },
      pitch_context: context,
      page_url: 'https://publisher.example/best-scraping-tools',
      page_domain: 'publisher.example',
      page_title: title,
      brand_domain: 'getanyapi.com',
      contact_email: 'editor@publisher.example',
      author_first: '',
      vendors_on_page: vendorsOnPage,
      reciprocity,
    },
  };
};

let gateHolds = true;
for (const { file, wf } of workflows) {
  const node = wf.nodes.find((n) => n.name === 'Verify The Pitch Quotes The Page');
  if (!node) continue;
  const stubs = {
    'Name Every Brand In The Answers': { brands_named: ['Apify', 'Bright Data'] },
    'Confirm Your Business Profile': { aliases: ['AnyAPI'] },
  };
  const $ = (ref) => ({ first: () => ({ json: stubs[ref] }), all: () => [{ json: stubs[ref] }] });
  const run = (item) => {
    const fn = new Function('$input', '$', node.parameters.jsCode);
    return fn({ all: () => [item], first: () => item }, $)[0].json;
  };

  const clean = run(gateFixture('It fits alongside the tools you already list.'));
  if (clean.draft_ready !== true) {
    fail(file + ' / the pitch gate rejects a clean draft: ' + JSON.stringify(clean.verify_failures));
    gateHolds = false;
  }
  const stray = run(gateFixture('You can see it at anyapi.com.'));
  if (stray.draft_ready !== false || !/domain that is neither/.test(stray.reject_reason || '')) {
    fail(file + ' / the pitch gate passed a draft naming a foreign bare domain: ' + JSON.stringify(stray.reject_reason));
    gateHolds = false;
  }

  // The offer back is the only promise this package makes to a stranger under the operator's name,
  // so it is checked in both directions: the configured one has to arrive verbatim, and an offer
  // nobody configured has to be refused.
  const offerLine = "In return, I'd be happy to link your piece from our own writing when it fits.";
  const offered = run(gateFixture('', { reciprocity: 'link your piece from our own writing when it fits', reciprocityLine: offerLine }));
  if (offered.draft_ready !== true) {
    fail(file + ' / the pitch gate rejects a draft carrying the configured offer: ' + JSON.stringify(offered.verify_failures));
    gateHolds = false;
  }
  const uninvited = run(gateFixture('In return, we would be happy to feature you on our site.'));
  if (uninvited.draft_ready !== false || !/nothing was configured/.test(uninvited.reject_reason || '')) {
    fail(file + ' / the pitch gate passed a draft offering something nobody configured: ' + JSON.stringify(uninvited.reject_reason));
    gateHolds = false;
  }

  // "On the page" has to mean the whole page. The excerpt the writer sees is 6000 characters; the
  // vendor list handed to it in the same prompt is matched against the entire markdown. Checking the
  // vendor against the excerpt alone threw away 10 of 17 pitches in one run, every one naming a
  // vendor that was genuinely on its page, just further down it.
  const deepVendor = run(gateFixture('', { vendorMentioned: 'Bright Data', vendorsOnPage: ['Bright Data'] }));
  if (deepVendor.draft_ready !== true) {
    fail(file + ' / the pitch gate rejects a vendor proven on the page but below the excerpt: ' + JSON.stringify(deepVendor.verify_failures));
    gateHolds = false;
  }
  const absentVendor = run(gateFixture('', { vendorMentioned: 'Bright Data', vendorsOnPage: [] }));
  if (absentVendor.draft_ready !== false || !/vendor named is not on the page/.test(absentVendor.reject_reason || '')) {
    fail(file + ' / the pitch gate passed a vendor that is on neither the page nor the excerpt: ' + JSON.stringify(absentVendor.reject_reason));
    gateHolds = false;
  }
}
if (gateHolds) pass('the pitch gate passes a clean draft, refuses a foreign bare domain, and refuses an offer nobody configured');

// -------------------------------------------------- 7c. one person is written to once per run
// Executed against the shipped Build Pitch Context. Measured before this existed: 16 drafts, 7 to
// one publisher and 4 of those to the same editor in the same batch.
{
  let onePer = true;
  for (const file of FILES) {
    const wf = parse('.', file);
    const node = wf.nodes.find((n) => n.name === 'Build Pitch Context');
    if (!node) continue;
    const stubs = { 'Confirm Your Business Profile': { brand: 'AnyAPI', brand_domain: 'getanyapi.com' } };
    const $ = (ref) => ({ first: () => ({ json: stubs[ref] }), all: () => [{ json: stubs[ref] }] });
    const items = [
      { json: { page_url: 'https://a.example/low', contact_email: 'ed@a.example', status: 'email_verified', score: 5, markdown: 'text' } },
      { json: { page_url: 'https://a.example/high', contact_email: 'ed@a.example', status: 'email_verified', score: 9, markdown: 'text' } },
      // Same human, shouted. Address comparison has to be case-insensitive or this one slips through.
      { json: { page_url: 'https://a.example/caps', contact_email: 'ED@A.EXAMPLE', status: 'email_verified', score: 1, markdown: 'text' } },
      { json: { page_url: 'https://b.example/only', contact_email: 'ed@b.example', status: 'email_verified', score: 3, markdown: 'text' } },
    ];
    const out = new Function('$input', '$', node.parameters.jsCode)({ all: () => items, first: () => items[0] }, $)
      .map((o) => o.json);
    const pitchable = out.filter((o) => o.pitchable).map((o) => o.page_url);
    const expected = ['https://a.example/high', 'https://b.example/only'];
    if (JSON.stringify(pitchable) !== JSON.stringify(expected)) {
      fail(file + ' / Build Pitch Context does not collapse one recipient to one draft: ' + JSON.stringify(pitchable));
      onePer = false;
    }
  }
  if (onePer) pass('one contact address receives one draft per run, keeping their highest-scoring page');
}

// --------------------------------------- 7e. no paid call is ever built without its request body
// Measured: 43 of 61 calls to email_finding.hunter_domain came back
// `invalid_input: missing property 'domain'`, because the node that built the bodies also decided
// who to skip, and marked the skipped ones with a flag rather than withholding them. The HTTP node
// POSTed them anyway. Skipping now happens one node earlier, where a false branch already exists.
{
  let bodied = true;
  for (const file of FILES) {
    const wf = parse('.', file);
    const decide = wf.nodes.find((n) => n.name === 'Decide Who Needs A Domain Editor');
    const build = wf.nodes.find((n) => n.name === 'Build Domain Editor Calls');
    if (!decide || !build) continue;
    const stubs = {
      'Confirm Your Business Profile': { run_id: 'r1', spend_ceiling_usd: 0.3 },
      'Do We Still Need An Email?': { cost_usd: 0 },
    };
    const $ = (ref) => ({ first: () => ({ json: stubs[ref] }), all: () => [{ json: stubs[ref] }] });
    const items = [
      { json: { page_url: 'https://a.example/1', page_domain: 'a.example', contact_email: '' } },
      // Same publisher, second page: one call per domain, not per page.
      { json: { page_url: 'https://a.example/2', page_domain: 'a.example', contact_email: '' } },
      { json: { page_url: 'https://b.example/1', page_domain: 'b.example', contact_email: 'info@b.example' } },
      // Third distinct domain: the reservation runs the 0.30 ceiling out before this one.
      { json: { page_url: 'https://c.example/1', page_domain: 'c.example', contact_email: '' } },
    ];
    const decided = new Function('$input', '$', decide.parameters.jsCode)({ all: () => items, first: () => items[0] }, $);
    const wanted = decided.filter((d) => d.json.needs_domain_editor);
    if (wanted.length !== 2) {
      fail(file + ' / the domain-editor decision does not collapse by domain and reserve budget: ' + wanted.length + ' lookups');
      bodied = false;
    }
    const built = new Function('$input', '$', build.parameters.jsCode)({ all: () => wanted, first: () => wanted[0] }, $);
    const bodiless = built.filter((b) => !b.json.editorBody || !b.json.editorBody.domain || !b.json.editorIdem);
    if (bodiless.length) {
      fail(file + ' / Build Domain Editor Calls emits ' + bodiless.length + ' item(s) with no request body');
      bodied = false;
    }
    // A skipped prospect has to survive with a reason, not disappear and not become a bodiless call.
    if (decided.length !== items.length || decided.filter((d) => !d.json.needs_domain_editor && !d.json.domain_editor_skip_reason).length !== 0) {
      fail(file + ' / a skipped domain-editor prospect is dropped or carries no reason');
      bodied = false;
    }
  }
  if (bodied) pass('the domain-editor lookup asks once per domain, inside the ceiling, and never posts an empty body');
}

// ------------------------------------------- 7d. the identity line ends on a complete thought
// The one sentence every draft in a run shares, so a bad cut here is not one broken email, it is all
// of them. Two have shipped: "...eliminating idle costs and." and "...billing from a." Both were a
// long value proposition cut to length on a word boundary, stopping on a function word.
{
  let ends = true;
  for (const file of FILES) {
    const wf = parse('.', file);
    const node = wf.nodes.find((n) => n.name === 'Compose The Pitch');
    if (!node) continue;
    const preamble = node.parameters.jsCode.split('const prospects =')[0];
    const build = new Function('VP', preamble + `
      return assemblePitch(
        { sender_name: 'Kevin Wang', brand: 'AnyAPI', category: 'scraping API', aliases: ['AnyAPI'],
          value_prop: VP, page_title: 'The best scraping tools', author_first: 'Andrew',
          sender_role: 'Founder', brand_domain: 'getanyapi.com', reciprocity: '' },
        { relevance: 'you cover ten of them but not a per-request option', subject: 'AnyAPI for your piece' },
      ).body.split('\\n').find((l) => l.startsWith("I'm "));`);
    // The first three are the exact value propositions behind the three drafts that shipped with a
    // truncated identity line. The fourth checks the other half: a second sentence is still dropped.
    // Found by what the line is, not by where it sits. It used to be body line 2 and the skeleton was
    // reordered to put the reader's sentence first, at which point the index silently pointed at a
    // different sentence and the check went on passing against the wrong string.
    const props = [
      'Access 327 social, search and enrichment APIs through one key with automatic provider failover and pay-per-request billing from a prepaid USD wallet.',
      'One API key provides pay-per-request access to hundreds of data APIs with automatic failover, eliminating idle costs and subscription lock-in for teams.',
      'Access 327 scraping and data APIs behind one key with automatic failover and pay per request from a prepaid USD wallet with no subscriptions.',
      'A unified data API. We also do enrichment. And search.',
    ];
    for (const vp of props) {
      const line = build(vp);
      const firstSentence = vp.split(/(?<=[.!?])\s+/)[0].replace(/[.!]+$/, '');
      // The property is that the whole first sentence survives - not that it ends on an approved
      // word. Checking a list of allowed final words is what let three of these ship: the list was
      // extended twice and was still short by one.
      if (line.indexOf(firstSentence.slice(1)) === -1) {
        fail(file + ' / the identity line truncates the value proposition: ' + JSON.stringify(line));
        ends = false;
      }
      if (vp.indexOf('We also do') !== -1 && line.indexOf('enrichment') !== -1) {
        fail(file + ' / the identity line carries more than the first sentence: ' + JSON.stringify(line));
        ends = false;
      }
    }
  }
  if (ends) pass('the identity line ends on a complete thought however long the value proposition is');
}

// ------------------------------------- 7b. the two nodes that decide what counts, executed
// Both of these were defects that shipped and cost real drafts, so both are held by an executed
// test rather than by reading the code. The brand list is the one that let a preprint archive and a
// Cloudflare block page qualify as multi-vendor roundups; the visibility computation is new work
// this package now does itself, because the SKUs that used to return mentioned/cited were retired.
let semanticsHold = true;
{
  const wf = workflows[0].wf;
  const code = (n) => (wf.nodes.find((x) => x.name === n) || {}).parameters.jsCode;
  const runNode = (name, items, stubs) => {
    const $ = (ref) => ({
      first: () => ({ json: stubs[ref] }),
      all: () => (Array.isArray(stubs[ref]) ? stubs[ref] : [stubs[ref]]).map((j) => ({ json: j })),
    });
    const fn = new Function('$input', '$', '$execution', code(name));
    return fn({ all: () => items.map((j) => ({ json: j })), first: () => ({ json: items[0] }) }, $, { id: 't' }).map((r) => r.json);
  };
  const profile = {
    run_id: 't', brand: 'AnyAPI', brand_domain: 'getanyapi.com', aliases: ['AnyAPI', 'getanyapi'],
    competitors: ['Apify'], category: 'scraping api', icp: '', buyer_prompts: ['p'], cost_usd: 0, spend_ceiling_usd: 2,
  };

  const harvest = { answers: [{ found: true, data: {
    answer: 'Major providers exist. Whether HTML or JSON, Community support is Official.',
    citations: [{ url: 'https://scrapfly.io/blog' }, { url: 'https://github.com/a/b' }, { url: 'https://arxiv.org/abs/1' }],
  } }] };
  const brands = runNode('Name Every Brand In The Answers', [harvest], { 'Confirm Your Business Profile': profile })[0].brands_named;
  const leaked = ['Major', 'Whether', 'Community', 'Official', 'HTML', 'JSON', 'Github', 'Arxiv'].filter((w) => brands.indexOf(w) !== -1);
  if (leaked.length) { fail('the brand list counts prose words or non-vendor domains as vendors: ' + leaked.join(', ')); semanticsHold = false; }
  if (brands.indexOf('Scrapfly') === -1) { fail('the brand list drops a vendor an engine actually cited'); semanticsHold = false; }

  const resp = (body, status) => ({ statusCode: status || 200, body });
  const ans = (text, cites, searched) => ({ costUsd: 0.0018, output: { found: true, data: { answer: text, citations: cites, webSearchTriggered: searched } } });
  const v = runNode('Verify Engine Answers', [{}], {
    'Confirm Your Business Profile': profile,
    'Build Visibility Calls': [{ prompt: 'p1' }, { prompt: 'p2' }],
    'AnyAPI Ask ChatGPT': [resp(ans('Try ManyAPIs today.', [], true)), resp(ans('written from memory', [], false))],
    'AnyAPI Ask Perplexity': [resp(ans('Use Apify.', [{ url: 'https://getanyapi.com/x' }], true)), resp('bad gateway', 502)],
    'AnyAPI Ask Google AI Overview': [resp(ans('AnyAPI is one option.', [], true)), resp(ans('x', [], true))],
  })[0];
  const p1chat = v.visibility.find((x) => x.prompt === 'p1' && x.engine === 'chatgpt');
  if (!p1chat || p1chat.mentioned !== false) { fail('"ManyAPIs" is read as a mention of AnyAPI - the alias match lost its word boundary'); semanticsHold = false; }
  if (v.visibility.filter((x) => x.cited).length !== 1) { fail('cited counts a citation that is not on your own domain'); semanticsHold = false; }
  if (v.visibility.length !== 4) { fail('an engine answer that never ran a search is being counted in the visibility denominator'); semanticsHold = false; }
}
if (semanticsHold) pass('the brand list refuses prose words, and visibility counts only answers that actually searched');

// ---------------------------------------------------------------- 8. no unexplained number in the prose
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
  // Node counts are not listed here on purpose: they are read off the shipped JSON below, because a
  // hand-maintained count is exactly the kind of constant that goes stale and still passes.
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
  // Published AnyAPI prices quoted in the cost table.
  [0.0018, 'the published price of perplexity.search and google.ai_overview'],
  [0.0036, 'the published price of chatgpt.search'],
  [0.036, 'the published price of email_finding.hunter_domain, per contact returned'],
  [43, 'bodiless hunter_domain calls measured in one run'],
  [61, 'calls to that SKU in that run'],
  // Engine timeouts, each set from what that engine actually takes.
  [180000, 'the chatgpt.search timeout in milliseconds'],
  [120000, 'the perplexity.search timeout in milliseconds'],
  [240000, 'the google.ai_overview timeout in milliseconds'],
  // The concurrency failure described in the README.
  [300, 'concurrent scrapes at which a run aborted'],
  [146, 'calls that had completed cleanly earlier in that same run'],
  [11, 'minutes, rounded down from the measured wall time'],
  // The number of sites judged is the sum of the verdicts, which the record carries separately.
  [184, 'sites judged in the harness run, the sum of its two publisher verdicts'],
  // Development measurements from the runs that found the defects PROOF.md describes.
  [207, 'domains judged in the run that tested keeping unclear verdicts'],
  [78, 'of those judged unclear, which is why that rule was reverted'],
  [21, 'of those judged publisher in that same run'],
  [38, 'percent of that run judged unclear'],
  [20, 'pages rejected for naming no vendor, and other small measured counts'],
  [0.362300, 'the spend the run record reported before it read every paid node'],
  [0.462400, 'the spend actually charged in that same run'],
  [17, 'pitches composed in the run where the vendor check rejected ten of them'],
  [503, 'the largest cited-URL count measured across development runs'],
  [16, 'drafts produced by the run that sent four emails to one editor'],
  [10, 'pitches the excerpt-only vendor check wrongly rejected, of 17'],
  [18, 'the most passing drafts measured across development runs'],
]);

const measuredNumbers = new Set();
(function collect(v) {
  if (typeof v === 'number') { measuredNumbers.add(v); return; }
  if (Array.isArray(v)) { v.forEach(collect); return; }
  if (v && typeof v === 'object') { Object.values(v).forEach(collect); }
}(samples.map((s) => s.sample)));

// The three runs of the shipped JSON inside real n8n feed the same set. They are not `samples`,
// because the draft and funnel checks below read the harness sample's shape and these are run
// records only - but every figure in the run table in PROOF.md has to come out of a run record all
// the same, so editing one there fails here.
(function collectRuns(v) {
  if (typeof v === 'number') { measuredNumbers.add(v); return; }
  if (Array.isArray(v)) { v.forEach(collectRuns); return; }
  if (v && typeof v === 'object') { Object.values(v).forEach(collectRuns); }
}(parse('samples', 'measured-runs-n8n.json')));

// A node count quoted in the prose is measured too - off the file it describes.
for (const file of FILES) {
  const wf = parse('.', file);
  measuredNumbers.add(wf.nodes.length);
  measuredNumbers.add(new Set(wf.nodes.map((n) => n.type)).size);
  measuredNumbers.add(wf.nodes.filter((n) => n.type === 'n8n-nodes-base.stickyNote').length);
}

const stripCodeAndLinks = (text) => text
  .replace(/```[\s\S]*?```/g, ' ')
  // Reddit does not render fenced blocks, so the post draft indents its example draft by four
  // spaces instead. That is the same thing as a fence and has to be exempt the same way: the
  // numbers inside a quoted email are that email's, not claims the post is making.
  .replace(/^ {4,}\S.*$/gm, ' ')
  .replace(/`[^`]*`/g, ' ')
  .replace(/\]\([^)]*\)/g, '] ')
  .replace(/https?:\/\/\S+/g, ' ')
  // Ordered-list and numbered-heading markers are structure, not claims.
  .replace(/^\s{0,3}#{0,6}\s*\d+\.\s/gm, ' ');

let prosePasses = true;
// The n8n listing is checked too: it is the copy most people will read without ever seeing the
// repo, and it is the easiest one to leave stale after a re-run. It is also the one file where the
// fenced blocks ARE the claims - the whole listing is fenced so it can be pasted - so stripping
// them would have made this check pass while reading nothing. It did, briefly: "$0.71 of API
// spend" sat unchecked inside a fence.
const FENCED_COPY_IS_THE_CLAIM = new Set(['N8N_TEMPLATE.md']);
for (const doc of ['README.md', 'PROOF.md', 'N8N_TEMPLATE.md']) {
  const raw = read(doc);
  if (/\{\{|\[TODO\]|XXX/.test(raw)) { fail(doc + ' still contains a placeholder'); prosePasses = false; }
  const text = FENCED_COPY_IS_THE_CLAIM.has(doc)
    ? stripCodeAndLinks(raw.replace(/^```\w*$/gm, ''))
    : stripCodeAndLinks(raw);
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
if (prosePasses) pass('every number in the README, the proof and the n8n listing is measured or explained');

if (failed) { console.error('\n' + failed + ' check(s) failed.'); process.exit(1); }
console.log('\nVerification complete.');

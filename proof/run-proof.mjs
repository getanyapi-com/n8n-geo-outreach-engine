#!/usr/bin/env node
// Runs the shipped lite workflow for real, outside n8n.
//
// It does not reimplement the workflow. It reads geo-outreach-prospector-lite.workflow.json,
// pulls the jsCode straight out of every Code node, evaluates the IF conditions straight out of
// every IF node, and calls the same AnyAPI endpoints with the same bodies the HTTP nodes would
// send. That is the point: the numbers in PROOF.md come from the code that ships, not from a
// parallel script that agrees with it.
//
// Two things it cannot do. Data Table nodes are skipped, because state persistence has no effect
// on any published number. Gmail draft:create is not called, because it needs an interactive OAuth
// consent; every draft that passes the gate is written to proof/artifacts/drafts instead, exactly
// as the node would have sent it.
//
// Usage: ANYAPI_API_KEY=... node proof/run-proof.mjs

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const artifacts = join(here, 'artifacts');
const workflow = JSON.parse(readFileSync(join(root, 'geo-outreach-prospector-lite.workflow.json'), 'utf8'));

const API_KEY = process.env.ANYAPI_API_KEY;
if (!API_KEY) { console.error('Set ANYAPI_API_KEY'); process.exit(1); }

const FORM = JSON.parse(readFileSync(join(here, 'proof-input.json'), 'utf8'));
const RUN_ID = process.env.PROOF_RUN_ID || 'proof-1';

const nodeByName = new Map(workflow.nodes.map((n) => [n.name, n]));
const outputs = new Map();
const httpLog = [];
const started = Date.now();

const wrap = (items) => items.map((i) => (i && i.json !== undefined ? i : { json: i }));

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

async function callAnyApi(nodeName, item) {
  const node = nodeByName.get(nodeName);
  const url = node.parameters.url;
  const bodyField = node.parameters.jsonBody.match(/\$json\.(\w+)/)[1];
  const idemField = node.parameters.headerParameters.parameters[0].value.match(/\$json\.(\w+)/)[1];
  const body = item.json[bodyField];
  const idem = item.json[idemField];
  const timeout = node.parameters.options.timeout;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const t0 = Date.now();
  let statusCode = 0;
  let parsed = {};
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + API_KEY,
        'Content-Type': 'application/json',
        'Idempotency-Key': idem,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    statusCode = res.status;
    const text = await res.text();
    try { parsed = JSON.parse(text); } catch (e) { parsed = { error: { code: 'unparseable', message: text.slice(0, 200) } }; }
  } catch (e) {
    statusCode = 0;
    parsed = { error: { code: 'transport', message: String(e.message || e) } };
  } finally {
    clearTimeout(timer);
  }

  httpLog.push({
    node: nodeName,
    url,
    statusCode,
    ms: Date.now() - t0,
    costUsd: statusCode >= 200 && statusCode < 300 ? Number(parsed.costUsd || 0) : 0,
    found: (parsed.output || {}).found,
    // true when this exact body was already run under this key inside the 24h replay window, in
    // which case the answer is served from the earlier run and the wallet is not charged again.
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
  const items = wrap(inputItems);
  const results = [];
  for (const item of items) {
    let result = await callAnyApi(nodeName, item);
    for (let attempt = 1; attempt < maxTries && result.json.statusCode >= 400; attempt += 1) {
      await new Promise((r) => setTimeout(r, waitMs));
      result = await callAnyApi(nodeName, item);
    }
    results.push(result);
  }
  outputs.set(nodeName, results);
  const spent = httpLog.filter((h) => h.node === nodeName).reduce((s, h) => s + h.costUsd, 0);
  console.log('  ' + nodeName + ' -> ' + results.length + ' call' + (results.length === 1 ? '' : 's') + ', $' + spent.toFixed(5));
  return results;
}

const concat = (...lists) => lists.flat();

(async () => {
  rmSync(join(artifacts, 'drafts'), { recursive: true, force: true });
  mkdirSync(join(artifacts, 'drafts'), { recursive: true });
  console.log('GEO Prospector (lite), executed from the shipped workflow JSON\n');

  console.log('Band 1 Onboard');
  const config = runCode('Normalize Onboarding Input', [{ json: FORM }]);
  const siteScrape = await runHttp('AnyAPI Scrape Your Website', config);
  runCode('Verify Your Website Was Read', siteScrape);
  const profile = runCode('Confirm Your Business Profile', outputs.get('Verify Your Website Was Read'));
  console.log('  buyer prompts: ' + JSON.stringify(profile[0].json.buyer_prompts) + '\n');

  console.log('Band 2 Ask the engines');
  const calls = runCode('Build Visibility Calls', profile);
  const engineNodes = ['AnyAPI Ask ChatGPT', 'AnyAPI Ask Perplexity', 'AnyAPI Ask Gemini', 'AnyAPI Ask Google AI Overview'];
  const engineResults = [];
  for (const n of engineNodes) engineResults.push(await runHttp(n, calls));
  runCode('Verify Engine Answers', concat(...engineResults));
  console.log('');

  console.log('Band 3 Harvest and filter');
  runCode('Harvest Cited URLs', outputs.get('Verify Engine Answers'));
  runCode('Name Every Brand In The Answers', outputs.get('Harvest Cited URLs'));
  runCode('Drop Pages You Or Your Rivals Own', outputs.get('Name Every Brand In The Answers'));
  const ranked = runCode('Score And Rank Pitchable Pages', outputs.get('Drop Pages You Or Your Rivals Own'));
  const [pitchable, noPages] = runIf('Did Any Pitchable Pages Survive?', ranked);
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
  const contacts = runCode('Extract Author And Contacts', concat(rescraped, readPages));
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
  const cleaned = runCode('Reject Free And Off-Domain Addresses', mergedContacts);
  const [toVerify, unverifiable] = runIf('Is There An Address To Verify?', cleaned);
  let verified = [];
  if (toVerify.length) {
    const verifyCalls = runCode('Build Email Verify Calls', toVerify);
    const verifyResults = await runHttp('AnyAPI Verify The Email', verifyCalls);
    verified = runCode('Accept Only Deliverable Addresses', verifyResults);
  }
  const allProspects = concat(verified, unverifiable);
  console.log('');

  console.log('Band 6 Write the pitch, then refuse to send it');
  const withContext = runCode('Build Pitch Context', allProspects);
  const [pitchThese, notPitchable] = runIf('Do We Have A Verified Contact?', withContext);
  let gated = [];
  if (pitchThese.length) {
    runCode('Compose The Pitch', pitchThese);
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
  console.log('  Draft It In Your Gmail -> not executed, ' + passed.length + ' payload(s) written to proof/artifacts/drafts\n');

  console.log('Band 7 Account for the run');
  const mergedDrafts = concat(passed, rejected, notPitchable);
  outputs.set('Merge Draft Paths', mergedDrafts);
  const record = runCode('Build Run Record', mergedDrafts);
  const rows = runCode('Build Prospect Workbook Rows', record);

  const runtime = Number(((Date.now() - started) / 1000).toFixed(3));
  const measuredCost = Number(httpLog.reduce((s, h) => s + h.costUsd, 0).toFixed(6));

  writeFileSync(join(artifacts, 'run-record.json'), JSON.stringify(record[0].json, null, 2));
  writeFileSync(join(artifacts, 'http-log.json'), JSON.stringify(httpLog, null, 2));
  writeFileSync(join(artifacts, 'workbook-rows.json'), JSON.stringify(rows.map((r) => r.json), null, 2));
  writeFileSync(join(artifacts, 'prospects.json'), JSON.stringify(mergedDrafts.map((i) => {
    const p = Object.assign({}, i.json);
    delete p.pitch_context;
    delete p.raw_html;
    return p;
  }), null, 2));

  // samples/measured-output.json is what README, PROOF.md and the post are checked against.
  // Every draft carries the slice of page text its quote has to be inside, so the claim
  // "the quote is really on the page" is checkable from the repo alone.
  const excerptAround = (text, quote) => {
    const flat = text.replace(/\s+/g, ' ');
    const needle = quote.replace(/\s+/g, ' ');
    const at = flat.indexOf(needle);
    if (at === -1) return flat.slice(0, 1200);
    return flat.slice(Math.max(0, at - 400), at + needle.length + 400);
  };
  // Publishing harvested addresses would be the one genuinely rude thing this package could do.
  // The local part is masked everywhere in the sample, including inside quoted page text, and the
  // same mask runs over the quote so the "this line is on the page" check still holds.
  const maskEmails = (text) => String(text || '').replace(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '[address]@$1');

  const sample = {
    run: {
      workflow: 'GEO Prospector (lite)',
      executed_by: 'proof/run-proof.mjs, which runs the Code nodes out of the shipped workflow JSON',
      gmail_executed: false,
      run_id: RUN_ID,
      started_at: new Date(started).toISOString(),
      harness_wall_seconds: runtime,
      anyapi_calls: httpLog.length,
      anyapi_cost_usd: measuredCost,
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
      spend_ceiling_usd: record[0].json.spend_ceiling_usd,
      by_node: httpLog.reduce((acc, h) => {
        acc[h.node] = Number(((acc[h.node] || 0) + h.costUsd).toFixed(6));
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
  writeFileSync(join(root, 'samples', 'measured-output.json'), JSON.stringify(sample, null, 2) + '\n');

  console.log('\nAnyAPI charged: $' + measuredCost.toFixed(6));
  console.log('Run record cost: $' + record[0].json.anyapi_cost_usd.toFixed(6));
  console.log('Harness wall time: ' + runtime + 's');
})();

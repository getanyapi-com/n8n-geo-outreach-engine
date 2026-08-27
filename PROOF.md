# Measured proof

## What was run, and by what

The published run was executed on 2026-08-23 against `getanyapi.com` with a $2 spend ceiling.

It was not executed inside n8n. It was executed by `proof/run-proof-pro.mjs`, which reads
`geo-outreach-prospector.workflow.json`, pulls the `jsCode` out of every Code node, evaluates the
condition out of every IF node, calls the same AnyAPI endpoints with the same bodies the HTTP
Request nodes would send, and calls each model node's model over OpenRouter with that node's own
system message and prompt. The numbers therefore come from the code that ships rather than from a
script that agrees with it.

Two things the harness does not do, and both matter when reading the table.

- **Data Table nodes are skipped.** This was published as "state persistence changes no published
  number", and that was wrong. A Data Table insert returns the row it wrote, not the item it was
  given, so any Code node reading `$input` straight after one gets the row instead of its data. The
  harness never saw it, because with the node skipped `$input` still carried the original item. Real
  n8n killed the first execution on it. Three nodes now read past the write by name, and `npm run
  verify` refuses the pattern outright.
- **`draft:create` was not called.** Gmail needs an interactive OAuth consent that a headless run
  cannot give. Every pitch that passed the gate was written to `proof/artifacts-pro/drafts` exactly
  as the node would have sent it, which is why the funnel below stops at "passed every gate" and
  `drafts_created_in_gmail` is `null` in the sample rather than a number.

Both workflow JSONs were separately imported into a clean `n8n 2.27.4` with no credentials, and
every node resolved to a real node type.

## The funnel

| Stage | Count |
| --- | ---: |
| Buyer questions | 17 |
| Engine calls | 51 |
| Failed | 3 |
| Empty | 0 |
| Answers scored for visibility | 39 |
| Answers mentioning AnyAPI | 0 |
| Answers citing AnyAPI | 0 |
| Cited URLs harvested | 471 |
| Pages considered | 517 |
| Ownership: competitor | 94 |
| Ownership: the vendor's own product page | 31 |
| Ownership: platform | 58 |
| Ownership: third party, pitchable | 334 |
| Sites read to judge who runs them | 184 |
| Judged a vendor in the same category | 106 |
| Judged an independent publisher | 78 |
| Pages read | 104 |
| Rejected as not a roundup | 65 |
| Contact from the page | 15 |
| Contact from a contact page | 4 |
| Contact from the domain's published editor or `email.find` | 6 |
| No contact found | 14 |
| Addresses rejected before verification or by it | 3 |
| Addresses verified | 19 |
| Pitches composed | 19 |
| Passed all thirteen gates | 17 |
| Rejected by the gate | 2 |

450 AnyAPI calls, $0.555590, plus $0.035604 of model calls, in 12 minutes of wall time.

19 verified addresses produced 19 pitches, of which 17 passed and 2 were rejected.

## The measurement that motivates the whole thing

Across 39 prompt and engine pairs, AnyAPI was mentioned zero times and cited zero times. Its share
of voice on its own category questions is zero.

The same 51 engine calls surfaced 471 distinct cited URLs, and 94 of them belong to a competitor.
That asymmetry is the thing this workflow is built to attack, and it is also the reason the
ownership filter exists: a fifth of the pages an engine cites are pages you can never be added to.

## The filter that costs the most to get wrong

184 sites survived the cheap filters. Reading each one's own home page and asking a model whether a
buyer with these questions would consider its product, 106 came back a vendor.

That step is the difference between outreach and self-harm, and it was wrong twice before it was
right.

The first version let a site through when the model could not tell. That sounded generous. Measured
across 207 judged domains it produced 108 vendor, 78 unclear and 21 publisher, and every one of the
11 drafts that run produced went to a site judged unclear or never judged, while **none** went to a
site judged publisher. `unclear` was not a rare abstention, it was 38 percent of the set and mostly
vendors declining to commit. Reverted.

The second version described the market to the model as a category phrase. Ours was "unified data
api", so a company whose home page reads "Fully-Managed Web Scraping Services" was judged an
independent publisher: it does not sell a unified data API, so it looked out of category. The run
drafted a polite request to be listed to a direct competitor. The model was reasoning about
vocabulary rather than about who competes.

It is now shown the buyer questions themselves. A site is a competitor exactly when somebody asking
one of those questions would consider it, and that test does not care how the vendor words its
homepage. On the same batch of ten sites and the same page text, the competitor flipped to `vendor`
while the genuine review blogs stayed `publisher`.

## Every refusal in the run

| Count | Refusal |
| ---: | --- |
| 43 | no named vendor on the page, so it is not a roundup |
| 22 | only one named vendor on the page, so it is not a roundup |
| 14 | no contact address could be found for the domain |
| 3 | `email.verify` said bad and the domain is not catch-all |
| 2 | the vendor named is not one of the brands the engines named |
| 1 | that person is already being written to about a different page |

The last one is new and worth reading. Before it existed a run produced 16 drafts of which 7 went to
one publisher and 4 of those to the same editor, all in the same batch. Four cold emails arriving
together from one sender is not four chances, it is a complaint. One address now receives one draft
per run, keeping their highest-scoring page. How many *different* people at one publisher may be
written to is a real choice and is deliberately left open: that publisher's second editor still gets
a draft.

## Every draft quotes its page

Each entry in `samples/measured-output-pro.json` carries `quoted_snippet` and the slice of page text
it came from. `npm run verify` fails if any quoted snippet is not literally inside its recorded page
text, and fails if any draft is addressed to a domain other than the page's own.

The quote is no longer printed in the email. It is still required and still checked, because it is
the proof the writer read the page rather than guessing from the title. But a sentence lifted out of
scraped markdown arrives carrying the page's own bullets and colons, and an editor does not need
their own sentence read back to them. The proof belongs in the workbook.

## What earlier runs found, and what it changed

The runs before the published one are why the shipped workflow looks the way it does.

**`retryOnFail` is decorative next to `neverError`.** 19 of 28 page scrapes returned 502 in about 70
milliseconds each, and every one of those URLs read fine minutes later. The workflow kept 9 pages
and produced no drafts. n8n retries a node only when it throws or when the **first** output item
carries an error, and the `neverError` option these nodes need in order to read a status code means
the node never produces one. Band 4 now has a visible rescrape branch, and `verify.mjs` fails any
node that claims both settings.

**`email.verify` does not say what the schema example says.** 7 addresses verified and 0 drafts came
out. The provider returns `good`, `risky` and `bad` with a score and a `catchAll` flag; the gate had
been written against `valid` and `deliverable`, so it threw away a `good` address scoring 100 along
with every catch-all publisher. Most publishers are behind a catch-all.

**`409` is two different things wearing one status code.** `idempotency_in_progress` means the
identical call is still running, which is transient. `idempotency_conflict` means the key formula is
broken, which is not. The workflow now stops for the second and shrugs at the first.

**A case-insensitive regex cannot check for a capital letter.** 8 anonymous drafts were rejected for
"greets a person by name and no author name was found". The pattern was
`/^(hi|hey|hello|dear)\s+[A-Z][a-z]+/im`, and the `i` flag makes `[A-Z]` match lowercase, so
`Hi there,` read as a greeting to somebody called There.

**Capitalised words are not brands.** A draft told a TechRadar editor "you already cover More
there", because words starting a sentence were harvested as rival brand names. The harvester now
works from the competitor list and the registrable domains of cited pages, with an explicit set of
domains that are never vendors: `github`, `reddit`, `arxiv` and the like. Before that, the contact
finder was sent looking for the editor of arxiv.org.

**A rule that sounded obviously right.** "A page that names its own brand more often than any vendor
it covers is that vendor's marketing page" rejected 22 of 33 pages, including TechRadar, KDnuggets,
GitHub and DesignRush, because every site repeats its own name in nav, breadcrumbs and footer more
than it names any single vendor. Reverted. The narrower rule that survived only fires when the
site's own brand leads the page title, which publishers do not do and vendors do.

**n8n fires every item at once and they share one clock.** `httpRequest` launches all of a node's
items together and gives each the same per-node timeout, so on a node carrying a few hundred pages
the last requests sit in the connection queue burning their own clock before the server sees them. A
run died with `This operation was aborted` at roughly 300 concurrent scrapes, having completed 146
calls cleanly earlier in the same run. The fan-out nodes now set `batching`.

**The run record under-reported spend by 22 percent.** It showed $0.362300 against $0.462400
actually charged, because it summed the cost carried on prospects that survived to the end: a page
scraped and then dropped as "not a roundup" was charged and forgotten, and a run-level cost stamped
onto every kept row could neither be summed nor counted once. It now reads every paid node directly.
That number prints beside the operator's spend ceiling, so `verify.mjs` now fails if any AnyAPI node
in the workflow is missing from the list the record adds up.

**The gate and the prompt disagreed about what "the page" meant.** 10 of 17 pitches were thrown away
for naming a vendor "not on the page" when the vendor was on the page. The prompt hands the writer a
list of vendors matched against the full page markdown; the gate then re-checked the answer against
the 6000-character excerpt the writer had been shown. Naming a vendor from halfway down a long
roundup failed a check for telling the truth. The gate now checks the deterministic full-page list,
which is stronger evidence than a substring search of a truncated window. The quote check still uses
the excerpt, because that claim genuinely is about the text the writer saw.

**A character limit cut sentences in half, three times.** The identity line shipped as "...
eliminating idle costs and.", then "...billing from a.", then "...wallet with no." Each fix extended
a list of function words to strip off the end, and each one shipped because it was tested against
the string that had just failed rather than against the property. The list is never finished; the
truncation was the bug. The line is now the first sentence of the value proposition, placed
unchanged, which is grammatical because the operator wrote it that way. The measured problem had
always been three sentences of marketing, and taking one sentence solves that exactly.

**A skipped call is not a free call.** The node that built the domain-editor requests also decided
which domains to skip, and marked the skipped ones with a flag instead of withholding them. The HTTP
node posted them anyway, with no body, and got back `invalid_input: missing property 'domain'` every
time: 43 of 61 calls to that SKU in one run. They were charged nothing, which is exactly why it went
unnoticed - the cost column read $0.00 and looked like a run of cheap misses. Deciding one node
earlier, where a false branch already existed, fixed it and also stopped silently discarding the
second page from a publisher we had already asked about.

Two things about AnyAPI itself, both worth knowing if you run this: a call that fails appears to
leave its idempotency key held, so re-running the identical body under the same key inside the
replay window returns `409 idempotency_in_progress` rather than retrying the work. And
`email_finding.hunter_domain` bills per contact returned and nothing at all when it finds nobody,
which is why it is worth trying as the last rung even after `email.find` has come up empty.

**A green harness is not a green run.** Twelve clean harness runs shipped a workflow that could
not have worked for anybody. `new URL(...)` throws `ReferenceError` inside n8n's Code node sandbox,
where `URL` is not a global; both callers caught it and returned an empty string, so every hostname
in the run silently came back blank - the brand domain, every page domain, the ownership filter, the
publisher filter and the recipient check. Node has `URL` as a global, so the harness was structurally
incapable of noticing. The helpers parse by hand now, and the verifier fails on any Code node
referencing a global the sandbox does not define.

**Two addresses that nothing keeps in step will drift apart.** The summary was emailed to an address
typed on the form, while the drafts were created in whichever account the Gmail credential belonged
to. Nothing connected them. On the first real run they were different accounts: eleven drafts in one
inbox, and the email describing them in another. The form no longer asks. A free Gmail profile read
supplies the address, so the summary always arrives where the drafts are.

**The template is copied, not derived.** The email shape here is taken from a working backlink
outreach product's own template editor, field for field: a "Collaboration between <their company>
and <your brand>" subject, the sender's line first, the page named in the second sentence, an offer
back, and a soft "would this be something your team is open to exploring?" close. I had already
rewritten this shape once from my own reasoning - reader's sentence first, an explicit "would you
consider adding X to Y" - and shipped it. It was worse, and it was worse in the two places the real
template is most deliberate. The subject now reads as one business writing to another rather than a
submission to a page, and the close asks for a conversation rather than for the link itself.

Four parts of the wording vary per recipient - greeting, opener, "thought" against "figured", and
the fit clause - because a run of identical bodies is what a spam filter clusters on. The choice is
seeded from the page rather than random, so re-running a prospect produces the same email rather
than a second, differently-worded one arriving beside the first.

## Three runs in real n8n

The harness proves the numbers. These prove the workflow, because they are the shipped JSON executing
inside `n8n 2.35.7` with real credentials, and every draft in the last column exists in a Gmail
account. Nothing was sent in any of them.

| Execution | Buyer questions | Citations | Pitchable | Sites judged | Drafts in Gmail | Cost | Runtime |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 6 | 17 | 414 | 299 | 128 | 11 | $0.43886 | 13m52s |
| 12 | 16 | 358 | 265 | 113 | 8 | $0.50639 | 11m22s |
| 13 | 17 | 410 | 276 | 116 | 10 | $0.50943 | 10m32s |

The spread between them is the engines, not the workflow: the same site and the same form produced
between 358 and 414 cited URLs across three runs an hour apart. Execution 13 is the one the
screenshot is captioned from, and the one whose gate refused a draft - a pitch naming a vendor the
engines had never named.

## The honest limits of this proof

- The engines are not stable between runs. Runs against the same site produced between 108 and 503
  cited URLs and between 0 and 18 passing drafts. Treat any single run as one sample.
- The number of buyer questions is not fixed. The same site produced between 15 and 17 across
  consecutive runs, and every downstream number moves with it.
- The funnel table above is the harness run, because that is the run with a saved artifact for every
  page it looked at. It is not the only evidence any more: see the three real runs below.
- A verified address means the mailbox accepts mail. It does not mean the person still works there.
- The publisher filter is a judgement, and judgements are wrong sometimes. It is the reason the
  workbook records a verdict for every domain: you can see what it decided and why before you send.
- The run proves the workflow finds pages, proves they are pitchable and writes accurate drafts. It
  does not prove any editor said yes, and it cannot prove a placement changed an engine's answer.
  The only way to know that is to re-run the same buyer questions later and compare.

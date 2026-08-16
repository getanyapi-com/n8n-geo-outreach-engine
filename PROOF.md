# Measured proof

## What was run, and by what

The published run is the **lite** tier, executed on 2026-08-16 against `getanyapi.com` with a $2
spend ceiling. Lite has no model in it anywhere, so every number below is deterministic and you can
reproduce it yourself.

It was not executed inside n8n. It was executed by `proof/run-proof.mjs`, which reads
`geo-outreach-prospector-lite.workflow.json`, pulls the `jsCode` out of every Code node, evaluates
the condition out of every IF node, and calls the same AnyAPI endpoints with the same bodies the
HTTP Request nodes would send. The numbers therefore come from the code that ships rather than from
a script that agrees with it.

Two things the harness does not do, and both matter when reading the table.

- **Data Table nodes are skipped.** State persistence changes no published number.
- **`draft:create` was not called.** Gmail needs an interactive OAuth consent that a headless run
  cannot give. Every pitch that passed the gate was written to `proof/artifacts/drafts` exactly as
  the node would have sent it, which is why the funnel below stops at "passed every gate" and
  `drafts_created_in_gmail` is `null` in the sample rather than a number.

The three workflow JSONs were separately imported into a clean `n8n 2.27.4` with no credentials, and
every node resolved to a real node type.

## The funnel

| Stage | Count |
| --- | ---: |
| Buyer questions | 8 |
| Engine calls | 32 |
| Failed | 3 |
| Empty | 0 |
| Brand-visibility answers scored | 21 |
| Answers mentioning AnyAPI | 0 |
| Answers citing AnyAPI | 0 |
| Cited URLs harvested | 130 |
| Ownership: competitor | 63 |
| Ownership: the vendor's own product page | 18 |
| Ownership: platform | 17 |
| Ownership: third party, pitchable | 32 |
| Pages read | 32 |
| Rejected as not a roundup | 1 |
| Contact from the page | 10 |
| Contact from a contact page | 5 |
| No contact found | 16 |
| Addresses rejected before verification or by it | 3 |
| Addresses verified | 12 |
| Pitches composed | 12 |
| Passed all twelve gates | 5 |
| Rejected by the gate | 7 |

122 AnyAPI calls, $0.155420, 23 minutes of wall time.

12 verified addresses produced 12 pitches, of which 5 passed and 7 were rejected. 5 + 7 = 12.

## The measurement that motivates the whole thing

Across 21 prompt and engine pairs, AnyAPI was mentioned zero times and cited zero times. Its share
of voice on its own category questions is zero.

The same 32 engine calls surfaced 130 distinct cited URLs, and 63 of them belong to a competitor.
That asymmetry is the thing this workflow is built to attack, and it is also the reason the
ownership filter exists: half the pages an engine cites are pages you can never be added to.

## Every refusal in the run

| Count | Refusal |
| ---: | --- |
| 16 | no contact address found on the page or its contact pages |
| 7 | no clean sentence on the page names a vendor inside the quote bounds |
| 2 | `email.verify` said risky and the domain is not catch-all |
| 1 | `email.verify` said bad and the domain is not catch-all |
| 1 | only 0 named vendors on the page, so it is not a roundup |

The 7 rejected pitches are the gate working. Lite composes its quote by lifting a sentence off the
page, and when no sentence on the page both names a vendor and reads like prose rather than
furniture, it produces nothing at all instead of producing something plausible.

## Every draft quotes its page

Each entry in `samples/measured-output.json` carries `quoted_snippet` and the slice of page text it
came from. `npm run verify` fails if any quoted snippet is not literally inside its recorded page
text, and fails if any draft is addressed to a domain other than the page's own.

## What earlier runs found, and what it changed

Six runs were needed. The five before the published one are why the shipped workflow looks the way
it does.

**Run 1.** 19 of 28 page scrapes returned 502 in about 70 milliseconds each. Every one of those URLs
read fine minutes later. The workflow kept 9 pages out of 28 and produced no drafts at all, because
`retryOnFail` was decorative: n8n retries a node only when it throws or when the **first** output
item carries an error, and the `neverError` option these nodes need in order to read a status code
means the node never produces one. That is why band 4 now has a visible rescrape branch, and why
`verify.mjs` fails any node that claims both settings.

**Run 1, second finding.** 7 addresses verified and 0 drafts came out. `email.verify` returns
`good`, `risky` and `bad`, with a score and a `catchAll` flag. The gate had been written against
the schema example's `valid` and `deliverable`, so it threw away a `good` address scoring 100 along
with every catch-all publisher. Most publishers are behind a catch-all.

**Run 2.** Killed itself on `409 idempotency_in_progress`. That status means the identical call is
still running, which is transient. `idempotency_conflict` means the key formula is broken, which is
not. The workflow now stops for the second and shrugs at the first.

**Run 3.** 8 anonymous drafts rejected for "greets a person by name and no author name was found".
The regex was `/^(hi|hey|hello|dear)\s+[A-Z][a-z]+/im`, and the `i` flag makes `[A-Z]` match
lowercase, so `Hi there,` reads as a greeting to somebody called There. Also in run 3: five drafts
lost because the composer stripped markdown characters out of a sentence before quoting it, so its
own quote was no longer literally on the page and the quote gate correctly refused it.

**Run 4.** A draft told a TechRadar editor "you already cover More there". Capitalised words at the
start of a sentence were being harvested as rival brands, so `More`, `Use`, `Need` and `Search`
became vendors. Only mid-sentence capitals count now, and words from your own category can never
become brands. The same run quoted a cookie banner and a "keep exploring as a member" upsell.

**Run 5.** A rule that sounded obviously right turned out to be wrong, and this is the useful one.
"A page that names its own brand more often than any vendor it covers is that vendor's marketing
page" rejected 22 of 33 pages, including TechRadar, KDnuggets, GitHub and DesignRush, because every
site repeats its own name in nav, breadcrumbs and footer more than it names any single vendor. It
was reverted. The narrower rule that survived only fires when the site's own brand leads the page
title, which publishers do not do and vendors do.

Two things about AnyAPI itself, both transient and both worth knowing if you run this: during run 1
`google.ai_overview` returned 502 on 8 of 8 calls and `gemini.brand_visibility` on 7 of 8, each in
under 200 milliseconds, and everything recovered within minutes. And a call that fails appears to
leave its idempotency key held, so re-running the identical body under the same key inside the
replay window returned `409 idempotency_in_progress` rather than retrying the work.

## The honest limits of this proof

- The engines are not stable between runs. Six runs against the same eight questions produced
  between 108 and 142 cited URLs and between 0 and 15 passing drafts. Treat any single run as one
  sample.
- No Gmail draft was created by this run, so "the draft lands in your Gmail" is verified against the
  Gmail node's documented behaviour and its source code. There is no screenshot of my inbox here.
- The pro tier's three model steps were not exercised. There is no OpenRouter credential on the
  machine that produced this proof, and the lite tier runs the identical discovery, ownership,
  roundup, contact, verification and gate path without one.
- A verified address means the mailbox accepts mail. It does not mean the person still works there.
- The run proves the workflow finds pages, proves they are pitchable and writes accurate drafts. It
  does not prove any editor said yes, and it cannot prove a placement changed an engine's answer.
  The only way to know that is to re-run the same buyer questions later and compare.

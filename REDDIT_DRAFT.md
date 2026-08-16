# I automated the outreach that gets you into AI answers

Getting ChatGPT to recommend you isn't about your website. When someone asks it for the best tool in
your category, it cites a handful of other people's pages and recommends whoever's named on them.
Finding those pages is easy. Getting onto them is the work.

So I built an n8n workflow that does the middle of that job and stops before the part that should
stay human.

What it does:

1. Takes your site, your category and your competitors from a form, plus a spend ceiling.
2. Scrapes your site and builds the buyer questions people actually type: "best X tools",
   "alternatives to <rival>", "<rival> vs <rival>".
3. Sends every question to ChatGPT, Perplexity, Gemini and Google AI Overviews.
4. Scores every cited URL by how many distinct (question, engine) pairs cite it. A page three
   engines cite for two questions is structurally trusted. A page one engine cited once is a fluke.
5. Drops everything you can't pitch: your own pages, rival-owned pages, vendors' own product pages,
   and platforms where listings aren't an editorial decision.
6. Reads each surviving page and requires two different vendors named on it, because one brand is a
   product page and a roundup is plural by definition.
7. Finds the human: the mailto already on the page, then two contact pages, then a paid lookup.
   Verifies the address. Refuses free providers, off-domain addresses and `noreply` variants.
8. Writes a pitch that quotes a line from their page, runs twelve deterministic checks on it, and
   then creates a **Gmail draft**.

It never sends. That's deliberate. A giveaway workflow that emails strangers on a few hundred
people's behalf is one bad output away from a mess nobody can recall. So it writes drafts into your
own Gmail, and you press send or you don't.

**One real run, against my own site, lite tier, no LLM anywhere in it:**

- 8 buyer questions, 32 engine calls, 3 of them failed
- **0 of 21 answers mentioned us. 0 cited us.** That's the before-picture
- 130 cited URLs harvested
- 63 owned by a competitor, 18 a vendor's own product page, 17 a platform: **32 left to pitch**
- 32 pages read, 1 rejected as not a real roundup
- 15 contacts found, 16 pages with no contact anywhere
- 12 addresses verified
- 12 pitches written, **5 passed all twelve gates**, 7 rejected
- **$0.155420 across 122 calls, 23 minutes**

Here's one of the five, exactly as it came out:

    To: [address]@searchcans.com
    Subject: AnyAPI for "Comparing SerpApi, Apify, and Bright Data for Web Scraping in 2026"

    Hi there,

    I was checking which pages come up when people ask an AI assistant for the best scraping
    API, and yours is one of them: https://searchcans.com/blog/serpapi-apify-bright-data-comparison

    This line is what made me write:

    "SerpApi, Apify, and Bright Data represent three distinct philosophies in the web scraping
    and data extraction space, each with a core architectural focus that dictates its strengths
    and ideal use cases."

    You already cover Apify there, and AnyAPI solves the same problem for the same reader.

    [...]

The quoted line has to appear literally in the page text the writer was shown, or no draft gets
created. Same for the vendor named, the recipient's domain matching the page's domain, and no
invented URLs. Seven of the twelve pitches died on those checks, which is the gate doing its job.

Three bugs that cost me real runs, in case they save you one:

**n8n's retry does nothing on an HTTP node that sets `neverError`.** I set it so the workflow could
read status codes and tell an empty answer from a failure. It also switches `retryOnFail` off,
because n8n only retries when a node throws or when the *first* output item carries an error. One
run lost 19 of 28 page scrapes to a 70-millisecond 502 that cleared minutes later, and the retry I
thought I had never fired. The fix is a visible retry branch on the canvas.

**`email.verify` doesn't return what the schema example says.** I coded the gate for `valid` and
`deliverable`. It returns `good`, `risky` and `bad` with a `catchAll` flag. So a `good` address
scoring 100 got thrown away along with every catch-all publisher, and a run with 7 verified
addresses produced 0 drafts.

**`/^(hi|hey|hello|dear)\s+[A-Z][a-z]+/im` matches "Hi there,".** The `i` flag makes `[A-Z]` match
lowercase too, so the anti-hallucination check that refuses to greet a person you can't name
rejected 8 perfectly good anonymous drafts.

And one that never made it in: do not build the reply watcher on the Gmail trigger. Above
typeVersion 1.2 it discards messages carrying the `SENT` label unless they also carry `INBOX`, so it
can never see you sending. A daily `thread:get` answers sent, replied and due in one call instead.

Honest limitation: this finds the pages models cite today and drafts the pitch. It can't make an
editor say yes, and it can't prove a placement changed an engine's answer. The only way to know that
is to re-run the same buyer questions later and compare, which costs three visibility calls per
question.

Free, MIT, inactive on import, no credentials in the export. Three JSONs: the full version, a lite
version with zero LLM calls, and the daily follow-up drafter.

https://github.com/getanyapi-com/n8n-geo-outreach-engine

Disclosure: I work on AnyAPI, which is the gateway the HTTP nodes call for the engine, scraping and
email-verification steps. A new key starts with $0.10 of credit and the run above cost $0.155420, so the
free credit covers most of one.

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
3. Sends every question to ChatGPT, Perplexity and Google AI Overviews.
4. Scores every cited URL by how many distinct (question, engine) pairs cite it. A page three
   engines cite for two questions is structurally trusted. A page one engine cited once is a fluke.
5. Drops everything you can't pitch: your own pages, rival-owned pages, vendors' own product pages,
   and platforms where listings aren't an editorial decision.
6. Reads the home page of every domain left and asks whether that site sells something a buyer with
   your questions would consider. If it does, it's a competitor, and it's dropped.
7. Reads each surviving page and requires two different vendors named on it, because one brand is a
   product page and a roundup is plural by definition.
8. Finds the human: the mailto already on the page, then two contact pages, then the domain's
   published editor, then a paid lookup. Verifies the address. Refuses free providers, off-domain
   addresses and `noreply` variants.
9. Writes a pitch, runs thirteen deterministic checks on it, and then creates a **Gmail draft**.

It never sends. That's deliberate. A giveaway workflow that emails strangers on a few hundred
people's behalf is one bad output away from a mess nobody can recall. So it writes drafts into your
own Gmail, and you press send or you don't.

**One real run, against my own site:**

- 17 buyer questions, 51 engine calls, 3 of them failed
- **0 of 39 answers mentioned us. 0 cited us.** That's the before-picture
- 471 cited URLs harvested, 517 pages considered
- 94 owned by a competitor, 31 a vendor's own product page, 58 a platform
- 184 sites read to judge who runs them: **106 turned out to be competitors**
- 104 pages read, 65 rejected as not a real roundup
- 15 contacts on the page itself, 4 from a contact page, 6 bought; 14 pages with none
- 19 addresses verified
- 19 pitches written, **17 passed all thirteen gates**
- **$0.555590 across 450 calls, 12 minutes**

Here's one of the seventeen, exactly as it came out:

    To: folks@folk.app
    Subject: AnyAPI for your 13 Best LinkedIn Data Scrapers list

    Hi Simo,

    I'm Kevin Wang from AnyAPI, access 327 scraping and data APIs behind one key with automatic
    failover and pay-per-request billing from a prepaid USD wallet with no subscription or idle
    fees.

    I came across your piece "13 Best LinkedIn Data Scrapers (2026 List)" and thought AnyAPI
    could be a relevant addition for your readers - you detail extracting profile data from Sales
    Navigator lists and Chrome extensions but don't cover API options that fit B2B lead
    enrichment without subscriptions.

    Would this be something you would be open to?

    Best,
    Kevin Wang
    Founder @ AnyAPI
    https://getanyapi.com

The model writes two things there: the subject and the one clause after the dash. Everything else is
placed by code, because three runs in a row lost every draft to the model forgetting a different
part of the email it had been asked to assemble.

It also has to return a run of at least forty characters copied character for character out of the
page, or no draft is created. That quote isn't printed - the editor doesn't need their own sentence
read back to them - but it's kept in the workbook so you can see what each draft was grounded in.

Bugs that cost me real runs, in case they save you one:

**n8n's retry does nothing on an HTTP node that sets `neverError`.** I set it so the workflow could
read status codes and tell an empty answer from a failure. It also switches `retryOnFail` off,
because n8n only retries when a node throws or when the *first* output item carries an error. One
run lost 19 of 28 page scrapes to a 70-millisecond 502 that cleared minutes later, and the retry I
thought I had never fired.

**n8n fires every item on a node at once, and they all share one timeout.** On a node carrying a few
hundred pages the last requests sit in the connection queue burning their own clock before the
server ever sees them. A run died with `This operation was aborted` at about 300 concurrent scrapes,
having completed 146 calls cleanly earlier in the same run. `batching` on the node fixes it.

**`email.verify` doesn't return what the schema example says.** I coded the gate for `valid` and
`deliverable`. It returns `good`, `risky` and `bad` with a `catchAll` flag. So a `good` address
scoring 100 got thrown away along with every catch-all publisher, and a run with 7 verified
addresses produced 0 drafts.

**`/^(hi|hey|hello|dear)\s+[A-Z][a-z]+/im` matches "Hi there,".** The `i` flag makes `[A-Z]` match
lowercase too, so the check that refuses to greet a person you can't name rejected 8 perfectly good
anonymous drafts.

And one that never made it in: do not build the reply watcher on the Gmail trigger. Above
typeVersion 1.2 it discards messages carrying the `SENT` label unless they also carry `INBOX`, so it
can never see you sending. A daily `thread:get` answers sent, replied and due in one call instead.

The one I'd most want back: telling the model your category as a phrase doesn't define your market.
Mine was "unified data api", so a company whose home page reads "Fully-Managed Web Scraping
Services" got judged an independent publisher, and the run wrote a polite request to be listed to a
direct competitor. It now sees the buyer questions instead, because a site is a competitor exactly
when someone asking one of them would consider it.

Honest limitation: this finds the pages models cite today and drafts the pitch. It can't make an
editor say yes, and it can't prove a placement changed an engine's answer. The only way to know that
is to re-run the same buyer questions later and compare. The engines aren't stable between runs
either - the same site produced between 108 and 503 cited URLs across development runs, so treat any
single run as one sample.

Free, MIT, inactive on import, no credentials in the export. Two JSONs: the prospector and the daily
follow-up drafter.

https://github.com/getanyapi-com/n8n-geo-outreach-engine

Disclosure: I work on AnyAPI, which is the gateway the HTTP nodes call for the engine, scraping,
contact-finding and email-verification steps. A new key starts with $0.10 of credit and the run
above cost $0.555590, so you'll need to top up for a full run.

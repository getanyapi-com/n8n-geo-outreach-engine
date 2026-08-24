# Submitting this to the n8n template library

Everything below is ready to paste. Nothing here needs editing except where marked.

## Where

Creator hub: <https://n8n.io/creators/> - sign in with the same account as your n8n Cloud login, then
**Submit a template**. Templates are reviewed by n8n before they appear at n8n.io/workflows.

Submit **one** template: `geo-outreach-prospector.workflow.json`. The follow-up drafter is a second
workflow that only makes sense once the first has produced drafts, so it belongs in the repo and in
the description, not as its own listing competing with the main one.

## Before you paste anything

1. Import `geo-outreach-prospector.workflow.json` into your own n8n and run it once end to end.
   n8n's reviewers do run templates, and a template whose first node errors gets rejected.
2. Re-export **after** removing your credentials, or export from a fresh import. The file in this
   repo is already clean - `npm run verify` fails if it ever contains a `credentials`, `pinData` or
   `webhookId` key, or a real Data Table id - so re-exporting a configured copy is the only way to
   leak something. Run `npm run verify` on whatever you upload.
3. Replace the five `YOUR_DATA_TABLE_ID` placeholders back in if your working copy has real ids.

## Title

```
Find the pages AI answer engines cite for your category and draft outreach to their editors
```

## Short description

```
Ask ChatGPT, Perplexity and Google AI Overviews your buyers' questions, harvest every page they
cite, drop the ones you can't be added to, find the editor, and write a Gmail draft. It never sends.
```

## Long description

```markdown
When someone asks an assistant for the best tool in your category, it doesn't read your website and
form an opinion. It reads a handful of other people's pages and recommends whoever is named on them.
So the useful question isn't "where do I rank", it's "which pages does the model quote, and am I on
them".

This workflow answers both halves and stops before the part that should stay human.

**What it does**

1. One form: your site, your category, your competitors, a spend ceiling.
2. Scrapes your site and builds the buyer questions your customers actually type, throwing away any
   proposed question that isn't recommendation-shaped, doesn't mention your category, or names you.
3. Sends every question to ChatGPT, Perplexity and Google AI Overviews.
4. Scores each cited URL by how many distinct (question, engine) pairs cite it. A page three engines
   cite for two questions is structurally trusted; a page one engine cited once is a fluke.
5. Drops what you can't pitch: your own pages, rival-owned pages, and platforms where listings
   aren't an editorial decision.
6. Reads the home page of every remaining domain and asks whether that site sells something a buyer
   with your questions would consider. If it does, it's a competitor, and it's dropped. This is the
   step that stops the workflow politely asking a rival to list you.
7. Requires two different vendors named on a page before treating it as a roundup, because one brand
   is a product page and a roundup is plural by definition.
8. Finds the human: the mailto already on the page, then contact pages, then the domain's published
   editor, then a paid lookup. Verifies the address. Refuses free providers, off-domain addresses
   and noreply variants.
9. Writes the pitch, runs thirteen deterministic checks on it, and creates a **Gmail draft**.

**It never sends.** There is no message:send to a prospect anywhere in it. The only thing it emails
is the run summary, to you. You read the drafts and press send, or you don't.

**What you need**

- An AnyAPI key for the engine, scraping, contact-finding and verification calls (one key, one
  wallet, billed per request in USD). New keys start with $0.10 of credit; a full run is more than
  that, so top up first.
- An OpenRouter credential for the four model steps.
- A Gmail OAuth2 credential.
- Five n8n Data Tables, listed in the workflow's own sticky notes.

**A measured run against my own site**

17 buyer questions, 51 engine calls, 471 cited URLs, 517 pages considered. 94 belonged to a
competitor. Of the 184 sites read to judge who runs them, 106 turned out to be selling in the same
category. 104 pages read, 19 addresses verified, 17 drafts. $0.555590 of API spend, 12 minutes.

Zero of 39 answers mentioned my product, which is the before-picture the whole thing exists to
change.

Full method, every refusal and every bug that cost a run:
https://github.com/getanyapi-com/n8n-geo-outreach-engine

**Companion workflow**

A daily follow-up drafter is in the same repo. It reads each thread rather than watching the Gmail
trigger, because above typeVersion 1.2 that trigger discards messages carrying the SENT label unless
they also carry INBOX, so it can never see you sending.
```

## Categories and tags

n8n asks for these on the submission form. The closest fits:

- **Categories:** Sales, Marketing, AI
- **Tags:** `outreach`, `seo`, `geo`, `ai-search`, `gmail`, `web-scraping`, `lead-generation`

## The disclosure line

The workflow's HTTP nodes call AnyAPI, which you work on. n8n does not forbid that, but an
undisclosed vendor workflow is the fastest way to get a template pulled. The long description above
names AnyAPI plainly under "What you need". Leave that in.

## What reviewers tend to check

- Imports cleanly with no missing node types. This one uses 13 node types, all core or official
  LangChain nodes, no community nodes.
- Sticky notes explain the bands. There are 8, one per stage.
- No credentials, no personal data, no hardcoded ids in the export.
- The description says what it needs before you can run it.

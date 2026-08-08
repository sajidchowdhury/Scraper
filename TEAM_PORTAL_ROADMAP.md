# Team Sales Portal — Roadmap (Phase 4 & 5, Reframed)

> **Status:** Planning document. No code yet.
> **Audience:** The builder (you) + the agent (me) that will implement it phase-by-phase.
> **Replaces:** The SaaS-oriented Phase 4 & 5 in `SCRAPER_FEATURES.md` (kept as a historical record of what we *could* have built, but are deliberately *not* building).

---

## 0. Why This Document Exists

The original `SCRAPER_FEATURES.md` Phase 4 ("Client Delivery & Monetization") and Phase 5 ("Enterprise & World-Class") were written for a **scraper-as-a-service SaaS** — client self-serve dashboards, Stripe billing, public REST API, white-label, reseller tiers, SOC 2, etc.

**We are not building that.** This is an **internal tool for our own team**. One scraper, one Postgres database, one web portal, used by ~3–5 people who sit together (physically or remotely) and turn scraped business listings into paying customers.

Everything in the old Phase 4/5 that smells like "sell to outsiders" — billing, API keys, client accounts, credit packages, white-label, reseller, SOC 2 — is **out of scope** and will not appear here. What remains is the part that actually matters to us: a visual portal where the team can work leads through a real sales pipeline instead of typing scraper commands in a terminal.

---

## 1. The Target Workflow (what the team actually does every day)

This is the 7-step process we are building the portal around. Every feature in Phase 4 & 5 must serve one of these steps.

| Step | Who | What they do | Where (in the portal) |
|------|-----|--------------|-----------------------|
| 1 | **Fetcher** (Member A) | Runs a scrape: picks query + location, launches the job, watches it finish, pushes the fresh businesses into the **lead pool**. | *Scrape* tab |
| 2 | **Qualifier** (Member B) | Opens the fresh lead pool, reviews each new business, studies the enrichment data (website gaps, low rating, no email, spam flags, lead score, confidence) to figure out **how this business could become a customer of ours**, marks the promising ones as **Priority**, starts calling, logs each call + outcome. | *Qualify* tab |
| 3 | **Qualifier** (Member B) | When a call goes well and the prospect sounds open, flips the lead status to **Ready to Talk** and hands it off. | *Qualify* tab → status change |
| 4 | **Rep** (Member C) | Opens the *Ready to Talk* queue. Sees only those leads. For each, reads the auto-generated **talking points** (built from enrichment data — "they have no website", "their rating dropped to 3.1", "competitor X just opened next door", etc.) so the meeting opens with a sharp angle. | *Meet* tab |
| 5 | **Rep** (Member C) | Has the meeting (call / visit / video). Logs **meeting notes**: what was discussed, objections, objections handled, next step, follow-up date. | *Meet* tab → lead detail → meeting notes |
| 6 | **Rep** (Member C) | After the meeting, marks the outcome: **Won** (became a customer), **Lost / Dead End** (not interested, unreachable, out of business), or **Nurturing** (needs more follow-up — loops back to step 4). | *Meet* tab → outcome selector |
| 7 | **Anyone** | Dashboards + reports show pipeline health, rep activity, conversion rate, where leads are stalling. | *Dashboard* tab |

> **One sentence summary:** Scrape → Qualify → Prioritize → Call → Hand off → Meet → Win or kill. The portal's only job is to make this loop fast and visible.

---

## 2. Architecture (one paragraph + one diagram)

The scraper (Phases 1–3, already shipped) writes enriched businesses into the shared Postgres `businesses` table. The new **portal** is a separate Next.js app that reads from that same database, treats each business row as a **lead**, and adds CRM tables on top (`leads`, `lead_statuses`, `call_logs`, `meeting_notes`, `talking_points`, `users`, `team_roles`). The scraper and the portal never call each other — they share data through Postgres. The portal is the only thing the team touches day-to-day; the scraper is run from inside the portal's *Scrape* tab (a button that shells out to the existing CLI) so nobody opens a terminal again.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Shared PostgreSQL                        │
│  ┌──────────────────────┐         ┌──────────────────────────┐  │
│  │ businesses (Phase 1-3)│ ◄────── │  leads + CRM tables (P4) │  │
│  │  + enrichment columns │  1:1    │  (status, notes, calls,  │  │
│  │  (scraper writes)     │  link   │   meetings, talking pts) │  │
│  └──────────────────────┘         └──────────────────────────┘  │
│        ▲                                    ▲                    │
│        │                                    │                    │
│  ┌─────┴──────────┐                ┌────────┴─────────┐          │
│  │  Node Scraper   │                │  Next.js Portal   │          │
│  │  (Phases 1-3)   │                │  (Phase 4-5)      │          │
│  │  CLI / Playwright│               │  Team UI          │          │
│  └─────────────────┘                │  - Fetcher view   │          │
│  Run from portal's                  │  - Qualifier view │          │
│  Scrape tab (shell out)             │  - Rep view       │          │
│                                     │  - Dashboards     │          │
│                                     └───────────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

**Tech stack (locked):**
- **Portal:** Next.js 16 (App Router) + TypeScript + Tailwind + shadcn/ui (already scaffolded at `/home/z/my-project`).
- **ORM:** Prisma, pointing at the **same** Postgres instance the scraper uses (`postgresql://gmaps:gmaps@localhost:5434/gmaps_scraper`).
- **Auth:** NextAuth.js v4 (already in the stack) — local credentials only, no OAuth, no signup. Admin creates team accounts.
- **Real-time:** socket.io mini-service for live scrape-job progress (already a pattern in the repo's `mini-services/` folder).
- **AI (talking points):** the `z-ai-web-dev-sdk` LLM skill, called from a portal API route, fed the enrichment data for a lead.

**Explicitly NOT in the stack:** Stripe, public API keys, client accounts, multi-tenant isolation, email marketing, white-label, reseller, OAuth providers, Kubernetes, Kafka, SOC 2.

---

## 3. Roles & Permissions (simple, 4 roles)

| Role | Sees | Can do |
|------|------|--------|
| **Admin** | Everything | Manage users, run scrapes, edit any lead, view all dashboards |
| **Fetcher** (Member A) | Scrape tab + lead pool (read) | Launch scrape jobs, push results to lead pool, fix bad imports |
| **Qualifier** (Member B) | Lead pool + Qualify tab + their own call logs | Claim leads, change status New→Priority→Ready to Talk, log calls, write notes |
| **Rep** (Member C) | Ready-to-Talk queue + Meet tab + their own meeting notes | Claim Ready-to-Talk leads, log meetings, set outcome Won/Lost/Nurturing |

One person can hold multiple roles (small team). Roles are a per-user flag in the `users` table, not a complex RBAC system.

---

## 4. Phase 4 — Team Portal Foundation

> **Goal of Phase 4:** Replace the terminal. The team logs into a web app, the Fetcher launches scrapes from a button, and everyone can browse the lead pool with full enrichment data. No sales workflow yet — that's Phase 5.
>
> **Phase 4 total: ~8 sessions.**

### 4.0 — Portal scaffolding, auth, DB schema, shared connection
**What:** Stand up the Next.js app, wire NextAuth (local credentials, 4 hardcoded roles to start), create the Prisma schema for the CRM tables (`User`, `Lead`, `LeadStatus`, `CallLog`, `MeetingNote`, `TalkingPoint`), connect to the scraper's existing Postgres so `businesses` is readable. Build the app shell: sidebar nav (Scrape / Leads / Qualify / Meet / Dashboard), top bar with logged-in user + role, sticky footer.
**Exit criteria:** Admin can log in, sees the shell, the `businesses` table row count shows on the Dashboard tab.
**Sessions: 2**

### 4.1 — Scrape tab (Fetcher's home)
**What:** A form (query, location, maxResults, deepScrape toggle, enrich toggle) that shells out to `node src/index.js ...` via a portal API route. Live progress via socket.io (parses the scraper's JSON-lines log and streams progress lines to the UI). On job completion, a one-click "Push to lead pool" button creates a `Lead` row for every new `businesses` row (linked by `place_id`) that doesn't already have one.
**Exit criteria:** Fetcher can launch a 100-business scrape from the browser, watch it progress, and the new businesses appear in the Leads tab as fresh leads (status = `New`).
**Sessions: 2**

### 4.2 — Leads tab (lead pool, everyone read-only except Qualifier)
**What:** A server-side-paginated table of all leads with: name, category, phone, website, lead_score, confidence, status, assigned_qualifier, assigned_rep, last_activity_at. Filters: status, category, lead_score band, confidence band, has-website / no-website, has-email / no-email, assigned-to-me. Search by name/phone/place_id. Sort by any column. Export current filter to CSV (reuse the scraper's export logic).
**Exit criteria:** A qualifier can filter "New leads, no website, lead_score ≥ 70, in Toronto" and get a focused list in under 2 seconds.
**Sessions: 2**

### 4.3 — Lead detail drawer
**What:** Click any lead → a right-side drawer (or full-page view) showing everything about that business in one scroll: identity (name, address, maps_url, place_id), contact (phone_e164, phone_type, email, email_status, website), enrichment (chain_result, spam_result, tech_stack, sentiment_score, competitor_density, geo), reviews (top_reviews with sentiment), and — empty for now — placeholders for Call Log, Meeting Notes, Talking Points (filled in Phase 5). This is the single screen both Qualifier and Rep live in.
**Exit criteria:** Opening a lead shows all 25+ Phase 3 enrichment fields in a clean, scannable layout. No data entry yet.
**Sessions: 1**

### 4.4 — Role-based dashboard landing
**What:** The Dashboard tab shows different cards based on role: Fetcher sees recent scrape jobs + total businesses; Qualifier sees "New leads waiting", "My active leads", "Priority leads"; Rep sees "Ready to talk", "My meetings this week", "Won this month". Admin sees all of it plus team activity. Pure read views — no actions yet beyond links to the relevant tabs.
**Exit criteria:** Each role's dashboard loads in under 1 second and shows the right counts.
**Sessions: 1**

**Phase 4 exit (end of ~8 sessions):** The terminal is retired. The team works entirely in the browser. But there's no sales workflow yet — leads are just "New" forever. Phase 5 adds the workflow.

---

## 5. Phase 5 — Sales Pipeline & Collaboration

> **Goal of Phase 5:** Move leads through the real pipeline (New → Priority → Ready to Talk → Meeting → Won/Lost/Nurturing), generate talking points, log calls and meetings, and show pipeline health. After Phase 5, the 7-step workflow from §1 is fully realized.
>
> **Phase 5 total: ~9 sessions.**

### 5.0 — Lead status machine + status history
**What:** Define the canonical status enum (`New`, `Under Review`, `Priority`, `Ready to Talk`, `Meeting Scheduled`, `Won`, `Lost`, `Nurturing`, `Dead End`) with allowed transitions (e.g. `New → Under Review → Priority → Ready to Talk`, any → `Won/Lost/Dead End/Nurturing`). Add a `lead_statuses` table that logs every transition (who, when, from, to, optional note). Build the status-change control in the lead detail drawer with a dropdown + reason field. Enforce transition rules server-side.
**Exit criteria:** A qualifier can move a lead New → Priority → Ready to Talk, and the full history is visible in the lead detail. Illegal transitions (e.g. `Won → New`) are rejected with a clear error.
**Sessions: 2**

### 5.1 — Qualifier workspace (Member B's home)
**What:** A dedicated *Qualify* tab showing only leads in `New` / `Under Review` / `Priority` statuses, sorted by lead_score descending. "Claim" button assigns the lead to the current user. Inline call-log form: outcome dropdown (no-answer / left-voicemail / talked / callback-scheduled / wrong-number), free-text notes, callback date. Calls create `CallLog` rows linked to the lead. A "Mark Priority" shortcut button + a "Move to Ready to Talk" button with a required handoff note (what the rep needs to know). The qualifier's dashboard card now shows "my callback queue" for today.
**Exit criteria:** A qualifier can work through 20 new leads in a sitting: claim, call, log, mark priority or ready-to-talk, without leaving the tab.
**Sessions: 2**

### 5.2 — Talking Points engine (AI-generated)
**What:** For each lead, a portal API route calls the LLM skill (`z-ai-web-dev-sdk`) with a structured prompt built from the enrichment data: "This is {name}, a {category} in {city}. Rating {rating} ({reviews} reviews). {Has/No} website. {Has/No} email. Tech stack: {tech}. Sentiment: {score}. Competitors within 1km: {count}. Spam risk: {level}. Lead score: {score}/100. Generate 3 sharp talking points for a sales call — each one a specific angle based on the data, not generic advice." Cache the result in `talking_points` (regenerate when enrichment data changes). Display in the lead detail under a "Talking Points" section. Rep can mark each point as "used / resonated / flopped" for feedback into the prompt over time.
**Exit criteria:** A rep opening a Ready-to-Talk lead sees 3 data-grounded talking points within 2 seconds (cached) or ~8 seconds (first generation).
**Sessions: 2**

### 5.3 — Rep workspace (Member C's home)
**What:** A dedicated *Meet* tab showing only leads in `Ready to Talk` / `Meeting Scheduled` statuses assigned to (or claimable by) the current rep. Each lead card shows: name, why-they're-here (the qualifier's handoff note), the 3 talking points, last call summary, and a "Schedule meeting" form (date, type: call/visit/video, prep notes). Scheduled meetings appear on a simple agenda view (today / this week). Meeting time triggers status → `Meeting Scheduled`.
**Exit criteria:** A rep can open their queue, pick a lead, see everything they need to walk into the meeting cold, and log the meeting date.
**Sessions: 2**

### 5.4 — Meeting notes & outcome marking
**What:** After a meeting, the rep opens the lead and fills the meeting-note form: attendees, what-was-discussed (free text + structured objection tags), outcome (Won / Lost / Nurturing / Follow-up Needed), next-step + next-step-date, dollar value if Won. Outcome change triggers the status machine (`Won` / `Lost` / `Nurturing`). Won leads get a closed-won date + optional deal-size field. Lost leads require a reason (price / competitor / not-interested / unreachable / out-of-business). Multiple meeting notes per lead are allowed (the relationship history). All notes are visible to admins and the assigned qualifier (handoff visibility).
**Exit criteria:** A rep can log a meeting, mark Won with a deal size, and the lead moves to the Won list on the dashboard. The qualifier who originally worked it can see the outcome.
**Sessions: 1**

### 5.5 — Pipeline dashboards & team reports
**What:** A *Reports* tab (admin + everyone read-only) with: pipeline funnel (New → Priority → Ready → Meeting → Won, with counts + conversion % at each stage + median time-in-stage), rep activity (calls logged / meetings held / won, per rep, per week), lead source breakdown (which queries/locations produce the best leads), stall report (leads sitting in a stage > X days), and a simple Won-revenue chart. CSV export of any report. No fancy charting library — reuse the shadcn/ui + Tailwind patterns + a lightweight chart component (Recharts is fine, already common in Next.js projects).
**Exit criteria:** An admin can answer "which rep is converting best?" and "which scrape query produced the most paying customers?" in under 30 seconds from the Reports tab.
**Sessions: 2**

**Phase 5 exit (end of ~9 sessions):** The full 7-step workflow from §1 runs end-to-end in the portal. A business goes from a search on Google Maps to a Won deal without anyone ever opening a terminal, a spreadsheet, or a separate notes app.

---

## 6. Session Budget Summary

| Phase | Sub-phase | What | Sessions |
|-------|-----------|------|----------|
| **4** | 4.0 | Portal scaffolding, auth, DB schema, app shell | 2 |
| **4** | 4.1 | Scrape tab (launch jobs, live progress, push to leads) | 2 |
| **4** | 4.2 | Leads tab (filter/search/sort/export) | 2 |
| **4** | 4.3 | Lead detail drawer (all enrichment data) | 1 |
| **4** | 4.4 | Role-based dashboard landing | 1 |
| | | **Phase 4 subtotal** | **8** |
| **5** | 5.0 | Lead status machine + history | 2 |
| **5** | 5.1 | Qualifier workspace (claim, call log, priority, handoff) | 2 |
| **5** | 5.2 | Talking Points engine (LLM from enrichment data) | 2 |
| **5** | 5.3 | Rep workspace (Ready-to-Talk queue, meeting scheduling) | 2 |
| **5** | 5.4 | Meeting notes & outcome (Won/Lost/Nurturing) | 1 |
| **5** | 5.5 | Pipeline dashboards & team reports | 2 |
| | | **Phase 5 subtotal** | **9** |
| | | **Grand total** | **~17 sessions** |

> **How to read "sessions":** one session = one conversation with me (Z.ai) from kickoff to a committed, pushed, verified increment. A 2-session sub-phase means we'll likely split it across two conversations (e.g. session 1 = schema + backend + API, session 2 = UI + agent-browser verification + polish). Sessions can compress if context allows — the numbers above are a realistic planning estimate, not a hard cap.

---

## 7. What "Done" Looks Like (the end state after Phase 5)

- **No one on the team uses the terminal.** The scraper is launched from a button in the portal.
- **A new business scraped at 9 AM is being called by a qualifier by 9:15 AM.**
- **A qualifier marks a lead "Ready to Talk" at 2 PM; a rep opens the meeting with 3 sharp, data-grounded talking points at 3 PM.**
- **The rep logs the meeting, marks Won, and the deal shows up on the dashboard funnel by 4 PM.**
- **At the end of the week, the admin opens Reports and sees: 500 leads scraped, 120 qualified, 40 ready-to-talk, 18 meetings held, 6 won, $X revenue. Every number clickable down to the underlying leads.**
- **The whole thing runs on one machine (or one small VPS), used by 3–5 people, costing nothing in SaaS fees.**

---

## 8. Explicitly Out of Scope (what we are NOT building)

To keep the team focused and the session budget honest, these are deliberately excluded from Phase 4 & 5. Any of them can become a Phase 6 later if the team genuinely needs it.

| Excluded | Why |
|----------|-----|
| Client / customer accounts | Internal tool. The "customers" are the businesses we sell *to*, not users of this portal. |
| Billing, Stripe, credits, invoices | We're not selling the scraper. We're using it. |
| Public REST API + API keys | No external developers. The portal's internal API routes are enough. |
| Multi-tenant isolation | One team, one database. |
| White-label / reseller / branded subdomains | Not a product for resale. |
| OAuth / Google login / SSO | Local credentials are fine for 5 people. |
| Email marketing / drip campaigns | Out of scope; the team calls, doesn't mass-email. |
| Mobile native apps | Responsive web is enough. |
| Kubernetes / distributed workers / Kafka | One machine runs the scraper + portal + Postgres. |
| SOC 2 / ISO 27001 / GDPR DPA endpoints | Internal tool, not enterprise sales. |
| Real-time delta feeds / webhooks to external systems | No external systems to feed. |
| LLM-based DOM extraction (Phase 5.5 in the old roadmap) | The scraper's self-healing selectors already handle this. |
| Multi-source federation (Yelp / Facebook / LinkedIn / OSM) | Google Maps is enough for v1. |

---

## 9. How We'll Execute (operating rules for the build)

1. **One sub-phase per session (usually).** We'll start each session by confirming which sub-phase we're tackling, end it with a commit pushed to `origin/main` and an agent-browser verification.
2. **Backend before frontend, but show the frontend fast.** Within each sub-phase: schema + API route first, then UI, then verify in the browser. The user should see something visual within the first third of every session.
3. **Reuse the scraper's database.** The portal's Prisma schema points at the same `gmaps_scraper` Postgres. We add tables, we never modify the scraper's `businesses` table structure (the scraper keeps owning it).
4. **No new big dependencies without a conversation first.** Recharts for charts is pre-approved. Anything heavier (e.g. a full CRM library) gets discussed before installing.
5. **Every session ends with the worklog updated** at `/home/z/my-project/worklog.md` (the shared agent worklog), a commit on `origin/main`, and a browser-verified screenshot-or-description of what now works.
6. **Tags at phase boundaries.** When Phase 4 completes: tag `v4.0.0-portal`. When Phase 5 completes: tag `v5.0.0-pipeline`. Sub-phases don't get tags, just commits.

---

## 10. Decision Points Before We Start (things to confirm in the kickoff session)

These don't block writing the doc, but should be settled in session 4.0 before coding:

1. **Who are the actual users?** Give me 3–5 names + roles (e.g. "Sajid = Admin + Fetcher, X = Qualifier, Y = Rep"). I'll seed the `users` table with them.
2. **What's "our" product?** The talking-points engine needs to know what we're *selling* to the scraped businesses (web design? POS systems? SEO? insurance?) so the LLM prompt can be angled. "Generic" talking points are much weaker than "you sell websites to businesses that don't have one."
3. **Single machine or VPS?** Affects whether we set up Docker Compose for Postgres + portal + scraper together, or deploy the portal separately.
4. **Phone integration?** Do you want a "click to call" button that fires tel: links, or is copying the number to a physical phone enough for v1? (Default: copy is enough.)
5. **Deal size / revenue tracking?** Do you actually want to track $-won, or just count of Won? (Affects whether 5.4 has a dollar field.)

Once these are answered, session 4.0 can start immediately.

---

**End of roadmap. Next action: you confirm the doc looks right, answer the 5 questions in §10, and I start session 4.0.**

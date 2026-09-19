# TaskPilot

**An AI browser agent that understands what you're trying to accomplish, organizes your browser around that goal, guides you through unfamiliar websites, remembers your workspace, and keeps you focused until the task is done.**

Not a website blocker. Not a thing that tells you where to click.

---

## Quick start

```bash
npm install
npm run build          # -> dist/
```

Load it in Chrome:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select the `dist/` folder
4. Pin TaskPilot and click it, or press <kbd>⌘⇧Y</kbd> / <kbd>Ctrl+Shift+Y</kbd>

The extension works without a backend: tabs group by site, plans and sessions
save and restore. Add the Worker to get the AI behavior.

```bash
cd backend
npm install
npx wrangler secret put OPENAI_API_KEY   # deployed
# for local dev, put it in backend/.dev.vars instead:
#   OPENAI_API_KEY=sk-...
#   TASKPILOT_TOKEN=some-shared-secret
npm run dev            # http://localhost:8787
npm run deploy         # or ship it
```

Then open TaskPilot → **Settings** → set the Worker URL (and token, if you set one).

`npm run watch` rebuilds on change; reload the extension at `chrome://extensions` to pick it up.

---

## The five systems

```
                    USER GOAL
                       │
                       ▼
               ┌──────────────┐
               │ Task Planner │
               └───────┬──────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
     Navigator      Tab Agent    Focus Agent
          │            │            │
          ▼            ▼            ▼
   Website guidance  Workspace   Distraction
                    organization  detection
                       │
                       ▼
                 Session Memory
```

| Where | What lives there |
|---|---|
| `src/sidepanel/` | React UI: Task, Tabs, Sessions, History, Settings |
| `src/background/` | Service worker: tabs, groups, sessions, focus loop, RPC router |
| `src/content/` | DOM extraction, element ids, highlight + banner overlays |
| `src/shared/` | Logic with no Chrome dependency — the part that's unit-tested |
| `shared/api.ts` | The extension ↔ Worker contract, imported by both sides |
| `backend/` | Cloudflare Worker: the five agents, session sync |

### Why tabs are grouped by intent, not domain

The whole point. Instead of `GitHub / YouTube / Google / Docs`, TaskPilot produces
`Build TaskPilot / Prepare Datadog Interview / CS Assignment / Personal`.

`youtube.com/react-tutorial` belongs to your extension project.
`youtube.com/NBA-highlights` belongs to Personal. Same domain, different intent.
Classification uses URL + title + a short page summary + your active task.

### The extension survives a dead backend

Every AI path has a local fallback, because a demo that dies when the network does
is not a demo. Grouping falls back to host heuristics, planning to a generic
4-step plan, "What was I doing?" to local tab/session data. The UI labels these
`offline` rather than pretending.

---

## What it does not do

Hard rules, enforced in code rather than in a prompt:

- **Never closes a tab without approval.** Every destructive action shows a
  confirmation listing exactly what it will affect.
- **Never fills passwords, payment or security fields.** Detected in the DOM
  (`extract.ts`), refused at the insert path, and refused again on the Worker
  before any model call.
- **Never submits a form, sends a message, or makes a purchase.** The Navigator
  highlights; you click. It is told to stop at the step *before* any
  submit/pay/send control.
- **Never overwrites text you already wrote.** Suggestions go into empty fields
  only, after you click Insert, and you can edit the draft first.
- **Does not hard-block distracting sites.** It shows a dismissible card in the
  corner. The overlay host is `pointer-events: none`, so the page underneath
  stays fully usable.

### What reaches the model

Page titles, URLs **stripped of query string and fragment**, and a short summary
built from the meta description and `h1`/`h2` headings — never page body text,
never field values. Mail hosts report as "Gmail" rather than leaking subject
lines. Hosts on your exclude list are never read at all. Your OpenAI key lives on
the Worker; the browser never sees it.

Model output is never trusted: element and tab ids that weren't in the request
are dropped, every tab lands in exactly one group, and anything the model forgot
falls into "Other".

---

## Tests

```bash
npm test          # 30 unit tests
npm run typecheck # extension + backend
```

`src/shared/` and `src/content/extract.ts` are Chrome-free on purpose, so the
interesting logic — duplicate detection, cleanup bucketing, step pointers,
replan merging, DOM extraction — runs in plain vitest/jsdom.

The extractor was also exercised against live pages, which is where the element
budget fix came from (16% of a real Wikipedia page's extracted elements had no
usable label). On a 1156-control page it caps at 150 in ~17 ms.

`demo/application.html` is a realistic internship application form — a safe
target for the Navigator and input suggestions that doesn't send junk to a real
employer.

---

## Sponsor stack

- **OpenAI** — planning, DOM reasoning, tab and distraction classification,
  input drafting, summaries. Strict JSON-schema structured outputs throughout.
- **Cloudflare** — Workers orchestrate the agents; a per-user Durable Object
  holds synced sessions. D1 is wired but optional.
- **Sentry** — wraps the Worker when `SENTRY_DSN` is set; failed DOM selections
  and workflow failures are reported explicitly. Session Replay is deliberately
  off in the side panel, which displays your tab titles.
- **Browserbase** — the intended home for Navigator regression runs against
  unfamiliar sites. Not wired up yet.
- **Composio** — the Actions view reconciles browser/GitHub/Discord context,
  previews an approved issue, pull request, or Discord message, and executes
  through the Worker-side adapter. Without a Composio key, the same flow runs
  as an explicitly labelled deterministic demo.

## Engineering workflow demo

Open TaskPilot → **Actions** → **Analyze task**. The Worker returns evidence
with confidence and flags conflicts or missing repository information. Select
an action to preview the exact GitHub or Discord mutation. Execution requires
the preview id as an approval token; demo mode produces a simulated result and
never contacts an external provider.

For live Composio execution, configure COMPOSIO_API_KEY and optionally
COMPOSIO_BASE_URL as Worker secrets/variables. Provider credentials never enter
the extension.

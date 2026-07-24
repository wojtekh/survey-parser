# Survey Parser → Google Sheet → Dograh Voice Agent

The three essentials, nothing else:

1. **Upload a document → a new Google Sheet gets created for it.** `/` in the browser: upload, parse, review, click "Push to new Google Sheet." Each survey gets its own spreadsheet (shared with you automatically); that spreadsheet's ID *is* the survey's identifier.
2. **One reusable Dograh agent, not one per document.** A single agent with two tools (`get_next_question`, `submit_answer`) handles every survey -- which sheet it's working against is passed in per-call, not baked into the agent.
3. **Responses land back in that survey's Sheet**, in the `responses` tab, one row per answer, as the call happens.

No database. Google Sheets *is* the data store -- one spreadsheet per survey (`questions` tab: one question per row; `responses` tab: `conversation_id`, `question_index`, `question`, `user_response`), plus one fixed "index" spreadsheet that lists every survey ever created, so there's always a place to find the link back to it.

## How the pieces fit

```
you upload a doc
      │
      ▼
Claude parses it → flat list of speakable questions
      │
      ▼
"Push to new Google Sheet" → creates a spreadsheet, shares it with you,
                              writes the questions in, logs it in the index
      │
      ▼
(separately) a call is placed/routed for that survey, passing its
spreadsheet_id as initial_context
      │
      ▼
agent calls get_next_question(spreadsheet_id) → asks it → gets answer
   → calls submit_answer(spreadsheet_id) → repeats until done
                                                                 │
                                                                 ▼
                                                that survey's responses tab fills in
```

## Setup

### 1. Anthropic (parsing)

```bash
cp .env.example .env
```
Add your `ANTHROPIC_API_KEY` (platform.claude.com → Settings → API Keys).

### 2. Google service account

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project (or use an existing one).
2. Enable **both** the Google Sheets API and the **Google Drive API** for that project (Drive API is needed to auto-share each new survey spreadsheet with you -- easy to miss since only Sheets gets used directly for reading/writing).
3. **IAM & Admin → Service Accounts → Create Service Account**, then create a JSON key for it and download it.
4. From that JSON, fill in `.env`: `GOOGLE_SERVICE_ACCOUNT_EMAIL` (the `client_email`), `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` (the `private_key`).

### 3. Index sheet

Create one empty Google Sheet (or reuse any sheet you already have, including a survey sheet from testing) and share it with the service account's email, Editor access. Put its ID in `GOOGLE_INDEX_SHEET_ID`. The `surveys` tab and its header row get created automatically the first time a survey is pushed -- nothing to set up by hand beyond sharing it.

Set `USER_GOOGLE_EMAIL` to your own Google account -- every new survey spreadsheet gets shared with this address automatically so it shows up in your own Drive, not just the service account's.

### 4. Google Calendar (appointment booking) -- optional

Lets a Dograh agent check availability and book appointments directly onto
a Google Calendar mid-call, via two new tools (`check_availability`,
`book_appointment` -- see `dograh/README_TOOLS.md`). Skip this section
entirely if you don't need appointment booking; nothing else in the app
depends on it.

Reuses the same service account from step 2, just with one more API and
one more delegated scope:

1. In the same Google Cloud Console project, enable the **Google Calendar API**.
2. In [Google Workspace Admin](https://admin.google.com/) → **Security → API controls → Domain-wide Delegation**, find the existing entry for this service account's **Client ID** (the numeric OAuth Client ID, not the email -- same one used when Sheets/Drive delegation was set up) and add `https://www.googleapis.com/auth/calendar` to its scopes. This is additive -- don't remove the Sheets/Drive scopes already there, just add the calendar one alongside them, comma-separated.
3. Fill in the calendar-related keys in `.env` (all optional, sensible defaults shown):
   - `GOOGLE_CALENDAR_ID` -- which calendar to book into. `"primary"` (default) books into `USER_GOOGLE_EMAIL`'s own calendar. Set it to a specific calendar's ID (that calendar's Settings → **Integrate calendar** → Calendar ID) to book into a separate, dedicated calendar instead -- share that calendar with the service account's email (or with `USER_GOOGLE_EMAIL`, since delegation impersonates that user) first.
   - `BUSINESS_TIME_ZONE` -- IANA name (e.g. `America/New_York`) business hours and spoken confirmations are interpreted in.
   - `BUSINESS_HOURS_START` / `BUSINESS_HOURS_END` -- 24h clock, in that timezone. Default `9`–`17`.
   - `BUSINESS_DAYS` -- `1`=Monday … `7`=Sunday, comma-separated. Default `1,2,3,4,5`.
   - `APPOINTMENT_DURATION_MINUTES` -- default slot length if the agent doesn't specify one. Default `30`.
   - `APPOINTMENT_TITLE_PREFIX` -- prefixed onto each event's title. Default `"Appointment"`.
4. Follow `dograh/tools-setup.md`'s Tool 5/6 section to create `check_availability` and `book_appointment` in the Dograh dashboard, then attach both to whichever agent(s) should be able to offer booking (can sit alongside the survey tools on the same agent, or live on their own agent). A ready-made standalone booking agent is in `dograh/workflow-definition-booking.json` (dashboard "Upload Agent Definition") / `dograh/create-agent-request-booking.json` (API, per Tool creation instructions above) -- fill in the two `REPLACE_WITH_..._TOOL_UUID` placeholders with the real tool UUIDs first.

Want a second, independent booking line (e.g. a different department or
location with its own calendar and hours)? Copy `lib/googleCalendar.ts` and
its two route files under a new path, point the copy's `GOOGLE_CALENDAR_ID`
/ `BUSINESS_*` env vars at the new calendar -- no changes needed to the
originals.

### 5. Run it locally

```bash
npm install
npm run dev   # http://localhost:3000
```

Upload a document, review the parsed questions, click **Push to new Google Sheet** — you'll get a link to the new spreadsheet, and it'll show up under "Past surveys" on the same page.

### 6. Deploy it (needed before Dograh can reach it)

Dograh's tools call real HTTPS URLs, so `/api/agent/*` needs to be publicly reachable — `localhost` won't work for a live call. Deployed here through Coolify, on the same box that self-hosts Dograh — no new hosting account, and no hand-rolled reverse proxy or cert manager, since Coolify already runs one (Caddy) for everything else on the box.

1. Push this repo to git (GitHub/GitLab/a private Gitea, whatever Coolify's already pulling Dograh from).
2. In Coolify: **New Resource → Application**, point it at this repo, set **Build Pack: Dockerfile**. It'll use the `Dockerfile` in this repo as-is (multi-stage, Next.js "standalone" output — nothing to change).
3. **Environment Variables** tab in the Coolify app settings: paste in every key from `.env.example`, with real values — same as what's in your local `.env`. Don't rely on a checked-in `.env` file; Coolify manages these itself and injects them at build/run time. Leave `.env` out of the repo entirely (it's already gitignored).
4. Set the domain for this app in Coolify (e.g. `survey.yourdomain.com`) — Coolify provisions the Let's Encrypt cert and wires up its proxy automatically once that's set. Nothing to configure in nginx.
5. Deploy. Coolify's build log is where to watch for the same webpack/build behavior you saw locally; once it's up, hit `https://survey.yourdomain.com` to confirm it's reachable.

Updating later is just `git push` — Coolify picks it up (or redeploy manually from its UI if auto-deploy isn't on).

The `docker-compose.yml` and `deploy/nginx-survey-parser.conf.example` in this repo are left in as a fallback for a plain Docker+nginx host — **not needed for the Coolify path above**, and running nginx alongside Coolify's own proxy would just fight it for port 443.

**Before this ever touches a git repo:** double check `.env.example` only has placeholders in it, never real credentials — `.env` (the real one) is gitignored and never committed. Real values live in your local `.env` for dev and in Coolify's Environment Variables tab for prod — never in git, even a private repo.

Set `AGENT_TOOLS_SECRET` to a random string now that it's deployed — see `dograh/tools-setup.md` for where it plugs in.

### 7. Dograh agent (steps 2 and 3, one-time)

1. Follow `dograh/tools-setup.md` to create the two HTTP API tools in the Dograh dashboard, pointing at your deployed `/api/agent/next-question` and `/api/agent/submit-answer` URLs. Both tools now take a `spreadsheet_id` parameter alongside `conversation_id`.
2. Import `dograh/workflow-definition.json` as a new agent. Replace the two `REPLACE_WITH_..._TOOL_UUID` placeholders with the real tool UUIDs from step 1.
3. When triggering or routing a call for a specific survey, pass that survey's spreadsheet ID as `initial_context.spreadsheet_id` (shown to you after pushing a survey, and listed under "Past surveys"). See `dograh/tools-setup.md` for how this flows through.
4. Connect a phone number or use Web Calls to test without a real number first.

Once that's done, this one agent handles every survey permanently — running a new survey is just: upload a new document, push it, use its spreadsheet ID when placing the call.

## What's deliberately not here

- **No retries/idempotency on `submit_answer`** beyond what the Sheets API gives you for free. If a call drops mid-answer, that row just doesn't get written -- there's no partial-completion recovery.
- **No auth on the upload UI itself** — anyone with the URL can create survey sheets. Fine for local/internal use, not for a public deployment without adding something in front of it.
- **No way to delete/archive a survey from the UI** — the index sheet is append-only from the app's side; delete rows or spreadsheets by hand in Google Sheets/Drive if needed.
- **Inbound calls to a fixed phone number can't easily carry a different `spreadsheet_id` per caller** -- this multi-survey design fits outbound/API-triggered calls cleanly, but for inbound you may need one number per active survey, or a lookup step (e.g. ask the caller which survey, or route by DID) -- worth revisiting once you know which calling pattern you actually need.
- **`check_availability`'s slot generator is a fixed-window scan, not a real scheduling engine** -- no buffer time between back-to-back appointments, no per-appointment-type durations, no holidays calendar. Fine for a straightforward single-calendar booking flow; revisit if the business rules get more elaborate.
- **No cancel/reschedule tool** -- `book_appointment` only creates events. Cancelling or moving one currently means doing it by hand in Google Calendar (or deleting the event, which does NOT notify the attendee unless done through Calendar's own UI/API with `sendUpdates`).
- **The book-appointment route re-checks the slot's still free immediately before booking, but there's a few-hundred-ms gap between that check and the event actually being created** -- two callers confirming the exact same slot within that window could both get through. Narrow in practice (needs two simultaneous calls hitting the same slot at the same instant), not eliminated.

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

### 4. Run it locally

```bash
npm install
npm run dev   # http://localhost:3000
```

Upload a document, review the parsed questions, click **Push to new Google Sheet** — you'll get a link to the new spreadsheet, and it'll show up under "Past surveys" on the same page.

### 5. Deploy it (needed before Dograh can reach it)

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

### 6. Dograh agent (steps 2 and 3, one-time)

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

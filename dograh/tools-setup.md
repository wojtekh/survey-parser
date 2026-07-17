# Dograh tool setup (one-time, manual)

Dograh's public API doesn't currently expose tool creation (only agents,
campaigns, runs, telephony configs) -- HTTP API tools have to be created once
in the dashboard. They're generic and reusable across every survey (nothing
survey-specific lives in the tool config), so this is a one-time setup, not
something to repeat per document.

Create these under **Tools** in the Dograh dashboard, then attach both to
the single `agentNode` in `workflow-definition.json` (either by importing
that file and editing the node afterward, or by pasting the resulting
`tool_uuids` into the JSON before import -- see below).

Replace `https://your-deployed-app.example.com` with wherever
`survey-parser` actually ends up running -- e.g. `https://survey.yourdomain.com`
if deployed per the main README's Coolify instructions (same box as Dograh).
These need to be public HTTPS URLs Dograh can reach either way.

If you set `AGENT_TOOLS_SECRET` in `.env`, add it as a custom header on
**both** tools below: header name `x-agent-secret`, value = that secret.

---

## Tool 1: get_next_question

| Field | Value |
|---|---|
| Name | `get_next_question` |
| Description | "Call this at the start of the survey and again immediately after each answer is recorded, to find out what to ask next. Never guess the next question yourself -- always call this tool." |
| Method | GET |
| URL | `https://your-deployed-app.example.com/api/agent/next-question` |
| Parameters | `conversation_id` (string, required) — "The unique ID for this call. Always pass exactly {{workflow_run_id}}." · `spreadsheet_id` (string, required) — "Which survey this call is for. Always pass exactly {{initial_context.spreadsheet_id}}." |

**Returns:** `{ done: boolean, index: number, question: string \| null, total?: number }`

If `done` is `true`, there are no more questions -- move on to ending the call.

---

## Tool 2: submit_answer

| Field | Value |
|---|---|
| Name | `submit_answer` |
| Description | "Call this immediately after the caller answers the current question, once you're confident you've captured what they said. Do this every time before calling get_next_question again." |
| Method | POST |
| URL | `https://your-deployed-app.example.com/api/agent/submit-answer` |
| Parameters | `conversation_id` (string, required) — "Always pass exactly {{workflow_run_id}}." · `spreadsheet_id` (string, required) — "Always pass exactly {{initial_context.spreadsheet_id}}." · `answer` (string, required) — "The caller's answer to the current question, in their own words." |

**Returns:** `{ ok: boolean, recordedIndex: number, remaining: number }`

---

## Multi-survey: passing spreadsheet_id

`spreadsheet_id` isn't a fixed value -- it's the ID of whichever survey's
spreadsheet this particular call is for (the ID you get back after pushing a
document in the app, shown on the survey's card in "Past surveys"). This
needs to reach the agent as an `initial_context` variable when the call is
triggered/routed, e.g. when placing an outbound call via the API or Dograh
SDK, pass `initial_context: { spreadsheet_id: "..." }` alongside the call
request. For inbound calls tied to a specific phone number, check whether
that phone number's config supports setting a default `initial_context` --
otherwise each survey effectively needs its own inbound number, or an
outbound-triggered flow instead.

---

After creating both, note their tool UUIDs (shown in the dashboard) and
either paste them into `workflow-definition.json`'s `tool_uuids` array
before importing, or attach them to the agent node manually after import --
whichever is easier in the dashboard at the time.

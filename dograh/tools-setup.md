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

## Tool 3: record_answer (for complex/branching screeners only)

Tools 1 and 2 assume a fixed, known question list (the "questions" tab) --
fine for straightforward linear surveys, but wrong for screeners with real
skip/termination logic (e.g. "IF NO: THANK AND TERMINATE", "if parent, ask
follow-up X"). For those, the source document goes into Dograh's
**Knowledge Base** instead (Full Document mode works for anything under
5MB) attached to a dedicated agent for that screener, and the agent
follows the document's own logic directly rather than calling
`get_next_question`. It still needs a way to log each answer, and to
terminate the call when the document says to -- that's this tool plus
Dograh's built-in **End Call** tool (docs.dograh.com/voice-agent/tools/
end-call -- not something we configure, just attach it to the node
alongside this one).

Unlike tools 1-2, this one is created **once** and reused across every
complex screener from then on (nothing survey-specific in its config) --
what's NOT reusable per screener is the Knowledge Base document and the
agent itself (KB attachment is per-node), so each new complex screener
needs its own agent, but that agent points at this same tool.

| Field | Value |
|---|---|
| Name | `record_answer` |
| Description | "Call this immediately after the caller answers each question, whatever question you just asked per the attached screener document. There's no fixed question list here -- just log exactly what you asked and what they said." |
| Method | POST |
| URL | `https://your-deployed-app.example.com/api/agent/record-answer` |
| Custom header | `x-agent-secret` = your `AGENT_TOOLS_SECRET` |
| Parameters | `conversation_id` (string, required) — "Always pass exactly {{workflow_run_id}}." · `spreadsheet_id` (string, required) — "Always pass exactly {{spreadsheet_id}}." · `question` (string, required) — "The exact question you just asked the caller, in your own words." · `answer` (string, required) — "The caller's answer, in their own words." |

**Returns:** `{ ok: boolean, recordedIndex: number }`

Prompt for a complex-screener agent should tell the LLM to: follow the
attached Knowledge Base document exactly, including its conditional
logic; call `record_answer` after every question; call `end_call` (with a
brief closing message and a reason) whenever the document instructs
terminating the call.

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

---

## Inbound calls (one number, reassigned per survey)

An inbound call has no `initial_context` -- nobody dials in with a
`spreadsheet_id` attached -- so the outbound tools above (which rely on
Dograh filling `{{spreadsheet_id}}` into the LLM's tool call) don't work
for inbound. Since it's one phone number reassigned to whichever survey is
currently live, the fix is a **separate, permanent pair of inbound tools**
where `spreadsheet_id` is a fixed **Preset Parameter** instead of an LLM
parameter -- Dograh injects it directly, bypassing the LLM, so it works
with zero context. Reassigning the number to a new survey later is just
editing that one preset value -- no new tools, no new agent, nothing to
touch on the phone number config again.

### One-time setup

1. **Create `get_next_question_inbound`** (Tools -> new HTTP API tool):
   - Method: GET, URL: `https://<your-domain>/api/agent/next-question`
   - Custom header: `x-agent-secret` = your `AGENT_TOOLS_SECRET`
   - LLM Parameters: only `conversation_id` (string, required) --
     "Always pass exactly {{workflow_run_id}}." Do **not** add
     `spreadsheet_id` here.
   - Preset Parameters: `spreadsheet_id` = the ID of whichever survey
     should currently be live for inbound callers.
   - Save, note the tool UUID (shown in the URL bar on the tool's page).

2. **Create `submit_answer_inbound`** the same way:
   - Method: POST, URL: `https://<your-domain>/api/agent/submit-answer`
   - Same header.
   - LLM Parameters: `conversation_id` and `answer` only.
   - Preset Parameters: same `spreadsheet_id` value as above.

3. **Create the inbound agent.** `workflow-definition-inbound.json` in
   this folder is the same shape as the outbound one, but the prompt
   doesn't reference `spreadsheet_id` at all (the LLM never sees it --
   it's injected automatically). Paste the two tool UUIDs from steps 1-2
   into its `tool_uuids` array, then either upload it via the dashboard's
   "Upload Agent Definition", or use `create-agent-request-inbound.json`
   (same fix applied, `tool_uuids` filled in) with the API:
   ```
   curl -X POST https://<your-dograh-domain>/api/v1/workflow/create/definition \
     -H "X-API-Key: <your Dograh API key>" \
     -H "Content-Type: application/json" \
     --data @create-agent-request-inbound.json
   ```

4. **Point the phone number at it.** In Dograh's `/telephony-configurations`,
   edit the number and set its **Inbound workflow** to this new agent.

### Reassigning to a new survey later

No new tools, no new agent -- just:

1. Get the new survey's `spreadsheet_id` (shown on its card under "Past
   surveys" in the app).
2. Edit `get_next_question_inbound`'s Preset Parameter `spreadsheet_id`
   to that value.
3. Edit `submit_answer_inbound`'s Preset Parameter `spreadsheet_id` to
   the same value.

That's it -- the same phone number, same agent, same tools now serve the
new survey.

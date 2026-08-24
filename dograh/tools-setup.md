# Dograh tool setup (one-time, manual)

**This file is superseded by `README_TOOLS.md`** in this same folder --
that's the actively-maintained, complete reference (exact fields for every
tool, the corrected conversation_id design, the corrected submit_answer
flow, step-by-step dashboard instructions). Use this file only for the
narrative/rationale below; for exact values to type into the dashboard, use
`README_TOOLS.md` instead. In particular, every `conversation_id` LLM
Parameter mentioned below (`{{workflow_run_id}}`) is **wrong** --
`workflow_run_id` isn't a real Dograh variable, and following these
instructions literally will reproduce the bug documented in
`README_TOOLS.md`'s "Before you start" section. See that file for the
correct Preset Parameter values (`{{initial_context.conversation_id}}` for
outbound, `{{initial_context.caller_number}}` for inbound).

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
| LLM Parameters | `conversation_id` (string, required) — "The unique ID for this call. Always pass exactly {{workflow_run_id}}." |
| Preset Parameters | `spreadsheet_id` = `{{initial_context.spreadsheet_id}}` -- template, not a literal. Injected directly by Dograh, not typed by the LLM, so it's more reliable than making this an LLM Parameter. Works for any outbound call that sets `initial_context: { spreadsheet_id: "..." }` when triggered -- one tool, every survey, forever. For inbound use, see the Inbound calls section below instead (different tool, keyed by phone number). |

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
| LLM Parameters | `conversation_id` (string, required) — "Always pass exactly {{workflow_run_id}}." · `answer` (string, required) — "The caller's answer to the current question, in their own words." |
| Preset Parameters | `spreadsheet_id` = `{{initial_context.spreadsheet_id}}` -- same as Tool 1, keep both in sync. |

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
| LLM Parameters | `conversation_id` (string, required) — "Always pass exactly {{workflow_run_id}}." · `question` (string, required) — "The exact question you just asked the caller, in your own words." · `answer` (string, required) — "The caller's answer, in their own words." |
| Preset Parameters (outbound) | `spreadsheet_id` = `{{initial_context.spreadsheet_id}}` |
| Preset Parameters (inbound) | `phone_number` = `{{initial_context.called_number}}` -- resolved server-side against the mapping in survey-parser's "Inbound numbers" section. Use this instead of `spreadsheet_id` for a screener served over a fixed inbound number. |

**Returns:** `{ ok: boolean, recordedIndex: number }`

Prompt for a complex-screener agent should tell the LLM to: follow the
attached Knowledge Base document exactly, including its conditional
logic; call `record_answer` after every question; call `end_call` (with a
brief closing message and a reason) whenever the document instructs
terminating the call.

Use this for screeners with skip/termination logic that were **not** parsed
through the app's "Recruitment / qualifier screener" flow -- e.g. a
hand-written document, or one you're deliberately keeping ad hoc. The agent
judges the logic itself from the attached document each turn, which is
reliable with a clean, explicit script but not deterministic.

---

## Tool 4: get_next_screener_question (deterministic screeners)

For screeners that WERE parsed and pushed through the app's "Recruitment /
qualifier screener" flow -- the structured question list (with skip_if/
terminate_if per question) gets saved to that survey's spreadsheet
automatically on push, in a `screener` tab. This tool reads that structure
server-side and resolves skip/terminate logic itself, so the agent never
has to judge it -- it just asks whatever this tool returns. Removes the
class of failure record_answer's document-based approach can have (an
agent misjudging a condition, skipping a question it shouldn't have,
inventing one that isn't in the document).

It also replaces `record_answer` for these screeners -- it logs the
answer AND decides what's next in the same call, so only one tool is
needed per turn instead of two.

| Field | Value |
|---|---|
| Name | `get_next_screener_question` |
| Description | "Call this once at the very start of the screener (with no last_question_id/answer) to get the first question, and again immediately after the caller answers each question (passing back the question_id this tool gave you last time, plus their answer) to get the next one. Never decide the next question yourself -- always call this tool. If it returns done=true, stop asking questions: if terminated=true, end the call using closing_message; otherwise read the invitation script under closing and end the call based on their response." |
| Method | POST |
| URL | `https://your-deployed-app.example.com/api/agent/next-screener-question` |
| Custom header | `x-agent-secret` = your `AGENT_TOOLS_SECRET` |
| LLM Parameters | `last_question_id` (string, optional) — "The exact question_id this tool returned last time. Copy it back character for character. Omit on the very first call." · `answer` (string, optional) — "The caller's answer to that question, in their own words. Omit on the very first call." |
| conversation_id | **No longer needed.** Leave it off. If an existing agent still sends one it is ignored except as a fallback for a call already in flight during a deploy. See "Per-call identity" below. |
| Preset Parameters | ONE entry. Which one depends on the direction -- see below. |

**Two tools, not one.** The dashboard has a single preset-parameter list per
tool; there is no inbound/outbound switch inside it. And an unresolvable
preset does not fall through quietly -- Dograh's template engine errors out
with "resolved to an empty value" before the request reaches this app (the
same failure that killed `{{workflow_run_id}}`). An inbound call has no
`initial_context.spreadsheet_id`, so a tool carrying both presets breaks on
every inbound call.

So make one tool per direction, exactly like `get_next_question` and
`get_next_question_inbound` already are:

| Tool name | Preset Parameter |
|---|---|
| `get_next_screener_question` (outbound) | `spreadsheet_id` = `{{initial_context.spreadsheet_id}}` |
| `get_next_screener_question_inbound` | `phone_number` = `{{initial_context.called_number}}` |

Same URL, same description, same LLM parameters for both -- only the preset
differs. The server needs no change either way: `resolveSpreadsheetId` accepts
either and works out the rest.

Build only the direction you actually use. Inbound first is usually faster to
test, since the inbound number mapping is already in place.

**Returns (next question):** `{ done: false, terminated: false, question_id: string, question: string }`
**Returns (disqualified):** `{ done: true, terminated: true, closing_message: string }`
**Returns (completed):** `{ done: true, terminated: false, closing: { invitation_script, accept_response, decline_response } }`

Prompt for this kind of agent should tell the LLM to: call this tool to get
each question (never invent one), ask exactly what it returns (light
rephrasing for natural speech is fine, don't change the meaning), pass back
the exact `question_id` and the caller's answer on the next call, and stop
asking questions the moment `done` is true -- using `closing_message` if
`terminated`, or reading `closing.invitation_script` and reacting to their
answer otherwise.

### Per-call identity (solved -- no Dograh config needed)

`conversation_id` used to be required here, and it never worked. `{{workflow_run_id}}`
resolves to an empty string both as an LLM Parameter (the model transcribes
nothing) and as a Preset Parameter (Dograh's template engine errors out,
"resolved to an empty value", before the call even reaches survey-parser).
The only configuration confirmed working end to end was a Preset Parameter
holding a fixed literal string -- which every concurrent call would then
share, colliding their answers in the responses tab AND mixing the in-memory
answer history that feeds skip/terminate decisions.

**This is now handled server-side.** The endpoint mints its own 8-hex-character
session on the first turn of each call and returns it inside `question_id`:

```
first call  ->  question_id: "a1b2c3d4.Q1"
next call   ->  last_question_id: "a1b2c3d4.Q1"  ->  question_id: "a1b2c3d4.Q2"
```

The agent is already required to echo `last_question_id` back exactly -- that
is core to the tool working at all, and it is confirmed working on real calls.
So the session rides on a channel that already works, and two simultaneous
callers stay separate because each is seeded independently on its own first
turn. Nothing to configure in Dograh.

The session id is what lands in the responses tab's `conversation_id` column,
so filtering column A separates callers exactly as it always should have.

See `lib/callSession.ts`.

---

## Multi-survey: passing spreadsheet_id

`spreadsheet_id` isn't a fixed value -- it's the ID of whichever survey's
spreadsheet this particular call is for (the ID you get back after pushing a
document in the app, shown on the survey's card in "Past surveys"). For
outbound calls, it reaches the agent as an `initial_context` variable set
when the call is triggered -- pass `initial_context: { spreadsheet_id: "..." }`
alongside the call request, and the tools above (Preset Parameter
`{{initial_context.spreadsheet_id}}`) resolve it automatically. One tool
set, reused for every survey forever -- nothing to recreate per document.

For inbound calls, there's no `initial_context` to set (nobody dials in
with a spreadsheet_id attached) -- see "Inbound calls" below instead.

---

After creating both, note their tool UUIDs (shown in the dashboard) and
either paste them into `workflow-definition.json`'s `tool_uuids` array
before importing, or attach them to the agent node manually after import --
whichever is easier in the dashboard at the time.

---

## Tool 5: check_availability (appointment booking)

Reusable across any agent that needs to offer appointment slots -- nothing
survey- or screener-specific in it. Requires the Google Calendar setup in
the main README (Calendar API enabled, calendar scope added to the service
account's domain-wide delegation) on top of the Sheets setup tools 1-4 use.

| Field | Value |
|---|---|
| Name | `check_availability` |
| Description | "Call this to find open appointment times for a given day before offering any time to the caller. Pass `date` as close to verbatim what the caller said -- 'today', 'tomorrow', a weekday name, or a literal date -- never compute or guess a date yourself. Read out 2-3 of the returned slot labels; don't read the whole list. If none_available is true, offer a different day." |
| Method | POST |
| URL | `https://your-deployed-app.example.com/api/agent/check-availability` |
| Custom header | `x-agent-secret` = your `AGENT_TOOLS_SECRET` |
| Parameters | `date` (string, required) -- "The day to check, exactly as the caller said it: 'today', 'tomorrow', a weekday name like 'Tuesday' or 'next Tuesday', or YYYY-MM-DD." · `duration_minutes` (number, optional) -- "Appointment length in minutes. Omit to use the default." |

**Returns:** `{ date, time_zone, is_business_day: boolean, slots: [{ label, start_iso, end_iso }], none_available: boolean }`

`label` is spoken-friendly (e.g. `"9:00 AM"`). `start_iso` is what gets
passed to `book_appointment` -- the agent should never construct or modify
it, only echo back whichever slot the caller picked.

---

## Tool 6: book_appointment

Pairs with Tool 5.

| Field | Value |
|---|---|
| Name | `book_appointment` |
| Description | "Call this once the caller has confirmed a specific time from check_availability's results and given you their name and a phone number or email. Pass start_iso exactly as returned by check_availability for the slot they picked. If this returns an error about the slot being taken, call check_availability again and offer new times -- don't retry the same start_iso." |
| Method | POST |
| URL | `https://your-deployed-app.example.com/api/agent/book-appointment` |
| Custom header | `x-agent-secret` = your `AGENT_TOOLS_SECRET` |
| Parameters | `conversation_id` (string, optional) -- "Always pass exactly {{workflow_run_id}} if you have it." · `start_iso` (string, required) -- "The start_iso value of the slot the caller chose, exactly as check_availability returned it." · `duration_minutes` (number, optional) -- "Should match whatever was passed to check_availability. Omit to use the default." · `name` (string, required) -- "The caller's full name." · `phone` (string, optional) -- "The caller's phone number." · `email` (string, optional) -- "The caller's email, if given -- they'll get a calendar invite if so." · `notes` (string, optional) -- "Anything relevant about the appointment the caller mentioned." |

**Returns (success):** `{ ok: true, event_id, start_iso, end_iso, confirmation }` -- `confirmation` is a spoken-friendly string (e.g. `"Tuesday, March 4 at 9:00 AM (EST)"`) safe to read back to the caller as-is.
**Returns (slot taken):** HTTP 409, `{ error: "..." }` -- call `check_availability` again rather than retrying.

At least one of `phone` or `email` is required -- the route rejects a
booking with neither, since there'd be no way to reach the caller about it
afterward.

`conversation_id` is deliberately NOT required server-side, unlike the
survey tools -- same `{{workflow_run_id}}`-resolves-empty issue documented
for `record_answer`/`get_next_screener_question` above, but here it's only
used for traceability in the event description, nothing keys off it. The
route logs when it arrives empty (for visibility) but still books the
appointment.

---

## Tool 9/10: calcom_check_availability / calcom_book_appointment (Cal.com booking, alternative backend)

Same purpose as Tools 5/6, added alongside them rather than replacing
them -- Cal.com as an alternative appointment-booking backend to Google
Calendar. Use this pair on an agent instead of Tools 5/6 (not both) when
Cal.com is the booking system for that line of business. Requires
`CAL_API_KEY` and `CAL_EVENT_TYPE_ID` set (main README's Cal.com section)
-- no Google Calendar/domain-wide-delegation setup needed for this pair.
See `README_TOOLS.md`'s Tool 9/10 for exact field values.

Cal.com does most of the scheduling work itself (business hours, buffers,
minimum notice, double-booking prevention all live on the Event Type's
own config in Cal.com's dashboard, not in env vars here) -- so if
availability looks wrong, check the Event Type's settings in Cal.com
first, not `BUSINESS_HOURS_START`/`END` (those don't apply to this pair).

---

## Inbound calls (phone_number -> spreadsheet_id, resolved server-side)

An inbound call has no `initial_context.spreadsheet_id` -- nobody dials in
with a survey ID attached -- so the outbound tools above don't work as-is
for inbound. Dograh's docs confirm production inbound calls DO populate
`initial_context.called_number` (and `caller_number`) from real telephony
data though, so the fix is: inbound tools pass `phone_number` as a Preset
Parameter instead of `spreadsheet_id`, and survey-parser resolves which
survey that number is currently mapped to, server-side (see
`resolveSpreadsheetId` in `lib/googleSheets.ts`).

This means: **one set of inbound tools, created once, ever.** Reassigning a
number to a new survey -- or adding a second number running a different
survey at the same time -- happens entirely inside survey-parser's
"Inbound numbers" section on the home page. No Dograh tool config, no new
tools, no new agent, nothing to touch in Dograh at all after initial setup.

### One-time setup

1. **Create `get_next_question_inbound`** (Tools -> new HTTP API tool):
   - Method: GET, URL: `https://<your-domain>/api/agent/next-question`
   - Custom header: `x-agent-secret` = your `AGENT_TOOLS_SECRET`
   - LLM Parameters: only `conversation_id` (string, required) --
     "Always pass exactly {{workflow_run_id}}." Do **not** add
     `spreadsheet_id` here.
   - Preset Parameters: `phone_number` = `{{initial_context.called_number}}`
   - Save, note the tool UUID (shown in the URL bar on the tool's page).

2. **Create `submit_answer_inbound`** the same way:
   - Method: POST, URL: `https://<your-domain>/api/agent/submit-answer`
   - Same header.
   - LLM Parameters: `conversation_id` and `answer` only.
   - Preset Parameters: same `phone_number` = `{{initial_context.called_number}}`.

3. **Create the inbound agent.** `workflow-definition-inbound.json` in
   this folder is the same shape as the outbound one, but the prompt
   doesn't reference `spreadsheet_id` or `phone_number` at all (the LLM
   never sees either -- both are resolved automatically server-side).
   Paste the two tool UUIDs from steps 1-2 into its `tool_uuids` array,
   then either upload it via the dashboard's "Upload Agent Definition", or
   use `create-agent-request-inbound.json` (same fix applied, `tool_uuids`
   filled in) with the API:
   ```
   curl -X POST https://<your-dograh-domain>/api/v1/workflow/create/definition \
     -H "X-API-Key: <your Dograh API key>" \
     -H "Content-Type: application/json" \
     --data @create-agent-request-inbound.json
   ```

4. **Point the phone number at it.** In Dograh's `/telephony-configurations`,
   edit the number and set its **Inbound workflow** to this new agent.

5. **Map the number to a survey.** In survey-parser, scroll to "Inbound
   numbers", enter the phone number (in whatever format Dograh's
   `called_number` actually sends -- check a real call's logs if unsure)
   and pick the survey from the dropdown, then Add. Until a number has a
   mapping, inbound calls to it will get a clear error instead of silently
   running the wrong survey.

### Reassigning to a new survey later

No Dograh dashboard work at all -- in survey-parser's "Inbound numbers"
section, change that number's dropdown to the new survey. Takes effect on
the very next call (there's an in-memory cache on the resolution, but it's
invalidated the moment you save a change).

The same pattern applies to `record_answer` and `get_next_screener_question`
for inbound complex screeners -- use `phone_number` as their Preset
Parameter instead of a literal `spreadsheet_id`, same as above.

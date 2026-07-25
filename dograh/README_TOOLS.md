# Dograh Tools Reference

Complete, exact configuration for every HTTP API tool survey-parser's agents
call. Use this to rebuild from scratch in Dograh's dashboard (Tools ->
New Tool) any time the Dograh database gets wiped -- nothing here depends on
Dograh's own data, only on survey-parser (unaffected by a Dograh reset) and
Google Sheets.

## Before you start

- **Base URL**: `https://sp.cognexion.com`
- **Shared secret header**: every tool below needs a custom header
  `x-agent-secret` set to the value of `AGENT_TOOLS_SECRET` in Coolify ->
  survey-parser app -> Environment Variables. Same value on every tool, no
  exceptions. If you don't have a live tool to copy it from anymore, get it
  directly from Coolify.
- **spreadsheet_id / phone_number**: as of this revision, every tool below
  uses a **Preset Parameter templated from `initial_context`**
  (`{{initial_context.spreadsheet_id}}` for outbound, `{{initial_context.
  called_number}}` for inbound) rather than a literal value -- meaning each
  tool is created **once, ever**, and works for every survey automatically.
  Reassigning which survey an inbound number serves happens in
  survey-parser's "Inbound numbers" section on the home page, not in
  Dograh. Outbound calls just pass `initial_context: { spreadsheet_id: "..." }`
  when triggered -- see "Triggering an outbound call" below.
- **conversation_id: `{{workflow_run_id}}` is NOT a real Dograh variable.**
  Every tool below used to have the agent pass `conversation_id` as an LLM
  Parameter with instructions to "always pass exactly `{{workflow_run_id}}`"
  -- this was based on a wrong assumption that `workflow_run_id` resolves
  like a real template variable. It doesn't; Dograh's docs confirm the only
  built-in variables are `{{caller_number}}`/`{{called_number}}`
  (telephony) and `{{current_time}}`/`{{current_weekday}}` (defaults) --
  `workflow_run_id` isn't one of them. In practice this meant the LLM was
  just copying the literal text `{{workflow_run_id}}` into the tool call
  (confirmed on a live test -- the responses sheet had the literal string
  `{{workflow_run_id}}` in every row, not a real ID), or sometimes producing
  an empty string instead -- unreliable either way, confirmed on a second
  live test where it broke the call outright (`Missing conversation_id`).
  **Fixed**: `conversation_id` is now also a **Preset Parameter**, not an
  LLM Parameter, using a variable that's actually real:
  - Inbound tools: `{{initial_context.caller_number}}` -- free, already
    populated on every real inbound call, nothing to set up.
  - Outbound tools: `{{initial_context.conversation_id}}` -- we generate a
    real UUID and pass it ourselves when triggering the call, same as
    `spreadsheet_id` (see "Triggering an outbound call" below).
  The agent no longer needs to know or reference conversation_id at all --
  same as it already doesn't need to know spreadsheet_id/phone_number.

## How to create a tool (step by step)

Repeat this for each tool below -- the fields differ, the steps don't:

1. In the Dograh dashboard, go to **Tools -> New Tool** (HTTP API tool).
2. Fill in **Name** and **Description** exactly as given in that tool's
   table -- the description is what the agent reads to decide when to call
   it, so don't shorten it.
3. Set **Method** and **URL** as given.
4. Under **Headers**, add one custom header: name `x-agent-secret`, value
   = your `AGENT_TOOLS_SECRET` (see above). Every tool needs this one.
5. Under **LLM Parameters**, add each parameter from that tool's "LLM
   Parameters" table -- name, type, required/optional, and paste the
   description verbatim (it's the instruction the model sees for how to
   fill that field in).
6. Under **Preset Parameters**, add each parameter from that tool's
   "Preset Parameters" table. These are NOT typed by the model -- Dograh
   fills them in directly from the template you give (e.g.
   `{{initial_context.spreadsheet_id}}`), so don't also add them as an LLM
   Parameter.
7. Save. Note the **tool UUID** Dograh shows you (visible in the URL bar
   on the tool's page, or on the tools list) -- you'll need it to attach
   the tool to an agent node, either by pasting it into that agent's
   `tool_uuids` array before importing via the API, or by attaching it
   manually in the workflow editor after the agent exists.
8. Repeat for every tool this agent needs, then move on to creating the
   agent itself (see "Creating an agent via the API" below) or attaching
   these tools to an existing agent node in the workflow editor.

---

## Tool 1: get_next_question

Outbound, simple linear surveys. Deterministic -- the agent never decides
the next question itself.

| Field | Value |
|---|---|
| Name | `get_next_question` |
| Description | Call this at the start of the survey and again immediately after each answer is recorded, to find out what to ask next. Never guess the next question yourself -- always call this tool. |
| Method | `GET` |
| URL | `https://sp.cognexion.com/api/agent/next-question` |
| Header | `x-agent-secret` = (see above) |

**LLM Parameters:** none -- the agent doesn't pass anything itself, everything comes from Preset Parameters below.

**Preset Parameters:**
| Name | Value |
|---|---|
| `spreadsheet_id` | `{{initial_context.spreadsheet_id}}` -- template, injected by Dograh directly. Set once; works for every survey triggered with `initial_context: { spreadsheet_id: "..." }`. |
| `conversation_id` | `{{initial_context.conversation_id}}` -- a real ID you generate and pass yourself when triggering the call (see "Triggering an outbound call" below). Not `{{workflow_run_id}}` -- that isn't a real Dograh variable, see "Before you start" above. |

**Returns:** `{ done: boolean, index: number, question: string | null, total?: number }`

---

## Tool 2: submit_answer

Pairs with Tool 1 -- but only for the *first* question. After that, this
tool alone drives the rest of the survey (see "Corrected flow" below).

| Field | Value |
|---|---|
| Name | `submit_answer` |
| Description | Call this immediately after the caller answers the current question, once you're confident you've captured what they said. Its response tells you the next question directly -- don't call get_next_question again after the first question. |
| Method | `POST` |
| URL | `https://sp.cognexion.com/api/agent/submit-answer` |
| Header | `x-agent-secret` = (see above) |

**LLM Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `answer` | string | yes | The caller's answer to the current question, in their own words. |

**Preset Parameters:**
| Name | Value |
|---|---|
| `spreadsheet_id` | `{{initial_context.spreadsheet_id}}` -- same as Tool 1, keep in sync. |
| `conversation_id` | `{{initial_context.conversation_id}}` -- same as Tool 1, keep in sync. |

**Returns:** `{ ok: boolean, recordedIndex: number, remaining: number, next: { done: boolean, index: number, question: string | null, total?: number } }`

### Corrected flow -- call get_next_question ONCE, not per-question

Earlier versions had the agent call `get_next_question` again after every
`submit_answer`, alternating between the two tools per question. **Don't do
that** -- it hits a real Google Sheets read-after-write race: `submit_answer`
appends the answer via the Sheets API, then the very next `get_next_question`
re-reads the same sheet a few hundred ms later to count answered questions,
and that read can come back stale (append acknowledged, but not yet visible
to a fresh read). The agent sees "still on question 0" right after it just
answered question 0, apologizes, and re-asks the same question -- confirmed
on a live test call (loops indefinitely on question 1 until the caller gives
up).

The fix: `submit_answer` now computes and returns the next question directly
in its own response (`next`), from data it already has in memory -- no
second read, no race. Correct flow:

1. Call `get_next_question` **exactly once**, at the very start of the
   survey, to get question 1.
2. Ask it, get the answer, call `submit_answer`.
3. Read `next` off `submit_answer`'s response. If `next.done`, the survey's
   over. Otherwise `next.question` **is** the next question -- ask it
   directly, then call `submit_answer` again for that answer.
4. Repeat step 3 for every remaining question. Never call `get_next_question`
   again after step 1.

The agent prompts in `create-agent-request.json` and
`create-agent-request-inbound.json` (and the `workflow-definition*.json`
equivalents) already encode this corrected flow -- if you're hand-editing an
agent's prompt in the dashboard instead of re-uploading, make sure it
matches this pattern.

---

## Tool 3: get_next_question_inbound

Same as Tool 1, but for inbound calls -- there's no `initial_context.
spreadsheet_id` to read (nobody dials in with a survey ID attached), so
this uses `phone_number` instead, resolved server-side against a mapping
you manage in survey-parser's "Inbound numbers" section (home page). One
tool, created once, serves every inbound number and every survey ever
mapped to one -- reassigning a number to a different survey is a dropdown
change in the app, not a Dograh edit.

| Field | Value |
|---|---|
| Name | `get_next_question_inbound` |
| Description | Same as Tool 1. |
| Method | `GET` |
| URL | `https://sp.cognexion.com/api/agent/next-question` |
| Header | `x-agent-secret` = (see above) |

**LLM Parameters:** none -- the agent doesn't pass anything itself, everything comes from Preset Parameters below.

**Preset Parameters:**
| Name | Value |
|---|---|
| `phone_number` | `{{initial_context.called_number}}` -- template, the number the caller dialed. Confirmed populated on real inbound calls per Dograh's docs. |
| `conversation_id` | `{{initial_context.caller_number}}` -- the caller's own number, also auto-populated on every real inbound call. Free, reliable, nothing to set up. Not `{{workflow_run_id}}` -- see "Before you start" above. |

---

## Tool 4: submit_answer_inbound

Pairs with Tool 3.

| Field | Value |
|---|---|
| Name | `submit_answer_inbound` |
| Description | Same as Tool 2. |
| Method | `POST` |
| URL | `https://sp.cognexion.com/api/agent/submit-answer` |
| Header | `x-agent-secret` = (see above) |

**LLM Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `answer` | string | yes | The caller's answer to the current question, in their own words. |

**Preset Parameters:**
| Name | Value |
|---|---|
| `phone_number` | `{{initial_context.called_number}}` -- same as Tool 3, keep in sync. |
| `conversation_id` | `{{initial_context.caller_number}}` -- same as Tool 3, keep in sync. |

---

## Tool 5: record_answer

Complex/branching screeners driven by a Dograh Knowledge Base document
(Full Document mode) instead of a fixed question list -- the agent follows
the document's own skip/termination logic itself. This tool just logs each
`(question, answer)` pair; it doesn't decide what's next. Reusable across
every screener built this way -- only the Knowledge Base document and the
agent are per-screener, not this tool.

**conversation_id fix applied:** same as Tools 1-4 -- `conversation_id` is a
Preset Parameter now, not an LLM Parameter, using `{{initial_context.
conversation_id}}` (outbound) or `{{initial_context.caller_number}}`
(inbound) instead of the non-existent `{{workflow_run_id}}`. See "Before you
start" above for why the old approach was unreliable.

| Field | Value |
|---|---|
| Name | `record_answer` |
| Description | Call this immediately after the caller answers each question, whatever question you just asked per the attached screener document. There's no fixed question list here -- just log exactly what you asked and what they said. |
| Method | `POST` |
| URL | `https://sp.cognexion.com/api/agent/record-answer` |
| Header | `x-agent-secret` = (see above) |

**LLM Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `question` | string | yes | The exact question you just asked the caller, in your own words. |
| `answer` | string | yes | The caller's answer, in their own words. |

**Preset Parameters (outbound):**
| Name | Value |
|---|---|
| `spreadsheet_id` | `{{initial_context.spreadsheet_id}}` |
| `conversation_id` | `{{initial_context.conversation_id}}` |

**Preset Parameters (inbound, e.g. AGO):**
| Name | Value |
|---|---|
| `phone_number` | `{{initial_context.called_number}}` -- resolved via survey-parser's inbound number mapping, same as Tools 3/4. |
| `conversation_id` | `{{initial_context.caller_number}}` |

Use whichever pair of Preset Parameters matches how this screener is being
called -- not both.

**Returns:** `{ ok: boolean, recordedIndex: number }`

---

## Tool 6: get_next_screener_question

Deterministic replacement for Tool 5, for screeners parsed and pushed
through the app's "Recruitment / qualifier screener" flow -- which persists
the full structured question list (with skip_if/terminate_if per question)
to that survey's spreadsheet automatically. This tool reads that structure
server-side and resolves the logic itself, so the agent never judges a
skip/terminate condition -- it just asks whatever this returns. Also
replaces the need for a Knowledge Base document read for question logic
(though the KB doc can still be attached for tone/phrasing reference).

Combines recording + deciding-next in one call, unlike the two-tool
Tool 1/2 pattern -- lower latency, one round-trip per turn.

| Field | Value |
|---|---|
| Name | `get_next_screener_question` |
| Description | Call this once at the very start of the screener (with no last_question_id/answer) to get the first question, and again immediately after the caller answers each question (passing back the question_id this tool gave you last time, plus their answer) to get the next one. Never decide the next question yourself -- always call this tool. If it returns done=true, stop asking questions: if terminated=true, end the call using closing_message; otherwise read the invitation script under closing and end the call based on their response. |
| Method | `POST` |
| URL | `https://sp.cognexion.com/api/agent/next-screener-question` |
| Header | `x-agent-secret` = (see above) |

**LLM Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `last_question_id` | string | no | The question_id this tool returned last time. Omit on the very first call. |
| `answer` | string | no | The caller's answer to that question, in their own words. Omit on the very first call. |

**Preset Parameters (outbound):**
| Name | Value |
|---|---|
| `spreadsheet_id` | `{{initial_context.spreadsheet_id}}` |
| `conversation_id` | `{{initial_context.conversation_id}}` |

**Preset Parameters (inbound):**
| Name | Value |
|---|---|
| `phone_number` | `{{initial_context.called_number}}` -- resolved via survey-parser's inbound number mapping. |
| `conversation_id` | `{{initial_context.caller_number}}` |

This screener must have been pushed via the app's screener flow (not
manually created) either way -- that's what persists the structured
question list this tool reads.

**Returns (next question):** `{ done: false, terminated: false, question_id: string, question: string }`
**Returns (disqualified):** `{ done: true, terminated: true, closing_message: string }`
**Returns (completed):** `{ done: true, terminated: false, closing: { invitation_script, accept_response, decline_response } }`

---

## Tool 7: check_availability

Appointment booking. Reusable across any agent -- not survey/screener
specific. Requires the Google Calendar setup in the main README (Calendar
API enabled + calendar scope added to the service account's domain-wide
delegation) in addition to the Sheets setup Tools 1-6 use.

| Field | Value |
|---|---|
| Name | `check_availability` |
| Description | Call this to find open appointment times for a given day before offering any time to the caller. Pass `date` as close to verbatim what the caller said -- never compute or guess a date yourself. Read out 2-3 of the returned slot labels, not the whole list. |
| Method | `POST` |
| URL | `https://sp.cognexion.com/api/agent/check-availability` |
| Header | `x-agent-secret` = (see above) |

**LLM Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `date` | string | yes | The day to check, exactly as the caller said it: `today`, `tomorrow`, a weekday name (`Tuesday` / `next Tuesday`), or `YYYY-MM-DD`. Resolved server-side, in `BUSINESS_TIME_ZONE`. |
| `duration_minutes` | number | no | Appointment length. Omit to use `APPOINTMENT_DURATION_MINUTES`. |

**Returns:** `{ date, time_zone, is_business_day: boolean, slots: [{ label, start_iso, end_iso }], none_available: boolean }`

---

## Tool 8: book_appointment

Pairs with Tool 7.

| Field | Value |
|---|---|
| Name | `book_appointment` |
| Description | Call this once the caller has confirmed a specific time from check_availability's results and given a name and a phone number or email. Pass start_iso exactly as check_availability returned it for the chosen slot. On a "slot taken" error, call check_availability again rather than retrying the same start_iso. |
| Method | `POST` |
| URL | `https://sp.cognexion.com/api/agent/book-appointment` |
| Header | `x-agent-secret` = (see above) |

**LLM Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `start_iso` | string | yes | The `start_iso` of the slot the caller chose, exactly as `check_availability` returned it. |
| `duration_minutes` | number | no | Should match what was passed to `check_availability`. Omit to use the default. |
| `name` | string | yes | The caller's full name. |
| `phone` | string | no* | The caller's phone number. *At least one of `phone`/`email` is required. |
| `email` | string | no* | The caller's email -- triggers a calendar invite if given. |
| `notes` | string | no | Anything relevant the caller mentioned. |

Optional: add a `conversation_id` Preset Parameter (`{{initial_context.
conversation_id}}` or `{{initial_context.caller_number}}`, matching whichever
survey tools this agent also uses) purely for traceability in the booking's
event description -- not required, the route books the appointment fine
without it.

**Returns (success):** `{ ok: true, event_id, start_iso, end_iso, confirmation }` -- `confirmation` is spoken-friendly (e.g. `"Tuesday, March 4 at 9:00 AM (EST)"`), safe to read back as-is.
**Returns (slot taken):** HTTP 409 `{ error }` -- re-call `check_availability`, don't retry.

---

## Which tools go on which agent

| Agent | Tools attached |
|---|---|
| Voice Survey Agent (outbound, simple) | `get_next_question`, `submit_answer` |
| Voice Survey Agent (Inbound) | `get_next_question_inbound`, `submit_answer_inbound` |
| Complex screener, KB-driven (e.g. AGO) | `record_answer` (+ Knowledge Base document, Full Document mode) |
| Complex screener, deterministic | `get_next_screener_question` (KB document optional, for tone only) |
| Any agent that should offer appointment booking | `check_availability`, `book_appointment` -- can be added alongside any of the above |

---

## Managing inbound number -> survey mappings

survey-parser's home page has an "Inbound numbers" section: lists every
mapped phone number, which survey it currently points to, a dropdown to
repoint it, and a form to map a new number. Backed by `/api/inbound-numbers`
(GET list, POST upsert) and `/api/inbound-numbers/:phoneNumber` (DELETE).
This is the only place reassignment happens -- no Dograh dashboard work
needed once the inbound tools above are set up.

If you're not sure what format Dograh sends `called_number` in (e.g.
`+14165551234` vs `14165551234` vs with dashes), place one real inbound
call first with the number unmapped -- the resulting error from
`resolveSpreadsheetId` will include the exact string that was received, so
you can map it precisely.

---

## Triggering an outbound call

`conversation_id` must be a real, unique value you generate yourself here --
every outbound trigger needs a fresh one (a UUID is fine, doesn't need to be
anything meaningful), so that concurrent calls don't collide in the
responses sheet:

```
curl -X POST https://voice.cognexion.com/api/v1/public/agent/workflow/<AGENT_UUID> \
  -H "X-API-Key: <your Dograh API key>" \
  -H "Content-Type: application/json" \
  --data '{
    "phone_number": "+1XXXXXXXXXX",
    "initial_context": {
      "spreadsheet_id": "<this survey's spreadsheet_id>",
      "conversation_id": "'"$(uuidgen)"'"
    }
  }'
```

(`uuidgen` is a shell command, available by default on macOS/Linux -- swap
in whatever UUID generator your actual trigger system uses, e.g.
`crypto.randomUUID()` in Node, `uuid.uuid4()` in Python.)

`<AGENT_UUID>` is the agent's Agent UUID (not its numeric #N id) -- find it
via the workflow editor's `...` menu -> "Copy Agent UUID", or the agent's
Settings page. Only needed for outbound agents; inbound agents are
triggered by a real call landing on whatever number is pointed at them in
Dograh's `/telephony-configurations`, and get `conversation_id` for free
from `{{initial_context.caller_number}}` -- nothing to generate.

## Creating an agent via the API

Dograh's dashboard "Upload Agent Definition" has been unreliable (silent
client-side validation failures with no readable error). Use the API
instead:

```
curl -X POST https://voice.cognexion.com/api/v1/workflow/create/definition \
  -H "X-API-Key: <your Dograh API key>" \
  -H "Content-Type: application/json" \
  --data @dograh/create-agent-request.json
```

Swap in `create-agent-request-inbound.json` or
`create-agent-request-ago-screener.json` for those variants. Fill in real
tool UUIDs (from the tools above) before running -- the JSON files in this
repo may still have placeholder UUIDs if tools were recreated since they
were last filled in.

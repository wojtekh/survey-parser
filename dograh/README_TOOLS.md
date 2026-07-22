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
- **spreadsheet_id** values are survey-specific and change every time you
  push a new survey from the app. The ones listed under each tool below are
  whatever was current as of this doc being written -- check the app's
  "Past surveys" list for the current one before relying on these.

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

**LLM Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `conversation_id` | string | yes | Always pass exactly `{{workflow_run_id}}`. |
| `spreadsheet_id` | string | yes | Always pass exactly `{{initial_context.spreadsheet_id}}`. |

**Returns:** `{ done: boolean, index: number, question: string | null, total?: number }`

---

## Tool 2: submit_answer

Pairs with Tool 1.

| Field | Value |
|---|---|
| Name | `submit_answer` |
| Description | Call this immediately after the caller answers the current question, once you're confident you've captured what they said. Do this every time before calling get_next_question again. |
| Method | `POST` |
| URL | `https://sp.cognexion.com/api/agent/submit-answer` |
| Header | `x-agent-secret` = (see above) |

**LLM Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `conversation_id` | string | yes | Always pass exactly `{{workflow_run_id}}`. |
| `spreadsheet_id` | string | yes | Always pass exactly `{{initial_context.spreadsheet_id}}`. |
| `answer` | string | yes | The caller's answer to the current question, in their own words. |

**Returns:** `{ ok: boolean, recordedIndex: number, remaining: number }`

---

## Tool 3: get_next_question_inbound

Same as Tool 1, but for a fixed inbound phone number where there's no
`initial_context` to carry a spreadsheet_id -- so it's a **Preset
Parameter** instead, injected by Dograh directly, invisible to the LLM.
Reassigning the number to a different survey later = editing this one
preset value, nothing else.

| Field | Value |
|---|---|
| Name | `get_next_question_inbound` |
| Description | Same as Tool 1. |
| Method | `GET` |
| URL | `https://sp.cognexion.com/api/agent/next-question` |
| Header | `x-agent-secret` = (see above) |

**LLM Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `conversation_id` | string | yes | Always pass exactly `{{workflow_run_id}}`. |

**Preset Parameters:**
| Name | Value |
|---|---|
| `spreadsheet_id` | `1Jro3K_TxIIun-leYw7kspUpMo1cp6Pu_StHyMiGmmSQ` (current simple survey -- check "Past surveys" for the live one) |

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
| `conversation_id` | string | yes | Always pass exactly `{{workflow_run_id}}`. |
| `answer` | string | yes | The caller's answer to the current question, in their own words. |

**Preset Parameters:**
| Name | Value |
|---|---|
| `spreadsheet_id` | Same value as Tool 3, kept identical. |

---

## Tool 5: record_answer

Complex/branching screeners driven by a Dograh Knowledge Base document
(Full Document mode) instead of a fixed question list -- the agent follows
the document's own skip/termination logic itself. This tool just logs each
`(question, answer)` pair; it doesn't decide what's next. Reusable across
every screener built this way -- only the Knowledge Base document and the
agent are per-screener, not this tool.

**Known reliability issue:** `conversation_id` as `{{workflow_run_id}}` does
not work in either an LLM Parameter (resolves empty) or a Preset Parameter
(Dograh's own preset engine throws "resolved to an empty value" before the
call even reaches survey-parser). The only configuration confirmed working
end-to-end was a **fixed literal string** as a Preset Parameter -- fine for
one test call at a time, not for real concurrent multi-caller use.

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

**Preset Parameters:**
| Name | Value |
|---|---|
| `spreadsheet_id` | This screener's sheet ID, e.g. `1OQv--HB3fZD9dD_0Z6uejyn-_oBJyRbs2vgfNBmRbnw` (AGO) |
| `conversation_id` | A fixed literal test string, e.g. `test-call-1` -- NOT a template |

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
| `conversation_id` | string | yes | Always pass exactly `{{workflow_run_id}}`. Same reliability caveat as Tool 5 applies -- verify this actually resolves on a real test call before relying on it. |
| `last_question_id` | string | no | The question_id this tool returned last time. Omit on the very first call. |
| `answer` | string | no | The caller's answer to that question, in their own words. Omit on the very first call. |

**Preset Parameters:**
| Name | Value |
|---|---|
| `spreadsheet_id` | This screener's sheet ID (must have been pushed via the app's screener flow, not manually created) |

**Returns (next question):** `{ done: false, terminated: false, question_id: string, question: string }`
**Returns (disqualified):** `{ done: true, terminated: true, closing_message: string }`
**Returns (completed):** `{ done: true, terminated: false, closing: { invitation_script, accept_response, decline_response } }`

---

## Which tools go on which agent

| Agent | Tools attached |
|---|---|
| Voice Survey Agent (outbound, simple) | `get_next_question`, `submit_answer` |
| Voice Survey Agent (Inbound) | `get_next_question_inbound`, `submit_answer_inbound` |
| Complex screener, KB-driven (e.g. AGO) | `record_answer` (+ Knowledge Base document, Full Document mode) |
| Complex screener, deterministic | `get_next_screener_question` (KB document optional, for tone only) |

---

## Triggering an outbound call

```
curl -X POST https://voice.cognexion.com/api/v1/public/agent/workflow/<AGENT_UUID> \
  -H "X-API-Key: <your Dograh API key>" \
  -H "Content-Type: application/json" \
  --data '{
    "phone_number": "+1XXXXXXXXXX",
    "initial_context": { "spreadsheet_id": "<this survey's spreadsheet_id>" }
  }'
```

`<AGENT_UUID>` is the agent's Agent UUID (not its numeric #N id) -- find it
via the workflow editor's `...` menu -> "Copy Agent UUID", or the agent's
Settings page. Only needed for outbound agents; inbound agents are
triggered by a real call landing on whatever number is pointed at them in
Dograh's `/telephony-configurations`.

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

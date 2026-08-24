import type { ParsedScreener } from '@/lib/generateScreener';

// Builds the three node prompts for a Dograh agent that runs a screener via
// the deterministic get_next_screener_question tool.
//
// Deterministic templates, not another model call. Two reasons: the prompt
// for this flow is almost entirely fixed rules about how to use the tool,
// and a generated prompt you cannot predict is a prompt you cannot review.
// The survey-specific parts -- the opening, the closing, the decline
// wording -- come straight out of the parsed screener.
//
// Note how much SHORTER the agent prompt is than the AGO one in
// dograh/create-agent-request-ago-screener.json. That older prompt had to
// teach the model to track question order, apply SKIP IF / TERMINATE IF
// rules, and keep a mental checklist -- because the logic lived in a
// Knowledge Base document the model had to interpret. Here the server owns
// all of that. The agent only has to ask what it is handed and report the
// answer, so the prompt says that and stops.

/**
 * The tool name the prompt tells the model to call.
 *
 * This MUST match the tool's name in the Dograh dashboard exactly. It is a
 * setting rather than a constant because the name is not ours to choose --
 * a tool is created by hand per direction (inbound vs outbound need separate
 * tools, since the preset parameter differs), so the same survey can face a
 * tool called `get_next_screener_question_inbound`.
 *
 * A mismatch does not fail loudly at build or deploy time. It fails mid-call,
 * as "The function X is not currently available", after the caller has
 * already heard the opening.
 */
export const DEFAULT_TOOL_NAME = 'get_next_screener_question';

export interface AgentPrompts {
  /** startCall node -- the greeting, before any question. */
  start: string;
  /** agentNode -- the loop: ask what the tool returns, report the answer. */
  agent: string;
  /** endCall node -- how to close, qualified or not. */
  end: string;
}

function firstOpening(screener: ParsedScreener) {
  return screener.openings?.[0] ?? null;
}

export function generateAgentPrompts(
  screener: ParsedScreener,
  toolName: string = DEFAULT_TOOL_NAME
): AgentPrompts {
  const opening = firstOpening(screener);
  const otherOpenings = (screener.openings ?? []).slice(1);

  const start = [
    `You are opening a market research screener call for "${screener.title}".`,
    '',
    'Greet the caller warmly and deliver this opening. Keep the wording close to',
    'this text -- the disclosures in it matter:',
    '',
    opening?.script?.trim() || '(No opening script was captured for this screener. Write one before using this agent.)',
    '',
    'If the caller declines right here, before any questions, say:',
    '',
    opening?.decline_response?.trim() || '(No decline response was captured. Write one before using this agent.)',
    ...(otherOpenings.length
      ? [
          '',
          'This screener has other opening variants that were not used here:',
          ...otherOpenings.map((o) => `- ${o.condition}`),
          'Pick the right one by hand if this agent is for that group instead.',
        ]
      : []),
    '',
    'Once the caller agrees to continue, move on to the questions.',
  ].join('\n');

  const agent = [
    'You are running a screener call. You do NOT decide which question comes',
    `next, and you do NOT decide who qualifies. The ${toolName}`,
    'tool decides both. Your job is to ask what it hands you and report what',
    'you hear back.',
    '',
    'The loop:',
    `1. Call ${toolName} with no last_question_id and no answer.`,
    '   It returns the first question.',
    '2. Ask that question. Rephrase only as much as it takes to sound natural',
    '   spoken aloud -- never change its meaning or its answer options.',
    '3. Wait for the caller to answer.',
    '4. Call the tool again. Pass last_question_id set to the exact question_id',
    '   it gave you, and answer set to what the caller said in their own words.',
    '5. Repeat from step 2 with whatever it returns.',
    '',
    'Hard rules:',
    '- Copy question_id back CHARACTER FOR CHARACTER. It is not a question',
    '  number -- it carries this call\'s identity, and a mangled one detaches',
    '  this call from its own answers.',
    '- Never invent a question, never reorder, never skip one on your own',
    '  judgment. If you are unsure what to ask, call the tool again.',
    '- Ask exactly one question at a time.',
    '- Never guess an answer for the caller. If their reply is unclear, ask a',
    '  short clarifying follow-up, then report what they actually said.',
    '- Report the answer in the caller\'s own words. Do not tidy it into a',
    '  category -- the server classifies it.',
    '',
    'Stopping:',
    '- When the tool returns done=true and terminated=true, stop asking',
    '  questions and read closing_message. Never reveal that they were screened',
    '  out, or why.',
    '- When the tool returns done=true and terminated=false, read',
    '  closing.invitation_script, then react to their reply using',
    '  closing.accept_response or closing.decline_response.',
    '- If the caller wants to end the call early, respect that immediately.',
    '',
    'Stay warm and conversational. This is a phone call, not a form.',
  ].join('\n');

  const end = [
    'Close the call.',
    '',
    'If the caller qualified and accepted, confirm the details once more and',
    'thank them warmly:',
    '',
    screener.closing?.accept_response?.trim() || '(No accept response was captured.)',
    '',
    'If they qualified but declined:',
    '',
    screener.closing?.decline_response?.trim() || '(No decline response was captured.)',
    '',
    'If they were screened out, thank them for their time just as warmly.',
    'Never tell them they were disqualified, and never explain why.',
    '',
    'Say goodbye and end the call.',
  ].join('\n');

  return { start, agent, end };
}

/**
 * Assemble the body for Dograh's create/definition API.
 *
 * Mirrors dograh/create-agent-request-ago-screener.json: three nodes, two
 * edges. `toolUuid` is the get_next_screener_question tool's UUID, which has
 * to be read off the Dograh dashboard -- there is no API for it here yet, so
 * it is passed in rather than guessed.
 */
export function buildAgentDefinition(input: {
  name: string;
  prompts: AgentPrompts;
  toolUuid?: string;
  toolName?: string;
}) {
  return {
    name: input.name,
    workflow_definition: {
      nodes: [
        {
          id: 'start-1',
          type: 'startCall',
          position: { x: 0, y: 0 },
          data: { name: 'Start', prompt: input.prompts.start },
        },
        {
          id: 'ask-1',
          type: 'agentNode',
          position: { x: 320, y: 0 },
          data: {
            name: 'Run Screener',
            prompt: input.prompts.agent,
            wait_for_user_response: true,
            allow_interrupt: true,
            tool_uuids: input.toolUuid ? [input.toolUuid] : [],
            document_uuids: [],
          },
        },
        {
          id: 'end-1',
          type: 'endCall',
          position: { x: 640, y: 0 },
          data: { name: 'End', prompt: input.prompts.end },
        },
      ],
      // Every edge needs BOTH data.label and data.condition. Dograh rejects
      // an empty edge data object with "Field required" on each -- the
      // condition is what the model evaluates to decide when to move on, so
      // an edge without one has no way to fire. Shapes copied from the
      // known-good definitions in this folder.
      edges: [
        {
          id: 'edge-start-ask',
          source: 'start-1',
          target: 'ask-1',
          data: {
            label: 'Begin screener',
            condition:
              'The opening has been delivered and the caller has agreed to continue.',
          },
        },
        {
          id: 'edge-ask-end',
          source: 'ask-1',
          target: 'end-1',
          data: {
            // Dograh turns an edge label into a callable function name --
            // "Begin screener" reaches the model as begin_screener(). Keep
            // labels short and identifier-shaped; a long sentence here
            // becomes a long function name for the model to reproduce.
            label: 'Finish screener',
            condition:
              `The ${input.toolName ?? DEFAULT_TOOL_NAME} tool has returned done=true -- either the caller was disqualified (terminated=true) or the screener finished and the invitation was read -- or the caller wants to end the call early.`,
          },
        },
      ],
    },
  };
}

// workers/icrv-agent/src/llm-planner.ts
// Calls Anthropic claude-sonnet-4-20250514 with structured tool_use.
// The LLM MUST call exactly one tool — this is enforced by tool_choice: 'any'.
// Output is validated and mapped to AgentPlanOutput before returning.
// On parse failure, retries once with an explicit correction message.

import type { AgentControls } from './policy-gate';

// ─────────────────────────────────────────────────────────────────────────────
// Input / output types
// ─────────────────────────────────────────────────────────────────────────────

export interface ContactContext {
  id:                   string;
  name:                 string;
  email?:               string;
  phone_e164?:          string;
  whatsapp_phone_e164?: string;
  attributes:           Record<string, string | number | boolean>;
  tags:                 string[];
}

export interface MessageHistoryItem {
  channel:         string;
  direction:       'inbound' | 'outbound';
  content_summary: string; // ≤ 300 chars — truncated before passing to LLM
  created_at:      string;
  status?:         string;
}

export interface CampaignStepContext {
  step_id:           string;
  step_index:        number;
  channel:           string;
  template_id?:      string;
  template_content?: string; // resolved text (≤ 500 chars)
  branch_logic?:     Record<string, unknown>;
}

export interface AgentPlanInput {
  tenant_id:       string;
  contact:         ContactContext;
  message_history: MessageHistoryItem[];    // last ≤ 20 messages
  consent_state:   Record<string, string>;  // channel → 'granted'|'revoked'|'none'
  campaign_id?:    string;
  campaign_name?:  string;
  campaign_goal?:  string;
  current_step?:   CampaignStepContext;
  tenant_persona:  string;  // e.g. "You are Alex, a sales rep at Acme Corp."
  tenant_goal:     string;  // e.g. "Book a product demo within 5 touches"
  controls:        AgentControls;
  trigger_type:    string;
  trigger_payload: Record<string, unknown>;
}

export type AgentActionType =
  | 'send_email'
  | 'send_whatsapp'
  | 'place_call'
  | 'wait'
  | 'add_tag'
  | 'escalate_to_human'
  | 'stop_sequence';

export interface AgentAction {
  type:                 AgentActionType;
  channel?:             string;
  content?: {
    subject?:              string;
    body_html?:            string;
    body_text?:            string;
    template_name?:        string;
    template_language?:    string;
    template_components?:  unknown[];
    call_script?:          string; // ElevenLabs agent system prompt for this call
  };
  tag?:                 string;
  wait_hours?:          number;
  scheduled_at?:        string; // ISO
  escalation_reason?:   string;
}

export interface AgentPlanOutput {
  actions:       AgentAction[];    // exactly one action per run
  reasoning:     string;
  risk_level:    number;           // 0.0 – 1.0
  confidence:    number;           // 0.0 – 1.0
  next_check_at?: string;          // ISO — when to evaluate again (for waits/follow-ups)
}

export interface PlannerResult {
  plan:          AgentPlanOutput;
  raw_input:     string;           // full JSON sent to Anthropic — stored in R2
  raw_output:    string;           // full JSON received — stored in R2
  input_tokens:  number;
  output_tokens: number;
  cost_usd:      number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions (Anthropic tool_use format)
// Tools are the ONLY allowed output — tool_choice:'any' enforces this.
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_TOOLS = [
  {
    name: 'send_email',
    description:
      'Send a personalized HTML email to the contact. Use for follow-ups, proposals, meeting requests, or value-add content.',
    input_schema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: 'Email subject line — concise, personalized, not spammy',
        },
        body_html: {
          type: 'string',
          description: 'Full HTML body of the email. Include a clear call-to-action.',
        },
        body_text: {
          type: 'string',
          description: 'Plain-text fallback (no HTML tags)',
        },
        reasoning: {
          type: 'string',
          description: 'Why this email, why now, what outcome you expect',
        },
        risk_level: {
          type: 'number',
          description: 'Disruption score 0.0–1.0 for this contact',
        },
        next_check_at: {
          type: 'string',
          description: 'ISO timestamp to check for a reply (omit if handled by campaign step)',
        },
      },
      required: ['subject', 'body_html', 'body_text', 'reasoning', 'risk_level'],
    },
  },
  {
    name: 'send_whatsapp',
    description:
      'Send a WhatsApp template message. Template must already be Meta-approved. Use for conversational follow-ups or alerts.',
    input_schema: {
      type: 'object',
      properties: {
        template_name: {
          type: 'string',
          description: 'Exact pre-approved Meta WhatsApp template name',
        },
        template_language: {
          type: 'string',
          description: 'Language code e.g. en_US',
        },
        template_components: {
          type: 'array',
          description: 'Component parameter objects per Meta Cloud API spec',
          items: { type: 'object' },
        },
        reasoning:     { type: 'string' },
        risk_level:    { type: 'number' },
        next_check_at: { type: 'string' },
      },
      required: ['template_name', 'template_language', 'template_components', 'reasoning', 'risk_level'],
    },
  },
  {
    name: 'place_call',
    description:
      'Initiate an outbound AI voice call via RingCentral + ElevenLabs. High risk — use only after email/WA attempts, or for hot leads.',
    input_schema: {
      type: 'object',
      properties: {
        call_script: {
          type: 'string',
          description:
            'System-prompt-style talking points for the ElevenLabs voice agent for this specific call. Include the contact name, goal, key facts.',
        },
        reasoning:     { type: 'string' },
        risk_level:    { type: 'number' },
        next_check_at: { type: 'string' },
      },
      required: ['call_script', 'reasoning', 'risk_level'],
    },
  },
  {
    name: 'wait',
    description:
      'Take no action now. Schedule a re-evaluation after wait_hours. Use when the contact needs time or recently engaged.',
    input_schema: {
      type: 'object',
      properties: {
        wait_hours: {
          type: 'number',
          description: 'Hours to wait before re-evaluating (0.5–168)',
        },
        reasoning:  { type: 'string' },
        risk_level: { type: 'number' },
      },
      required: ['wait_hours', 'reasoning', 'risk_level'],
    },
  },
  {
    name: 'add_tag',
    description:
      'Apply a CRM tag to the contact for segmentation or future campaign triggers. Does not send any message.',
    input_schema: {
      type: 'object',
      properties: {
        tag:        { type: 'string', description: 'Tag name (lowercase, underscores, no spaces)' },
        reasoning:  { type: 'string' },
        risk_level: { type: 'number' },
      },
      required: ['tag', 'reasoning', 'risk_level'],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Stop the agent and create a human-review task. Use when the conversation is complex, sensitive, or the contact has asked to speak to a person.',
    input_schema: {
      type: 'object',
      properties: {
        escalation_reason: {
          type: 'string',
          description: 'Clear explanation of why human intervention is needed',
        },
        risk_level: { type: 'number' },
      },
      required: ['escalation_reason', 'risk_level'],
    },
  },
  {
    name: 'stop_sequence',
    description:
      'Permanently stop all automated outreach to this contact in the current campaign. Use when contact unsubscribed, not interested, or DNC.',
    input_schema: {
      type: 'object',
      properties: {
        reason:     { type: 'string', description: 'Why the sequence should stop' },
        risk_level: { type: 'number' },
      },
      required: ['reason', 'risk_level'],
    },
  },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builders
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(input: AgentPlanInput): string {
  return `${input.tenant_persona}

You are an autonomous AI sales engagement agent operating on behalf of a B2B sales team.

## Primary Objective
${input.tenant_goal}

## Rules You Must Follow
- Only use channels where consent is: ${JSON.stringify(input.consent_state)}
- Allowed channels (from operator config): ${input.controls.allowed_channels.length > 0 ? input.controls.allowed_channels.join(', ') : 'all'}
- Max messages per day to this contact: ${input.controls.max_per_day}
- Call approval required: ${input.controls.require_call_approval}
- Approval threshold (risk_level above this requires human review): ${input.controls.approval_threshold}

## Decision Principles
1. Be genuinely helpful — reference specific facts from the contact's history
2. Advance the relationship one logical step per touch; never jump ahead
3. If the contact has asked a question, answer it before pitching
4. Choose the lowest-risk channel appropriate for the relationship stage
5. Never sound automated; write as a thoughtful human professional
6. After ${input.controls.max_unanswered_sequence} unanswered touches, stop and escalate

## Risk Level Guide
- 0.0–0.2: Tag only, low-disruption wait
- 0.2–0.4: Cold-ish email, first touch
- 0.4–0.6: Follow-up email, warm WhatsApp
- 0.6–0.8: 3rd+ follow-up, first outbound call attempt
- 0.8–1.0: Aggressive follow-up, cold call, re-engagement after long silence

## Output Requirement
Call EXACTLY ONE tool. Do not output any plain text — your entire response must be a tool call.
Think step-by-step in your reasoning field before committing to an action.`;
}

function buildUserPrompt(input: AgentPlanInput): string {
  // Truncate message history summaries to stay within context budget
  const history = input.message_history.map(m => ({
    at:        m.created_at,
    ch:        m.channel,
    dir:       m.direction,
    status:    m.status,
    summary:   m.content_summary.slice(0, 300),
  }));

  const context = {
    trigger: {
      type:    input.trigger_type,
      payload: input.trigger_payload,
    },
    contact: {
      id:         input.contact.id,
      name:       input.contact.name,
      email:      input.contact.email,
      phone:      input.contact.phone_e164,
      whatsapp:   input.contact.whatsapp_phone_e164,
      attributes: input.contact.attributes,
      tags:       input.contact.tags,
    },
    consent_by_channel: input.consent_state,
    campaign: input.campaign_id
      ? {
          id:           input.campaign_id,
          name:         input.campaign_name,
          goal:         input.campaign_goal,
          current_step: input.current_step
            ? {
                step_index: input.current_step.step_index,
                channel:    input.current_step.channel,
                template:   input.current_step.template_content?.slice(0, 500),
              }
            : null,
        }
      : null,
    message_history_last_20: history,
  };

  return `Evaluate the following context and call the most appropriate tool.\n\n${JSON.stringify(context, null, 2)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic API call
// ─────────────────────────────────────────────────────────────────────────────

interface ToolUseBlock {
  type:  'tool_use';
  id:    string;
  name:  string;
  input: Record<string, unknown>;
}

interface TextBlock {
  type: 'text';
  text: string;
}

interface AnthropicResponse {
  id:          string;
  type:        string;
  role:        string;
  content:     Array<ToolUseBlock | TextBlock>;
  model:       string;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

async function callAnthropic(
  apiKey: string,
  model:  string,
  system: string,
  user:   string,
): Promise<{ response: AnthropicResponse; rawInput: string; rawOutput: string }> {
  const body = {
    model,
    max_tokens:   4096, // 1024 was too low — a single HTML email can exceed 1500 tokens
    system,
    tools:        AGENT_TOOLS,
    tool_choice:  { type: 'any' }, // force at least one tool call
    messages:     [{ role: 'user', content: user }],
  };

  const rawInput = JSON.stringify(body);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: rawInput,
  });

  const rawOutput = await res.text();

  if (!res.ok) {
    throw new Error(`anthropic_api_error:${res.status}:${rawOutput.slice(0, 200)}`);
  }

  const response = JSON.parse(rawOutput) as AnthropicResponse;
  return { response, rawInput, rawOutput };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool use parser — maps raw Anthropic tool block to AgentPlanOutput
// ─────────────────────────────────────────────────────────────────────────────

function parsePlanFromToolUse(
  response: AnthropicResponse,
): AgentPlanOutput {
  const toolBlock = response.content.find(
    (b): b is ToolUseBlock => b.type === 'tool_use',
  );
  if (!toolBlock) throw new Error('llm_no_tool_use_block');

  const { name, input: ti } = toolBlock;

  // Extract cross-tool fields
  const riskLevel = typeof ti.risk_level === 'number'
    ? Math.max(0, Math.min(1, ti.risk_level))
    : 0.5;

  const reasoning =
    (ti.reasoning as string | undefined) ??
    (ti.escalation_reason as string | undefined) ??
    (ti.reason as string | undefined) ??
    'No reasoning provided';

  const nextCheckAt = typeof ti.next_check_at === 'string'
    ? ti.next_check_at
    : undefined;

  let action: AgentAction;

  switch (name) {
    case 'send_email': {
      if (typeof ti.subject !== 'string' || typeof ti.body_html !== 'string') {
        throw new Error('llm_send_email_missing_fields');
      }
      action = {
        type:    'send_email',
        channel: 'email',
        content: {
          subject:   ti.subject as string,
          body_html: ti.body_html as string,
          body_text: typeof ti.body_text === 'string'
            ? (ti.body_text as string)
            : stripHtml(ti.body_html as string),
        },
        scheduled_at: nextCheckAt,
      };
      break;
    }

    case 'send_whatsapp': {
      if (typeof ti.template_name !== 'string') {
        throw new Error('llm_send_whatsapp_missing_template_name');
      }
      action = {
        type:    'send_whatsapp',
        channel: 'whatsapp',
        content: {
          template_name:       ti.template_name as string,
          template_language:   (ti.template_language as string | undefined) ?? 'en_US',
          template_components: Array.isArray(ti.template_components)
            ? ti.template_components as unknown[]
            : [],
        },
        scheduled_at: nextCheckAt,
      };
      break;
    }

    case 'place_call': {
      if (typeof ti.call_script !== 'string') {
        throw new Error('llm_place_call_missing_script');
      }
      action = {
        type:    'place_call',
        channel: 'voice',
        content: { call_script: ti.call_script as string },
        scheduled_at: nextCheckAt,
      };
      break;
    }

    case 'wait': {
      const raw = typeof ti.wait_hours === 'number' ? ti.wait_hours : 24;
      const waitHours = Math.max(0.5, Math.min(168, raw));
      action = {
        type:         'wait',
        wait_hours:   waitHours,
        scheduled_at: new Date(Date.now() + waitHours * 3_600_000).toISOString(),
      };
      break;
    }

    case 'add_tag': {
      if (typeof ti.tag !== 'string' || ti.tag.trim() === '') {
        throw new Error('llm_add_tag_missing_tag');
      }
      action = {
        type: 'add_tag',
        tag:  (ti.tag as string).trim().toLowerCase().replace(/\s+/g, '_'),
      };
      break;
    }

    case 'escalate_to_human': {
      action = {
        type:               'escalate_to_human',
        escalation_reason:  (ti.escalation_reason as string | undefined) ?? 'agent_escalation',
      };
      break;
    }

    case 'stop_sequence': {
      action = {
        type: 'stop_sequence',
      };
      break;
    }

    default:
      throw new Error(`llm_unknown_tool:${name}`);
  }

  return {
    actions:       [action],
    reasoning,
    risk_level:    riskLevel,
    confidence:    parseFloat((1 - riskLevel * 0.4).toFixed(3)), // heuristic inverse
    next_check_at: nextCheckAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Token cost (Sonnet 4 pricing — update if Anthropic changes rates)
// ─────────────────────────────────────────────────────────────────────────────

const INPUT_COST_PER_TOKEN  = 3.00  / 1_000_000; // $3.00 / 1M
const OUTPUT_COST_PER_TOKEN = 15.00 / 1_000_000; // $15.00 / 1M

// ─────────────────────────────────────────────────────────────────────────────
// Main exported function
// ─────────────────────────────────────────────────────────────────────────────

export async function runLlmPlanner(
  input:  AgentPlanInput,
  apiKey: string,
  model:  string,
): Promise<PlannerResult> {
  const systemPrompt = buildSystemPrompt(input);
  const userPrompt   = buildUserPrompt(input);

  // First attempt
  let callResult = await callAnthropic(apiKey, model, systemPrompt, userPrompt);

  let plan: AgentPlanOutput;
  try {
    plan = parsePlanFromToolUse(callResult.response);
  } catch (parseErr) {
    // Retry once — add explicit correction instruction as a second user turn
    const correctionPrompt =
      userPrompt +
      '\n\n[CORRECTION REQUIRED: Your previous response was not a valid tool call. ' +
      'You MUST call exactly one of the provided tools. Do not output plain text. ' +
      `Parse error: ${(parseErr as Error).message}]`;

    callResult = await callAnthropic(apiKey, model, systemPrompt, correctionPrompt);
    plan = parsePlanFromToolUse(callResult.response); // throws if still invalid → propagates to caller
  }

  const { usage } = callResult.response;
  const costUsd =
    usage.input_tokens  * INPUT_COST_PER_TOKEN +
    usage.output_tokens * OUTPUT_COST_PER_TOKEN;

  return {
    plan,
    raw_input:     callResult.rawInput,
    raw_output:    callResult.rawOutput,
    input_tokens:  usage.input_tokens,
    output_tokens: usage.output_tokens,
    cost_usd:      parseFloat(costUsd.toFixed(6)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

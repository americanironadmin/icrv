// workers/icrv-agent/src/policy-gate.ts
// Pure policy evaluation — zero external calls, deterministically testable.
// Called BEFORE the LLM to gate whether the agent is even allowed to act.
//
// Hierarchy (most-specific wins):
//   global → tenant → campaign → contact
// All four levels are merged into AgentControls before calling evaluatePolicy().

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type PolicyOutcome =
  | 'allow'
  | 'require_approval'
  | 'defer'
  | 'block'
  | 'escalate';

export interface PolicyResult {
  outcome: PolicyOutcome;
  reason: string;
  next_run_at?: string; // ISO — set only when outcome === 'defer'
}

export interface QuietHoursConfig {
  start:    string; // 'HH:MM' 24h
  end:      string; // 'HH:MM' 24h
  timezone: string; // IANA tz e.g. 'America/New_York'
}

/** Merged agent controls — most-specific scope wins per field */
export interface AgentControls {
  /** Immediately halt the agent at any level. */
  kill_switch: boolean;

  /** Which outbound channels the agent may use. Empty = all allowed. */
  allowed_channels: string[];

  /** Do not send messages outside this window. */
  quiet_hours?: QuietHoursConfig;

  /** Max outbound actions per calendar day (UTC) for a single contact. */
  max_per_day: number;

  /**
   * risk_level threshold (0–1) above which operator approval is required.
   * 0 = always approve, 1 = never require approval.
   */
  approval_threshold: number;

  /** Always route place_call actions through human approval. */
  require_call_approval: boolean;

  /**
   * After this many un-replied outbound messages, escalate to human.
   * 0 = no limit.
   */
  max_unanswered_sequence: number;
}

export interface PolicyContext {
  tenant_id:    string;
  contact_id:   string;
  channel:      string;         // the channel the LLM intends to use
  controls:     AgentControls;
  consent_state: Record<string, 'granted' | 'revoked' | 'none'>;
  is_suppressed: boolean;
  sent_today:    number;        // outbound messages sent today to this contact
  unanswered_sequence: number;  // consecutive outbound messages with no inbound reply
  recent_runs: Array<{
    trigger_type: string;
    created_at:   string;
    status:       string;
  }>;
  now_iso: string; // current time as ISO string (injected so pure)
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when nowISO falls inside the quiet window.
 * Handles overnight windows (e.g. 22:00 → 08:00) correctly.
 */
function isInQuietHours(qh: QuietHoursConfig, nowISO: string): boolean {
  const now = new Date(nowISO);

  const formatter = new Intl.DateTimeFormat('en-US', {
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
    timeZone: qh.timezone,
  });

  // formatter.format returns "HH:MM" (with leading zero)
  const localTime = formatter.format(now);

  const toMins = (hhmm: string): number => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };

  const startMins = toMins(qh.start);
  const endMins   = toMins(qh.end);
  const nowMins   = toMins(localTime);

  if (startMins < endMins) {
    // Same-day window e.g. 01:00–06:00
    return nowMins >= startMins && nowMins < endMins;
  }
  // Overnight window e.g. 22:00–08:00
  return nowMins >= startMins || nowMins < endMins;
}

/**
 * Advance nowISO by 1-hour increments until we exit the quiet window.
 * Returns an ISO string of the first moment outside quiet hours.
 * Cap at +25 h to avoid infinite loops on bad config.
 */
function nextWindowOpen(qh: QuietHoursConfig, nowISO: string): string {
  let candidate = new Date(nowISO);
  for (let i = 0; i < 25; i++) {
    candidate = new Date(candidate.getTime() + 60 * 60_000);
    if (!isInQuietHours(qh, candidate.toISOString())) {
      return candidate.toISOString();
    }
  }
  // Fallback: +24 h
  return new Date(new Date(nowISO).getTime() + 24 * 3_600_000).toISOString();
}

/**
 * Loop detection: 3+ agent_runs for this contact within the last 10 minutes
 * means the system is likely in a feedback loop.
 */
function detectLoop(recentRuns: PolicyContext['recent_runs'], nowISO: string): boolean {
  const windowMs = 10 * 60_000;
  const cutoff   = new Date(nowISO).getTime() - windowMs;
  const count    = recentRuns.filter(r => new Date(r.created_at).getTime() >= cutoff).length;
  return count >= 3;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

export function evaluatePolicy(ctx: PolicyContext): PolicyResult {
  const {
    controls, consent_state, channel,
    is_suppressed, sent_today, unanswered_sequence, recent_runs, now_iso,
  } = ctx;

  // ── 1. Kill switch — highest priority at any scope ────────────────────────
  if (controls.kill_switch) {
    return { outcome: 'block', reason: 'kill_switch_active' };
  }

  // ── 2. Consent revoked ────────────────────────────────────────────────────
  const channelConsent = consent_state[channel] ?? 'none';
  if (channelConsent === 'revoked') {
    return { outcome: 'block', reason: `consent_revoked:${channel}` };
  }

  // ── 3. Suppression list ───────────────────────────────────────────────────
  if (is_suppressed) {
    return { outcome: 'block', reason: 'contact_suppressed' };
  }

  // ── 4. Channel allow-list ─────────────────────────────────────────────────
  if (
    controls.allowed_channels.length > 0 &&
    !controls.allowed_channels.includes(channel)
  ) {
    return { outcome: 'block', reason: `channel_not_allowed:${channel}` };
  }

  // ── 5. Quiet hours ────────────────────────────────────────────────────────
  if (controls.quiet_hours && isInQuietHours(controls.quiet_hours, now_iso)) {
    return {
      outcome:      'defer',
      reason:       'quiet_hours',
      next_run_at:  nextWindowOpen(controls.quiet_hours, now_iso),
    };
  }

  // ── 6. Daily outbound cap ─────────────────────────────────────────────────
  if (controls.max_per_day > 0 && sent_today >= controls.max_per_day) {
    // Defer to 09:00 UTC next day
    const tomorrow = new Date(now_iso);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(9, 0, 0, 0);
    return {
      outcome:     'defer',
      reason:      'max_per_day_reached',
      next_run_at: tomorrow.toISOString(),
    };
  }

  // ── 7. Unanswered sequence limit ──────────────────────────────────────────
  if (
    controls.max_unanswered_sequence > 0 &&
    unanswered_sequence >= controls.max_unanswered_sequence
  ) {
    return { outcome: 'escalate', reason: 'max_unanswered_sequence_reached' };
  }

  // ── 8. Loop detection ─────────────────────────────────────────────────────
  if (detectLoop(recent_runs, now_iso)) {
    return { outcome: 'escalate', reason: 'loop_detected' };
  }

  // NOTE: require_call_approval is intentionally NOT checked here.
  // The policy gate runs BEFORE the LLM, so we do not yet know the action type.
  // Call approval is enforced in index.ts Step 5, after the LLM returns.

  return { outcome: 'allow', reason: 'all_checks_passed' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge helper — builds a single AgentControls from D1 rows
//
// Row format from agent_controls table:
//   scope: 'global' | 'tenant' | 'campaign' | 'contact'
//   controls_json: JSON string of Partial<AgentControls>
//
// Most-specific scope wins per individual field.
// ─────────────────────────────────────────────────────────────────────────────

type ControlScope = 'global' | 'tenant' | 'campaign' | 'contact';

interface AgentControlsRow {
  scope:         ControlScope;
  controls_json: string;
}

const SCOPE_PRIORITY: Record<ControlScope, number> = {
  global:   0,
  tenant:   1,
  campaign: 2,
  contact:  3,
};

export function mergeAgentControls(rows: AgentControlsRow[]): AgentControls {
  // Default (permissive) values
  const merged: AgentControls = {
    kill_switch:              false,
    allowed_channels:         [],
    quiet_hours:              undefined,
    max_per_day:              20,
    approval_threshold:       0.8,
    require_call_approval:    false,
    max_unanswered_sequence:  5,
  };

  // Sort ascending by priority (global first, contact last = wins)
  const sorted = [...rows].sort(
    (a, b) => SCOPE_PRIORITY[a.scope] - SCOPE_PRIORITY[b.scope],
  );

  for (const row of sorted) {
    let partial: Partial<AgentControls>;
    try {
      partial = JSON.parse(row.controls_json) as Partial<AgentControls>;
    } catch {
      continue; // malformed row — skip
    }

    if (partial.kill_switch !== undefined)           merged.kill_switch = partial.kill_switch;
    if (partial.allowed_channels !== undefined)      merged.allowed_channels = partial.allowed_channels;
    if (partial.quiet_hours !== undefined)           merged.quiet_hours = partial.quiet_hours;
    if (partial.max_per_day !== undefined)           merged.max_per_day = partial.max_per_day;
    if (partial.approval_threshold !== undefined)    merged.approval_threshold = partial.approval_threshold;
    if (partial.require_call_approval !== undefined) merged.require_call_approval = partial.require_call_approval;
    if (partial.max_unanswered_sequence !== undefined) merged.max_unanswered_sequence = partial.max_unanswered_sequence;
  }

  return merged;
}

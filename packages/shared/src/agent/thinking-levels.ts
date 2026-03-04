/**
 * Thinking/Effort Configuration
 *
 * Provider-aligned effort levels:
 * - GPT/Codex reasoning effort: low | medium | high | xhigh
 * - Claude effort (official slider): low | medium | high
 *
 * Legacy compatibility:
 * - think -> medium
 * - max remains valid for internal ultrathink override paths
 */

export type ThinkingLevel =
  | 'off'
  | 'think' // legacy alias for medium
  | 'low'
  | 'medium'
  | 'high'
  | 'max'
  | 'xhigh';

export interface ThinkingLevelDefinition {
  id: ThinkingLevel;
  name: string;
  description: string;
}

/** Canonical levels shown in generic contexts */
export const THINKING_LEVELS: readonly ThinkingLevelDefinition[] = [
  { id: 'off', name: 'No Thinking', description: 'Fastest responses, no reasoning' },
  { id: 'low', name: 'Low', description: 'Lower effort, faster and cheaper' },
  { id: 'medium', name: 'Medium', description: 'Balanced effort' },
  { id: 'high', name: 'High', description: 'Thorough reasoning' },
  { id: 'xhigh', name: 'XHigh', description: 'Highest GPT reasoning effort' },
  { id: 'max', name: 'Max', description: 'Internal ultrathink override' },
] as const;

/** Provider-specific display levels */
export const GPT_EFFORT_LEVELS: readonly ThinkingLevelDefinition[] = [
  { id: 'low', name: 'Low', description: 'Official GPT reasoning effort: low' },
  { id: 'medium', name: 'Medium', description: 'Official GPT reasoning effort: medium' },
  { id: 'high', name: 'High', description: 'Official GPT reasoning effort: high' },
  { id: 'xhigh', name: 'XHigh', description: 'Official GPT reasoning effort: xhigh' },
] as const;

export const CLAUDE_EFFORT_LEVELS: readonly ThinkingLevelDefinition[] = [
  { id: 'low', name: 'Low', description: 'Official Claude effort: low' },
  { id: 'medium', name: 'Medium', description: 'Official Claude effort: medium' },
  { id: 'high', name: 'High', description: 'Official Claude effort: high (default)' },
] as const;

/** Default thinking level for new sessions when workspace has no default */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';

const TOKEN_BUDGETS = {
  haiku: {
    off: 0,
    low: 2_000,
    medium: 4_000,
    high: 6_000,
    max: 8_000,
  },
  default: {
    off: 0,
    low: 4_000,
    medium: 10_000,
    high: 20_000,
    max: 32_000,
  },
} as const;

/** Normalize legacy aliases to canonical internal levels. */
export function normalizeThinkingLevel(level: ThinkingLevel): Exclude<ThinkingLevel, 'think' | 'xhigh'> | 'xhigh' {
  if (level === 'think') return 'medium';
  return level;
}

/**
 * Get the thinking token budget for Claude SDK thinking tokens.
 * xhigh is mapped to max budget on Claude paths.
 */
export function getThinkingTokens(level: ThinkingLevel, modelId: string): number {
  const normalized = normalizeThinkingLevel(level);
  const budgetLevel = normalized === 'xhigh' ? 'max' : normalized;
  const isHaiku = modelId.toLowerCase().includes('haiku');
  const budgets = isHaiku ? TOKEN_BUDGETS.haiku : TOKEN_BUDGETS.default;
  return budgets[budgetLevel as keyof typeof budgets];
}

export function getThinkingLevelName(level: ThinkingLevel): string {
  const normalized = normalizeThinkingLevel(level);
  if (normalized === 'medium' && level === 'think') return 'Medium';
  const def = THINKING_LEVELS.find((l) => l.id === normalized);
  return def?.name ?? normalized;
}

export function isValidThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === 'off' || value === 'think' || value === 'low' || value === 'medium' || value === 'high' || value === 'max' || value === 'xhigh';
}

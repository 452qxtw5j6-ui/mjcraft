/**
 * Session Options Types
 *
 * Type definitions and helpers for session-scoped settings.
 * The actual hook is in AppShellContext.tsx as useSessionOptionsFor().
 *
 * ADDING A NEW SESSION OPTION:
 * 1. Add field to SessionOptions interface below
 * 2. Update defaultSessionOptions
 * 3. Add UI control in FreeFormInput.tsx (or wherever needed)
 */

import type { PermissionMode } from '../../shared/types'
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import { DEFAULT_THINKING_LEVEL, normalizeThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'

/**
 * All session-scoped options in one place.
 */
export interface SessionOptions {
  /** Permission mode ('safe', 'ask', 'allow-all') */
  permissionMode: PermissionMode
  /** Monotonic version from backend permission mode state (used to ignore stale events) */
  permissionModeVersion?: number
  /** Session-level thinking level ('off', 'low', 'medium', 'high', 'max') - sticky, persisted */
  thinkingLevel: ThinkingLevel
}

/** Default values for new sessions */
export const defaultSessionOptions: SessionOptions = {
  permissionMode: 'ask', // Default to ask mode (prompt for permissions)
  thinkingLevel: DEFAULT_THINKING_LEVEL, // Default to 'medium' level
}

/** Type for partial updates to session options */
export type SessionOptionUpdates = Partial<SessionOptions>

export function resolveSessionThinkingLevel(value: unknown): ThinkingLevel {
  return normalizeThinkingLevel(value) ?? DEFAULT_THINKING_LEVEL
}

export function normalizeSessionOptions(options: Partial<SessionOptions> | undefined): SessionOptions {
  return {
    ...defaultSessionOptions,
    ...options,
    thinkingLevel: resolveSessionThinkingLevel(options?.thinkingLevel),
  }
}

/** Helper to merge session options with updates */
export function mergeSessionOptions(
  current: SessionOptions | undefined,
  updates: SessionOptionUpdates
): SessionOptions {
  return normalizeSessionOptions({
    ...current,
    ...updates,
  })
}

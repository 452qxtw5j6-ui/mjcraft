/**
 * Session title generation utilities.
 *
 * Shared helpers for building title prompts and validating results.
 * Actual title generation is handled by agent classes using their respective SDKs:
 * - ClaudeAgent: Uses Claude SDK query()
 * - CodexAgent: Uses OpenAI SDK
 */

/**
 * Build a prompt for generating a session title from a user message.
 *
 * @param message - The user's message to generate a title from
 * @returns Formatted prompt string
 */
export function buildTitlePrompt(message: string): string {
  const snippet = message.slice(0, 500);
  return [
    'What topic or area is the user exploring? Reply with ONLY a short topic label (2-5 words).',
    'Use a noun phrase — NOT a verb/action. Use plain text only - no markdown.',
    'If the user has a clear specific task, name the area it belongs to, not the action.',
    'Examples: "Auto Title Generation", "Dark Mode Support", "API Authentication", "Database Schema Design", "React Performance"',
    '',
    'User: ' + snippet,
    '',
    'Topic:',
  ].join('\n');
}

/**
 * Build a prompt for regenerating a session title from recent messages.
 *
 * @param recentUserMessages - The last few user messages
 * @param lastAssistantResponse - The most recent assistant response
 * @returns Formatted prompt string
 */
export function buildRegenerateTitlePrompt(
  recentUserMessages: string[],
  lastAssistantResponse: string
): string {
  const userContext = recentUserMessages
    .map((msg) => msg.slice(0, 300))
    .join('\n\n');
  const assistantSnippet = lastAssistantResponse.slice(0, 500);

  return [
    'Based on these recent messages, what topic or area is this conversation about?',
    'Reply with ONLY a short topic label (2-5 words).',
    'Use a noun phrase — NOT a verb/action. Use plain text only - no markdown.',
    'Examples: "Auto Title Generation", "Dark Mode Support", "API Authentication", "Database Schema Design"',
    '',
    'Recent user messages:',
    userContext,
    '',
    'Latest assistant response:',
    assistantSnippet,
    '',
    'Topic:',
  ].join('\n');
}

/**
 * Validate and clean a generated title.
 *
 * @param title - The raw title from the model
 * @returns Cleaned title, or null if invalid
 */
export function validateTitle(title: string | null | undefined): string | null {
  const trimmed = title?.trim();
  if (trimmed && trimmed.length > 0 && trimmed.length < 100) {
    return trimmed;
  }
  return null;
}

/**
 * Title sanitization utility.
 * Extracted to a separate file to allow unit testing without importing
 * Electron main process modules.
 */
import { WS_ID_CHARS } from '@craft-agent/shared/mentions'
import { isLowSignal, sliceAtWord } from '@craft-agent/shared/utils'

/**
 * Sanitize message content for use as session title.
 * Strips XML blocks (e.g. <edit_request>), bracket mentions, and normalizes whitespace.
 */
export function sanitizeForTitle(content: string): string {
  return content
    .replace(/<edit_request>[\s\S]*?<\/edit_request>/g, '') // Strip entire edit_request blocks
    .replace(/<[^>]+>/g, '')     // Strip remaining XML/HTML tags
    .replace(new RegExp(`\\[skill:(?:${WS_ID_CHARS}+:)?[\\w-]+\\]`, 'g'), '')   // Strip [skill:...] mentions
    .replace(/\[source:[\w-]+\]/g, '')                // Strip [source:...] mentions
    .replace(/\[file:[^\]]+\]/g, '')                  // Strip [file:...] mentions
    .replace(/\[folder:[^\]]+\]/g, '')                // Strip [folder:...] mentions
    .replace(/\s+/g, ' ')        // Collapse whitespace
    .trim()
}

/**
 * Build a deterministic fallback title when model-based regeneration fails.
 * Prefers the most recent substantive user message after sanitization.
 */
export function deriveFallbackTitleFromMessages(messages: string[]): string | null {
  const sanitizedMessages = messages
    .map(message => sanitizeForTitle(message))
    .map(message => message.replace(/\s+/g, ' ').trim())
    .filter(message => message.length > 0)

  if (sanitizedMessages.length === 0) return null

  const substantiveMessages = sanitizedMessages.filter(message => !isLowSignal(message))
  const candidate = (substantiveMessages.length > 0
    ? substantiveMessages[substantiveMessages.length - 1]
    : sanitizedMessages[sanitizedMessages.length - 1])!

  const shortened = sliceAtWord(candidate, 50).trim()
  if (shortened.length === 0) return null

  return shortened.length < candidate.length ? `${shortened}…` : shortened
}

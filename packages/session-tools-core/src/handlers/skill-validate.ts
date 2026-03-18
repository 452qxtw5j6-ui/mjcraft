/**
 * Skill Validate Handler
 *
 * Validates a skill's SKILL.md file for correct format and required fields.
 * Resolves skills from the official workspace skills directory only.
 */

import { join } from 'node:path';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse } from '../response.ts';
import {
  validateSlug,
  validateSkillContent,
  formatValidationResult,
} from '../validation.ts';

export interface SkillValidateArgs {
  skillSlug: string;
}

/**
 * Resolve the SKILL.md path from the workspace skills directory.
 */
function resolveSkillMdPath(
  ctx: SessionToolContext,
  slug: string,
): { path: string; tier: string } | null {
  // Workspace-level: {workspace}/skills/{slug}/SKILL.md
  const workspacePath = join(ctx.workspacePath, 'skills', slug, 'SKILL.md');
  if (ctx.fs.exists(workspacePath)) {
    return { path: workspacePath, tier: 'workspace' };
  }

  return null;
}

/**
 * Handle the skill_validate tool call.
 *
 * 1. Validate slug format
 * 2. Resolve SKILL.md from the workspace skills directory
 * 3. Read and validate content (frontmatter + body)
 * 4. Return validation result
 */
export async function handleSkillValidate(
  ctx: SessionToolContext,
  args: SkillValidateArgs
): Promise<ToolResult> {
  const { skillSlug } = args;

  // Validate slug format first
  const slugResult = validateSlug(skillSlug);
  if (!slugResult.valid) {
    return {
      content: [{ type: 'text', text: formatValidationResult(slugResult) }],
      isError: true,
    };
  }

  // Resolve SKILL.md from the workspace skills directory
  const resolved = resolveSkillMdPath(ctx, skillSlug);
  if (!resolved) {
    return errorResponse(
      `SKILL.md not found for skill "${skillSlug}". Searched:\n  - ${join(ctx.workspacePath, 'skills', skillSlug, 'SKILL.md')} (workspace)\n\nCreate it with YAML frontmatter.`
    );
  }

  // Read and validate content
  let content: string;
  try {
    content = ctx.fs.readFile(resolved.path);
  } catch (e) {
    return errorResponse(
      `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`
    );
  }

  const result = validateSkillContent(content, skillSlug);
  const tierInfo = `Validated from ${resolved.tier} tier: ${resolved.path}`;
  const formatted = formatValidationResult(result);

  return {
    content: [{ type: 'text', text: `${tierInfo}\n\n${formatted}` }],
    isError: !result.valid,
  };
}

/**
 * Slash-line direct execution — the "a typed command runs a LOCAL script" seam.
 *
 * A slash line whose name is allowlisted in `slashCommands` runs a local
 * command instead of becoming an agent turn: no model, no tokens, no first-
 * token latency, and no content policy between the operator and a purely local
 * tool. It is the typed sibling of the card-button seam (`card-run.ts`) and it
 * reuses that module's security envelope verbatim — the LINE never names a
 * path; only the configured `file` + fixed `args` + `cwd` decide what runs,
 * every argument is one argv element (no shell), and a name outside the
 * allowlist is refused.
 *
 * `/stop` is the built-in case: it is a SURFACE command, so the bridge
 * intercepts it before any dsh passthrough, cancels every RUNNING conversation
 * (selected from the in-memory agent registry by each agent's own `status`, so
 * no stored history is read), and then consults this allowlist for an entry
 * named `stop` — the deployment's hard-kill cleanup script (see
 * {@link parseSlashArgs} for how the line's own trailing text reaches that
 * script).
 *
 * @module @dsh-feishu/dsh-feishu/slash-commands
 */

import type { CardCommandConfig, CardCommandSpec, CardRunOutcome } from './card-run.js';
import { normalizeCardCommands } from './card-run.js';
import type { CommandResult } from './commands.js';
import { t } from './i18n/index.js';

/** One allowlisted slash command: the same shape a card button may reference. */
export type SlashCommandSpec = CardCommandSpec;

/** One `slashCommands` CONFIG entry (normalized by {@link normalizeSlashCommands}). */
export type SlashCommandConfig = CardCommandConfig;

/**
 * Normalize `slashCommands` config entries into strict specs. Same contract as
 * {@link normalizeCardCommands}: a nameless entry is dead config (nothing can
 * reference it) and is dropped, empty strings count as absent.
 * @param entries - the raw `slashCommands` config value.
 * @returns the usable specs, in config order.
 */
export function normalizeSlashCommands(
  entries: readonly SlashCommandConfig[] | undefined,
): SlashCommandSpec[] {
  return normalizeCardCommands(entries);
}

/**
 * Split the trailing text of a slash line into argv.
 *
 * Whitespace-separated and deliberately WITHOUT quote/escape parsing: the line
 * is user input, and the runner never re-enters a shell, so a token that looks
 * like shell syntax stays one literal argv element. An empty rest is no args.
 * @param rawInput - the text after the command name (separator whitespace included).
 * @returns the arguments, possibly empty.
 */
export function parseSlashArgs(rawInput: string): string[] {
  const trimmed = rawInput.trim();
  return trimmed === '' ? [] : trimmed.split(/\s+/);
}

/**
 * Render a direct-run outcome as the chat reply. A started run names the child
 * pid and its capture file — the script owns its own progress reporting, so the
 * surface only proves it started.
 * @param name - the allowlisted entry that ran.
 * @param outcome - the runner's outcome.
 * @returns the command result to reply with.
 */
export function slashRunResult(name: string, outcome: CardRunOutcome): CommandResult {
  if (outcome.ok) {
    return {
      kind: 'success',
      text: t('slashRun.started', { name, pid: outcome.pid, log: outcome.logFile }),
    };
  }
  switch (outcome.code) {
    case 'not-allowed':
      return { kind: 'error', text: t('slashRun.notAllowed', { name }) };
    case 'busy':
      return { kind: 'error', text: t('slashRun.busy', { name, detail: outcome.detail }) };
    case 'invalid':
      return { kind: 'error', text: t('slashRun.invalid', { detail: outcome.detail }) };
    case 'spawn-failed':
      return { kind: 'error', text: t('slashRun.failed', { name, detail: outcome.detail }) };
  }
}

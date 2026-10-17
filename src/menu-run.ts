/**
 * Bot custom-menu command table — the `event_key → command` seam.
 *
 * A bot's custom menu (the items above the composer) offers three response
 * actions; only "推送事件" (push event) reaches this surface, as an
 * `application.bot.menu_v6` event whose `event_key` is the menu item's
 * developer-defined identifier. That key is the ONLY menu identity in the
 * payload — no menu name, no menu id, no hierarchy, and no chat id — so a
 * mapping table IS the dispatch mechanism, and an unmapped key is a
 * configuration gap worth reporting loudly (a silently ignored click is
 * indistinguishable from a broken bot).
 *
 * An entry does NOT name an executable: it points at a `cardCommands` entry by
 * NAME, so a single allowlist (and its path/argv security envelope, see
 * {@link CardCommandRunner}) remains the only thing that decides what runs.
 *
 * @module @dsh-feishu/dsh-feishu/menu-run
 */

/**
 * One `menuCommands` CONFIG entry. Every field is optional/nullable because
 * that is what the config schema materializes; {@link normalizeMenuCommands}
 * turns the raw list into strict specs.
 */
export interface MenuCommandConfig {
  /** The menu item's developer-defined event key (the event's `event_key`). */
  readonly eventKey?: string | null;
  /** The `cardCommands` entry name to run when this key is clicked. */
  readonly command?: string | null;
  /**
   * Extra whole-argument templates, appended AFTER the referenced entry's own
   * args. Same substitution rules as a card button's args (`{operator}` etc.);
   * a menu click has no card and no chat id of its own.
   */
  readonly args?: string[] | null;
}

/** A usable mapping: one menu event key → one allowlisted command. */
export interface MenuCommandSpec {
  readonly eventKey: string;
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Normalize config entries into strict specs.
 *
 * An entry missing either half of the mapping is dropped rather than failing
 * the boot: a key with no command can never run anything, and a command with
 * no key can never be selected — both are dead config, not a runtime error.
 * @param entries - the raw `menuCommands` config value.
 * @returns the usable specs, in config order.
 */
export function normalizeMenuCommands(
  entries: readonly MenuCommandConfig[] | undefined,
): MenuCommandSpec[] {
  const specs: MenuCommandSpec[] = [];
  for (const entry of entries ?? []) {
    const eventKey = typeof entry.eventKey === 'string' ? entry.eventKey.trim() : '';
    const command = typeof entry.command === 'string' ? entry.command.trim() : '';
    if (eventKey === '' || command === '') continue;
    specs.push({
      eventKey,
      command,
      args: Array.isArray(entry.args) ? [...entry.args] : [],
    });
  }
  return specs;
}

/**
 * The resolved menu mapping. A later entry with the same key wins (last
 * registration wins, matching the surface's other single-slot seams), so a
 * config overridden by a patch layer behaves predictably.
 */
export class MenuCommandTable {
  private readonly byKey = new Map<string, MenuCommandSpec>();

  /**
   * @param specs - normalized entries (see {@link normalizeMenuCommands}).
   */
  constructor(specs: readonly MenuCommandSpec[]) {
    for (const spec of specs) this.byKey.set(spec.eventKey, spec);
  }

  /**
   * Look up the command a menu click asked for.
   * @param eventKey - the event's `event_key`.
   * @returns the mapping, or `undefined` when the key is not configured.
   */
  resolve(eventKey: string): MenuCommandSpec | undefined {
    return this.byKey.get(eventKey);
  }

  /** The configured keys, in insertion order (diagnostics + unknown-key logs). */
  keys(): readonly string[] {
    return [...this.byKey.keys()];
  }

  /** Number of configured mappings. */
  get size(): number {
    return this.byKey.size;
  }
}

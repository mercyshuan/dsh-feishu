/**
 * Card-button command runner — the "点按钮直接执行" seam.
 *
 * A card this surface did NOT render (a skill's control card, built with
 * lark-cli) can carry buttons whose `behaviors:[{type:'callback'}]` value asks
 * the surface to run a LOCAL command — no agent turn, no model in the loop. It
 * exists because the agent path is not always the right one: an LLM turn costs
 * tokens and latency, and its own content policy sits between the user and a
 * purely local tool. For a card that is a UI over a local engine, the button is
 * better off executing the tool directly.
 *
 * SECURITY — this is remote command execution triggered from a chat button, so
 * the rules are deliberately narrow:
 * - **The card never names a path.** It names a configured `cardCommands`
 *   entry (`{name}`), and only `file` + fixed `args` + `cwd` from the CONFIG
 *   decide what runs. An unknown name is refused (and reported), never guessed.
 * - **No shell.** `spawn(file, args, {shell: false})` — every argument is one
 *   argv element, so nothing in a substituted value is ever re-parsed as shell
 *   syntax. Quoting games are structurally impossible.
 * - **Template substitution is whole-argument only** (`{card}`, `{chat}`,
 *   `{operator}`, `{form.<key>}`): an argument is either a placeholder or a
 *   literal — never a concatenation that could smuggle one value into another.
 *   Unknown placeholders are refused rather than silently emptied.
 * - **Bounds**: argument count, argument length, and concurrent runs are
 *   capped; a per-chat lock refuses a second run while one is still alive.
 * - **Audit trail**: every run gets its own log file holding the child's
 *   stdout/stderr, and the resolved argv is logged.
 *
 * Failures are LOUD: the caller reports them back to the chat, because a button
 * that silently does nothing is the exact bug this seam was born from.
 *
 * @module @dsh-feishu/dsh-feishu/card-run
 */

import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** One allowlisted command a card button may ask for. */
export interface CardCommandSpec {
  /** The name a card button references (`value.name`). Case-sensitive. */
  readonly name: string;
  /** Executable to spawn. Defaults to this process's own Node binary. */
  readonly file?: string;
  /** Fixed leading arguments (e.g. the script path), before the card's own. */
  readonly args?: readonly string[];
  /** Child working directory. Defaults to the surface process cwd. */
  readonly cwd?: string;
}

/** What a card button asked for (validated shape of `action.value`). */
export interface CardRunRequest {
  readonly name: string;
  readonly args: readonly string[];
}

/**
 * One `cardCommands` CONFIG entry: every field optional/nullable because that
 * is what the config schema materializes. Normalized into a strict
 * {@link CardCommandSpec} by {@link normalizeCardCommands} before any use.
 */
export interface CardCommandConfig {
  readonly name?: string | null;
  readonly file?: string | null;
  readonly args?: string[] | null;
  readonly cwd?: string | null;
}

/**
 * Normalize config entries into strict specs: entries without a usable name are
 * dropped (a nameless entry can never be referenced, so it is dead config, not
 * an error worth failing the boot over), and empty strings are treated as
 * absent.
 * @param entries - the raw `cardCommands` config value.
 * @returns the usable specs, in config order.
 */
export function normalizeCardCommands(
  entries: readonly CardCommandConfig[] | undefined,
): CardCommandSpec[] {
  const specs: CardCommandSpec[] = [];
  for (const entry of entries ?? []) {
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (name === '') continue;
    specs.push({
      name,
      ...(typeof entry.file === 'string' && entry.file !== '' ? { file: entry.file } : {}),
      ...(Array.isArray(entry.args) ? { args: [...entry.args] } : {}),
      ...(typeof entry.cwd === 'string' && entry.cwd !== '' ? { cwd: entry.cwd } : {}),
    });
  }
  return specs;
}

/** Everything a template may interpolate. */
export interface CardRunContext {
  readonly chatId: string;
  readonly messageId: string;
  readonly operatorOpenId: string;
  readonly formValue: Readonly<Record<string, string>>;
}

/** The failure categories (each maps to one localized message). */
export type CardRunErrorCode = 'not-allowed' | 'busy' | 'invalid' | 'spawn-failed';

/** A started run (the child keeps going on its own). */
export interface CardRunStarted {
  readonly ok: true;
  readonly pid: number;
  /** The child's stdout/stderr capture file. */
  readonly logFile: string;
  /** The resolved argv joined for the log (NOT shell-quoted — never re-run). */
  readonly command: string;
}

/** A refused or failed run. */
export interface CardRunRefused {
  readonly ok: false;
  readonly code: CardRunErrorCode;
  /** Concrete detail for the user-facing notice. */
  readonly detail: string;
}

export type CardRunOutcome = CardRunStarted | CardRunRefused;

/** Hard bounds: a card payload is data, and data gets bounds. */
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 8000;
const MAX_CONCURRENT = 4;

/** `{name}` / `{form.key}` — the WHOLE argument, never a fragment. */
const PLACEHOLDER = /^\{([A-Za-z0-9_.]+)\}$/;

/**
 * Validate the `action.value` a `kind: 'run'` button sent.
 * @param value - the raw callback value (untrusted).
 * @returns the request, or a refusal naming the malformed field.
 */
export function parseCardRunRequest(
  value: Readonly<Record<string, unknown>>,
): { ok: true; request: CardRunRequest } | { ok: false; detail: string } {
  const name = value.name;
  if (typeof name !== 'string' || name === '') {
    return { ok: false, detail: 'value.name must be a non-empty string' };
  }
  const args = value.args ?? [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    return { ok: false, detail: 'value.args must be an array of strings' };
  }
  if (args.length > MAX_ARGS) {
    return { ok: false, detail: `value.args has ${args.length} entries (max ${MAX_ARGS})` };
  }
  return { ok: true, request: { name, args: args as string[] } };
}

/**
 * Substitute whole-argument placeholders.
 * @param template - the argument template (config args first, then the card's).
 * @param context - the resolved sources (`{card}`, `{chat}`, `{operator}`,
 *   `{form.<key>}`).
 * @returns the argv, or a refusal naming the bad placeholder/argument.
 */
export function resolveRunArgs(
  template: readonly string[],
  context: CardRunContext,
): { ok: true; args: string[] } | { ok: false; detail: string } {
  const args: string[] = [];
  for (const raw of template) {
    const match = PLACEHOLDER.exec(raw);
    let value = raw;
    if (match !== null) {
      const key = match[1] ?? '';
      if (key === 'card') value = context.messageId;
      else if (key === 'chat') value = context.chatId;
      else if (key === 'operator') value = context.operatorOpenId;
      else if (key.startsWith('form.')) {
        const field = key.slice('form.'.length);
        const fromForm = context.formValue[field];
        if (fromForm === undefined) {
          return { ok: false, detail: `unknown form field "${field}" in {${key}}` };
        }
        value = fromForm;
      } else {
        return { ok: false, detail: `unknown placeholder {${key}}` };
      }
    }
    if (value.includes('\0')) return { ok: false, detail: 'argument contains a NUL byte' };
    if (value.length > MAX_ARG_CHARS) {
      return { ok: false, detail: `argument is ${value.length} chars (max ${MAX_ARG_CHARS})` };
    }
    args.push(value);
  }
  return { ok: true, args };
}

/** One in-flight run, keyed by chat. */
interface ActiveRun {
  readonly name: string;
  readonly child: ChildProcess;
  readonly logFile: string;
}

/** Logger seam (the bridge's logger satisfies it). */
export interface CardRunLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** Options for {@link CardCommandRunner}. */
export interface CardCommandRunnerOptions {
  readonly logger: CardRunLogger;
  /** Directory for per-run stdout/stderr captures. */
  readonly logDir: string;
  /** Executable used when a spec omits `file` (default `process.execPath`). */
  readonly nodePath?: string;
}

/**
 * Runs allowlisted card-button commands, one per chat at a time.
 */
export class CardCommandRunner {
  private readonly specs = new Map<string, CardCommandSpec>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly logger: CardRunLogger;
  private readonly logDir: string;
  private readonly nodePath: string;

  /**
   * @param specs - the configured allowlist (`cardCommands`).
   * @param options - logger + capture directory.
   */
  constructor(specs: readonly CardCommandSpec[], options: CardCommandRunnerOptions) {
    for (const spec of specs) {
      if (spec.name === '') continue;
      this.specs.set(spec.name, spec);
    }
    this.logger = options.logger;
    this.logDir = options.logDir;
    this.nodePath = options.nodePath ?? process.execPath;
  }

  /** The configured names (for docs/diagnostics). */
  names(): readonly string[] {
    return [...this.specs.keys()];
  }

  /** Whether a run is still alive for this chat. */
  isBusy(chatId: string): boolean {
    return this.active.has(chatId);
  }

  /**
   * Start one allowlisted command for a card button click.
   * @param request - the validated card payload.
   * @param context - the substitution sources.
   * @returns the started run (with pid + log path) or a refusal.
   */
  run(request: CardRunRequest, context: CardRunContext): CardRunOutcome {
    const spec = this.specs.get(request.name);
    if (spec === undefined) {
      return {
        ok: false,
        code: 'not-allowed',
        detail: `"${request.name}" is not a configured cardCommands entry`,
      };
    }
    if (this.active.has(context.chatId)) {
      return { ok: false, code: 'busy', detail: `"${this.active.get(context.chatId)?.name}"` };
    }
    if (this.active.size >= MAX_CONCURRENT) {
      return { ok: false, code: 'busy', detail: `${MAX_CONCURRENT} runs already active` };
    }
    const resolved = resolveRunArgs([...(spec.args ?? []), ...request.args], context);
    if (!resolved.ok) return { ok: false, code: 'invalid', detail: resolved.detail };

    const file = spec.file ?? this.nodePath;
    let fd: number | undefined;
    let logFile = '';
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      logFile = path.join(this.logDir, `${stamp()}-${sanitize(request.name)}.log`);
      fd = fs.openSync(logFile, 'a');
    } catch (error: unknown) {
      return {
        ok: false,
        code: 'spawn-failed',
        detail: `cannot open the run log: ${String(error)}`,
      };
    }

    let child: ChildProcess;
    try {
      child = spawn(file, resolved.args, {
        cwd: spec.cwd,
        detached: true,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', fd, fd],
      });
    } catch (error: unknown) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
      return { ok: false, code: 'spawn-failed', detail: String(error) };
    }
    // The child holds its own copy of the fd; the parent must not keep it open
    // (otherwise the log file stays locked for the whole run).
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    child.unref();

    const pid = child.pid ?? -1;
    const command = [file, ...resolved.args].join(' ');
    this.active.set(context.chatId, { name: request.name, child, logFile });
    child.once('exit', (code, signal) => {
      this.active.delete(context.chatId);
      this.logger.info(
        `card command "${request.name}" (pid ${pid}) exited code=${String(code)} signal=${String(signal)}`,
      );
    });
    child.once('error', (error: Error) => {
      this.active.delete(context.chatId);
      this.logger.warn(`card command "${request.name}" (pid ${pid}) failed: ${error.message}`);
    });
    this.logger.info(
      `card command "${request.name}" started (pid ${pid}, chat ${context.chatId}) -> ${logFile}`,
    );
    this.logger.info(`card command argv: ${command}`);
    return { ok: true, pid, logFile, command };
  }
}

/** `yyyyMMdd-HHmmss` in local time (log file ordering). */
function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Keep a configured name safe as a file name. */
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
}

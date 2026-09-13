/**
 * Per-session model switching for `/model`.
 *
 * dsh-web's `/model` switches the CURRENT session's model immediately (and
 * saves the default). The host implements the per-session switch by coupling a
 * mutable {@link ModelSelectionRef} to the live agent's scoped context via
 * `installModelSelection` (see `dsh-host-apiproxy`'s `selectionFor`). This
 * module replicates that: an agent gets ONE coupled selection ref (installed
 * once, cached in a `WeakMap`), and `/model` mutates its `current` so the next
 * prompt assembly uses the new provider/model.
 *
 * NOTE: this is a runtime import from `@deepseek-ai/dsh-agent` — a deliberate
 * exception to the repo's "type-only `@deepseek-ai/*` imports" convention, made
 * because genuine per-session model switching requires it (maintainer decision,
 * see docs/ux-specification.md → `/model` immediate switch).
 *
 * @module src/model-switch
 */

import type { Context } from '@deepseek-ai/cordis';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';

/**
 * A selected provider/model plus an optional reasoning effort (structural
 * subset of dsh's `ModelSelection`).
 *
 * The effort is TRI-STATE at the request-routing layer
 * (`dsh-agent`'s `installModelSelection`):
 *
 * - a string → that effort is applied to the request, overriding whatever the
 *   route/default would have resolved;
 * - `undefined` → any inherited effort is CLEARED, restoring the selected
 *   model's own provider/default behavior;
 * - (no selection at all → the route is untouched.)
 *
 * That is why clearing a level is expressed by omitting the field rather than
 * by sending a placeholder.
 */
export interface ModelSelectionRef {
  current: SessionModelSelection | undefined;
  assembled: SessionModelSelection | undefined;
}

/** What one session switch pins. `reasoningEffort` is the engine's branded
 *  level id, so it is only ever produced through {@link ReasoningEffortId}. */
interface SessionModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: ReturnType<typeof ReasoningEffortId>;
}

const refs = new WeakMap<object, ModelSelectionRef>();

/**
 * Couple a mutable model-selection to `agentCtx` ONCE and return it. Repeated
 * calls for the same context return the cached ref without re-installing so
 * the waterfall listeners are not stacked.
 * @param agentCtx - the live agent's scoped context.
 * @returns the agent's mutable selection ref.
 */
export function sessionSelectionFor(agentCtx: Context): ModelSelectionRef {
  let ref = refs.get(agentCtx);
  if (ref === undefined) {
    ref = { current: undefined, assembled: undefined };
    refs.set(agentCtx, ref);
    installModelSelection(agentCtx, ref);
  }
  return ref;
}

/**
 * Read the live agent's coupled selection ref WITHOUT installing it (the
 * `#40 display bug`). `sessionSelectionFor` couples the waterfall listeners on
 * first use (a write path); a read path — e.g. the panel's "current model" —
 * must never install listeners just to inspect a value, so it reads the cached
 * ref directly and returns `undefined` when no `/model` switch ran yet.
 * @param agentCtx - the live agent's scoped context (or `undefined` for none).
 * @returns the coupled selection ref (its `current` is the switched model), or
 *   `undefined` when no session switch was applied to this context.
 */
export function sessionSelection(agentCtx: Context | undefined): ModelSelectionRef | undefined {
  if (agentCtx === undefined) return undefined;
  return refs.get(agentCtx);
}

/**
 * Switch the model (and optionally the reasoning effort) for one live agent's
 * session (`next` becomes what the next turn assembles). No-op when `agentCtx`
 * is undefined (already handled by the caller). Does not touch the deployment
 * default — the caller saves that separately.
 *
 * Omitting `reasoningEffort` CLEARS any inherited effort (the model's own
 * provider/default level applies again); pass a string to pin one.
 * @param agentCtx - the live agent's scoped context (or undefined for no-op).
 * @param selection - the `{ provider, model, reasoningEffort? }` to apply.
 * @param logger - optional bridge logger for debug tracing (`FEISHU_DEBUG=1`).
 */
export function applySessionModelSwitch(
  agentCtx: Context | undefined,
  selection: { provider: string; model: string; reasoningEffort?: string },
  logger?: { debug: (msg: string) => void },
): void {
  if (agentCtx === undefined) return;
  // The engine expects a BRANDED level id, and an ABSENT level must stay
  // absent (that is what clears an inherited effort), so the field is built
  // conditionally rather than passed through.
  sessionSelectionFor(agentCtx).current =
    selection.reasoningEffort === undefined
      ? { provider: selection.provider, model: selection.model }
      : {
          provider: selection.provider,
          model: selection.model,
          reasoningEffort: ReasoningEffortId(selection.reasoningEffort),
        };
  logger?.debug(
    `[feishu] model switch session to ${selection.provider}/${selection.model} ` +
      `effort=${selection.reasoningEffort ?? '(model default)'}`,
  );
}

/**
 * Switch ONLY the reasoning effort of one live agent's session, keeping its
 * provider/model. `undefined` clears the pinned level (tri-state semantics —
 * see {@link ModelSelectionRef}).
 * @param agentCtx - the live agent's scoped context (or undefined for no-op).
 * @param selection - the provider/model the session currently runs, plus the
 *   effort to pin (or `undefined` to clear it).
 * @param logger - optional bridge logger for debug tracing.
 */
export function applySessionEffort(
  agentCtx: Context | undefined,
  selection: { provider: string; model: string; reasoningEffort?: string },
  logger?: { debug: (msg: string) => void },
): void {
  applySessionModelSwitch(agentCtx, selection, logger);
}

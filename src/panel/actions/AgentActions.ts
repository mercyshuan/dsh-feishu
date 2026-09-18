/**
 * Agent-card panel actions: opening the merged agent-settings card and the
 * one control that is a TOGGLE rather than a dropdown pick (plan mode).
 *
 * The five settings live on ONE card (see `buildAgentSettingsCard`), so the
 * picks that already have actions (`model-pick`, `effort-pick`,
 * `permission-pick`, `agent-preset-pick` in PickActions) keep their business
 * step and only their completion exit changes: on the agent card they
 * re-render it in place instead of popping to the menu.
 *
 * @module @dsh-feishu/dsh-feishu/panel/actions/AgentActions
 */

import type { CommandResult } from '../../commands.js';
import type { CardAction } from '../../feishu/types.js';
import { t } from '../../i18n/index.js';
import { PanelAction } from './ActionRegistry.js';
import type { PanelActionContext } from './PanelAction.js';
import { finishPick } from './PickActions.js';

/** `agent-settings` — the palette's single 🤖 Agent button: PUSH the merged
 *  agent-settings view (a transition — showPanel posts the Loading placeholder
 *  itself, since the view loads the catalog). */
export class AgentSettingsAction extends PanelAction {
  readonly kind = 'agent-settings';
  readonly allowedWhileWorking = true;
  protected override isTransition(): boolean {
    return true;
  }
  protected override async transition(ctx: PanelActionContext, action: CardAction): Promise<void> {
    await ctx.pushPanel(action.chatId, { kind: 'agent-settings' });
  }
}

/** `plan-mode-set` — the agent card's plan-mode dropdown. An OPERATION (it
 *  mutates the live agent), whose completion exit keeps the user on the agent
 *  card by re-rendering it, so the next setting can be picked immediately. */
export class PlanModeSetAction extends PanelAction {
  readonly kind = 'plan-mode-set';
  readonly allowedWhileWorking = false;
  protected override busyTitle(): string {
    return t('panel.agentSettings.title');
  }
  protected override work(
    ctx: PanelActionContext,
    action: CardAction,
  ): Promise<CommandResult> | CommandResult {
    // The dropdown stamps the marker only; the chosen value arrives in
    // `option` (the legacy `active` field is the button-style fallback).
    const raw = action.option ?? action.value.active;
    if (raw !== 'on' && raw !== 'off') {
      return {
        kind: 'error',
        text: t('panel.action.planModePickInvalid'),
      };
    }
    return ctx.applyPlanModeSet(action.chatId, raw === 'on');
  }
  protected override async finish(ctx: PanelActionContext, action: CardAction): Promise<void> {
    // Stay on the agent card while it is the current view (the point of the
    // merged card: set one setting, then the next); a standalone card (or any
    // other view) keeps the historical pop-to-menu exit.
    await finishPick(ctx, action);
  }
}

/** All agent-card actions. */
export const AGENT_ACTIONS: readonly PanelAction[] = [
  new AgentSettingsAction(),
  new PlanModeSetAction(),
];

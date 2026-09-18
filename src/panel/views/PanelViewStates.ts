/**
 * Panel view states: one renderer per panel view (Strategy objects).
 *
 * Each state declares its `asyncData` flag (whether the controller must post
 * a `⏳ Loading…` placeholder before rendering) and renders its card through
 * the {@link PanelViewContext} seam. The former `panelViewIsAsync` kind list
 * in PanelController is gone — async-ness is a property of the view itself.
 * Each picker subtype is its own state (`picker:repo` / `picker:model` /
 * `picker:permission`), so adding a picker never touches a shared router.
 *
 * @module @dsh-feishu/dsh-feishu/panel/views/PanelViewStates
 */

import {
  type AgentPresetView,
  type AgentSettingsView,
  buildAgentPresetPickerCard,
  buildAgentSettingsCard,
  buildConfirmCard,
  buildInputCard,
  buildModelPickerCard,
  buildPermissionPickerCard,
  buildRepoPickerCard,
  type PanelServiceNotice,
  type PermissionPresetView,
} from '../../cards/render.js';
import { buildSessionDetailCard, buildSessionsCard } from '../../cards/session-list.js';
import type { CardJson } from '../../feishu/types.js';
import { permissionPresetLabel, t } from '../../i18n/index.js';
import { type PanelView, panelConfirmCopy, panelInputCopy } from '../types.js';
import type { PanelViewContext } from './PanelViewContext.js';
import type { PanelViewState } from './PanelViewState.js';

/** `menu` — the palette root (sync; built by the Bridge's business side). */
export class MenuViewState implements PanelViewState {
  readonly key = 'menu';
  readonly asyncData = false;
  render(ctx: PanelViewContext, chatId: string, view: PanelView): Promise<CardJson> {
    const page = view.kind === 'menu' ? view.page : 0;
    return Promise.resolve(ctx.buildMenuCard(chatId, page));
  }
}

/** `input` — a text-input sub-view (sync; copy lives in types.ts). */
export class InputViewState implements PanelViewState {
  readonly key = 'input';
  readonly asyncData = false;
  render(_ctx: PanelViewContext, _chatId: string, view: PanelView): Promise<CardJson> {
    if (view.kind !== 'input') return Promise.resolve(this.fallback());
    const spec = panelInputCopy(view.command);
    return Promise.resolve(
      buildInputCard({
        title: spec.title,
        hint: spec.hint,
        fieldName: spec.fieldName,
        placeholder: spec.placeholder,
        submitLabel: spec.submitLabel,
        command: view.command,
        ...(view.kind === 'input' && view.sessionId !== undefined
          ? { sessionId: view.sessionId }
          : {}),
      }),
    );
  }
  /** Defensive fallback for a malformed view (unreachable in practice). */
  private fallback(): CardJson {
    return buildInputCard({
      title: t('panel.input.fallback.title'),
      hint: t('panel.input.fallback.hint'),
      fieldName: 'value',
      placeholder: 'Value',
      submitLabel: 'Submit',
      command: 'cd',
    });
  }
}

/** `confirm` — a destructive-action confirmation sub-view (sync). */
export class ConfirmViewState implements PanelViewState {
  readonly key = 'confirm';
  readonly asyncData = false;
  render(_ctx: PanelViewContext, _chatId: string, view: PanelView): Promise<CardJson> {
    if (view.kind !== 'confirm') return Promise.resolve(this.fallback());
    const spec = panelConfirmCopy(view.command);
    return Promise.resolve(
      buildConfirmCard({
        title: spec.title,
        message: spec.message,
        confirmLabel: spec.confirmLabel,
        command: view.command,
      }),
    );
  }
  /** Defensive fallback for a malformed view (unreachable in practice). */
  private fallback(): CardJson {
    return buildConfirmCard({
      title: t('panel.confirm.fallback.title'),
      message: t('panel.confirm.fallback.message'),
      confirmLabel: 'Confirm',
      command: 'clear',
    });
  }
}

/** `sessions` — the session list (async: loads the session corpus). */
export class SessionsViewState implements PanelViewState {
  readonly key = 'sessions';
  readonly asyncData = true;
  async render(ctx: PanelViewContext, chatId: string, view: PanelView): Promise<CardJson> {
    const archived = view.kind === 'sessions' ? view.archived : false;
    const query = view.kind === 'sessions' ? view.query : undefined;
    const rows = await ctx.loadSessions(chatId, archived);
    return buildSessionsCard(rows ?? [], archived, query);
  }
}

/** `session-detail` — one session's detail sub-view (async: reads the log). */
export class SessionDetailViewState implements PanelViewState {
  readonly key = 'session-detail';
  readonly asyncData = true;
  async render(ctx: PanelViewContext, chatId: string, view: PanelView): Promise<CardJson> {
    const sessionId =
      view.kind === 'session-detail' ? view.sessionId : t('panel.view.unknownSession');
    const detail = await ctx.sessionDetail(chatId, sessionId);
    if (detail === undefined) return this.unknown(sessionId, ctx);
    return buildSessionDetailCard(detail, ctx.canMutateSessions);
  }
  /** The session is unknown (stale list): render an inert placeholder. */
  private unknown(sessionId: string, ctx: PanelViewContext): CardJson {
    return buildSessionDetailCard(
      {
        sessionId,
        title: t('panel.view.unknownSession'),
        cwd: undefined,
        createdAt: 0,
        messageCount: 0,
        lastSummary: undefined,
        live: false,
        current: false,
        archived: false,
      },
      ctx.canMutateSessions,
    );
  }
}

/** `picker:repo` — the project-directory picker (async: scans the roots). */
export class RepoPickerViewState implements PanelViewState {
  readonly key = 'picker:repo';
  readonly asyncData = true;
  async render(ctx: PanelViewContext, _chatId: string, view: PanelView): Promise<CardJson> {
    // A typed `/repo <path>` passes a custom root to scan; bare uses the
    // deployment's default repoRoots. Both open the picker card.
    const roots =
      view.kind === 'picker' && view.picker === 'repo' ? (view.roots ?? ctx.repoRoots) : [];
    const page = view.kind === 'picker' && view.picker === 'repo' ? view.page : 0;
    const projects = await ctx.listProjects(roots);
    return buildRepoPickerCard(projects, roots, page);
  }
}

/** `picker:model` — the model picker (async: loads the provider catalog plus
 *  the current model's reasoning levels). */
export class ModelPickerViewState implements PanelViewState {
  readonly key = 'picker:model';
  readonly asyncData = true;
  async render(ctx: PanelViewContext, chatId: string, _view: PanelView): Promise<CardJson> {
    const options = await ctx.loadModelOptions();
    const current = ctx.currentModelSelection(chatId);
    const withCurrent = (options ?? []).map((option) => ({
      ...option,
      current: option.value === current,
    }));
    // The thinking depth belongs to the CURRENT model: the card offers only
    // the levels that model advertises (`resolveModelInfo().reasoning`).
    const reasoning = await ctx.modelReasoning(chatId);
    return buildModelPickerCard(withCurrent, current, 0, {
      efforts: reasoning?.efforts ?? [],
      current: ctx.currentEffort(chatId),
      modelDefault: reasoning?.defaultEffort,
    });
  }
}

/** `picker:permission` — the permission-preset picker (async: resolves the
 *  live agent + preset service). */
export class PermissionPickerViewState implements PanelViewState {
  readonly key = 'picker:permission';
  readonly asyncData = true;
  async render(ctx: PanelViewContext, chatId: string, _view: PanelView): Promise<CardJson> {
    const service = ctx.permissionPresets();
    if (service === undefined) {
      return {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: t('command.cmd.permission.label') },
          template: 'wathet',
        },
        elements: [
          {
            tag: 'markdown',
            content: t('panel.permission.serviceUnavailable'),
          },
        ],
      };
    }
    const agent = await ctx.ensureAgent(chatId);
    const currentPreset = service.current(agent.session);
    const presets: PermissionPresetView[] = service.names.map((name) => {
      const option = service.optionOf(name);
      return {
        name,
        label: permissionPresetLabel(option.name ?? name),
        description: option.description,
        current: name === currentPreset,
      };
    });
    return buildPermissionPickerCard(presets);
  }
}

/** `picker:agent-preset` — the agent-preset picker (async: resolves the live
 *  agent, the roster, and the chat's effective preset). */
export class AgentPresetPickerViewState implements PanelViewState {
  readonly key = 'picker:agent-preset';
  readonly asyncData = true;
  async render(ctx: PanelViewContext, chatId: string, _view: PanelView): Promise<CardJson> {
    const service = ctx.agentPresets();
    if (service === undefined) {
      return {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: t('command.cmd.preset.label') },
          template: 'wathet',
        },
        elements: [
          {
            tag: 'markdown',
            content: t('panel.agentPreset.serviceUnavailable'),
          },
        ],
      };
    }
    // Ensure the chat has an agent: the picker's current value is the preset
    // that agent was COMPOSED from (the roster's default id is only the
    // fallback for an agent that was composed from nothing).
    const agent = await ctx.ensureAgent(chatId);
    const rows = await service.list();
    const composed =
      service.composedPreset === undefined ? undefined : service.composedPreset(agent.ctx);
    const current =
      composed ?? ctx.selectedAgentPreset(chatId) ?? rows.find((row) => row.isDefault)?.id;
    const presets: AgentPresetView[] = rows.map((row) => ({
      id: row.id,
      label: row.name ?? row.id,
      description: row.description,
      current: row.id === current,
      // exactOptionalPropertyTypes: a broken row carries the reason, a healthy
      // one must not carry the key at all.
      ...(row.broken !== undefined ? { broken: row.broken } : {}),
    }));
    return buildAgentPresetPickerCard(presets);
  }
}

/** The loud placeholder for a missing service (one shape, four sections). */
function serviceNotice(title: string, markdown: string): PanelServiceNotice {
  return { title, markdown };
}

/** `agent-settings` — the MERGED agent card (async: loads the model catalog,
 *  the current model's levels, the permission table, the preset roster, and the
 *  chat's plan state).
 *
 *  The palette's single 🤖 Agent button pushes this view, and every picker
 *  that belongs to the agent (model / thinking depth / permission / agent
 *  preset / plan mode) acts on it in place: the pick actions re-render THIS
 *  view (see PickActions) instead of popping to the menu, so all five can be
 *  set in one visit. Each section degrades to its own loud notice when the
 *  deployment does not mount the matching service (misconfiguration fails
 *  loud — never a dead control). */
export class AgentSettingsViewState implements PanelViewState {
  readonly key = 'agent-settings';
  readonly asyncData = true;
  async render(ctx: PanelViewContext, chatId: string, _view: PanelView): Promise<CardJson> {
    const modelOptions = await ctx.loadModelOptions();
    const current = ctx.currentModelSelection(chatId);
    const options = (modelOptions ?? []).map((option) => ({
      ...option,
      current: option.value === current,
    }));
    const reasoning = await ctx.modelReasoning(chatId);
    return buildAgentSettingsCard({
      model: {
        options,
        current,
        notice:
          modelOptions === undefined
            ? serviceNotice(t('panel.model.title'), t('command.error.modelSwitchUnavailable'))
            : undefined,
      },
      reasoning: {
        efforts: reasoning?.efforts ?? [],
        current: ctx.currentEffort(chatId),
        modelDefault: reasoning?.defaultEffort,
      },
      permission: await this.permissionSection(ctx, chatId),
      preset: await this.presetSection(ctx, chatId),
      plan: this.planSection(ctx, chatId),
    });
  }

  /** The permission section: the live preset table and the session's current
   *  one, or the service notice when permission presets are not mounted. */
  private async permissionSection(
    ctx: PanelViewContext,
    chatId: string,
  ): Promise<AgentSettingsView['permission']> {
    const service = ctx.permissionPresets();
    if (service === undefined) {
      return {
        presets: [],
        notice: serviceNotice(
          t('command.cmd.permission.label'),
          t('panel.permission.serviceUnavailable'),
        ),
      };
    }
    const agent = await ctx.ensureAgent(chatId);
    const currentPreset = service.current(agent.session);
    const presets: PermissionPresetView[] = service.names.map((name) => {
      const option = service.optionOf(name);
      return {
        name,
        label: permissionPresetLabel(option.name ?? name),
        description: option.description,
        current: name === currentPreset,
      };
    });
    return { presets, notice: undefined };
  }

  /** The agent-preset section: the roster and the preset the chat's agent was
   *  COMPOSED from (the roster default is only a fallback), or the service
   *  notice when the roster is not mounted. */
  private async presetSection(
    ctx: PanelViewContext,
    chatId: string,
  ): Promise<AgentSettingsView['preset']> {
    const service = ctx.agentPresets();
    if (service === undefined) {
      return {
        presets: [],
        notice: serviceNotice(
          t('command.cmd.preset.label'),
          t('panel.agentPreset.serviceUnavailable'),
        ),
      };
    }
    // Ensure the chat has an agent: the section's current value is the preset
    // that agent was COMPOSED from (the roster's default id is only the
    // fallback for an agent that was composed from nothing).
    const agent = await ctx.ensureAgent(chatId);
    const rows = await service.list();
    const composed =
      service.composedPreset === undefined ? undefined : service.composedPreset(agent.ctx);
    const current =
      composed ?? ctx.selectedAgentPreset(chatId) ?? rows.find((row) => row.isDefault)?.id;
    const presets: AgentPresetView[] = rows.map((row) => ({
      id: row.id,
      label: row.name ?? row.id,
      description: row.description,
      current: row.id === current,
      ...(row.broken !== undefined ? { broken: row.broken } : {}),
    }));
    return { presets, notice: undefined };
  }

  /** The plan-mode section: the chat's live plan state, or the service notice
   *  when no plan-mode controller is mounted. */
  private planSection(ctx: PanelViewContext, chatId: string): AgentSettingsView['plan'] {
    const state = ctx.planModeState(chatId);
    if (state === undefined) {
      return {
        active: false,
        notice: serviceNotice(
          t('command.cmd.plan.label'),
          t('panel.agentSettings.planUnavailable'),
        ),
      };
    }
    return { active: state.active, notice: undefined };
  }
}

/**
 * Unit tests for the pure card-rendering helpers.
 */

import { describe, expect, it } from 'vitest';
import { markdownToElements } from '../../src/cards/markdown.js';
import {
  type AgentSettingsView,
  assistantText,
  buildAgentSettingsCard,
  buildApprovalCard,
  buildApprovalDecidedCard,
  buildCard,
  buildInboundFileCard,
  buildModelPickerCard,
  buildPanelCard,
  buildPermissionPickerCard,
  buildQuestionAnsweredCard,
  buildQuestionCard,
  buildQueueItemCard,
  buildRepoPickedCard,
  buildRepoPickerCard,
  buildRowDetailsCard,
  collapseThought,
  MAX_COLLAPSED_THINK_CHARS,
  PANEL_PAGE_SIZE,
  type PanelCommand,
  type PanelPageEntry,
  panelPages,
  REPO_SELECT_MAX_OPTIONS,
  repoOptionLabel,
  repoRelativePath,
  rowLine,
  truncateTail,
} from '../../src/cards/render.js';
import { toolRowSummary, toolRowTitle } from '../../src/cards/tool-summary.js';
import type { ButtonAction, CardElement, SelectAction } from '../../src/feishu/types.js';

/** Button-only labels of an action element (skips select dropdowns). */
function buttonLabels(el: CardElement | undefined): string[] {
  if (el === undefined || el.tag !== 'action') return [];
  return el.actions.filter((a): a is ButtonAction => a.tag === 'button').map((a) => a.text.content);
}

/** The select dropdown of an action element, if any. */
function selectOf(el: CardElement | undefined): SelectAction | undefined {
  if (el === undefined || el.tag !== 'action') return undefined;
  return el.actions.find((a): a is SelectAction => a.tag === 'select_static');
}

/** The one-line lark_md content of a row's text column. */
function rowText(row: CardElement | undefined): string {
  if (row === undefined || row.tag !== 'column_set') return '';
  const text = row.columns[0]?.elements[0];
  return text?.tag === 'div' ? text.text.content : '';
}

/** The ⋯ expand button of a row's button column. */
function rowButton(
  row: CardElement | undefined,
): { content: string; value: Record<string, string> } | undefined {
  if (row === undefined || row.tag !== 'column_set') return undefined;
  const button = row.columns[1]?.elements[0];
  if (button?.tag !== 'button') return undefined;
  return { content: button.text.content, value: button.value };
}

describe('truncateTail', () => {
  it('returns short text unchanged', () => {
    expect(truncateTail('short', 10)).toBe('short');
  });

  it('keeps the newest tail with a truncation marker', () => {
    const text = 'a'.repeat(100);
    const out = truncateTail(text, 40);
    expect(out).toContain('truncated');
    expect(out.endsWith('aaaa')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(45);
  });
});

describe('assistantText', () => {
  it('joins text blocks', () => {
    const blocks = [
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ] as const;
    expect(assistantText(blocks)).toBe('hello world');
  });
});

describe('rowLine', () => {
  it('always shows the cloud emoji and Thinking for a think row', () => {
    expect(rowLine({ kind: 'think', id: 't1', text: 'hmm', settled: false })).toBe(
      '☁️ Think · Thinking',
    );
    // Even after the block settles, the line stays minimal.
    expect(rowLine({ kind: 'think', id: 't1', text: 'first line\nsecond', settled: true })).toBe(
      '☁️ Think · Thinking',
    );
  });

  it('renders a tool row as Title · summary with status icon', () => {
    const row = {
      kind: 'tool' as const,
      id: 'c1',
      name: 'bash',
      status: 'done' as const,
      summary: 'ls -la',
      args: '{"command":"ls -la"}',
      result: '',
    };
    expect(rowLine(row)).toBe('✅ Bash · ls -la');
  });

  it('renders a steering row as Steer · preview', () => {
    expect(rowLine({ kind: 'steering', id: 'm1', text: 'rebuild the frontend' })).toBe(
      '💬 Steer · rebuild the frontend',
    );
  });

  it('uses the stored summary even when the args were truncated', () => {
    // A long command truncates mid-JSON; the summary was computed from the
    // full arguments at capture time and must not degrade to the raw JSON.
    const row = {
      kind: 'tool' as const,
      id: 'c1',
      name: 'bash',
      status: 'running' as const,
      summary: 'export DOCKER_HOST=unix:///run/user/1001/docker.sock',
      args: '{"command":"export DOCKER_HOST=unix:///run/u',
      result: '',
    };
    expect(rowLine(row)).toBe('🔧 Bash · export DOCKER_HOST=unix:///run/user/1001/docker.sock');
  });
});

describe('collapseThought', () => {
  const think = (id: string, text: string, settled = false) => ({
    kind: 'think' as const,
    id,
    text,
    settled,
  });
  const tool = (id: string, name: string, summary = '', status: 'done' | 'running' = 'done') => ({
    kind: 'tool' as const,
    id,
    name,
    status,
    summary,
    args: '',
    result: '',
  });

  it('shows the newest reasoning text, not the tool-name trail (feedback)', () => {
    const rows = [
      think('t1', 'first thought', true),
      tool('c1', 'read_image', 'shot.png'),
      think('t2', 'second thought'),
      tool('c2', 'pwsh', 'Get-ChildItem'),
    ];
    expect(collapseThought(rows)).toBe('☁️ second thought');
  });

  it('keeps the tail of a long block, on one line', () => {
    const text = `${'x'.repeat(400)}TAIL`;
    const line = collapseThought([think('t1', text)]);
    expect(line.startsWith('☁️ …')).toBe(true);
    expect(line.endsWith('TAIL')).toBe(true);
    // `☁️ ` + `…` + the clipped tail — nothing longer.
    expect(line.length).toBe(3 + 1 + MAX_COLLAPSED_THINK_CHARS);
    expect(line).not.toContain('\n');
  });

  it('flattens newlines and runs of whitespace onto one line', () => {
    expect(collapseThought([think('t1', 'line one\n\n  line two\t')])).toBe('☁️ line one line two');
  });

  it('skips reasoning rows that carry no text yet', () => {
    const rows = [think('t1', ''), tool('c1', 'bash', 'ls', 'running')];
    expect(collapseThought(rows)).toBe('🔧 Bash · ls');
  });

  it('falls back to the latest row line when the turn has no reasoning at all', () => {
    const rows = [tool('c1', 'bash', 'ls'), tool('c2', 'read', 'a.ts')];
    expect(collapseThought(rows)).toBe('✅ Read · a.ts');
  });

  it('returns an empty line for no rows', () => {
    expect(collapseThought([])).toBe('');
  });
});

describe('buildCard', () => {
  it('emits a v1 card (no schema field) with header template by status', () => {
    const card = buildCard({ title: 'T', content: 'body', rows: [], status: 'working' });
    // The v1 root-elements layout is used deliberately so the card can carry
    // interactive action buttons (schema 2.0 rejects the action tag).
    expect(card.schema).toBeUndefined();
    expect(card.header?.title.content).toBe('T');
    expect(card.header?.template).toBe('wathet');
  });

  it('uses green for done and red for error', () => {
    expect(buildCard({ title: 'T', content: '', rows: [], status: 'done' }).header?.template).toBe(
      'green',
    );
    expect(buildCard({ title: 'T', content: '', rows: [], status: 'error' }).header?.template).toBe(
      'red',
    );
  });

  it('renders the friendly error reason on the error card (never a dead end)', () => {
    const card = buildCard({
      title: 'T',
      content: '',
      rows: [],
      status: 'error',
      errorText: 'MISSING_CREDENTIAL: llm-deepseek: no API key',
    });
    const cardJson = JSON.stringify(card.elements);
    expect(cardJson).toContain('no API key');
    // The error card must never fall back to a meaningless placeholder.
    expect(cardJson).not.toContain('see the card for details');
  });

  it('offers an Export log button on the error card only', () => {
    const errorCard = buildCard({
      title: 'T',
      content: '',
      rows: [],
      status: 'error',
      errorText: 'boom',
    });
    const buttons = errorCard.elements
      .flatMap((el) => (el.tag === 'action' ? el.actions : []))
      .flatMap((a) => (a.tag === 'button' ? [a] : []));
    const exportLog = buttons.find(
      (b) => JSON.stringify(b.value) === JSON.stringify({ kind: 'send-log' }),
    );
    expect(exportLog).toBeDefined();
    expect(JSON.stringify(exportLog)).toContain('Export log');

    const doneCard = buildCard({ title: 'T', content: '', rows: [], status: 'done' });
    const doneButtons = doneCard.elements
      .flatMap((el) => (el.tag === 'action' ? el.actions : []))
      .flatMap((a) => (a.tag === 'button' ? [a] : []));
    expect(
      doneButtons.some((b) => JSON.stringify(b.value) === JSON.stringify({ kind: 'send-log' })),
    ).toBe(false);
  });

  it('renders think/tool rows in chronological order with expand buttons', () => {
    const card = buildCard({
      title: 'T',
      content: '',
      rows: [
        { kind: 'think', id: 't1', text: 'hmm', settled: true },
        {
          kind: 'tool',
          id: 'c1',
          name: 'bash',
          status: 'done',
          summary: 'ls',
          args: '{"command":"ls"}',
          result: '',
        },
        {
          kind: 'tool',
          id: 'c2',
          name: 'read',
          status: 'error',
          summary: 'a.txt',
          args: '{"path":"a.txt"}',
          result: '',
        },
      ],
      status: 'done',
    });
    const rows = card.elements.filter((el) => el.tag === 'column_set');
    expect(rows).toHaveLength(3);
    expect(rowText(rows[0])).toBe('☁️ Think · Thinking');
    expect(rowText(rows[1])).toContain('✅ Bash');
    expect(rowText(rows[2])).toContain('❌ Read');
    expect(rowButton(rows[0])?.content).toBe('⋯');
    expect(rowButton(rows[1])?.value).toEqual({ kind: 'row-details', id: 'c1' });
  });

  it('collapsed FINISHED card hides thinking and tool rows behind the expand toggle', () => {
    const card = buildCard({
      title: 'T',
      content: 'done',
      rows: [
        { kind: 'think', id: 't1', text: 'weighing the options', settled: true },
        {
          kind: 'tool',
          id: 'c1',
          name: 'bash',
          status: 'done',
          summary: '',
          args: '{}',
          result: '',
        },
        {
          kind: 'tool',
          id: 'c2',
          name: 'read',
          status: 'done',
          summary: '',
          args: '{}',
          result: '',
        },
      ],
      collapsed: true,
      status: 'done',
    });
    // No thinking line and no row at all while folded — the answer plus the
    // stats/button area are the card (user request).
    const thought = card.elements.find(
      (el): el is Extract<CardElement, { tag: 'markdown' }> =>
        el.tag === 'markdown' && el.content.startsWith('☁️ '),
    );
    expect(thought).toBeUndefined();
    expect(card.elements.filter((el) => el.tag === 'column_set')).toHaveLength(0);
    const actions = card.elements.filter((el) => el.tag === 'action');
    // ONE row: the panel action, then the expand toggle (user request).
    expect(buttonLabels(actions[0])).toEqual(['⚙️ Panel', '▸ Expand']);
  });

  it('collapsed WORKING card still streams the current thinking line', () => {
    const card = buildCard({
      title: 'T',
      content: '',
      rows: [{ kind: 'think', id: 't1', text: 'weighing the options', settled: false }],
      collapsed: true,
      status: 'working',
    });
    const thought = card.elements.find(
      (el): el is Extract<CardElement, { tag: 'markdown' }> =>
        el.tag === 'markdown' && el.content.startsWith('☁️ '),
    );
    expect(thought?.content).toBe('☁️ weighing the options');
    expect(card.elements.filter((el) => el.tag === 'column_set')).toHaveLength(0);
    const actions = card.elements.filter((el) => el.tag === 'action');
    expect(buttonLabels(actions[0])).toEqual(['⏹ Stop turn', '▸ Expand']);
  });

  it('expanded card keeps one row: the panel action then the collapse toggle', () => {
    const card = buildCard({
      title: 'T',
      content: 'done',
      rows: [
        {
          kind: 'tool',
          id: 'c1',
          name: 'bash',
          status: 'done',
          summary: '',
          args: '{}',
          result: '',
        },
      ],
      status: 'done',
    });
    const actions = card.elements.filter((el) => el.tag === 'action');
    expect(actions).toHaveLength(1);
    expect(buttonLabels(actions[0])).toEqual(['⚙️ Panel', '▾ Collapse']);
    expect(card.elements.filter((el) => el.tag === 'column_set')).toHaveLength(1);
  });

  it('renders the complete output at the bottom as markdown', () => {
    const card = buildCard({
      title: 'T',
      content: '# Hello\n\nsome **bold** text',
      rows: [{ kind: 'think', id: 't1', text: 'hmm', settled: true }],
      status: 'done',
    });
    const markdowns = card.elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    const joined = markdowns.map((el) => el.content).join('\n');
    expect(joined).toContain('**Hello**');
    expect(joined).toContain('**bold**');
    expect(joined).not.toContain('# Hello');
  });

  it('shows panel plus the rows toggle when done (no copy/retry buttons)', () => {
    const card = buildCard({
      title: 'T',
      content: 'done',
      rows: [
        {
          kind: 'tool',
          id: 'c1',
          name: 'bash',
          status: 'done',
          summary: '',
          args: '{}',
          result: 'ok',
        },
      ],
      status: 'done',
    });
    const actions = card.elements.filter((el) => el.tag === 'action');
    expect(buttonLabels(actions[0])).toEqual(['⚙️ Panel', '▾ Collapse']);
    expect(buttonLabels(actions[0])).not.toContain('📋 Copy');
    expect(buttonLabels(actions[0])).not.toContain('🔁 Retry');
  });
});

describe('markdownToElements', () => {
  it('converts headings to bold and keeps code fences', () => {
    const elements = markdownToElements('# Title\n\n```js\nconst x = 1;\n```');
    const markdowns = elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    const joined = markdowns.map((el) => el.content).join('\n');
    expect(joined).toContain('**Title**');
    expect(joined).toContain('```js');
  });

  it('emits an hr element for thematic breaks', () => {
    const elements = markdownToElements('a\n\n---\n\nb');
    expect(elements.some((el) => el.tag === 'hr')).toBe(true);
  });

  it('renders GFM tables as native Feishu table elements, not raw pipes', () => {
    // Regression: tables previously fell back to their source lines, so the
    // final card showed raw '| 路径 | 内容 |' text (user report).
    const table = `| 路径 | 内容 |
|---|---|
| \`Agent4AVR/\` | 主代码包 |
| \`Agent4AVR/main.py\` | 入口：加载数据集 |
| \`results/\` | Lite/Full 的 \`preds.json\` |`;
    const elements = markdownToElements(table);
    const tableElement = elements.find(
      (el): el is Extract<CardElement, { tag: 'table' }> => el.tag === 'table',
    );
    expect(tableElement).toBeDefined();
    expect(tableElement?.columns.map((c) => c.display_name)).toEqual(['路径', '内容']);
    expect(tableElement?.rows).toHaveLength(3);
    expect(tableElement?.rows[0]?.c0).toContain('Agent4AVR/');
    expect(tableElement?.rows[2]?.c1).toContain('preds.json');
    // No raw pipe text leaks into markdown elements.
    const markdowns = elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    expect(markdowns.every((el) => !el.content.includes('|'))).toBe(true);
  });

  it('caps native tables at the Feishu limit and keeps overflow as code blocks', () => {
    // Regression: >5 tables in one card made message.patch fail with
    // ErrCode 11310 ('card table number over limit'), surfacing as
    // '目标回调服务未在线'. The sixth table must degrade to a code block
    // (content preserved), not fail the patch.
    const sixTables = Array.from({ length: 6 }, (_, i) => `| h${i} |\n|---|\n| v${i} |`).join(
      '\n\n',
    );
    const elements = markdownToElements(sixTables);
    const tables = elements.filter(
      (el): el is Extract<CardElement, { tag: 'table' }> => el.tag === 'table',
    );
    expect(tables).toHaveLength(5);
    const markdowns = elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    const joined = markdowns.map((el) => el.content).join('\n');
    expect(joined).toContain('```');
    expect(joined).toContain('h5'); // the sixth table's header survives
  });

  it('returns an empty array for empty input', () => {
    expect(markdownToElements('')).toEqual([]);
  });
});

describe('card buttons', () => {
  it('shows only the stop button while working', () => {
    const card = buildCard({ title: 'T', content: 'x', rows: [], status: 'working' });
    const action = card.elements.find((el) => el.tag === 'action');
    expect(buttonLabels(action)).toEqual(['⏹ Stop turn']);
  });
});

describe('buildRowDetailsCard', () => {
  it('shows the full reasoning in a code block for a think row', () => {
    const card = buildRowDetailsCard({
      kind: 'think',
      id: 't1',
      text: 'full reasoning',
      settled: true,
    });
    const markdowns = card.elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    expect(markdowns[0]?.content).toBe('```\nfull reasoning\n```');
  });

  it('shows formatted JSON input and code-blocked output for a tool row', () => {
    const card = buildRowDetailsCard({
      kind: 'tool',
      id: 'c1',
      name: 'bash',
      status: 'done',
      summary: 'ls',
      args: '{"command":"ls","n":1}',
      result: 'file.txt',
    });
    const markdowns = card.elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    expect(markdowns[0]?.content).toContain('Bash');
    // IN: pretty-printed JSON inside a json fence.
    expect(markdowns[1]?.content).toContain('IN');
    expect(markdowns[1]?.content).toContain('```json');
    expect(markdowns[1]?.content).toContain('  "command": "ls",');
    // OUT: fenced result.
    expect(markdowns[2]?.content).toContain('OUT');
    expect(markdowns[2]?.content).toContain('```');
  });

  it('handles unparseable args as raw text', () => {
    const card = buildRowDetailsCard({
      kind: 'tool',
      id: 'c1',
      name: 'bash',
      status: 'done',
      summary: '{not json',
      args: '{not json',
      result: '',
    });
    const markdowns = card.elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    expect(markdowns[1]?.content).toContain('{not json');
  });

  it('shows the full steered message text for a steering row', () => {
    const card = buildRowDetailsCard({ kind: 'steering', id: 'm1', text: 'rebuild the frontend' });
    expect(card.header?.title.content).toBe('💬 Steer');
    const markdowns = card.elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    expect(markdowns[0]?.content).toBe('```\nrebuild the frontend\n```');
  });
});

describe('buildPanelCard', () => {
  it('emits a control card with the favorites palette on page 1', () => {
    const card = buildPanelCard('**Idle** — send a message.', false);
    expect(card.header?.title.content).toBe('⚙️ dsh-feishu panel');
    // No commands → no palette, and the core action row lives from page 2 on:
    // page 1 stays the status line only.
    const action = card.elements.find((el) => el.tag === 'action');
    expect(action).toBeUndefined();
  });

  it('shows the core action row on page 2 only (Stop while running)', () => {
    // A favorites group takes page 1, so the rest lands on page 2.
    const palette: PanelCommand[] = [
      { name: 'agent', buttonLabel: 'A', category: 'common' },
      { name: 'x', buttonLabel: 'X', category: 'system' },
    ];
    const labelsOf = (card: ReturnType<typeof buildPanelCard>): readonly string[] => {
      const action = card.elements.find((el) => el.tag === 'action');
      return action && 'actions' in action
        ? action.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
        : [];
    };
    // Page 1 = favorites only → the core row is NOT there.
    expect(labelsOf(buildPanelCard('**Running**', true, palette, 0))).toEqual(['A']);
    expect(labelsOf(buildPanelCard('**Idle**', false, palette, 0))).toEqual(['A']);
    // Page 2 carries it: Stop while running, Retry/Copy always.
    expect(labelsOf(buildPanelCard('**Running**', true, palette, 1))).toEqual([
      '⏹ Stop current turn',
      '🔁 Retry last',
      '📋 Copy last',
    ]);
    expect(labelsOf(buildPanelCard('**Idle**', false, palette, 1))).toEqual([
      '🔁 Retry last',
      '📋 Copy last',
    ]);
  });
});

describe('repo relative paths', () => {
  it('labels options with the repoRoot-relative path, not the basename', () => {
    const roots = ['/work'];
    const card = buildRepoPickerCard(
      [
        { name: 'source', path: '/work/a/source', type: 'repo', branch: 'main' },
        { name: 'source', path: '/work/b/source', type: 'repo', branch: 'dev' },
      ],
      roots,
    );
    const action = card.elements.find((el) => el.tag === 'action');
    const select = selectOf(action);
    const labels = select?.options.map((o) => o.text.content) ?? [];
    expect(labels).toEqual(['1. a/source (main)', '2. b/source (dev)']);
  });

  it('repoRelativePath picks the longest matching root and falls back to full path', () => {
    expect(
      repoRelativePath({ name: 'x', path: '/work/sub/x', type: 'repo', branch: 'main' }, ['/work']),
    ).toBe('sub/x');
    expect(
      repoRelativePath({ name: 'x', path: '/elsewhere/x', type: 'repo', branch: 'main' }, [
        '/work',
      ]),
    ).toBe('/elsewhere/x');
  });

  it('falls back to paginated buttons beyond the dropdown option cap', () => {
    const projects = Array.from(
      { length: REPO_SELECT_MAX_OPTIONS + 2 },
      (_, i) =>
        ({
          name: `p${i}`,
          path: `/work/p${i}`,
          type: 'repo',
          branch: 'main',
        }) as const,
    );
    const card = buildRepoPickerCard(projects, ['/work'], 0);
    const actions = card.elements.filter((el) => el.tag === 'action');
    // No Back button on a direct builder card — the panel controller appends
    // it only when the card's stack can return (a standalone typed-command
    // card renders none).
    expect(actions.every((el) => !buttonLabels(el).includes('⬅ Back'))).toBe(true);
    const nav = actions.at(-1);
    expect(buttonLabels(nav)).toEqual(['Next ›']);
    const first = actions[0];
    expect(selectOf(first)).toBeUndefined();
    expect(buttonLabels(first).length).toBeGreaterThan(0);
  });
});

describe('buildRepoPickedCard', () => {
  it('emits a static confirmation card with no action buttons', () => {
    const card = buildRepoPickedCard('/work/a');
    expect(card.elements.some((el) => el.tag === 'action')).toBe(false);
    const markdowns = card.elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    expect(markdowns[0]?.content).toContain('/work/a');
  });
});

describe('repoOptionLabel', () => {
  it('appends branch and worktree marker', () => {
    expect(
      repoOptionLabel({ name: 'a', path: '/work/a', type: 'worktree', branch: 'feature' }, [
        '/work',
      ]),
    ).toBe('a (feature) [worktree]');
  });
});

describe('toolRowSummary / toolRowTitle', () => {
  it('bash summary prefers the description then the command', () => {
    expect(toolRowSummary('bash', '{"command":"ls"}')).toBe('ls');
    expect(toolRowSummary('bash', '{"description":"check deps","command":"ls"}')).toBe(
      'check deps',
    );
  });

  it('read summary is the file path', () => {
    expect(toolRowSummary('read', '{"path":"/work/src/a.ts"}', '/work')).toBe('src/a.ts');
  });

  it('unknown tools fall back to the first string arg with a Tool call title', () => {
    expect(toolRowSummary('my_tool', '{"msg":"hello"}')).toBe('my_tool · hello');
    expect(toolRowTitle('my_tool')).toBe('Tool call');
    expect(toolRowTitle('bash')).toBe('Bash');
  });

  it('classifies background-job tools as Read rows with the job id summary', () => {
    expect(toolRowTitle('job_output')).toBe('Read Job');
    expect(toolRowTitle('job_list')).toBe('List Jobs');
    expect(toolRowTitle('job_kill')).toBe('Kill Job');
    expect(toolRowSummary('job_output', '{"job_id":"bash-1"}')).toBe('bash-1');
  });
});

const paletteCommands: PanelCommand[] = [
  { name: 'cancel', buttonLabel: '⏹ Stop', category: 'session' },
  { name: 'cd', buttonLabel: '📁 Change dir', category: 'session' },
  { name: 'repo', buttonLabel: '📚 Pick project', category: 'session' },
  { name: 'sessions', buttonLabel: '🗂️ Sessions', category: 'session' },
  { name: 'resume', buttonLabel: '🔁 Resume session', category: 'session' },
  { name: 'clear', buttonLabel: '🧹 Fresh start', category: 'session' },
  { name: 'new', buttonLabel: '➕ New chat', category: 'session' },
  { name: 'group', buttonLabel: '👥 New group', category: 'chat' },
  { name: 'help', buttonLabel: '❓ Help', category: 'system' },
  { name: 'status', buttonLabel: '📊 Status', category: 'system' },
  { name: 'plan', buttonLabel: '🗺️ Plan mode', category: 'system' },
  { name: 'goal', buttonLabel: '🎯 Goal', category: 'system' },
  { name: 'compact', buttonLabel: '🧹 Compact', category: 'system' },
  { name: 'feedback', buttonLabel: '💬 Feedback', category: 'system' },
  { name: 'permission', buttonLabel: '🔐 Permission', category: 'system' },
];

describe('panelPages', () => {
  it('groups by category with one header per group', () => {
    const pages = panelPages(paletteCommands);
    const headers = pages.flat().filter((e) => e.type === 'header');
    expect(headers.map((h) => ('label' in h ? h.label : ''))).toEqual([
      'session',
      'chat',
      'system',
    ]);
  });

  it('packs whole category blocks and never splits one across pages', () => {
    const pages = panelPages(paletteCommands);
    const buttonCounts = pages.map((page) => page.filter((e) => e.type === 'button').length);
    // session(7) + chat(1) fit page 1; the whole system block moves to page 2
    // as one piece (categories are never torn across pages). Page 1 holds 8
    // here because the fixture has no agent group — with the shipped command
    // set it is the full PANEL_PAGE_SIZE (agent + session + chat).
    expect(buttonCounts).toEqual([8, 7]);
    // No page ever exceeds the capacity (page 1 is simply not full with this
    // fixture: it has no agent group, and a category block is never split).
    expect(Math.max(...buttonCounts)).toBeLessThanOrEqual(PANEL_PAGE_SIZE);
  });

  it('a category larger than the page size keeps its own page (no split)', () => {
    const pages = panelPages(
      [
        { name: 'a', buttonLabel: 'A', category: 'session' },
        { name: 'b', buttonLabel: 'B', category: 'system' },
        { name: 'c', buttonLabel: 'C', category: 'system' },
        { name: 'd', buttonLabel: 'D', category: 'system' },
      ],
      2,
    );
    // session(1) fits; system(3) would overflow page 1 → whole block moves
    // to page 2 with its header (never 'system' split across pages).
    expect(pages.map((p) => p.map((e) => (e.type === 'header' ? e.label : e.name)))).toEqual([
      ['session', 'a'],
      ['system', 'b', 'c', 'd'],
    ]);
  });

  it('packs the ONE agent button with the session/card/chat groups on page 1 (the shipped palette)', () => {
    // The shipped set: the AGENT group is a SINGLE button (the merged agent
    // card — model / thinking depth / permission / agent preset / plan mode all
    // live on that one card), so agent(1) + session(6, `/stop` joined) +
    // card(1) + chat(1) fit page 1 and page 2 keeps the system group.
    const shipped: PanelCommand[] = [
      { name: 'agent', buttonLabel: '🤖 Agent', category: 'agent' },
      ...(
        [
          ['cancel', '⏹ Stop'],
          ['stop', '🛑 Stop everything'],
          ['cd', '📁 Change dir'],
          ['repo', '📚 Pick project'],
          ['sessions', '🗂️ Sessions'],
          ['new', '➕ New chat'],
        ] as Array<[string, string]>
      ).map(([name, buttonLabel]) => ({ name, buttonLabel, category: 'session' })),
      { name: 'imagecard', buttonLabel: '🎨 Image card', category: 'card' },
      { name: 'group', buttonLabel: '👥 New group', category: 'chat' },
      ...Array.from({ length: 9 }, (_, i) => ({
        name: `sys${i}`,
        buttonLabel: `S${i}`,
        category: 'system',
      })),
    ];
    const pages = panelPages(shipped);
    const names = (page: readonly PanelPageEntry[]): string[] =>
      page.filter((e) => e.type === 'button').map((e) => (e.type === 'button' ? e.name : ''));
    const headers = (page: readonly PanelPageEntry[]): string[] =>
      page.filter((e) => e.type === 'header').map((e) => (e.type === 'header' ? e.label : ''));
    expect(headers(pages[0] ?? [])).toEqual(['agent', 'session', 'card', 'chat']);
    expect(names(pages[0] ?? [])).toEqual([
      'agent',
      'cancel',
      'stop',
      'cd',
      'repo',
      'sessions',
      'new',
      'imagecard',
      'group',
    ]);
    // Page 2 keeps the system group exactly as before.
    expect(headers(pages[1] ?? [])).toEqual(['system']);
    expect(names(pages[1] ?? [])).toHaveLength(9);
  });
  it('puts the favorites group alone on page 1 and packs the rest after it', () => {
    const pages = panelPages([
      { name: 'agent', buttonLabel: 'A', category: 'common' },
      { name: 'stop', buttonLabel: 'B', category: 'common' },
      { name: 'repo', buttonLabel: 'C', category: 'common' },
      { name: 'imagecard', buttonLabel: 'D', category: 'common' },
      { name: 'sessions', buttonLabel: 'E', category: 'session' },
      { name: 'help', buttonLabel: 'F', category: 'system' },
    ]);
    const headers = (page: readonly PanelPageEntry[]): string[] =>
      page.filter((e) => e.type === 'header').map((e) => (e.type === 'header' ? e.label : ''));
    const names = (page: readonly PanelPageEntry[]): string[] =>
      page.filter((e) => e.type === 'button').map((e) => (e.type === 'button' ? e.name : ''));
    expect(headers(pages[0] ?? [])).toEqual(['common']);
    expect(names(pages[0] ?? [])).toEqual(['agent', 'stop', 'repo', 'imagecard']);
    expect(headers(pages[1] ?? [])).toEqual(['session', 'system']);
    expect(names(pages[1] ?? [])).toEqual(['sessions', 'help']);
  });
});

/** A fully-populated merged agent view (every section has a real control). */
function agentSettingsView(): AgentSettingsView {
  return {
    model: {
      options: [
        {
          value: 'deepseek-official/deepseek-v4-flash',
          label: 'DeepSeek · V4 Flash',
          current: true,
        },
        { value: 'deepseek-official/deepseek-r1', label: 'DeepSeek · R1', current: false },
      ],
      current: 'deepseek-official/deepseek-v4-flash',
      notice: undefined,
    },
    reasoning: {
      efforts: [
        { id: 'off', name: 'Off' },
        { id: 'high', name: 'High' },
      ],
      current: 'high',
      modelDefault: 'off',
    },
    permission: {
      presets: [
        { name: 'workspace-write', label: 'Workspace write', description: 'write', current: true },
        { name: 'read-only', label: 'Read only', description: 'read', current: false },
      ],
      notice: undefined,
    },
    preset: {
      presets: [
        { id: 'default', label: 'Default', description: undefined, current: true },
        { id: 'reviewer', label: 'Reviewer', description: 'Reviews only.', current: false },
      ],
      notice: undefined,
    },
    plan: { active: false, notice: undefined },
  };
}

describe('buildAgentSettingsCard', () => {
  /** Every `select_static` marker kind on a card, in card order. */
  const selectKinds = (elements: readonly CardElement[]): (string | undefined)[] =>
    elements.flatMap((el) =>
      el.tag === 'action'
        ? el.actions.filter((a) => a.tag === 'select_static').map((a) => a.value?.kind)
        : [],
    );

  it('stacks all five settings on ONE card, each with its own control', () => {
    const card = buildAgentSettingsCard(agentSettingsView());
    expect(card.header?.title.content).toBe('🤖 Agent');
    const markdowns = card.elements.flatMap((el) => (el.tag === 'markdown' ? [el.content] : []));
    const labels = [
      '**Model**',
      '**Thinking depth**',
      '**Permission**',
      '**Agent preset**',
      '**Plan mode**',
    ];
    const positions = labels.map((label) => markdowns.indexOf(label));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // Each section owns its control, in card order.
    expect(selectKinds(card.elements)).toEqual([
      'model-pick',
      'effort-pick',
      'permission-pick',
      'agent-preset-pick',
      'plan-mode-set',
    ]);
    // No Back row: the CALLER appends it when the card has a parent.
    expect(JSON.stringify(card.elements)).not.toContain('⬅ Back');
  });

  it('preselects each dropdown with the session’s current value', () => {
    const card = buildAgentSettingsCard(agentSettingsView());
    const selects = card.elements.flatMap((el) =>
      el.tag === 'action'
        ? el.actions.filter((a): a is SelectAction => a.tag === 'select_static')
        : [],
    );
    expect(selects.map((select) => select.initial_option)).toEqual([
      'deepseek-official/deepseek-v4-flash',
      'high',
      'workspace-write',
      'default',
      'off',
    ]);
    // The plan select offers exactly on/off.
    expect(selects.at(-1)?.options.map((option) => option.value)).toEqual(['on', 'off']);
  });

  it('the plan section preselects ON while plan mode is active', () => {
    const view = agentSettingsView();
    const card = buildAgentSettingsCard({ ...view, plan: { active: true, notice: undefined } });
    const planSelect = card.elements
      .flatMap((el) => (el.tag === 'action' ? el.actions : []))
      .find(
        (action): action is SelectAction =>
          action.tag === 'select_static' && action.value?.kind === 'plan-mode-set',
      );
    expect(planSelect?.initial_option).toBe('on');
    expect(JSON.stringify(card.elements)).toContain('Plan mode: On');
  });

  it('degrades a section to its loud notice when its service is missing', () => {
    const view = agentSettingsView();
    const notice = { title: 'x', markdown: 'unavailable here.' };
    const card = buildAgentSettingsCard({
      ...view,
      model: { options: [], current: undefined, notice },
      permission: { presets: [], notice },
      preset: { presets: [], notice },
      plan: { active: false, notice },
    });
    // Only the thinking-depth dropdown survives.
    expect(selectKinds(card.elements)).toEqual(['effort-pick']);
    // Each degraded section still shows its line.
    expect(JSON.stringify(card.elements)).toContain('unavailable here.');
  });

  it('explains an empty thinking-depth list instead of rendering a dead dropdown', () => {
    const view = agentSettingsView();
    const card = buildAgentSettingsCard({
      ...view,
      reasoning: { efforts: [], current: undefined, modelDefault: undefined },
    });
    expect(selectKinds(card.elements)).not.toContain('effort-pick');
    expect(JSON.stringify(card.elements)).toContain(
      'The current model offers no thinking-depth levels.',
    );
  });
});

describe('buildPanelCard palette', () => {
  it('renders each category as its own block on the page', () => {
    const card = buildPanelCard('**Idle**', false, paletteCommands, 0);
    const actions = card.elements.filter(
      (el): el is Extract<CardElement, { tag: 'action' }> => el.tag === 'action',
    );
    // Page 1 of this fixture (no favorites group): the session + chat blocks,
    // then the page-nav row (the core Retry/Copy row lives from page 2 on).
    const sessionRow = buttonLabels(actions[0]);
    expect(sessionRow).toHaveLength(7);
    expect(sessionRow[0]).toBe('⏹ Stop');
    expect(sessionRow).not.toContain('👥 New group');
    const chatRow = buttonLabels(actions[1]);
    expect(chatRow).toEqual(['👥 New group']);
    expect(buttonLabels(actions[2])).toEqual(['Next ▶️']);
    // Category headers render as emoji-tagged markdown lines, each BEFORE
    // its own button row (interleaved, not stacked).
    const markdowns = card.elements.filter(
      (el): el is Extract<CardElement, { tag: 'markdown' }> => el.tag === 'markdown',
    );
    const sessionHeader = markdowns.findIndex((m) => m.content === '**🧩 Session**');
    const chatHeader = markdowns.findIndex((m) => m.content === '**💬 Chat**');
    expect(sessionHeader).toBeGreaterThanOrEqual(0);
    expect(chatHeader).toBeGreaterThan(sessionHeader);
    const sessionRowIndex = card.elements.indexOf(actions[0] as CardElement);
    const chatRowIndex = card.elements.indexOf(actions[1] as CardElement);
    expect(sessionHeader).toBeLessThan(sessionRowIndex);
    expect(chatHeader).toBeLessThan(chatRowIndex);
    // The page indicator is a quiet note, not a bold line.
    const notes = card.elements.filter(
      (el): el is Extract<CardElement, { tag: 'note' }> => el.tag === 'note',
    );
    expect(notes.some((n) => n.elements[0]?.content.includes('page 1/2'))).toBe(true);
  });

  it('puts the favorites group alone on page 1 with no core action row', () => {
    const favorites: PanelCommand[] = [
      { name: 'agent', buttonLabel: '🤖 Agent', category: 'common' },
      { name: 'stop', buttonLabel: '🛑 Stop everything', category: 'common' },
      { name: 'repo', buttonLabel: '📚 Pick project', category: 'common' },
      { name: 'imagecard', buttonLabel: '🎨 Image card', category: 'common' },
      { name: 'sessions', buttonLabel: '🗂️ Sessions', category: 'session' },
      { name: 'help', buttonLabel: '❓ Help', category: 'system' },
    ];
    const page1 = buildPanelCard('**Idle**', false, favorites, 0);
    const page1Actions = page1.elements.filter((el) => el.tag === 'action');
    expect(buttonLabels(page1Actions[0])).toEqual([
      '🤖 Agent',
      '🛑 Stop everything',
      '📚 Pick project',
      '🎨 Image card',
    ]);
    // ONLY the favorites: no Retry/Copy core row anywhere on page 1.
    expect(JSON.stringify(page1.elements)).not.toContain('Retry last');
    expect(page1.elements.some((el) => el.tag === 'hr')).toBe(false);
    // Page 2: the remaining groups' buttons, then the core row.
    const page2 = buildPanelCard('**Idle**', false, favorites, 1);
    const page2Actions = page2.elements.filter((el) => el.tag === 'action');
    expect(buttonLabels(page2Actions[0])).toEqual(['🔁 Retry last', '📋 Copy last']);
    expect(buttonLabels(page2Actions[1])).toEqual(['🗂️ Sessions']);
    expect(buttonLabels(page2Actions[2])).toEqual(['❓ Help']);
    expect(JSON.stringify(page2.elements)).not.toContain('🎨 Image card');
  });

  it('stamps command payloads on palette buttons', () => {
    const card = buildPanelCard('**Idle**', false, paletteCommands, 0);
    const pageAction = card.elements
      .filter((el): el is Extract<CardElement, { tag: 'action' }> => el.tag === 'action')
      .find((el) =>
        el.actions.some((a) => a.tag === 'button' && 'value' in a && a.value.kind === 'command'),
      );
    expect(pageAction).toBeDefined();
    const command = pageAction?.actions.find(
      (a): a is ButtonAction => a.tag === 'button' && a.value.kind === 'command',
    );
    expect(command?.value).toEqual({ kind: 'command', name: 'cancel' });
  });

  it('hides Stop unless running', () => {
    // A favorites group takes page 1, so the core row sits on page 2.
    const palette: PanelCommand[] = [
      { name: 'agent', buttonLabel: '🤖 Agent', category: 'common' },
      ...paletteCommands,
    ];
    const coreOf = (card: ReturnType<typeof buildPanelCard>): readonly string[] => {
      const action = card.elements.find((el) => el.tag === 'action');
      return action && 'actions' in action
        ? action.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
        : [];
    };
    const idle = buildPanelCard('**Idle**', false, palette, 1);
    expect(coreOf(idle)).toEqual(['🔁 Retry last', '📋 Copy last']);
    const running = buildPanelCard('**Running**', true, palette, 1);
    expect(coreOf(running)).toEqual(['⏹ Stop current turn', '🔁 Retry last', '📋 Copy last']);
  });

  it('renders no palette section when there are no commands', () => {
    const card = buildPanelCard('**Idle**', false, [], 0);
    expect(
      card.elements.some(
        (el) => el.tag === 'markdown' && 'content' in el && el.content.includes('Commands'),
      ),
    ).toBe(false);
  });
});

describe('buildPermissionPickerCard', () => {
  const presets = [
    {
      name: 'read-only',
      label: 'Read only',
      description: 'Sandbox read-only, approval ask.',
      current: false,
    },
    {
      name: 'workspace-write',
      label: 'workspace-write',
      description: 'Sandbox workspace-write, approval ask.',
      current: true,
    },
    {
      name: 'danger-full-access',
      label: 'danger-full-access',
      description: 'Sandbox danger-full-access, approval never.',
      current: false,
    },
  ];

  it('renders a select_static dropdown with all presets as options', () => {
    const card = buildPermissionPickerCard(presets);
    const action = card.elements.find((el) => el.tag === 'action');
    const select = selectOf(action);
    expect(select).toBeDefined();
    expect(select?.options.map((o) => o.value)).toEqual([
      'read-only',
      'workspace-write',
      'danger-full-access',
    ]);
    // The select is the repo-picker pattern: a marker payload, with the
    // chosen preset arriving in the callback's `option` field.
    expect(select?.value).toEqual({ kind: 'permission-pick' });
    expect(card.elements.filter((el) => el.tag === 'column_set')).toHaveLength(0);
  });

  it('preselects the current preset via initial_option', () => {
    const card = buildPermissionPickerCard(presets);
    const select = selectOf(card.elements.find((el) => el.tag === 'action'));
    expect(select?.initial_option).toBe('workspace-write');
    // The current preset is also spelled out in a quiet note.
    const note = card.elements.find((el) => el.tag === 'note');
    expect(note && 'elements' in note ? note.elements[0]?.content : '').toContain(
      '★ current: workspace-write',
    );
  });

  it('omits initial_option when the effective state is not an option (custom)', () => {
    const custom = presets.map((p) => ({ ...p, current: false }));
    const card = buildPermissionPickerCard(custom);
    const select = selectOf(card.elements.find((el) => el.tag === 'action'));
    expect(select?.initial_option).toBeUndefined();
    const note = card.elements.find((el) => el.tag === 'note');
    expect(note && 'elements' in note ? note.elements[0]?.content : '').toContain(
      'No preset selected yet',
    );
  });

  it('shows the empty state with no presets', () => {
    const card = buildPermissionPickerCard([]);
    expect(card.header?.title.content).toBe('🔐 Permission presets');
    expect(
      card.elements.some(
        (el) =>
          el.tag === 'markdown' && 'content' in el && el.content.includes('No presets configured'),
      ),
    ).toBe(true);
  });
});

describe('buildModelPickerCard', () => {
  const options = [
    {
      value: 'deepseek-official/deepseek-v4-flash',
      label: 'deepseek-official · DeepSeek V4 Flash',
      current: true,
    },
    {
      value: 'deepseek-official/deepseek-r1',
      label: 'deepseek-official · DeepSeek R1',
      current: false,
    },
  ];

  it('renders a select_static dropdown with provider/model options', () => {
    const card = buildModelPickerCard(options, 'deepseek-official/deepseek-v4-flash');
    const action = card.elements.find((el) => el.tag === 'action');
    const select = selectOf(action);
    expect(select).toBeDefined();
    expect(select?.options.map((o) => o.value)).toEqual([
      'deepseek-official/deepseek-v4-flash',
      'deepseek-official/deepseek-r1',
    ]);
    expect(select?.value).toEqual({ kind: 'model-pick' });
    // The current selection is preselected.
    expect(select?.initial_option).toBe('deepseek-official/deepseek-v4-flash');
  });

  it('spells out the current model in a note; omits initial_option when absent', () => {
    const noCurrent = buildModelPickerCard(
      options.map((o) => ({ ...o, current: false })),
      undefined,
    );
    const select = selectOf(noCurrent.elements.find((el) => el.tag === 'action'));
    expect(select?.initial_option).toBeUndefined();
    const note = noCurrent.elements.find((el) => el.tag === 'note');
    expect(note && 'elements' in note ? note.elements[0]?.content : '').toContain(
      'No model selected yet',
    );
    const withCurrent = buildModelPickerCard(options, 'deepseek-official/deepseek-v4-flash');
    const note2 = withCurrent.elements.find((el) => el.tag === 'note');
    expect(note2 && 'elements' in note2 ? note2.elements[0]?.content : '').toContain(
      '★ current: deepseek-official · DeepSeek V4 Flash',
    );
  });

  it('shows the empty state when the catalog is empty', () => {
    const card = buildModelPickerCard([], undefined);
    expect(card.header?.title.content).toBe('🤖 Model');
    expect(
      card.elements.some(
        (el) =>
          el.tag === 'markdown' && 'content' in el && el.content.includes('No models available'),
      ),
    ).toBe(true);
  });

  it('adds the thinking-depth dropdown when the current model advertises levels', () => {
    const card = buildModelPickerCard(options, 'deepseek-official/deepseek-v4-flash', 0, {
      efforts: [
        { id: 'off', name: 'Off' },
        { id: 'low', name: 'Low' },
        { id: 'high', name: 'High' },
        { id: 'max', name: 'Max' },
      ],
      current: 'low',
      modelDefault: 'high',
    });
    const actions = card.elements.filter((el) => el.tag === 'action');
    const effortSelect = selectOf(actions[1]);
    expect(effortSelect?.value).toEqual({ kind: 'effort-pick' });
    // Only the levels the model itself advertises (DSH never clamps).
    expect(effortSelect?.options.map((o) => o.value)).toEqual(['off', 'low', 'high', 'max']);
    // The pinned level is preselected and the note spells out what runs.
    expect(effortSelect?.initial_option).toBe('low');
    expect(JSON.stringify(card.elements)).toContain('Thinking depth: Low');
  });

  it('preselects the model default when nothing is pinned; no dropdown without levels', () => {
    const card = buildModelPickerCard(options, 'deepseek-official/deepseek-v4-flash', 0, {
      efforts: [
        { id: 'off', name: 'Off' },
        { id: 'high', name: 'High' },
      ],
      current: undefined,
      modelDefault: 'high',
    });
    const effortSelect = selectOf(card.elements.filter((el) => el.tag === 'action')[1]);
    expect(effortSelect?.initial_option).toBe('high');
    expect(JSON.stringify(card.elements)).toContain('Thinking depth: High');
    // No reasoning metadata → one dropdown only, and no depth copy at all.
    const plain = buildModelPickerCard(options, 'deepseek-official/deepseek-v4-flash');
    expect(plain.elements.filter((el) => el.tag === 'action')).toHaveLength(1);
    expect(JSON.stringify(plain.elements)).not.toContain('Thinking depth');
  });

  it('falls back to paginated Select buttons beyond the dropdown cap', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      value: `provider-${i}/model-${i}`,
      label: `provider-${i} · Model ${i}`,
      current: false,
    }));
    const card = buildModelPickerCard(many, undefined, 0);
    const actions = card.elements.filter((el) => el.tag === 'action');
    const pageButtons = actions.flatMap((el) =>
      'actions' in el ? el.actions.filter((a) => a.tag === 'button') : [],
    );
    const pickValues = pageButtons.filter((a) => a.value.kind === 'model-pick').map((a) => a.value);
    expect(pickValues).toHaveLength(8);
    expect(pickValues[0]).toEqual({ kind: 'model-pick', selection: 'provider-0/model-0' });
    // Nav buttons present with page bounds.
    const nav = pageButtons.filter((a) => a.value.kind === 'model-page').map((a) => a.text.content);
    expect(nav).toEqual(['Next ›']);
  });
});

describe('interaction cards (approvals/questions)', () => {
  it('approval card shows the tool and reason with Allow/Reject buttons', () => {
    const card = buildApprovalCard('bash', 'delete the files', 'approval-1');
    expect(card.header?.title.content).toBe('🔐 Approval needed');
    expect(JSON.stringify(card.elements)).toContain('delete the files');
    const action = card.elements.find((el) => el.tag === 'action');
    const values =
      action && 'actions' in action
        ? action.actions.filter((a) => a.tag === 'button').map((a) => a.value)
        : [];
    expect(values).toEqual([
      { kind: 'approval', decision: 'allow', id: 'approval-1' },
      { kind: 'approval', decision: 'reject', id: 'approval-1' },
    ]);
  });

  it('approval decided card is static (no buttons)', () => {
    for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable']) {
      const card = buildApprovalDecidedCard(outcome);
      expect(card.elements.some((el) => el.tag === 'action')).toBe(false);
    }
    expect(JSON.stringify(buildApprovalDecidedCard('allowed-once').elements)).toContain(
      'Allowed once',
    );
  });

  it('single-select question card answers on an option button', () => {
    const card = buildQuestionCard({
      id: 'q1',
      question: 'Which stack?',
      detail: undefined,
      options: [{ label: 'Go' }, { label: 'Rust' }],
      multiSelect: false,
    });
    const action = card.elements.find((el) => el.tag === 'action');
    const buttons =
      action && 'actions' in action
        ? action.actions.filter((a) => a.tag === 'button').map((a) => a.value)
        : [];
    expect(buttons).toEqual([
      { kind: 'question', id: 'q1', answer: 'Go' },
      { kind: 'question', id: 'q1', answer: 'Rust' },
    ]);
  });

  it('multi-select question card toggles and submits', () => {
    const card = buildQuestionCard(
      {
        id: 'q1',
        question: 'Pick any',
        detail: undefined,
        options: [{ label: 'A' }, { label: 'B' }],
        multiSelect: true,
      },
      ['A'],
    );
    const actions = card.elements.filter((el) => el.tag === 'action');
    const values = actions.flatMap((el) =>
      'actions' in el ? el.actions.filter((a) => a.tag === 'button').map((a) => a.value) : [],
    );
    // Selected options render checked and toggle; a Submit button follows.
    expect(JSON.stringify(card.elements)).toContain('✅ A');
    expect(values).toContainEqual({ kind: 'question-toggle', id: 'q1', option: 'A' });
    expect(values).toContainEqual({ kind: 'question-toggle', id: 'q1', option: 'B' });
    expect(values).toContainEqual({ kind: 'question-submit', id: 'q1' });
  });

  it('free-text question card asks for a message reply with a cancel button', () => {
    const card = buildQuestionCard({
      id: 'q1',
      question: 'Describe it',
      detail: undefined,
      options: [],
      multiSelect: false,
    });
    expect(JSON.stringify(card.elements)).toContain('Reply with your answer as a message');
    const action = card.elements.find((el) => el.tag === 'action');
    expect(action && 'actions' in action ? action.actions[0]?.value : undefined).toEqual({
      kind: 'question-cancel',
      id: 'q1',
    });
  });

  it('question answered card is static', () => {
    const card = buildQuestionAnsweredCard('Which stack?', 'Rust');
    expect(card.elements.some((el) => el.tag === 'action')).toBe(false);
    expect(JSON.stringify(card.elements)).toContain('Answer: Rust');
  });

  it('inbound-file receipt card shows the saved path and the pending count', () => {
    const card = buildInboundFileCard('report.pdf', '/work/attachments/report.pdf', 3);
    expect(card.header?.title.content).toBe('📎 File received');
    const content = JSON.stringify(card.elements);
    expect(content).toContain('report.pdf');
    expect(content).toContain('/work/attachments/report.pdf');
    expect(content).toContain('**3 files awaiting your instruction.**');
    // No action buttons — the interaction model is "send an instruction".
    expect(card.elements.some((el) => el.tag === 'action')).toBe(false);
  });

  it('inbound-file receipt card defaults to count 1 and a name-only note without a path', () => {
    const card = buildInboundFileCard('notes.txt');
    const content = JSON.stringify(card.elements);
    expect(content).toContain('notes.txt');
    expect(content).not.toContain('awaiting your instruction');
    expect(content).toContain('Tell me what to do with it.');
  });

  it('a queued item card shows the preview plus Steer/Edit/Remove while a turn runs', () => {
    const card = buildQueueItemCard({ id: 'm1', text: 'run the build', status: 'queued' }, true);
    expect(card.header?.title.content).toBe('⏳ run the build');
    const labels = card.elements.flatMap((el) =>
      el.tag === 'action'
        ? el.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
        : el.tag === 'form'
          ? el.elements.filter((e) => e.tag === 'button').map((e) => e.text.content)
          : [],
    );
    expect(labels).toContain('➡️ Steer');
    expect(labels).toContain('✏️ Edit');
    expect(labels).toContain('🗑️ Remove');
    expect(JSON.stringify(card.elements)).toContain('run the build');
    // No edit form rendered in the `queued` state.
    expect(card.elements.some((el) => el.tag === 'form')).toBe(false);
  });

  it('a queued item card omits Steer and shows a hint when idle', () => {
    const card = buildQueueItemCard({ id: 'm1', text: 'first', status: 'queued' }, false);
    // No Steer button anywhere; an idle hint explains why.
    const labels = card.elements.flatMap((el) =>
      el.tag === 'action'
        ? el.actions.filter((a) => a.tag === 'button').map((a) => a.text.content)
        : el.tag === 'form'
          ? el.elements.filter((e) => e.tag === 'button').map((e) => e.text.content)
          : [],
    );
    expect(labels).not.toContain('➡️ Steer');
    expect(labels).toContain('✏️ Edit');
    expect(labels).toContain('🗑️ Remove');
    const allContent = JSON.stringify(card.elements);
    expect(allContent).toContain('➡️ Steer unavailable — no turn is running.');
    expect(allContent).toContain('first');
  });

  it('an editing item card renders a single edit form with Submit + a Cancel row and no default_value', () => {
    const card = buildQueueItemCard({ id: 'm1', text: 'first', status: 'editing' }, true);
    const form = card.elements.find((el) => el.tag === 'form');
    expect(form !== undefined && form.tag === 'form').toBe(true);
    if (form !== undefined && form.tag === 'form') {
      expect(form.name).toBe('queue-edit');
      // Exactly one input; the input must NOT carry a default_value (the
      // verified buildInputCard shape — a default_value produced the 400).
      const inputs = form.elements.filter((e) => e.tag === 'input');
      expect(inputs).toHaveLength(1);
      expect('default_value' in inputs[0]!).toBe(false);
      // The form holds ONLY the submit button (botmux v1 rule); the Cancel
      // button lives in its own action row OUTSIDE the form.
      const buttons = form.elements.filter((e) => e.tag === 'button');
      expect(buttons.map((b) => b.text.content)).toEqual(['✏️ Submit']);
      expect(buttons[0]?.action_type).toBe('form_submit');
      expect(buttons[0]?.value.kind).toBe('queue-edit-submit');
    }
    const cancelAction = card.elements.find(
      (el): el is Extract<CardElement, { tag: 'action' }> => el.tag === 'action',
    );
    const cancel = cancelAction?.actions.find((a) => a.tag === 'button');
    expect(cancel?.tag === 'button' ? cancel.text.content : undefined).toBe('↩️ Cancel');
    expect(cancel?.tag === 'button' ? cancel.value.kind : undefined).toBe('queue-edit-cancel');
  });

  it.each([
    ['steering', '💬 Steering…', '⏳ Steering…'],
    ['steered', '✅ Steered', '⏳ Steered'],
    ['sent', '📤 Sent', '⏳ Sent'],
    ['removed', '🗑️ Removed', '⏳ Removed'],
  ] as const)('a %s item card shows its marker with no buttons', (status, marker, title) => {
    const card = buildQueueItemCard({ id: 'm1', text: 'run the build', status }, true);
    expect(card.header?.title.content).toBe(title);
    const content = JSON.stringify(card.elements);
    expect(content).toContain(marker);
    expect(content).toContain('run the build');
    // No action buttons and no form in marker-only states.
    expect(card.elements.some((el) => el.tag === 'action')).toBe(false);
    expect(card.elements.some((el) => el.tag === 'form')).toBe(false);
  });
});

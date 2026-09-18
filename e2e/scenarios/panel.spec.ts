/**
 * E2E scenario: `/panel` opens the control-panel card and its buttons work.
 *
 * The `/panel` handler (src/commands/surface.ts → `openPanel`) renders the
 * FAVORITES page (agent / stop-everything / pick-project / image card) with the
 * full palette on the following pages. This scenario asserts the panel card
 * appears (with the favorites buttons) and then CLICKS one of them
 * (`Stop everything`) to verify the panel button resolves to the surface's stop
 * command — a real card-button round-trip, no LLM in the loop.
 *
 * @module e2e/scenarios/panel
 */

import { test } from '@playwright/test';
import { waitForBotReplyContaining, waitForCardContaining } from '../helpers/assert.js';
import { loadE2eConfig } from '../helpers/config.js';
import { clickCardButton, sendMessage, snapshot } from '../helpers/feishu.js';
import { caseIdFromTitle } from '../helpers/report.js';
import { disbandGroup, openCaseGroup, scenarioDebug } from '../helpers/scenario.js';

const cfg = loadE2eConfig();
const debugEnabled = process.env.E2E_DEBUG === '1';
const debug = scenarioDebug(debugEnabled);

test('send /panel → control panel card with working buttons', async ({ page }, testInfo) => {
  const caseId = caseIdFromTitle(testInfo.title);
  const { groupName, chatId } = await openCaseGroup(page, cfg, caseId, cfg.timeoutMs, debug);
  try {
    await sendMessage(page, '/panel');
    await snapshot(page, cfg, `${caseId}-sent`, caseId);

    // The panel card appears (its header carries the surface name). The card
    // opens a paged command palette — wait for it before clicking a button.
    await waitForCardContaining(page, 'dsh-feishu panel', cfg.timeoutMs);
    debug('assert', 'panel card received');
    await snapshot(page, cfg, `${caseId}-panel`, caseId);

    // Click a favorites button on the FIRST page — `Stop everything` (emoji in
    // the label is cosmetic; match the accessible name without it), whose
    // handler with no active session returns the deterministic local text
    // `no active session to stop.` (no LLM). This proves the panel button
    // resolves to a surface command. (`📊 Status` sits on a later page, so we
    // use a first-page button instead of paging.)
    await clickCardButton(page, 'Stop everything');
    await waitForBotReplyContaining(page, 'no active session to stop.', cfg.timeoutMs);
    debug('assert', 'panel button -> stop-everything reply received');
    await snapshot(page, cfg, `${caseId}-button-reply`, caseId);

    testInfo.annotations.push({
      type: 'evidence',
      description: `group: ${groupName} | panel rendered + its "Stop everything" button resolved to the stop command`,
    });
  } finally {
    await disbandGroup(cfg, groupName, chatId, debug);
  }
});

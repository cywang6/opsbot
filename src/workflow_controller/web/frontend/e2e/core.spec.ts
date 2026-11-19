// Copyright (c) 2026 Workflow Controller Contributors
//
// Licensed under the MIT License (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://opensource.org/licenses/MIT
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { expect, test } from './fixtures'

test('Settings route opens the settings dialog with its sections', async ({ page }) => {
  await page.goto('/settings?section=全局设置', { waitUntil: 'domcontentloaded' })

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('全局设置', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Watchdog', { exact: true })).toBeVisible()
  await expect(dialog.getByText('插件', { exact: true })).toBeVisible()
})

test('Run not-found state offers a return path', async ({ page }) => {
  await page.goto('/run/e2e-missing-run', { waitUntil: 'domcontentloaded' })

  await expect(page.getByText('run 不在账面（可能已删除）')).toBeVisible()
  await expect(page.getByRole('button', { name: '返回' })).toBeVisible()
})

test('Session detail sends pause through the ordinary session endpoint', async ({ page }) => {
  const session = {
    id: 'e2e-session',
    name: 'E2E session',
    role: 'worker',
    state: 'running',
    loop_status: 'yes',
    stop_reason: null,
    loop_hold: null,
    current_iteration: 1,
    max_iterations: 3,
    progress: 0,
    elapsed_seconds: 2,
    created_at_iso: '2026-10-22T00:00:00Z',
    error: null,
    last_activity: [],
    birth_handoff_doc: null,
    result: null,
    predecessor: null,
    successors: [],
    sdk_session_id: 'sdk-e2e-session',
    project_dir: '/tmp/e2e-project',
    run_id: null,
    reviewer_mode: 'auto',
  }
  let pauseRequest = false

  await page.route('**/api/v1/sessions/e2e-session', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: session })
      return
    }
    await route.continue()
  })
  await page.route('**/api/v1/config', async (route) => {
    await route.fulfill({ json: { reviewer: { enabled: false, mode: 'auto' } } })
  })
  await page.route('**/api/v1/plugins', async (route) => {
    await route.fulfill({ json: { plugins: [] } })
  })
  await page.route('**/api/v1/events?*', async (route) => {
    await route.fulfill({ json: { events: [] } })
  })
  await page.route('**/api/breather/state?*', async (route) => {
    await route.fulfill({ json: {} })
  })
  await page.route('**/api/v1/plugins/breather/config', async (route) => {
    await route.fulfill({ json: { enabled: false } })
  })
  await page.route('**/api/v1/sessions/e2e-session/subagent-hint', async (route) => {
    await route.fulfill({ json: { hints: {} } })
  })
  await page.route('**/api/v1/sessions/e2e-session/agents', async (route) => {
    await route.fulfill({ json: { agents: [] } })
  })
  await page.route('**/api/v1/sessions/e2e-session/instructions', async (route) => {
    await route.fulfill({ json: { instructions: [] } })
  })
  await page.route('**/api/v1/sessions/e2e-session/pause', async (route) => {
    pauseRequest = true
    await route.fulfill({ status: 200, json: { ok: true } })
  })

  await page.goto('/session/e2e-session', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('E2E session')).toBeVisible()

  await page.getByTitle('暂停').click()
  await expect.poll(() => pauseRequest).toBe(true)
})

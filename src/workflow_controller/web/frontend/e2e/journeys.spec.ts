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

import { expect, test, type Page } from './fixtures'

function sessionPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e2e-journey-session', name: 'Journey session', role: 'worker', state: 'idle',
    loop_status: 'no', stop_reason: 'user_pause', loop_hold: null, current_iteration: 1,
    max_iterations: 3, progress: 0, elapsed_seconds: 2, created_at_iso: '2026-10-22T00:00:00Z',
    error: null, last_activity: [], birth_handoff_doc: null, result: null,
    predecessor: null, successors: [], sdk_session_id: 'sdk-journey', project_dir: '/tmp/project-a',
    run_id: null, reviewer_mode: 'auto', ...overrides,
  }
}

async function mockSessionDependencies(page: Page) {
  await page.route('**/api/v1/config', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { reviewer: { enabled: false, mode: 'auto' } } })
      return
    }
    await route.continue()
  })
  await page.route('**/api/v1/plugins', async (route) => {
    await route.fulfill({ json: { plugins: [] } })
  })
  await page.route('**/api/v1/events?*', async (route) => {
    await route.fulfill({ json: { events: [] } })
  })
  // SSE 不 mock 会把真实后端会话推进侧栏（环境耦合），补空 session_update
  await page.route('**/api/v1/events/stream', async (route) => {
    await route.fulfill({
      contentType: 'text/event-stream',
      body: sseBody([['session_update', []]]),
    })
  })
  await page.route('**/api/breather/state?*', async (route) => {
    await route.fulfill({ json: {} })
  })
  await page.route('**/api/v1/plugins/breather/config', async (route) => {
    await route.fulfill({ json: { enabled: false } })
  })
  await page.route('**/api/v1/sessions/e2e-journey-session/**', async (route) => {
    await route.fulfill({ json: { hints: {}, agents: [], instructions: [] } })
  })
}

function sseBody(events: Array<[string, unknown]>) {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

test('project picker switches the active project and persists the selection', async ({ page }) => {
  let selectedProject = ''
  // SSE 回放 PUT 结果（真实约定：PUT /config → config_update 回推）；
  // 固定回放 project-a 会在重连时把乐观选中翻回旧项目
  let sseProjectDir = '/tmp/project-a'
  await page.route('**/api/v1/events/stream', async (route) => {
    await route.fulfill({
      contentType: 'text/event-stream',
      body: sseBody([
        ['config_update', { project_dir: sseProjectDir, recent_dirs: ['/tmp/project-a', '/tmp/project-b'] }],
        ['session_update', []],
      ]),
    })
  })
  await page.route('**/api/v1/config', async (route) => {
    if (route.request().method() === 'PUT') {
      selectedProject = JSON.parse(route.request().postData() || '{}').project_dir || ''
      sseProjectDir = selectedProject
      await route.fulfill({ json: { ok: true } })
      return
    }
    await route.fulfill({ json: {} })
  })
  await page.route('**/api/v1/auth/status', async (route) => {
    await route.fulfill({ json: { has_api_key: false } })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.project-row.active[title="/tmp/project-a"]')).toBeVisible()
  // 项目导航是自定义 .project-row（title=完整路径），不再是 role=menu
  await page.locator('.project-row[title="/tmp/project-b"]').click()
  await expect.poll(() => selectedProject).toBe('/tmp/project-b')
  await expect(page).toHaveURL(/\/$/)
  await expect(page.locator('.project-row.active[title="/tmp/project-b"]')).toBeVisible()
})

test('Dashboard starts an ordinary Session with the selected project and prompt', async ({ page }) => {
  let startBody: Record<string, unknown> = {}
  await page.route('**/api/v1/events/stream', async (route) => {
    await route.fulfill({
      contentType: 'text/event-stream',
      body: sseBody([
        ['config_update', { project_dir: '/tmp/project-a', recent_dirs: ['/tmp/project-a'] }],
        ['session_update', []],
        ['auth_update', { providers: [{ index: 0, model: 'e2e-model', runtime: 'claude_sdk', status: 'active', is_active: true }] }],
      ]),
    })
  })
  await page.route('**/api/v1/auth/status', async (route) => {
    await route.fulfill({ json: { has_api_key: true } })
  })
  await page.route('**/api/v1/project-config*', async (route) => {
    await route.fulfill({ json: { runtime: 'claude_sdk', starting_prompt: '' } })
  })
  await page.route('**/api/v1/config', (route) => {
    if (route.request().method() === 'PUT') {
      return route.fulfill({ json: { ok: true } })
    }
    return route.continue()
  })
  await page.route('**/api/v1/sessions/start', async (route) => {
    startBody = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({ json: { session_id: 'started-journey-session' } })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.locator('.project-row.active').getByRole('button', { name: '新建会话', exact: true }).click()
  const modal = page.getByRole('dialog')
  await modal.getByPlaceholder('默认为 workflow-controller.yaml 中的 starting_prompt').fill('执行 E2E 启动流程')
  await modal.getByRole('button', { name: '启动会话' }).click()
  await expect.poll(() => startBody).toMatchObject({
    project_dir: '/tmp/project-a',
    prompt: '执行 E2E 启动流程',
  })
  await expect(modal).toBeHidden()
})

test('workflow member details link to the owning Run', async ({ page }) => {
  await mockSessionDependencies(page)
  await page.route('**/api/v1/sessions/e2e-journey-session', async (route) => {
    await route.fulfill({ json: sessionPayload({ id: 'e2e-journey-session', run_id: 'wf-journey', sdk_session_id: 'sdk-member' }) })
  })
  await page.route('**/api/v1/runs/wf-journey', async (route) => {
    await route.fulfill({ json: {
      run: { run_id: 'wf-journey', kind: 'workflow', format: 'graph-yaml@1', label: 'Journey workflow', status: 'running',
        pause_reason: null, work_dir: '/tmp/project-a', created_at: '2026-10-22T00:00:00Z', finished_at: null, error: null },
      sessions: [],
    } })
  })
  await page.route('**/api/v1/runs/wf-journey/state', async (route) => {
    await route.fulfill({ json: { processes: [], metrics: { rounds: 1, queue_depth: 0, deferred: 0, in_flight: 0 }, driver: null } })
  })
  await page.route('**/api/v1/runs/wf-journey/events**', async (route) => {
    await route.fulfill({ json: { events: [], next_cursor: null, has_more: false } })
  })

  await page.goto('/session/e2e-journey-session', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Journey session')).toBeVisible()
  await expect(page.getByTitle('查看所属 Run')).toHaveText('Run · Journey workflow')
  await page.getByTitle('查看所属 Run').click()
  await expect(page).toHaveURL(/\/run\/wf-journey$/)
  await expect(page.getByText('Journey workflow')).toBeVisible()
})

test('Dashboard imports a Claude Code session and removes it from candidates', async ({ page }) => {
  let importedSession = ''
  await page.route(/\/api\/v1\/sessions\/opencode(?:\?.*)?$/, async (route) => {
    await route.fulfill({ json: { sessions: [] } })
  })
  await page.route(/\/api\/v1\/sessions\/claude(?:\?.*)?$/, async (route) => {
    await route.fulfill({ json: { sessions: [{ id: 'claude-e2e', title: 'Imported Claude session', directory: '/tmp/project-a' }] } })
  })
  await page.route('**/api/v1/sessions/import-claude', async (route) => {
    importedSession = JSON.parse(route.request().postData() || '{}').session_id || ''
    await route.fulfill({ json: { success: true } })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '添加项目', exact: true }).click()
  const modal = page.getByRole('dialog')
  await modal.getByText('Claude Code', { exact: true }).click()
  await expect(modal.getByText('Imported Claude session')).toBeVisible()
  await modal.getByRole('button', { name: '导入' }).click()
  await expect.poll(() => importedSession).toBe('claude-e2e')
  await expect(modal.getByText('Imported Claude session')).toHaveCount(0)
})

test('Session details import a session into Insight and open its URL', async ({ page }) => {
  await mockSessionDependencies(page)
  await page.route('**/api/v1/sessions/e2e-journey-session', async (route) => {
    await route.fulfill({ json: sessionPayload() })
  })
  await page.route('**/api/v1/insight/import?session_id=e2e-journey-session', async (route) => {
    await route.fulfill({ json: { ok: true, insightUrl: '/insight/run/solo:e2e-journey-session' } })
  })

  await page.goto('/session/e2e-journey-session', { waitUntil: 'domcontentloaded' })
  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Insight' }).click()
  const popup = await popupPromise
  await expect(popup).toHaveURL(/\/insight\/run\/solo:e2e-journey-session$/)
})

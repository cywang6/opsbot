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
import { mockSessionDeps, sessionPayload } from './support/mock-session'

test('idle Session can be resumed and sent a message', async ({ page }) => {
  const session = sessionPayload({ state: 'idle', stop_reason: 'user_pause' })
  let resumed = false
  let sentText = ''
  // 只装依赖不导航：专用子路由（resume/send）后注册再 goto（newest wins）
  await mockSessionDeps(page, session)
  await page.route('**/api/v1/sessions/e2e-session-actions/resume', async (route) => {
    resumed = true
    await route.fulfill({ status: 200, json: { ok: true } })
  })
  await page.route('**/api/v1/sessions/e2e-session-actions/send', async (route) => {
    sentText = JSON.parse(route.request().postData() || '{}').text || ''
    await route.fulfill({ status: 200, json: { resumed: true } })
  })

  await page.goto('/session/e2e-session-actions', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('E2E action session')).toBeVisible()
  await page.getByTitle('恢复会话').click()
  await expect.poll(() => resumed).toBe(true)

  // Bind to the message input by its placeholder instead of a positional
  // `getByRole('textbox').last()`, matching the field-bound locator convention
  // used across settings.spec.ts / import.spec.ts (a positional `.last()` would
  // silently retarget if a new textbox were added earlier in the DOM).
  await page.getByPlaceholder('输入消息并按 Enter 发送...').fill('继续执行 E2E 测试')
  await page.getByRole('button', { name: '发送' }).click()
  await expect.poll(() => sentText).toBe('继续执行 E2E 测试')
})

test('idle Session can be deleted after confirmation', async ({ page }) => {
  let deleted = false
  const session = sessionPayload({ state: 'idle' })
  // 删除入口在侧栏会话行（title=删除会话）：经 SSE 推入被测会话与所属项目，
  // 侧栏才会渲染其行（真实链路里 session_update/config_update 同源）。
  // 只装依赖不导航：DELETE/GET 专用路由后注册再 goto（newest wins）
  await mockSessionDeps(page, session, {
    streamEvents: [
      ['config_update', { project_dir: '/tmp/e2e-project', recent_dirs: ['/tmp/e2e-project'] }],
      ['session_update', [session]],
    ],
  })
  await page.route('**/api/v1/sessions/e2e-session-actions', async (route) => {
    if (route.request().method() === 'DELETE') {
      deleted = true
      await route.fulfill({ status: 200, json: { ok: true } })
      return
    }
    await route.fulfill({ json: session })
  })

  await page.goto('/session/e2e-session-actions', { waitUntil: 'domcontentloaded' })
  await page.getByTitle('删除会话').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('该会话及其事件记录将被删除。')).toBeVisible()
  await dialog.getByRole('button', { name: '确认删除' }).click()
  await expect.poll(() => deleted).toBe(true)
})

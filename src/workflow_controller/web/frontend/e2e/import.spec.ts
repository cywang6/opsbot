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

test('Dashboard imports an OpenCode session and removes it from candidates', async ({ page }) => {
  let imported = false
  await page.route(/\/api\/v1\/sessions\/opencode(?:\?.*)?$/, async (route) => {
    await route.fulfill({ json: { sessions: [{ id: 'oc-e2e', title: 'Imported OpenCode session', directory: '/tmp/e2e-project' }] } })
  })
  await page.route(/\/api\/v1\/sessions\/claude(?:\?.*)?$/, async (route) => {
    await route.fulfill({ json: { sessions: [] } })
  })
  await page.route('**/api/v1/sessions/import', async (route) => {
    imported = JSON.parse(route.request().postData() || '{}').opencode_session_id === 'oc-e2e'
    await route.fulfill({ json: { success: true } })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '添加项目', exact: true }).click()
  const modal = page.getByRole('dialog')
  // 导入弹窗默认停在首个 tab（本地文件夹），Opencode 候选在专属 tab
  await modal.getByText('Opencode', { exact: true }).click()
  await expect(modal.getByText('Imported OpenCode session')).toBeVisible()
  await modal.getByRole('button', { name: '导入' }).click()
  await expect.poll(() => imported).toBe(true)
  await expect(modal.getByText('Imported OpenCode session')).toHaveCount(0)
})

test('Cannbot DB import reports a failed reconstruction', async ({ page }) => {
  await page.route(/\/api\/v1\/sessions\/opencode(?:\?.*)?$/, async (route) => {
    await route.fulfill({ json: { sessions: [] } })
  })
  await page.route(/\/api\/v1\/sessions\/claude(?:\?.*)?$/, async (route) => {
    await route.fulfill({ json: { sessions: [] } })
  })
  await page.route('**/api/sessions/import-db', async (route) => {
    await route.fulfill({ status: 500, json: { ok: false, error: 'reconstruction failed' } })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '添加项目', exact: true }).click()
  const modal = page.getByRole('dialog')
  await modal.getByText('Opencode DB', { exact: true }).click()
  await expect(modal.getByText('Session DB 文件', { exact: true })).toBeVisible()
  // Bind to each field by its placeholder instead of nth(0)/nth(1), which would
  // silently retarget if another input is added earlier in the modal.
  await modal.getByPlaceholder('选择或输入 cannbot session db 文件路径').fill('/tmp/session.db')
  await modal.getByPlaceholder('重建产出的工程目录路径').fill('/tmp/reconstructed')
  await modal.getByRole('button', { name: '重建并导入' }).click()
  await expect(page.getByText(/reconstruction failed|重建失败/)).toBeVisible()
})

test('Cannbot DB reconstruction log download resolves the target directory', async ({ page }) => {
  // DA-15（②形态：真实重建链路构造成本高；只验证日志入口与 resolved target_cwd）
  let logUrl = ''
  await page.route(/\/api\/v1\/sessions\/opencode(?:\?.*)?$/, route =>
    route.fulfill({ json: { sessions: [] } }))
  await page.route(/\/api\/v1\/sessions\/claude(?:\?.*)?$/, route =>
    route.fulfill({ json: { sessions: [] } }))
  // window.open 创建的是新 Page：page.route 不覆盖 popup，须用 context 级路由。
  await page.context().route('**/api/sessions/import-db/log?*', async route => {
    logUrl = route.request().url()
    await route.fulfill({ contentType: 'text/plain', body: 'partial reconstruction log' })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '添加项目', exact: true }).click()
  const modal = page.getByRole('dialog')
  await modal.getByText('Opencode DB', { exact: true }).click()
  await modal.getByPlaceholder('重建产出的工程目录路径').fill('/tmp/reconstructed with space')

  const popupPromise = page.waitForEvent('popup')
  await modal.getByRole('button', { name: '下载日志' }).click()
  const popup = await popupPromise
  await popup.waitForLoadState('domcontentloaded')
  await expect.poll(() => logUrl).toContain('/api/sessions/import-db/log?target_cwd=')
  expect(new URL(logUrl).searchParams.get('target_cwd')).toBe('/tmp/reconstructed with space')
  await expect(popup.locator('body')).toContainText('partial reconstruction log')
  await popup.close()
})

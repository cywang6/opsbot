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

import { expect, test } from '../fixtures'
import type { Locator, Page } from '@playwright/test'
import { NewSessionFormPO } from './pom/NewSessionFormPO'
import { createProject, IS_LIVE, switchProject, uiTimeout } from './support/env'
import { startSession } from './support/flows'

// 特性矩阵 e2e · Dashboard 会话编排域（设计文档 workflow-controller-e2e-testcase-development.md
// §2.3/§6.1）：侧栏全部停止、打开会话、项目行内新建及移除项目。
//
// E2E_LIVE=1 时为 live 环境（无 shim），整文件跳过（纯 UI/配置与等人态用例
// 不镜像 live，见设计文档 §3.4 live 镜像原则）。
test.skip(IS_LIVE, 'E2E_LIVE=1 时为 live 环境（无 shim），shim 矩阵用例不运行')

function stopAllButton(page: Page): Locator {
  return page.locator('.sidebar').getByRole('button', { name: '全部停止', exact: true })
}

async function confirmStopAll(page: Page): Promise<void> {
  await stopAllButton(page).click()
  // useConfirm 确认弹窗：标题「停止所有会话」+ 正文 + 确定。
  await expect(page.getByText('确定要停止所有项目的会话吗？'))
    .toBeVisible({ timeout: uiTimeout(10_000) })
  await page.getByRole('button', { name: '确定' }).click()
}

/** poll `GET /api/v1/sessions` 直到没有任何会话处于 running（真实停机回证）。 */
async function expectNoneRunning(page: Page): Promise<void> {
  await expect.poll(async () => {
    const res = await page.request.get('/api/v1/sessions')
    if (!res.ok()) return false
    const sessions = await res.json() as Array<{ state: string }>
    return sessions.every((s) => s.state !== 'running')
  }, { timeout: 30_000, intervals: [1_000] }).toBe(true)
}

test('DA-04 全部停止：确认弹窗 → 真实停机 → /sessions 回读终态', async ({ page }) => {
  test.setTimeout(120_000)
  const project = await createProject('da04-stop-all', { maxIterations: 30 })
  await switchProject(page, project.dir)

  const detail = await startSession(page, 'handoff-keep-running', { project, maxIterations: 30 })
  await detail.expectStatus('运行中')

  await page.goto('/')
  await expect(stopAllButton(page)).toBeVisible({ timeout: uiTimeout(15_000) })
  await confirmStopAll(page)
  await expect(page.getByText('正在停止所有会话...').first())
    .toBeVisible({ timeout: uiTimeout(10_000) })
  await expectNoneRunning(page)
  // 无运行会话后侧栏按钮隐藏。
  await expect(stopAllButton(page)).toBeHidden({ timeout: uiTimeout(15_000) })
})

test('DA-05 从侧栏打开普通会话与全部停止收尾', async ({ page }) => {
  test.setTimeout(120_000)
  const project = await createProject('da05-plain-session', { maxIterations: 30 })
  await switchProject(page, project.dir)

  const detail = await startSession(page, 'handoff-keep-running', { project, maxIterations: 30 })
  await detail.expectStatus('运行中')

  await page.goto('/')
  const row = page.locator(`.project-row[title="${project.dir}"] + .project-sessions .project-session-row`)
  await row.click()
  await detail.awaitNavigated()

  await expect(stopAllButton(page)).toBeVisible({ timeout: uiTimeout(15_000) })
  await confirmStopAll(page)
  await expectNoneRunning(page)
  await expect(stopAllButton(page)).toBeHidden({ timeout: uiTimeout(15_000) })
})

test('DA-12 侧边栏项目行内新建：PUT /config 先行 + 弹窗项目切换回读', async ({ page }) => {
  const a = await createProject('da12-proj-a')
  const b = await createProject('da12-proj-b')
  await switchProject(page, a.dir)
  // switchProject 已将 a 加入侧栏，这里只注册 b。
  const added = await page.request.post('/api/v1/recent-dirs', { data: { dir: b.dir } })
  expect(added.ok()).toBeTruthy()
  const data = await added.json() as { error?: string; recent_dirs?: string[] }
  expect(data.error).toBeUndefined()
  expect(data.recent_dirs).toContain(b.dir)
  await page.goto('/')

  const rowB = page.locator(`.project-row[title="${b.dir}"]`)
  await expect(rowB).toBeVisible({ timeout: uiTimeout(15_000) })

  // 项目行「＋」：AppSidebar.onNewSessionInProject 先 await PUT /config 持久化
  // project_dir 再开弹窗（顺序由代码路径保证；这里以 PUT 请求记录 + 弹窗可见
  // + 配置回读三重验证落点）。
  const configPuts: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'PUT' && req.url().endsWith('/api/v1/config')) {
      configPuts.push(req.postData() || '')
    }
  })
  const plus = rowB.locator('.project-new-session')
  await expect(plus).toBeEnabled({ timeout: uiTimeout(10_000) })
  await plus.click()

  const form = new NewSessionFormPO(page)
  await expect(form.modal).toBeVisible({ timeout: uiTimeout(10_000) })
  await expect.poll(() => configPuts.some((body) => body.includes(b.dir)), {
    timeout: uiTimeout(10_000),
  }).toBe(true)
  await expect.poll(async () => {
    const res = await page.request.get('/api/v1/config')
    return ((await res.json()) as { project_dir?: string }).project_dir
  }, { timeout: uiTimeout(10_000) }).toBe(b.dir)

  // 关闭弹窗（取消）并把项目指针还原回 A，不污染后续用例。
  await form.modal.getByRole('button', { name: '取消' }).click()
  await expect(form.modal).toBeHidden({ timeout: uiTimeout(10_000) })
  await switchProject(page, a.dir)
})

test('DA-13 侧边栏移除项目：有会话防误删回推、无会话真删不重现', async ({ page }) => {
  test.setTimeout(120_000)
  // 有会话项目：会话 cwd 并入 recent_dirs（后端合并 session 目录），行出现。
  const p1 = await createProject('da13-remove')
  await switchProject(page, p1.dir)
  const detail = await startSession(page, 'pass-first', { project: p1 })
  await detail.expectStatus('已完成')
  await page.goto('/')
  const row1 = page.locator(`.project-row[title="${p1.dir}"]`)
  await expect(row1).toBeVisible({ timeout: uiTimeout(15_000) })

  // 记录 UI 触发的 DELETE /recent-dirs 及其响应体（回推语义的服务器侧证据：
  // 响应即 remove 后重算的合并列表）。
  const deletes: Array<{ dir: string; recentDirs: string[] }> = []
  page.on('response', async (res) => {
    const req = res.request()
    if (req.method() !== 'DELETE' || !res.url().includes('/api/v1/recent-dirs')) return
    try {
      const dir = (JSON.parse(req.postData() || '{}') as { dir?: string }).dir || ''
      const body = await res.json() as { recent_dirs?: string[] }
      deletes.push({ dir, recentDirs: body.recent_dirs || [] })
    } catch { /* 响应体不可解析时跳过记录，断言由下方 poll 保证 */ }
  })

  await row1.locator('.dir-delete-btn').click()
  await expect.poll(() => deletes.filter((d) => d.dir === p1.dir).length, {
    timeout: uiTimeout(10_000), intervals: [500],
  }).toBeGreaterThan(0)
  // 防误删回推：有会话目录仍由 session cwd 合并兜回——DELETE 响应的合并列表
  // 即刻仍含该目录，行不消失。
  expect(deletes.find((d) => d.dir === p1.dir)!.recentDirs).toContain(p1.dir)
  await expect(row1).toBeVisible({ timeout: uiTimeout(15_000) })
  await expect.poll(async () => {
    const res = await page.request.get('/api/v1/config')
    return ((await res.json()) as { recent_dirs?: string[] }).recent_dirs || []
  }, { timeout: uiTimeout(15_000) }).toContain(p1.dir)

  // 无会话项目：移除即真删。session cwd 无来源，合并列表不可能再纳入该目录
  // （重现路径结构性不存在），断言 API 回读不含 + 行消失即充分。
  const p2 = await createProject('da13-empty')
  const added = await (await page.request.post('/api/v1/recent-dirs', { data: { dir: p2.dir } }))
    .json() as { error?: string; recent_dirs?: string[] }
  expect(added.error).toBeUndefined()
  const row2 = page.locator(`.project-row[title="${p2.dir}"]`)
  await expect(row2).toBeVisible({ timeout: uiTimeout(15_000) })
  await row2.locator('.dir-delete-btn').click()
  await expect.poll(() => deletes.filter((d) => d.dir === p2.dir).length, {
    timeout: uiTimeout(10_000), intervals: [500],
  }).toBeGreaterThan(0)
  expect(deletes.find((d) => d.dir === p2.dir)!.recentDirs).not.toContain(p2.dir)
  await expect(row2).toHaveCount(0, { timeout: uiTimeout(15_000) })
  await expect.poll(async () => {
    const res = await page.request.get('/api/v1/config')
    return ((await res.json()) as { recent_dirs?: string[] }).recent_dirs || []
  }, { timeout: uiTimeout(15_000) }).not.toContain(p2.dir)
})

test('MX-06 多项目并发会话：事件分桶与状态独立，全部停止覆盖双方', async ({ page }) => {
  test.setTimeout(120_000)
  const a = await createProject('mx06-project-a', { maxIterations: 30 })
  const b = await createProject('mx06-project-b', { maxIterations: 30 })

  await switchProject(page, a.dir)
  const detailA = await startSession(page, 'handoff-keep-running', {
    project: a, reviewer: false, maxIterations: 30,
  })
  await detailA.expectStatus('运行中')
  const idA = detailA.sessionId()
  await switchProject(page, b.dir)
  const detailB = await startSession(page, 'handoff-keep-running', {
    project: b, reviewer: false, maxIterations: 30,
  })
  await detailB.expectStatus('运行中')
  const idB = detailB.sessionId()

  await expect.poll(async () => {
    const res = await page.request.get('/api/v1/sessions')
    if (!res.ok()) return []
    const sessions = await res.json() as Array<{ id: string; state: string; project_dir: string }>
    return sessions.map(s => ({ id: s.id, state: s.state, project_dir: s.project_dir }))
  }, { timeout: 30_000, intervals: [1_000] }).toEqual(expect.arrayContaining([
    { id: idA, state: 'running', project_dir: a.dir },
    { id: idB, state: 'running', project_dir: b.dir },
  ]))

  // 事件分桶回证：两个项目各自的事件流只含自己的 session_id。
  for (const [id, other] of [[idA, idB], [idB, idA]]) {
    await expect.poll(async () => {
      const res = await page.request.get(`/api/v1/events?session_id=${id}&limit=100`)
      if (!res.ok()) return false
      const events = (await res.json()).events || []
      return events.length > 0 && events.every((e: { session_id?: string }) =>
        e.session_id === id && e.session_id !== other)
    }, { timeout: 30_000, intervals: [1_000] }).toBe(true)
  }

  await page.goto('/')
  await confirmStopAll(page)
  await expectNoneRunning(page)
  await expect.poll(async () => {
    const res = await page.request.get('/api/v1/sessions')
    const sessions = await res.json() as Array<{ id: string; state: string }>
    return [idA, idB].every(id => sessions.find(s => s.id === id)?.state !== 'running')
  }, { timeout: 30_000, intervals: [1_000] }).toBe(true)
})

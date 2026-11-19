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
import { SessionDetailPO } from './pom/SessionDetailPO'
import { createProject, IS_LIVE, switchProject, uiTimeout } from './support/env'
import { startSession } from './support/flows'

// 特性矩阵 e2e · 检查点重放域（设计文档 workflow-controller-e2e-testcase-development.md
// §6.7 MX-04，吸收 §6.5 PL-01 检查点面板断言与 §6.2 SD-10 fork 段）：
// pass-first 会话完成 → 终态检查点 → ReplayConfigModal 提交 → fork 会话
// 真实创建并跑完 → Dashboard ↻ 徽标 + 按 origin 项目归组 → origin 面板
// 「重放会话」卡 → fork 态删除三态文案 + 真实删除回证。重放提示词
// 「请继续你之前的工作。」无场景标记 → shim 默认 pass-first，fork 一轮完成。
//
// E2E_LIVE=1 时为 live 环境（无 shim），整文件跳过（重放链含内核决策，
// live 镜像按 §3.4 原则另行评估，不进门禁）。
test.skip(IS_LIVE, 'E2E_LIVE=1 时为 live 环境（无 shim），shim 矩阵用例不运行')

test('MX-04 检查点重放 fork 真链路（吸收 PL-01 + SD-10 fork 段）：重放 → 完成 → ↻ 徽标归组 → 三态删除', async ({ page }) => {
  test.setTimeout(120_000)
  const project = await createProject('mx04-replay')
  await switchProject(page, project.dir)

  const detail = await startSession(page, 'pass-first', { project })
  await detail.expectStatus('已完成')
  const originId = detail.sessionId()

  // 终态检查点落地：session_complete 快照须 git_ref + status ok 才可重放。
  // 经 API 投影等就绪再开 tab——面板除首拉外只在会话态迁移时重拉，若进入
  // 页面时快照尚未完成，仅靠首拉会漏。
  await expect.poll(async () => {
    const res = await page.request.get(`/api/sessions/${originId}/checkpoints`)
    if (!res.ok()) return 0
    const data = await res.json()
    return (data.checkpoints || []).filter(
      (cp: { trigger?: string, git_ref?: string, status?: string }) =>
        cp.trigger === 'session_complete' && cp.git_ref && cp.status === 'ok',
    ).length
  }, { timeout: 30_000, intervals: [1_000] }).toBeGreaterThan(0)

  // 检查点面板（PL-01）：final 检查点列表项（↻ 图标）→ 点击开重放弹窗。
  // 点击目标用 .cp-type（类型文本）：整行中心会落在行内「预览检查点文件态」
  // 按钮上（stopPropagation，开的是文件预览弹窗而非重放弹窗）。
  await page.getByText('检查点', { exact: true }).first().click()
  const checkpointItem = page.locator('.checkpoint-item').first()
  await expect(checkpointItem).toBeVisible({ timeout: 15_000 })
  await expect(checkpointItem.locator('.cp-icon')).toHaveText('↻')
  await expect(checkpointItem.getByText('final')).toBeVisible()
  await checkpointItem.locator('.cp-type').click()

  // ReplayConfigModal：等表单按 origin 项目配置装载（框架继承 claude_cli、
  // 提示词默认续跑信号）再提交。NModal 无隐式 dialog role（SettingsModal 是
  // 显式声明），按 .n-modal 类定位。
  const replayModal = page.locator('.n-modal').filter({ hasText: '重放检查点' })
  await expect(replayModal).toBeVisible({ timeout: uiTimeout(10_000) })
  await expect(
    replayModal.locator('.n-form-item').filter({ hasText: '代理框架' }),
  ).toContainText('Claude CLI', { timeout: uiTimeout(10_000) })
  await expect(replayModal.getByPlaceholder('默认为 workflow-controller.yaml 中的 starting_prompt'))
    .toHaveValue('请继续你之前的工作。')
  await replayModal.getByRole('button', { name: '确认重放' }).click()
  await expect(page.getByText('重放会话已启动').first())
    .toBeVisible({ timeout: uiTimeout(30_000) })

  // fork 创建并自动跳转（onReplayed → open-session → /session/{forkId}）。
  await page.waitForURL(
    url => !url.pathname.endsWith(`/session/${originId}`),
    { timeout: 30_000 },
  )
  const fork = new SessionDetailPO(page)
  const forkId = fork.sessionId()
  expect(forkId).not.toBe(originId)

  // fork 真实运行：隔离 cwd 的 shim 无场景标记 → 默认 pass-first → 一轮完成。
  await fork.expectStatus('已完成', uiTimeout(60_000))

  // 首页侧栏：fork 按 origin 项目归组（fork 实际 project_dir 是隔离 tempdir，
  // logicalProjectDir 经 birth_traceback 指回 origin 的项目目录——当前项目
  // 视图能看到该行即归组成立）。Dashboard 运行列表在 c7a53a78 迁移到侧栏。
  await page.goto('/')
  const forkRow = page.locator('.project-session-row').filter({ hasText: 'replay-' })
  await expect(forkRow).toBeVisible({ timeout: 15_000 })

  // origin 面板回传：检查点 tab 出现「重放会话」卡（fork 拓扑边）。
  await page.goto(`/session/${originId}`, { waitUntil: 'domcontentloaded' })
  await page.getByText('检查点', { exact: true }).first().click()
  const forkCard = page.locator('.n-card:not(.session-sidebar-card)').filter({ hasText: '重放会话' })
  await expect(forkCard).toBeVisible({ timeout: 15_000 })
  await expect(forkCard.getByText('replay-')).toBeVisible()

  // SD-10 fork 段：删除三态的 fork 态文案（提示清理 ~2GB 隔离目录）→ 确认 →
  // 行消失 + API 投影 404 语义（真实删除回证；fork_root 清理由后端承担）。
  await page.goto('/')
  await forkRow.locator('.history-delete').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('这是重放产生的派生会话。删除将一并清理其隔离工作目录（~2GB 临时目录）。原会话不受影响。'))
    .toBeVisible()
  await dialog.getByRole('button', { name: '确认删除' }).click()
  await expect(page.getByText('已删除会话').first()).toBeVisible({ timeout: 15_000 })
  await expect(forkRow).toHaveCount(0, { timeout: 15_000 })
  const res = await page.request.get(`/api/v1/sessions/${forkId}`)
  expect(await res.json()).toMatchObject({ error: 'session not found' })
})

test('MX-09 会话删除清理链：fork_root 真删且 recent_dirs 不保留隔离目录', async ({ page }) => {
  test.setTimeout(120_000)
  const { existsSync } = await import('node:fs')
  const project = await createProject('mx09-fork-cleanup')
  await switchProject(page, project.dir)
  const detail = await startSession(page, 'pass-first', { project })
  await detail.expectStatus('已完成')
  const originId = detail.sessionId()

  await expect.poll(async () => {
    const res = await page.request.get(`/api/sessions/${originId}/checkpoints`)
    if (!res.ok()) return false
    return ((await res.json()).checkpoints || []).some(
      (cp: { trigger?: string; git_ref?: string; status?: string }) =>
        cp.trigger === 'session_complete' && cp.git_ref && cp.status === 'ok')
  }, { timeout: 30_000, intervals: [1_000] }).toBe(true)

  await page.getByText('检查点', { exact: true }).first().click()
  const checkpointItem = page.locator('.checkpoint-item').first()
  await expect(checkpointItem).toBeVisible({ timeout: 15_000 })
  await checkpointItem.locator('.cp-type').click()
  const replayModal = page.locator('.n-modal').filter({ hasText: '重放检查点' })
  await expect(replayModal).toBeVisible()
  await replayModal.getByRole('button', { name: '确认重放' }).click()
  await page.waitForURL(url => !url.pathname.endsWith(`/session/${originId}`), { timeout: 30_000 })
  const fork = new SessionDetailPO(page)
  await fork.expectStatus('已完成', uiTimeout(60_000))
  const forkId = fork.sessionId()

  const forkInfo = await (await page.request.get(`/api/v1/sessions/${forkId}`)).json()
  const birth = forkInfo.plugin_metadata?.agent_traceback?.birth_traceback || {}
  const forkRoot = String(birth.fork_root || '')
  const forkCwd = String(birth.fork_cwd || '')
  expect(forkRoot).toBeTruthy()
  expect(forkCwd).toBeTruthy()
  expect(existsSync(forkRoot)).toBe(true)

  await page.goto('/')
  const forkRow = page.locator('.project-session-row').filter({ hasText: 'replay-' })
  await expect(forkRow).toBeVisible({ timeout: 15_000 })
  await forkRow.locator('.history-delete').click()
  await page.getByRole('dialog').getByRole('button', { name: '确认删除' }).click()
  await expect(forkRow).toHaveCount(0, { timeout: 15_000 })

  // 清理在 DELETE 返回前由插件拦截器同步完成；recent_dirs 只保留 origin 项目，
  // fork 的隔离 cwd/root 既不能在删除前污染列表，也不能在删除后残留。
  expect(existsSync(forkRoot)).toBe(false)
  const config = await (await page.request.get('/api/v1/config')).json()
  expect(config.recent_dirs).toContain(project.dir)
  expect(config.recent_dirs).not.toContain(forkCwd)
  expect(config.recent_dirs).not.toContain(forkRoot)
})

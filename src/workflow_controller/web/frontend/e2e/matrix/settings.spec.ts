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

import { expect, test, type Page } from '../fixtures'
import { SettingsPO } from './pom/SettingsPO'
import { createProject, IS_LIVE, switchProject } from './support/env'
import { startSession } from './support/flows'

// 特性矩阵 e2e · 设置域（设计文档 workflow-controller-e2e-testcase-development.md
// §2.6/§6.4/§6.7）：Settings 写路径真链路——ST-01 Watchdog 三规则、ST-02
// 外观主题/品牌名（SSE 真实推送）、ST-04 Context Bay 切片目录、MX-13 插件启停
// 与行内配置（吸收 ST-05/PL-06）。断言原则（§4.5）：toast 之外必须 GET
// 回读回证 + reload 后保持；写路径落盘隔离配置 yaml / 插件 config.yaml，
// 每条用例结束时把改动恢复原值，不污染同批后续用例（workers:1 顺序执行）。
//
// E2E_LIVE=1 时为 live 环境（无 shim），整文件跳过（live 层不镜像纯
// UI/配置类用例——设计文档 §3.4 live 镜像原则）。
test.skip(IS_LIVE, 'E2E_LIVE=1 时为 live 环境（无 shim），shim 矩阵用例不运行')

// 与 SettingsModal.saveWeb 同构的恢复通道（PUT /config 写内存 + POST
// /config/save 落盘）：用例结束时整份写回进入用例前的原配置。
async function restoreConfig(page: Page, original: Record<string, unknown>): Promise<void> {
  const r1 = await page.request.put('/api/v1/config', { data: original })
  expect(r1.ok()).toBeTruthy()
  const r2 = await page.request.post('/api/v1/config/save')
  expect(r2.ok()).toBeTruthy()
}

test('ST-01 Watchdog 三规则编辑保存：toast + 回读一致 + reload 持久', async ({ page }) => {
  const po = new SettingsPO(page)
  const original = await (await page.request.get('/api/v1/config')).json()

  await po.open('Watchdog')
  await po.fillField('超时阈值（秒）', '2222')
  await po.fillField('追踪文件', 'logs/e2e-watchdog.md')
  await po.fillField('连续未变化阈值', '4')
  await po.fillField('检测文件', 'logs/e2e-keyword.md')
  await po.fillField('关键词', 'e2e-stall')
  await po.save('保存设置')
  await po.expectToast('全局设置已保存')

  // 回读回证：saveWeb 的 PUT /config + POST /config/save 双请求成功后的 GET 投影。
  await expect.poll(() => po.configField('watchdog.subagent_timeout_seconds')).toBe(2222)
  await expect.poll(() => po.configField('watchdog.track_file')).toBe('logs/e2e-watchdog.md')
  await expect.poll(() => po.configField('watchdog.file_stall_threshold')).toBe(4)
  await expect.poll(() => po.configField('watchdog.track_keyword_file')).toBe('logs/e2e-keyword.md')
  await expect.poll(() => po.configField('watchdog.track_keyword')).toBe('e2e-stall')

  // reload 持久：重进设置弹窗，字段按落盘配置回填。
  await po.open('Watchdog')
  expect(await po.fieldValue('超时阈值（秒）')).toBe('2222')
  expect(await po.fieldValue('追踪文件')).toBe('logs/e2e-watchdog.md')
  expect(await po.fieldValue('检测文件')).toBe('logs/e2e-keyword.md')
  expect(await po.fieldValue('关键词')).toBe('e2e-stall')

  await restoreConfig(page, original)
})

test('ST-02 外观真链路：主题即时生效 + 品牌名保存（SSE 推送 + 回读 + reload 持久）', async ({ page }) => {
  const po = new SettingsPO(page)
  const originalBrand = (await po.configField<string>('brand_name')) ?? 'Workflow Controller'

  await po.open('外观')
  // 原主题 label（恢复用；主题卡 n-select 显示当前选项 label）。
  const themeCard = po.modal.locator('.n-card:visible').filter({ hasText: '主题选择后立即生效' })
  const originalThemeLabel = ((await themeCard.locator('.n-select').textContent()) ?? '').trim()

  // 主题即时生效（未点保存）：html 令牌 + body 背景 + localStorage 三重断言
  // （github-light 的 body 是纯色 #f6f8fa，非渐变主题，背景断言安全）。
  await po.selectTheme('GitHub Light')
  await expect(page.locator('html')).toHaveAttribute('data-appearance-theme', 'github-light')
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(246, 248, 250)')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('workflow-controller-appearance-theme')))
    .toBe('github-light')

  // 品牌名：PUT 只带外观字段 → SSE config_update 真实推送（标题/侧栏即时更新）。
  await po.brandNameInput().fill('E2E 品牌名')
  await po.save('保存外观设置')
  await po.expectToast('外观设置已保存')
  await expect.poll(() => page.title()).toContain('E2E 品牌名')
  await expect(page.locator('.sidebar-title')).toHaveText('E2E 品牌名')
  await expect.poll(() => po.configField('brand_name')).toBe('E2E 品牌名')

  // reload 持久：重进弹窗回填品牌名，标题随落盘配置重建。
  await po.open('外观')
  await expect(po.brandNameInput()).toHaveValue('E2E 品牌名')
  await expect.poll(() => page.title()).toContain('E2E 品牌名')

  // 恢复：主题切回原值（选择即时生效，随外观保存一并持久化）+ 品牌名写回。
  await po.selectTheme(originalThemeLabel)
  await po.brandNameInput().fill(originalBrand)
  await po.save('保存外观设置')
  await po.expectToast('外观设置已保存')
})

test('ST-04 Context Bay 切片目录增删：空态文案 + 条目呈现 + 回读一致', async ({ page }) => {
  const po = new SettingsPO(page)
  const original = await (await page.request.get('/api/v1/config')).json()

  await po.open('Context Bay 上传')

  // 矩阵隔离配置（boot 的 workflow-controller-config.yaml）未配置切片目录 → 空态文案。
  await expect(po.modal.getByText('未配置切片目录（默认只上传 events.db）')).toBeVisible()

  await po.addSnapshotPath('operators/e2e-snapshot/')
  await expect(po.snapshotPathItem('operators/e2e-snapshot/')).toBeVisible()
  await po.addSnapshotPath('docs/e2e-add/')
  await expect(po.modal.locator('.snapshot-path-item')).toHaveCount(2)

  // 逐条删除：移除首条后仍剩一条（空态未回归）。
  await po.snapshotPathItem('operators/e2e-snapshot/').getByRole('button', { name: '删除' }).click()
  await expect(po.snapshotPathItem('operators/e2e-snapshot/')).toHaveCount(0)
  await expect(po.modal.locator('.snapshot-path-item')).toHaveCount(1)

  await po.save('保存设置')
  await po.expectToast('全局设置已保存')
  await expect.poll(() => po.configField<string[]>('context_bay.snapshot_paths'))
    .toEqual(['docs/e2e-add/'])

  // reload 持久：重进弹窗条目仍在。
  await po.open('Context Bay 上传')
  await expect(po.snapshotPathItem('docs/e2e-add/')).toBeVisible()

  await restoreConfig(page, original)
})

test('MX-13 插件启停与行内配置真链路：动态 tab 联动 + 配置回读（吸收 ST-05/PL-06）', async ({ page }) => {
  const project = await createProject('mx13-plugins')
  await switchProject(page, project.dir)

  // 前置：boot 临时启用的 agent_traceback（teardown 快照还原保障）→ 完成
  // 会话的详情页有「检查点」插件 tab。
  const detail = await startSession(page, 'pass-first', { project })
  await detail.expectStatus('已完成')
  const sessionId = detail.sessionId()
  await expect(page.getByText('检查点', { exact: true }).first()).toBeVisible()

  // breather 行内配置原值（改动后恢复用）。
  const originalThreshold = (await (await page.request.get('/api/v1/plugins/breather/config')).json())
    .fields.context_threshold_pct

  // 禁用 → toggle 即时 reload（toast 的「保存后生效」指配置面）→ manifest
  // 刷新经 API 投影回证 → 详情页插件 tab 消失。
  const po = new SettingsPO(page)
  await po.open('插件')
  await po.togglePlugin('agent_traceback')
  await po.expectToast('agent_traceback 已禁用（保存后生效）')
  await expect.poll(async () => {
    const res = await page.request.get('/api/v1/plugins')
    const entry = ((await res.json()).plugins || [])
      .find((p: { name: string }) => p.name === 'agent_traceback')
    return entry ? 'manifest' in entry : false
  }).toBe(false)

  await page.goto(`/session/${sessionId}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('检查点', { exact: true })).toHaveCount(0)

  // 重新启用 → manifest 恢复 → 插件 tab 回来（动态 tab 联动的正向路径）。
  await po.open('插件')
  await po.togglePlugin('agent_traceback')
  await po.expectToast('agent_traceback 已启用（保存后生效）')
  await page.goto(`/session/${sessionId}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('检查点', { exact: true }).first())
    .toBeVisible({ timeout: 15_000 })

  // 行内配置：breather 主代理阈值改 80 → 保存 → 回读一致 → 恢复原值。
  await po.open('插件')
  await po.expandPluginConfig('breather')
  await po.fillField('主代理阈值（%）', '80')
  await po.savePluginConfig('breather')
  await po.expectToast('breather 配置已保存')
  await expect.poll(async () => {
    const res = await page.request.get('/api/v1/plugins/breather/config')
    return (await res.json()).fields.context_threshold_pct
  }).toBe(80)

  await po.fillField('主代理阈值（%）', String(originalThreshold))
  await po.savePluginConfig('breather')
  await po.expectToast('breather 配置已保存')
})

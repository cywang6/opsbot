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

import { expect } from '../../fixtures'
import type { Locator, Page } from '@playwright/test'
import { uiTimeout } from '../support/env'

// Run 详情页面对象。run 终态徽章 + DAG 面板可见性 + 成员表/控制条/导出。
// 回滚细节（回滚边/代数）经 /runs/{id}/state 的驱动快照断言（解释器
// 写盘的持久真相），UI 断言只锚定用户可见部分。
export class RunViewPO {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  async awaitNavigated(): Promise<void> {
    await this.page.waitForURL(/\/run\/.+$/)
  }

  runId(): string {
    const match = this.page.url().match(/\/run\/([^/?#]+)/)
    return match ? match[1] : ''
  }

  /** 状态徽章文本（运行中/已暂停/已完成/失败/已停止/待运行）。 */
  async expectStatus(label: string, timeout: number = uiTimeout(90_000)): Promise<void> {
    await expect(
      this.page.locator('.n-tag').filter({ hasText: label }).first(),
    ).toBeVisible({ timeout })
  }

  /** pause_reason 标签（run paused 时：用户暂停/密钥挂起/成员投影）。 */
  async expectPauseReason(label: string): Promise<void> {
    await expect(
      this.page.locator('.n-tag').filter({ hasText: label }).first(),
    ).toBeVisible({ timeout: uiTimeout(15_000) })
  }

  async expectCompleted(): Promise<void> {
    await this.expectStatus('已完成')
  }

  async expectDagPanelVisible(workflow: string): Promise<void> {
    await expect(this.page.getByText(workflow, { exact: true }).first())
      .toBeVisible({ timeout: uiTimeout(30_000) })
  }

  /** 驱动投影里的回滚证据：rollback_edges 非空或归档实例非空。 */
  async expectRollbackHappened(): Promise<void> {
    const runId = this.runId()
    await expect.poll(async () => {
      const response = await this.page.request.get(`/api/v1/runs/${runId}/state`)
      if (!response.ok()) return false
      const state = await response.json()
      const driver = state.driver || {}
      const edges: unknown[] = driver.rollback_edges || []
      // retired_instances 投影为数组，快照降级时为对象，取 key 数兼容两者
      const retired = driver.retired_instances || {}
      return edges.length > 0 || Object.keys(retired).length > 0
    }, { timeout: 30_000, intervals: [1_000] }).toBe(true)
  }

  // ── 成员表（RunSessionsTable）────────────────────────────────────

  /** 成员行（n-data-table 行，按 session_id 前缀定位）。 */
  memberRow(sessionId: string): Locator {
    return this.page.locator('.n-data-table-tr').filter({ hasText: sessionId })
  }

  async expectMember(sessionId: string, timeout: number = uiTimeout(30_000)): Promise<void> {
    await expect(this.memberRow(sessionId).first()).toBeVisible({ timeout })
  }

  /** 行内成员级控制按钮（暂停/恢复/停止/注入）。 */
  memberButton(sessionId: string, label: string): Locator {
    return this.memberRow(sessionId).getByRole('button', { name: label, exact: true })
  }

  async memberControl(sessionId: string, label: string): Promise<void> {
    await this.memberButton(sessionId, label).click()
  }

  async openInject(sessionId: string): Promise<void> {
    await this.memberButton(sessionId, '注入').click()
    await expect(
      this.page.getByRole('dialog').filter({ hasText: '成员定向注入' }),
    ).toBeVisible({ timeout: uiTimeout(10_000) })
  }

  async submitInject(text: string): Promise<void> {
    await this.page.getByPlaceholder('注入给该成员的提示词').fill(text)
    await this.page.getByRole('dialog').getByRole('button', { name: '注入' }).click()
  }

  /** 成员行点击下钻 Session Detail。 */
  async openMember(sessionId: string): Promise<void> {
    await this.memberRow(sessionId).first().click()
    await this.page.waitForURL(/\/session\/.+$/)
  }

  // ── 控制条 / 指标 / 进程表 / 导出 ─────────────────────────────────

  controlButton(label: string): Locator {
    return this.page.getByRole('button', { name: label, exact: true })
  }

  async control(label: '恢复' | '停止' | '重启'): Promise<void> {
    await this.controlButton(label).click()
  }

  /** 指标行：`轮次 N · 队列 N · 挂起 N · 在途 N`。Vue 模板缩进在行首尾
   *  留下单个空格（textContent = " 轮次 … 在途 N "），getByText 的正则
   *  匹配不做 trim——`^…$` 全行锚定永远落空；以行内独有片段锚定。 */
  metricsLine(): Locator {
    return this.page.getByText('· 队列').filter({ hasText: '· 在途' })
  }

  /** 进程表「run 键进程」卡。 */
  processesCard(): Locator {
    return this.page.locator('.n-card').filter({ hasText: 'run 键进程' })
  }

  async exportRun(): Promise<void> {
    await this.page.getByRole('button', { name: '导出', exact: true }).click()
  }

  async cancelExport(): Promise<void> {
    await this.page.getByRole('button', { name: '取消', exact: true }).click()
  }

  async closeExportModal(): Promise<void> {
    await this.page.getByRole('button', { name: '关闭', exact: true }).click()
  }
}

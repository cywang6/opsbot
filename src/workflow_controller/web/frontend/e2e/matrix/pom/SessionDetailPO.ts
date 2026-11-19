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

// 会话详情页面对象。断言依据来自 SessionDetailView.vue 的可见文案：
// 循环状态（已完成/已交接/运行中/已暂停）、迭代计数（迭代 N/M）、等待输入横幅、
// 会话交接 Tab 与交接/强制按钮、消息输入框、头部元信息（模型/耗时）。
export class SessionDetailPO {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  async awaitNavigated(): Promise<void> {
    await this.page.waitForURL(/\/session\/.+$/)
  }

  sessionId(): string {
    const match = this.page.url().match(/\/session\/([^/?#]+)/)
    return match ? match[1] : ''
  }

  /** 循环状态标签（运行中/已完成/已交接/…）。 */
  statusText(text: string): Locator {
    return this.page.getByText(text, { exact: true }).first()
  }

  async expectStatus(text: string, timeout: number = uiTimeout(30_000)): Promise<void> {
    await expect(this.statusText(text)).toBeVisible({ timeout })
  }

  async expectIterations(current: number, max: number): Promise<void> {
    await expect(
      this.page.getByText(`${current}/${max}`, { exact: true }).first(),
    ).toBeVisible({ timeout: uiTimeout(30_000) })
  }

  /** 头部元信息（会话统计卡，概览 tab 默认可见）：耗时行（fmtDur 的
   * `Ns`/`Nm Ns`/`Nh Nm` 形态）与创建时间行。E1 增补断言（顶替 SD-01）。 */
  async expectHeaderMeta(): Promise<void> {
    // 会话统计卡嵌在侧栏卡内：按专用 class 精确定位，避免外层卡也被
    // hasText 命中（strict mode 多匹配）。
    const stats = this.page.locator('.n-card.session-stat-card')
    await expect(stats).toBeVisible({ timeout: uiTimeout(30_000) })
    await expect(stats.getByText('会话统计', { exact: true })).toBeVisible()
    await expect(stats.getByText('耗时', { exact: true })).toBeVisible()
    await expect(stats.getByText('创建时间', { exact: true })).toBeVisible()
    await expect(
      stats.getByText(/^\d+h \d+m$|^\d+m \d+s$|^\d+s$/).first(),
    ).toBeVisible({ timeout: uiTimeout(30_000) })
  }

  async expectWaitingForInput(): Promise<void> {
    await expect(
      this.page.getByText(/模型在等你回答问题|本轮结束时，模型的问题尚未回答|自动回复出错，请手动回复/),
    ).toBeVisible({ timeout: uiTimeout(30_000) })
  }

  async openHandoffTab(): Promise<void> {
    // Naive UI 的 n-tabs 头在无障碍树里不是 role=tab，按文本定位。
    await this.page.getByText('会话交接', { exact: true }).first().click()
  }

  async forceHandoff(): Promise<void> {
    await this.page.getByTitle('跳过阈值检查，强制触发交接').click()
  }

  /** 「最近一次交接」收敛为成功：handoff agent 产出文档、接续会话已启动。
   * 侧栏卡（session-sidebar-card）包含全部 tab 内容，排除后只命链路卡本体。 */
  async expectLastHandoffSucceeded(timeout: number = uiTimeout(60_000)): Promise<void> {
    const card = this.page.locator('.n-card:not(.session-sidebar-card)')
      .filter({ hasText: '最近一次交接' })
    await expect(card.getByText('成功', { exact: true })).toBeVisible({ timeout })
  }

  /** 沿交接链下钻：handoff agent 会话 → 接续 worker 会话。 */
  async openHandoffChain(): Promise<void> {
    await this.page.getByText('-handoff-1', { exact: false }).first().click()
    await this.page.getByText('-continue-1', { exact: false }).first().click()
  }

  async sendManualMessage(text: string): Promise<void> {
    // 等待输入态的 placeholder 是「回答模型问题...」（SessionDetailView
    // getInputPlaceholder），普通 idle 态是「输入消息并按 Enter 发送...」。
    const input = this.page.locator(
      'input[placeholder="回答模型问题..."], input[placeholder="输入消息并按 Enter 发送..."]',
    ).first()
    await input.fill(text)
    await this.page.getByRole('button', { name: '发送' }).click()
  }

  // ── 控制面四件套（MX-11）：暂停/注入/恢复/停止 ────────────────────

  private inputBox(): Locator {
    // 输入框 placeholder 随会话状态/回复模式切换（getInputPlaceholder 四态），
    // 统一按已知 placeholder 集合定位，不耦合具体态。
    return this.page.locator(
      'input[placeholder="输入消息并按 Enter 发送..."], '
      + 'input[placeholder="回答模型问题..."], '
      + 'input[placeholder="回答 CP 问题..."], '
      + 'input[placeholder="请切换到手动回复模式再发送消息"], '
      + 'input[placeholder="会话运行中，无 CP 门禁"]',
    ).first()
  }

  /** 头部「暂停」按钮（title=暂停）。workflow 成员自动经 run 端点。 */
  async pause(): Promise<void> {
    await this.page.getByTitle('暂停').click()
  }

  /** 头部「恢复会话」按钮。 */
  async resume(): Promise<void> {
    await this.page.getByTitle(/恢复会话|^恢复$/).first().click()
  }

  /** 填入输入框并点「发送」（send：注入 + 可续跑时自动恢复）。 */
  async send(text: string): Promise<void> {
    await this.inputBox().fill(text)
    await this.page.getByRole('button', { name: '发送' }).click()
  }

  /** 输入框当前值（发送失败回填断言用）。 */
  async inputValue(): Promise<string> {
    return this.inputBox().inputValue()
  }

  async toast(text: string): Promise<void> {
    await expect(this.page.getByText(text).first())
      .toBeVisible({ timeout: uiTimeout(10_000) })
  }

  /** 输出日志（VirtualLog）内的任意文本。 */
  logText(text: string): Locator {
    return this.page.locator('.vlog').getByText(text, { exact: false }).first()
  }

  // ── API 投影断言（回读回证）──────────────────────────────────────

  /** `GET /api/v1/sessions/{id}` 的任意字段（expect.poll 的轮询体）。 */
  async sessionField(field: string): Promise<unknown> {
    const res = await this.page.request.get(`/api/v1/sessions/${this.sessionId()}`)
    if (!res.ok()) return null
    return (await res.json())[field]
  }
}

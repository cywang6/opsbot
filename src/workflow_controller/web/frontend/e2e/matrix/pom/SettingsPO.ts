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

// e2e 调用插件内部名（API/manifest 名）；设置界面渲染展示名。
const pluginPresentation = new Map([
  ['agent_traceback', { label: '检查点回滚' }],
  ['breather', { label: '上下文交接' }],
])

// Settings 弹窗页面对象：六区切换 + 表单项定位 + 保存 + 回读断言。
// 选择器约定与 settings.spec.ts 一致：表单项按 `.n-form-item` + label 文本
// 过滤，n-select 用 `.n-select` + `.n-base-select-option` 选项文本。各区用
// v-show 渲染（DOM 常驻），按可见性过滤避免 strict-mode 多匹配。
export class SettingsPO {
  readonly modal: Locator
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    this.modal = page.getByRole('dialog')
  }

  /** 经路由深链打开并等待加载完成（`加载设置中...` 消失）。 */
  async open(section?: string): Promise<void> {
    await this.page.goto(
      section ? `/settings?section=${encodeURIComponent(section)}` : '/settings',
      { waitUntil: 'domcontentloaded' },
    )
    await expect(this.modal).toBeVisible({ timeout: uiTimeout(10_000) })
    await expect(this.modal.getByText('加载设置中...')).toBeHidden({ timeout: uiTimeout(10_000) })
  }

  /** 左侧分区导航（n-tabs，非 role=tab/button，按 tab 文本定位）。 */
  async selectSection(name: string): Promise<void> {
    await this.modal.locator('.n-tabs-tab').filter({ hasText: name }).click()
  }

  field(label: string): Locator {
    return this.modal.locator('.n-form-item:visible').filter({ hasText: label })
  }

  async fillField(label: string, value: string): Promise<void> {
    await this.field(label).locator('input').fill(value)
  }

  async fieldValue(label: string): Promise<string> {
    return this.field(label).locator('input').first().inputValue()
  }

  /** n-select 选具体选项文本（等选项浮层渲染后点选）。 */
  async selectOption(label: string, option: string): Promise<void> {
    await this.field(label).locator('.n-select').click()
    await this.page.locator('.n-base-select-option').filter({ hasText: option }).first().click()
  }

  /** 外观区主题下拉（不在 n-form-item 里，挂在「主题」卡内）。 */
  async selectTheme(option: string): Promise<void> {
    const card = this.modal.locator('.n-card:visible').filter({ hasText: '主题选择后立即生效' })
    await card.locator('.n-select').click()
    await this.page.locator('.n-base-select-option').filter({ hasText: option }).first().click()
  }

  /** 品牌名称输入（外观区卡内 input，placeholder 为默认品牌名）。 */
  brandNameInput(): Locator {
    return this.modal.locator('.n-card:visible').filter({ hasText: '侧边栏标识与浏览器标签标题' }).locator('input')
  }

  /** Context Bay 切片目录输入（placeholder 定位）+「+ 添加」。 */
  async addSnapshotPath(path: string): Promise<void> {
    await this.modal.getByPlaceholder('如 operators/add_custom_package/ 或 docs/add/').fill(path)
    await this.modal.locator('button:visible').filter({ hasText: '+ 添加' }).click()
  }

  snapshotPathItem(path: string): Locator {
    return this.modal.locator('.snapshot-path-item').filter({ hasText: path })
  }

  /** 区内保存按钮（各区按钮文案不同；v-show 下按可见性过滤）。 */
  saveButton(text: string): Locator {
    return this.modal.locator('button:visible').filter({ hasText: text })
  }

  async save(text: string): Promise<void> {
    await this.saveButton(text).first().click()
  }

  /** 插件行头（含插件显示名 <strong> 与 启用/禁用/配置 按钮的横向 flex）。 */
  pluginHeader(name: string): Locator {
    const presentation = pluginPresentation.get(name)
    const label = presentation?.label ?? name
    return this.modal.locator('strong').filter({ hasText: label })
      .locator('xpath=ancestor::*[contains(@class,"n-flex")][1]')
  }

  /** 插件启停按钮（当前状态的反向操作：已启用 → 「禁用」）。 */
  pluginToggleButton(name: string): Locator {
    return this.pluginHeader(name).locator('button').filter({ hasText: /^(禁用|启用)$/ })
  }

  async togglePlugin(name: string): Promise<void> {
    await this.pluginToggleButton(name).click()
  }

  async expandPluginConfig(name: string): Promise<void> {
    const header = this.pluginHeader(name)
    if ((await header.getByRole('button', { name: '收起' }).count()) === 0) {
      await header.getByRole('button', { name: '配置' }).click()
    }
    await expect(this.field('主代理阈值（%）')).toBeVisible({ timeout: uiTimeout(10_000) })
  }

  async savePluginConfig(name: string): Promise<void> {
    // 展开区内的「保存」按钮（非顶部的 启用/配置）。
    await this.pluginHeader(name)
      .locator('xpath=following-sibling::div[1]')
      .locator('button').filter({ hasText: '保存' }).click()
  }

  async expectToast(text: string): Promise<void> {
    await expect(this.page.getByText(text).first()).toBeVisible({ timeout: uiTimeout(10_000) })
  }

  // ── API 投影断言（保存回读回证）──────────────────────────────────

  async configField<T>(path: string): Promise<T> {
    const res = await this.page.request.get('/api/v1/config')
    const data = await res.json()
    return path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], data) as T
  }
}

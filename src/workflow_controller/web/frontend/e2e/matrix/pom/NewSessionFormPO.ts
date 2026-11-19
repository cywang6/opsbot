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

// 新建会话弹窗页面对象。选择器约定与 settings.spec.ts 一致：
// n-select 用 `.n-select` + label 文本过滤，开关用 `.n-switch`，
// 文本输入一律 placeholder 定位（不用位置序号）。
export class NewSessionFormPO {
  readonly modal: Locator
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    this.modal = page.getByRole('dialog')
  }

  private field(label: string): Locator {
    return this.modal.locator('.n-form-item').filter({ hasText: label })
  }

  async open(): Promise<void> {
    await this.page.locator('.project-row.active')
      .getByRole('button', { name: '新建会话', exact: true }).click()
    await expect(this.modal).toBeVisible({ timeout: uiTimeout(10_000) })
  }

  async selectRuntime(label: string): Promise<void> {
    await this.field('代理框架').locator('.n-select').click()
    await this.page.locator('.n-base-select-option').filter({ hasText: label }).first().click()
  }

  async toggleCpx(on: boolean): Promise<void> {
    await this.setSwitch('通过 cpx 捕获', on)
  }

  async toggleReviewer(on: boolean): Promise<void> {
    await this.openAdvanced()
    await this.setSwitch('启用 Reviewer', on)
  }

  async selectEvaluator(type: string): Promise<void> {
    await this.openAdvanced()
    await this.field('评估器').locator('.n-select').click()
    await this.page.locator('.n-base-select-option').filter({ hasText: type }).first().click()
  }

  async setMaxIterations(value: number): Promise<void> {
    await this.openAdvanced()
    await this.field('最大迭代').locator('input').fill(String(value))
  }

  async fillPrompt(text: string): Promise<void> {
    await this.modal.getByPlaceholder('默认为 workflow-controller.yaml 中的 starting_prompt').fill(text)
  }

  async fillReviewerGoal(text: string): Promise<void> {
    await this.openAdvanced()
    await this.modal.getByPlaceholder('feedback 评估器判完成的依据').fill(text)
  }

  async fillGraphYaml(path: string): Promise<void> {
    await this.modal.getByPlaceholder('graph yaml 文件路径，留空 = 普通会话').fill(path)
  }

  async submit(): Promise<void> {
    const submit = this.modal.getByRole('button', { name: /启动会话|启动工作流/ })
    // 提交按钮受 authReady（存在可用 Provider）门控：provider 状态经 SSE
    // 异步到达，等按钮可用再点击，避免点击被吞导致弹窗滞留。
    await expect(submit).toBeEnabled({ timeout: uiTimeout(10_000) })
    await submit.click()
    await expect(this.modal).toBeHidden({ timeout: uiTimeout(10_000) })
  }

  private async openAdvanced(): Promise<void> {
    const header = this.modal.getByText('高级设置')
    // 折叠区展开后「启用 Reviewer」开关可见；已展开时点击会收起，先探测。
    if ((await this.field('启用 Reviewer').count()) === 0) {
      await header.click()
    }
    await expect(this.field('启用 Reviewer')).toBeVisible()
  }

  private async setSwitch(label: string, on: boolean): Promise<void> {
    const sw = this.field(label).locator('.n-switch')
    const isOn = await sw.locator('.n-switch--active').count()
    if ((on && isOn === 0) || (!on && isOn > 0)) {
      await sw.click()
    }
  }
}

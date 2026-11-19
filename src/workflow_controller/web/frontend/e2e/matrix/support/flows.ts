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

import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect } from '../../fixtures'
import { NewSessionFormPO } from '../pom/NewSessionFormPO'
import { RunViewPO } from '../pom/RunViewPO'
import { SessionDetailPO } from '../pom/SessionDetailPO'
import { scenarioPrompt, type MatrixProject } from './env'

// 矩阵层公共启动流：新建会话弹窗 → 组合配置 → 提交 → 跳转断言。
// 与 POM 分开放置（POM 反向依赖 support/env 的 uiTimeout，避免环）。

/** 等侧栏呈现目标项目行（SSE config_update 回推的 project_dir）。
 * 切换项目的请求在服务端即时生效，但前端 projectDir 走 SSE 异步
 * 回推——不等待的话，弹窗的 project-config 会读到上一个项目的配置
 * （runtime/evaluator/max_iterations 全部错位）。 */
async function awaitProjectShown(page: Page, project: MatrixProject): Promise<void> {
  await page.goto('/')
  await expect(page.locator(`.project-row.active[title="${project.dir}"]`))
    .toBeVisible({ timeout: 15_000 })
}

export interface StartSessionOptions {
  /** 默认跟随全局配置（矩阵 boot 的 reviewer 默认启用）。显式 false 关闭
   * （MX-11 等控制面用例需要无 reviewer 干预的普通输入路径）。 */
  reviewer?: boolean
  cpx?: boolean
  maxIterations?: number
  /** 默认 feedback（与 E1/E2 既有显式选择一致）。 */
  evaluator?: string
  /** runtime（默认 'Claude CLI'；opencode/codex 用例传对应 runtime 值）。 */
  runtime?: string
}

/** 经新建会话弹窗启动普通会话（Claude CLI + feedback 评估器为默认组合）。 */
export async function startSession(
  page: Page,
  scenario: string,
  options: StartSessionOptions & { project?: MatrixProject } = {},
): Promise<SessionDetailPO> {
  const { project, ...formOptions } = options
  if (project) {
    await awaitProjectShown(page, project)
  } else {
    await page.goto('/')
  }
  const form = new NewSessionFormPO(page)
  await form.open()
  const runtimeLabel = formOptions.runtime === 'opencode'
    ? 'OpenCode'
    : formOptions.runtime === 'codex_cli'
      ? 'Codex CLI'
      : 'Claude CLI'
  await form.selectRuntime(runtimeLabel)
  await form.selectEvaluator(formOptions.evaluator ?? 'feedback')
  if (formOptions.reviewer !== undefined) await form.toggleReviewer(formOptions.reviewer)
  if (formOptions.cpx) await form.toggleCpx(true)
  if (formOptions.maxIterations !== undefined) await form.setMaxIterations(formOptions.maxIterations)
  await form.fillPrompt(scenarioPrompt(scenario))
  await form.submit()
  const detail = new SessionDetailPO(page)
  await detail.awaitNavigated()
  return detail
}

/** 经新建会话弹窗启动 graph run（项目需经 createProject({graph: …}) 备好
 * yaml），跳转 /run/:run_id 后返回 RunViewPO。组合与 E3 一致（cpx +
 * reviewer + feedback）。maxIterations 经表单下发（run params 优先级高于
 * 节点 yaml 的 max_iterations——engine `opts or node` 口径），长跑道模板
 * 必须显式放宽（默认 3 轮窗口太短）。 */
export async function startGraphRun(
  page: Page,
  project: MatrixProject,
  options: { cpx?: boolean; reviewer?: boolean; maxIterations?: number } = {},
): Promise<RunViewPO> {
  await awaitProjectShown(page, project)
  const form = new NewSessionFormPO(page)
  await form.open()
  await form.selectRuntime('Claude CLI')
  await form.selectEvaluator('feedback')
  if (options.maxIterations !== undefined) await form.setMaxIterations(options.maxIterations)
  if (options.reviewer !== false) await form.toggleReviewer(true)
  if (options.cpx !== false) await form.toggleCpx(true)
  await form.fillGraphYaml(path.join(project.dir, 'graph-rollback.yaml'))
  await form.submit()
  const runView = new RunViewPO(page)
  await runView.awaitNavigated()
  return runView
}

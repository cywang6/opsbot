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
import { createProject, IS_LIVE, switchProject } from './support/env'
import { startSession } from './support/flows'

// 特性矩阵 e2e · 会话主链路域（设计文档 docs/designs/workflow-controller-e2e-feature-matrix.md
// §2.4 / workflow-controller-e2e-testcase-development.md §8.8 按域拆分）：
// E1–E2 / X1–X2 全部 claude_cli runtime、模型无关（CLI shim 不校验模型；
// provider 是 boot 脚本种的假密钥，仅满足「密钥就绪」门禁）。
// 公共骨架：建项目 → 切目录 → 开弹窗 → 组合配置 → 启动 → 详情页断言。
//
// E2E_LIVE=1 时服务端是 live 环境（无 shim），场景哨兵 prompt 无从应答，
// 整文件跳过，由 claude-live.spec.ts 接管同一矩阵。
test.skip(IS_LIVE, 'E2E_LIVE=1 时为 live 环境（无 shim），shim 矩阵用例不运行')

test('E1 claude_cli 基线：无 reviewer/cpx，feedback 评估器一轮完成', async ({ page }) => {
  const project = await createProject('e1-baseline')
  await switchProject(page, project.dir)

  const detail = await startSession(page, 'pass-first', { project })
  // 头部元信息增补断言（顶替已删除的 SD-01）：状态/迭代/统计卡（耗时、
  // 创建时间）四项可见，证明 SessionInfo 投影真实到达 UI。
  await detail.expectStatus('已完成')
  await detail.expectIterations(1, 3)
  await detail.expectHeaderMeta()
})

test('E2 claude_cli reviewer+cpx：反馈回路两轮收敛', async ({ page }) => {
  const project = await createProject('e2-reviewer-cpx')
  await switchProject(page, project.dir)

  const detail = await startSession(page, 'review-then-pass', { project, reviewer: true, cpx: true })
  // 第 1 轮 shim 回复带 [E2E:INCOMPLETE]，评估器判未完成并把反馈传给
  // 下一轮，第 2 轮补齐后完成——迭代推进到 2 证明反馈回路真实跑过。
  await detail.expectIterations(2, 3)
  await detail.expectStatus('已完成')
})

test('X1 claude_cli passthrough：不判完成，跑满最大迭代', async ({ page }) => {
  const project = await createProject('x1-passthrough')
  await switchProject(page, project.dir)

  const detail = await startSession(page, 'max-iter-never', {
    project, evaluator: 'passthrough', maxIterations: 3,
  })

  await detail.expectIterations(3, 3)
  // MAX_ITERATIONS 坍缩为 COMPLETED（final_loop_status 保留真实原因）。
  await detail.expectStatus('已完成')
})

test('X2 claude_cli 自动回复转人工：等待时切到手动，收到回复后恢复自动', async ({ page }, testInfo) => {
  const project = await createProject('x2-ask-human')
  await switchProject(page, project.dir)

  const detail = await startSession(page, 'ask-human', { project, reviewer: true })

  const banner = page.getByText('自动回复出错，请手动回复。', { exact: true })
  await expect(banner).toBeVisible()
  await expect(page.getByRole('button', { name: '回复: 手动' })).toBeDisabled()
  await expect(page.getByPlaceholder('回答模型问题...')).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('reply-fallback-manual.png'), animations: 'disabled' })

  await detail.sendManualMessage('选择方案 A，继续执行 E2E 测试')
  await expect(page.getByRole('button', { name: '回复: 自动' })).toBeVisible()
  await expect(banner).toBeHidden()
  await detail.expectStatus('已完成')
  await page.screenshot({ path: testInfo.outputPath('reply-fallback-auto.png'), animations: 'disabled' })
})

// 控制面四件套（MX-11/12）、Run 域（E3 等）、交接域（E4 等）、Dashboard/
// Settings/检查点域见同目录其他 spec；SD-13（send 失败回填）与 SD-16
// （会话未找到）为 mock 层用例（../session-detail.spec.ts），矩阵层无增量。

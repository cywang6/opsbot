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

import { test } from '../fixtures'
import { NewSessionFormPO } from './pom/NewSessionFormPO'
import { RunViewPO } from './pom/RunViewPO'
import { SessionDetailPO } from './pom/SessionDetailPO'
import { createProject, IS_LIVE, switchProject } from './support/env'
import { cpxAvailable, expectEvaluatorRan, expectReviewerDecided, requireProviders } from './support/live'

// live 冒烟：E2E_LIVE=1 时与 shim 矩阵互换，同一特性组合、真模型小任务。
// 只断言结构性结果——会话终态、评估/review 决策事件存在、交接链形成；
// 不断言内容与轮次（LX1 的 3/3 迭代属 loop 结构属性，保留）。无可用
// Provider / 缺 cpx 的组合 skip 并在报告列出原因。
//
// 与 shim 矩阵的两个真模型行为差异（live 实测所得）：
// 1. reviewer 开启时 review_stage 的 stop hook 会自动应答自然语言提问，
//    「等待输入」只在 reviewer 关闭时成立 → LX2 live 关 reviewer；
// 2. reviewer 开启走 reviewer_let_exit 完成、无 log_eval；reviewer 关闭走
//    feedback 评估器、有 log_eval → 结构断言按路径各取判定事件。
test.skip(!IS_LIVE, 'live 冒烟需 E2E_LIVE=1 显式开启（默认跑 shim 矩阵）')

// 失败用例的会话不会随测试结束而停，会拖慢后续用例并空耗真实 API——
// 每条用例结束后无条件清场。
test.afterEach(async ({ page }) => {
  await page.request.post('/api/v1/sessions/stop-all')
})

test('L1 live 基线：claude_cli + feedback 评估器，真模型小任务完成', async ({ page }) => {
  await requireProviders(page, false)
  const project = await createProject('live-e1-baseline')
  await switchProject(page, project.dir)
  await page.goto('/')

  const form = new NewSessionFormPO(page)
  await form.open()
  await form.selectRuntime('Claude CLI')
  await form.selectEvaluator('feedback')
  await form.fillPrompt(
    '在当前目录创建文件 live-e1.txt，内容为一行文本 e2e live ok，'
    + '完成后回复 DONE。不要向用户提问。',
  )
  await form.submit()

  const detail = new SessionDetailPO(page)
  await detail.awaitNavigated()
  await detail.expectStatus('已完成')
  await expectEvaluatorRan(page, detail.sessionId())
})

test('L2 live reviewer+cpx：reviewer 决策真实跑过并收敛到完成', async ({ page }) => {
  test.skip(!cpxAvailable(), 'live：cpx 不在 PATH，跳过 cpx 组合')
  await requireProviders(page, true)
  test.setTimeout(900_000)
  const project = await createProject('live-e2-reviewer-cpx')
  await switchProject(page, project.dir)
  await page.goto('/')

  const form = new NewSessionFormPO(page)
  await form.open()
  await form.selectRuntime('Claude CLI')
  await form.toggleCpx(true)
  await form.toggleReviewer(true)
  await form.selectEvaluator('feedback')
  await form.fillReviewerGoal('当前目录存在 live-e2.txt 且内容为 e2e live reviewer ok 即视为完成。')
  await form.fillPrompt(
    '在当前目录创建文件 live-e2.txt，内容为一行文本 e2e live reviewer ok，'
    + '完成后回复 DONE。不要向用户提问。',
  )
  await form.submit()

  const detail = new SessionDetailPO(page)
  await detail.awaitNavigated()
  await detail.expectStatus('已完成')
  await expectReviewerDecided(page, detail.sessionId())
})

test('L3 live 工作流回滚：真模型驱动 graph 节点跑到 run 终态', async ({ page }) => {
  test.skip(!cpxAvailable(), 'live：cpx 不在 PATH，跳过 cpx 组合')
  await requireProviders(page, true)
  // graph 编排轮次多（init + worker-a 多次尝试/回滚 + final），单测放宽。
  test.setTimeout(900_000)
  const project = await createProject('live-e3-rollback', { graph: 'live' })
  await switchProject(page, project.dir)
  await page.goto('/')

  const form = new NewSessionFormPO(page)
  await form.open()
  await form.selectRuntime('Claude CLI')
  await form.toggleCpx(true)
  await form.toggleReviewer(true)
  await form.selectEvaluator('feedback')
  await form.fillGraphYaml(`${project.dir}/graph-rollback.yaml`)
  await form.submit()

  // 回滚是否发生取决于模型行为（编号递增指令），冒烟只断言 run 收敛到终态。
  const runView = new RunViewPO(page)
  await runView.awaitNavigated()
  await runView.expectDagPanelVisible('e2e-rollback')
  await runView.expectCompleted()
})

test('L4 live 强制交接：handoff agent 产文档后接续 worker 完成', async ({ page }) => {
  await requireProviders(page, true)
  // 真模型单轮 2–5 分钟：交接要等当前轮收尾，接续还要 1–2 轮，预算 40 分钟。
  test.setTimeout(2_400_000)
  const project = await createProject('live-e4-handoff', { handoff: true })
  await switchProject(page, project.dir)
  await page.goto('/')

  const form = new NewSessionFormPO(page)
  await form.open()
  await form.selectRuntime('Claude CLI')
  await form.toggleReviewer(true)
  await form.selectEvaluator('feedback')
  await form.fillReviewerGoal('当前目录存在 step-1.txt 与 step-2.txt 共 2 个文件即视为完成。')
  await form.setMaxIterations(30)
  await form.fillPrompt(
    '依次创建 step-1.txt 和 step-2.txt 共 2 个文件（内容为文件名即可）。'
    + '每轮迭代只创建下一个文件，本轮创建完后即停止并简述进度，不要一口气做完，'
    + '也不要向用户提问；全部创建完成后回复 DONE。',
  )
  await form.submit()

  const detail = new SessionDetailPO(page)
  await detail.awaitNavigated()
  await detail.expectStatus('运行中')

  await detail.openHandoffTab()
  await detail.forceHandoff()

  // 边界处停旧 worker / 交接 / 接续都要等真模型当前轮收尾（单轮可达
  // 分钟级），PO 默认超时不够，逐步显式放宽到 900s。
  await detail.expectStatus('空闲', 900_000)
  await detail.expectLastHandoffSucceeded(900_000)
  await detail.openHandoffChain()
  await detail.expectStatus('已完成', 900_000)
})

test('LX1 live passthrough：不判完成，跑满最大迭代', async ({ page }) => {
  await requireProviders(page, false)
  const project = await createProject('live-x1-passthrough')
  await switchProject(page, project.dir)
  await page.goto('/')

  const form = new NewSessionFormPO(page)
  await form.open()
  await form.selectRuntime('Claude CLI')
  await form.selectEvaluator('passthrough')
  await form.setMaxIterations(3)
  await form.fillPrompt('每轮回复一句当前进度说明即可（不要向用户提问，回复中不要出现问号），不要创建任何文件。')
  await form.submit()

  const detail = new SessionDetailPO(page)
  await detail.awaitNavigated()
  await detail.expectIterations(3, 3)
  // MAX_ITERATIONS 坍缩为 COMPLETED（与 shim X1 同语义）。
  await detail.expectStatus('已完成')
})

test('LX2 live 人工回复：问句停等后注入消息恢复', async ({ page }) => {
  // reviewer 关闭：reviewer 的 stop hook 会自动应答自然语言提问（实测），
  // 人工回复路径只在无 reviewer 时成立。
  await requireProviders(page, false)
  test.setTimeout(900_000)
  const project = await createProject('live-x2-ask-human')
  await switchProject(page, project.dir)
  await page.goto('/')

  const form = new NewSessionFormPO(page)
  await form.open()
  await form.selectRuntime('Claude CLI')
  await form.toggleReviewer(false)
  await form.selectEvaluator('feedback')
  await form.fillPrompt(
    '任务：在当前目录创建文件 live-x2.txt，内容为一行文本 e2e live x2 ok。\n'
    + '但第一步必须先向用户确认一个问题：live-x2.txt 的内容使用中文还是英文？\n'
    + '本轮不要使用任何工具，回复必须是纯文本且以问号结尾，然后等待用户回答。\n'
    + '得到用户回答后，按用户选择的语言创建 live-x2.txt 并回复 DONE。',
  )
  await form.submit()

  const detail = new SessionDetailPO(page)
  await detail.awaitNavigated()
  await detail.expectWaitingForInput()
  await detail.sendManualMessage('用中文，内容写 e2e live x2 ok')
  await detail.expectStatus('已完成')
})

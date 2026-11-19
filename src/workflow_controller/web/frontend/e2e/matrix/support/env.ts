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

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { expect, type Page } from '../../fixtures'

// 矩阵层环境助手：与 boot-server.sh 共享 MATRIX_ROOT 约定，为每条用例
// 准备独立的临时项目目录（workflow-controller.yaml / graph 模板 / 交接模板 / agent）。
// 项目目录即 shim 回合状态的定位载体（.workflow-controller-e2e/），用例间天然隔离。
export const MATRIX_ROOT = process.env.WORKFLOW_CONTROLLER_E2E_MATRIX_ROOT
  || `${homedir()}/.workflow-controller-e2e-matrix`
const FIXTURES_DIR = fileURLToPath(new URL('../fixtures', import.meta.url))

// live 冒烟模式（E2E_LIVE=1）：服务端无 shim、直连真实 Provider，与 shim 矩阵互斥。
export const IS_LIVE = process.env.E2E_LIVE === '1'

// live 下真模型一轮可达分钟级，UI 断言超时在 shim 基数上 ×10。
export function uiTimeout(ms: number): number {
  return IS_LIVE ? ms * 10 : ms
}

export interface MatrixProject {
  dir: string
  name: string
}

export interface ProjectOptions {
  /** 拷入 graph 模板并带 agents 目录：true/'live'=回滚（E3），'longrun'=长跑道，'subgraph'=子图+验收（MX-07） */
  graph?: boolean | 'live' | 'longrun' | 'subgraph'
  /** 拷入 handoff/continuation 模板并在 workflow-controller.yaml 注册（E4） */
  handoff?: boolean
  /** workflow-controller.yaml loop.max_iterations（默认 3；handoff-keep-running 等长跑道用） */
  maxIterations?: number
  /** 项目 runtime（默认 claude_cli；O 系列用例选 opencode） */
  runtime?: string
}

// live 项目缺省 Reviewer 目标。全局默认 goal（config/bootstrap.py）语义是
// 「永远继续推进、禁止收尾」——真模型评估器会照办，把冒烟会话拖满迭代上限；
// shim 评估器只认 [E2E:DONE] 标记所以矩阵层无感。live 必须换成收敛导向。
const LIVE_DEFAULT_GOAL = '按提示词完成指定的文件创建/修改并回复 DONE 即视为完成，不需要扩展任务范围。'

// recent-dirs 拒绝系统临时区。保留临时矩阵根下的 daemon 和配置，仅把项目
// 夹具放到持久目录；按规范化矩阵根分隔并行运行。
async function projectsRoot(): Promise<string> {
  const root = await realpath(MATRIX_ROOT)
  const transientRoots = await Promise.all(
    [tmpdir(), '/tmp', '/var/tmp'].map(dir => realpath(dir).catch(() => dir)),
  )
  if (transientRoots.some(dir => root === dir || root.startsWith(dir + path.sep))) {
    const namespace = createHash('sha256').update(root).digest('hex').slice(0, 16)
    return path.join(homedir(), '.workflow-controller-e2e-matrix-persistent', namespace)
  }
  return path.join(root, 'projects')
}

export async function createProject(
  caseName: string,
  options: ProjectOptions = {},
): Promise<MatrixProject> {
  const dir = path.join(await projectsRoot(), caseName)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  const yamlLines = [
    `runtime: ${options.runtime ?? 'claude_cli'}`,
    'loop:',
    `  max_iterations: ${options.maxIterations ?? 3}`,
  ]
  if (IS_LIVE) {
    // 表单不总会提交 reviewer_task_goal，后端回落链会落到反收敛的全局默认
    // goal（见 LIVE_DEFAULT_GOAL），live 项目必须显式覆写；JSON 字符串是
    // 合法 YAML 双引号标量，goal 含「: + 空格」/「#」时不会破坏 yaml 结构。
    yamlLines.push('reviewer:', `  task_goal: ${JSON.stringify(LIVE_DEFAULT_GOAL)}`)
  }
  if (options.handoff) {
    yamlLines.push(
      'handoff_prompt_path: ./e2e-handoff-prompt.md',
      'continuation_prompt_path: ./e2e-continuation-prompt.md',
    )
  }
  await writeFile(path.join(dir, 'workflow-controller.yaml'), `${yamlLines.join('\n')}\n`)

  if (options.graph) {
    await mkdir(path.join(dir, 'agents'), { recursive: true })
    const graphFixture = options.graph === 'live'
      ? 'graph-rollback-live.yaml'
      : options.graph === 'longrun'
        ? 'graph-longrun.yaml'
        : options.graph === 'subgraph'
          ? 'graph-subgraph.yaml'
          : 'graph-rollback.yaml'
    await copyFile(
      path.join(FIXTURES_DIR, graphFixture),
      path.join(dir, 'graph-rollback.yaml'),
    )
    await copyFile(
      path.join(FIXTURES_DIR, 'agents/e2e-worker.md'),
      path.join(dir, 'agents/e2e-worker.md'),
    )
    if (options.graph === 'subgraph') {
      await copyFile(
        path.join(FIXTURES_DIR, 'graph-subgraph-child.yaml'),
        path.join(dir, 'e2e-subgraph.yaml'),
      )
      await copyFile(
        path.join(FIXTURES_DIR, 'agents/e2e-verifier.md'),
        path.join(dir, 'agents/e2e-verifier.md'),
      )
    }
  }
  if (options.handoff) {
    await copyFile(
      path.join(FIXTURES_DIR, 'handoff-prompt.md'),
      path.join(dir, 'e2e-handoff-prompt.md'),
    )
    await copyFile(
      path.join(FIXTURES_DIR, 'continuation-prompt.md'),
      path.join(dir, 'e2e-continuation-prompt.md'),
    )
  }
  return { dir: await realpath(dir), name: caseName }
}

/** 将目录加入侧栏并切为当前项目（arrange 步骤；act/assert 全部走 UI）。 */
export async function switchProject(page: Page, dir: string): Promise<void> {
  const added = await page.request.post('/api/v1/recent-dirs', { data: { dir } })
  expect(added.ok()).toBeTruthy()
  expect((await added.json()).error).toBeUndefined()
  const response = await page.request.post('/api/v1/config/load-from-dir', { data: { dir } })
  expect(response.ok()).toBeTruthy()
}

/** worker 场景 prompt：shim 按 E2E-SCENARIO 标记选择回合脚本。 */
export function scenarioPrompt(scenario: string): string {
  return `E2E-SCENARIO:${scenario} 请完成本用例定义的任务。`
}

/** 读取 shim 落盘的回合状态（<project.dir>/.workflow-controller-e2e/state.json），
 * 供用例回读断言 shim 侧可观测事实（如 O2 的 resume 收到 --session）。文件由
 * shim 子进程异步写入，读不到时返回空对象，配合 expect.poll 等终态。 */
export async function readShimState(projectDir: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path.join(projectDir, '.workflow-controller-e2e', 'state.json'), 'utf8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

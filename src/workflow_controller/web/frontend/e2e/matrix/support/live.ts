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

import { execSync } from 'node:child_process'
import { expect, test, type Page } from '../../fixtures'
import { uiTimeout } from './env'

// live 冒烟支撑：Provider 前置探测与结构性断言助手。探测会打真实 API
// （等价 Settings 页「重测」），一次运行只做一遍，结果缓存到模块级
// promise，各用例共享。

interface ProviderInfo {
  index: number
  status: string
  runtime: string
  worker_validation?: { status?: string }
  reviewer_validation?: { status?: string }
}

export interface LiveProviders {
  worker: ProviderInfo[]
  reviewer: ProviderInfo[]
}

// 与表单 workerModelOptions 的禁用规则同构（runtime 匹配 + 未耗尽 + 未判
// 失效）；/auth/status 的 runtime 字段已是 effective 值（含全局默认值）。
function structurallyUsable(p: ProviderInfo): boolean {
  return (
    (p.status === 'unused' || p.status === 'active') &&
    p.runtime === 'claude_cli' &&
    (p.worker_validation?.status || '') !== 'invalid'
  )
}

function validatedUsable(p: ProviderInfo, capability: 'worker' | 'reviewer'): boolean {
  const validation = capability === 'worker' ? p.worker_validation : p.reviewer_validation
  // worker 能力额外要求 runtime 匹配（/auth/status 的 runtime 已是 effective
  // 值）；reviewer 走 anthropic_http，与 runtime 绑定无关。
  const runtimeOk = capability === 'reviewer' || p.runtime === 'claude_cli'
  return (
    runtimeOk &&
    (p.status === 'unused' || p.status === 'active') &&
    (validation?.status || '') === 'valid'
  )
}

async function fetchProviders(page: Page): Promise<ProviderInfo[]> {
  const response = await page.request.get('/api/v1/auth/status')
  const status = await response.json()
  return status.providers || []
}

async function probeProviders(page: Page): Promise<LiveProviders> {
  let providers = await fetchProviders(page)
  // 结构可用但从未实测过的 provider 逐个「重测」：死 key 在此判 invalid，
  // 表单自动选型随之跳过它，避免冒烟被环境里的陈旧密钥误红。
  for (const p of providers) {
    if (!structurallyUsable(p)) continue
    if ((p.worker_validation?.status || 'untested') !== 'valid') {
      await page.request.post(`/api/v1/auth/keys/${p.index}/test`)
    }
  }
  providers = await fetchProviders(page)
  return {
    worker: providers.filter((p) => validatedUsable(p, 'worker')),
    reviewer: providers.filter((p) => validatedUsable(p, 'reviewer')),
  }
}

let probed: Promise<LiveProviders> | null = null

export function liveProviders(page: Page): Promise<LiveProviders> {
  probed ??= probeProviders(page)
  return probed
}

/** 缺少可用 Provider 的组合 skip 并在报告列出原因（Worker / Reviewer 分别判定）。 */
export async function requireProviders(
  page: Page,
  needsReviewer: boolean,
): Promise<void> {
  const providers = await liveProviders(page)
  test.skip(providers.worker.length === 0, 'live：无可用 claude_cli Worker Provider')
  if (needsReviewer) {
    test.skip(providers.reviewer.length === 0, 'live：无可用 Reviewer Provider')
  }
}

/** cpx 组合（L2/L3）依赖 cpx CLI 在被测进程同一 PATH 上。 */
export function cpxAvailable(): boolean {
  try {
    execSync('command -v cpx', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

interface SessionEvent {
  event_type?: string
  data?: { hook?: string }
}

/** 轮询会话事件流直到出现匹配事件（判定事件由后台异步落库）。 */
async function expectSessionEvent(
  page: Page,
  sessionId: string,
  matches: (event: SessionEvent) => boolean,
): Promise<void> {
  await expect.poll(async () => {
    const response = await page.request.get(
      `/api/v1/events?session_id=${encodeURIComponent(sessionId)}`,
    )
    if (!response.ok()) return false
    const { events } = await response.json()
    return (events || []).some(matches)
  }, { timeout: uiTimeout(60_000), intervals: [2_000] }).toBe(true)
}

/** 评估器真实跑过的结构性证据：事件流出现 log_eval（reviewer 关闭的 feedback 路径）。 */
export async function expectEvaluatorRan(page: Page, sessionId: string): Promise<void> {
  await expectSessionEvent(page, sessionId, (e) => e.event_type === 'log_eval')
}

/** reviewer 真实跑过的结构性证据：stop hook 的 LLM 决策事件。实测 reviewer
 *  开启时走 review_stage 门控完成、不产生 log_eval——两条完成路径的判定事件不同。 */
export async function expectReviewerDecided(page: Page, sessionId: string): Promise<void> {
  await expectSessionEvent(
    page,
    sessionId,
    (e) => e.event_type === 'log_auto' && e.data?.hook === 'stop_hook_llm',
  )
}

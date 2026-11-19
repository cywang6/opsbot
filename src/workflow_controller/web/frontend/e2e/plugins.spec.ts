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

import { expect, test } from './fixtures'
import { mockSessionDeps, sessionPayload, sseBody } from './support/mock-session'

test('enabled plugin manifests expose their Session panels', async ({ page }) => {
  const session = {
    id: 'e2e-plugin-session', name: 'Plugin session', role: 'worker', state: 'idle',
    loop_status: 'no', stop_reason: null, loop_hold: null, current_iteration: 1,
    max_iterations: 3, progress: 0, elapsed_seconds: 1, created_at_iso: '2026-10-22T00:00:00Z',
    error: null, last_activity: [], birth_handoff_doc: null, result: null,
    predecessor: null, successors: [], sdk_session_id: 'sdk-plugin', project_dir: '/tmp/e2e', run_id: null,
  }
  await page.route('**/api/v1/sessions/e2e-plugin-session', async (route) => {
    await route.fulfill({ json: session })
  })
  await page.route('**/api/v1/config', async (route) => {
    await route.fulfill({ json: { reviewer: { enabled: false, mode: 'auto' } } })
  })
  await page.route('**/api/v1/plugins', async (route) => {
    await route.fulfill({ json: { plugins: [
      { name: 'agent_traceback', enabled: true, manifest: [], version: '1.0.0' },
      { name: 'file_provenance', enabled: true, manifest: [], version: '1.0.0' },
    ] } })
  })
  await page.route('**/api/v1/events?*', async (route) => {
    await route.fulfill({ json: { events: [] } })
  })
  await page.route('**/api/breather/state?*', async (route) => {
    await route.fulfill({ json: {} })
  })
  await page.route('**/api/v1/plugins/breather/config', async (route) => {
    await route.fulfill({ json: { enabled: false } })
  })
  await page.route('**/api/v1/sessions/e2e-plugin-session/**', async (route) => {
    await route.fulfill({ json: { hints: {}, agents: [], instructions: [] } })
  })

  await page.goto('/session/e2e-plugin-session', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Plugin session')).toBeVisible()
  await expect(page.getByText('检查点', { exact: true })).toBeVisible()
  await expect(page.getByText('文件归因', { exact: true })).toBeVisible()
  await page.getByText('检查点', { exact: true }).click()
  await expect(page.getByText(/无检查点/)).toBeVisible()
  await page.getByText('文件归因', { exact: true }).click()
  await expect(page.getByRole('heading', { name: '文件归因' })).toBeVisible()
})

test('enabled Breather plugin exposes the handoff tab', async ({ page }) => {
  const session = {
    id: 'e2e-breather-session', name: 'Breather session', role: 'worker', state: 'idle',
    loop_status: 'no', stop_reason: null, loop_hold: null, current_iteration: 1,
    max_iterations: 3, progress: 0, elapsed_seconds: 1, created_at_iso: '2026-10-22T00:00:00Z',
    error: null, last_activity: [], birth_handoff_doc: null, result: null,
    predecessor: null, successors: [], sdk_session_id: 'sdk-breather', project_dir: '/tmp/e2e', run_id: null,
  }
  await page.route('**/api/v1/sessions/e2e-breather-session', async (route) => {
    await route.fulfill({ json: session })
  })
  await page.route('**/api/v1/config', async (route) => {
    await route.fulfill({ json: { reviewer: { enabled: false, mode: 'auto' } } })
  })
  await page.route('**/api/v1/plugins', async (route) => {
    await route.fulfill({ json: { plugins: [{ name: 'breather', enabled: true, manifest: [], version: '1.0.0' }] } })
  })
  await page.route('**/api/v1/events?*', async (route) => {
    await route.fulfill({ json: { events: [] } })
  })
  await page.route('**/api/breather/state?*', async (route) => {
    await route.fulfill({ json: { force_pending: false, stop_armed: false, pending_session_id: null } })
  })
  await page.route('**/api/v1/plugins/breather/config', async (route) => {
    await route.fulfill({ json: { enabled: true, fields: { context_threshold_pct: 70, context_window: 200000 } } })
  })
  await page.route('**/api/v1/sessions/e2e-breather-session/**', async (route) => {
    await route.fulfill({ json: { hints: {}, agents: [], instructions: [] } })
  })

  await page.goto('/session/e2e-breather-session', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Breather session')).toBeVisible()
  await expect(page.getByText('会话交接', { exact: true })).toBeVisible()
})

test('file provenance panel renders metrics, per-line sources, capture evidence, and audit export', async ({ page }) => {
  // PL-02（②形态：真实归因需 git 仓库 + 提交历史构造，成本高；面板 API 形状见
  // plugins/file_provenance/web_api.py + 前端 plugins/file_provenance/api.ts）
  const sid = 'e2e-pl-provenance'
  const session = sessionPayload({ id: sid, name: 'Provenance session', project_dir: '/tmp/e2e-prov' })
  await mockSessionDeps(page, session, {
    plugins: [{ name: 'file_provenance', enabled: true, manifest: [], version: '1.0.0' }],
  })
  await page.route('**/api/provenance/commits*', async (route) => {
    await route.fulfill({ json: { commits: [{
      commit_sha: 'abc123def4567890', ai_lines: 40, total_added_lines: 50, generated_lines: 40, accepted_lines: 30,
    }] } })
  })
  await page.route('**/api/provenance/files*', async (route) => {
    await route.fulfill({ json: { files: ['src/demo.py'] } })
  })
  await page.route('**/api/provenance/metrics*', async (route) => {
    await route.fulfill({ json: {
      commit_sha: '', ai_lines: 40, total_added_lines: 50,
      generated_lines: 45, accepted_lines: 36, ai_share: 0.8, acceptance_rate: 0.75,
    } })
  })
  await page.route('**/api/provenance/blame*', async (route) => {
    await route.fulfill({ json: { content_hash: 'hash-1', lines: [
      { line_no: 1, content: 'def main():', actor_kind: 'agent', capture_id: 'cap-1', session_id: sid, runtime: 'claude_cli', model: 'e2e-model', agent_name: 'worker' },
      { line_no: 2, content: '# 人工补充的注释', actor_kind: 'human' },
      { line_no: 3, content: 'pass', actor_kind: 'unknown' },
    ] } })
  })
  // capture 详情与 before/after 快照同域：按路径后缀分流（/file 子路由）
  await page.route('**/api/provenance/captures/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/file')) {
      if (url.searchParams.get('stage') === 'before') {
        await route.fulfill({ status: 404, json: { detail: 'no snapshot' } })
        return
      }
      await route.fulfill({ json: {
        capture_id: 'cap-1', stage: 'after', path: 'src/demo.py', size: 24,
        binary: false, content: 'def main():\n    pass\n', attributions: [],
      } })
      return
    }
    await route.fulfill({ json: {
      capture_id: 'cap-1', session_id: sid, actor_kind: 'agent', runtime: 'claude_cli',
      model: 'e2e-model', agent_name: 'worker', native_session_id: null,
      parent_native_session_id: null, native_agent_id: null, tool_name: 'Edit',
      tool_use_id: 'tu-1', cwd: '/tmp/e2e-prov', started_at: '2026-11-05T10:00:00Z',
      finished_at: '2026-11-05T10:01:00Z', succeeded: true, is_error: false,
      conflicted: false, incomplete: false, tool_input: { file_path: 'src/demo.py' },
      tool_output: { ok: true }, attributes: {},
      head_before: 'b0000000000000000000000000000000000000000',
      head_after: 'a0000000000000000000000000000000000000000',
      committed_sha: null,
      mutations: [{ path: 'src/demo.py', additions: 3, deletions: 1, conflict: false }],
      snapshots: [], conflicts: [],
    } })
  })
  let auditRequested = false
  await page.route('**/api/provenance/sessions/*/audit-evidence*', async (route) => {
    auditRequested = true
    await route.fulfill({ json: { ok: true } })
  })

  await page.goto(`/session/${sid}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Provenance session')).toBeVisible()
  await page.getByText('文件归因', { exact: true }).click()

  // 指标卡：AI 行占比 / 接受率 / Agent 生成 / 最终采纳
  await expect(page.getByText('AI 行占比')).toBeVisible()
  await expect(page.getByText('80.0', { exact: true })).toBeVisible()
  await expect(page.getByText('接受率')).toBeVisible()
  await expect(page.getByText('75.0', { exact: true })).toBeVisible()
  await expect(page.getByText('Agent 生成')).toBeVisible()
  await expect(page.getByText('最终采纳')).toBeVisible()

  // 逐行归因表：agent / human / unknown 来源标签可区分
  await expect(page.locator('.n-data-table').getByText('agent', { exact: true })).toBeVisible()
  await expect(page.locator('.n-data-table').getByText('human', { exact: true })).toBeVisible()
  await expect(page.locator('.n-data-table').getByText('unknown', { exact: true })).toBeVisible()

  // 点行内「Capture 详情」→ 修改证据详情弹窗
  await page.getByRole('button', { name: 'Capture 详情' }).click()
  const evidenceModal = page.locator('.n-modal').filter({ hasText: '修改证据详情' })
  await expect(evidenceModal).toBeVisible()
  await expect(evidenceModal).toContainText('Edit')
  await expect(evidenceModal.getByText('成功', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(evidenceModal).toBeHidden()

  // 导出审计证据：按钮触发 audit-evidence 请求（attachment 不缓存）
  await page.getByRole('button', { name: '导出审计证据' }).click()
  await expect.poll(() => auditRequested).toBe(true)
})

test('breather tab renders pending handoff state and the last-handoff card across outcomes', async ({ page }) => {
  // PL-04（②形态：失败/执行中中间态回放；成功态真链路已由矩阵 E4 覆盖）。
  // 「最近一次交接」卡的数据源是 session_update 会话列表中的 handoff_agent 成员
  // （SessionDetailView.handoffAgentSession），非 handoff_update 事件。
  const sid = 'e2e-pl-breather'
  const main = sessionPayload({ id: sid, name: 'Breather state session', project_dir: '/tmp/e2e-breather' })
  const handoffAgent = (over: Record<string, unknown>) => sessionPayload({
    id: 'e2e-pl-handoff', name: 'Handoff agent session', role: 'handoff_agent',
    predecessor: { id: sid, name: 'Breather state session' },
    state: 'completed', result: 'success', stop_reason: null,
    ...over,
  })
  await mockSessionDeps(page, main, {
    plugins: [{ name: 'breather', enabled: true, manifest: [], version: '1.0.0' }],
    breatherState: { force_pending: true, stop_armed: false, pending_session_id: sid },
    breatherConfig: { enabled: true, fields: { context_threshold_pct: 70, context_window: 200000 } },
  })
  const mockStream = async (agent: Record<string, unknown>) => {
    await page.route('**/api/v1/events/stream', (route) => route.fulfill({
      contentType: 'text/event-stream',
      body: sseBody([['session_update', [main, handoffAgent(agent)]]]),
    }))
  }

  // 成功态：待交接（force_pending）+ 最近一次交接成功
  await mockStream({ state: 'completed', result: 'success' })
  await page.goto(`/session/${sid}`, { waitUntil: 'domcontentloaded' })
  await page.getByText('会话交接', { exact: true }).click()
  await expect(page.getByText('交接状态')).toBeVisible()
  await expect(page.getByText('待处理', { exact: true })).toBeVisible()
  await expect(page.getByText('最近一次交接')).toBeVisible()
  await expect(page.getByText('成功', { exact: true })).toBeVisible()

  // 失败态
  await mockStream({ state: 'completed', result: 'fail' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('会话交接', { exact: true }).click()
  await expect(page.getByText('最近一次交接')).toBeVisible()
  await expect(page.getByText('失败', { exact: true })).toBeVisible()

  // 执行中态：handoff_agent 运行中
  await mockStream({ state: 'running', result: null })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('会话交接', { exact: true }).click()
  await expect(page.getByText('交接执行中...')).toBeVisible()
  await expect(page.getByText('执行中', { exact: true })).toBeVisible()
})

test('staged pipeline tab renders the stage progress timeline', async ({ page }) => {
  // PL-05（②形态：staged 门禁依赖 hook 回调，shim 无 hook，阶段数据只能回放）。
  // 插件开关经 GET /plugins/staged_pipeline/config，阶段数据经 SSE pipeline_update。
  const sid = 'e2e-pl-pipe'
  const session = sessionPayload({ id: sid, name: 'Pipeline session' })
  await mockSessionDeps(page, session)
  await page.route('**/api/v1/plugins/staged_pipeline/config', async (route) => {
    await route.fulfill({ json: { enabled: true } })
  })
  await page.route('**/api/v1/events/stream', (route) => route.fulfill({
    contentType: 'text/event-stream',
    body: sseBody([
      ['session_update', []],
      ['pipeline_update', {
        [sid]: {
          stages: [
            { name: '代码实现', completed: true, active: false, progress: 1 },
            { name: '代码评审', completed: false, active: true, progress: 0.5 },
            { name: '验收测试', completed: false, active: false, progress: 0 },
          ],
          active_stage: '代码评审',
          total_progress: 0.5,
          detail: '阶段 2/3',
        },
      }],
    ]),
  }))

  await page.goto(`/session/${sid}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Pipeline session')).toBeVisible()
  await page.getByText('阶段验证', { exact: true }).click()

  // 阶段进度卡：n-timeline 按阶段状态渲染 + 总进度
  await expect(page.getByText('阶段进度')).toBeVisible()
  await expect(page.getByText('代码实现')).toBeVisible()
  await expect(page.getByText('代码评审')).toBeVisible()
  await expect(page.getByText('验收测试')).toBeVisible()
  await expect(page.getByText('已完成', { exact: true })).toBeVisible()
  await expect(page.getByText('进行中', { exact: true })).toBeVisible()
  await expect(page.getByText('待开始', { exact: true })).toBeVisible()
  await expect(page.getByText('50% · 阶段 2/3')).toBeVisible()
})

test('human claim conflict stays in the modal with a refresh instruction', async ({ page }) => {
  // PL-03（①故障注入：409 内容哈希冲突，提示刷新后重试且不关闭弹窗）
  const sid = 'e2e-pl-claim'
  await mockSessionDeps(page, sessionPayload({
    id: sid, name: 'Claim conflict session', project_dir: '/tmp/e2e-claim',
  }), {
    plugins: [{ name: 'file_provenance', enabled: true, manifest: [], version: '1.0.0' }],
  })
  await page.route('**/api/provenance/commits*', route =>
    route.fulfill({ json: { commits: [] } }))
  await page.route('**/api/provenance/files*', route =>
    route.fulfill({ json: { files: ['src/demo.py'] } }))
  await page.route('**/api/provenance/metrics*', route => route.fulfill({ json: {
    commit_sha: '', ai_lines: 0, total_added_lines: 1,
    generated_lines: 0, accepted_lines: 0, ai_share: 0, acceptance_rate: 0,
  } }))
  await page.route('**/api/provenance/blame*', route => route.fulfill({ json: {
    content_hash: 'stale-hash',
    lines: [{ line_no: 1, content: 'pass', actor_kind: 'unknown' }],
  } }))
  await page.route('**/api/provenance/claim-human', route => route.fulfill({
    status: 409, json: { detail: 'file provenance changed; refresh before claiming' },
  }))

  await page.goto(`/session/${sid}`, { waitUntil: 'domcontentloaded' })
  await page.getByText('文件归因', { exact: true }).click()
  await page.getByRole('button', { name: '认领', exact: true }).click()
  const modal = page.locator('.n-modal').filter({ hasText: '认领人工修改' })
  await expect(modal).toBeVisible()
  await modal.getByPlaceholder('Name <email@example.com>').fill('E2E User <e2e@example.com>')
  await modal.getByRole('button', { name: '确认认领' }).click()

  await expect(modal.getByText('file provenance changed; refresh before claiming'))
    .toBeVisible()
  await expect(modal).toBeVisible()
})

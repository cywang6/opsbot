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

/// <reference types="node" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { ref } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'

// 本文件不 mock utils/subagentLines：折叠块断言需要真实渲染路径。
// 现有 SessionDetailView.test.ts 将其 mock 为空实现，无法断言「点击展开」行。

enableAutoUnmount(afterEach)

const mockSessions = ref<any[]>([])
const mockEvents = ref<Record<string, any[]>>({})

vi.mock('../composables/useSSE', () => ({ useSSE: () => ({
  connected: ref(true), sessions: mockSessions, config: ref(null),
  eventsBySession: mockEvents, pipeline: ref({}), usage: ref(null),
  runStateEventCount: ref({}), subscribePlugin: vi.fn(),
}) }))
vi.mock('../composables/useSessions', () => ({ useSessions: () => ({
  pause: vi.fn(), resume: vi.fn(), handoff: vi.fn(), injectPrompt: vi.fn(),
  sendMessage: vi.fn(), getSubagentHints: vi.fn().mockResolvedValue({}),
  registerSubagentHint: vi.fn(), clearSubagentHint: vi.fn(),
  listSubagentAgents: vi.fn().mockResolvedValue([]),
  getSessionInstructions: vi.fn().mockResolvedValue([]),
  registerSessionInstruction: vi.fn(), clearSessionInstruction: vi.fn(),
  removeSession: vi.fn(),
}) }))
vi.mock('../composables/usePlugins', () => ({ usePlugins: () => ({
  plugins: ref([]), loaded: ref(true), loadPlugins: vi.fn(),
  pluginLoaded: vi.fn().mockReturnValue(false),
}) }))
vi.mock('../composables/useToast', () => ({ useToast: () => ({
  success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(),
}) }))
vi.mock('../composables/useConfirm', () => ({ useConfirm: () => ({
  confirmAction: vi.fn().mockResolvedValue(false),
}) }))
vi.mock('../composables/useTopology', () => ({ deriveTopology: vi.fn().mockReturnValue(null) }))
vi.mock('../plugins/agent_traceback/types', () => ({ birthTracebackOf: vi.fn().mockReturnValue(null) }))

function ev(n: number, iteration: number, type: string, data: any) {
  return {
    id: String(n), session_id: 'sess-1', iteration,
    timestamp: `2026-11-10T10:0${iteration}:0${n}`,
    event_type: type, data,
  }
}

function msg(text: string) {
  return { type: 'text', text }
}

async function mountWithEvents(events: any[]) {
  mockEvents.value = { 'sess-1': events }
  globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve({
    ok: true, json: vi.fn().mockResolvedValue({ events: [] }),
  } as any))
  mockSessions.value = [{
    id: 'sess-1', name: 's', role: 'worker', state: 'idle', loop_status: 'no',
    stop_reason: null, current_iteration: 2, max_iterations: 10, elapsed_seconds: 1,
    created_at_iso: '2026-11-10T10:00:00', sdk_session_id: 'x', project_dir: '/tmp',
    run_id: null, plugin_metadata: {}, predecessor: null, successors: [],
    result: null, error: null, reviewer_mode: 'auto',
  }]
  const SessionDetailView = (await import('../views/SessionDetailView.vue')).default
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/session/:id', component: { template: '<div/>' } }],
  })
  router.push('/session/sess-1')
  await router.isReady()
  const wrapper = mount(SessionDetailView, {
    global: {
      plugins: [router],
      stubs: {
        CheckpointPanel: true, DeleteSessionDialog: true, FileProvenanceView: true,
        VirtualLog: true, AgentTopologyGraph: true, WatchdogAlerts: true,
      },
    },
  })
  await flushPromises()
  return wrapper
}

// 折叠开关行：带 expandId 且文案含「点击展开」
function foldSwitches(wrapper: any) {
  return (wrapper.vm as any).workerOutput
    .filter((l: any) => l.expandId && String(l.text).includes('点击展开'))
    .map((l: any) => ({ text: l.text, expandId: l.expandId }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSessions.value = []
  mockEvents.value = {}
})

describe('子代理 hand-back 折叠块消息来源', () => {
  it('stop 空 messages 保留 progress 累积——iteration 2 折叠块不消失', { timeout: 15000 }, async () => {
    const wrapper = await mountWithEvents([
      ev(1, 1, 'subagent_start', { agent_id: 'ses_A', agent_type: 'task' }),
      ev(2, 1, 'subagent_progress', { agent_id: 'ses_A', messages: [msg('iter1 answer')] }),
      ev(3, 1, 'subagent_stop', {
        agent_id: 'ses_A', agent_type: 'task', content: 'iter1 done',
        total_tokens: 10, messages: [msg('iter1 answer')],
      }),
      ev(4, 2, 'subagent_start', { agent_id: 'ses_B', agent_type: 'task' }),
      ev(5, 2, 'subagent_progress', { agent_id: 'ses_B', messages: [msg('iter2 answer')] }),
      // 后端降级路径：stop 只有 content（含截断标记），messages 为空
      ev(6, 2, 'subagent_stop', {
        agent_id: 'ses_B', agent_type: 'task',
        content: 'iter2 ... (truncated, 999 lines, 99999 chars total)',
        total_tokens: 20, messages: [],
      }),
    ])

    const switches = foldSwitches(wrapper)
    expect(switches).toHaveLength(2)
    expect(switches[0]).toMatchObject({ expandId: 'sa:ses_A' })
    expect(switches[1]).toMatchObject({ expandId: 'sa:ses_B' })
    expect(switches[1].text).toContain('1 条消息')
    wrapper.unmount()
  })

  it('stop 无 messages 键同样保留 progress 累积', { timeout: 15000 }, async () => {
    const wrapper = await mountWithEvents([
      ev(1, 1, 'subagent_start', { agent_id: 'ses_A', agent_type: 'task' }),
      ev(2, 1, 'subagent_progress', { agent_id: 'ses_A', messages: [msg('kept')] }),
      ev(3, 1, 'subagent_stop', {
        agent_id: 'ses_A', agent_type: 'task', content: 'done', total_tokens: 1,
      }),
    ])

    const switches = foldSwitches(wrapper)
    expect(switches).toHaveLength(1)
    expect(switches[0].text).toContain('1 条消息')
    wrapper.unmount()
  })

  it('stop 带非空 messages 时权威替换 progress 累积，不重复计数', { timeout: 15000 }, async () => {
    const wrapper = await mountWithEvents([
      ev(1, 1, 'subagent_start', { agent_id: 'ses_A', agent_type: 'task' }),
      ev(2, 1, 'subagent_progress', { agent_id: 'ses_A', messages: [msg('m1')] }),
      ev(3, 1, 'subagent_stop', {
        agent_id: 'ses_A', agent_type: 'task', content: 'done', total_tokens: 1,
        messages: [msg('m1'), msg('m2')],
      }),
    ])

    const switches = foldSwitches(wrapper)
    expect(switches).toHaveLength(1)
    expect(switches[0].text).toContain('2 条消息')
    wrapper.unmount()
  })

  it('无 progress 且 stop 无 messages 时不产生折叠块', { timeout: 15000 }, async () => {
    const wrapper = await mountWithEvents([
      ev(1, 1, 'subagent_start', { agent_id: 'ses_A', agent_type: 'task' }),
      ev(2, 1, 'subagent_stop', {
        agent_id: 'ses_A', agent_type: 'task', content: 'done', total_tokens: 1,
        messages: [],
      }),
    ])

    expect(foldSwitches(wrapper)).toHaveLength(0)
    wrapper.unmount()
  })
})

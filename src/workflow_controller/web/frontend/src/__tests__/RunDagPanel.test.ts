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

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import RunDagPanel from '../plugins/graph/ui/RunDagPanel.vue'

// 读修复终态门：run 账面终态后驱动运行时已摘除，reconcile_projection 必 503——
// 用户 stop 后 graph 按设计落 paused（续跑断点），不得再发起对账。
// 渲染内核（insight 移植）经真实组件树挂载：投影 + 事件回放 → SVG DAG →
// 节点点击侧栏 → 成员会话下钻。

const mockDriverOp = vi.fn().mockResolvedValue(null)
const mockFetchEvents = vi.fn()
const mockPush = vi.fn().mockResolvedValue(undefined)

vi.mock('../composables/useRuns', () => ({
  useRuns: () => ({
    driverOp: mockDriverOp,
    fetchEvents: mockFetchEvents,
  }),
}))

vi.mock('../composables/useSSE', () => ({
  useSSE: () => ({ authState: ref({ providers: [] }) }),
}))

vi.mock('../composables/useAuth', () => ({
  useAuth: () => ({ activateProvider: vi.fn().mockResolvedValue(undefined) }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mockPush }),
}))

// 投影带 nodes 数组才可渲染 DAG；graph 状态 paused 是 stop 断点语义
const PAUSED_PROJECTION = {
  schema_version: 2,
  graph_id: 'g1',
  workflow: 'demo',
  status: 'paused',
  nodes: [{ id: 'n1', status: 'passed' }],
}

const PROJECTION = {
  schema_version: 2,
  graph_id: 'g1',
  workflow: 'demo',
  status: 'completed',
  nodes: [
    { id: 'prep', depends_on: [], task_type: 'agent', status: 'passed', attempts: 1, gen: 0 },
    { id: 'build', depends_on: ['prep'], task_type: 'agent', status: 'failed', attempts: 1, gen: 0 },
  ],
  edges: [{ from: 'prep', to: 'build' }],
  rollback_edges: [],
  retired_instances: [],
  subgraphs: [],
}

function histEvent(over: Record<string, unknown>) {
  return { source: 'run_events', event_type: 'node_history', data: over }
}

// 页内不足一页 = 已到水位（事件端点排空判据）
function eventsPage(events: unknown[], cursor = 'cur-1') {
  return { events, next_cursor: cursor, limit: 1000 }
}

function mountPanel(props: Record<string, unknown>) {
  return mount(RunDagPanel, {
    props: { runId: 'r1', projection: null, ...props },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetchEvents.mockResolvedValue(null)
})

describe('RunDagPanel — 读修复终态门', () => {
  it('run 终态时 graph 状态 paused 不发起 reconcile_projection', async () => {
    const wrapper = mountPanel({ terminal: true })
    await wrapper.setProps({ projection: PAUSED_PROJECTION })
    await flushPromises()
    expect(mockDriverOp).not.toHaveBeenCalled()
  })

  it('run 非终态时非终态 graph 状态照常发起（静默请求）', async () => {
    const wrapper = mountPanel({ terminal: false })
    await wrapper.setProps({
      projection: { ...PAUSED_PROJECTION, status: 'running' },
    })
    await flushPromises()
    expect(mockDriverOp).toHaveBeenCalledWith(
      'r1', 'reconcile_projection', undefined, true,
    )
  })

  it('graph 自身终态状态不发起（原有排除表行为）', async () => {
    const wrapper = mountPanel({ terminal: false })
    await wrapper.setProps({
      projection: { ...PAUSED_PROJECTION, status: 'completed' },
    })
    await flushPromises()
    expect(mockDriverOp).not.toHaveBeenCalled()
  })
})

describe('RunDagPanel — DAG 渲染与交互', () => {
  it('投影不可用（无 nodes）时呈现空态', () => {
    const wrapper = mountPanel({ projection: { schema_version: 2, status: 'running' } })
    expect(wrapper.text()).toContain('驱动投影不可用')
  })

  it('投影 + node_history 事件 → 渲染主图 SVG（代带、节点、依赖边）', async () => {
    mockFetchEvents.mockResolvedValue(eventsPage([
      histEvent({ node_id: 'prep', gen: 0, attempt: 1, status: 'passed', workflow_controller_session_id: 'ses_1' }),
      histEvent({ node_id: 'build', gen: 0, attempt: 1, status: 'failed', workflow_controller_session_id: 'ses_2' }),
    ]))
    const wrapper = mountPanel({ projection: PROJECTION })
    await flushPromises()

    const svg = wrapper.find('svg.graph-dag')
    expect(svg.exists()).toBe(true)
    // 两节点 + 第 1 次运现代带标签
    expect(wrapper.findAll('.run-node')).toHaveLength(2)
    expect(wrapper.text()).toContain('第 1 次运行')
    // 依赖边（prep → build）渲染为 SVG path
    expect(svg.findAll('path').length).toBeGreaterThan(0)
  })

  it('节点点击 → 侧栏运行历史；成员会话下钻跳转 /session/:id', async () => {
    mockFetchEvents.mockResolvedValue(eventsPage([
      histEvent({ node_id: 'prep', gen: 0, attempt: 1, status: 'passed', workflow_controller_session_id: 'ses_1' }),
    ]))
    const wrapper = mountPanel({ projection: PROJECTION })
    await flushPromises()

    expect(wrapper.find('.run-node-detail').exists()).toBe(false)
    const prepNode = wrapper.findAll('.run-node').find(g => g.text().includes('prep'))
    expect(prepNode).toBeDefined()
    await prepNode!.trigger('click')
    expect(wrapper.find('.run-node-detail').exists()).toBe(true)
    // attempt 时间线呈现会话成员
    expect(wrapper.find('.run-node-detail').text()).toContain('第 1 次')

    await wrapper.find('.member-link').trigger('click')
    expect(mockPush).toHaveBeenCalledWith('/session/ses_1')
  })

  it('事件增量续拉：投影刷新从上次游标续取（不整表重拉）', async () => {
    mockFetchEvents.mockResolvedValueOnce(eventsPage([
      histEvent({ node_id: 'prep', gen: 0, attempt: 1, status: 'passed', workflow_controller_session_id: 'ses_1' }),
    ]))
    const wrapper = mountPanel({ projection: PROJECTION })
    await flushPromises()
    expect(mockFetchEvents).toHaveBeenCalledTimes(1)
    expect(mockFetchEvents).toHaveBeenCalledWith('r1', undefined, 1000)

    mockFetchEvents.mockResolvedValueOnce(eventsPage([], 'cur-2'))
    await wrapper.setProps({ projection: { ...PROJECTION } })
    await flushPromises()
    expect(mockFetchEvents).toHaveBeenCalledTimes(2)
    expect(mockFetchEvents).toHaveBeenLastCalledWith('r1', 'cur-1', 1000)
  })
})

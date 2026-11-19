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
// 投影 v2 + node_history → RunIndex 适配层 IT：语义对照后端 exporter.py
// （成员判定 / carried / 占位 / 验收 / 回滚 / 子图容器），断言经
// buildViewModel 消费后的节点实例形状——布局渲染族零改动消费的证据。
import { describe, it, expect } from 'vitest'
import { projectionToRunIndex } from '../graph/lib/projectionToRunIndex'
import { buildViewModel, findNodeInstance, nodeKeyOf } from '../graph/lib/view-model'

type Ev = { source: string; event_type: string; data: Record<string, unknown> }

function hist(over: Record<string, unknown>): Ev {
  return { source: 'run_events', event_type: 'node_history', data: over }
}

function buildVm(projection: Record<string, unknown>, events: Ev[]) {
  const index = projectionToRunIndex(projection, events, 'run-it')
  return { index, vm: buildViewModel(index) }
}

const BASE_PROJECTION = {
  schema_version: 2,
  graph_id: 'g-it',
  workflow: '适配层 IT',
  status: 'running',
  nodes: [
    { id: 'prep', depends_on: [], task_type: 'agent', status: 'passed', attempts: 1, gen: 0, workflow_controller_session_id: 'ses_prep' },
    { id: 'build', depends_on: ['prep'], task_type: 'agent', status: 'failed', attempts: 1, gen: 0, workflow_controller_session_id: 'ses_build' },
    { id: 'lint', depends_on: [], task_type: 'agent', status: 'pending', attempts: 0, gen: 0 },
  ],
  edges: [{ from: 'prep', to: 'build' }],
  rollback_edges: [],
  retired_instances: [],
  subgraphs: [],
}

describe('projectionToRunIndex：成员判定', () => {
  it('agent 节点 → session 成员；依赖边解析为主图边；状态由 attempt 结论驱动', () => {
    const events = [
      hist({ node_id: 'prep', gen: 0, attempt: 1, status: 'passed', workflow_controller_session_id: 'ses_prep' }),
      hist({ node_id: 'build', gen: 0, attempt: 1, status: 'failed', workflow_controller_session_id: 'ses_build' }),
    ]
    const { vm } = buildVm(BASE_PROJECTION, events)
    const main = vm.views[0]
    expect(main.id).toBe('main')
    expect(main.edges).toEqual([{ from: nodeKeyOf('prep', 0), to: nodeKeyOf('build', 0) }])

    const prep = findNodeInstance(vm, 'prep', 0)!
    expect(prep.status).toBe('passed')
    expect(prep.taskType).toBe('agent')
    expect(prep.attempts).toHaveLength(1)
    expect(prep.attempts[0].executeMember.sessionId).toBe('ses_prep')
    expect(prep.attempts[0].executeMember.kind).toBe('session')

    const build = findNodeInstance(vm, 'build', 0)!
    expect(build.status).toBe('failed')
  })

  it('同代重试：attempt 逐次递增为时间线，末次结论为节点状态', () => {
    const projection = { ...BASE_PROJECTION, nodes: BASE_PROJECTION.nodes.map(n => n.id === 'prep' ? { ...n, status: 'passed', attempts: 2 } : n) }
    const events = [
      hist({ node_id: 'prep', gen: 0, attempt: 1, status: 'failed', workflow_controller_session_id: 'ses_1' }),
      hist({ node_id: 'prep', gen: 0, attempt: 2, status: 'passed', workflow_controller_session_id: 'ses_2' }),
    ]
    const { vm } = buildVm(projection, events)
    const prep = findNodeInstance(vm, 'prep', 0)!
    expect(prep.attempts.map(a => a.ordinal)).toEqual([1, 2])
    expect(prep.status).toBe('passed')
    expect(prep.attempts[0].executeMember.sessionId).toBe('ses_1')
    expect(prep.attempts[1].executeMember.sessionId).toBe('ses_2')
  })

  it('未运行节点 → 占位成员（not_run / pending），不产 attempt', () => {
    const events = [
      hist({ node_id: 'prep', gen: 0, attempt: 1, status: 'passed', workflow_controller_session_id: 'ses_prep' }),
    ]
    const { vm } = buildVm(BASE_PROJECTION, events)
    const lint = findNodeInstance(vm, 'lint', 0)!
    expect(lint.status).toBe('pending')
    expect(lint.executionState).toBe('not_run')
    expect(lint.attempts).toHaveLength(0)
    expect(lint.pendingMembers).toHaveLength(1)
  })

  it('bash 节点 → process 成员携带输出文本', () => {
    const projection = {
      ...BASE_PROJECTION,
      nodes: [{ id: 'shell', depends_on: [], task_type: 'bash', status: 'passed', attempts: 1, gen: 0 }],
      edges: [],
    }
    const events = [hist({ node_id: 'shell', gen: 0, attempt: 1, status: 'passed', output: 'hello\nworld' })]
    const { vm } = buildVm(projection, events)
    const shell = findNodeInstance(vm, 'shell', 0)!
    expect(shell.taskType).toBe('bash')
    expect(shell.attempts[0].executeMember.kind).toBe('process')
    expect(shell.attempts[0].executeMember.sessionId).toBeNull()
    expect(shell.attempts[0].outputText).toBe('hello\nworld')
  })

  it('快照档案补缺：无事件时当前 attempt 仍成成员（running 以 started/unfinished 推导）', () => {
    const projection = {
      ...BASE_PROJECTION,
      nodes: [{ id: 'prep', depends_on: [], task_type: 'agent', status: 'running', attempts: 1, gen: 0, workflow_controller_session_id: 'ses_live', started_at: '2026-01-01T10:00:00Z', finished_at: null }],
      edges: [],
    }
    const { vm } = buildVm(projection, [])
    const prep = findNodeInstance(vm, 'prep', 0)!
    expect(prep.attempts).toHaveLength(1)
    expect(prep.status).toBe('running')
    expect(prep.attempts[0].executeMember.sessionId).toBe('ses_live')
    expect(prep.attempts[0].startedAt).toBe('2026-01-01T10:00:00Z')
  })

  it('事件流合并：起步事件（running + session）与结论事件（passed + 验收）合并为同一 attempt', () => {
    const events = [
      hist({ node_id: 'prep', gen: 0, attempt: 1, status: 'running', workflow_controller_session_id: 'ses_prep', started_at: '2026-01-01T10:00:00Z' }),
      hist({ node_id: 'prep', gen: 0, attempt: 1, status: 'passed', verify_type: 'script', verify_reason: '全部断言通过' }),
    ]
    const { vm } = buildVm(BASE_PROJECTION, events)
    const prep = findNodeInstance(vm, 'prep', 0)!
    expect(prep.attempts).toHaveLength(1)
    expect(prep.attempts[0].executeMember.sessionId).toBe('ses_prep')
    expect(prep.attempts[0].startedAt).toBe('2026-01-01T10:00:00Z')
    expect(prep.attempts[0].verification.type).toBe('script')
    expect(prep.attempts[0].verification.status).toBe('passed')
    expect(prep.attempts[0].verification.reason).toBe('全部断言通过')
  })
})

describe('projectionToRunIndex：验收成员', () => {
  it('verify_session_id → 独立 session 验收成员 + exec→verify 依赖边', () => {
    const events = [
      hist({
        node_id: 'build', gen: 0, attempt: 1, status: 'failed', workflow_controller_session_id: 'ses_build',
        verify_type: 'agent', verify_session_id: 'ses_v', verify_reason: '测试未覆盖空输入',
      }),
    ]
    const { vm, index } = buildVm(BASE_PROJECTION, events)
    const build = findNodeInstance(vm, 'build', 0)!
    expect(build.attempts[0].verifyMember?.sessionId).toBe('ses_v')
    expect(build.attempts[0].verifyMember?.kind).toBe('session')
    const ids = new Set(index.members.map(m => m.member.id))
    expect(ids.has('s_ses_build')).toBe(true)
    expect(ids.has('s_ses_v')).toBe(true)
    // exec → verify 为同节点作用域依赖
    const rel = index.relations.find(r =>
      r.from.member.id === 's_ses_build' && r.to.member.id === 's_ses_v')
    expect(rel?.raw.type).toBe('depends_on')
  })
})

describe('projectionToRunIndex：回滚与承接', () => {
  it('回滚边 → 下一代 carried（沿用上一代终态结果）+ rollback 记录', () => {
    const projection = {
      ...BASE_PROJECTION,
      rollback_edges: [{ from: 'build', from_gen: 0, to: 'prep', to_gen: 1 }],
    }
    const events = [
      hist({ node_id: 'prep', gen: 0, attempt: 1, status: 'passed', workflow_controller_session_id: 'ses_prep' }),
      hist({ node_id: 'build', gen: 0, attempt: 1, status: 'failed', workflow_controller_session_id: 'ses_build' }),
    ]
    const { vm } = buildVm(projection, events)
    expect(vm.generations).toEqual([0, 1])

    const prep1 = findNodeInstance(vm, 'prep', 1)!
    expect(prep1.status).toBe('carried')
    expect(prep1.executionState).toBe('carried')
    expect(prep1.carriedFromGeneration).toBe(0)
    expect(prep1.attempts).toHaveLength(0)

    const build1 = findNodeInstance(vm, 'build', 1)!
    expect(build1.status).toBe('carried')

    expect(vm.rollbacks).toHaveLength(1)
    expect(vm.rollbacks[0].from).toEqual({ nodeId: 'build', generation: 0, attempt: 1 })
    expect(vm.rollbacks[0].to).toEqual({ nodeId: 'prep', generation: 1, attempt: 0 })
    expect(vm.rollbacks[0].triggerKey).toBe(nodeKeyOf('build', 0))
    expect(vm.rollbacks[0].targetKey).toBe(nodeKeyOf('prep', 1))
    expect(vm.views[0].rollbackLinks).toHaveLength(1)
  })

  it('最近实例非终态（running）时该代不产 carried（占位语义由 exporter 同口径跳过）', () => {
    const projection = {
      ...BASE_PROJECTION,
      rollback_edges: [{ from: 'build', from_gen: 0, to: 'prep', to_gen: 1 }],
      nodes: BASE_PROJECTION.nodes.map(n => n.id === 'prep' ? { ...n, status: 'running' } : n),
    }
    const events = [
      hist({ node_id: 'prep', gen: 0, attempt: 1, status: 'running', workflow_controller_session_id: 'ses_prep' }),
    ]
    const { vm } = buildVm(projection, events)
    const prep1 = findNodeInstance(vm, 'prep', 1)
    expect(prep1).toBeNull()
  })
})

describe('projectionToRunIndex：子图容器', () => {
  it('xlsx 子图（display_type=subgraph）：generator 执行成员即容器，子节点全 id 挂接', () => {
    const projection = {
      ...BASE_PROJECTION,
      nodes: [
        { id: 'prep', depends_on: [], task_type: 'agent', status: 'passed', attempts: 1, gen: 0, workflow_controller_session_id: 'ses_prep' },
        { id: 'gen1', depends_on: ['prep'], task_type: 'generator', display_type: 'subgraph', status: 'passed', attempts: 1, gen: 0, subgraph_generated: true },
      ],
      edges: [{ from: 'prep', to: 'gen1' }],
      subgraphs: [{
        parent_node: 'gen1',
        nodes: [
          { id: 'sub_a', depends_on: [], task_type: 'agent', status: 'passed', attempts: 1, gen: 0, workflow_controller_session_id: 'ses_suba' },
          { id: 'sub_b', depends_on: ['sub_a'], task_type: 'agent', status: 'pending', attempts: 0, gen: 0 },
        ],
      }],
    }
    const events = [
      hist({ node_id: 'prep', gen: 0, attempt: 1, status: 'passed', workflow_controller_session_id: 'ses_prep' }),
      hist({ node_id: 'gen1', gen: 0, attempt: 1, status: 'passed' }),
      hist({ node_id: 'gen1:sub_a', gen: 0, attempt: 1, status: 'passed', workflow_controller_session_id: 'ses_suba' }),
    ]
    const { vm } = buildVm(projection, events)
    const gen = findNodeInstance(vm, 'gen1', 0)!
    expect(gen.taskType).toBe('workflow')
    expect(gen.hasSubgraph).toBe(true)
    expect(vm.views).toHaveLength(2)
    const sub = vm.views[1]
    expect(sub.parentKey).toBe(nodeKeyOf('gen1', 0))
    expect(sub.nodeKeys).toContain(nodeKeyOf('gen1:sub_a', 0))
    // 子图内部依赖边（strip 后的 id 经 parent 还原为全 id）
    expect(sub.edges).toEqual([{ from: nodeKeyOf('gen1:sub_a', 0), to: nodeKeyOf('gen1:sub_b', 0) }])
    const subB = findNodeInstance(vm, 'gen1:sub_b', 0)!
    expect(subB.status).toBe('pending')
  })

  it('动态生成器（LLM 生成）：独立容器 + gen-sub-graph 关系，generator 呈生成器语义', () => {
    const projection = {
      ...BASE_PROJECTION,
      nodes: [
        { id: 'gen2', depends_on: [], task_type: 'generator', display_type: 'generator', status: 'passed', attempts: 1, gen: 0, workflow_controller_session_id: 'ses_gen', subgraph_generated: true },
      ],
      edges: [],
      subgraphs: [{
        parent_node: 'gen2',
        nodes: [
          { id: 'sub_x', depends_on: [], task_type: 'agent', status: 'passed', attempts: 1, gen: 0, workflow_controller_session_id: 'ses_x' },
        ],
      }],
    }
    const events = [
      hist({ node_id: 'gen2', gen: 0, attempt: 1, status: 'passed', workflow_controller_session_id: 'ses_gen' }),
      hist({ node_id: 'gen2:sub_x', gen: 0, attempt: 1, status: 'passed', workflow_controller_session_id: 'ses_x' }),
    ]
    const { vm } = buildVm(projection, events)
    const gen = findNodeInstance(vm, 'gen2', 0)!
    expect(gen.taskType).toBe('generator')
    expect(gen.hasSubgraph).toBe(true)
    expect(vm.views).toHaveLength(2)
    expect(vm.views[1].nodeKeys).toContain(nodeKeyOf('gen2:sub_x', 0))
    // 主图下游以容器为依赖边锚点（upstream 归约）——这里无下游，断言 gen-sub-graph 关系存在
    const sub = findNodeInstance(vm, 'gen2:sub_x', 0)!
    expect(sub.status).toBe('passed')
  })
})

describe('projectionToRunIndex：形状防呆', () => {
  it('空投影 / 非法字段不抛，产空模型', () => {
    const { vm } = buildVm({ nodes: [], edges: [] }, [])
    expect(vm.nodes).toHaveLength(0)
    expect(vm.views).toHaveLength(1)

    const { vm: vm2 } = buildVm({ nodes: [{ id: 'x' }] }, [
      { source: 'events', event_type: 'node_history', data: { node_id: 'x', attempt: 1, gen: 0, status: 'passed' } },
    ])
    // 非 run_events 源（session 事件）不进事实
    expect(findNodeInstance(vm2, 'x', 0)!.attempts).toHaveLength(0)
  })
})

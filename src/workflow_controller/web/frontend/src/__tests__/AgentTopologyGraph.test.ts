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

import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentTopologyGraph from '../components/common/AgentTopologyGraph.vue'
import type {
  TopologyEdge,
  TopologyNode,
  TopologySnapshot,
} from '../types/topology'

const T0 = 1_700_000_000_000

function sub(
  id: string,
  startedAtSec: number,
  over: Partial<TopologyNode> = {},
): TopologyNode {
  return {
    id,
    role: 'subagent',
    agentType: 'explore',
    label: id,
    status: 'completed',
    startedAt: T0 + startedAtSec * 1000,
    endedAt: T0 + (startedAtSec + 10) * 1000,
    tokens: 100,
    toolCallCount: 2,
    iteration: 0,
    messageCount: 4,
    dispatchContent: null,
    model: null,
    ...over,
  }
}

function snapshot(
  subs: TopologyNode[],
  edges: TopologyEdge[],
  over: Partial<TopologySnapshot> = {},
): TopologySnapshot {
  const main: TopologyNode = {
    id: 'main',
    role: 'main',
    agentType: 'worker',
    label: 'Main Agent',
    status: 'completed',
    startedAt: null,
    endedAt: null,
    tokens: 0,
    toolCallCount: 0,
    iteration: 0,
    messageCount: 0,
    dispatchContent: null,
    model: null,
  }
  return {
    nodes: [main, ...subs],
    edges,
    globalStartMs: T0,
    globalEndMs: T0 + 100_000,
    totalSubagents: subs.length,
    activeSubagents: 0,
    completedSubagents: subs.length,
    failedSubagents: 0,
    stoppedSubagents: 0,
    reviewerDecisions: 0,
    forks: [],
    ...over,
  }
}

function dispatch(fromId: string, toId: string): TopologyEdge {
  return { fromId, toId, type: 'dispatch', status: 'completed', label: null }
}

function labelsOf(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('.topo-node-title').map((n) => n.text())
}

function depthOf(wrapper: ReturnType<typeof mount>, id: string): string | undefined {
  return wrapper.find(`.topo-node[data-agent-id="${id}"]`).attributes('data-depth')
}

describe('AgentTopologyGraph — 紧凑归属树', () => {
  it('按真实派发关系嵌套子、孙与更深层节点', () => {
    const subs = [
      sub('sub-parent', 0),
      sub('sub-g1', 1),
      sub('sub-g2', 2),
      sub('sub-gg', 3),
      sub('sub-direct', 4),
    ]
    const topo = snapshot(subs, [
      dispatch('main', 'sub-parent'),
      dispatch('sub-parent', 'sub-g1'),
      dispatch('sub-parent', 'sub-g2'),
      dispatch('sub-g1', 'sub-gg'),
      dispatch('main', 'sub-direct'),
    ])
    const wrapper = mount(AgentTopologyGraph, { props: { topology: topo } })

    expect(labelsOf(wrapper)).toEqual([
      'Main Agent', 'sub-parent', 'sub-g1', 'sub-gg', 'sub-g2', 'sub-direct',
    ])
    expect(depthOf(wrapper, 'sub-parent')).toBe('1')
    expect(depthOf(wrapper, 'sub-g1')).toBe('2')
    expect(depthOf(wrapper, 'sub-gg')).toBe('3')
    expect(depthOf(wrapper, 'sub-direct')).toBe('1')
    expect(wrapper.find('svg').exists()).toBe(false)
  })

  it('折叠只隐藏后代，兄弟节点保持可见；重新展开恢复子树', async () => {
    const subs = [sub('parent', 0), sub('child', 1), sub('sibling', 2)]
    const topo = snapshot(subs, [
      dispatch('main', 'parent'),
      dispatch('parent', 'child'),
      dispatch('main', 'sibling'),
    ])
    const wrapper = mount(AgentTopologyGraph, { props: { topology: topo } })
    const toggle = wrapper.find('.topo-node[data-agent-id="parent"] .tree-toggle')

    await toggle.trigger('click')
    expect(labelsOf(wrapper)).toEqual(['Main Agent', 'parent', 'sibling'])
    expect(wrapper.find('.topo-node[data-agent-id="parent"]').attributes('aria-expanded')).toBe('false')

    await toggle.trigger('click')
    expect(labelsOf(wrapper)).toEqual(['Main Agent', 'parent', 'child', 'sibling'])
    expect(wrapper.find('.topo-node[data-agent-id="parent"]').attributes('aria-expanded')).toBe('true')
  })

  it('无层级信息时全部作为 main 的直接子节点', () => {
    const subs = [sub('s1', 0), sub('s2', 1), sub('s3', 2)]
    const topo = snapshot(subs, [
      dispatch('main', 's1'),
      dispatch('main', 's2'),
      dispatch('main', 's3'),
    ])
    const wrapper = mount(AgentTopologyGraph, { props: { topology: topo } })
    for (const node of subs) expect(depthOf(wrapper, node.id)).toBe('1')
  })

  it('悬挂父引用回退到 main，节点不丢失', () => {
    const topo = snapshot(
      [sub('orphan-g', 0)],
      [dispatch('ghost-parent', 'orphan-g')],
    )
    const wrapper = mount(AgentTopologyGraph, { props: { topology: topo } })
    expect(depthOf(wrapper, 'orphan-g')).toBe('1')
  })

  it('reviewer 位于 main 之前，点击节点仍发出原详情事件', async () => {
    const reviewer: TopologyNode = {
      id: 'reviewer', role: 'reviewer', agentType: 'reviewer', label: 'Reviewer',
      status: 'completed', startedAt: null, endedAt: null, tokens: 0,
      toolCallCount: 0, iteration: 0, messageCount: 0,
      dispatchContent: null, model: null,
    }
    const topo = snapshot([sub('s1', 0, { status: 'running' })], [
      dispatch('main', 's1'),
      { fromId: 'reviewer', toId: 'main', type: 'feedback', status: 'completed', label: 'feedback' },
    ])
    topo.nodes.push(reviewer)
    const wrapper = mount(AgentTopologyGraph, { props: { topology: topo } })

    expect(labelsOf(wrapper).slice(0, 2)).toEqual(['Reviewer', 'Main Agent'])
    expect(wrapper.find('.topo-node[data-agent-id="s1"]').classes()).toContain('status-running')
    await wrapper.find('.topo-node[data-agent-id="s1"] .topo-node-title').trigger('click')
    expect(wrapper.emitted('selectAgent')).toEqual([['s1']])
  })

  it('树内不展示耗时、token 或工具数等详情', () => {
    const topo = snapshot([sub('s1', 0)], [dispatch('main', 's1')])
    const wrapper = mount(AgentTopologyGraph, { props: { topology: topo } })
    expect(wrapper.find('.topo-node-sub').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('tokens')
    expect(wrapper.text()).not.toContain('tools')
    expect(wrapper.text()).not.toContain('10s')
  })
})

<!--
  Copyright (c) 2026 Workflow Controller Contributors

  Licensed under the MIT License (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://opensource.org/licenses/MIT

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->

<template>
  <div class="topo" role="tree" aria-label="Agent 调用树">
    <div
      v-for="row in visibleRows"
      :key="row.node.id"
      class="topo-node"
      :class="[`status-${row.node.status}`, `depth-${row.depth}`]"
      :style="{ paddingLeft: `${row.depth * 18 + 4}px` }"
      :data-agent-id="row.node.id"
      :data-depth="row.depth"
      role="treeitem"
      :aria-expanded="row.hasChildren ? !collapsed.has(row.node.id) : undefined"
    >
      <span
        v-if="row.depth"
        class="tree-branch"
        :style="{ left: `${row.depth * 18 - 10}px` }"
        aria-hidden="true"
      />
      <button
        v-if="row.hasChildren"
        class="tree-toggle"
        type="button"
        :aria-label="`${collapsed.has(row.node.id) ? '展开' : '折叠'} ${row.node.label}`"
        @click.stop="toggle(row.node.id)"
      >{{ collapsed.has(row.node.id) ? '▸' : '▾' }}</button>
      <span v-else class="tree-toggle-placeholder" aria-hidden="true" />
      <span class="status-dot" :title="row.node.status" aria-hidden="true" />
      <button
        class="topo-node-title"
        :class="{ 'topo-clickable': clickable(row.node) }"
        :title="`${row.node.label} (${row.node.status})`"
        type="button"
        @click="activate(row.node)"
      >{{ row.node.label }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TopologySnapshot, TopologyNode } from '../../types/topology'

const props = defineProps<{ topology: TopologySnapshot }>()
const emit = defineEmits<{
  selectAgent: [agentId: string]
  replay: [checkpointId: string]
  openFork: [sessionId: string]
}>()

interface TreeRow {
  node: TopologyNode
  depth: number
  hasChildren: boolean
}

const collapsed = ref<Set<string>>(new Set())
const visibleRows = computed<TreeRow[]>(() => {
  const subs = props.topology.nodes.filter((n) => n.role === 'subagent')
  const subById = new Map(subs.map((n) => [n.id, n]))
  const childrenOf = new Map<string, TopologyNode[]>()
  for (const node of subs) {
    const edge = props.topology.edges.find(
      (e) => e.type === 'dispatch' && e.toId === node.id,
    )
    const parent = edge && (edge.fromId === 'main' || subById.has(edge.fromId))
      ? edge.fromId
      : 'main'
    childrenOf.set(parent, [...(childrenOf.get(parent) || []), node])
  }
  for (const children of childrenOf.values()) {
    children.sort((a, b) =>
      (a.startedAt || 0) - (b.startedAt || 0) || a.label.localeCompare(b.label),
    )
  }

  // 先独立于折叠状态收集 main 可达节点，悬挂引用与环中的节点再回退到根层。
  const reachable = new Set<string>(['main'])
  const markReachable = (id: string): void => {
    for (const child of childrenOf.get(id) || []) {
      if (reachable.has(child.id)) continue
      reachable.add(child.id)
      markReachable(child.id)
    }
  }
  markReachable('main')

  const rows: TreeRow[] = []
  const reviewer = props.topology.nodes.find((n) => n.role === 'reviewer')
  const main = props.topology.nodes.find((n) => n.role === 'main')
  if (reviewer) rows.push({ node: reviewer, depth: 0, hasChildren: false })
  if (main) {
    rows.push({ node: main, depth: 0, hasChildren: (childrenOf.get('main') || []).length > 0 })
  }

  const visited = new Set<string>(['main'])
  const appendChildren = (id: string, depth: number): void => {
    for (const child of childrenOf.get(id) || []) {
      if (visited.has(child.id)) continue
      visited.add(child.id)
      const hasChildren = (childrenOf.get(child.id) || []).length > 0
      rows.push({ node: child, depth, hasChildren })
      if (!collapsed.value.has(child.id)) appendChildren(child.id, depth + 1)
    }
  }
  appendChildren('main', 1)
  for (const node of subs) {
    if (!reachable.has(node.id)) rows.push({ node, depth: 1, hasChildren: false })
  }
  return rows
})

function toggle(id: string): void {
  const next = new Set(collapsed.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsed.value = next
}

function clickable(node: TopologyNode): boolean {
  return node.role === 'subagent' || node.role === 'reviewer'
    || Boolean(node.replayable || node.sessionId)
}

function activate(node: TopologyNode): void {
  if (node.role === 'subagent' || node.role === 'reviewer') {
    emit('selectAgent', node.id)
  } else if (node.replayable && node.checkpointId) {
    emit('replay', node.checkpointId)
  } else if (node.sessionId) {
    emit('openFork', node.sessionId)
  }
}
</script>

<style scoped>
.topo {
  width: 100%;
  max-height: 360px;
  overflow: auto;
  padding: 6px 4px;
  box-sizing: border-box;
}
.topo-node {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  height: 32px;
  border-radius: 4px;
  color: var(--workflow-controller-text, #f8fafc);
}
.topo-node.depth-1 {
  background: var(--workflow-controller-card, #292a40);
}
.topo-node.status-running {
  background: color-mix(in srgb, #35d6b1 10%, transparent);
}
.tree-branch {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 10px;
  border-left: 1px solid var(--workflow-controller-border, #62657d);
  pointer-events: none;
}
.tree-branch::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 0;
  width: 10px;
  border-top: 1px solid var(--workflow-controller-border, #62657d);
}
.tree-toggle,
.tree-toggle-placeholder {
  flex: 0 0 18px;
  width: 18px;
  height: 28px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--workflow-controller-text-muted, #94a3b8);
  font: inherit;
  line-height: 1;
}
.tree-toggle { cursor: pointer; }
.status-dot {
  flex: 0 0 7px;
  width: 7px;
  height: 7px;
  margin: 0 8px 0 2px;
  border-radius: 50%;
  background: #8f8f8f;
}
.status-running .status-dot { background: #35d6b1; }
.status-failed .status-dot { background: #ef4444; }
.status-dispatched .status-dot { background: #a753ae; }
.status-stopped .status-dot { background: #f0a020; }
.topo-node-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  padding: 0 6px 0 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: 600 12px/1.4 'JetBrains Mono', 'SF Mono', monospace;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.topo-node-title.topo-clickable { cursor: pointer; }
.topo-node-title.topo-clickable:hover {
  color: var(--workflow-controller-primary, #c4b5fd);
}
</style>

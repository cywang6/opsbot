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

<!--
  子图弹窗：主图中点击生成器节点的「子图 ▸」入口打开。只展示入口节点所在
  代的子图（其他代不混入）；右侧内嵌节点运行历史侧栏（与主图同构）；画布
  支持缩放平移与选中点亮，打开自动适配。成员会话定位（打开 /session/:id）
  由面板外壳收口：弹窗打开状态下先关闭弹窗再跳转。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NModal } from 'naive-ui'
import RunCanvas from './RunCanvas.vue'
import RunNodeDetail from './RunNodeDetail.vue'
import type { NodeInstance, RollbackRecord, RunView } from '../lib/view-model'
import { bandLabel } from '../lib/run-theme'

const props = defineProps<{
  show: boolean
  views: RunView[]
  nodesByKey: Map<string, NodeInstance>
  rollbacks: RollbackRecord[]
  /** 入口：生成器节点实例 key（null = 无选中入口） */
  entryKey: string | null
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  locateSession: [sessionId: string]
}>()

const entry = computed(() => (props.entryKey !== null ? props.nodesByKey.get(props.entryKey) ?? null : null))
// 锁定入口代：只取该代生成器节点的子图视图
const view = computed(() => (entry.value ? props.views.find(v => v.parentKey === entry.value!.key) ?? null : null))

// 本地选中态按入口节点键失效（重开/换节点 → 重置）
const sel = ref<{ entryKey: string; key: string | null } | null>(null)
watch(() => props.entryKey, () => { sel.value = null })

const selectedKey = computed(() => (entry.value && sel.value?.entryKey === entry.value.key ? sel.value.key : null))
const selectedNode = computed(() => (selectedKey.value !== null ? props.nodesByKey.get(selectedKey.value) ?? null : null))
const selectedRollbacks = computed(() => {
  const node = selectedNode.value
  if (!node) return []
  return props.rollbacks.filter(r => r.triggerKey === node.key)
})
const viewKeys = computed(() => new Set(view.value?.nodeKeys ?? []))

function selectInDialog(key: string | null): void {
  if (!entry.value) return
  sel.value = { entryKey: entry.value.key, key }
}
function onSelectNode(key: string): void {
  // 跨代跳转目标不在本代子图内 → 忽略（弹窗锁定入口代）
  if (viewKeys.value.has(key)) selectInDialog(key)
}
function onLocateSession(sessionId: string): void {
  emit('update:show', false)
  emit('locateSession', sessionId)
}
</script>

<template>
  <NModal
    :show="show && !!entry && !!view"
    class="run-subgraph-modal"
    :style="{ width: 'min(1180px, 94vw)' }"
    :bordered="false"
    :mask-closable="true"
    @update:show="emit('update:show', $event)"
    @after-leave="selectInDialog(null)"
  >
    <div class="run-glass subgraph-dialog">
      <div class="subgraph-header">
        <span class="subgraph-title">
          {{ entry?.label }} · 子图
          <span class="subgraph-gen">{{ entry ? bandLabel(entry.generation) : '' }}</span>
        </span>
      </div>
      <div class="subgraph-body">
        <div class="subgraph-canvas-wrap">
          <RunCanvas
            v-if="view"
            :view="view"
            :nodes-by-key="nodesByKey"
            :selected-key="selectedKey"
            :fit-key="view.id"
            @select-node="selectInDialog"
          />
        </div>
        <!-- 历史侧栏：浮层玻璃面板 -->
        <aside class="run-glass subgraph-aside">
          <RunNodeDetail
            v-if="selectedNode"
            :node="selectedNode"
            :rollbacks="selectedRollbacks"
            :peers="[]"
            @select-node="onSelectNode"
            @locate-session="onLocateSession"
            @close="selectInDialog(null)"
          />
          <p v-else class="subgraph-hint">
            点击子图节点查看运行历史（逐次尝试、验收结论、成员会话下钻）。
          </p>
        </aside>
      </div>
    </div>
  </NModal>
</template>

<script setup lang="ts">
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

// graph 驱动的 run 面板：投影 v2 + node_history 事件回放 → insight DAG 渲染
// 内核（lib/ 纯函数族 + components/ 移植件）。节点历史走 run 事件回放（游标
// 增量）、模型切换走 driver op——面板零 graph 专用 API 调用。
import { computed, ref, watch } from 'vue'
import { NFlex, NFormItem, NSelect, NTag, NText } from 'naive-ui'
import { useRouter } from 'vue-router'
import RunCanvas from '../../../graph/components/RunCanvas.vue'
import RunNodeDetail from '../../../graph/components/RunNodeDetail.vue'
import RunSubgraphDialog from '../../../graph/components/RunSubgraphDialog.vue'
import { buildViewModel } from '../../../graph/lib/view-model'
import { projectionToRunIndex } from '../../../graph/lib/projectionToRunIndex'
import { useAuth } from '../../../composables/useAuth'
import { useRuns } from '../../../composables/useRuns'
import { useSSE } from '../../../composables/useSSE'

const props = defineProps<{
  runId: string
  projection: Record<string, unknown> | null
  terminal?: boolean
}>()

const router = useRouter()
const { authState } = useSSE()
const { activateProvider } = useAuth()
const { fetchEvents, driverOp } = useRuns()

// 投影形状与旧 graph 详情端点一致，可直接作 DAG 渲染输入；降级应答可能是
// 快照形状（忙时窗/旧库）——无可渲染 DAG 时按投影不可用呈现
const graph = computed(() => {
  const p = props.projection
  return p && Array.isArray(p.nodes) ? p : null
})
const workflow = computed(() => String(props.projection?.workflow ?? ''))
const graphStatus = computed(() => String(props.projection?.status ?? ''))

// 非终态投影到达时对账已消失的运行成员（读修复经通用驱动通道执行；
// 修正随 node_state/projection_updated 事件回流触发下次拉取）。
// 终态门：用户 stop 后 graph 按设计落 paused（续跑断点），但驱动运行时
// 已随 run 任务退出摘除——终态 run 发起 driver op 必 503，读修复无对象
watch([() => props.projection, graphStatus], ([, status]) => {
  if (props.terminal) return
  if (graph.value && !['completed', 'failed', 'stopped'].includes(String(status))) {
    void driverOp(props.runId, 'reconcile_projection', undefined, true).catch(() => {})
  }
})

const statusMeta: Record<string, { type: 'default' | 'success' | 'error' | 'warning' | 'info'; label: string }> = {
  pending: { type: 'default', label: '待运行' },
  running: { type: 'warning', label: '运行中' },
  passed: { type: 'success', label: '完成' },
  completed: { type: 'success', label: '完成' },
  failed: { type: 'error', label: '失败' },
  skipped: { type: 'default', label: '跳过' },
  stopped: { type: 'info', label: '已暂停' },
  paused: { type: 'info', label: '已暂停' },
}

// ── 节点历史（run 事件回放，游标增量）──────────────────────────
// 事件端点请求页长；「页满」判定用应答 limit（服务端钳制后实际生效页长）。
// 游标是稳定尾指针：投影刷新后从上次水位续拉，只取新增事件
const HISTORY_PAGE_SIZE = 1000
const historyEvents = ref<Array<{ source?: string; event_type?: string; data?: Record<string, unknown> | null }>>([])
let eventsCursor: string | undefined
let draining = false
let retriggered = false
let runSeq = 0

async function refreshHistory(): Promise<void> {
  if (draining) { retriggered = true; return }
  draining = true
  const seq = runSeq
  try {
    for (;;) {
      const page = await fetchEvents(props.runId, eventsCursor, HISTORY_PAGE_SIZE)
      if (seq !== runSeq) return
      if (!page) break
      const fresh = page.events.filter(ev =>
        ev.source === 'run_events' && ev.event_type === 'node_history')
      if (fresh.length > 0) historyEvents.value.push(...fresh)
      eventsCursor = page.next_cursor || undefined
      // 满页才续拉（游标为空串时重拉首页会死循环，防御性终止）
      if (page.events.length < page.limit || !page.next_cursor) break
    }
  } finally {
    draining = false
    if (retriggered && seq === runSeq) {
      retriggered = false
      void refreshHistory()
    }
  }
}

// ── 选中态（run/投影切换时重置）────────────────────────────────
const selectedKey = ref<string | null>(null)
const showSubgraph = ref(false)
const subgraphKey = ref<string | null>(null)

watch(() => props.runId, () => {
  runSeq++
  eventsCursor = undefined
  historyEvents.value = []
  selectedKey.value = null
  subgraphKey.value = null
})
watch([() => props.projection, () => props.runId], () => { void refreshHistory() }, { immediate: true })

// ── 视图模型：投影 + 事件 → RunIndex → 布局（纯函数，前端执行）──
const vm = computed(() => {
  const g = graph.value
  if (!g) return null
  try {
    return buildViewModel(projectionToRunIndex(g, historyEvents.value, props.runId))
  } catch {
    return null
  }
})
const nodesByKey = computed(() => new Map((vm.value?.nodes ?? []).map(n => [n.key, n])))
const mainView = computed(() => vm.value?.views[0] ?? null)
const fitKey = computed(() => (vm.value !== null ? 'main' : undefined))

// ── 节点详情侧栏 ──────────────────────────────────────────────
const selectedNode = computed(() => (selectedKey.value !== null ? nodesByKey.value.get(selectedKey.value) ?? null : null))
const selectedRollbacks = computed(() => {
  const node = selectedNode.value
  if (!vm.value || !node) return []
  return vm.value.rollbacks.filter(r => r.triggerKey === node.key)
})
const selectedPeers = computed(() => {
  const node = selectedNode.value
  if (!vm.value || !node) return []
  return vm.value.nodes
    .filter(n => n.nodeId === node.nodeId && n.generation !== node.generation)
    .map(n => ({ key: n.key, generation: n.generation, status: n.status }))
})

function onSelectNode(key: string | null): void {
  selectedKey.value = key
}
function onLocateSession(sessionId: string): void {
  void router.push(`/session/${sessionId}`)
}

// ── 子图弹窗 ──────────────────────────────────────────────────
function onOpenSubgraph(key: string): void {
  subgraphKey.value = key
  showSubgraph.value = true
}

// ── 运行期模型切换（driver op）────────────────────────────────
const allProviders = computed(() => authState.value?.providers || [])
const modelOptions = computed(() =>
  allProviders.value.map((p: any) => ({
    label: `${p.model || '(无模型)'}${p.status === 'active' ? ' ✓' : ''}`,
    value: String(p.index),
  })))
const activeProviderIndex = computed(() => {
  const p = allProviders.value.find((x: any) => x.is_active)
  return p ? String(p.index) : ''
})
const selectedModel = ref('')
const modelSaving = ref(false)

function providerByIndex(idx: number) {
  return allProviders.value.find((p: any) => p.index === idx) || null
}

async function onModelChange(value: string) {
  const idx = Number(value)
  const provider = providerByIndex(idx)
  if (!value || !provider) return
  modelSaving.value = true
  try {
    if (!provider.is_active) await activateProvider(idx)
    await driverOp(props.runId, 'update_model', {
      model: provider.model,
      provider_index: idx,
      model_pinned: false,
    })
  } finally {
    modelSaving.value = false
  }
}

// 默认选中：投影自带 provider_index 优先，缺省回落当前 active provider
watch([() => props.projection, allProviders], () => {
  const idx = props.projection?.provider_index
  if (typeof idx === 'number' && providerByIndex(idx)) {
    selectedModel.value = String(idx)
    return
  }
  if (!selectedModel.value || !providerByIndex(Number(selectedModel.value))) {
    selectedModel.value = activeProviderIndex.value
  }
}, { immediate: true })
</script>

<template>
  <div class="dag-panel">
    <div v-if="!graph" class="dag-panel-empty">
      <NText depth="3">驱动投影不可用</NText>
    </div>
    <template v-else>
      <NFlex align="center" :size="12" class="dag-panel-header">
        <NText strong>{{ workflow || '未命名工作流' }}</NText>
        <NTag size="small" :bordered="false" round
              :type="statusMeta[graphStatus]?.type || 'default'">
          {{ statusMeta[graphStatus]?.label || graphStatus || '—' }}
        </NTag>
        <span style="flex:1"></span>
        <NFormItem label="模型" :show-feedback="false" size="small">
          <NSelect v-model:value="selectedModel" :options="modelOptions"
                   :loading="modelSaving" size="small" style="width:200px"
                   placeholder="默认" @update:value="onModelChange" />
        </NFormItem>
      </NFlex>
      <div class="dag-container">
        <RunCanvas
          v-if="mainView"
          :view="mainView"
          :nodes-by-key="nodesByKey"
          :selected-key="selectedKey"
          :fit-key="fitKey"
          enable-subgraph-entry
          @select-node="onSelectNode"
          @open-subgraph="onOpenSubgraph"
        />
        <aside v-if="selectedNode" class="dag-detail-aside">
          <RunNodeDetail
            :node="selectedNode"
            :rollbacks="selectedRollbacks"
            :peers="selectedPeers"
            @select-node="onSelectNode"
            @locate-session="onLocateSession"
            @close="onSelectNode(null)"
          />
        </aside>
      </div>
    </template>

    <RunSubgraphDialog
      v-model:show="showSubgraph"
      :views="vm?.views ?? []"
      :nodes-by-key="nodesByKey"
      :rollbacks="vm?.rollbacks ?? []"
      :entry-key="subgraphKey"
      @locate-session="onLocateSession"
    />
  </div>
</template>

<style>
/* ── run-* 材质与动画（自 context-insight globals.css 移植）──────
   深浅主题经 --run-* 桥接 --workflow-controller-* 令牌（:root 全局声明，
   含弹窗 teleport 到 body 的内容）。内容层（节点/边/文本）禁用
   backdrop-filter——玻璃只给浮层 chrome（缩放工具条/侧栏/子图弹窗）。 */
:root {
  --run-canvas: var(--workflow-controller-surface, #ffffff);
  /* v8 图底统一：卡片底色与画布同色（节点由状态色描边定义，不是色块盒子） */
  --run-node-fill: var(--run-canvas);
  --run-text-primary: var(--workflow-controller-text, #1f2328);
  --run-text-muted: var(--workflow-controller-text-muted, #57606a);
  --run-text-faint: #8c959f;
  --run-edge: var(--workflow-controller-border, #d0d7de);
  --run-flow: var(--workflow-controller-text-muted, #8c959f);
  --run-accent: #8250df;
  /* 状态语义色亮档（暗档在 html[data-theme-mode='dark'] 切换） */
  --run-st-passed: #1a7f37;
  --run-st-failed: #cf222e;
  --run-st-running: #9a6700;
  --run-st-stopped: #0969da;
  --run-st-pending: #8c959f;
  --run-st-carried: #1b7c83;
  --run-st-unknown: #57606a;
  /* 节点卡材质：阴影底板 / 顶部内高光 / 点阵网格 */
  --run-shadow: rgba(31, 35, 40, 0.1);
  --run-node-border: var(--workflow-controller-border, #d0d7de);
  --run-dot: rgba(27, 31, 36, 0.07);
  --run-dot-faint: rgba(27, 31, 36, 0.035);
}

/* 暗色档：状态色提亮（GitHub Dark 语义色）、点阵/阴影换暗色系。
   v8 图底统一：node-fill 不覆盖（亮暗同为 canvas 同色），节点由
   状态色描边定义 */
html[data-theme-mode='dark'] {
  --run-edge: color-mix(in srgb, var(--workflow-controller-text, #f0f6fc) 34%, transparent);
  --run-text-faint: #8d96a0;
  --run-st-passed: #3fb950;
  --run-st-failed: #f85149;
  --run-st-running: #d29922;
  --run-st-stopped: #58a6ff;
  --run-st-pending: #8d96a0;
  --run-st-carried: #39c5cf;
  --run-st-unknown: #6e7681;
  --run-shadow: rgba(0, 0, 0, 0.45);
  --run-node-border: rgba(240, 246, 252, 0.2);
  /* 子图入口微章交互色：暗档提亮（GitHub Dark 语义紫），亮档 #8250df */
  --run-accent: #a371f7;
  --run-dot: rgba(240, 246, 252, 0.055);
  --run-dot-faint: rgba(240, 246, 252, 0.028);
}

/* 节点卡材质层（编辑级排版：一条干净的中性发丝边 + 柔和阴影） */
.run-node-shadow {
  fill: var(--run-shadow);
}
/* 外沿：状态色描边定义节点（v8 图底统一后节点的唯一轮廓；--node-st 为
   节点行内状态色变量），同旧自研 UI 的彩色描边模型 */
.run-node-box {
  stroke: var(--node-st);
  stroke-width: 1.5;
}
.run-node:hover .run-node-box {
  stroke: color-mix(in srgb, var(--node-st) 70%, var(--run-text-primary));
  stroke-width: 1.8;
}
.run-node.selected .run-node-box {
  stroke: var(--node-st);
  stroke-width: 2;
}
.run-node.carried .run-node-box {
  stroke-dasharray: 4 3;
}
/* 发丝分隔线：标题区与元信息区的编辑结构 */
.run-node-divider {
  stroke: var(--run-node-border);
  stroke-width: 1;
  opacity: 0.6;
}
/* 元信息行：等宽字体（CJK 回退系统字体），技术感数字排版 */
.run-node-meta {
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
  letter-spacing: 0.04em;
}
/* 子图入口微章：元信息行微章簇的可交互成员（accent 交互色，同状态微章
   一样经 --run-* 令牌桥接——弹窗 teleport 场景同源）；hover 强化底色
   与描边以示可点 */
.run-sub-entry-bg {
  fill: var(--run-accent, #8250df);
  fill-opacity: 0.14;
  stroke: var(--run-accent, #8250df);
  stroke-opacity: 0.6;
  stroke-width: 0.9;
}
.run-sub-entry-text {
  fill: var(--run-accent, #8250df);
}
.run-sub-entry:hover .run-sub-entry-bg {
  fill-opacity: 0.26;
  stroke-opacity: 1;
}
.run-node:hover .run-node-shadow {
  fill: color-mix(in srgb, var(--run-shadow) 70%, var(--run-st-pending));
}

/* 画布根：flex 布局内占满面板主体，工具条以根为定位上下文 */
.run-canvas-root {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}

/* 相机模型：viewport 布局/绘制隔离，camera 单元素 transform 走 GPU 合成
   ——平移/缩放手势零重栅格化 */
.run-viewport {
  position: absolute;
  inset: 0;
  overflow: hidden;
  user-select: none;
  contain: strict;
  touch-action: none;
  cursor: grab;
  /* v9 图底统一：点阵为 viewport 的 CSS 背景（双层 radial-gradient：
     主点阵 + 12px 偏移半透明加密点，复刻原 SVG pattern 密度）——
     屏幕固定、永远铺满、天然无边界。不能画进 SVG：相机落定后 SVG 尺寸
     为「内容 × 缩放」，缩小后点阵区域成边界分明的洗亮盒子，与底色割裂 */
  background-color: var(--run-canvas);
  background-image:
    radial-gradient(circle, var(--run-dot) 0.9px, transparent 0.9px),
    radial-gradient(circle, var(--run-dot-faint) 0.9px, transparent 0.9px);
  background-size: 24px 24px;
  background-position: 0 0, 12px 12px;
}
.run-camera {
  will-change: transform;
}
.run-viewport.run-gesture {
  cursor: grabbing;
}
.run-gesture .run-edge-flow,
.run-gesture .run-edge-flow-active,
.run-gesture .run-rb-flow {
  animation-play-state: paused;
}

/* 边流动画：依赖边叠加流动光点（dash 周期 = 偏移量保证无缝循环），回滚
   虚线缓慢爬行——方向均为数据流向（源 → 目标） */
@keyframes run-edge-flow {
  to { stroke-dashoffset: -14; }
}
.run-edge-flow {
  stroke-dasharray: 3 11;
  animation: run-edge-flow 1.4s linear infinite;
  pointer-events: none;
}
.run-edge-flow-active {
  animation-duration: 0.8s;
}
@keyframes run-rb-flow {
  to { stroke-dashoffset: -9; }
}
.run-rb-flow {
  animation: run-rb-flow 1.2s linear infinite;
  pointer-events: none;
}

/* ── 玻璃材质（Liquid Glass 克制版）── */
.run-glass {
  background-color: color-mix(in srgb, var(--run-canvas) 55%, transparent);
  background-image: linear-gradient(
    135deg,
    color-mix(in srgb, var(--run-canvas) 55%, transparent) 0%,
    color-mix(in srgb, var(--run-canvas) 8%, transparent) 42%,
    color-mix(in srgb, var(--run-canvas) 22%, transparent) 100%
  );
  -webkit-backdrop-filter: blur(20px) saturate(1.6);
  backdrop-filter: blur(20px) saturate(1.6);
  border: 1px solid color-mix(in srgb, var(--run-canvas) 70%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #ffffff 95%, transparent),
    inset 0 0 0 1px color-mix(in srgb, #ffffff 28%, transparent),
    0 0 0 1px rgba(31, 35, 40, 0.07),
    0 2px 6px rgba(31, 35, 40, 0.06),
    0 16px 48px rgba(31, 35, 40, 0.16);
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .run-glass {
    background: var(--run-canvas);
  }
}

/* 工具条按钮微交互 */
.run-tool-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  width: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  color: var(--run-text-muted);
  transition: background-color 160ms ease, color 160ms ease;
}
.run-tool-btn:hover {
  background: color-mix(in srgb, var(--run-text-primary) 6%, transparent);
  color: var(--run-text-primary);
}
.run-tool-btn:active {
  transform: scale(0.98);
}
.run-zoom-label {
  width: 44px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.run-zoom-bar {
  position: absolute;
  bottom: 12px;
  left: 12px;
  display: flex;
  align-items: center;
  border-radius: 12px;
  padding: 2px;
  gap: 2px;
  z-index: 5;
}
.run-tool-sep {
  height: 14px;
  width: 1px;
  background: rgba(31, 35, 40, 0.1);
}
.run-icon { width: 14px; height: 14px; }

/* ── 子图弹窗 ── */
.run-subgraph-modal {
  --run-canvas: var(--workflow-controller-surface, #ffffff);
}
.subgraph-dialog {
  display: flex;
  flex-direction: column;
  height: 84vh;
  border-radius: 16px;
  overflow: hidden;
}
.subgraph-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--run-text-primary) 8%, transparent);
}
.subgraph-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--run-text-primary);
}
.subgraph-gen {
  margin-left: 8px;
  border-radius: 4px;
  padding: 1px 6px;
  font-family: var(--workflow-controller-font-family, monospace);
  font-size: 11px;
  font-weight: 400;
  color: var(--run-text-muted);
  background: color-mix(in srgb, var(--run-text-primary) 5%, transparent);
}
.subgraph-body {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
}
.subgraph-canvas-wrap {
  display: flex;
  min-width: 0;
  flex: 1;
  margin: 12px;
}
.subgraph-aside {
  position: absolute;
  top: 8px;
  bottom: 8px;
  right: 8px;
  z-index: 10;
  width: 340px;
  flex-shrink: 0;
  overflow-y: auto;
  border-radius: 12px;
}
.subgraph-hint {
  padding: 16px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--run-text-faint);
}
</style>

<style scoped>
.dag-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.dag-panel-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.dag-panel-header {
  flex-shrink: 0;
  margin-bottom: 8px;
}
.dag-container {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  /* v8 图底统一：平色画布（无渐晕、无边框、无圆角），卡片底色与画布
     同为 --run-canvas，节点由状态色描边定义；底色仍是暗色主题断言锚点 */
  background-color: var(--run-canvas);
  overflow: hidden;
}
.dag-detail-aside {
  position: absolute;
  top: 8px;
  bottom: 8px;
  right: 8px;
  z-index: 10;
  width: 360px;
  flex-shrink: 0;
  overflow-y: auto;
  border-radius: 12px;
}
</style>

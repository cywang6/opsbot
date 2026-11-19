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
  <div class="vlog" ref="el" @scroll="onScroll">
    <div v-if="!lines.length" class="vlog-empty"><slot /></div>
    <div v-else-if="hasBlocks" class="vlog-flow">
      <div v-for="(ln, i) in flowLines" :key="i" class="vlog-flow-line"
           :class="[ln.cls, { 'vlog-clickable': ln.expandId || ln.modal }]"
           @click="onFlowLineClick(ln, $event)">
        <div v-if="ln.block" class="tool-block" :class="{ expanded: ln.block.expanded }">
          <div class="tool-block-title" :class="{ failed: ln.block.failed }">{{ ln.block.failed ? '✗ ' : '' }}{{ ln.block.title }} <span>{{ ln.block.expanded ? '▾' : '▸' }}</span></div>
          <div v-if="ln.block.expanded" class="tool-block-body">
            <div v-if="ln.block.command" class="tool-block-command">$ {{ ln.block.command }}</div>
            <pre v-if="ln.block.result" class="tool-block-result" :class="{ failed: ln.block.failed }">{{ ln.block.result }}</pre>
            <div v-if="ln.block.fullText" class="tool-block-full" @click.stop="onOpenModal(ln.block.fullText)">… 结果过长，点击查看全文</div>
          </div>
        </div>
        <span v-else-if="ln.html" v-html="ln.html"></span><span v-else>{{ ln.text }}</span>
      </div>
    </div>
    <div v-else class="vlog-inner" :style="{ height: total + 'px' }">
      <div v-for="ln in visible" :key="ln.i" class="vlog-line"
           :class="[ln.cls, { 'vlog-clickable': ln.expandId || ln.modal }]"
           :style="{ top: (ln.i * lh) + 'px' }"
           @click="onFlowLineClick(ln, $event)"
          ><span v-if="ln.html" v-html="ln.html"></span><span v-else>{{ ln.text }}</span></div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 固定行高虚拟滚动：只渲染可见行 ± buffer，支持任意行数而不卡。
// 长行不 wrap（white-space: pre），超宽横向滚 —— 换取固定行高（虚拟滚动前提）。
// 支持可展开行：带 expandId 的行可点击，触发 toggle 事件由父组件重建 lines。
// 窗口内存在工具块（block）时切换到非虚拟化 flow 渲染：工具块高度不定，
// 固定行高虚拟列表会造成断裂边框。
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'

export interface VLogLine {
  text: string
  cls?: string
  expandId?: string  // 非空 → 行可点击展开/收起；值为展开块的唯一 key
  html?: string      // 富文本 HTML（优先于 text 渲染）
  modal?: string     // 非空 → 行可点击，弹窗展示完整内容（长文本截断时用）
  block?: { title: string; command: string; result: string; expanded: boolean; failed?: boolean; fullText?: string }
}
const props = defineProps<{ lines: Array<string | VLogLine> }>()
const emit = defineEmits<{ toggle: [expandId: string]; openModal: [content: string] }>()
const lh = 20            // 行高 px（与 CSS line-height 一致）
const buffer = 30        // 可见区上下各多渲染的行数，避免快速滚动闪白
const el = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportH = ref(400)
const suppressAutoStick = ref(false)

const total = computed(() => props.lines.length * lh)
const hasBlocks = computed(() => props.lines.some((line) => typeof line !== 'string' && !!line.block))
// flow 路径为非虚拟化渲染：虽有 500 事件窗口封顶，但长助手文本按行内联后仍可能
// 积累大量行。设行数护栏，只渲染末尾 N 行，避免长会话挂载数千 DOM 行并在每个
// SSE 批次全量 re-patch；更早的行回看请等待事件窗口推进。
const FLOW_LINE_CAP = 2000
const flowLines = computed(() => {
  const mapped = props.lines.map((line) => typeof line === 'string'
    ? { text: line, cls: '', expandId: '', html: '', modal: '', block: undefined }
    : { text: line.text, cls: line.cls || '', expandId: line.expandId || '', html: line.html || '', modal: line.modal || '', block: line.block })
  if (mapped.length <= FLOW_LINE_CAP) return mapped
  const omitted = mapped.length - FLOW_LINE_CAP
  const hint: VLogLine = { text: `… 已省略前 ${omitted} 行（仅显示最近 ${FLOW_LINE_CAP} 行）`, cls: 'vlog-truncated-hint' }
  return [hint, ...mapped.slice(-FLOW_LINE_CAP)]
})
const startIdx = computed(() => Math.max(0, Math.floor(scrollTop.value / lh) - buffer))
const endIdx = computed(() => Math.min(props.lines.length, Math.ceil((scrollTop.value + viewportH.value) / lh) + buffer))
const visible = computed(() => {
  const out: { i: number; text: string; cls: string; expandId: string; html: string; modal: string }[] = []
  for (let i = startIdx.value; i < endIdx.value; i++) {
    const raw = props.lines[i]
    if (typeof raw === 'string') out.push({ i, text: raw, cls: '', expandId: '', html: '', modal: '' })
    else out.push({ i, text: raw.text, cls: raw.cls || '', expandId: raw.expandId || '', html: raw.html || '', modal: raw.modal || '' })
  }
  return out
})

// flow 路径为整行可点击（标题区展开/收起），但展开后的命令面板与结果正文
// 必须保持可选择可复制：点击落在 .tool-block-body 内时不触发 toggle。
function onFlowLineClick(ln: VLogLine, event: MouseEvent) {
  if (ln.block?.expanded && (event.target as HTMLElement | null)?.closest?.('.tool-block-body')) return
  if (ln.modal) { onOpenModal(ln.modal); return }
  if (ln.expandId) onToggle(ln.expandId, event)
}

function onToggle(expandId: string, event?: MouseEvent) {
  suppressAutoStick.value = true
  const target = event ? (event.currentTarget as HTMLElement | null) : null
  const container = el.value
  const before = target && container ? target.getBoundingClientRect().top - container.getBoundingClientRect().top : null
  emit('toggle', expandId)
  if (before === null || !container) {
    suppressAutoStick.value = false
    return
  }
  nextTick(() => {
    if (!el.value || !target) {
      // 容器或目标已卸载时也复位，避免 suppressAutoStick 卡死为 true、
      // 自动粘底在本组件挂载期内永久失效。
      suppressAutoStick.value = false
      return
    }
    // 展开/折叠后补偿滚动量，保持标题行相对视口位置不跳。
    const after = target.getBoundingClientRect().top - el.value.getBoundingClientRect().top
    el.value.scrollTop += after - before
    suppressAutoStick.value = false
  })
}

function onOpenModal(content: string) {
  emit('openModal', content)
}

// 用户滚到底附近时「粘底」——新行来自动滚到底；用户主动上滚查看历史时不抢滚动
let stick = true
function onScroll() {
  const e = el.value
  if (!e) return
  scrollTop.value = e.scrollTop
  stick = e.scrollTop + e.clientHeight >= e.scrollHeight - lh * 2
}
watch(() => props.lines.length, () => {
  if (stick && !suppressAutoStick.value) nextTick(() => { if (el.value) el.value.scrollTop = el.value.scrollHeight })
})

let ro: ResizeObserver | null = null
onMounted(() => {
  const e = el.value
  if (!e) return
  viewportH.value = e.clientHeight
  ro = new ResizeObserver(() => { if (el.value) viewportH.value = el.value.clientHeight })
  ro.observe(e)
  nextTick(() => { if (el.value) el.value.scrollTop = el.value.scrollHeight })
})
onUnmounted(() => ro?.disconnect())
</script>

<style scoped>
.vlog {
  flex: 1; overflow: auto; min-height: 0;
  padding: 12px;
  font-family: 'JetBrains Mono', 'SF Mono', monospace;
  font-size: 12px; line-height: 20px;
  color: var(--workflow-controller-text, #1e293b); background: transparent; border-radius: 6px;
  white-space: pre;
}
.vlog-inner { position: relative; }
.vlog-flow { white-space: pre; }
.vlog-flow-line { min-height: 20px; white-space: pre-wrap; }
.tool-block { margin: 0; color: var(--workflow-controller-text, #cbd5e1); }
.tool-block-title { padding: 3px 0; color: var(--workflow-controller-text-muted, #94a3b8); }
/* 失败标识在折叠标题即可见：错误文本为空时展开态没有结果 <pre> 可着色。 */
.tool-block-title.failed,
.tool-block.expanded .tool-block-title.failed { color: #ff9ca3; }
.tool-block.expanded .tool-block-title { color: var(--workflow-controller-text, #f8fafc); }
.tool-block-body { margin: 0; border: 1px solid var(--workflow-controller-border, #b7b9c7); border-radius: 8px; overflow: hidden; background: var(--workflow-controller-surface, #111827); }
.tool-block-command { margin: 8px !important; padding: 8px; border-radius: 6px; background: var(--workflow-controller-tool-command-bg, #211f3b); color: var(--workflow-controller-tool-command-text, #a7e3b0); white-space: pre-wrap; overflow-wrap: anywhere; }
.tool-block-result { margin: 0; padding: 8px; border-top: 1px solid var(--workflow-controller-border, rgba(183,185,199,.28)); color: var(--workflow-controller-tool-result-text, #cbd5e1); font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; }
.tool-block-result.failed { color: #ff9ca3; }
.tool-block-full { padding: 6px 8px; border-top: 1px solid var(--workflow-controller-border, rgba(183,185,199,.28)); color: var(--workflow-controller-tool-command-text, #a7e3b0); font-size: 11px; cursor: pointer; user-select: none; }
.tool-block-full:hover { background: color-mix(in srgb, var(--workflow-controller-primary, #7c8cff) 8%, transparent); }
.vlog-truncated-hint { color: var(--workflow-controller-text-muted, #8f8f8f); font-style: italic; padding: 4px 8px; }
.vlog-line { position: absolute; left: 0; height: 20px; overflow: hidden; white-space: pre; }
.vlog-clickable { cursor: pointer; }
.vlog-clickable:hover { background: color-mix(in srgb, var(--workflow-controller-primary, #7c8cff) 12%, transparent); border-radius: 3px; }
.vlog-flow-line.cls-thinking.vlog-clickable:hover { background: transparent; color: var(--workflow-controller-text, #f8fafc); }
.vlog-flow-line.tool-block-line.vlog-clickable:hover { background: transparent; }
.vlog-empty { color: var(--workflow-controller-text-muted, #8f8f8f); }
/* hook 判定行按角色三色：门禁（plugin 结构判定）= cyan；Reviewer（llm 语义审查）
   = indigo；AUQ（需人工介入）= amber —— 三类角色一眼分清，跟 worker 灰色对话区分。
   动态 :class 在 scoped 下仍命中（元素带 data-v hash）。 */
.cls-hook-stop { color: var(--workflow-controller-primary, #034cff); font-weight: 500; }
.cls-hook-auq { color: #fbb73c; font-weight: 500; }
.cls-hook-eval { color: #12c905; font-weight: 500; }
</style>

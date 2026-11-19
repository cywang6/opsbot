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
  画布容器（相机模型，性能地基）：viewport（overflow-hidden + contain 隔离）
  × camera（平移单元素 transform，GPU 合成）× RunGraph。

  高清与顺滑的混合栅格策略（静态模糊的根因是 will-change 合成层缓存了
  zoom=1 的纹理，CSS scale 放大 = 拉伸缓存位图）：
  - 手势中（滚轮/按钮连击）：CSS scale 相对已栅格化尺寸拉伸——GPU 顺滑，
    允许瞬时轻微模糊（地图类产品惯例）
  - 手势落定（静默 160ms / 离散操作立即）：SVG 按 viewBox 重设 width/
    height = 内容尺寸 × 缩放，浏览器按最终显示分辨率矢量重栅格——静止
    状态任意缩放档位下文字线条始终高清；CSS scale 归 1，平移保持纯 translate

  手势期间暂停流动画（CSS 类）。缩放百分比命令式直更 textContent。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import RunGraph from './RunGraph.vue'
import type { NodeInstance, RunView } from '../lib/view-model'

const props = defineProps<{
  view: RunView
  nodesByKey: Map<string, NodeInstance>
  selectedKey: string | null
  /** 自动适配触发键（变化即 fit-to-view；undefined 不自动适配） */
  fitKey?: string
  /** 是否渲染「子图 ▸」入口（弹窗内画布无嵌套入口） */
  enableSubgraphEntry?: boolean
}>()

const emit = defineEmits<{
  selectNode: [key: string | null]
  openSubgraph: [key: string]
}>()

const MIN_ZOOM = 0.25
const MAX_ZOOM = 2.5
const toDomPrecision = (v: number) => Math.round(v * 1e4) / 1e4
const clampZoom = (z: number) => Math.min(Math.max(z, MIN_ZOOM), MAX_ZOOM)

const viewportRef = ref<HTMLDivElement | null>(null)
const cameraRef = ref<HTMLDivElement | null>(null)
const zoomLabelRef = ref<HTMLButtonElement | null>(null)
const graphRef = ref<InstanceType<typeof RunGraph> | null>(null)
const svgEl = computed(() => graphRef.value?.svgEl ?? null)

const camera = { x: 0, y: 0, z: 1 }
/** SVG 最近一次矢量重栅格时的缩放档位（CSS scale 相对它做手势期拉伸） */
let rasterZ = 1
let panMoved = false
let gestureTimer: number | null = null
let paused = false
// 布局尺寸镜像（普通变量）：相机操作不依赖响应式，避免无关重渲染
let dims = { w: 0, h: 0 }

function syncDims(): void {
  dims = { w: Math.max(props.view.layout.width, 200), h: props.view.layout.height }
}

function applyCamera(): void {
  const { x, y, z } = camera
  const s = z / rasterZ
  const el = cameraRef.value
  if (el) {
    el.style.transform =
      `translate(${toDomPrecision(x)}px, ${toDomPrecision(y)}px)` +
      (Math.abs(s - 1) > 1e-4 ? ` scale(${toDomPrecision(s)})` : '')
  }
  if (zoomLabelRef.value) zoomLabelRef.value.textContent = `${Math.round(z * 100)}%`
}

/** 相机落定：SVG 尺寸对齐逻辑缩放 → 矢量重栅格（高清），CSS scale 归 1 */
function commitCamera(): void {
  rasterZ = camera.z
  const svg = svgEl.value
  if (svg) {
    svg.setAttribute('width', String(toDomPrecision(dims.w * camera.z)))
    svg.setAttribute('height', String(toDomPrecision(dims.h * camera.z)))
  }
  applyCamera()
}

// 手势标记：抓取光标 + 暂停流动画（CSS 类；SVG 根 pauseAnimations 特性
// 检测降级，老引擎静默跳过功能不受损）
function setGesture(on: boolean): void {
  const vp = viewportRef.value
  if (!vp) return
  vp.classList.toggle('run-gesture', on)
  if (on === paused) return
  paused = on
  if (on) svgEl.value?.pauseAnimations?.()
  else svgEl.value?.unpauseAnimations?.()
}

function zoomAt(factor: number, cx?: number, cy?: number, immediate = false): void {
  const vp = viewportRef.value
  if (!vp) return
  const { x, y, z } = camera
  const next = clampZoom(z * factor)
  if (next === z) return
  const px = cx ?? vp.clientWidth / 2
  const py = cy ?? vp.clientHeight / 2
  // 光标锚点：缩放后保持视口点 (px, py) 下的内容点不动
  camera.x = px - (px - x) * (next / z)
  camera.y = py - (py - y) * (next / z)
  camera.z = next
  // 离散操作（工具条按钮）立即矢量重栅格；连击手势（滚轮）先 GPU 拉伸，
  // 静默 160ms 后落定重栅格
  if (immediate) {
    commitCamera()
  } else {
    applyCamera()
  }
  setGesture(true)
  if (gestureTimer !== null) window.clearTimeout(gestureTimer)
  gestureTimer = window.setTimeout(() => {
    commitCamera()
    setGesture(false)
    gestureTimer = null
  }, 160)
}

function resetCamera(): void {
  camera.x = 0
  camera.y = 0
  camera.z = 1
  commitCamera()
}

function fitToView(w: number, h: number): void {
  const vp = viewportRef.value
  if (!vp) return
  const availW = vp.clientWidth - 24
  const availH = vp.clientHeight - 24
  if (availW <= 0 || availH <= 0 || w <= 0 || h <= 0) {
    resetCamera()
    return
  }
  const z = clampZoom(Math.min(availW / w, availH / h))
  camera.x = (vp.clientWidth - w * z) / 2
  camera.y = (vp.clientHeight - h * z) / 2
  camera.z = z
  commitCamera()
}

// 挂载/视图切换：内容尺寸变化后立即重设 SVG 尺寸（渲染同步、无闪帧）
watch(() => props.view, () => {
  syncDims()
  commitCamera()
}, { immediate: true })

// 自动适配：fitKey 变化 = 子图弹窗打开或切换代际。首次打开在 onMounted 执行
// ——watch 的 immediate 轮在 DOM 插入前视口 ref 尚空，测不到尺寸
function autoFit(): void {
  if (props.fitKey === undefined) return
  fitToView(Math.max(props.view.layout.width, 200), props.view.layout.height)
}
watch(() => props.fitKey, autoFit)

// Ctrl/⌘+滚轮缩放（native listener，passive: false 才能 preventDefault）
function onWheel(e: WheelEvent): void {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  const el = viewportRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top)
}

// 原地点击空白（非拖拽、非节点）→ 取消选中，跑马灯熄灭
function onCanvasPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return
  // 节点（含子图 chip）上的按下不触发取消选中——由节点自身 click 处理
  const onNode = (e.target as Element).closest?.('.run-node') != null
  const start = { x: e.clientX, y: e.clientY }
  const startCam = { ...camera }
  panMoved = false
  const onMove = (ev: PointerEvent) => {
    const dx = ev.clientX - start.x
    const dy = ev.clientY - start.y
    if (!panMoved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      panMoved = true
      setGesture(true)
    }
    if (panMoved) {
      camera.x = startCam.x + dx
      camera.y = startCam.y + dy
      applyCamera()
    }
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    if (panMoved) {
      setGesture(false)
    } else if (!onNode) {
      emit('selectNode', null)
    }
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

function handleNodeSelect(key: string): void {
  if (panMoved) return
  emit('selectNode', props.selectedKey === key ? null : key)
}

const rootRef = ref<HTMLDivElement | null>(null)
function attachWheel(): void {
  rootRef.value?.querySelector('.run-viewport')?.addEventListener('wheel', onWheel as EventListener, { passive: false })
}
onMounted(() => {
  // 挂载后落定初始 SVG 尺寸（view-watch 的 immediate 轮在 DOM 插入前，refs 空）
  syncDims()
  commitCamera()
  autoFit()
  attachWheel()
})

onBeforeUnmount(() => {
  const el = rootRef.value?.querySelector('.run-viewport')
  el?.removeEventListener('wheel', onWheel as EventListener)
  if (gestureTimer !== null) window.clearTimeout(gestureTimer)
})

function fitAction(): void {
  fitToView(Math.max(props.view.layout.width, 200), props.view.layout.height)
}
</script>

<template>
  <div ref="rootRef" class="run-canvas-root">
    <div
      ref="viewportRef"
      class="run-canvas run-viewport"
      @pointerdown="onCanvasPointerDown"
    >
      <div ref="cameraRef" class="run-camera" style="transform-origin: 0 0">
        <RunGraph
          ref="graphRef"
          :view="view"
          :nodes-by-key="nodesByKey"
          :selected-key="selectedKey"
          :enable-subgraph-entry="enableSubgraphEntry"
          @select-node="handleNodeSelect"
          @open-subgraph="$emit('openSubgraph', $event)"
        />
      </div>
    </div>

    <!-- 缩放/适配工具条：左下角（右缘被侧栏玻璃面板占据） -->
    <div class="run-glass run-zoom-bar">
      <button type="button" title="缩小（Ctrl + 滚轮）" aria-label="缩小" class="run-tool-btn" @click="zoomAt(1 / 1.15, undefined, undefined, true)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="run-icon"><circle cx="11" cy="11" r="7" /><line x1="8" y1="11" x2="14" y2="11" /><line x1="20" y1="20" x2="16.5" y2="16.5" /></svg>
      </button>
      <button ref="zoomLabelRef" type="button" title="重置缩放" aria-label="重置缩放" class="run-tool-btn run-zoom-label" @click="resetCamera">100%</button>
      <button type="button" title="放大（Ctrl + 滚轮）" aria-label="放大" class="run-tool-btn" @click="zoomAt(1.15, undefined, undefined, true)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="run-icon"><circle cx="11" cy="11" r="7" /><line x1="8" y1="11" x2="14" y2="11" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="20" y1="20" x2="16.5" y2="16.5" /></svg>
      </button>
      <span class="run-tool-sep" aria-hidden="true" />
      <button type="button" title="适配画布" aria-label="适配画布" class="run-tool-btn" @click="fitAction">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="run-icon"><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /><path d="M3 16v3a2 2 0 0 0 2 2h3" /></svg>
      </button>
    </div>
  </div>
</template>

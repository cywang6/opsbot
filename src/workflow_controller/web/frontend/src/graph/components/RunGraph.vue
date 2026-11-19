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
  Run DAG 图（纯 SVG，禁图表库）。布局由 view-model 预计算（rank y / 代带
  x：带内依赖自上而下流，代带为纵向列），本组件只渲染：代带条带、同代依赖
  边（源底 → 虚拟点 → 目标顶的正交走线，水平过渡只进行间隙）、回滚边
  （跨带正交虚线 + 暗底 chip 标签）、节点（暗底卡 + 状态圆点）。色板见
  lib/run-theme.ts。

  交互语义：跑马灯按需点亮——默认全部静止，选中节点后其关联边（直接连出/
  连入）以状态色加粗 + 白色蚂蚁线流动，其余边压暗；回滚虚线爬行同理。走线
  交叉处做 PCB 式半圆跳线（水平段跳过垂直段），表达「交叉不相连」。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { NodeInstance, RunView } from '../lib/view-model'
import { NODE_W, NODE_H, wrapNodeLabel, truncateToWidth } from '../lib/view-model'
import { nudgeParallelRuns, vChainPoints } from '../lib/edge-geometry'
import {
  RUN_COLORS, STATUS_TINT_OPACITY, flowColor, statusColor, statusLabel,
} from '../lib/run-theme'

const props = defineProps<{
  view: RunView
  nodesByKey: Map<string, NodeInstance>
  selectedKey: string | null
  /** 是否渲染「子图 ▸」入口（子图弹窗内画布无嵌套入口） */
  enableSubgraphEntry?: boolean
}>()

const emit = defineEmits<{
  selectNode: [key: string]
  openSubgraph: [key: string]
}>()

// 根 `<svg>` 元素：上层画布相机缩放落定后据此重设 width/height 做矢量重栅格。
// 以 defineExpose 暴露而非让父组件访问 `$el`——`$el` 依赖根节点恰为 `<svg>`，
// 加包裹层或多根节点即失效。
const svgRoot = ref<SVGSVGElement | null>(null)
defineExpose({
  get svgEl(): SVGSVGElement | null {
    return svgRoot.value
  },
})

/** 节点名断行：单行或双行（分隔符平衡断），卡片收窄后长名不截断。 */
function titleLines(node: NodeInstance): string[] {
  return wrapNodeLabel(node.label, NODE_W - 28)
}

const TASK_TYPE_LABEL: Record<NodeInstance['taskType'], string> = {
  agent: 'agent',
  bash: 'bash',
  generator: '生成器',
  workflow: '子图',
}

/** 子图入口微章（元信息行微章簇成员，与状态微章同构）：宽度与簇内间距 */
const SUB_ENTRY_W = 38
const SUB_ENTRY_GAP = 6

const HOP_R = 4.5

interface Pt { x: number; y: number }

/** PCB 式交叉跳线收集：不同边的水平段与垂直段相交时，水平段在交叉点做
 *  半圆突起（垂直段直行）——「交叉不相连」的电路图语义。段端保护带
 *  （margin）内不放跳线（避开节点锚点与拐角 fillet），端点重合处是汇聚
 *  连接而非交叉；同段多个跳线保持间距。返回 `${edgeId}:${段索引}` →
 *  跳线位置列表（距段起点距离）。 */
function collectHops(edges: Array<{ id: string; pts: Pt[] }>, margin: number): Map<string, number[]> {
  const raw = new Map<string, number[]>()
  for (let a = 0; a < edges.length; a++) {
    for (let b = a + 1; b < edges.length; b++) {
      for (let i = 0; i < edges[a].pts.length - 1; i++) {
        const s1 = edges[a].pts[i]
        const e1 = edges[a].pts[i + 1]
        if (s1.x === e1.x && s1.y === e1.y) continue
        for (let j = 0; j < edges[b].pts.length - 1; j++) {
          const s2 = edges[b].pts[j]
          const e2 = edges[b].pts[j + 1]
          if (s2.x === e2.x && s2.y === e2.y) continue
          const h1 = s1.y === e1.y
          const h2 = s2.y === e2.y
          if (h1 === h2) continue // 平行（含共享主干的共线重叠——连接而非交叉）
          const hs = h1 ? [s1, e1] : [s2, e2]
          const vs = h1 ? [s2, e2] : [s1, e1]
          const owner = h1 ? edges[a] : edges[b]
          const segIdx = h1 ? i : j
          const x = vs[0].x
          const y = hs[0].y
          const hxMin = Math.min(hs[0].x, hs[1].x)
          const hxMax = Math.max(hs[0].x, hs[1].x)
          const vyMin = Math.min(vs[0].y, vs[1].y)
          const vyMax = Math.max(vs[0].y, vs[1].y)
          if (x <= hxMin + 0.5 || x >= hxMax - 0.5 || y <= vyMin + 0.5 || y >= vyMax - 0.5) continue
          const dist = Math.abs(x - hs[0].x)
          const len = hxMax - hxMin
          if (dist < margin || dist > len - margin) continue
          const key = `${owner.id}:${segIdx}`
          const list = raw.get(key) ?? []
          list.push(dist)
          raw.set(key, list)
        }
      }
    }
  }
  const hops = new Map<string, number[]>()
  for (const [key, list] of raw) {
    list.sort((p, q) => p - q)
    const kept: number[] = []
    for (const d of list) {
      if (kept.length === 0 || d - kept[kept.length - 1] >= 2 * HOP_R + 1) kept.push(d)
    }
    hops.set(key, kept)
  }
  return hops
}

/** 折线圆角化 + 段内跳线：拐点用小二次曲线 fillet（r≈4px，非曲线走线）；
 *  hopsBySeg 为跳线位置（距段起点距离），以半圆弧 A 命令突起。 */
function roundedPolyline(pts: Array<{ x: number; y: number }>, r = 4, hopsBySeg: number[][] = []): string {
  if (pts.length < 2) return ''
  let d = `M ${pts[0].x} ${pts[0].y}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i]
    const q = pts[i + 1]
    const len = Math.hypot(q.x - p.x, q.y - p.y)
    if (len < 0.01) continue
    const ux = (q.x - p.x) / len
    const uy = (q.y - p.y) / len
    const at = (t: number) => `${p.x + ux * t} ${p.y + uy * t}`
    let endCut = 0
    let outLen = 0
    if (i < pts.length - 2) {
      const next = pts[i + 2]
      outLen = Math.hypot(next.x - q.x, next.y - q.y)
      endCut = Math.min(r, len / 2, outLen / 2)
    }
    const hops = (hopsBySeg[i] ?? [])
      .filter(h => h - HOP_R > 4 && h + HOP_R < len - endCut)
      .sort((x, y) => x - y)
    for (const h of hops) {
      d += ` L ${at(h - HOP_R)} A ${HOP_R} ${HOP_R} 0 0 1 ${at(h + HOP_R)}`
    }
    d += ` L ${at(len - endCut)}`
    if (endCut >= 0.5) {
      const next = pts[i + 2]
      const ox = (next.x - q.x) / (outLen || 1)
      const oy = (next.y - q.y) / (outLen || 1)
      d += ` Q ${q.x} ${q.y} ${q.x + ox * endCut} ${q.y + oy * endCut}`
    }
  }
  return d
}

/** 横向正交走线（回滚边跨带）：源右缘 → 带隙中竖 → 目标左缘。 */
function hChainPoints(sx: number, sy: number, tx: number, ty: number): Array<{ x: number; y: number }> {
  if (Math.abs(sy - ty) < 1) return [{ x: sx, y: sy }, { x: tx, y: ty }]
  const midX = (sx + tx) / 2
  return [
    { x: sx, y: sy },
    { x: midX, y: sy },
    { x: midX, y: ty },
    { x: tx, y: ty },
  ]
}

// ── 派生几何（纯 computed，视图变化时全量重算——布局为确定性纯函数）──
const layout = computed(() => props.view.layout)
const nodes = computed(() =>
  props.view.nodeKeys.map(k => props.nodesByKey.get(k)).filter((n): n is NodeInstance => n !== undefined))
const hasSel = computed(() => props.selectedKey !== null)
const contentW = computed(() => Math.max(layout.value.width, 200))
const statuses = computed(() => [...new Set(nodes.value.map(n => n.status))])

interface EdgeGeomOut { id: string; chain?: { from: string; to: string }; link?: { ordinal: number; label: string; from: string; to: string }; pts: Pt[] }

// 边折线（依赖 + 回滚）先统一计算，再收集 PCB 交叉跳线，最后渲染——
// 跳线在 base 与流光叠加层共享同一条 d
const depGeoms = computed<EdgeGeomOut[]>(() =>
  props.view.edgeChains.flatMap(chain => {
    const a = layout.value.positions[chain.from]
    const b = layout.value.positions[chain.to]
    if (!a || !b) return []
    // 端口偏移：扇出/扇入 ≥3 时锚点沿节点缘错开（view-model 7e），缺省中心
    const pts = vChainPoints([
      { x: a.x + NODE_W / 2 + (chain.fromDx ?? 0), y: a.y + NODE_H },
      ...chain.bends,
      { x: b.x + NODE_W / 2 + (chain.toDx ?? 0), y: b.y },
    ])
    return [{ id: `dep:${chain.from}->${chain.to}`, chain, pts }]
  }))
// 平行段错开：共线重叠的垂直段横向错开（主干全同叠线保留）——在跳线
// 检测前应用，跳线按错开后的最终几何计算
const depNudged = computed(() => nudgeParallelRuns(depGeoms.value))
const rbGeoms = computed<EdgeGeomOut[]>(() =>
  props.view.rollbackLinks.flatMap(link => {
    const a = layout.value.positions[link.from]
    const b = layout.value.positions[link.to]
    if (!a || !b) return []
    let pts: Array<{ x: number; y: number }>
    if (b.x > a.x + NODE_W + 8) {
      pts = hChainPoints(a.x + NODE_W, a.y + NODE_H / 2, b.x, b.y + NODE_H / 2)
    } else {
      const topY = Math.min(a.y, b.y) - 18
      pts = [
        { x: a.x + NODE_W / 2, y: a.y },
        { x: a.x + NODE_W / 2, y: topY },
        { x: b.x + NODE_W / 2, y: topY },
        { x: b.x + NODE_W / 2, y: b.y },
      ]
    }
    return [{ id: `rb:${link.ordinal}`, link, pts }]
  }))
const hops = computed(() => collectHops([...depNudged.value, ...rbGeoms.value], HOP_R + 5))
function hopsOf(id: string, pts: Array<{ x: number; y: number }>): number[][] {
  return pts.slice(0, -1).map((_, i) => hops.value.get(`${id}:${i}`) ?? [])
}
function edgePath(id: string, pts: Pt[]): string {
  return roundedPolyline(pts, 4, hopsOf(id, pts))
}
function rbMid(pts: Pt[]): Pt {
  return pts.length === 2
    ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
    : { x: (pts[1].x + pts[2].x) / 2, y: (pts[1].y + pts[2].y) / 2 }
}
function depTarget(to: string): NodeInstance | undefined {
  return props.nodesByKey.get(to)
}
function isDepRelated(chain: { from: string; to: string }): boolean {
  return hasSel.value && (chain.from === props.selectedKey || chain.to === props.selectedKey)
}
function isRbRelated(link: { from: string; to: string }): boolean {
  return hasSel.value && (link.from === props.selectedKey || link.to === props.selectedKey)
}

function subTextOf(node: NodeInstance): string {
  const retries = Math.max(node.attempts.length - 1, 0)
  return `${TASK_TYPE_LABEL[node.taskType]}${retries > 0 ? ` · 重试 ${retries}` : ''}${node.executionState === 'carried' ? ' · 承接' : ''}`
}

/** 元信息行右侧微章簇总宽：状态微章 + （主画布内）子图入口微章。
    弹窗画布无嵌套入口，自动回到仅状态微章的宽度。 */
function metaClusterInset(node: NodeInstance): number {
  const pill = pillWidth(statusLabel(node.status))
  return props.enableSubgraphEntry && node.hasSubgraph
    ? pill + SUB_ENTRY_GAP + SUB_ENTRY_W
    : pill
}

/** 元信息行展示文本：为右侧微章簇留位后超宽尾部省略。 */
function metaText(node: NodeInstance): string {
  const avail = NODE_W - 26 - 8 - metaClusterInset(node)
  return truncateToWidth(subTextOf(node), avail, 10)
}

/** 状态微章宽度：CJK 字符按 9px 估宽 + 12px 水平呼吸。 */
function pillWidth(label: string): number {
  return label.length * 9 + 12
}

function onNodeClick(key: string): void {
  emit('selectNode', key)
}
function onSubgraphClick(key: string): void {
  emit('openSubgraph', key)
}
</script>

<template>
  <svg
    ref="svgRoot"
    class="graph-dag"
    :viewBox="`0 0 ${contentW} ${layout.height}`"
    role="img"
    :aria-label="view.title"
  >
    <defs>
      <marker id="run-dep-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0,0 L8,4 L0,8 z" :fill="RUN_COLORS.edge" />
      </marker>
      <!-- 选中态箭头随目标状态着色（状态值均为字母，id 安全） -->
      <marker
        v-for="st in statuses" :key="st" :id="`run-dep-arrow-${st}`"
        viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"
      >
        <path d="M0,0 L8,4 L0,8 z" :fill="flowColor(st)" />
      </marker>
      <marker id="run-rollback-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0,0 L8,4 L0,8 z" :fill="RUN_COLORS.rollback" />
      </marker>
    </defs>

    <!-- 代带列：v9 图底统一——带只保留带顶标签（回滚带带红点），
         不再画整列面填充（半透明涂层会拼成洗亮盒子，与底色割裂） -->
    <g v-for="band in layout.bands" :key="band.generation">
      <circle v-if="band.generation > 0" :cx="band.x + 19" cy="21.5" r="3" :fill="RUN_COLORS.rollback" fill-opacity="0.8" />
      <text
        :x="band.x + (band.generation > 0 ? 28 : 14)" y="25" font-size="11"
        :fill="band.generation > 0 ? RUN_COLORS.rollback : RUN_COLORS.textMuted"
        fill-opacity="0.9" letter-spacing="0.02em"
      >{{ band.label }}</text>
    </g>

    <!-- 同代依赖边链：正交走线。跑马灯按需点亮：默认静止，选中节点后其
        关联边以状态色加粗 + 白色蚂蚁线流动（运行中提速），其余边压暗；
        交叉处 PCB 半圆跳线 -->
    <g
      v-for="g in depNudged" :key="g.id" class="run-edge"
      :opacity="hasSel && !isDepRelated(g.chain!) ? 0.35 : 1"
    >
      <path
        class="run-dep"
        :d="edgePath(g.id, g.pts)"
        fill="none"
        :stroke="isDepRelated(g.chain!) ? flowColor(depTarget(g.chain!.to)?.status ?? 'pending') : RUN_COLORS.edge"
        :stroke-width="isDepRelated(g.chain!) ? 2 : 1.5"
        :marker-end="isDepRelated(g.chain!) && depTarget(g.chain!.to) ? `url(#run-dep-arrow-${depTarget(g.chain!.to)!.status})` : 'url(#run-dep-arrow)'"
      />
      <path
        v-if="isDepRelated(g.chain!)"
        :d="edgePath(g.id, g.pts)"
        fill="none"
        :class="depTarget(g.chain!.to)?.status === 'running' ? 'run-edge-flow run-edge-flow-active' : 'run-edge-flow'"
        :stroke="RUN_COLORS.canvas"
        stroke-width="1.6"
      />
    </g>

    <!-- 回滚边：目标带在右 → 正交跨带；同带异常数据兜底上绕。虚线爬行只在
        选中关联时点亮，chip 标签挂路径中点 -->
    <g
      v-for="g in rbGeoms" :key="g.id" class="run-rb"
      :opacity="hasSel && !isRbRelated(g.link!) ? 0.35 : 1"
    >
      <path
        :d="edgePath(g.id, g.pts)"
        fill="none"
        :stroke="RUN_COLORS.rollback"
        :stroke-width="isRbRelated(g.link!) ? 1.8 : 1.4"
        stroke-dasharray="5 4"
        :class="isRbRelated(g.link!) ? 'run-rb-flow' : undefined"
        marker-end="url(#run-rollback-arrow)"
      />
      <rect
        :x="rbMid(g.pts).x - (g.link!.label.length * 6.2 + 18) / 2"
        :y="rbMid(g.pts).y - 14"
        :width="g.link!.label.length * 6.2 + 18"
        height="17"
        rx="8.5"
        :fill="RUN_COLORS.canvas"
        :stroke="RUN_COLORS.rollback"
        stroke-opacity="0.45"
        stroke-width="1"
      />
      <text :x="rbMid(g.pts).x" :y="rbMid(g.pts).y - 2" font-size="9.5" :fill="RUN_COLORS.rollback" text-anchor="middle">{{ g.link!.label }}</text>
    </g>

    <!-- 节点：编辑级排版卡——质感来自比例/留白/字重层级：中性发丝边框 +
         抬升面 + 5% 状态洗染（远读辨识）；标题行整行留白，发丝分隔线，
         元信息行 mono，状态收进右下微章。副文本语义（重试/承接）保持 e2e 锚点 -->
    <g
      v-for="node in nodes" :key="node.key"
      :transform="`translate(${layout.positions[node.key]?.x ?? 0}, ${layout.positions[node.key]?.y ?? 0})`"
      class="run-node cursor-pointer"
      :class="{ selected: selectedKey === node.key, carried: node.executionState === 'carried' }"
      :style="{ '--node-st': statusColor(node.status) }"
      @click.stop="onNodeClick(node.key)"
    >
      <!-- 阴影底板：dy+2 半透明黑，与盒体同圆角（静态元素，相机合成零成本） -->
      <rect class="run-node-shadow" x="0" y="2.5" :width="NODE_W" :height="NODE_H" rx="10" />
      <template v-if="selectedKey === node.key">
        <!-- 玻璃高光外圈：双层同心光晕（状态色随行），描边提亮为全状态色 -->
        <rect x="-4.5" y="-4.5" :width="NODE_W + 9" :height="NODE_H + 9" rx="14.5" fill="none" :stroke="statusColor(node.status)" stroke-opacity="0.32" stroke-width="1.5" />
        <rect x="-9" y="-9" :width="NODE_W + 18" :height="NODE_H + 18" rx="19" fill="none" :stroke="statusColor(node.status)" stroke-opacity="0.12" stroke-width="2.5" />
      </template>
      <rect
        class="run-node-box"
        :width="NODE_W" :height="NODE_H" rx="10"
        :fill="RUN_COLORS.nodeFill"
      />
      <!-- 状态轻染：抬升面上的低透明度 overlay（彩色只留给状态；run-node-wash 为状态语义锚点） -->
      <rect class="run-node-wash" :width="NODE_W" :height="NODE_H" rx="10" :fill="statusColor(node.status)" :fill-opacity="STATUS_TINT_OPACITY" />
      <!-- 发丝分隔线：标题区（可两行）与元信息区的编辑结构 -->
      <line class="run-node-divider" x1="14" y1="44" :x2="NODE_W - 14" y2="44" />
      <!-- 节点名：单行光学居中；长名两行（tspan 承载，textContent 仍为完整名） -->
      <text font-size="13" font-weight="500" letter-spacing="0.02em" :fill="RUN_COLORS.textPrimary">
        <tspan
          v-for="(ln, i) in titleLines(node)"
          :key="i"
          x="14"
          :y="titleLines(node).length === 1 ? 30 : i === 0 ? 20 : 36"
        >{{ ln }}</tspan>
      </text>
      <text class="run-node-meta" x="14" y="56" font-size="10" :fill="RUN_COLORS.textMuted">{{ metaText(node) }}</text>
      <!-- 状态微章：元信息行微章簇右端（无边框平色块：状态色 12% 底 + 状态色文字） -->
      <g :transform="`translate(${NODE_W - 12 - pillWidth(statusLabel(node.status))}, 45)`">
        <rect :width="pillWidth(statusLabel(node.status))" height="15" rx="3.5" :fill="statusColor(node.status)" fill-opacity="0.12" />
        <text :x="pillWidth(statusLabel(node.status)) / 2" y="10.8" text-anchor="middle" font-size="8.5" font-weight="600" letter-spacing="0.05em" :fill="statusColor(node.status)">{{ statusLabel(node.status) }}</text>
      </g>
      <!-- 悬停原生 tooltip：完整节点名（SVG title） -->
      <title>{{ node.label }}</title>
      <!-- 子图入口微章：元信息行微章簇成员（状态微章左侧，同构胶囊 + 描边/
           指针/hover 强化以示可点）。v10 收进卡片包络：图底统一后卡片由状态
           色描边定义，跨出描边的元素会打断卡的视觉完整性；弹窗内画布无嵌套入口 -->
      <g
        v-if="node.hasSubgraph && enableSubgraphEntry"
        class="run-sub-entry cursor-pointer"
        :transform="`translate(${NODE_W - 12 - metaClusterInset(node)}, 45)`"
        @click.stop="onSubgraphClick(node.key)"
      >
        <rect class="run-sub-entry-bg" :width="SUB_ENTRY_W" height="15" rx="7.5" />
        <text class="run-sub-entry-text" :x="SUB_ENTRY_W / 2" y="11" font-size="9" text-anchor="middle">子图 ▸</text>
        <title>打开子图</title>
      </g>
    </g>
  </svg>
</template>

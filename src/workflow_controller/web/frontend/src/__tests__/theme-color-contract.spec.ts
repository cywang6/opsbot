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

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function source(path: string) {
  return readFileSync(join(srcRoot, path), 'utf8')
}

describe('普通颜色使用主题令牌的回归约定', () => {
  it('Run 元信息、事件和提示不使用旧的固定颜色', () => {
    const runView = source('views/RunView.vue')
    expect(runView).toContain('color:var(--workflow-controller-text-muted, #6f6f6f)')
    expect(runView).toContain('color-mix(in srgb, #f0a020 12%, var(--workflow-controller-surface, #fff7e6))')
    expect(runView).not.toContain('color:#6f6f6f')

    const events = source('components/RunEventStream.vue')
    expect(events).toContain('color: var(--workflow-controller-primary, #0b6bcb)')
    expect(events).toContain('background: color-mix(in srgb, #f0a020 12%, var(--workflow-controller-surface, #fff7e6))')
  })

  it('告警提示文字色保持固定语义，不随主题正文色退化', () => {
    const runView = source('views/RunView.vue')
    expect(runView).toContain('.state-error-hint')
    expect(runView).toContain('color: #c2551c;')
    expect(runView).not.toContain('var(--workflow-controller-text, #c2551c)')

    const events = source('components/RunEventStream.vue')
    expect(events).toContain('.retry-hint')
    expect(events).toContain('color: #c2551c;')
    expect(events).not.toContain('var(--workflow-controller-text, #c2551c)')
  })

  it('Run 成员行和成员表使用主题文字、边框与 hover', () => {
    const row = source('components/RunMemberRow.vue')
    expect(row).toContain('border-bottom: 1px solid var(--workflow-controller-divider, #f0f0f0)')
    expect(row).toContain('.member-row:hover { background: var(--workflow-controller-hover, #fafafa); }')
    expect(row).toContain('color: var(--workflow-controller-text-muted, #6f6f6f)')

    const table = source('components/RunSessionsTable.vue')
    expect(table).not.toContain('color:#6f6f6f')
    expect(table).toContain('color:var(--workflow-controller-text-muted, #6f6f6f)')
  })

  it('Graph DAG 渲染内核（insight 移植）跟随主题令牌', () => {
    // 画布中性色经 --run-* 桥接 --workflow-controller-* 令牌（含弹窗 teleport 场景）
    const panel = source('plugins/graph/ui/RunDagPanel.vue')
    expect(panel).toContain('--run-canvas: var(--workflow-controller-surface, #ffffff)')
    expect(panel).toContain('--run-edge: var(--workflow-controller-border, #d0d7de)')
    expect(panel).toContain('--run-text-muted: var(--workflow-controller-text-muted, #57606a)')
    // v8 图底统一：卡片底色与画布同色，节点由状态色描边定义
    expect(panel).toContain('--run-node-fill: var(--run-canvas)')
    // v10 子图入口微章（元信息行微章簇成员）：accent 经 --run-* 桥接（亮暗双档）
    expect(panel).toContain('.run-sub-entry-bg {')
    expect(panel).toContain('fill: var(--run-accent, #8250df)')
    expect(panel).toContain('--run-accent: #a371f7')

    const detail = source('graph/components/RunNodeDetail.vue')
    expect(detail).toContain('color: var(--workflow-controller-primary, #0b6bcb)')

    // 状态色为语义色 var() 引用（亮档作回退值），暗档由 data-theme-mode 切换
    const theme = source('graph/lib/run-theme.ts')
    expect(theme).toContain('passed: { label: "通过", color: "var(--run-st-passed, #1a7f37)" }')
    expect(theme).toContain('failed: { label: "失败", color: "var(--run-st-failed, #cf222e)" }')

    // 暗色档：状态色提亮 + 点阵/阴影双档（暗色可读性）；v8 图底统一后
    // node-fill 无暗档覆盖（亮暗同为 canvas 同色）
    expect(panel).toContain("html[data-theme-mode='dark']")
    expect(panel).toContain('--run-st-passed: #3fb950')
    expect(panel).toContain('--run-st-failed: #f85149')
    expect(panel).toContain('--run-dot: rgba(240, 246, 252, 0.055)')
    // v9 图底统一：点阵为 viewport CSS 背景（屏幕固定、铺满无边界），
    // 不再画进内容尺寸的 SVG（缩小时会形成洗亮盒子与底色割裂）
    expect(panel).toContain('radial-gradient(circle, var(--run-dot) 0.9px, transparent 0.9px)')
    expect(panel).toContain('--run-shadow: rgba(0, 0, 0, 0.45)')

    // 明暗档切换键由 useAppearance 落 data 属性
    const appearance = source('composables/useAppearance.ts')
    expect(appearance).toContain('root.dataset.themeMode = selected.mode')

    // 状态透明度变体用 color-mix 派生（var() 引用不可作十六进制后缀拼接）
    expect(detail).toContain('color-mix(in srgb, ${c} 35%, transparent)')
  })

  it('Watchdog 正文和指标卡跟随主题', () => {
    const watchdog = source('components/common/WatchdogAlerts.vue')
    expect(watchdog).toContain('color:var(--workflow-controller-text, #3a3a3a)')
    expect(watchdog).toContain('background:var(--workflow-controller-surface, #fafafa)')
    expect(watchdog).toContain('border:1px solid var(--workflow-controller-border, #e8e8e8)')
    expect(watchdog).not.toContain('color:#3a3a3a')
    expect(watchdog).not.toContain('background:#fafafa')
  })

  it('Session 补充指令与长文本弹窗在深浅主题下均有对比度', () => {
    const session = source('views/SessionDetailView.vue')
    expect(session).toContain('background:color-mix(in srgb, #52c41a 8%, var(--workflow-controller-surface, #eef9ee))')
    expect(session).toContain('background:color-mix(in srgb, var(--workflow-controller-primary, #4078f2) 8%, var(--workflow-controller-surface, #ecf3ff))')
    expect(session).toContain('.hint-text-pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 11px; color: var(--workflow-controller-text-muted, #cbd5e1);')
    expect(session).toContain('.log-modal-pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; color: var(--workflow-controller-text, #cbd5e1);')
  })

  it('Settings 的链接、说明文字、代码和路径块使用主题令牌', () => {
    const settings = source('components/SettingsModal.vue')
    expect(settings).toContain('color:var(--workflow-controller-primary, #034cff)')
    expect(settings).toContain('background:var(--workflow-controller-code, #f3f3f3)')
    expect(settings).toContain('color:var(--workflow-controller-code-text, #1f2328)')
    expect(settings).toContain('background:var(--workflow-controller-surface, #fafafa)')
    expect(settings).toContain('color:var(--workflow-controller-text, #3a3a3a)')
    expect(settings).not.toContain('color:#6f6f6f')
    expect(settings).not.toContain('color:#3a3a3a')
  })

  it('通用 VirtualLog 的 hover 和辅助文字使用主题令牌', () => {
    const log = source('components/common/VirtualLog.vue')
    expect(log).toContain('.vlog-clickable:hover { background: color-mix(in srgb, var(--workflow-controller-primary, #7c8cff) 12%, transparent);')
    expect(log).toContain('.vlog-empty { color: var(--workflow-controller-text-muted, #8f8f8f); }')
    expect(log).toContain('.vlog-truncated-hint { color: var(--workflow-controller-text-muted, #8f8f8f);')
    expect(log).toContain('.cls-hook-stop { color: var(--workflow-controller-primary, #034cff);')
    expect(log).not.toContain('.vlog-clickable:hover { background: #ecf3ff;')
  })
})

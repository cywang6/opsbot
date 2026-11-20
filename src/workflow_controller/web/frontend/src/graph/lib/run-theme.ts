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
// Run 图主题（自 context-insight 移植，适配 workflow-controller 主题令牌）：
// 色板单点声明（彩色只留给状态与强调）。SVG 与 DOM 两侧共用，禁止散落
// 硬编码。画布中性色经 --run-* CSS 变量桥接 --workflow-controller-* 令牌
// （变量声明见 RunDagPanel.vue），深浅主题同源；状态色为固定语义色，
// 亮/暗两档经 --run-st-* 桥接（亮档为回退值，暗档由 data-theme-mode 切换）。

export interface RunStatusMeta {
  label: string;
  color: string;
}

/** 状态语义色亮/暗双档：亮档作 var() 回退值，暗档在 RunDagPanel 的
 * html[data-theme-mode='dark'] 声明（对齐 GitHub Dark 语义色亮度）。 */
const STATUS_COLOR_LIGHT: Record<string, string> = {
  passed: "#1a7f37",
  failed: "#cf222e",
  running: "#9a6700",
  stopped: "#0969da",
  pending: "#8c959f",
  carried: "#1b7c83",
  unknown: "#57606a",
};

export const RUN_STATUS_META: Record<string, RunStatusMeta> = {
  passed: { label: "通过", color: "var(--run-st-passed, #1a7f37)" },
  failed: { label: "失败", color: "var(--run-st-failed, #cf222e)" },
  running: { label: "运行中", color: "var(--run-st-running, #9a6700)" },
  stopped: { label: "已停止", color: "var(--run-st-stopped, #0969da)" },
  pending: { label: "待定", color: "var(--run-st-pending, #8c959f)" },
  carried: { label: "承接", color: "var(--run-st-carried, #1b7c83)" },
  unknown: { label: "未知", color: "var(--run-st-unknown, #57606a)" },
};

/** 画布中性色：值为 CSS 变量引用（SVG 属性位取值时由 --run-* 桥接层解析）。 */
export const RUN_COLORS = {
  canvas: "var(--run-canvas, #ffffff)",
  nodeFill: "var(--run-node-fill, #f6f8fa)",
  textPrimary: "var(--run-text-primary, #1f2328)",
  textMuted: "var(--run-text-muted, #57606a)",
  textFaint: "var(--run-text-faint, #8c959f)",
  edge: "var(--run-edge, #d0d7de)",
  flow: "var(--run-flow, #8c959f)",
  rollback: "var(--run-st-failed, #cf222e)",
  accent: "var(--run-accent, #8250df)",
} as const;

export function statusColor(status: string): string {
  return RUN_STATUS_META[status]?.color ?? RUN_STATUS_META.unknown.color;
}

/** 亮档语义色的原值（var() 引用不可作字符串运算的场景，如十六进制透明度
 *  拼接的旧用法——新代码应改用 color-mix 与 var() 引用）。 */
export function statusColorValue(status: string): string {
  return STATUS_COLOR_LIGHT[status] ?? STATUS_COLOR_LIGHT.unknown;
}

/** 边流光颜色：跟随目标节点状态（通过=绿 / 运行中=琥珀 / 失败=红 / 承接=青），
 *  未执行（待定/未知）用中性灰——没跑过的管线不发光。 */
export function flowColor(status: string): string {
  if (status === "pending" || status === "unknown") return RUN_COLORS.flow;
  return statusColor(status);
}

export function statusLabel(status: string): string {
  return RUN_STATUS_META[status]?.label ?? status;
}

/** 状态轻染：盒体抬升面上的状态色 overlay 透明度（描边宽窄与配色在
 *  RunDagPanel 的 .run-node-box CSS 单点管理）。 */
export const STATUS_TINT_OPACITY = 0.08;

export function bandLabel(generation: number): string {
  return generation === 0 ? "第 1 次运行" : `回滚 #${generation}`;
}

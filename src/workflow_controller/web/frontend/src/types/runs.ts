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

// runs API (/api/v1/runs) 契约类型。

// run 状态值集（未知值后端原样透传，消费侧按 string 兜底）
export type RunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped'

// run 类别：workflow 程序+驱动 / container 显式纯容器 / implicit 归属自动铸造
export type RunKind = 'workflow' | 'container' | 'implicit'

// run 账面行（列表与详情共用）
export interface RunRecord {
  run_id: string
  kind: RunKind
  format: string
  status: RunStatus
  program_ref: string
  params: Record<string, string>
  label: string | null
  work_dir: string | null
  max_parallel: number | null
  pause_reason: string | null
  created_at: string
  finished_at: string | null
  reopened_at: string | null
  error: string | null
  // 列表面聚合列（仅列表端点填充；单 run 端点为 0）
  member_count?: number
  running_count?: number
}

// run 成员 session 行（role/context 为归属四元组的两翼，context 驱动私有标签）
export interface RunSession {
  session_id: string
  role: string
  context: string | null
  state: string
  stop_reason: string | null
  in_flight: boolean
}

// run 键进程句柄（returncode null = 在途）
export interface RunProcess {
  proc_id: string
  context: string | null
  returncode: number | null
}

// run 任务运行时指标（run 任务不在时整段为 null）
export interface RunMetrics {
  rounds: number
  queue_depth: number
  deferred: number
  in_flight: number
}

// 通用面 + 驱动投影透传（driver 形状由驱动定义并带 schema_version）
export interface RunState {
  run_id: string
  status: RunStatus
  kind: RunKind
  format: string
  sessions: RunSession[]
  processes: RunProcess[]
  driver: Record<string, unknown> | null
  metrics: RunMetrics | null
  root: string
}

// run 事件流条目（两源合并序）：run 键事件与成员 session 事件
export interface RunEvent {
  id: number
  source: 'run_events' | 'events'
  run_id: string
  context: string | null
  timestamp: string
  event_type: string
  data: Record<string, unknown>
  // 成员事件专有：对外幂等 id 与所属 session
  uuid?: string
  session_id?: string
  iteration?: number
}

// 事件端点一页应答；limit 为服务端钳制后实际生效页长（「页满」判据以此为准）
export interface RunEventsPage {
  events: RunEvent[]
  next_cursor: string
  limit: number
}

// 导出结果汇总：压缩包已触发浏览器下载，回传会话/成员/关系计数与完整性
export interface RunExportSummary {
  members: number
  relations: number
  sessions: number
  complete: boolean
}

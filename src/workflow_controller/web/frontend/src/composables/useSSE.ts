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

import { computed, ref } from 'vue'
import type { SessionInfo, PipelineSnapshot, UsageSnapshot, ConfigInfo, ClaudeEvent, HandoffState, LoopState } from '../types/api'
import { isWaitingRelevantEvent, waitingInputKind, type WaitingInputKind } from '../utils/waitingInput'

export type PipelineMap = Record<string, PipelineSnapshot>

// events 数组上限（环形）：防无限增长 + 每 event 全数组复制的 O(n²)。
// 超出丢最旧。调大 → 更多回滚历史（VirtualLog 虚拟滚动，行数多不卡），代价是内存 +
// 每事件 log 重算（都 O(上限)，有界）。2000 ≈ 当前 300 的 6.7×，覆盖一个完整多轮 session。
export const MAX_EVENTS = 2000

// 高频遥测 event，不入 events.value：每个 delta 一条，会淹没 log + 占满 events 上限，
// 把真正要回看的输出挤出窗口。thinking 内容走 assistant_message 的 thinking 块；
// token 用量有独立的 usage_update 通道。以后再有类似高频噪声加这儿。
export function isNoiseEvent(ev: any): boolean {
  return ev?.event_type === 'notification' && ev?.data?.subtype === 'thinking_tokens'
}

// 状态/控制类判定：详情刷新只由「会改变 run 详情」的事件触发。成员事件写库前经
// _stamp_run 打 run_id 戳，SSE 透传后与 run 键事件同样带 run_id；run 键事件（无
// session_id）除 process_output 高频输出外都算状态类，成员 session 事件里只有
// 生命周期/状态迁移类才算——tool_use / assistant_message / subagent_progress 等
// 高频活动只驱动事件流，否则活跃 run 会对详情+状态两端点恒定轮询。
const STATE_RELEVANT_SESSION_EVENTS = new Set([
  'session_activated', 'session_state_changed', 'session_outcome',
])

function isStateRelevantEvent(ev: ClaudeEvent): boolean {
  if (ev.event_type === 'process_output') return false
  if (ev.session_id) return STATE_RELEVANT_SESSION_EVENTS.has(ev.event_type)
  return true
}

// ── 模块级单例 ──────────────────────────────────────────────────────────
// 与 useAuth / useProjectPaths / usePlugins 一致：所有响应式状态 + EventSource +
// 重连定时器建在模块级，全局只一条 EventSource、一个 connected、一个重连定时器。
// 连接生命周期由 App.vue 根组件 onMounted/onUnmounted 托管，不随路由 / keep-alive
// 切换——根治多组件各开 EventSource + keep-alive 错配导致的连接泄漏与重连 toast 死循环。
const sessions = ref<SessionInfo[]>([])
const pipeline = ref<PipelineMap>({})
const usage = ref<UsageSnapshot | null>(null)
const config = ref<ConfigInfo | null>(null)
const authState = ref<any>(null)
const eventsBySession = ref<Record<string, ClaudeEvent[]>>({})
// run 维度累计接收事件数（按 run_id 分桶，单调递增，不随环形裁剪回退）：
// 事件流按当前 run 过滤触发，其他 run/session 的事件不惊扰本 run。两档信号：
// 事件流用全量计，详情/状态刷新用状态类计（判定见 isStateRelevantEvent）。
// 每键仅一个数字，不设键数淘汰——事件分桶才是真内存问题（run 键事件不入桶）
const runEventCount = ref<Record<string, number>>({})
const runStateEventCount = ref<Record<string, number>>({})
const events = computed(() => Object.values(eventsBySession.value).flat())
// 删除：后续清理首页运行列表遗留代码时，一并移除该派生状态、更新逻辑和测试。
// 停等人工输入的会话（等人路径归组）：等待/门禁/人工回复类事件到达时增量重判
// 该会话的事件桶，避免逐事件全量扫描全部桶
const waitingInputBySession = ref<Record<string, WaitingInputKind | null>>({})
const connected = ref(false)
const error = ref<string | null>(null)
const handoffState = ref<HandoffState>({ states: {} })
const loopState = ref<LoopState>({
  running_sessions: [], watching_session_id: null, watching_session_name: null,
})

let eventSource: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let retryCount = 0

// 指数退避重连参数：1s→2→4…→30s 封顶 + 抖动 + 重试上限，取代固定 2s 无限重试。
// dev 模式下 uvicorn reload 会有 1-2s 空窗，需要快速重连 + 足够多的重试次数。
const BASE_DELAY = 500
const MAX_DELAY = 10000
const MAX_RETRY = 30

function _bumpRunCount(runId: string, stateRelevant: boolean) {
  runEventCount.value[runId] = (runEventCount.value[runId] ?? 0) + 1
  if (stateRelevant) {
    runStateEventCount.value[runId] = (runStateEventCount.value[runId] ?? 0) + 1
  }
}

function _attachListeners() {
  if (!eventSource) return

  eventSource.onopen = () => {
    connected.value = true
    error.value = null
    retryCount = 0
    // 停等键按回放窗重算：服务端连接建立即回放最近事件，随后重新播种；
    // 不清零则断线期间落在回放窗外的人工回复会让旧停等永久残留
    waitingInputBySession.value = {}
  }

  eventSource.addEventListener('session_update', (e: MessageEvent) => {
    try { sessions.value = JSON.parse(e.data) } catch {}
  })

  eventSource.addEventListener('pipeline_update', (e: MessageEvent) => {
    try { pipeline.value = JSON.parse(e.data) as PipelineMap } catch {}
  })

  eventSource.addEventListener('usage_update', (e: MessageEvent) => {
    try { usage.value = JSON.parse(e.data) } catch {}
  })

  eventSource.addEventListener('config_update', (e: MessageEvent) => {
    try { config.value = JSON.parse(e.data) } catch {}
  })

  eventSource.addEventListener('auth_update', (e: MessageEvent) => {
    try { authState.value = JSON.parse(e.data) } catch {}
  })

  eventSource.addEventListener('claude_event', (e: MessageEvent) => {
    try {
      const ev = JSON.parse(e.data) as ClaudeEvent
      if (isNoiseEvent(ev)) return                              // 跳过 thinking_tokens 等高频遥测
      if (ev.run_id) {
        _bumpRunCount(ev.run_id, isStateRelevantEvent(ev))
      }
      // run 键事件（有 run_id 无 session 身份）只作触发信号，不入 eventsBySession：
      // 事件流走 useRunEvents 的 cursor 拉取，分桶无人消费，per-run 常驻桶内存会随
      // distinct run 数无界增长
      if (!ev.session_id) return
      const arr = eventsBySession.value[ev.session_id] || (eventsBySession.value[ev.session_id] = [])
      arr.push(ev)                                              // O(1)，替代 [...arr, ev] 的 O(n) 全复制
      if (arr.length > MAX_EVENTS) arr.splice(0, arr.length - MAX_EVENTS)  // 环形：超上限丢最旧
      if (isWaitingRelevantEvent(ev)) {
        waitingInputBySession.value[ev.session_id] = waitingInputKind(arr)
      }
    } catch {}
  })

  eventSource.addEventListener('handoff_update', (e: MessageEvent) => {
    try { handoffState.value = JSON.parse(e.data) } catch {}
  })

  eventSource.addEventListener('loop_update', (e: MessageEvent) => {
    try { loopState.value = JSON.parse(e.data) } catch {}
  })

  // uvicorn reload 时后端发 server_reload 事件，立即重连不用等超时
  eventSource.addEventListener('server_reload', () => {
    connected.value = false
    eventSource?.close()
    eventSource = null
    retryCount = 0
    _scheduleReconnect()
  })

  eventSource.onerror = () => {
    connected.value = false
    error.value = 'Connection lost'
    eventSource?.close()
    eventSource = null
    _scheduleReconnect()
  }
}

function _scheduleReconnect() {
  if (reconnectTimer) return
  // 离线不重连，等 window 'online' 事件恢复（避免后端宕机时 ×连接数并行重试风暴）
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    error.value = '网络离线，等待恢复'
    return
  }
  if (retryCount >= MAX_RETRY) {
    error.value = '连接超时，请刷新页面'
    return
  }
  // 指数退避 + 抖动：抖动避免多客户端同步重连
  const delay = Math.min(BASE_DELAY * 2 ** retryCount + Math.random() * 500, MAX_DELAY)
  retryCount++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    _connect()
  }, delay)
}

// REST 兜底：authState（模型下拉框的数据源）不应只依赖 SSE 的 auth_update。
// SSE 一旦卡住（生成器阻塞）会导致下拉框永远空着，这里在建立连接时同步拉一次
// auth 状态端点，SSE 的 auth_update 仍负责后续增量更新。
async function _refreshAuth() {
  try {
    const r = await fetch('/api/v1/auth/status')
    // REST 快照只做兜底初值：若在途期间 SSE 已推送 auth_update，则不再用较旧
    // 的 REST 响应覆盖较新状态，仅在 authState 仍为空时写入。
    if (r.ok) {
      const data = await r.json()
      if (authState.value == null) {
        authState.value = data
      }
    }
  } catch {}
}

function _connect() {
  if (eventSource) return
  eventSource = new EventSource('/api/v1/events/stream')
  ;(window as any).__workflow_controller_sse = eventSource
  _attachListeners()
  _refreshAuth()
}

function _disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  eventSource?.close()
  eventSource = null
  connected.value = false
  retryCount = 0
}

// 网络恢复时立即触发重连（离线期间 _scheduleReconnect 提前返回，未占 retryCount/定时器）
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (!eventSource && !reconnectTimer) _scheduleReconnect()
  })
}

export function useSSE() {
  return {
    sessions, pipeline, usage, config, authState, events, eventsBySession,
    waitingInputBySession,
    connected, error, handoffState, loopState, runEventCount, runStateEventCount,
    connect: _connect, disconnect: _disconnect,
  }
}

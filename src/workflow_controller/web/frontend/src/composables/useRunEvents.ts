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

import { computed, getCurrentInstance, onUnmounted, ref } from 'vue'
import type { RunEvent, RunEventsPage } from '../types/runs'
import { useRuns } from './useRuns'
import { useSSE } from './useSSE'

// 事件列表上限（环形丢最旧）：游标只前进，防长跑 run 无界增长
const MAX_EVENTS = 2000
// 翻页页长（显式传入服务端）：页内不足一页即两表取尽、已到当前水位——追平
// 的唯一判据，不依赖对「是否还有事件」的任何推断。「页满」以应答 limit
// （服务端钳制后实际生效页长）为准，请求值可被上限压缩
const PAGE_SIZE = 200
// 排空限速保险：连续满页说明积压在清，全速追；每拉满这段页数让出一拍。
// 让出无条件生效——「终态判定失真（详情缓存滞后）+ 持续产出 + SSE 静默」的
// 组合下退化为有界速率的跟随而非 busy-loop，循环的继续条件只有「满页」这
// 一服务端事实，不依赖任何缓存判定；不用页数上限截断（截断大存量是缺陷，
// 有限存量必须能追平到尾）
const DRAIN_BURST_PAGES = 50
const DRAIN_YIELD_MS = 100
// 非终态 run 的兜底节拍：SSE 只是加速信号且可能静默失职（断线退避、通道异常
// 被吞、事件被其他 run 挤占单拍推送预算），追平后按此间隔复核水位——SSE 正常
// 时信号先到，节拍拉到不足一页即止。终态 run 事件集有限，不排程
const TICK_MS = 3000
// 单页失败重试：失败不是追平；穷尽后进入指数退避自动恢复
const RETRY_MAX = 3
const RETRY_DELAY_MS = 300
const RETRY_BACKOFF_CAP_MS = 5000

// run 事件流：cursor 是唯一数据源，SSE 信号 / 断线重连 / 定时器三路触发都汇入
// pump 串行。每次触发把两表水位排空到「不足一页」（服务端事实），失败指数退避
// 自动恢复。isTerminal 只决定追平后是否排程兜底节拍——排空循环本身不依赖任何
// 终止推断（终态判定读详情缓存可能滞后，见 DRAIN_BURST_PAGES 注）
export function useRunEvents(runId: string, isTerminal?: () => boolean) {
  const { fetchEvents } = useRuns()
  const { runEventCount } = useSSE()
  // 本 run 的累计接收事件数：其他 run/session 的事件不触发本 run 拉取
  const runCount = computed(() => runEventCount.value[runId] ?? 0)
  const events = ref<RunEvent[]>([])
  const loading = ref(false)
  // 排空失败（重试穷尽，退避自动恢复中）：尾部暂不完整，退避到点自动续拉
  const failed = ref(false)
  let cursor: string | undefined
  let pulling = false
  let retriggered = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let cooldownUntil = 0
  let retryDelay = RETRY_DELAY_MS
  let disposed = false

  // 组件 setup 内注册卸载清理；测试等无实例环境跳过（不产生 Vue 警告）
  if (getCurrentInstance()) {
    onUnmounted(() => {
      disposed = true
      if (timer) clearTimeout(timer)
    })
  }

  function schedule(delay: number) {
    if (disposed || timer) return
    timer = setTimeout(() => { timer = null; void pump() }, delay)
  }

  // 拉一页，失败有界重试（重试期静默）：返回 null = 穷尽失败，游标未动
  async function fetchPage(): Promise<RunEventsPage | null> {
    for (let attempt = 0; ; attempt++) {
      const page = await fetchEvents(runId, cursor, PAGE_SIZE)
      if (page) return page
      if (attempt >= RETRY_MAX) return null
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }

  // 排空到当前水位：满页说明仍有积压，立即续拉；不足一页（含空页）即追平。
  // 满页连续 DRAIN_BURST_PAGES 页让出一拍（限速理由见常量注），与终态判定
  // 无关——判定读的是详情缓存，可能滞后失真
  async function drainToWatermark(): Promise<boolean> {
    let pages = 0
    for (;;) {
      const page = await fetchPage()
      if (!page) return false
      events.value.push(...page.events)
      if (events.value.length > MAX_EVENTS) {
        events.value.splice(0, events.value.length - MAX_EVENTS)
      }
      cursor = page.next_cursor
      if (page.events.length < page.limit) return true
      if (++pages >= DRAIN_BURST_PAGES) {
        pages = 0
        await new Promise((resolve) => setTimeout(resolve, DRAIN_YIELD_MS))
      }
    }
  }

  // 统一泵：拉取中的触发合并为收尾后再拉一次；失败退避的冷却期内忽略新
  // 触发——防 SSE 存活但 REST 持续失败时信号把重试放大成风暴，恢复只由
  // 退避定时器驱动
  async function pump(): Promise<void> {
    if (disposed) return
    if (pulling) { retriggered = true; return }
    if (Date.now() < cooldownUntil) return
    if (timer) { clearTimeout(timer); timer = null }
    pulling = true
    loading.value = true
    try {
      const caughtUp = await drainToWatermark()
      failed.value = !caughtUp
      if (!caughtUp) {
        cooldownUntil = Date.now() + retryDelay
        schedule(retryDelay)
        retryDelay = Math.min(retryDelay * 2, RETRY_BACKOFF_CAP_MS)
      } else {
        retryDelay = RETRY_DELAY_MS
        if (!isTerminal?.()) schedule(TICK_MS)
      }
    } finally {
      pulling = false
      loading.value = false
      if (retriggered && !disposed) {
        retriggered = false
        void pump()
      }
    }
  }

  // 手动重试（失败提示条的重试按钮）：绕过冷却立即拉
  function retry() {
    cooldownUntil = 0
    void pump()
  }

  return { events, loading, failed, runCount, pump, retry }
}

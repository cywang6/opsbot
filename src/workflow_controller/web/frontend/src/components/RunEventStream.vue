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

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NEmpty, NModal, NSpin } from 'naive-ui'
import type { RunEvent } from '../types/runs'
import { useRunEvents } from '../composables/useRunEvents'
import { useSSE } from '../composables/useSSE'
import VirtualLog from './common/VirtualLog.vue'
import type { VLogLine } from './common/VirtualLog.vue'

const props = defineProps<{ runId: string; terminal?: boolean }>()

const { events, loading, failed, runCount, pump, retry } = useRunEvents(
  props.runId, () => props.terminal)
const { connected } = useSSE()

const TRIGGER_DEBOUNCE_MS = 300
let triggerTimer: ReturnType<typeof setTimeout> | null = null

function schedulePull() {
  if (triggerTimer) return
  triggerTimer = setTimeout(() => {
    triggerTimer = null
    void pump()
  }, TRIGGER_DEBOUNCE_MS)
}

// SSE 触发信号：本 run 的累计接收事件数单调递增（按 run_id 过滤），反之仅无关事件不惊扰
watch(runCount, schedulePull)
// 断线重连：重连成功即补拉一轮（服务端游标水位保证不重不漏）
watch(connected, (ok, prev) => { if (ok && !prev) void pump() })
onMounted(() => void pump())
onUnmounted(() => { if (triggerTimer) clearTimeout(triggerTimer) })

// 事件内容摘要：进程输出取行、退出取码，其余 JSON 截断；全文经弹窗查看
function summarize(ev: RunEvent): string {
  const data = ev.data || {}
  if (ev.event_type === 'process_output') return String(data.line ?? '')
  if (ev.event_type === 'process_exit') {
    return `rc=${data.returncode ?? '?'} lines=${data.lines ?? '?'}`
  }
  const text = JSON.stringify(data)
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

function eventLine(ev: RunEvent): VLogLine {
  const date = new Date(ev.timestamp)
  const pad = (part: number) => String(part).padStart(2, '0')
  const time = Number.isNaN(date.getTime())
    ? ev.timestamp
    : `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  const owner = ev.source === 'run_events'
    ? (ev.context || 'run')
    : `s:${(ev.session_id || '').slice(-8)}`
  return {
    text: `${time}  ${ev.event_type}  ${owner}  ${summarize(ev)}`,
    cls: ev.source === 'run_events' ? 'ev-run' : undefined,
    modal: JSON.stringify(ev, null, 2),
  }
}

const lines = computed<VLogLine[]>(() => events.value.map(eventLine))

const modalShow = ref(false)
const modalContent = ref('')
</script>

<template>
  <div class="run-event-stream">
    <n-spin v-if="loading && events.length === 0" size="small" style="padding:40px 0;width:100%" />
    <n-empty v-else-if="failed && !lines.length" size="small" description="事件流加载失败" style="padding:40px 0">
      <template #extra>
        <n-button size="small" @click="retry()">重试</n-button>
      </template>
    </n-empty>
    <template v-else>
      <div v-if="failed" class="retry-hint">
        <span>事件流拉取失败，自动重试中，尾部可能不完整</span>
        <n-button size="tiny" quaternary type="primary" @click="retry()">重试</n-button>
      </div>
      <VirtualLog v-if="lines.length" :lines="lines"
        @open-modal="(content: string) => { modalContent = content; modalShow = true }" />
      <n-empty v-else size="small" description="暂无事件" style="padding:40px 0" />
    </template>

    <n-modal v-model:show="modalShow" preset="card" title="事件详情" style="width:640px">
      <pre class="event-json">{{ modalContent }}</pre>
    </n-modal>
  </div>
</template>

<style scoped>
.run-event-stream {
  flex: 1;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* run 键事件行使用主题强调色、成员事件行默认色：两源一眼可分 */
.run-event-stream :deep(.ev-run) {
  color: var(--workflow-controller-primary, #0b6bcb);
}
.retry-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  font-size: 12px;
  color: #c2551c;
  background: color-mix(in srgb, #f0a020 12%, var(--workflow-controller-surface, #fff7e6));
  border: 1px solid color-mix(in srgb, #f0a020 45%, var(--workflow-controller-border, #ffd591));
  border-radius: 4px;
}
.event-json {
  max-height: 60vh;
  overflow: auto;
  font-family: 'JetBrains Mono', 'SF Mono', monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>

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
import { computed, ref } from 'vue'
import { NEmpty, NTag, NTimeline, NTimelineItem, NButton, NTooltip, NProgress } from 'naive-ui'
import type { ClaudeEvent } from '../../types/api'

const props = defineProps<{
  /** SSE + 历史回放合并后该 session 的全部事件 */
  sessionEvents: ClaudeEvent[]
  /** session id（上传用） */
  sessionId?: string
}>()

const emit = defineEmits<{
  (e: 'upload'): void
}>()

interface AlertDict {
  alert_id: string
  rule: string
  severity: 'info' | 'warning' | 'error'
  session_id: string
  message: string
  agent_id?: string
  agent_type?: string
  started_at?: string
  elapsed_seconds?: number
  threshold_seconds?: number
  file_path?: string
  stall_count?: number
  keyword?: string
  timestamp: string
}

// 从事件流里筛出 watchdog 告警（fault.* 事件，data 是 Alert.to_dict()）
const alerts = computed<AlertDict[]>(() => {
  return props.sessionEvents
    .filter(e => e.event_type.startsWith('fault.'))
    .map(e => (e.data as any) as AlertDict)
    .filter(a => a && a.alert_id && a.rule)
    .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''))
})

const alertCount = computed(() => alerts.value.length)
const maxSeverity = computed<'none' | 'info' | 'warning' | 'error'>(() => {
  if (!alerts.value.length) return 'none'
  if (alerts.value.some(a => a.severity === 'error')) return 'error'
  if (alerts.value.some(a => a.severity === 'warning')) return 'warning'
  return 'info'
})

const severityTag = (s: AlertDict['severity']) => {
  if (s === 'error') return { type: 'error' as const, text: 'ERROR' }
  if (s === 'warning') return { type: 'warning' as const, text: 'WARNING' }
  return { type: 'info' as const, text: 'INFO' }
}

const timelineType = (s: AlertDict['severity']): 'error' | 'warning' | 'info' =>
  s === 'error' ? 'error' : s === 'warning' ? 'warning' : 'info'

function fmtDuration(sec?: number): string {
  if (!sec) return ''
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s ? `${m}m${s}s` : `${m}m`
}

function fmtTime(ts?: string): string {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    return d.toLocaleString('zh-CN', { hour12: false })
  } catch {
    return ts
  }
}

// 上传状态
const uploading = ref(false)
const uploadPct = ref(0)
const uploadStep = ref('')
const uploadResult = ref<{ ok: boolean; folder?: string; message?: string; error?: string } | null>(null)

const STEP_LABELS: Record<string, string> = {
  pause: '正在暂停流程',
  export: '正在导出 session',
  collect: '正在收集切片',
  clone: '正在克隆 Context Bay 仓',
  copy: '正在复制产物',
  commit: '正在提交',
  push: '正在推送',
  done: '完成',
  error: '出错了',
}

let _pollTimer: ReturnType<typeof setInterval> | null = null

function stopPoll() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null }
}

async function doUpload() {
  if (!props.sessionId || uploading.value) return
  uploading.value = true
  uploadPct.value = 0
  uploadStep.value = 'pause'
  uploadResult.value = null
  try {
    const r = await fetch(`/api/v1/sessions/${props.sessionId}/upload-to-context-bay`, { method: 'POST' })
    const d = await r.json()
    if (!d.ok || !d.taskId) {
      uploadResult.value = { ok: false, error: d.error || 'Failed to start upload' }
      uploading.value = false
      return
    }
    // poll progress
    _pollTimer = setInterval(async () => {
      try {
        const pr = await fetch(`/api/v1/sessions/${props.sessionId}/upload-progress/${d.taskId}`)
        const pd = await pr.json()
        uploadPct.value = pd.pct ?? 0
        uploadStep.value = pd.step ?? ''
        if (pd.step === 'done') {
          stopPoll()
          uploading.value = false
          uploadResult.value = { ok: true, folder: pd.folder, message: pd.message }
          emit('upload')
        } else if (pd.step === 'error') {
          stopPoll()
          uploading.value = false
          uploadResult.value = { ok: false, error: pd.error || 'Upload failed' }
        }
      } catch {
        // keep polling
      }
    }, 500)
  } catch (e: any) {
    uploading.value = false
    stopPoll()
    uploadResult.value = { ok: false, error: e.message || String(e) }
  }
}

defineExpose({ alertCount, maxSeverity })
</script>

<template>
  <div class="watchdog-alerts" style="padding:8px;display:flex;flex-direction:column;max-height:60vh">
    <div v-if="alertCount > 0" style="font-size:13px;font-weight:500;margin-bottom:8px;color:var(--workflow-controller-text, #3a3a3a);flex-shrink:0;display:flex;align-items:center;justify-content:space-between">
      <span>共 {{ alertCount }} 条告警</span>
      <n-tooltip placement="bottom">
        <template #trigger>
          <n-button
            size="small"
            type="warning"
            :disabled="!sessionId || uploading"
            @click="doUpload"
          >
            上传现场到 Context Bay
          </n-button>
        </template>
        点击此按钮会中断当前流程（与手动暂停效果相同）
      </n-tooltip>
    </div>
    <!-- 上传进度条 -->
    <div v-if="uploading" style="margin-bottom:8px;flex-shrink:0">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px">
        <span style="font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">{{ STEP_LABELS[uploadStep] || uploadStep }}</span>
        <span style="font-size:12px;color:var(--workflow-controller-text-muted, #9a9a9a)">{{ uploadPct }}%</span>
      </div>
      <n-progress
        type="line"
        :percentage="uploadPct"
        :show-indicator="false"
        :height="4"
        :border-radius="2"
        :processing="true"
        color="var(--workflow-controller-primary, #2080f0)"
        rail-color="var(--workflow-controller-hover, #f0f0f0)"
      />
    </div>
    <!-- 上传结果提示 -->
    <div v-if="uploadResult" style="font-size:12px;margin-bottom:8px;padding:4px 8px;border-radius:4px;flex-shrink:0"
      :style="{ background: uploadResult.ok ? 'color-mix(in srgb, #67c23a 12%, var(--workflow-controller-surface, #f0f9eb))' : 'color-mix(in srgb, #f56c6c 12%, var(--workflow-controller-surface, #fef0f0))', color: uploadResult.ok ? '#67c23a' : '#f56c6c' }">
      <span v-if="uploadResult.ok">{{ uploadResult.message || ('已上传到 ' + (uploadResult.folder || '')) }}</span>
      <span v-else>{{ uploadResult.error }}</span>
    </div>
    <n-empty v-if="!alerts.length" description="暂无告警" size="small" />
    <div v-else style="overflow-y:auto;flex:1;min-height:0;padding-right:4px">
      <n-timeline>
        <n-timeline-item
          v-for="a in alerts"
          :key="a.alert_id"
          :type="timelineType(a.severity)"
        >
          <template #header>
            <n-tag size="small" :type="severityTag(a.severity).type" style="margin-right:6px">
              {{ severityTag(a.severity).text }}
            </n-tag>
            <span style="font-weight:500">{{ a.rule }}</span>
            <span v-if="a.agent_type" style="margin-left:8px;color:var(--workflow-controller-text-muted, #6f6f6f);font-size:12px">
              · {{ a.agent_type }}
            </span>
          </template>
          <!-- 告警正文 -->
          <div style="font-size:13px;color:var(--workflow-controller-text, #3a3a3a);margin-top:6px;line-height:1.5">
            {{ a.message }}
          </div>
          <!-- 规则专属指标卡 -->
          <!-- subagent_timeout: 已运行 vs 阈值 -->
          <div v-if="a.rule === 'subagent_timeout' && (a.elapsed_seconds || a.threshold_seconds)" style="margin-top:8px;display:flex;gap:0;border:1px solid var(--workflow-controller-border, #e8e8e8);border-radius:6px;overflow:hidden">
            <div style="flex:1;padding:6px 10px;background:var(--workflow-controller-surface, #fafafa)">
              <div style="font-size:11px;color:var(--workflow-controller-text-muted, #9a9a9a);margin-bottom:2px">已运行</div>
              <div style="font-size:16px;font-weight:600;color:#ed4831">{{ fmtDuration(a.elapsed_seconds) }}</div>
            </div>
            <div style="width:1px;background:var(--workflow-controller-border, #e8e8e8)" />
            <div style="flex:1;padding:6px 10px;background:var(--workflow-controller-surface, #fafafa)">
              <div style="font-size:11px;color:var(--workflow-controller-text-muted, #9a9a9a);margin-bottom:2px">阈值</div>
              <div style="font-size:16px;font-weight:600;color:var(--workflow-controller-text-muted, #6f6f6f)">{{ fmtDuration(a.threshold_seconds) }}</div>
            </div>
          </div>
          <!-- file_stall: 连续未变化次数 + 文件路径 -->
          <div v-if="a.rule === 'file_stall' && a.stall_count" style="margin-top:8px;display:flex;gap:0;border:1px solid var(--workflow-controller-border, #e8e8e8);border-radius:6px;overflow:hidden">
            <div style="flex:1;padding:6px 10px;background:var(--workflow-controller-surface, #fafafa)">
              <div style="font-size:11px;color:var(--workflow-controller-text-muted, #9a9a9a);margin-bottom:2px">连续未变化</div>
              <div style="font-size:16px;font-weight:600;color:#ed4831">{{ a.stall_count }} 次</div>
            </div>
            <div style="width:1px;background:var(--workflow-controller-border, #e8e8e8)" />
            <div style="flex:2;padding:6px 10px;background:var(--workflow-controller-surface, #fafafa);overflow:hidden">
              <div style="font-size:11px;color:var(--workflow-controller-text-muted, #9a9a9a);margin-bottom:2px">追踪文件</div>
              <div style="font-size:13px;font-weight:500;color:var(--workflow-controller-text-muted, #6f6f6f);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ a.file_path }}</div>
            </div>
          </div>
          <!-- keyword_detected: 文件路径 + 关键词 -->
          <div v-if="a.rule === 'keyword_detected' && a.keyword" style="margin-top:8px;display:flex;gap:0;border:1px solid var(--workflow-controller-border, #e8e8e8);border-radius:6px;overflow:hidden">
            <div style="flex:1;padding:6px 10px;background:var(--workflow-controller-surface, #fafafa)">
              <div style="font-size:11px;color:var(--workflow-controller-text-muted, #9a9a9a);margin-bottom:2px">关键词</div>
              <div style="font-size:15px;font-weight:600;color:#ed4831">{{ a.keyword }}</div>
            </div>
            <div style="width:1px;background:var(--workflow-controller-border, #e8e8e8)" />
            <div style="flex:2;padding:6px 10px;background:var(--workflow-controller-surface, #fafafa);overflow:hidden">
              <div style="font-size:11px;color:var(--workflow-controller-text-muted, #9a9a9a);margin-bottom:2px">检测文件</div>
              <div style="font-size:13px;font-weight:500;color:var(--workflow-controller-text-muted, #6f6f6f);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ a.file_path }}</div>
            </div>
          </div>
          <!-- 时间信息 -->
          <div style="margin-top:6px;font-size:11px;color:var(--workflow-controller-text-muted, #9a9a9a);display:flex;flex-direction:column;gap:2px">
            <div v-if="a.started_at" style="display:flex;align-items:center;gap:4px">
              <span style="width:56px">启动时间</span>
              <span style="color:var(--workflow-controller-text-muted, #6f6f6f)">{{ fmtTime(a.started_at) }}</span>
            </div>
            <div style="display:flex;align-items:center;gap:4px">
              <span style="width:56px">告警时间</span>
              <span style="color:var(--workflow-controller-text-muted, #6f6f6f)">{{ fmtTime(a.timestamp) }}</span>
            </div>
          </div>
        </n-timeline-item>
      </n-timeline>
    </div>
  </div>
</template>

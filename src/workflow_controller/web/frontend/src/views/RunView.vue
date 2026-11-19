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
import type { Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NAlert, NButton, NCard, NDataTable, NEmpty, NFlex, NLayout,
  NLayoutContent, NModal, NProgress, NSpin, NTag, NText, NTooltip,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import type { RunExportSummary, RunProcess, RunRecord, RunState } from '../types/runs'
import { useRuns } from '../composables/useRuns'
import { useSSE } from '../composables/useSSE'
import { usePlugins } from '../composables/usePlugins'
import { useConfirm } from '../composables/useConfirm'
import { useToast } from '../composables/useToast'
import { resolveRunPanel } from '../plugin-components'
import RunSessionsTable from '../components/RunSessionsTable.vue'
import RunEventStream from '../components/RunEventStream.vue'

defineOptions({ name: 'RunView' })

const route = useRoute()
const router = useRouter()
const toast = useToast()
const { confirmDelete } = useConfirm()
const { runDetail, refreshRun, fetchState, control, remove, exportRun } = useRuns()
const { connected, runStateEventCount } = useSSE()
const { plugins, loadPlugins } = usePlugins()

const runId = computed(() => String(route.params.id ?? ''))
const run = computed<RunRecord | null>(() => runDetail.value?.run ?? null)
const sessions = computed(() => runDetail.value?.sessions ?? [])
const state = ref<RunState | null>(null)
const notFound = ref(false)
const acting = ref(false)
const exporting = ref(false)
// 导出进度弹层：后台导出逐会话上报 done/total，NProgress 展示百分比；
// 结束后停在弹层里展示结果（会话数 + 完整性），由用户手动关闭
const showExportModal = ref(false)
const exportDone = ref(0)
const exportTotal = ref(0)
const exportStatus = ref<'running' | 'done' | 'error'>('running')
const exportCancelled = ref(false)
const exportSummary = ref<RunExportSummary | null>(null)
const exportError = ref('')
const exportPct = computed(() =>
  exportTotal.value > 0 ? Math.round((exportDone.value / exportTotal.value) * 100) : 0)
const exportClosable = computed(() => exportStatus.value !== 'running')
// 本 run 的状态/控制类事件计数（按 run_id 过滤、排除 process_output 高频输出）：
// 仅状态/控制类事件驱动详情刷新，process_output 只驱动事件流，避免恒定轮询风暴
const runCount = computed(() => runStateEventCount.value[runId.value] ?? 0)

const statusMeta: Record<string, { color: string; label: string }> = {
  pending: { color: '#999999', label: '待运行' },
  running: { color: '#f0a020', label: '运行中' },
  paused: { color: '#0891b2', label: '已暂停' },
  completed: { color: '#52c41a', label: '已完成' },
  failed: { color: '#f5222d', label: '失败' },
  stopped: { color: '#bfbfbf', label: '已停止' },
}

const pauseReasonLabel: Record<string, string> = {
  user: '用户暂停', auth: '密钥挂起', projection: '成员投影',
}

const kindLabel: Record<string, string> = {
  workflow: '工作流', container: '容器', implicit: '隐式',
}

const terminal = computed(() =>
  ['completed', 'failed', 'stopped'].includes(run.value?.status ?? ''))

const processes = computed<RunProcess[]>(() => state.value?.processes ?? [])

// 驱动面板槽位：插件声明的面板（/api/v1/plugins 下发）按 (format, 投影
// schema_version) 路由——插件列表未载或格式未声明时无面板
const driverProjection = computed<Record<string, unknown> | null>(
  () => state.value?.driver ?? null)

const panelComponent = computed<Component | null>(() => {
  const version = driverProjection.value?.['schema_version']
  return resolveRunPanel(
    plugins.value.flatMap((p) => p.run_panels ?? []),
    run.value?.format ?? '',
    typeof version === 'number' ? version : null,
  )
})

// 面板路由依赖插件列表：挂载即拉取（幂等去重，不阻塞详情加载）
onMounted(() => { void loadPlugins() })

const processColumns: DataTableColumns<RunProcess> = [
  { title: '进程', key: 'proc_id', width: 100 },
  { title: 'context', key: 'context', ellipsis: { tooltip: true },
    render: (row) => row.context || '—' },
  { title: '退出码', key: 'returncode', width: 90,
    render: (row) => row.returncode === null ? '在途' : String(row.returncode) },
]

function fmtTime(iso: string | null) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

let loadSeq = 0
// 详情加载失败退避：与事件流泵同款「失败不是终态」策略——指数退避到点自动重拉，
// 静止 run 无后续信号也能自愈；状态类触发信号本身低频（白名单过滤），刷新速率
// 上界即设计速率，无需泵级冷却门
const LOAD_DEBOUNCE_MS = 300
const RETRY_DELAY_MS = 300
const RETRY_CAP_MS = 5000
let loadRetryDelay = RETRY_DELAY_MS
// 防抖与退避共用单一定时器槽：到期都只是重跑 loadDetail
let loadTimer: ReturnType<typeof setTimeout> | null = null
// 退避自动恢复中：驱动错误态（空态或提示条），不弹 toast
const loadFailed = ref(false)

function scheduleLoad(delay: number) {
  if (loadTimer) return
  loadTimer = setTimeout(() => { loadTimer = null; void loadDetail() }, delay)
}

function failLoad() {
  loadFailed.value = true
  scheduleLoad(loadRetryDelay)
  loadRetryDelay = Math.min(loadRetryDelay * 2, RETRY_CAP_MS)
}

async function loadDetail() {
  const id = runId.value
  const seq = ++loadSeq
  // 全程静默：失败不逐次 toast，错误态即唯一用户可见出口
  const res = await refreshRun(id)
  // 慢响应乱序返回时丢弃过期结果，防旧 run 数据写回
  if (seq !== loadSeq) return
  // 仅真 404 判定「不在账面」；网络/5xx 失败走退避
  notFound.value = !res.ok && res.notFound
  if (!res.ok) {
    // 首拉失败退避自动恢复；已有详情保留旧数据（不撕空），交下轮信号补齐
    if (!res.notFound && !runDetail.value) failLoad()
    return
  }
  const s = await fetchState(id)
  // fetchState 在途切 run 时写回前再校验，防旧 run 状态覆盖新 run
  if (seq !== loadSeq) return
  if (s) {
    state.value = s
    loadFailed.value = false
    loadRetryDelay = RETRY_DELAY_MS
  } else if (!state.value) {
    // 详情已就绪但状态拉不到：同款退避，静止 run 的进程表/指标不永久缺失
    failLoad()
  }
}

// 错误态手动重试：重置退避立即重拉
function retryLoad() {
  loadRetryDelay = RETRY_DELAY_MS
  loadFailed.value = false
  void loadDetail()
}

// SSE 状态类信号防抖刷新（本 run 状态/控制类事件计数单调递增）
watch(runCount, () => scheduleLoad(LOAD_DEBOUNCE_MS))
// 卸载清挂起定时器，防离页后 loadDetail 以空 runId 打列表端点、污染 runDetail 单例
onUnmounted(() => { if (loadTimer) clearTimeout(loadTimer) })

// 断线重连补拉一轮
watch(connected, (ok, prev) => { if (ok && !prev) void loadDetail() })

watch(runId, () => {
  // 切换 run 先清空旧详情，避免新数据返回前按上个 run 渲染
  if (loadTimer) { clearTimeout(loadTimer); loadTimer = null }
  runDetail.value = null
  state.value = null
  notFound.value = false
  loadFailed.value = false
  loadRetryDelay = RETRY_DELAY_MS
  void loadDetail()
}, { immediate: true })

async function doControl(action: 'resume' | 'stop' | 'restart') {
  acting.value = true
  try {
    if (await control(runId.value, action)) {
      toast.success(`run 操作已受理：${action}`)
      await loadDetail()
    }
  } finally {
    acting.value = false
  }
}

async function doDelete() {
  const label = run.value?.label || runId.value
  if (!await confirmDelete(label)) return
  if (await remove(runId.value)) {
    toast.success('已删除 run')
    router.push('/')
  }
}

// 导出为 workflow bundle：后台导出 + 进度条弹层，结束后结果留在弹层内由用户关闭
async function doExport() {
  if (!runId.value || showExportModal.value) return
  showExportModal.value = true
  exportDone.value = 0
  exportTotal.value = 0
  exportStatus.value = 'running'
  exportCancelled.value = false
  exportSummary.value = null
  exportError.value = ''
  exporting.value = true
  try {
    const result = await exportRun(
      runId.value,
      (done, total, status) => {
        exportDone.value = done
        exportTotal.value = total
        exportStatus.value = status === 'error' ? 'error' : 'running'
      },
      () => exportCancelled.value,
    )
    if (result.ok) {
      exportSummary.value = result.summary ?? null
      exportStatus.value = 'done'
    } else if (result.cancelled) {
      exportError.value = '已取消导出'
      exportStatus.value = 'error'
    } else {
      exportError.value = result.error ?? '导出失败'
      exportStatus.value = 'error'
    }
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <n-layout style="height:100vh">
    <n-layout-content content-style="padding:20px;" style="height:100vh;overflow-y:auto">
      <div class="run-page">
        <n-empty v-if="notFound" size="large" description="run 不在账面（可能已删除）">
          <template #extra>
            <n-button @click="router.push('/')">返回</n-button>
          </template>
        </n-empty>

        <n-empty v-else-if="!run && loadFailed" size="large" description="加载失败，自动重试中">
          <template #extra>
            <n-button @click="retryLoad">立即重试</n-button>
          </template>
        </n-empty>

        <n-spin v-else-if="!run" style="width:100%;padding:80px 0" />

        <template v-else>
          <n-card size="small">
            <n-flex vertical size="small">
              <n-flex align="center" :size="10">
                <n-button @click="router.push('/')" strong quaternary>←</n-button>
                <n-tag size="small" :bordered="false" round
                       :color="{ color: statusMeta[run.status]?.color || '#999999' }">
                  {{ statusMeta[run.status]?.label || run.status }}
                </n-tag>
                <span style="font-size:18px;font-weight:700">{{ run.label || '未命名 run' }}</span>
                <span style="font-family:JetBrains Mono,monospace;font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">{{ run.run_id }}</span>
                <n-tag size="small" :bordered="false">{{ kindLabel[run.kind] || run.kind }}</n-tag>
                <n-tag v-if="run.format" size="small" :bordered="false">
                  {{ run.format }}
                </n-tag>
                <n-tag v-if="run.status === 'paused' && run.pause_reason" size="small" :bordered="false" type="warning">
                  {{ pauseReasonLabel[run.pause_reason] || run.pause_reason }}
                </n-tag>
              </n-flex>

              <n-flex align="center" :size="16" style="font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">
                <span v-if="run.work_dir" style="font-family:JetBrains Mono,monospace" :title="run.work_dir">
                  {{ run.work_dir }}
                </span>
                <span>创建 {{ fmtTime(run.created_at) }}</span>
                <span v-if="run.finished_at">完成 {{ fmtTime(run.finished_at) }}</span>
                <span v-if="state?.metrics" style="font-family:JetBrains Mono,monospace">
                  轮次 {{ state.metrics.rounds }} · 队列 {{ state.metrics.queue_depth }} ·
                  挂起 {{ state.metrics.deferred }} · 在途 {{ state.metrics.in_flight }}
                </span>
              </n-flex>

              <n-alert v-if="run.error" type="error" :show-icon="false" style="font-size:12px">
                {{ run.error }}
              </n-alert>

              <n-flex align="center" :size="8">
                <n-button v-if="run.status === 'paused'" size="small" tertiary :loading="acting"
                          @click="doControl('resume')">恢复</n-button>
                <n-tooltip v-if="!terminal" trigger="hover" placement="bottom">
                  <template #trigger>
                    <n-button size="small" type="error" ghost :loading="acting"
                              @click="doControl('stop')">停止</n-button>
                  </template>
                  终止本次运行，之后可通过重启恢复
                </n-tooltip>
                <n-button v-if="terminal" size="small" tertiary :loading="acting"
                          @click="doControl('restart')">重启</n-button>
                <n-tooltip trigger="hover" placement="bottom">
                  <template #trigger>
                    <n-button v-if="run.status !== 'pending' && run.kind !== 'implicit'" size="small" tertiary
                              :loading="exporting" @click="doExport">导出</n-button>
                  </template>
                  下载 workflow bundle（zip）到本地
                </n-tooltip>
                <span style="flex:1"></span>
                <n-button size="small" type="error" quaternary @click="doDelete">删除</n-button>
              </n-flex>
            </n-flex>
          </n-card>

          <n-card v-if="panelComponent" size="small" class="run-panel">
            <component :is="panelComponent" :run-id="runId" :projection="driverProjection"
                       :terminal="terminal" />
          </n-card>

          <div v-if="loadFailed" class="state-error-hint">
            <span>运行状态（进程表/指标）加载失败，自动重试中</span>
            <n-button size="tiny" quaternary type="primary" @click="retryLoad">立即重试</n-button>
          </div>

          <div class="run-body">
            <div class="run-left">
              <n-card title="成员 session" size="small" class="run-members">
                <RunSessionsTable :run-id="runId" :sessions="sessions" @changed="loadDetail" />
              </n-card>
              <n-card v-if="processes.length" title="run 键进程" size="small" class="run-processes">
                <n-data-table
                  :columns="processColumns"
                  :data="processes"
                  :bordered="false"
                  size="small"
                  :max-height="'calc(100vh - 380px)'"
                />
              </n-card>
            </div>
            <n-card title="事件流" size="small" class="run-events">
              <RunEventStream :key="runId" :run-id="runId" :terminal="terminal" />
            </n-card>
          </div>
        </template>
      </div>

      <!-- 导出进度弹层 -->
      <n-modal v-model:show="showExportModal" :mask-closable="exportClosable" :closable="exportClosable" :close-on-esc="exportClosable">
        <n-card title="导出工作流包" style="width: 420px">
          <n-flex vertical :size="12">
            <template v-if="exportStatus === 'running'">
              <n-progress
                type="line"
                :percentage="exportPct"
                :processing="true"
              />
              <n-text depth="3" style="font-size: 13px">
                {{ exportTotal > 0 ? `正在导出 ${exportDone}/${exportTotal} 个会话…` : '正在准备导出…' }}
              </n-text>
              <n-button size="small" quaternary @click="exportCancelled = true">取消</n-button>
            </template>
            <template v-else-if="exportStatus === 'done'">
              <n-text strong style="font-size: 15px">
                已导出 {{ exportSummary?.sessions ?? exportTotal }} 个会话{{ exportSummary?.complete === false ? '（数据不完整）' : '' }}
              </n-text>
              <n-button type="primary" size="small" @click="showExportModal = false">关闭</n-button>
            </template>
            <template v-else>
              <n-text style="font-size: 14px">{{ exportError || '导出失败' }}</n-text>
              <n-button type="primary" size="small" @click="showExportModal = false">关闭</n-button>
            </template>
          </n-flex>
        </n-card>
      </n-modal>
    </n-layout-content>
  </n-layout>
</template>

<style scoped>
.run-page {
  max-width: 1400px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.run-body {
  display: flex;
  gap: 16px;
  align-items: stretch;
}
.run-left {
  width: 560px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.run-events {
  flex: 1;
  min-width: 0;
}
.run-events :deep(.n-card-content) {
  box-sizing: border-box;
  flex: none;
  height: calc(100vh - 320px);
  min-height: 0;
  display: flex;
  overflow: hidden;
}
.run-panel :deep(.n-card-content) {
  box-sizing: border-box;
  flex: none;
  height: 600px;
  min-height: 0;
  overflow: hidden;
}
.state-error-hint {
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
</style>

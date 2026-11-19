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
import { computed, h, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NCard,
  NCode,
  NCollapse,
  NCollapseItem,
  NDataTable,
  NDescriptions,
  NDescriptionsItem,
  NEmpty,
  NFlex,
  NGi,
  NGrid,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSpin,
  NStatistic,
  NTag,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { useToast } from '../composables/useToast'
import {
  claimHuman,
  downloadAuditEvidence,
  errorMessage,
  getBlame,
  getCapture,
  getCaptureFile,
  getMetrics,
  listCommits,
  listFiles,
} from '../plugins/file_provenance/api'
import type {
  BlameLine,
  CaptureFile,
  CaptureMutation,
  CaptureRecord,
  CommitMetrics,
  CommitRecord,
} from '../plugins/file_provenance/api'

defineOptions({ name: 'FileProvenanceView' })

const props = withDefaults(defineProps<{
  projectDir?: string
  sessionId?: string
  active?: boolean
}>(), {
  active: true,
})

const router = useRouter()
const toast = useToast()
const selectedProject = computed(() => props.projectDir || '')
const files = ref<string[]>([])
const commits = ref<CommitRecord[]>([])
const selectedFile = ref<string | null>(null)
const selectedCommit = ref('')
const lines = ref<BlameLine[]>([])
const contentHash = ref<string | null>(null)
const metrics = ref<CommitMetrics>(emptyMetrics())
const loading = ref(false)
const exporting = ref(false)
const error = ref('')
let requestId = 0

async function exportAuditEvidence() {
  if (!selectedProject.value || !props.sessionId) return
  exporting.value = true
  try {
    const blob = await downloadAuditEvidence(selectedProject.value, props.sessionId)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `workflow-controller-audit-${props.sessionId}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  } catch (reason) {
    error.value = errorMessage(reason)
  } finally {
    exporting.value = false
  }
}

const claimOpen = ref(false)
const claimStart = ref(1)
const claimEnd = ref(1)
const claimAuthor = ref('')
const claiming = ref(false)
const claimError = ref('')

const evidenceOpen = ref(false)
const evidenceLoading = ref(false)
const evidenceError = ref('')
const evidence = ref<CaptureRecord | null>(null)
const evidenceBefore = ref<CaptureFile | null>(null)
const evidenceAfter = ref<CaptureFile | null>(null)
let evidenceRequest = 0

const fileOptions = computed(() => files.value.map(value => ({ label: value, value })))
const commitOptions = computed(() => [
  { label: '当前工作树', value: '' },
  ...commits.value.map(item => ({
    label: `${item.commit_sha.slice(0, 12)} · AI ${item.ai_lines}/${item.total_added_lines}`,
    value: item.commit_sha,
  })),
])
const unknownLines = computed(() => lines.value.filter(
  line => line.actor_kind === 'unknown' || line.conflict,
))
const canClaim = computed(() =>
  !selectedCommit.value && !!selectedFile.value && !!contentHash.value && unknownLines.value.length > 0,
)
const canSubmitClaim = computed(() =>
  claimStart.value >= 1
  && claimEnd.value >= claimStart.value
  && claimAuthor.value.trim().length > 0
  && !!contentHash.value,
)
const contextFields = computed(() => {
  const attributes = evidence.value?.attributes ?? {}
  return [
    { label: '当前 Prompt', value: attributes.prompt },
    { label: '初始 Prompt', value: attributes.initial_prompt },
    { label: 'System Prompt', value: attributes.system_prompt },
  ].filter(item => hasEvidenceValue(item.value))
})
const extraAttributes = computed(() => {
  const attributes = evidence.value?.attributes ?? {}
  return Object.fromEntries(Object.entries(attributes).filter(
    ([key]) => !['prompt', 'initial_prompt', 'system_prompt'].includes(key),
  ))
})

const columns = computed<DataTableColumns<BlameLine>>(() => [
  { title: '#', key: 'line_no', width: 58, fixed: 'left' },
  {
    title: '来源',
    key: 'actor_kind',
    width: 110,
    render: row => h(
      NTag,
      { size: 'small', type: tagType(row), bordered: false },
      { default: () => row.conflict ? 'conflict' : row.actor_kind },
    ),
  },
  {
    title: '模型 / Agent',
    key: 'model',
    width: 250,
    ellipsis: { tooltip: true },
    render: row => [row.runtime, row.model, row.agent_name].filter(Boolean).join(' / ') || '—',
  },
  {
    title: '内容',
    key: 'content',
    minWidth: 320,
    render: row => h('code', { class: 'source-line' }, row.content || ' '),
  },
  {
    title: '证据 / 详情',
    key: 'evidence',
    width: 240,
    render: row => h(NFlex, { size: 6, wrap: false }, {
      default: () => [
        row.session_id
          ? h(NButton, {
              text: true,
              type: 'primary',
              size: 'tiny',
              onClick: () => void router.push(`/session/${row.session_id}`),
            }, { default: () => `session ${row.session_id?.slice(0, 8)}` })
          : null,
        row.capture_id
          ? h(NButton, {
              secondary: true,
              type: 'primary',
              size: 'tiny',
              onClick: () => void openEvidence(row.capture_id!),
            }, { default: () => 'Capture 详情' })
          : null,
        !selectedCommit.value && (row.actor_kind === 'unknown' || row.conflict)
          ? h(NButton, {
              text: true,
              type: 'info',
              size: 'tiny',
              disabled: !contentHash.value,
              onClick: (event: MouseEvent) => openClaim(row, event),
            }, { default: () => '认领' })
          : null,
      ],
    }),
  },
])

const mutationColumns: DataTableColumns<CaptureMutation> = [
  { title: '文件', key: 'path', minWidth: 280, ellipsis: { tooltip: true } },
  {
    title: '新增',
    key: 'additions',
    width: 80,
    render: row => h('span', { class: 'addition-count' }, `+${row.additions}`),
  },
  {
    title: '删除',
    key: 'deletions',
    width: 80,
    render: row => h('span', { class: 'deletion-count' }, `-${row.deletions}`),
  },
  {
    title: '归因状态',
    key: 'conflict',
    width: 110,
    render: row => h(
      NTag,
      { size: 'small', type: row.conflict ? 'error' : 'success', bordered: false },
      { default: () => row.conflict ? 'conflict' : '明确' },
    ),
  },
]

function emptyMetrics(): CommitMetrics {
  return {
    commit_sha: '',
    ai_lines: 0,
    total_added_lines: 0,
    generated_lines: 0,
    accepted_lines: 0,
    ai_share: 0,
    acceptance_rate: 0,
  }
}

function tagType(line: BlameLine): 'success' | 'info' | 'warning' | 'error' | 'default' {
  if (line.conflict) return 'error'
  if (line.actor_kind === 'agent') return 'success'
  if (line.actor_kind === 'human') return 'info'
  if (line.actor_kind === 'automation') return 'warning'
  return 'default'
}

function actorLabel(kind: string): string {
  return {
    agent: 'Agent',
    human: '人工',
    automation: '自动化',
    unknown: '未知',
  }[kind] ?? kind
}

function hasEvidenceValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== ''
}

function formatEvidence(value: unknown): string {
  if (!hasEvidenceValue(value)) return '—'
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2) ?? String(value)
}

function captureStatus(capture: CaptureRecord): string {
  if (capture.conflicted) return 'conflict'
  if (capture.incomplete) return 'incomplete'
  if (!capture.finished_at) return '进行中'
  if (capture.is_error || capture.succeeded === false) return '失败'
  if (capture.succeeded) return '成功'
  return '已完成'
}

function captureDuration(capture: CaptureRecord): string {
  if (!capture.finished_at) return '—'
  const duration = Date.parse(capture.finished_at) - Date.parse(capture.started_at)
  if (!Number.isFinite(duration) || duration < 0) return '—'
  if (duration < 1000) return `${duration} ms`
  if (duration < 60_000) return `${(Math.floor(duration / 10) / 100).toFixed(2)} s`
  const totalSeconds = Math.floor(duration / 1000)
  return `${Math.floor(totalSeconds / 60)} min ${totalSeconds % 60} s`
}

function shortSha(value?: string | null): string {
  return value ? value.slice(0, 12) : '—'
}

async function refresh() {
  const project = selectedProject.value
  const request = ++requestId
  if (!project) {
    loading.value = false
    error.value = ''
    return
  }
  loading.value = true
  error.value = ''
  try {
    const [commitValues, fileValues, metricValue] = await Promise.all([
      listCommits(project),
      listFiles(project, selectedCommit.value),
      getMetrics(project, selectedCommit.value),
    ])
    if (request !== requestId) return
    commits.value = commitValues
    files.value = fileValues
    if (!selectedFile.value || !fileValues.includes(selectedFile.value)) {
      selectedFile.value = fileValues[0] ?? null
    }
    metrics.value = metricValue
    if (selectedFile.value) {
      const blame = await getBlame(project, selectedFile.value, selectedCommit.value)
      if (request !== requestId) return
      lines.value = blame.lines
      contentHash.value = blame.content_hash
    } else {
      lines.value = []
      contentHash.value = null
    }
  } catch (reason) {
    if (request === requestId) error.value = errorMessage(reason)
  } finally {
    if (request === requestId) loading.value = false
  }
}

async function loadSelectedFile() {
  const project = selectedProject.value
  const path = selectedFile.value
  const request = ++requestId
  if (!project || !path) return
  loading.value = true
  error.value = ''
  try {
    const blame = await getBlame(project, path, selectedCommit.value)
    if (request !== requestId) return
    lines.value = blame.lines
    contentHash.value = blame.content_hash
  } catch (reason) {
    if (request === requestId) error.value = errorMessage(reason)
  } finally {
    if (request === requestId) loading.value = false
  }
}

function openClaim(line?: BlameLine, event?: MouseEvent) {
  if (!canClaim.value && !line) return
  const first = line?.line_no ?? unknownLines.value[0]?.line_no ?? 1
  claimStart.value = first
  claimEnd.value = first
  claimError.value = ''
  const trigger = event?.currentTarget as HTMLElement | null
  trigger?.blur()
  claimOpen.value = true
}

async function submitClaim() {
  if (!canSubmitClaim.value || !selectedProject.value || !selectedFile.value || !contentHash.value) return
  claiming.value = true
  claimError.value = ''
  try {
    const count = await claimHuman({
      project_dir: selectedProject.value,
      path: selectedFile.value,
      start_line: claimStart.value,
      end_line: claimEnd.value,
      author: claimAuthor.value.trim(),
      expected_content_hash: contentHash.value,
    })
    claimOpen.value = false
    toast.success(`已认领 ${count} 行人工修改`)
    await loadSelectedFile()
  } catch (reason) {
    claimError.value = errorMessage(reason)
  } finally {
    claiming.value = false
  }
}

async function openEvidence(captureId: string) {
  const project = selectedProject.value
  const path = selectedFile.value
  if (!project || !path) return
  const request = ++evidenceRequest
  evidenceOpen.value = true
  evidenceLoading.value = true
  evidenceError.value = ''
  evidence.value = null
  evidenceBefore.value = null
  evidenceAfter.value = null
  try {
    const [capture, before, after] = await Promise.all([
      getCapture(project, captureId),
      getCaptureFile(project, captureId, path, 'before'),
      getCaptureFile(project, captureId, path, 'after'),
    ])
    if (request !== evidenceRequest) return
    evidence.value = capture
    evidenceBefore.value = before
    evidenceAfter.value = after
  } catch (reason) {
    if (request === evidenceRequest) evidenceError.value = errorMessage(reason)
  } finally {
    if (request === evidenceRequest) evidenceLoading.value = false
  }
}

watch(selectedProject, () => {
  selectedFile.value = null
  selectedCommit.value = ''
  if (props.active) void refresh()
})
watch(() => props.active, active => {
  if (active) void refresh()
})
onMounted(() => {
  if (props.active) void refresh()
})
</script>

<template>
  <div class="page">
    <NFlex justify="space-between" align="center" class="page-header">
      <div>
        <h2>文件归因</h2>
        <div v-if="selectedProject" class="project-path">{{ selectedProject }}</div>
      </div>
      <NFlex v-if="selectedProject">
        <NButton
          :disabled="!sessionId"
          :loading="exporting"
          title="下载完整会话及变更文件的 before/after 内容，文件可能包含敏感源码"
          @click="exportAuditEvidence"
        >导出审计证据</NButton>
        <NButton :disabled="!canClaim" @click="openClaim(undefined, $event)">人工认领</NButton>
        <NButton type="primary" :loading="loading" @click="refresh">刷新</NButton>
      </NFlex>
    </NFlex>

    <NEmpty v-if="!selectedProject" description="当前会话未关联项目目录" />
    <NAlert v-if="selectedProject && error" type="error" closable class="block" @close="error = ''">{{ error }}</NAlert>
    <NAlert v-if="selectedProject && selectedCommit" type="info" :show-icon="false" class="block">
      历史 commit 为只读视图，人工认领仅支持当前工作树。
    </NAlert>

    <NFlex v-if="selectedProject" :size="12" class="block">
      <NSelect
        v-model:value="selectedCommit"
        :options="commitOptions"
        filterable
        placeholder="当前工作树"
        style="width:360px"
        @update:value="refresh"
      />
      <NSelect
        v-model:value="selectedFile"
        :options="fileOptions"
        filterable
        placeholder="选择文件"
        style="min-width:360px;flex:1"
        @update:value="loadSelectedFile"
      />
    </NFlex>

    <NGrid v-if="selectedProject" :cols="4" :x-gap="12" responsive="screen" class="block">
      <NGi><NCard size="small"><NStatistic label="AI 行占比" :value="(metrics.ai_share * 100).toFixed(1)" suffix="%" /></NCard></NGi>
      <NGi><NCard size="small"><NStatistic label="接受率" :value="(metrics.acceptance_rate * 100).toFixed(1)" suffix="%" /></NCard></NGi>
      <NGi><NCard size="small"><NStatistic label="Agent 生成" :value="metrics.generated_lines" /></NCard></NGi>
      <NGi><NCard size="small"><NStatistic label="最终采纳" :value="metrics.accepted_lines" /></NCard></NGi>
    </NGrid>

    <NCard v-if="selectedProject" size="small" :title="selectedFile || '逐行归因'" class="table-card">
      <template #header-extra>
        <span class="metric-note">
          {{ metrics.commit_sha ? `commit ${metrics.commit_sha.slice(0, 12)}` : '尚无 commit 指标' }}
          · AI {{ metrics.ai_lines }}/{{ metrics.total_added_lines }} 新增行
        </span>
      </template>
      <NSpin :show="loading">
        <NDataTable
          v-if="lines.length"
          :columns="columns"
          :data="lines"
          :row-key="row => row.line_no"
          :max-height="620"
          :scroll-x="960"
          virtual-scroll
        />
        <NEmpty v-else description="尚无可查证的文件修改" />
      </NSpin>
    </NCard>

    <NModal v-model:show="claimOpen" preset="card" title="认领人工修改" style="width:520px">
      <NFlex vertical :size="12">
        <div class="modal-path">{{ selectedFile }}</div>
        <NAlert v-if="claimError" type="error" closable @close="claimError = ''">{{ claimError }}</NAlert>
        <NFlex align="center">
          <span>行号</span>
          <NInputNumber v-model:value="claimStart" :min="1" />
          <span>至</span>
          <NInputNumber v-model:value="claimEnd" :min="claimStart" />
        </NFlex>
        <NInput v-model:value="claimAuthor" placeholder="Name <email@example.com>" />
        <NAlert type="warning" :show-icon="false">
          只有明确的人工证据才应认领；已有 Agent 或 human 归因不会被覆盖。
        </NAlert>
        <NFlex justify="end">
          <NButton @click="claimOpen = false">取消</NButton>
          <NButton type="primary" :loading="claiming" :disabled="!canSubmitClaim" @click="submitClaim">
            确认认领
          </NButton>
        </NFlex>
      </NFlex>
    </NModal>

    <NModal
      v-model:show="evidenceOpen"
      preset="card"
      title="修改证据详情"
      style="width:min(1120px,94vw)"
      content-style="max-height:calc(90vh - 100px);overflow:auto"
    >
      <NSpin :show="evidenceLoading">
        <NAlert v-if="evidenceError" type="error" closable class="block" @close="evidenceError = ''">
          {{ evidenceError }}
        </NAlert>
        <template v-if="evidence">
          <NDescriptions bordered :column="3" size="small" class="block">
            <NDescriptionsItem label="Session">
              <NButton
                v-if="evidence.session_id"
                text
                type="primary"
                size="small"
                @click="router.push(`/session/${evidence.session_id}`)"
              >
                {{ evidence.session_id }}
              </NButton>
              <template v-else>—</template>
            </NDescriptionsItem>
            <NDescriptionsItem label="来源">{{ actorLabel(evidence.actor_kind) }}</NDescriptionsItem>
            <NDescriptionsItem label="Agent 名称">
              {{ evidence.agent_name || '未提供' }}
            </NDescriptionsItem>
            <NDescriptionsItem label="Runtime / Model">
              {{ [evidence.runtime, evidence.model].filter(Boolean).join(' / ') || '—' }}
            </NDescriptionsItem>
            <NDescriptionsItem label="工具">{{ evidence.tool_name }}</NDescriptionsItem>
            <NDescriptionsItem label="状态">{{ captureStatus(evidence) }}</NDescriptionsItem>
            <NDescriptionsItem label="开始">{{ evidence.started_at }}</NDescriptionsItem>
            <NDescriptionsItem label="结束">{{ evidence.finished_at || '—' }}</NDescriptionsItem>
            <NDescriptionsItem label="耗时">{{ captureDuration(evidence) }}</NDescriptionsItem>
            <NDescriptionsItem label="工作目录" :span="3">
              <span class="evidence-id">{{ evidence.cwd }}</span>
            </NDescriptionsItem>
            <NDescriptionsItem label="Git 边界" :span="3">
              <span class="evidence-id">
                {{ shortSha(evidence.head_before) }} → {{ shortSha(evidence.head_after) }}
              </span>
              <span v-if="evidence.committed_sha" class="muted">
                · commit {{ shortSha(evidence.committed_sha) }}
              </span>
            </NDescriptionsItem>
          </NDescriptions>
          <NAlert v-for="item in evidence.conflicts" :key="`${item.kind}:${item.created_at}`" type="warning" :show-icon="false" class="block">
            {{ item.kind }} · {{ item.detail }} · {{ item.created_at }}
          </NAlert>

          <NCard size="small" title="文件变化" class="block">
            <NDataTable
              v-if="evidence.mutations.length"
              :columns="mutationColumns"
              :data="evidence.mutations"
              :row-key="row => row.path"
              size="small"
            />
            <NEmpty v-else description="未记录文件变化" />
          </NCard>

          <NCollapse
            arrow-placement="right"
            :default-expanded-names="contextFields.length ? ['context'] : []"
          >
            <NCollapseItem
              v-if="contextFields.length || Object.keys(extraAttributes).length"
              title="修改上下文"
              name="context"
            >
              <NCard
                v-for="item in contextFields"
                :key="item.label"
                size="small"
                :title="item.label"
                class="detail-card"
              >
                <NCode :code="formatEvidence(item.value)" language="text" word-wrap />
              </NCard>
              <NCard
                v-if="Object.keys(extraAttributes).length"
                size="small"
                title="其他 Attributes"
                class="detail-card"
              >
                <NCode :code="formatEvidence(extraAttributes)" language="json" word-wrap />
              </NCard>
            </NCollapseItem>

            <NCollapseItem title="工具输入与输出" name="tool-io">
              <NGrid cols="1 m:2" responsive="screen" :x-gap="12" :y-gap="12">
                <NGi>
                  <NCard size="small" title="Tool Input">
                    <NCode :code="formatEvidence(evidence.tool_input)" language="json" word-wrap />
                  </NCard>
                </NGi>
                <NGi>
                  <NCard size="small" title="Tool Output">
                    <NCode :code="formatEvidence(evidence.tool_output)" language="json" word-wrap />
                  </NCard>
                </NGi>
              </NGrid>
            </NCollapseItem>

            <NCollapseItem title="技术标识" name="identifiers">
              <NDescriptions bordered :column="1" size="small">
                <NDescriptionsItem label="Capture ID">
                  <span class="evidence-id">{{ evidence.capture_id }}</span>
                </NDescriptionsItem>
                <NDescriptionsItem label="Tool Use ID">
                  <span class="evidence-id">{{ evidence.tool_use_id }}</span>
                </NDescriptionsItem>
                <NDescriptionsItem label="原生 Session ID">
                  <span class="evidence-id">{{ evidence.native_session_id || '—' }}</span>
                </NDescriptionsItem>
                <NDescriptionsItem label="父原生 Session ID">
                  <span class="evidence-id">{{ evidence.parent_native_session_id || '—' }}</span>
                </NDescriptionsItem>
                <NDescriptionsItem label="原生 Agent ID">
                  <span class="evidence-id">{{ evidence.native_agent_id || '—' }}</span>
                </NDescriptionsItem>
              </NDescriptions>
            </NCollapseItem>

            <NCollapseItem title="Before / After 快照" name="snapshots">
              <NGrid cols="1 m:2" responsive="screen" :x-gap="12" :y-gap="12">
                <NGi>
                  <NCard size="small" title="Before">
                    <NCode v-if="evidenceBefore && !evidenceBefore.binary" :code="evidenceBefore.content" language="text" word-wrap />
                    <NEmpty v-else :description="evidenceBefore?.binary ? '二进制内容' : '无 before 快照'" />
                  </NCard>
                </NGi>
                <NGi>
                  <NCard size="small" title="After">
                    <NCode v-if="evidenceAfter && !evidenceAfter.binary" :code="evidenceAfter.content" language="text" word-wrap />
                    <NEmpty v-else :description="evidenceAfter?.binary ? '二进制内容' : '无 after 快照'" />
                  </NCard>
                </NGi>
              </NGrid>
            </NCollapseItem>
          </NCollapse>
        </template>
      </NSpin>
    </NModal>
  </div>
</template>

<style scoped>
.page { height: 100%; overflow: auto; box-sizing: border-box; padding: 12px; background: transparent }
.page-header { margin-bottom: 16px }
h2 { margin: 0; font-size: 20px }
.project-path { margin-top: 4px; color: #8f8f8f; font-size: 12px; word-break: break-all }
.block { margin-bottom: 16px }
.table-card { min-height: 320px }
.metric-note { color: #8f8f8f; font-size: 12px }
.modal-path { font-family: 'JetBrains Mono', monospace; font-size: 12px; word-break: break-all }
.detail-card { margin-bottom: 12px }
.detail-card:last-child { margin-bottom: 0 }
.evidence-id { font-family: 'JetBrains Mono', monospace; font-size: 12px; word-break: break-all }
.muted { color: #8f8f8f }
.addition-count { color: #18a058 }
.deletion-count { color: #d03050 }
:deep(.source-line) { font-family: 'JetBrains Mono', monospace; white-space: pre; font-size: 12px }
:deep(pre) { margin: 0; max-height: 460px; overflow: auto; white-space: pre-wrap; word-break: break-word }
</style>

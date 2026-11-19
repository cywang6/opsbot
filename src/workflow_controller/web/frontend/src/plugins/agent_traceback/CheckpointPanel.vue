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
// agent_traceback plugin — checkpoint panel (list / replay / file preview /
// origin jump-back / fork sessions). Moved out of core SessionDetailView so the
// core view no longer carries checkpoint UI or state. Rendered only when the
// agent_traceback plugin is loaded (guarded by the parent). The fixed-position
// overlays (replay dialog / file preview) render correctly from within.
import { computed, ref, watch } from 'vue'
import { NCard, NTag, NBadge, NFlex, NEmpty, NText } from 'naive-ui'
import { useToast } from '../../composables/useToast'
import { useCheckpoints } from './useCheckpoints'
import { birthTracebackOf } from './types'
import type { CheckpointInfo, CheckpointFileContent, TracebackResult } from './types'
import type { CheckpointFile } from './types'
import type { SessionInfo } from '../../types/api'
import ReplayConfigModal from './ReplayConfigModal.vue'

// 检查点时间展示为浏览器本地时区的完整日期与分钟：[YYYY-MM-DD HH:mm]
function formatCheckpointTime(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `[${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}]`
}

const props = defineProps<{
  sessionId: string
  sessions: SessionInfo[]
  subagentStartCount: number
  sessionState?: string
  subagentNoMap?: Map<string, number>
}>()
const emit = defineEmits<{
  (e: 'open-session', id: string): void
  (e: 'checkpoints-update', cps: CheckpointInfo[]): void
  (e: 'forks-update', forks: SessionInfo[]): void
}>()

const toast = useToast()
const { listCheckpoints, listCheckpointFiles, readCheckpointFile } = useCheckpoints()

const session = computed(() =>
  props.sessions.find(s => s.id === props.sessionId),
)
const birthTraceback = computed(() => birthTracebackOf(session.value?.plugin_metadata))
const originSession = computed(() =>
  birthTraceback.value
    ? props.sessions.find(s => s.id === birthTraceback.value!.origin_session_id)
    : undefined,
)

const checkpoints = ref<CheckpointInfo[]>([])

const replayableCheckpoints = computed(() =>
  checkpoints.value.filter(c => c.git_ref && c.status === 'ok'),
)

// Fork sessions: sessions that birthed from this session via traceback.
const forkSessions = computed(() =>
  props.sessions.filter(s =>
    birthTracebackOf(s.plugin_metadata)?.origin_session_id === props.sessionId,
  ),
)

// Feed topology (fork edges + replayable markers) back to the parent so the
// core topology graph can augment without owning checkpoint data.
watch(checkpoints, cps => emit('checkpoints-update', cps), { immediate: true, deep: false })
watch(forkSessions, fs => emit('forks-update', fs), { immediate: true, deep: false })

// ── checkpoint loading ───────────────────────────────────────────────
async function loadCheckpoints() {
  checkpoints.value = await listCheckpoints(props.sessionId)
}

// Reload checkpoints when a new subagent start arrives (mid-run checkpoints).
watch(() => props.subagentStartCount, async () => { await loadCheckpoints() })

// Reload when the session transitions out of running (final stop may create a
// checkpoint just before completion).
watch(() => props.sessionState, async (newState, oldState) => {
  if (oldState === 'running' && newState && newState !== 'running') {
    await loadCheckpoints()
  }
})

// Initial load + when sessionId changes.
watch(() => props.sessionId, async () => {
  await loadCheckpoints()
}, { immediate: true })

// ── replay ───────────────────────────────────────────────────────────
// 重放：点击检查点 → 打开 ReplayConfigModal；提交后由该 modal 调 traceback API，
// 本组件只负责开 modal + 监听结果跳转。
const replayModalRef = ref<InstanceType<typeof ReplayConfigModal> | null>(null)
const replayCheckpoint = ref<CheckpointInfo | null>(null)

function onReplay(checkpointId: string) {
  const cp = checkpoints.value.find(c => c.checkpoint_id === checkpointId)
  if (!cp) { toast.error('Checkpoint not found'); return }
  replayCheckpoint.value = cp
  replayModalRef.value?.open()
}

function onReplayed(result: TracebackResult) {
  replayCheckpoint.value = null
  if (result.ok && result.session_id) {
    emit('open-session', result.session_id)
  }
}

// ── file-state preview ───────────────────────────────────────────────
const showFilePreview = ref(false)
const previewCheckpoint = ref<CheckpointInfo | null>(null)
const previewFiles = ref<CheckpointFile[]>([])
const previewFile = ref<CheckpointFileContent | null>(null)
const previewPath = ref('')
const previewLoading = ref(false)

async function openFilePreview(checkpointId: string) {
  const cp = checkpoints.value.find(c => c.checkpoint_id === checkpointId)
  if (!cp) return
  previewCheckpoint.value = cp
  previewPath.value = ''
  previewFile.value = null
  previewFiles.value = []
  showFilePreview.value = true
  await loadPreviewDir('')
}

async function loadPreviewDir(path: string) {
  if (!previewCheckpoint.value) return
  previewPath.value = path
  previewFile.value = null
  previewLoading.value = true
  try {
    previewFiles.value = await listCheckpointFiles(
      props.sessionId, previewCheckpoint.value.checkpoint_id, path,
    )
  } finally {
    previewLoading.value = false
  }
}

async function loadPreviewFile(path: string) {
  if (!previewCheckpoint.value) return
  previewLoading.value = true
  try {
    previewFile.value = await readCheckpointFile(
      props.sessionId, previewCheckpoint.value.checkpoint_id, path,
    )
  } finally {
    previewLoading.value = false
  }
}

function previewUp(): string {
  const p = previewPath.value
  if (!p || !p.includes('/')) return ''
  return p.slice(0, p.lastIndexOf('/'))
}

// Exposed so the core topology graph's re-call badge (which lives in the parent)
// can trigger this panel's replay dialog without the parent owning checkpoint
// state.
defineExpose({ onReplay })

function subagentNoOf(cp: CheckpointInfo): number | undefined {
  if (cp.agent_id) return props.subagentNoMap?.get(cp.agent_id)
  return undefined
}
</script>

<template>
  <n-flex vertical :size="16">
    <!-- Origin session jump-back (this session is a replay) -->
    <n-card v-if="birthTraceback" size="small" title="源会话">
      <n-flex align="center" :size="8" style="padding:6px 8px;border-radius:6px;cursor:pointer" @click="originSession && $emit('open-session', originSession.id)">
        <n-badge v-if="originSession" :dot="true" :type="originSession.state === 'running' ? 'success' : 'default'" />
        <n-text style="font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ originSession?.name || '...' }}</n-text>
        <n-text depth="3">←</n-text>
      </n-flex>
    </n-card>

    <!-- Checkpoint list -->
    <n-card size="small">
      <template #header>
        <n-flex align="center" :size="8">
          <span style="font-size:14px;font-weight:600">检查点</span>
          <n-tag class="checkpoint-count-tag" size="small" :bordered="false">{{ replayableCheckpoints.length }}</n-tag>
        </n-flex>
      </template>
      <div v-if="replayableCheckpoints.length > 0" class="checkpoint-list">
        <div
          v-for="cp in replayableCheckpoints"
          :key="cp.checkpoint_id"
          class="checkpoint-item"
          @click="onReplay(cp.checkpoint_id)"
        >
          <span v-if="subagentNoOf(cp)" class="cp-no">#{{ subagentNoOf(cp) }}</span>
          <span class="cp-icon" :title="cp.status">↻</span>
          <span class="cp-type">{{ cp.trigger === 'session_complete' ? 'final' : (cp.agent_type || cp.agent_id?.slice(0, 8) || 'main') }}</span>
          <button
            class="cp-preview-btn"
            title="预览检查点文件态"
            @click.stop="openFilePreview(cp.checkpoint_id)"
          ><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg></button>
          <span class="cp-time">{{ formatCheckpointTime(cp.created_at) }}</span>
        </div>
      </div>
      <n-empty v-else size="small" :description="checkpoints.length === 0 ? '无检查点 — 在 Dashboard 启用 Traceback 后运行会话即可创建' : '无可重放检查点（快照可能失败或超时）'" />
    </n-card>

    <!-- Fork sessions (traceback replays of this session) -->
    <n-card v-if="forkSessions.length > 0" size="small" :title="`重放会话 (${forkSessions.length})`">
      <n-flex vertical :size="6">
        <div
          v-for="fork in forkSessions"
          :key="fork.id"
          style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer"
          @click="$emit('open-session', fork.id)"
        >
          <n-badge :dot="true" :type="fork.state === 'running' ? 'success' : 'default'" />
          <n-text style="font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">↻ {{ fork.name }}</n-text>
          <n-tag v-if="birthTracebackOf(fork.plugin_metadata)" size="tiny" type="warning" round>{{ birthTracebackOf(fork.plugin_metadata)?.origin_checkpoint_id }}</n-tag>
        </div>
      </n-flex>
    </n-card>
  </n-flex>

  <!-- 重放配置弹窗（提交后跳转新 session） -->
  <ReplayConfigModal
    ref="replayModalRef"
    :session-id="sessionId"
    :checkpoint="replayCheckpoint"
    :project-dir="session?.project_dir"
    @replayed="onReplayed"
  />

  <!-- Checkpoint file-state preview modal -->
  <div class="replay-overlay" v-if="showFilePreview" @click.self="showFilePreview = false">
    <div class="file-preview-dialog">
      <div class="file-preview-header">
        <h3 class="replay-title">检查点文件态预览</h3>
        <span class="file-preview-cp" v-if="previewCheckpoint">{{ previewCheckpoint.checkpoint_id }} · iter {{ previewCheckpoint.iteration }}</span>
      </div>
      <div class="file-preview-breadcrumb">
        <span class="fp-crumb clickable" @click="loadPreviewDir('')">root</span>
        <template v-for="(seg, i) in previewPath ? previewPath.split('/') : []" :key="i">
          <span class="fp-sep">/</span>
          <span class="fp-crumb clickable" @click="loadPreviewDir(previewPath.split('/').slice(0, i + 1).join('/'))">{{ seg }}</span>
        </template>
        <button v-if="previewPath" class="fp-up" @click="loadPreviewDir(previewUp())" title="Up">↑</button>
      </div>
      <div class="file-preview-body">
        <div class="file-list" v-if="!previewFile">
          <div v-if="previewLoading" class="fp-empty">Loading…</div>
          <div v-else-if="previewFiles.length === 0" class="fp-empty">No files</div>
          <div
            v-for="f in previewFiles"
            :key="f.path"
            class="file-entry"
            :class="{ 'is-dir': f.is_dir }"
            @click="f.is_dir ? loadPreviewDir(f.path) : loadPreviewFile(f.path)"
          >
            <span class="fp-icon">{{ f.is_dir ? '📁' : '📄' }}</span>
            <span class="fp-name">{{ f.name }}</span>
          </div>
        </div>
        <div v-else class="file-content-view">
          <button class="fp-back" @click="previewFile = null">← back to {{ previewPath || 'root' }}</button>
          <div class="fp-file-name">{{ previewFile.name }} <span class="fp-size" v-if="previewFile.size">{{ previewFile.size }} bytes</span></div>
          <pre class="fp-content">{{ previewFile.content }}</pre>
        </div>
      </div>
      <div class="replay-actions">
        <button class="btn btn-sm" @click="showFilePreview = false">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Checkpoint list (设计 §7.1) */
.checkpoint-count-tag { background:rgba(148,163,184,.12) !important; color:var(--workflow-controller-text-muted, #94a3b8) !important; }
.checkpoint-list { display: flex; flex-direction: column; gap: 4px; max-height: 300px; overflow-y: auto }
.checkpoint-item { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 5px; font-size: 12px; cursor: pointer; transition: background .15s }
.checkpoint-item:hover { background: rgba(148,163,184,.08); color:var(--workflow-controller-text, #f8fafc); }
.cp-icon { color: #f59e0b; font-size: 13px }
.cp-no { font-size: 11px; color: #9ca3af; font-family: 'JetBrains Mono', monospace; font-weight: 500 }
.cp-type { font-weight: 600; color: var(--workflow-controller-text, #cbd5e1); font-family: 'JetBrains Mono', monospace; flex: 1 }
.cp-preview-btn { background: transparent; border: 0; color:var(--workflow-controller-text, #cbd5e1); border-radius: 4px; padding: 1px 5px; cursor: pointer; font-size: 12px; line-height: 1 }
.cp-preview-btn:hover { background: rgba(148,163,184,.12); color:var(--workflow-controller-text, #f8fafc); }
.cp-time { font-size: 11px; color: #9ca3af; font-family: 'JetBrains Mono', monospace }

/* 共享遮罩层（文件态预览弹窗用） */
.replay-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 1000 }
.replay-title { font-size: 16px; font-weight: 600; margin: 0 0 16px; color: var(--workflow-controller-text, #f8fafc) }
.replay-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px }

/* Checkpoint file-state preview modal */
.file-preview-dialog { background: var(--workflow-controller-modal, #172033); color:var(--workflow-controller-text, #e2e8f0); border-radius: 10px; padding: 20px; max-width: 680px; width: 92%; max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 8px 24px rgba(0,0,0,.15) }
.file-preview-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px }
.file-preview-cp { font-size: 11px; color: var(--workflow-controller-text-muted, #94a3b8); font-family: 'JetBrains Mono', monospace }
.file-preview-breadcrumb { display: flex; align-items: center; gap: 4px; padding: 6px 8px; background: var(--workflow-controller-surface, #111827); border-radius: 6px; font-size: 12px; margin-bottom: 8px; flex-wrap: wrap }
.fp-crumb { color: #aab4ff; cursor: pointer }
.fp-crumb:hover { text-decoration: underline }
.fp-sep { color: #64748b }
.fp-up { margin-left: auto; background: transparent; border: 1px solid rgba(148,163,184,.24); color:var(--workflow-controller-text, #cbd5e1); border-radius: 4px; cursor: pointer; padding: 1px 8px; font-size: 12px }
.file-preview-body { flex: 1; overflow: hidden; min-height: 200px }
.file-list { height: 100%; overflow-y: auto; display: flex; flex-direction: column; gap: 2px }
.file-entry { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 5px; font-size: 12px; cursor: pointer; transition: background .15s }
.file-entry:hover { background: rgba(148,163,184,.08); }
.file-entry.is-dir { font-weight: 600 }
.fp-icon { font-size: 14px }
.fp-name { font-family: 'JetBrains Mono', monospace; color: var(--workflow-controller-text, #cbd5e1) }
.fp-empty { padding: 16px; text-align: center; color: #9ca3af; font-size: 12px }
.file-content-view { height: 100%; display: flex; flex-direction: column }
.fp-back { background: none; border: none; color: #aab4ff; cursor: pointer; font-size: 12px; align-self: flex-start; margin-bottom: 8px }
.fp-file-name { font-size: 13px; font-weight: 600; font-family: 'JetBrains Mono', monospace; margin-bottom: 6px; color: var(--workflow-controller-text, #f8fafc) }
.fp-size { font-size: 11px; color: #9ca3af; font-weight: 400 }
.fp-content { flex: 1; overflow: auto; background: var(--workflow-controller-surface, #111827); color:var(--workflow-controller-text, #cbd5e1); border-radius: 6px; padding: 10px; font-size: 11px; line-height: 1.5; font-family: 'JetBrains Mono', monospace; white-space: pre-wrap; word-break: break-word; margin: 0 }
</style>

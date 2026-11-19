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
import { ref, watch, onMounted, onUnmounted, onActivated } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NSpin, NFlex, NModal, NTabs, NTabPane, NInput } from 'naive-ui'
import { useSSE } from '../composables/useSSE'
import { useSessions } from '../composables/useSessions'
import { useRecentDirs } from '../composables/useRecentDirs'
import { useToast } from '../composables/useToast'
import { useConfirm } from '../composables/useConfirm'
import { useProjectPaths } from '../composables/useProjectPaths'
import { usePlugins } from '../composables/usePlugins'
import NewSessionModal from '../components/NewSessionModal.vue'
import DirPicker from '../components/common/DirPicker.vue'
import InlineDirectoryPicker from '../components/common/InlineDirectoryPicker.vue'

const router = useRouter()
const toast = useToast()
const { confirmAction } = useConfirm()
const { connected } = useSSE()
const { stopAll } = useSessions()
const { addDir } = useRecentDirs()
const { projectDir } = useProjectPaths()

const newSessionModalRef = ref<InstanceType<typeof NewSessionModal> | null>(null)
// 插件列表装载：NewSessionModal 的 graph 分支按 pluginEnabled('graph') 消费共享列表
const { loadPlugins } = usePlugins()

async function doStopAll() {
  if (!await confirmAction('停止所有会话', '确定要停止所有项目的会话吗？')) return
  await stopAll()
  toast.info('正在停止所有会话...')
}

function openNewSession() {
  newSessionModalRef.value?.open()
}

function onSessionStarted(sessionId: string) {
  if (sessionId) {
    router.push(`/session/${sessionId}`)
  }
}

watch(connected, (val, prev) => {
  if (!val && prev) toast.warning('连接断开 · 正在重连...')
  if (val && !prev) toast.success('已重新连接')
})

onMounted(() => {
  loadPlugins()
  window.addEventListener('workflow-controller:open-new-session', handleOpenNewSession)
  window.addEventListener('workflow-controller:open-import', handleOpenImport)
  window.addEventListener('workflow-controller:stop-all', handleStopAll)
})
onActivated(loadPlugins)
onUnmounted(() => {
  window.removeEventListener('workflow-controller:open-new-session', handleOpenNewSession)
  window.removeEventListener('workflow-controller:open-import', handleOpenImport)
  window.removeEventListener('workflow-controller:stop-all', handleStopAll)
})

// 侧栏的新建/导入/全部停止按钮经全局事件触发；本视图（仅挂载于 '/'）统一承接。
function handleOpenNewSession() { openNewSession() }
function handleOpenImport() { void openImportModal() }
function handleStopAll() { void doStopAll() }

// ── Import ─────────────────────────────────────────────────────────
const showImportModal = ref(false)
const ocCandidates = ref<any[]>([])
const ocLoading = ref(false)
const ccCandidates = ref<any[]>([])
const ccLoading = ref(false)
const importing = ref<Record<string, boolean>>({})

// ── Cannbot DB 导入重建 ──
// POST /api/sessions/import-db {db_path, target_cwd} → 同步阻塞到完成，返回 {ok, session_id, ..., log_path}。
// 重放耗时长，按钮 loading；失败可点「下载日志」排查。
const cannbotDbPath = ref('')
const cannbotTargetCwd = ref('')
const cannbotImporting = ref(false)
const cannbotDbPickerRef = ref<InstanceType<typeof DirPicker> | null>(null)
const cannbotCwdPickerRef = ref<InstanceType<typeof DirPicker> | null>(null)

async function openImportModal() {
  showImportModal.value = true
  // opencode-db tab：target_cwd 默认取当前项目目录
  if (!cannbotTargetCwd.value) cannbotTargetCwd.value = projectDir.value
  ocLoading.value = true; ccLoading.value = true
  try { const r = await fetch(`/api/v1/sessions/opencode?directory=${encodeURIComponent(projectDir.value)}`); ocCandidates.value = (await r.json()).sessions || [] } catch {}
  ocLoading.value = false
  try { const r = await fetch(`/api/v1/sessions/claude?directory=${encodeURIComponent(projectDir.value)}`); ccCandidates.value = (await r.json()).sessions || [] } catch {}
  ccLoading.value = false
}

// 从「本地文件夹」页签添加项目：写 recent_dirs + 持久化 project_dir。
async function onLocalFolderSelected(path: string) {
  const result = await addDir(path)
  if (!result.ok) {
    if (result.error === 'path not found') toast.error('该路径在当前主机不存在')
    else if (result.error === 'transient dir') toast.error('该路径位于系统临时目录（会被系统自动清理），不能作为项目目录')
    else toast.error('项目添加失败')
    return
  }
  projectDir.value = path
  try {
    const res = await fetch('/api/v1/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_dir: path }) })
    if (!res.ok) throw new Error(`PUT /api/v1/config ${res.status}`)
    const saveRes = await fetch('/api/v1/config/save', { method: 'POST' })
    if (!saveRes.ok) throw new Error(`POST /api/v1/config/save ${saveRes.status}`)
    toast.success('项目已添加')
    showImportModal.value = false
  } catch (e: any) {
    toast.error(`项目添加失败（保存配置出错）: ${e?.message || e}`)
  }
}

async function doImportOc(ocId: string) {
  importing.value[ocId] = true
  try { const d = await (await fetch('/api/v1/sessions/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opencode_session_id: ocId }) })).json(); if (d.success) { toast.success('Imported'); ocCandidates.value = ocCandidates.value.filter(s => s.id !== ocId) } else { toast.error(d.error || 'Import failed') } } catch { toast.error('Import failed') }
  importing.value[ocId] = false
}

async function doImportCc(ccId: string) {
  importing.value[ccId] = true
  try { const d = await (await fetch('/api/v1/sessions/import-claude', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: ccId, directory: projectDir.value }) })).json(); if (d.success) { toast.success('Imported'); ccCandidates.value = ccCandidates.value.filter(s => s.id !== ccId) } else { toast.error(d.error || 'Import failed') } } catch { toast.error('Import failed') }
  importing.value[ccId] = false
}

// 从 cannbot session db 重建 Workflow Controller session（含检查点）。同步阻塞到完成：
// 成功跳转 Session Detail，失败 toast 提示可下载日志排查。
async function doImportCannbot() {
  const dbPath = cannbotDbPath.value.trim()
  const targetCwd = cannbotTargetCwd.value.trim()
  if (!dbPath) { toast.error('请选择 cannbot session db 文件'); return }
  if (!targetCwd) { toast.error('请选择重建目标目录'); return }
  cannbotImporting.value = true
  try {
    const res = await fetch('/api/sessions/import-db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db_path: dbPath, target_cwd: targetCwd }),
    })
    const d = await res.json()
    if (d.ok && d.session_id) {
      toast.success('重建完成')
      router.push(`/session/${d.session_id}`)
    } else {
      toast.error(d.error || '重建失败，可下载日志排查')
    }
  } catch {
    toast.error('重建失败，可下载日志排查')
  }
  cannbotImporting.value = false
}

// 浏览器原生下载重建日志（重建中也能点，下载到的是 partial 日志）
function downloadReconstructLog() {
  const cwd = cannbotTargetCwd.value.trim()
  if (!cwd) return
  window.open(
    `/api/sessions/import-db/log?target_cwd=${encodeURIComponent(cwd)}`,
    '_blank',
  )
}
</script>

<template>
  <div class="dashboard-placeholder" aria-hidden="true" />

  <NewSessionModal ref="newSessionModalRef" @started="onSessionStarted" />

  <!-- Import Modal -->
  <n-modal v-model:show="showImportModal" preset="card" title="导入对话" style="width:560px">
    <n-tabs type="segment" animated>
      <n-tab-pane name="local-folder" tab="本地文件夹">
        <div class="local-folder-import">
          <div class="local-folder-title">添加本地项目</div>
          <div class="local-folder-description">选择一个本地文件夹，将它添加到左侧项目列表。</div>
          <InlineDirectoryPicker :initial-path="projectDir || undefined" @selected="onLocalFolderSelected" />
        </div>
      </n-tab-pane>
      <n-tab-pane name="opencode" tab="Opencode">
        <div v-if="ocLoading" style="padding:40px;text-align:center"><n-spin /></div>
        <div v-else-if="ocCandidates.length === 0" style="padding:20px;text-align:center;color:#999">没有找到可导入的对话</div>
        <n-flex v-else vertical size="small" style="max-height:360px;overflow-y:auto;padding:4px 0">
          <n-flex v-for="s in ocCandidates" :key="s.id" align="center" justify="space-between" style="padding:8px 0;border-bottom:1px solid #f0f0f0">
            <div style="flex:1;min-width:0"><div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ s.title }}</div><small style="color:#999">{{ s.directory }}</small></div>
            <n-button size="small" :loading="importing[s.id]" @click="doImportOc(s.id)">导入</n-button>
          </n-flex>
        </n-flex>
      </n-tab-pane>
      <n-tab-pane name="claude" tab="Claude Code">
        <div v-if="ccLoading" style="padding:40px;text-align:center"><n-spin /></div>
        <div v-else-if="ccCandidates.length === 0" style="padding:20px;text-align:center;color:#999">没有找到可导入的对话</div>
        <n-flex v-else vertical size="small" style="max-height:360px;overflow-y:auto;padding:4px 0">
          <n-flex v-for="s in ccCandidates" :key="s.id" align="center" justify="space-between" style="padding:8px 0;border-bottom:1px solid #f0f0f0">
            <div style="flex:1;min-width:0"><div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ s.title }}</div><small style="color:#999">{{ s.directory }}</small></div>
            <n-button size="small" :loading="importing[s.id]" @click="doImportCc(s.id)">导入</n-button>
          </n-flex>
        </n-flex>
      </n-tab-pane>
      <n-tab-pane name="opencode-db" tab="Opencode DB">
        <n-flex vertical size="large" style="padding:8px 0">
          <div>
            <div style="font-size:13px;font-weight:600;margin-bottom:6px;color:#171717">Session DB 文件</div>
            <n-flex align="center" :size="8">
              <n-input v-model:value="cannbotDbPath" placeholder="选择或输入 cannbot session db 文件路径" :input-props="{ spellcheck: false }" style="flex:1" />
              <n-button size="small" @click="($event.currentTarget as HTMLElement).blur(); cannbotDbPickerRef?.open(cannbotDbPath || projectDir || undefined)">浏览</n-button>
            </n-flex>
            <small style="color:#999;display:block;margin-top:4px">cannbot 录制的 session db（含 Session/Turn/ToolCall/Execution/InteractionBridge 表）</small>
          </div>
          <div>
            <div style="font-size:13px;font-weight:600;margin-bottom:6px;color:#171717">重建目标目录（空目录）</div>
            <n-flex align="center" :size="8">
              <n-input v-model:value="cannbotTargetCwd" placeholder="重建产出的工程目录路径" :input-props="{ spellcheck: false }" style="flex:1" />
              <n-button size="small" @click="($event.currentTarget as HTMLElement).blur(); cannbotCwdPickerRef?.open(cannbotTargetCwd || projectDir || undefined)">浏览</n-button>
            </n-flex>
            <small style="color:#999;display:block;margin-top:4px">将在此目录重建文件态 + 对话态 + 检查点（opencode.db / snapshots/.git / events.db）</small>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;padding-top:4px">
            <n-button :disabled="!cannbotTargetCwd" @click="downloadReconstructLog">下载日志</n-button>
            <n-button type="primary" :loading="cannbotImporting" :disabled="!cannbotDbPath || !cannbotTargetCwd" @click="doImportCannbot">重建并导入</n-button>
          </div>
          <small style="color:#bbb;display:block;text-align:right">重放耗时长，期间可点「下载日志」下载当前 partial 日志</small>
        </n-flex>
      </n-tab-pane>
    </n-tabs>
  </n-modal>

  <DirPicker ref="cannbotDbPickerRef" mode="file" @selected="cannbotDbPath = $event" />
  <DirPicker ref="cannbotCwdPickerRef" mode="dir" @selected="cannbotTargetCwd = $event" />
</template>

<style scoped>
.dashboard-placeholder {
  min-height: 100vh;
  background-image: var(--workflow-controller-empty-background-image, none);
  background-position: center;
  background-size: var(--workflow-controller-empty-background-size, cover);
  background-repeat: no-repeat;
}
.local-folder-import { display:flex; flex-direction:column; gap:10px; padding:16px 4px 6px; }
.local-folder-title { color:var(--workflow-controller-text, #f8fafc); font-size:15px; font-weight:600; letter-spacing:.01em; }
.local-folder-description { color:var(--workflow-controller-text-muted, #94a3b8); font-size:13px; line-height:20px; }
</style>

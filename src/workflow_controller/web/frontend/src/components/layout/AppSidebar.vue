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
import { useRoute, useRouter } from 'vue-router'
import { NButton, NEmpty, NList, NListItem, NModal, NSpin } from 'naive-ui'
import { useSettingsModal } from '../../composables/useSettingsModal'
import { useRecentDirs } from '../../composables/useRecentDirs'
import { useProjectPaths } from '../../composables/useProjectPaths'
import { useSSE } from '../../composables/useSSE'
import { useSessions } from '../../composables/useSessions'
import { useToast } from '../../composables/useToast'
import { useAuth } from '../../composables/useAuth'
import { useRuns } from '../../composables/useRuns'
import { DEFAULT_BRAND_NAME } from '../../utils/brand'
import DeleteSessionDialog from '../../plugins/agent_traceback/DeleteSessionDialog.vue'
import { logicalProjectDir } from '../../plugins/agent_traceback/types'

const router = useRouter()
const route = useRoute()
const settingsModal = useSettingsModal()
const toast = useToast()
const { removeSession } = useSessions()
const { authReady } = useAuth()
const { runs, refreshRuns } = useRuns()
const { removeDir } = useRecentDirs()
const { projectDir } = useProjectPaths()
// 项目列表 = 后端单一来源（SSE config.recent_dirs）。后端已合并 recent_dirs.json
// （用户手选，recency 优先）+ events.db sessions 的 cwd，去重后随 SSE 推送。
const { config, sessions } = useSSE()
const expandedProjects = ref<Record<string, boolean>>({})

function basename(path: string) {
  if (!path) return ''
  const parts = path.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : path
}

// 后端已合并好的统一列表，直接取 SSE config.recent_dirs。
const visibleDirs = computed<string[]>(() => config.value?.recent_dirs ?? [])

// 侧边栏品牌名：全局配置 brand_name（SSE 实时推），缺失回落默认。
const brandName = computed(
  () => config.value?.brand_name?.trim() || DEFAULT_BRAND_NAME,
)

const activeSessionId = computed(() => {
  return route.name === 'sessionDetail' ? String(route.params.id || '') : ''
})
const hasRunningSessions = computed(() => sessions.value.some(session => session.state === 'running'))

const showRunHistory = ref(false)
const loadingRuns = ref(false)
const runHistoryError = ref(false)

async function openRunHistory() {
  showRunHistory.value = true
  if (loadingRuns.value) return
  loadingRuns.value = true
  try {
    runHistoryError.value = !await refreshRuns({ silent: true })
  } finally {
    loadingRuns.value = false
  }
}

function sessionTitle(session: any) { return session.name || session.title || session.id }

// ── 删除会话（agent_traceback DeleteSessionDialog，含重建产物清理选项）──
const deleteDialogShow = ref(false)
const deleteTarget = ref<any>(null)
const deleting = ref(false)

function openDeleteDialog(session: any, event: Event) {
  event.stopPropagation()
  if (session.state === 'running') return
  deleteTarget.value = session
  deleteDialogShow.value = true
}

async function handleDeleteConfirm(payload: { clean_reconstruct?: 'workflow_controller' | 'all' }) {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    const result = await removeSession(deleteTarget.value.id, {
      clean_reconstruct: payload.clean_reconstruct,
    })
    if (result.ok) {
      // 级联清理可能连带删除重建子会话，一并纳入「是否命中当前会话」判定
      const deletedIds = new Set((result.deleted_session_ids ?? [deleteTarget.value.id]).map(String))
      toast.success('已删除会话')
      deleteDialogShow.value = false
      deleteTarget.value = null
      // 命中当前查看的会话时显式回首页：详情页 localSession 兜底会让
      // 「session 从有变 null」的 watcher 在正常流程中永不触发
      if (activeSessionId.value && deletedIds.has(activeSessionId.value)) router.replace('/')
    } else {
      toast.error(result.error || '删除失败')
    }
  } catch {
    toast.error('删除失败（网络错误）')
  } finally {
    deleting.value = false
  }
}

// 新建/导入/全部停止 的监听者只注册在 DashboardView（仅挂载于 '/'）。任何非 '/'
// 路由（/session/:id、/run/:id、/settings 深链）下都先跳回 '/' 再派发，
// 避免事件丢失或向 keep-alive 挂起的 Dashboard 派发导致弹窗不可见。
function dispatchDashboardEvent(name: string) {
  const dispatch = () => window.dispatchEvent(new CustomEvent(name))
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '/'
  if (pathname !== '/' && pathname !== '') {
    void router.push('/').finally(() => window.setTimeout(dispatch, 0))
    return
  }
  dispatch()
}
function requestNewSession() { dispatchDashboardEvent('workflow-controller:open-new-session') }
function requestImport() { dispatchDashboardEvent('workflow-controller:open-import') }
function requestStopAll() { dispatchDashboardEvent('workflow-controller:stop-all') }
function openSession(id: string) { router.push(`/session/${id}`) }

function normalizeDir(path: string | undefined) {
  if (!path) return ''
  if (path.length <= 1) return path
  return path.replace(/[\\/]+$/, '')
}

// 会话按「逻辑项目目录」归组：fork/回放会话（birth_traceback.fork_root）归入其源项目，
// 避免只按原始 project_dir 分组时 fork 会话从侧栏消失。
// graph 插件创建的节点会话（plugin_metadata.graph）不进入会话列表——graph 用户通过
// Graph 视图看各 node 的 session。
const sessionsByProject = computed(() => {
  const grouped = new Map<string, any[]>()
  for (const session of sessions.value) {
    if ((session.plugin_metadata as any)?.graph) continue
    const key = normalizeDir(logicalProjectDir(session, sessions.value))
    if (!key) continue
    const list = grouped.get(key) || []
    list.push(session)
    grouped.set(key, list)
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => String(b.created_at_iso || '').localeCompare(String(a.created_at_iso || '')))
  }
  return grouped
})

function projectSessions(path: string) {
  return sessionsByProject.value.get(normalizeDir(path)) || []
}

function isProjectExpanded(path: string) {
  const key = normalizeDir(path)
  return expandedProjects.value[key] ?? key === normalizeDir(projectDir.value)
}

async function persistProjectDir(path: string) {
  projectDir.value = path
  try {
    await fetch('/api/v1/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_dir: path }) })
  } catch {}
}

async function selectProject(path: string) {
  const key = normalizeDir(path)
  const isCurrent = key === normalizeDir(projectDir.value)
  expandedProjects.value[key] = isCurrent ? !isProjectExpanded(key) : true
  if (!isCurrent) {
    await persistProjectDir(path)
    router.push('/')
  }
}

// 行级 Enter/Space 仅在自己是事件目标时响应：内部「＋ / ×」按钮的 keydown 会冒泡上来，
// 且浏览器还会对聚焦按钮合成 click，若不加区分会触发「切项目 + 开弹窗」双动作。
function onProjectRowActivate(event: KeyboardEvent, path: string) {
  if (event.target !== event.currentTarget) return
  if (event.key === ' ') event.preventDefault()
  void selectProject(path)
}
function onSessionRowActivate(event: KeyboardEvent, id: string) {
  if (event.target !== event.currentTarget) return
  if (event.key === ' ') event.preventDefault()
  openSession(id)
}

// 项目行「＋」：与行点击一致地持久化 project_dir（PUT /api/v1/config + SSE 回推），
// 再打开新建会话弹窗，避免刷新后选中态回跳、或在 SSE config_update 回推前被覆盖。
async function onNewSessionInProject(path: string) {
  await persistProjectDir(path)
  expandedProjects.value[normalizeDir(path)] = true
  requestNewSession()
}
</script>

<template>
  <div class="sidebar">
    <!-- Logo -->
    <div class="sidebar-brand">
      <span class="sidebar-title">{{ brandName }}</span>
    </div>

    <div class="section-header">
      <span class="section-label">项目</span>
      <button class="browse-btn" @click="requestImport">添加项目</button>
    </div>

    <!-- 项目导航：会话直接挂在项目下，项目行可展开/收起 -->
    <div class="project-list">
      <div v-for="(path, idx) in visibleDirs" :key="path" class="project-group">
        <div
          class="project-row"
          :class="{ active: normalizeDir(projectDir) === normalizeDir(path), expanded: isProjectExpanded(path) }"
          role="button"
          tabindex="0"
          :title="path"
          :aria-expanded="isProjectExpanded(path)"
          :aria-controls="`project-sessions-${idx}`"
          @click="selectProject(path)"
          @keydown.enter="onProjectRowActivate($event, path)"
          @keydown.space="onProjectRowActivate($event, path)"
        >
          <svg class="project-folder-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 7.5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <span class="project-name">{{ basename(path) }}</span>
          <span class="project-actions">
            <button class="project-new-session" :disabled="!authReady" title="新建会话" aria-label="新建会话" @click.stop="onNewSessionInProject(path)">＋</button>
            <button class="dir-delete-btn" title="移除" @click.stop="void removeDir(path)">×</button>
          </span>
        </div>
        <div v-if="isProjectExpanded(path)" :id="`project-sessions-${idx}`" class="project-sessions">
          <div v-for="item in projectSessions(path)" :key="item.id" class="project-session-row" :class="{ active: activeSessionId === item.id, 'idle-session': item.state === 'idle' }" role="button" tabindex="0" :title="sessionTitle(item)" @click="openSession(item.id)" @keydown.enter="onSessionRowActivate($event, item.id)" @keydown.space="onSessionRowActivate($event, item.id)">
            <span v-if="item.state === 'running'" title="会话正在运行" class="project-running-dot" aria-label="会话正在运行" />
            <span v-else-if="item.state !== 'idle'" class="history-dot" :class="`state-${item.state || 'idle'}`" />
            <span class="history-name">{{ sessionTitle(item) }}</span>
            <button v-if="item.state !== 'running'" class="history-delete" title="删除会话" @click="openDeleteDialog(item, $event)">×</button>
          </div>
        </div>
      </div>
    </div>

    <div class="history-section">
      <button v-if="hasRunningSessions" class="sidebar-stop-action" @click="requestStopAll">全部停止</button>
    </div>

    <!-- 底部固定：运行记录和设置 -->
    <div class="sidebar-footer">
      <button class="settings-btn" @click="openRunHistory">运行记录</button>
      <button class="settings-btn" @click="settingsModal.open()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8f8f8f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
        <span>设置</span>
      </button>
    </div>
  </div>

  <n-modal v-model:show="showRunHistory" preset="card" title="运行记录" style="width:min(560px, 92vw)">
    <n-spin v-if="loadingRuns" />
    <n-empty v-else-if="runHistoryError" description="无法加载运行记录">
      <template #extra>
        <n-button size="small" @click="openRunHistory">重试</n-button>
      </template>
    </n-empty>
    <n-list v-else-if="runs.length" style="max-height:60vh;overflow-y:auto">
      <n-list-item v-for="run in runs" :key="run.run_id">
        <router-link
          class="run-history-link"
          :to="{ name: 'runView', params: { id: run.run_id } }"
          :title="run.run_id"
          @click="showRunHistory = false"
        >{{ run.label || run.run_id }}</router-link>
        <template #suffix>{{ run.status }}</template>
      </n-list-item>
    </n-list>
    <n-empty v-else description="暂无运行记录" />
  </n-modal>

  <DeleteSessionDialog
    :show="deleteDialogShow"
    :session="deleteTarget"
    :loading="deleting"
    @update:show="deleteDialogShow = $event"
    @confirm="handleDeleteConfirm"
  />
</template>

<style scoped>
.sidebar {
  box-sizing: border-box;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 12px;
  background: linear-gradient(180deg, #111a31 0%, #0d1426 55%, #0b1020 100%);
  border-right: 1px solid rgba(148,163,184,.18);
  color: #f8fafc;
}

.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 12px;
}
.sidebar-title { font-size: 16px; font-weight: 700; color: #f8fafc; letter-spacing: .3px }

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px 4px 12px;
  margin: 0 4px;
}
.section-label {
  font-size: 14px;
  color: #cbd5e1;
  font-weight: 400;
  line-height: 22px;
}
.browse-btn {
  background: transparent;
  border: 1px solid rgba(170,180,255,.7);
  cursor: pointer;
  padding: 3px 9px;
  font-size: 14px;
  line-height: 1;
  border-radius: 5px;
  color: #aab4ff;
  opacity: 1;
  transition: background .15s, border-color .15s, color .15s;
}
.browse-btn:hover { background: rgba(124,140,255,.16); border-color:#c4b5fd; color:#c4b5fd; }
.browse-btn:disabled { opacity: .45; cursor: not-allowed; background: transparent; border-color: rgba(170,180,255,.7); color: inherit; }

.dir-delete-btn {
  appearance: none;
  background: transparent !important;
  border: 0 !important;
  cursor: pointer;
  padding: 0 2px;
  line-height: 1;
  color: #64748b;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  font-size: 18px;
  opacity: 0;
  flex-shrink: 0;
}
.project-row .dir-delete-btn { opacity: 1; }
.dir-delete-btn:hover {
  color: #ef4444;
  background: rgba(255,124,134,.12) !important;
}

/* 运行中会话：绿色呼吸点（替代持续旋转的 loading 圈） */
.project-running-dot {
  position: relative;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  margin-left: 0;
  background: transparent;
  box-shadow: none;
  animation: none;
}
.project-running-dot::after {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #18a058;
  box-shadow: 0 0 0 0 rgba(24, 160, 88, .55);
  animation: project-running-pulse 1.4s ease-out infinite;
}

@keyframes project-running-pulse {
  0% { box-shadow: 0 0 0 0 rgba(24, 160, 88, .55); opacity: 1; }
  70% { box-shadow: 0 0 0 5px rgba(24, 160, 88, 0); opacity: .7; }
  100% { box-shadow: 0 0 0 0 rgba(24, 160, 88, 0); opacity: 1; }
}

/* 项目列表独立滚动（隐藏滚动条），底部按钮始终可见 */
.project-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 4px 0;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.project-list::-webkit-scrollbar {
  display: none;
}
.project-group { margin: 1px 0 4px; }
.project-row {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  margin: 1px 4px;
  padding: 5px 8px;
  border-radius: 9px;
  color: #cbd5e1;
  cursor: pointer;
  user-select: none;
  transition: background .12s, color .12s;
}
.project-row:hover { background: rgba(148,163,184,.08); color: #f8fafc; }
.project-row.active { background: transparent; color: #f8fafc; }
.project-folder-icon { flex: 0 0 18px; color: #aab4d1; }
.project-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.project-actions { display: flex; align-items: center; gap: 5px; flex: 0 0 auto; }
.project-new-session { appearance: none; display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: #aab4ff; cursor: pointer; font-size: 18px; line-height: 1; }
.project-new-session:hover { background: rgba(124,140,255,.16); color: #f8fafc; }
.project-new-session:disabled { opacity: .45; cursor: not-allowed; }
.project-row .dir-delete-btn { opacity: 1; }
.project-sessions { margin: 0 4px 2px; padding-left: 0; }
.project-session-row { box-sizing: border-box; display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 4px 6px; border-radius: 7px; color: #94a3b8; cursor: pointer; }
.project-session-row.idle-session { padding-left: 34px; }
.project-session-row:hover { background: rgba(148,163,184,.08); color: #f8fafc; }
.project-session-row.active { background: rgba(124,140,255,.16); color: #f8fafc; }
.project-session-row .history-name { font-size: 14px; }

.sidebar-footer {
  flex-shrink: 0;
  padding: 8px 4px 0;
  border-top: 1px solid rgba(148,163,184,.14);
  margin-top: 4px;
}
.run-history-link { color: var(--workflow-controller-primary); overflow-wrap: anywhere; }
.settings-btn {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  padding: 6px 8px;
  font-size: 14px;
  color: #cbd5e1 !important;
  border-radius: 6px;
  transition: background 0.12s;
}
.settings-btn:hover {
  background: rgba(148,163,184,.08);
  color: #f8fafc !important;
}

.history-section { flex:0 0 auto; min-height:0; padding:0 4px 10px; }
.history-dot { position:relative; display:grid; place-items:center; width:18px; height:18px; flex:0 0 18px; color:#64748b; }
.history-dot::after { content:""; width:7px; height:7px; border-radius:50%; background:currentColor; }
.history-dot.state-running { color:#35d6b1; }
.history-name { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
.history-delete {
  opacity:1;
  flex:0 0 24px;
  width:24px;
  height:24px;
  display:grid;
  place-items:center;
  padding:0;
  border:0;
  border-radius:6px;
  background:transparent;
  color:#94a3b8;
  cursor:pointer;
  font-size:16px;
  line-height:1;
  z-index:2;
}
.history-delete:hover { color:#ff9ca3; background:rgba(255,124,134,.12); }
.sidebar-stop-action { width:100%; margin-top:7px; padding:5px 8px; border:1px solid rgba(255,124,134,.28); border-radius:7px; background:rgba(255,124,134,.08); color:#ff9ca3; cursor:pointer; font-size:11px; }
</style>

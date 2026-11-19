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
import { ref, computed, nextTick } from 'vue'

// mode='dir'（默认）：选目录；mode='file'：选文件（点击文件即 emit + 关闭）。
// cannbot-db 导入用 file 模式浏览 .db 文件。
const props = withDefaults(defineProps<{ mode?: 'dir' | 'file' }>(), { mode: 'dir' })
const emit = defineEmits<{ selected: [path: string] }>()

const pickerEl = ref<HTMLElement | null>(null)
const visible = ref(false)
const currentPath = ref('')
const parentPath = ref<string | null>(null)
const entries = ref<{ name: string; is_dir: boolean; path: string }[]>([])
const loading = ref(false)
const error = ref('')
const pathInput = ref('')
const showHidden = ref(false)

const isDrives = computed(() => currentPath.value === '::drives')
const currentName = computed(
  () => currentPath.value.split(/[\\/]/).filter(Boolean).pop() || currentPath.value,
)
const pickerTitle = computed(() => props.mode === 'file' ? 'Select File' : 'Select Directory')

async function open(startPath?: string) {
  visible.value = true
  error.value = ''
  await navigate(startPath || '::drives')
  // 自动聚焦：在 Naive UI n-modal 上打开时，焦点会困在 modal 里，
  // 导致 @keydown 无法触发。须显式 focus。
  await nextTick()
  pickerEl.value?.focus()
}

async function navigate(path: string) {
  pathInput.value = ''
  loading.value = true
  error.value = ''
  try {
    const r = await fetch(`/api/v1/list-directory?path=${encodeURIComponent(path)}&show_hidden=${showHidden.value}`)
    const d = await r.json()
    if (d.error) { error.value = d.error; entries.value = [] }
    else {
      currentPath.value = d.path
      parentPath.value = d.parent
      entries.value = d.entries || []
    }
  } catch (e: any) { error.value = `Failed: ${e}` }
  loading.value = false
}

function select(path: string) {
  visible.value = false
  emit('selected', path)
}

function onEntryClick(e: { name: string; is_dir: boolean; path: string }) {
  if (e.is_dir) navigate(e.path)
  else if (props.mode === 'file') select(e.path)
  // dir 模式点文件：无操作（用底部按钮选当前目录）
}

function navUp() {
  if (parentPath.value) navigate(parentPath.value)
}

function goPath() {
  const p = pathInput.value.trim()
  if (p) navigate(p)
}

async function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') visible.value = false
}

defineExpose({ open })
</script>

<template>
  <Teleport to="body">
    <Transition name="dirpicker-fade">
      <div v-if="visible" class="overlay" @click.self="visible=false" @keydown="onKeydown">
        <div class="picker" tabindex="0" ref="pickerEl">
          <div class="picker-header">
            <span class="picker-title">{{ pickerTitle }}</span>
            <button class="btn btn-sm" @click="visible=false">✕</button>
          </div>

          <div class="breadcrumb">
            <button class="btn btn-sm" v-if="parentPath !== null" @click="navUp">↑ Up</button>
            <span class="breadcrumb-path mono">{{ isDrives ? 'This PC' : currentPath }}</span>
          </div>

          <div class="path-input-row">
            <input
              v-model="pathInput"
              class="input path-input"
              placeholder="Type a path and press Enter..."
              @keydown.enter="goPath"
            />
            <button class="btn btn-sm" @click="goPath">Go</button>
          </div>

          <div class="hidden-toggle">
            <label class="toggle-label">
              <input type="checkbox" v-model="showHidden" @change="navigate(currentPath)" />
              <span>Show hidden files</span>
            </label>
          </div>

          <div class="picker-body">
            <div v-if="loading" class="empty-state">Loading...</div>
            <div v-else-if="error" class="empty-state" style="color:#ef4444">{{ error }}</div>
            <div v-else-if="entries.length===0" class="empty-state">Empty directory</div>
            <div v-for="e in entries" :key="e.path"
                 class="entry"
                 :class="{dir:e.is_dir, pickable: mode==='file' && !e.is_dir}"
                 @click="onEntryClick(e)">
              <span class="entry-icon">{{ e.is_dir ? '📁' : '📄' }}</span>
              <span class="entry-name">{{ e.name }}</span>
            </div>
          </div>

          <div class="picker-footer">
            <button class="btn" @click="visible=false">Cancel</button>
            <button v-if="mode==='dir'" class="btn btn-primary" :disabled="isDrives" @click="select(currentPath)">{{ isDrives ? 'Select a drive' : `Select "${currentName}"` }}</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* Teleport 到 body + z-index 3000，确保在 n-modal 上方可点击 */
.overlay {
  position: fixed; inset: 0; background: rgba(2,6,23,.72);
  display: flex; align-items: center; justify-content: center;
  z-index: 3000;
}
.dirpicker-fade-enter-active, .dirpicker-fade-leave-active { transition: opacity .12s ease; }
.dirpicker-fade-enter-from, .dirpicker-fade-leave-to { opacity: 0; }
.picker {
  background: var(--workflow-controller-modal, #172033); border: 1px solid rgba(148,163,184,.2); border-radius: 12px; width: 560px; max-height: 520px;
  display: flex; flex-direction: column;
  box-shadow: 0 20px 60px rgba(2,6,23,.5);
  outline: none;
}
.picker-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 18px; border-bottom: 1px solid rgba(148,163,184,.18);
}
.picker-title { font-weight: 600; font-size: 14px; color: var(--workflow-controller-text, #f8fafc); }
.breadcrumb {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 14px; background: var(--workflow-controller-surface, #111827); border-bottom: 1px solid rgba(148,163,184,.18);
  font-size: 12px;
}
.breadcrumb-path { color: var(--workflow-controller-text-muted, #94a3b8); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.path-input-row {
  display: flex; gap: 6px;
  padding: 6px 14px; background: var(--workflow-controller-surface, #111827); border-bottom: 1px solid rgba(148,163,184,.18);
}
.path-input { flex: 1; font-size: 12px; font-family: 'JetBrains Mono', monospace; }
.input { min-width: 0; padding: 7px 9px; border: 1px solid rgba(148,163,184,.28); border-radius: 8px; background: var(--workflow-controller-input, #0f172a); color: var(--workflow-controller-text, #f8fafc); outline: none; }
.input::placeholder { color: #64748b; }
.input:focus { border-color: #8b9cff; box-shadow: 0 0 0 2px rgba(124,140,255,.16); }
.hidden-toggle {
  padding: 4px 14px; font-size: 12px;
  border-bottom: 1px solid rgba(148,163,184,.18); background: var(--workflow-controller-surface, #111827);
}
.toggle-label { display: flex; align-items: center; gap: 6px; cursor: pointer; color: var(--workflow-controller-text-muted, #94a3b8); }
.toggle-label input[type="checkbox"] { margin: 0; }
.picker-body { flex: 1; overflow-y: auto; padding: 4px 0; max-height: 280px; }
.entry {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 14px; cursor: pointer; font-size: 13px;
  transition: background .1s;
}
.entry:hover { background: rgba(124,140,255,.12); }
.entry-icon { font-size: 14px; width: 20px; text-align: center; }
.entry-name { color: var(--workflow-controller-text, #cbd5e1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.entry.dir .entry-name { color: var(--workflow-controller-text, #f8fafc); font-weight: 500; }
.entry.pickable { cursor: pointer; }
.entry.pickable:hover .entry-name { color: #c4b5fd; }
.picker-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 18px; border-top: 1px solid rgba(148,163,184,.18);
}
.mono { font-family: 'JetBrains Mono', monospace; }
.empty-state { padding: 30px; text-align: center; color: var(--workflow-controller-text-muted, #94a3b8); }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 14px; font-size: 13px; font-weight: 500; border: 1px solid rgba(148,163,184,.28); border-radius: 8px; background: var(--workflow-controller-surface, #111827); color: var(--workflow-controller-text, #cbd5e1); cursor: pointer; transition: all .15s; font-family: inherit; }
.btn:hover { background: var(--workflow-controller-hover, #1f2a44); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn-sm { padding: 4px 10px; font-size: 12px; border-radius: 5px; }
.btn-primary { background: #6d7cff; color: #fff; border-color: #6d7cff; }
.btn-primary:hover { background: #7c8cff; }
</style>

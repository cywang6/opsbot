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
import { ref, watch } from 'vue'

// 内嵌目录选择器：直接嵌在弹窗/表单里浏览服务器目录，替代再叠一层目录弹窗。
const props = defineProps<{ initialPath?: string }>()
const emit = defineEmits<{ selected: [path: string] }>()
const currentPath = ref(props.initialPath || '::drives')
const parentPath = ref<string | null>(null)
const pathInput = ref('')
const entries = ref<{ name: string; is_dir: boolean; path: string }[]>([])
const loading = ref(false)
const error = ref('')
const showHidden = ref(false)

// 目录点击/路径回车/隐藏开关等多个入口并发触发 navigate 时，旧请求可能后返回；
// 仅接受最新一次请求的响应，过期响应直接丢弃，防止覆盖成过期目录。
let navigateSeq = 0
async function navigate(path: string) {
  const seq = ++navigateSeq
  loading.value = true
  error.value = ''
  try {
    const res = await fetch(`/api/v1/list-directory?path=${encodeURIComponent(path)}&show_hidden=${showHidden.value}`)
    const data = await res.json()
    if (seq !== navigateSeq) return
    if (data.error) { error.value = data.error; entries.value = [] }
    else { currentPath.value = data.path; parentPath.value = data.parent; entries.value = data.entries || [] }
  } catch (err) {
    if (seq !== navigateSeq) return
    error.value = String(err); entries.value = []
  }
  loading.value = false
}
function selectEntry(entry: { is_dir: boolean; path: string }) { if (entry.is_dir) void navigate(entry.path) }
function goPath() { const path = pathInput.value.trim(); if (path) { pathInput.value = ''; void navigate(path) } }
function chooseCurrent() { if (currentPath.value !== '::drives') emit('selected', currentPath.value) }
watch(showHidden, () => void navigate(currentPath.value))
watch(() => props.initialPath, (path) => { void navigate(path || '::drives') }, { immediate: true })
</script>

<template>
  <div class="inline-directory-picker">
    <div class="inline-directory-toolbar">
      <button class="inline-directory-button" :disabled="!parentPath" @click="parentPath && navigate(parentPath)">↑ 上级</button>
      <span class="inline-directory-path">{{ currentPath === '::drives' ? '此电脑' : currentPath }}</span>
    </div>
    <div class="inline-directory-input-row">
      <input v-model="pathInput" class="inline-directory-input" placeholder="输入路径后按 Enter" @keydown.enter="goPath" />
      <button class="inline-directory-button" @click="goPath">前往</button>
    </div>
    <label class="inline-directory-toggle"><input v-model="showHidden" type="checkbox" /> 显示隐藏文件</label>
    <div class="inline-directory-body">
      <div v-if="loading" class="inline-directory-empty">加载中…</div>
      <div v-else-if="error" class="inline-directory-empty error">{{ error }}</div>
      <button v-for="entry in entries" v-else :key="entry.path" class="inline-directory-entry" :class="{ file: !entry.is_dir }" @click="selectEntry(entry)">
        <span>{{ entry.is_dir ? '📁' : '📄' }}</span><span>{{ entry.name }}</span>
      </button>
      <div v-if="!loading && !error && !entries.length" class="inline-directory-empty">目录为空</div>
    </div>
    <div class="inline-directory-footer">
      <span class="inline-directory-selected">{{ currentPath === '::drives' ? '请选择一个目录' : currentPath }}</span>
      <button class="inline-directory-primary" :disabled="currentPath === '::drives'" @click="chooseCurrent">选择当前目录</button>
    </div>
  </div>
</template>

<style scoped>
.inline-directory-picker { width:100%; overflow:hidden; border:1px solid var(--workflow-controller-border, rgba(148,163,184,.2)); border-radius:12px; background:var(--workflow-controller-surface, #111827); box-shadow:0 10px 24px rgba(2,6,23,.18); }
.inline-directory-toolbar, .inline-directory-input-row { display:flex; align-items:center; gap:8px; padding:9px 10px; border-bottom:1px solid var(--workflow-controller-border, rgba(148,163,184,.14)); }
.inline-directory-path, .inline-directory-selected { min-width:0; overflow:hidden; color:var(--workflow-controller-text-muted, #94a3b8); font-size:12px; line-height:18px; text-overflow:ellipsis; white-space:nowrap; }
.inline-directory-input { min-width:0; flex:1; padding:8px 10px; border:1px solid var(--workflow-controller-border, rgba(148,163,184,.24)); border-radius:8px; outline:none; background:var(--workflow-controller-input, #0f172a); color:var(--workflow-controller-text, #f8fafc); font-size:12px; }
.inline-directory-input:focus { border-color:#8b9cff; }
.inline-directory-toggle { display:block; padding:8px 10px; border-bottom:1px solid var(--workflow-controller-border, rgba(148,163,184,.14)); color:var(--workflow-controller-text-muted, #94a3b8); font-size:12px; }
.inline-directory-body { max-height:210px; overflow:auto; padding:5px 0; }
.inline-directory-entry { display:flex; align-items:center; gap:9px; width:100%; padding:8px 12px; border:0; background:transparent; color:var(--workflow-controller-text, #cbd5e1); cursor:pointer; text-align:left; font-size:13px; }
.inline-directory-entry:hover { background:rgba(124,140,255,.12); color:var(--workflow-controller-text, #f8fafc); }
.inline-directory-entry.file { cursor:default; }
.inline-directory-empty { padding:24px 10px; color:var(--workflow-controller-text-muted, #64748b); font-size:12px; text-align:center; }
.inline-directory-empty.error { color:#ff9ca3; }
.inline-directory-footer { display:flex; align-items:center; gap:10px; padding:10px; border-top:1px solid var(--workflow-controller-border, rgba(148,163,184,.14)); }
.inline-directory-selected { flex:1; }
.inline-directory-button, .inline-directory-primary { flex:0 0 auto; white-space:nowrap; border:1px solid var(--workflow-controller-border, rgba(148,163,184,.24)); border-radius:8px; padding:7px 11px; background:var(--workflow-controller-modal, #172033); color:var(--workflow-controller-text, #cbd5e1); cursor:pointer; font-size:12px; }
.inline-directory-button:hover { background:var(--workflow-controller-hover, #1f2a44); color:var(--workflow-controller-text, #f8fafc); }
.inline-directory-primary { border-color:#6d7cff; background:#6d7cff; color:#fff; }
.inline-directory-primary:hover { background:#7c8cff; }
.inline-directory-button:disabled, .inline-directory-primary:disabled { cursor:not-allowed; opacity:.45; }
</style>

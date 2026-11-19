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
import { h, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NDataTable, NFlex, NInput, NModal, NTag } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import type { RunSession } from '../types/runs'
import { useRuns } from '../composables/useRuns'
import { useToast } from '../composables/useToast'

const props = defineProps<{ runId: string; sessions: RunSession[] }>()
const emit = defineEmits<{ changed: [] }>()

const router = useRouter()
const toast = useToast()
const { controlSession, injectSession } = useRuns()

const stateColors: Record<string, string> = {
  running: '#52c41a', idle: '#999999', paused: '#0891b2',
  completed: '#52c41a', failed: '#f5222d', stopped: '#bfbfbf',
}

const roleType: Record<string, 'default' | 'info' | 'warning'> = {
  executor: 'default', verifier: 'info', handoff: 'warning',
}

async function doControl(action: 'pause' | 'resume' | 'stop', row: RunSession) {
  if (await controlSession(props.runId, row.session_id, action)) {
    toast.success(`成员操作已受理：${action}`)
    emit('changed')
  }
}

// 定向注入弹窗（一次只服务一个成员）
const injectShow = ref(false)
const injectTarget = ref<RunSession | null>(null)
const injectPrompt = ref('')
const injecting = ref(false)

// 打开定向注入弹窗（按钮焦点已由统一包装释放）
function openInject(row: RunSession) {
  injectTarget.value = row
  injectPrompt.value = ''
  injectShow.value = true
}

async function doInject() {
  const row = injectTarget.value
  const prompt = injectPrompt.value.trim()
  if (!row || !prompt) return
  injecting.value = true
  try {
    if (await injectSession(props.runId, row.session_id, prompt)) {
      toast.success('已注入成员')
      injectShow.value = false
    }
  } finally {
    injecting.value = false
  }
}

const columns: DataTableColumns<RunSession> = [
  {
    title: 'session',
    key: 'session_id',
    width: 230,
    ellipsis: { tooltip: true },
    render(row) {
      const children: any[] = [
        h('span', { style: 'font-family:JetBrains Mono,monospace;font-size:12px' }, row.session_id),
      ]
      if (row.in_flight) {
        children.push(h(NTag, { size: 'tiny', bordered: false, style: 'margin-left:6px' }, { default: () => '在途' }))
      }
      return h('div', { style: 'display:flex;align-items:center' }, children)
    },
  },
  {
    title: '角色',
    key: 'role',
    width: 90,
    render(row) {
      return h(NTag, { size: 'small', type: roleType[row.role] ?? 'default', bordered: false }, { default: () => row.role })
    },
  },
  {
    title: 'context',
    key: 'context',
    ellipsis: { tooltip: true },
    render(row) {
      return h('span', { style: 'font-family:JetBrains Mono,monospace;font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)' }, row.context || '—')
    },
  },
  {
    title: '状态',
    key: 'state',
    width: 90,
    render(row) {
      const s = (row.state || '').toLowerCase()
      return h(NTag, { size: 'small', bordered: false, color: { color: stateColors[s] || '#999999' } }, { default: () => row.state || '—' })
    },
  },
  {
    title: 'stop_reason',
    key: 'stop_reason',
    width: 110,
    ellipsis: { tooltip: true },
    render(row) {
      return h('span', { style: 'font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)' }, row.stop_reason || '—')
    },
  },
  {
    title: '',
    key: 'actions',
    width: 210,
    render(row) {
      const btn = (label: string, handler: () => void, type?: 'error') =>
        h(NButton, {
          size: 'tiny', quaternary: true, type,
          onClick: (e: Event) => { e.stopPropagation(); (e.currentTarget as HTMLElement).blur(); handler() },
        }, { default: () => label })
      return h('div', { style: 'display:flex;gap:2px' }, [
        btn('暂停', () => doControl('pause', row)),
        btn('恢复', () => doControl('resume', row)),
        btn('停止', () => doControl('stop', row), 'error'),
        btn('注入', () => openInject(row)),
      ])
    },
  },
]
</script>

<template>
  <n-data-table
    :columns="columns"
    :data="sessions"
    :bordered="false"
    size="small"
    :max-height="'calc(100vh - 380px)'"
    :row-props="(row: RunSession) => ({ style: 'cursor:pointer', onClick: () => router.push(`/session/${row.session_id}`) })"
  />

  <n-modal v-model:show="injectShow" preset="card" title="成员定向注入" style="width:520px">
    <n-flex vertical size="small">
      <span style="font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f);font-family:JetBrains Mono,monospace">{{ injectTarget?.session_id }}</span>
      <n-input v-model:value="injectPrompt" type="textarea" placeholder="注入给该成员的提示词" :autosize="{ minRows: 3 }" />
      <div style="display:flex;justify-content:flex-end">
        <n-button size="small" :loading="injecting" :disabled="!injectPrompt.trim()" @click="doInject">注入</n-button>
      </div>
    </n-flex>
  </n-modal>
</template>

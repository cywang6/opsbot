<script setup lang="ts">
// Copyright (c) 2026 Workflow Controller Contributors
//
// Licensed under the MIT License (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://opensource.org/licenses/MIT
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// 删除：在清理 PR !381 合入时，连同主题契约测试中的组件断言一并删除。
import { NBadge, NButton, NTag } from 'naive-ui'
import type { SessionInfo } from '../types/api'
import { birthTracebackOf } from '../plugins/agent_traceback/types'

// run 卡片内的成员会话行（也承载单成员隐式分组的整卡呈现）
defineProps<{
  session: SessionInfo
  waiting: boolean
}>()
const emit = defineEmits<{ open: []; delete: [] }>()

function loopStatusLabel(s: SessionInfo) {
  if (s.state === 'running') return '运行中'
  if (s.role === 'handoff_agent') {
    if (s.loop_status === 'yes') return '运行中'
    if (s.result === 'success') return '已完成'
    if (s.result === 'fail') return '失败'
    return '空闲'
  }
  if (s.loop_status === 'yes') return '空闲'
  if (s.loop_status === 'no') {
    const reason = s.stop_reason || ''
    if (reason === 'error' && s.error) return '错误'
    if (reason === 'timeout') return '错误'
    if (reason === 'user_pause') return '已暂停'
    if (reason === 'handoff_triggered') return '已交接'
    if (reason === 'evaluator_complete') return '已完成'
    if (reason === 'reviewer_complete') return '已完成'
    if (reason === 'max_iterations') return '已达上限'
    if (reason === 'iteration_gate_stop') return '已完成'
    return '空闲'
  }
  return '空闲'
}

function loopStatusType(s: SessionInfo): 'success' | 'error' | 'warning' | 'info' | 'default' {
  if (s.state === 'running') return 'success'
  if (s.role === 'handoff_agent') {
    if (s.result === 'success') return 'info'
    if (s.result === 'fail') return 'error'
    return 'default'
  }
  if (s.loop_status === 'no') {
    const reason = s.stop_reason || ''
    if (reason === 'error' || reason === 'timeout') return 'error'
    if (reason === 'evaluator_complete' || reason === 'reviewer_complete' || reason === 'max_iterations') return 'info'
  }
  return 'default'
}

function fmtDur(s: number) {
  if (s >= 3600) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return `${h}h ${m}m` }
  if (s >= 60) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
  return `${Math.floor(s)}s`
}

function onDelete(e: Event) {
  e.stopPropagation()
  ;(e.currentTarget as HTMLElement).blur()
  emit('delete')
}
</script>

<template>
  <div
    class="member-row"
    @click="emit('open')"
  >
    <n-badge dot :type="session.state === 'running' ? 'success' : 'default'" :processing="session.state === 'running'" />
    <span class="name" :title="session.name">{{ session.name }}</span>
    <span
      v-if="birthTracebackOf(session.plugin_metadata)?.fork_root"
      class="fork-badge"
      title="重放派生会话"
    >↻</span>
    <n-tag v-if="waiting" size="small" type="warning" :bordered="false">等待输入</n-tag>
    <n-tag size="small" :type="loopStatusType(session)" :bordered="false">
      {{ loopStatusLabel(session) }}
    </n-tag>
    <span class="meta">{{ session.current_iteration }}/{{ session.max_iterations }}</span>
    <span class="meta">{{ fmtDur(session.elapsed_seconds) }}</span>
    <n-button
      v-if="session.state !== 'running'"
      size="small"
      type="error"
      quaternary
      @click="onDelete"
    >删除</n-button>
  </div>
</template>

<style scoped>
.member-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px 5px 28px;
  cursor: pointer;
  border-bottom: 1px solid var(--workflow-controller-divider, #f0f0f0);
}
.member-row:hover { background: var(--workflow-controller-hover, #fafafa); }
.name {
  flex: 1;
  min-width: 0;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fork-badge {
  font-size: 11px;
  color: #a855f7;
  border: 1px solid #d8b4fe;
  border-radius: 4px;
  padding: 0 4px;
  line-height: 16px;
}
.meta {
  font-family: JetBrains Mono, monospace;
  font-size: 12px;
  color: var(--workflow-controller-text-muted, #6f6f6f);
  white-space: nowrap;
}
</style>

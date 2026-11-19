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

<!--
  节点运行历史侧栏（Run 工作台内）：竖轨时间线呈现逐次尝试
  （状态/起止/验收/输出/成员会话定位）、carried/空占位语义、跨代全景、
  本节点触发的回滚。成员点击两态：session 成员 → 打开会话详情
  （/session/:id）；无会话成员 → 灰态说明。
  （自 context-insight 移植；指标透镜/时间构成/冗余信号块不随移植——
  那是 insight 的会话观测数据功能，投影不携带。）
-->
<script setup lang="ts">
import { ref } from 'vue'
import type { AttemptRecord, NodeInstance, RollbackRecord, SessionMemberRef } from '../lib/view-model'
import { nodeKeyOf } from '../lib/view-model'
import { bandLabel, statusColor, statusLabel } from '../lib/run-theme'

defineProps<{
  node: NodeInstance
  rollbacks: RollbackRecord[]
  peers: Array<{ key: string; generation: number; status: string }>
}>()

const emit = defineEmits<{
  selectNode: [key: string]
  locateSession: [sessionId: string]
  close: []
}>()

const EXECUTION_STATE_TEXT: Record<NodeInstance['executionState'], string> = {
  executed: '本代执行过',
  not_run: '本代尚未运行',
  carried: '本代承接编排状态，未重跑',
}

/** 确定性格式的时间行：同日只写一次日期，跨日各自带日期。 */
function formatRange(startIso: string | null, endIso: string | null): string {
  const clock = (iso: string): { date: string; time: string } | null => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return null
    const p = (n: number) => String(n).padStart(2, '0')
    return { date: `${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` }
  }
  const s = startIso !== null ? clock(startIso) : null
  const e = endIso !== null ? clock(endIso) : null
  if (!s) return '—'
  if (!e) return `${s.date} ${s.time} → —`
  return s.date === e.date ? `${s.date} ${s.time} → ${e.time}` : `${s.date} ${s.time} → ${e.date} ${e.time}`
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3_600_000)}h${Math.round((ms % 3_600_000) / 60_000)}m`
}

const isoMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : t
}

/** 尝试有效起止/时长：执行/验收成员起止合并（manifest 缺端点时按已有端点）。 */
function attemptRange(a: AttemptRecord): { start: string | null; end: string | null } {
  const start = a.executeMember.startedAt
  const ends = [a.executeMember.finishedAt, a.verifyMember?.finishedAt].filter((x): x is string => typeof x === 'string')
  return { start: start ?? null, end: ends.length > 0 ? ends[ends.length - 1] : null }
}
function attemptSpanMs(a: AttemptRecord): number | null {
  const { start, end } = attemptRange(a)
  const s = isoMs(start)
  const e = isoMs(end)
  return s !== null && e !== null ? Math.max(e - s, 0) : null
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 14)}…` : id
}

/** 状态 pill 内联样式：状态色为 var() 引用，透明度变体用 color-mix 派生
 *  （十六进制透明度后缀拼接对 var() 引用非法）。 */
function pillStyle(status: string) {
  const c = statusColor(status)
  return {
    color: c,
    borderColor: `color-mix(in srgb, ${c} 35%, transparent)`,
    backgroundColor: `color-mix(in srgb, ${c} 9%, transparent)`,
  }
}

const VERIFICATION_TYPE_TEXT: Record<string, string> = {
  agent: 'Agent',
  script: '脚本',
  none: '无',
}

function typeTextOf(type: string): string {
  return VERIFICATION_TYPE_TEXT[type] ?? type
}

// 验收报告展开态（键：attempt ordinal——本节点内唯一）
const expandedReports = ref(new Set<number>())
function toggleReport(ordinal: number): void {
  const next = new Set(expandedReports.value)
  if (next.has(ordinal)) next.delete(ordinal)
  else next.add(ordinal)
  expandedReports.value = next
}
</script>

<template>
  <div class="run-node-detail">
    <div class="detail-header">
      <div class="detail-heading">
        <h2 class="detail-title">{{ node.label }}</h2>
        <p class="detail-sub">
          {{ bandLabel(node.generation) }} · {{ EXECUTION_STATE_TEXT[node.executionState] }}{{ node.taskType === 'generator' ? ' · 子图生成器' : node.taskType === 'workflow' ? ' · 子图节点' : node.taskType === 'bash' ? ' · 无 Agent 会话' : ' · Agent 节点' }}
        </p>
      </div>
      <button class="icon-btn" aria-label="关闭" @click="emit('close')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="run-icon"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
      </button>
    </div>

    <div class="detail-meta">
      <div class="meta-row">
        <span class="status-pill" :style="pillStyle(node.status)">
          <span class="status-dot" :style="{ backgroundColor: statusColor(node.status) }" />
          {{ statusLabel(node.status) }}
        </span>
        <span v-if="node.attempts.length > 0" class="meta-text">执行 {{ node.attempts.length }} 次</span>
      </div>
      <span v-if="node.retryPolicy" class="meta-text faint" title="重试策略">
        重试上限 {{ node.retryPolicy.maxRetries ?? '?' }} · 用尽后 {{ node.retryPolicy.onExhaust ?? '?' }}
      </span>
    </div>

    <div class="detail-body">
      <div v-if="node.executionState === 'carried' && node.carriedFromGeneration !== null" class="carried-banner">
        本代没有重新执行，沿用
        <button class="carried-link" @click="emit('selectNode', nodeKeyOf(node.nodeId, node.carriedFromGeneration!))">
          {{ bandLabel(node.carriedFromGeneration) }}
        </button>
        的结果
      </div>

      <div v-if="node.attempts.length === 0" class="empty-attempts">
        <template v-if="node.pendingMembers.length > 0">
          本代尚未执行（attempt=0，role={{ node.pendingMembers[0].role }}）：
          {{ node.pendingMembers[0].kind === 'session' ? 'sessionId=null，location=null——一旦执行会以真实成员替换占位。' : 'Bash process 尚无执行输出。' }}
        </template>
        <template v-else>本代没有执行记录；未运行不代表数据被删除。</template>
      </div>
      <div v-else class="attempt-list">
        <div v-for="(a, i) in node.attempts" :key="a.ordinal" class="attempt-item" :class="{ last: i === node.attempts.length - 1 }">
          <span v-if="i !== node.attempts.length - 1" class="attempt-rail" aria-hidden="true" />
          <span class="attempt-node" :style="{ borderColor: statusColor(a.status) }" aria-hidden="true" />
          <div class="attempt-card">
            <div class="attempt-head">
              <span class="attempt-ordinal">第 {{ a.ordinal }} 次</span>
              <span v-if="a.ordinal > 1" class="retry-chip">重试 {{ a.ordinal - 1 }}</span>
              <span class="status-pill" :style="pillStyle(a.status)">
                <span class="status-dot" :style="{ backgroundColor: statusColor(a.status) }" />
                {{ typeTextOf(a.verification.type) !== '无' ? `${typeTextOf(a.verification.type)} · ${statusLabel(a.status)}` : statusLabel(a.status) }}
              </span>
              <span v-if="a.verification.reason && a.verification.reason.length <= 80" class="attempt-reason">（{{ a.verification.reason }}）</span>
              <span
                v-if="attemptSpanMs(a) !== null && attemptSpanMs(a)! >= 0"
                class="attempt-duration"
                :title="`耗时 ${formatDurationMs(attemptSpanMs(a)!)}`"
              >{{ formatDurationMs(attemptSpanMs(a)!) }}</span>
            </div>
            <div class="attempt-range">{{ formatRange(attemptRange(a).start, attemptRange(a).end) }}</div>
            <div v-if="a.verification.reason && a.verification.reason.length > 80" class="verify-report">
              <div class="verify-report-head">
                <span class="meta-text">验收报告</span>
                <button class="verify-toggle" :aria-expanded="expandedReports.has(a.ordinal)" @click="toggleReport(a.ordinal)">
                  {{ expandedReports.has(a.ordinal) ? '收起' : '展开' }}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="run-icon tiny" :class="{ flipped: expandedReports.has(a.ordinal) }"><path d="m6 9 6 6 6-6" /></svg>
                </button>
              </div>
              <pre v-if="expandedReports.has(a.ordinal)" class="verify-report-full">{{ a.verification.reason }}</pre>
              <div v-else class="verify-report-preview">{{ a.verification.reason }}</div>
            </div>
            <pre v-if="a.outputText" class="attempt-output">{{ a.outputText }}</pre>
            <div class="member-list">
              <template v-for="m in ([a.executeMember, a.verifyMember].filter(Boolean) as SessionMemberRef[])" :key="`${a.ordinal}-${m.role}`">
                <div v-if="m.sessionId" class="member-row">
                  <button class="member-link" :title="`打开会话详情（${m.sessionId}）`" @click="emit('locateSession', m.sessionId!)">
                    {{ m.role === 'execute' ? '执行' : '验收' }}：{{ shortId(m.sessionId) }}
                  </button>
                </div>
                <span v-else class="member-none">
                  {{ m.role === 'execute' ? '执行' : '验收' }}：无成员会话（{{ m.kind === 'process' ? 'Bash/脚本' : '未开始' }}）
                </span>
              </template>
            </div>
          </div>
        </div>
      </div>

      <div v-if="rollbacks.length > 0" class="detail-section">
        <h3 class="section-title">触发的回滚</h3>
        <div class="rollback-list">
          <button
            v-for="r in rollbacks" :key="r.ordinal"
            class="rollback-link"
            @click="emit('selectNode', r.targetKey)"
          >
            回滚 #{{ r.ordinal }}：第 {{ r.from.attempt }} 次尝试失败（{{ r.from.nodeId }}）→ {{ r.to.nodeId }} {{ bandLabel(r.to.generation) }} 第 {{ r.to.attempt }} 次
          </button>
        </div>
      </div>

      <div v-if="peers.length > 0" class="detail-section">
        <h3 class="section-title">其他代</h3>
        <div class="peer-list">
          <button v-for="p in peers" :key="p.key" class="peer-chip" @click="emit('selectNode', p.key)">
            <span class="status-dot" :style="{ backgroundColor: statusColor(p.status) }" aria-hidden="true" />
            {{ bandLabel(p.generation) }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.run-node-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--run-text-primary);
  font-size: 12px;
}
.detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--run-text-primary) 8%, transparent);
}
.detail-heading { min-width: 0; }
.detail-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-sub {
  margin: 2px 0 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--run-text-faint);
}
.icon-btn {
  flex-shrink: 0;
  border: none;
  background: transparent;
  border-radius: 6px;
  padding: 4px;
  cursor: pointer;
  color: var(--run-text-faint);
  transition: background-color 140ms ease, color 140ms ease;
}
.icon-btn:hover {
  background: color-mix(in srgb, var(--run-text-primary) 5%, transparent);
  color: var(--run-text-primary);
}
.run-icon { width: 16px; height: 16px; }
.run-icon.tiny { width: 12px; height: 12px; }
.run-icon.flipped { transform: rotate(180deg); }

.detail-meta {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--run-text-primary) 8%, transparent);
}
.meta-row { display: flex; align-items: center; gap: 8px; }
.meta-text { font-size: 11px; color: var(--run-text-muted); }
.meta-text.faint { color: var(--run-text-faint); }

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 999px;
  border: 1px solid;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 16px;
}
.status-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 999px;
}

.detail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px;
}
.carried-banner {
  margin-bottom: 14px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--run-st-carried, #1b7c83) 30%, transparent);
  background: color-mix(in srgb, var(--run-st-carried, #1b7c83) 6%, transparent);
  padding: 8px 12px;
  font-size: 11px;
  line-height: 20px;
  color: var(--run-text-muted);
}
.carried-link {
  border: none;
  background: none;
  padding: 0 4px;
  cursor: pointer;
  color: var(--run-st-carried, #1b7c83);
}
.carried-link:hover { text-decoration: underline; }

.empty-attempts {
  border-radius: 8px;
  border: 1px dashed color-mix(in srgb, var(--run-text-primary) 15%, transparent);
  padding: 12px;
  font-size: 11px;
  line-height: 20px;
  color: var(--run-text-faint);
}

.attempt-list { display: flex; flex-direction: column; }
.attempt-item {
  position: relative;
  padding-left: 20px;
  padding-bottom: 14px;
}
.attempt-item.last { padding-bottom: 0; }
.attempt-rail {
  position: absolute;
  left: 4.5px;
  top: 16px;
  bottom: 0;
  width: 1px;
  background: color-mix(in srgb, var(--run-text-primary) 10%, transparent);
}
.attempt-node {
  position: absolute;
  left: 0;
  top: 6px;
  width: 10px;
  height: 10px;
  border-radius: 999px;
  border: 2px solid;
  background: var(--run-canvas);
}
.attempt-card {
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--run-text-primary) 8%, transparent);
  background: color-mix(in srgb, var(--run-text-primary) 2%, transparent);
  padding: 10px 12px;
}
.attempt-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}
.attempt-ordinal { font-size: 13px; font-weight: 600; }
.retry-chip {
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--run-text-primary) 10%, transparent);
  background: color-mix(in srgb, var(--run-text-primary) 4%, transparent);
  padding: 1px 6px;
  font-size: 10px;
  line-height: 16px;
  color: var(--run-text-muted);
}
.attempt-reason { font-size: 11px; color: var(--run-text-faint); }
.attempt-duration {
  margin-left: auto;
  white-space: nowrap;
  font-size: 10.5px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  color: var(--run-text-faint);
}
.attempt-range {
  margin-top: 6px;
  font-size: 10.5px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  color: var(--run-text-faint);
}

.verify-report { margin-top: 6px; }
.verify-report-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  line-height: 20px;
}
.verify-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  border-radius: 4px;
  font-size: 11px;
  color: var(--run-text-faint);
  transition: color 140ms ease;
}
.verify-toggle:hover { color: var(--run-text-primary); }
.verify-report-full, .attempt-output {
  margin: 4px 0 0;
  max-height: 256px;
  overflow: auto;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--run-text-primary) 8%, transparent);
  background: var(--run-canvas);
  padding: 8px;
  font-family: var(--workflow-controller-font-family, ui-monospace, monospace);
  font-size: 10.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  color: var(--run-text-primary);
}
.attempt-output { max-height: 128px; font-size: 11px; }
.verify-report-preview {
  margin-top: 4px;
  font-family: var(--workflow-controller-font-family, ui-monospace, monospace);
  font-size: 10.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  color: var(--run-text-faint);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.member-list {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.member-row { display: flex; flex-wrap: wrap; align-items: center; }
.member-link {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  font-size: 12px;
  color: var(--workflow-controller-primary, #0b6bcb);
}
.member-link:hover { text-decoration: underline; }
.member-none { font-size: 12px; color: var(--run-text-faint); }

.detail-section {
  margin-top: 16px;
  border-top: 1px solid color-mix(in srgb, var(--run-text-primary) 8%, transparent);
  padding-top: 14px;
}
.section-title {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--run-text-faint);
}
.rollback-list { display: flex; flex-direction: column; gap: 4px; }
.rollback-link {
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  text-align: left;
  font-size: 11px;
  line-height: 20px;
  color: var(--run-st-failed, #cf222e);
}
.rollback-link:hover { text-decoration: underline; }
.peer-list { display: flex; flex-wrap: wrap; gap: 6px; }
.peer-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--run-text-primary) 10%, transparent);
  background: color-mix(in srgb, var(--run-text-primary) 3%, transparent);
  padding: 2px 8px;
  font-size: 11px;
  line-height: 16px;
  color: var(--run-text-muted);
  cursor: pointer;
  transition: border-color 140ms ease, color 140ms ease;
}
.peer-chip:hover {
  border-color: color-mix(in srgb, var(--run-text-primary) 25%, transparent);
  color: var(--run-text-primary);
}
</style>

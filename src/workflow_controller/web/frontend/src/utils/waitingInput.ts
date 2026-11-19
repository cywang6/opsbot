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

import type { ClaudeEvent } from '../types/api'

export type WaitingInputKind = 'manual' | 'question' | 'unanswered_question'

// 最近一次等待输入事件之后没有人工回复（log_manual），即仍在等人。
export function waitingInputKind(events: ClaudeEvent[]): WaitingInputKind | null {
  let latestWait = ''
  let kind: WaitingInputKind | null = null
  for (const e of events) {
    const data = e.data as Record<string, unknown> | null
    const ts = e.timestamp || ''
    if (data?.hook === 'pretool_hook_deny_manual' && ts > latestWait) {
      latestWait = ts
      kind = 'question'
    }
    if (data?.decision === 'waiting_for_input' && ts > latestWait) {
      latestWait = ts
      if (data.reason === 'manual_mode') kind = 'manual'
      else if (data.reason === 'unanswered_question') kind = 'unanswered_question'
      else kind = 'question'
    }
  }
  if (kind === null) return null
  for (const e of events) {
    if (e.event_type === 'log_manual' && (e.timestamp || '') > latestWait) return null
  }
  return kind
}

// 事件是否参与等人判定（增量重判的触发条件：等待/门禁/人工回复三类）
export function isWaitingRelevantEvent(ev: ClaudeEvent): boolean {
  const data = ev.data as Record<string, unknown> | null
  return (
    ev.event_type === 'log_manual'
    || data?.hook === 'pretool_hook_deny_manual'
    || data?.decision === 'waiting_for_input'
  )
}

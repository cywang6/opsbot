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

import { describe, expect, it } from 'vitest'
import type { ClaudeEvent } from '../../types/api'
import { waitingInputKind } from '../waitingInput'

const ev = (
  event_type: string,
  data: Record<string, unknown>,
  timestamp: string,
): ClaudeEvent =>
  ({ event_type, data, timestamp, rowid: 0, session_id: 's1', iteration: 0 }) as ClaudeEvent

describe('waitingInputKind', () => {
  it('区分轮末问句、手动模式和工具门禁的等待事件', () => {
    expect(waitingInputKind([
      ev('log_loop', { decision: 'waiting_for_input', reason: 'unanswered_question' }, '2026-10-16T10:00:01'),
    ])).toBe('unanswered_question')
    expect(waitingInputKind([
      ev('log_loop', { decision: 'waiting_for_input', reason: 'manual_mode' }, '2026-10-16T10:00:01'),
    ])).toBe('manual')
    expect(waitingInputKind([
      ev('log_auto', { hook: 'pretool_hook_deny_manual' }, '2026-10-16T10:00:01'),
    ])).toBe('question')
  })

  it('等待之后的人工回复清除停等；无等待事件为 null', () => {
    expect(waitingInputKind([
      ev('log_loop', { decision: 'waiting_for_input', reason: 'manual_mode' }, '2026-10-16T10:00:01'),
      ev('log_manual', { content: '回复' }, '2026-10-16T10:00:02'),
    ])).toBeNull()
    expect(waitingInputKind([ev('tool_use', {}, '2026-10-16T10:00:01')])).toBeNull()
    expect(waitingInputKind([])).toBeNull()
  })
})

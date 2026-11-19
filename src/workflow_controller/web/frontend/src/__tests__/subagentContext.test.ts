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

import { expect, it } from 'vitest'
import { deriveTopology } from '../composables/useTopology'
import { fmtSubagentMessageLines } from '../utils/subagentLines'

it('shows the latest running subagent context separately from cumulative tokens', () => {
  const events = [
    { event_type: 'subagent_start', timestamp: '2026-10-29T01:00:00', data: { agent_id: 'a', agent_type: 'general' } },
    { event_type: 'subagent_context', timestamp: '2026-10-29T01:00:01', data: { agent_id: 'a', current_tokens: 700, max_tokens: 1000, percentage: 70 } },
    { event_type: 'subagent_context', timestamp: '2026-10-29T01:00:02', data: { agent_id: 'a', current_tokens: 750, max_tokens: 1000, percentage: 75 } },
  ] as any
  const snapshot = deriveTopology(events, undefined, false)
  const child = snapshot?.nodes.find(n => n.id === 'a')
  expect(child?.contextTokens).toBe(750)
  expect(child?.contextPercentage).toBe(75)
  expect(child?.tokens).toBe(0)
})

it('marks a handoff stop as interrupted', () => {
  const snapshot = deriveTopology([
    { event_type: 'subagent_start', timestamp: '2026-10-29T01:00:00', data: { agent_id: 'a' } },
    { event_type: 'subagent_stop', timestamp: '2026-10-29T01:00:01', data: { agent_id: 'a', status: 'interrupted' } },
  ] as any, undefined, false)
  expect(snapshot?.nodes.find(n => n.id === 'a')?.status).toBe('interrupted')
})

it.each([
  [true, '✗ error'],
  [false, '✓ result'],
  [null, '? unknown'],
])('renders tool result state %#', (isError, label) => {
  const lines = fmtSubagentMessageLines([
    { type: 'tool_result', tool_use_id: 'call-1', content: 'done', is_error: isError },
  ])

  expect(lines[0].text).toContain(label)
})

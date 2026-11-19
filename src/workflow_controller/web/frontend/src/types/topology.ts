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

export type TopologyRole = 'main' | 'subagent' | 'reviewer'

export type TopologyNodeStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'idle'
  | 'dispatched'
  | 'stopped'

export interface TopologyNode {
  id: string
  role: TopologyRole
  agentType: string
  /** 重建合成事件携带的 subagentName（如「Designer: …」）；实时事件无此字段 */
  agentName?: string
  label: string
  status: TopologyNodeStatus
  startedAt: number | null
  endedAt: number | null
  tokens: number
  contextTokens?: number
  contextWindow?: number
  contextPercentage?: number
  toolCallCount: number
  iteration: number
  messageCount: number
  dispatchContent: string | null
  model: string | null
  replayable?: boolean
  checkpointId?: string
  sessionId?: string
  subagentNo?: number
}

export type TopologyEdgeType = 'dispatch' | 'feedback' | 'fork'
export type TopologyEdgeStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'

export interface TopologyEdge {
  fromId: string
  toId: string
  type: TopologyEdgeType
  status: TopologyEdgeStatus
  label: string | null
}

export interface ForkSessionInfo {
  sessionId: string
  originSessionId: string
  originCheckpointId: string
  originNodeId: string
}

export interface TopologySnapshot {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  globalStartMs: number
  globalEndMs: number
  totalSubagents: number
  activeSubagents: number
  completedSubagents: number
  failedSubagents: number
  stoppedSubagents: number
  reviewerDecisions: number
  forks: ForkSessionInfo[]
}

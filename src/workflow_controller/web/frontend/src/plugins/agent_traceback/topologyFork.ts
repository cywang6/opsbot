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

// agent_traceback plugin — fork-edge + replayable-node augmentation for the
// topology graph. Moved out of core useTopology.ts so the core derivation no
// longer carries checkpoint/fork concepts. Core calls this (guarded by
// pluginLoaded('agent_traceback')) after building the base topology; it mutates
// nodes/edges/forks in place.
import type { SessionInfo } from '../../types/api'
import type {
  ForkSessionInfo,
  TopologyEdge,
  TopologyNode,
} from '../../types/topology'
import type { CheckpointInfo } from './types'
import { birthTracebackOf } from './types'

export function augmentTopology(
  nodes: TopologyNode[],
  edges: TopologyEdge[],
  subMap: Map<string, TopologyNode>,
  forks: ForkSessionInfo[],
  checkpoints: CheckpointInfo[],
  forkSessions: SessionInfo[],
  sessionId: string,
): void {
  // ── Mark replayable subagent nodes with checkpoint info ──
  if (checkpoints.length > 0) {
    const cpByAgentId = new Map<string, CheckpointInfo>()
    for (const cp of checkpoints) {
      if (cp.agent_id) cpByAgentId.set(cp.agent_id, cp)
    }
    for (const node of nodes) {
      if (node.role === 'subagent' && node.status === 'completed') {
        const cp = cpByAgentId.get(node.id)
        if (cp && cp.git_ref && cp.status === 'ok') {
          node.replayable = true
          node.checkpointId = cp.checkpoint_id
        }
      }
    }
  }

  // ── Add fork sessions as nodes + fork edges ──
  for (const forkSess of forkSessions) {
    const bt = birthTracebackOf(forkSess.plugin_metadata)
    if (!bt || bt.origin_session_id !== sessionId) continue
    // Find the origin checkpoint to locate the fork origin node
    const originCp = checkpoints.find(c => c.checkpoint_id === bt.origin_checkpoint_id)
    const cpAgentId = originCp?.agent_id
    // Only use the checkpoint's agent_id as origin if that node exists in
    // topology; otherwise fall back to main (checkpoint = subagent stop moment)
    const originNodeId = (cpAgentId && subMap.has(cpAgentId)) ? cpAgentId : 'main'
    const forkNodeId = `fork:${forkSess.id}`
    const forkStatus: TopologyNode['status'] =
      forkSess.state === 'running' ? 'running' :
      forkSess.result === 'success' ? 'completed' :
      forkSess.result === 'fail' ? 'failed' : 'idle'
    nodes.push({
      id: forkNodeId,
      role: 'main',
      agentType: 'fork',
      label: forkSess.name || forkSess.id.slice(0, 8),
      status: forkStatus,
      startedAt: null,
      endedAt: null,
      tokens: 0,
      toolCallCount: 0,
      iteration: forkSess.current_iteration || 0,
      messageCount: 0,
      dispatchContent: null,
      model: null,
      sessionId: forkSess.id,
    })
    edges.push({
      fromId: originNodeId,
      toId: forkNodeId,
      type: 'fork',
      status: forkStatus === 'running' ? 'running' : 'completed',
      label: 'replay',
    })
    forks.push({
      sessionId: forkSess.id,
      originSessionId: bt.origin_session_id,
      originCheckpointId: bt.origin_checkpoint_id,
      originNodeId,
    })
  }
}

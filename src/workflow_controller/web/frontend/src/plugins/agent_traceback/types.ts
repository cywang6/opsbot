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

// agent_traceback plugin — frontend types. Moved out of core types/api.ts so
// the core SessionInfo/type set no longer carries checkpoint concepts. The
// plugin owns these; core views import from here only when rendering the
// traceback UI (guarded by pluginLoaded('agent_traceback')).

import type { SessionInfo } from '../../types/api'

export interface CheckpointInfo {
  checkpoint_id: string
  session_id: string
  iteration: number
  agent_id: string | null
  agent_type: string | null
  trigger: string
  git_ref: string | null
  event_rowid: number | null
  main_part_id: string | null
  parent_checkpoint_id: string | null
  created_at: string
  file_count: number
  byte_size: number
  status: string
  // 内部 git 捕获结果：captured / absent / skipped_size；空串 = 旧检查点（未知）。
  // captured 可展示「含 git 历史」徽标（重放将恢复检查点时刻的 .git）。
  inner_git?: string
}

export interface CheckpointFile {
  name: string
  path: string
  is_dir: boolean
}

export interface CheckpointFileContent {
  name: string
  path: string
  size: number
  content: string
  truncated: boolean
}

export interface TracebackResult {
  ok: boolean
  session_id?: string
  fork_cwd?: string
  resume_sdk_session_id?: string
  origin_checkpoint_id?: string
  error?: string
}

// Fork origin lives under SessionInfo.plugin_metadata.agent_traceback.birth_traceback
// (the plugin owns its data; core SessionInfo only carries the generic
// plugin_metadata dict).
export interface BirthTraceback {
  origin_session_id: string
  origin_checkpoint_id: string
  forked_at: string
  // 重放 fork session 才有 fork_root（隔离 tempdir 路径，删除时 rmtree）。
  // 重建 session 无此字段（其 cwd 是用户真实 target_cwd）。「是否有 fork_root」是
  // 「这是重放 fork」的唯一语义信号。
  fork_root?: string
  // 仅从 cannbot db 重建的 session 有此字段，用于区分「已重建（无用量）」与「等待首次结果」
  reconstructed_from?: string
  origin_sdk_session_id?: string
  origin_cwd?: string
  fork_cwd?: string
  checkpoints?: number
  // origin session 名（可选），前端 fork 子节点 label 用。
  origin_name?: string
  // 重建时 .git 是否由重建产生（删除清理据此判定 .git 是否可清）。旧 session 无此字段 → 保守不清。
  created_git_dir?: boolean
}

export function birthTracebackOf(
  pm: Record<string, unknown> | undefined | null,
): BirthTraceback | undefined {
  if (!pm) return undefined
  return (pm.agent_traceback as
    | { birth_traceback?: BirthTraceback }
    | undefined)?.birth_traceback
}

// fork 按 origin_session_id 归到根 origin 的项目目录（origin_session_id 恒指向根）。
export function logicalProjectDir(s: SessionInfo, sessions?: SessionInfo[]): string {
  const bt = birthTracebackOf(s.plugin_metadata)
  if (!bt?.fork_root) return s.project_dir ?? ''
  return sessions?.find(x => x.id === bt.origin_session_id)?.project_dir
    ?? bt.origin_cwd
    ?? s.project_dir
    ?? ''
}

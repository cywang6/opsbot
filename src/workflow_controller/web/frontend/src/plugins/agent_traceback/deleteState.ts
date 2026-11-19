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

// agent_traceback plugin — 删除会话弹窗的 session 分类。
// 前端只读 birth_traceback 字段判定三态，不推断路径形状（fork_root 是
// 「重放 fork」的唯一语义信号）。普通 session 也复用，保证体验一致。
import type { SessionInfo } from '../../types/api'
import { birthTracebackOf, type BirthTraceback } from './types'

export type DeleteSessionKind = 'normal' | 'reconstruct' | 'fork'

export interface DeleteSessionState {
  kind: DeleteSessionKind
  birth: BirthTraceback | undefined
}

/**
 * 分类一个 session 的删除态。仅读 ``birth_traceback`` 字段，无副作用。
 */
export function classifyForDelete(
  session: SessionInfo,
): DeleteSessionState {
  const birth = birthTracebackOf(session.plugin_metadata)
  let kind: DeleteSessionKind = 'normal'
  if (birth) {
    if (birth.fork_root) kind = 'fork'
    else if (birth.reconstructed_from) kind = 'reconstruct'
  }
  return { kind, birth }
}

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

import { computed } from 'vue'
import { useSSE } from './useSSE'

// 侧边栏「最近项目」列表 —— 后端单一来源、SSE config.recent_dirs 驱动。
// 后端合并 recent_dirs.json（用户手选，recency 优先）+ events.db sessions 的
// config.cwd（补充），去重后随 config_update SSE 推送。目录存在性在后端校验，
// 根治 SSH 端口转发同 origin 下本地路径串台；删除即真删，无需黑名单防闪回。

const { config } = useSSE()

const dirs = computed<string[]>(() => config.value?.recent_dirs ?? [])

async function addDir(path: string): Promise<{ ok: boolean; error?: string }> {
  if (!path) return { ok: false }
  try {
    const r = await fetch('/api/v1/recent-dirs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: path }),
    })
    const d = await r.json()
    // 后端校验存在性：路径在本机不存在 → error（前端据此 toast）
    return { ok: !d.error, error: d.error }
  } catch {
    return { ok: false }
  }
}

async function removeDir(path: string): Promise<void> {
  if (!path) return
  try {
    await fetch('/api/v1/recent-dirs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: path }),
    })
  } catch {}
}

export function useRecentDirs() {
  return {
    dirs,
    addDir,
    removeDir,
  }
}

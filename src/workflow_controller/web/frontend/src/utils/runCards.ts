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

// 删除：在清理 PR !381 合入时，连同运行分组单测一并删除。
import type { SessionInfo } from '../types/api'
import type { RunRecord, RunStatus } from '../types/runs'
import { logicalProjectDir } from '../plugins/agent_traceback/types'

// Dashboard run 卡片视图模型：显式 run 与隐式会话分组的统一形态
export interface RunCardGroup {
  // 分组键 = run_id（隐式分组的账面记录未到时同样以成员携带的 run_id 为键）
  key: string
  // null = 账面记录未到（新建对话/新 run 的列表刷新迟滞窗口）
  run: RunRecord | null
  members: SessionInfo[]
  // 显式 run 取账面状态；隐式分组取成员投影（任一成员运行即 running）
  status: RunStatus
  title: string
  createdAt: string
}

// 统一分隔符后做目录边界比较：Windows 上反斜杠路径只认 '/' 会恒 false
export function dirContains(parent: string, child: string): boolean {
  const normalizeSep = (p: string) => p.replace(/[\\/]+/g, '/')
  const stripTrailingSlash = (p: string) =>
    p.length > 1 ? p.replace(/[\\/]+$/, '') : p
  const p = normalizeSep(stripTrailingSlash(parent))
  const c = normalizeSep(stripTrailingSlash(child))
  return c === p || c.startsWith(p + '/')
}

// 显式 run 的项目归属：work_dir 或程序原始位置落在当前项目下；
// 两者皆空（无锚点的容器 run）不隐藏——否则从 Dashboard 不可达
function explicitRunInProject(run: RunRecord, projectDir: string): boolean {
  const anchors = [run.work_dir, run.program_ref].filter(
    (v): v is string => !!v,
  )
  return anchors.length === 0 || anchors.some((a) => dirContains(projectDir, a))
}

// 按 run 归组会话并与账面 run 记录合并成卡片列表（新到旧）：
// 显式 run 由账面记录驱动（纯 bash run 无成员也成卡片）；隐式分组由会话驱动
// （账面记录未到也先按成员投影成组）；无 run 归属或所属显式 run 卡片不在本项目
// 的会话以 orphans 兜底返回
export function buildRunCardGroups(
  runs: RunRecord[],
  sessions: SessionInfo[],
  projectDir: string,
): { groups: RunCardGroup[]; orphans: SessionInfo[] } {
  if (!projectDir) return { groups: [], orphans: [] }
  const runById = new Map(runs.map((r) => [r.run_id, r]))
  // 归组只收本项目会话（fork 按 origin 项目）：跨项目谱系成员混入会污染
  // 卡片的成员/运行/等人数计数与状态投影
  const inProject = (s: SessionInfo) => logicalProjectDir(s, sessions) === projectDir
  const byRun: Record<string, SessionInfo[]> = {}
  const implicitIds = new Set<string>()
  const orphans: SessionInfo[] = []
  for (const s of sessions) {
    if (!inProject(s)) continue
    if (!s.run_id) {
      orphans.push(s)
      continue
    }
    const record = runById.get(s.run_id)
    if (record && record.kind !== 'implicit' && !explicitRunInProject(record, projectDir)) {
      // 锚点不在本项目的显式 run：其成员兜底进 orphans，会话不随隐匿卡片消失
      orphans.push(s)
      continue
    }
    (byRun[s.run_id] ??= []).push(s)
    if (!record || record.kind === 'implicit') implicitIds.add(s.run_id)
  }

  const groups: RunCardGroup[] = []
  for (const run of runs) {
    if (run.kind === 'implicit' || !explicitRunInProject(run, projectDir)) continue
    groups.push({
      key: run.run_id,
      run,
      members: byRun[run.run_id] ?? [],
      status: run.status,
      title: run.label || run.run_id,
      createdAt: run.created_at,
    })
  }
  for (const runId of implicitIds) {
    const members = byRun[runId] ?? []
    const run = runById.get(runId) ?? null
    groups.push({
      key: runId,
      run,
      members,
      status: members.some((m) => m.state === 'running') ? 'running' : 'paused',
      title: members[0]?.name || run?.label || runId,
      createdAt: run?.created_at || members[0]?.created_at_iso || '',
    })
  }

  groups.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { groups, orphans }
}

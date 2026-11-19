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
import type { SessionInfo } from '../../types/api'
import type { RunRecord } from '../../types/runs'
import { buildRunCardGroups } from '../runCards'

// 最小会话/run 夹具：默认归属当前项目
function makeSession(over: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    name: over.id, role: 'worker', state: 'idle', loop_status: 'yes',
    stop_reason: null, loop_hold: null, current_iteration: 0, max_iterations: 10,
    progress: 0, elapsed_seconds: 0, created_at_iso: '2026-10-16T10:00:00',
    error: null, last_activity: [], birth_handoff_doc: null, result: null,
    predecessor: null, successors: [], sdk_session_id: null,
    project_dir: '/proj', ...over,
  } as SessionInfo
}

function makeRun(over: Partial<RunRecord> & { run_id: string }): RunRecord {
  return {
    kind: 'workflow', format: 'graph-yaml@1', status: 'running',
    program_ref: '', params: {}, label: null, work_dir: null,
    max_parallel: null, pause_reason: null, created_at: '2026-10-16T10:00:00',
    finished_at: null, reopened_at: null, error: null, ...over,
  } as RunRecord
}

describe('buildRunCardGroups', () => {
  const projectDir = '/proj'

  it('显式 run 成卡片：锚点落当前项目才显示，成员随卡片（新到旧排序）', () => {
    const inRun = makeRun({ run_id: 'r1', work_dir: '/proj/wd', label: 'op-dev', created_at: '2026-10-16T10:00:00' })
    const outRun = makeRun({ run_id: 'r2', work_dir: '/elsewhere/wd', created_at: '2026-10-16T11:00:00' })
    const noAnchor = makeRun({
      run_id: 'r3', kind: 'container', format: '', created_at: '2026-10-16T09:00:00',
    })
    const member = makeSession({ id: 's1', run_id: 'r1', state: 'running' })
    const { groups } = buildRunCardGroups(
      [inRun, outRun, noAnchor], [member], projectDir)
    expect(groups.map((g) => g.key)).toEqual(['r1', 'r3']) // r2 锚点在项目外
    const card = groups[0]
    expect(card.title).toBe('op-dev')
    expect(card.status).toBe('running')
    expect(card.members).toEqual([member])
  })

  it('隐式分组：成员投影定状态，实时会话名作标题，账面记录未到也成组', () => {
    const running = makeSession({ id: 's1', run_id: 'ri1', state: 'running', name: '主会话' })
    const idle = makeSession({ id: 's2', run_id: 'ri1', state: 'idle', name: '交接会话' })
    const fresh = makeSession({ id: 's3', run_id: 'ri2', state: 'idle', name: '新对话' })
    const runs = [makeRun({
      run_id: 'ri1', kind: 'implicit', format: '', status: 'paused',
      label: '旧名', created_at: '2026-10-16T08:00:00',
    })]
    const { groups } = buildRunCardGroups(
      runs, [running, idle, fresh], projectDir)
    const g1 = groups.find((g) => g.key === 'ri1')!
    expect(g1.status).toBe('running') // 任一成员运行
    expect(g1.title).toBe('主会话')
    expect(g1.members).toHaveLength(2)
    const g2 = groups.find((g) => g.key === 'ri2')!
    expect(g2.run).toBeNull() // 列表刷新迟滞窗口：仍按投影成组
    expect(g2.status).toBe('paused')
  })

  it('显式 run 成员不重复进隐式分组；无归属会话落 orphans', () => {
    const run = makeRun({ run_id: 'r1', work_dir: '/proj/wd' })
    const member = makeSession({ id: 's1', run_id: 'r1' })
    const orphan = makeSession({ id: 's2' })
    const { groups, orphans } = buildRunCardGroups(
      [run], [member, orphan], projectDir)
    expect(groups).toHaveLength(1)
    expect(orphans).toEqual([orphan])
  })

  it('隐式分组成员按项目过滤：跨项目谱系成员不进卡片（fork 按 origin 归并）', () => {
    const mine = makeSession({ id: 's1', run_id: 'ri1', state: 'idle', name: '本会话' })
    const foreign = makeSession({ id: 's2', run_id: 'ri1', state: 'running', name: '外来会话', project_dir: '/elsewhere' })
    const fork = makeSession({
      id: 's3', run_id: 'ri1', state: 'idle', name: '谱系成员', project_dir: '/elsewhere',
      plugin_metadata: {
        agent_traceback: { birth_traceback: { fork_root: true, origin_session_id: 's1' } },
      },
    })
    const { groups } = buildRunCardGroups(
      [], [mine, foreign, fork], projectDir)
    const g = groups.find((g) => g.key === 'ri1')!
    expect(g.members.map((m) => m.id)).toEqual(['s1', 's3'])
    expect(g.status).toBe('paused') // 外来 running 成员不顶起状态投影
    expect(g.title).toBe('本会话')
  })

  it('显式卡片成员按项目过滤：跨项目成员不混入，谱系成员保留', () => {
    const run = makeRun({ run_id: 'r1', work_dir: '/proj/wd', label: 'op-dev' })
    const mine = makeSession({ id: 's1', run_id: 'r1', state: 'idle', name: '本会话' })
    const foreign = makeSession({ id: 's2', run_id: 'r1', state: 'running', name: '外来会话', project_dir: '/elsewhere' })
    const fork = makeSession({
      id: 's3', run_id: 'r1', state: 'idle', name: '谱系成员', project_dir: '/elsewhere',
      plugin_metadata: {
        agent_traceback: { birth_traceback: { fork_root: true, origin_session_id: 's1' } },
      },
    })
    const { groups, orphans } = buildRunCardGroups(
      [run], [mine, foreign, fork], projectDir)
    const card = groups.find((g) => g.key === 'r1')!
    expect(card.members.map((m) => m.id)).toEqual(['s1', 's3'])
    // 外来 running 成员不顶起「全部停止」与运行计数
    expect(card.members.some((m) => m.state === 'running')).toBe(false)
    expect(orphans).toEqual([]) // 外来成员不在本项目兜底（其实际归属项目呈现）
  })

  it('锚点在项目外的显式 run：归属本项目的成员落 orphans 兜底', () => {
    const foreignRun = makeRun({ run_id: 'r9', work_dir: '/elsewhere/wd' })
    const mine = makeSession({ id: 's1', run_id: 'r9', state: 'running' })
    const { groups, orphans } = buildRunCardGroups(
      [foreignRun], [mine], projectDir)
    expect(groups).toEqual([]) // 卡片锚点在项目外，不显示
    expect(orphans).toEqual([mine]) // 成员不随隐匿卡片消失
  })

  it('未选项目目录时列表为空', () => {
    const run = makeRun({ run_id: 'r1', work_dir: '/proj/wd' })
    const { groups, orphans } = buildRunCardGroups(
      [run], [makeSession({ id: 's1', run_id: 'r1' })], '')
    expect(groups).toEqual([])
    expect(orphans).toEqual([])
  })
})

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
// 投影 v2 + node_history 事件 → workflow-bundle manifest → RunIndex。
// 语义 1:1 对照后端 plugins/graph/exporter.py（三源对齐的事件 > 快照序），
// 布局/渲染层（lib/ 纯函数族）零改动消费。与导出件的差异点（投影字段缺口，
// 均为低影响降级）：
// - retryPolicy/runOnFailure（冻结程序 acceptance）不随投影下发，不产出；
// - bash 输出回退链（process_exit tail）不做，只用 node_history 的 output；
// - 会话成员 executionState 以节点状态推导（无 roster/session_outcomes 对账）；
// - 归档 generator 实例的子图不可重建（投影 subgraphs 只挂当前 generator）。
import { BUNDLE_SCHEMA, BUNDLE_VERSION } from './model'
import { parseAndIndex } from './reader'
import type { RunIndex } from './reader'

/** 投影 node/subgraph/retired 条目（字段见 projection.py，宽松收窄）。 */
export interface ProjectionNode {
  id: string
  depends_on?: string[]
  task_type?: string
  display_type?: string
  status?: string
  attempts?: number
  gen?: number
  workflow_controller_session_id?: string | null
  started_at?: string | null
  finished_at?: string | null
  output?: string | null
  subgraph_generated?: boolean
  subgraph_node_ids?: string[] | null
}

export interface ProjectionSubgraph {
  parent_node: string
  nodes: ProjectionNode[]
}

export interface ProjectionRollbackEdge {
  from?: string
  from_gen?: number
  to?: string
  to_gen?: number
}

/** run 事件（/runs/:id/events 回放面，只关心 node_history）。 */
export interface RunEventLike {
  source?: string
  event_type?: string
  data?: Record<string, unknown> | null
}

type Fact = {
  status?: string
  session_id?: string
  started_at?: string | null
  finished_at?: string | null
  output?: string | null
  verify?: { verify_type?: string; verify_session_id?: string; verify_reason?: string }
}

type Rec = {
  status: string
  attempts: number
  sessionId: string | null
  startedAt: string | null
  finishedAt: string | null
  output: string | null
  taskType: string | null
  displayType: string | null
}

const TERMINAL_STATUSES = new Set(['passed', 'failed', 'skipped'])

/** `nid|gen` 复合键解析（nid 自身允许含 ':'，不含 '|'——与合成 id 约定一致）。 */
function parseKey(key: string): [string, number] {
  const sep = key.lastIndexOf('|')
  return [key.slice(0, sep), Number(key.slice(sep + 1))]
}

/** 确定性合成成员 id（与后端 synthetic_member_id 同输入形状；前端用同步
 *  FNV 双字替代 sha256——只需同 run 内确定性唯一，无需跨导出稳定）。 */
function syntheticMemberId(runId: string, nodePath: string, generation: number, attempt: number, role: string): string {
  const raw = `${runId}|${nodePath}|${generation}|${attempt}|${role}`
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ Math.imul(c + i, 0x85ebca6b), 0x27d4eb2f) >>> 0
  }
  return 'm' + (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).padEnd(24, '0')
}

function executionState(status: string | undefined): string {
  return status === 'stopped' || TERMINAL_STATUSES.has(String(status)) ? 'finished' : 'in_progress'
}

type MemberOut = Record<string, unknown> & { id: string; kind: string }
type RelationOut = { from: string; to: string; type: string; note?: string }

/** 投影 + 事件 → RunIndex（纯函数；形状异常按缺失对待，不抛）。 */
export function projectionToRunIndex(
  projection: Record<string, unknown>,
  events: RunEventLike[],
  runId: string,
): RunIndex {
  const nodes = (projection.nodes as ProjectionNode[] | undefined) ?? []
  const subgraphs = (projection.subgraphs as ProjectionSubgraph[] | undefined) ?? []
  const retired = (projection.retired_instances as ProjectionNode[] | undefined) ?? []
  const edges = (projection.edges as Array<{ from: string; to: string }> | undefined) ?? []
  const rollbackEdges = (projection.rollback_edges as ProjectionRollbackEdge[] | undefined) ?? []
  const workflow = typeof projection.workflow === 'string' ? projection.workflow : null

  // 子节点全 id = `父:子`（state 归约口径）；投影 strip 后由 parent 还原
  const parentOf = new Map<string, string>()
  const records = new Map<string, Rec>()
  const noteRecord = (fullId: string, raw: ProjectionNode) => {
    records.set(`${fullId}|${Number(raw.gen ?? 0)}`, {
      status: String(raw.status ?? 'pending'),
      attempts: Number(raw.attempts ?? 0),
      sessionId: raw.workflow_controller_session_id ?? null,
      startedAt: raw.started_at ?? null,
      finishedAt: raw.finished_at ?? null,
      output: raw.output ?? null,
      taskType: raw.task_type ?? null,
      displayType: raw.display_type ?? null,
    })
  }
  for (const raw of nodes) noteRecord(raw.id, raw)
  for (const raw of retired) noteRecord(raw.id, raw)
  for (const sub of subgraphs) {
    for (const raw of sub.nodes ?? []) {
      const fullId = `${sub.parent_node}:${raw.id}`
      parentOf.set(fullId, sub.parent_node)
      noteRecord(fullId, raw)
    }
  }

  // ── attempt 级事实：node_history 事件（权威源）──
  const facts = new Map<string, Map<number, Fact>>()
  const factsOf = (nid: string, gen: number): Map<number, Fact> => {
    const key = `${nid}|${gen}`
    let m = facts.get(key)
    if (!m) { m = new Map(); facts.set(key, m) }
    return m
  }
  for (const ev of events) {
    if (ev.source !== 'run_events' || ev.event_type !== 'node_history') continue
    const data = ev.data ?? {}
    const nid = data.node_id
    if (typeof nid !== 'string' || !nid) continue
    const attempt = Number(data.attempt ?? 0)
    if (attempt <= 0) continue
    const m = factsOf(nid, Number(data.gen ?? 0))
    const fact = m.get(attempt) ?? {}
    if (!m.has(attempt)) m.set(attempt, fact)
    if (typeof data.workflow_controller_session_id === 'string') fact.session_id = data.workflow_controller_session_id
    for (const key of ['started_at', 'finished_at', 'output'] as const) {
      const v = data[key]
      if (v !== undefined && v !== null) fact[key] = String(v)
    }
    if (data.status !== undefined && data.status !== null) fact.status = String(data.status)
    const verify: NonNullable<Fact['verify']> = {}
    for (const key of ['verify_type', 'verify_session_id', 'verify_reason'] as const) {
      const v = data[key]
      if (v !== undefined && v !== null) verify[key] = String(v)
    }
    if (Object.keys(verify).length > 0) {
      // 逐事件合并：结论事件可能只带 sid/reason（type 为空），覆盖式会丢起步事件的验收方式
      fact.verify = { ...(fact.verify ?? {}), ...verify }
    }
  }
  // 当前快照可更新运行与停止状态，事件中的已完成结论优先。
  for (const [key, rec] of records) {
    if (rec.attempts <= 0) continue
    const [nid, gen] = parseKey(key)
    const m = factsOf(nid, gen)
    const fact = m.get(rec.attempts) ?? {}
    if (!m.has(rec.attempts)) m.set(rec.attempts, fact)
    if (fact.started_at === undefined && rec.startedAt !== null) fact.started_at = rec.startedAt
    if (fact.finished_at === undefined && rec.finishedAt !== null) fact.finished_at = rec.finishedAt
    if (fact.output === undefined && rec.output !== null) fact.output = rec.output
    if (fact.session_id === undefined && rec.sessionId !== null) fact.session_id = rec.sessionId
    const activeState = rec.status === 'running' || rec.status === 'stopped'
    if (fact.status === undefined || (activeState && !TERMINAL_STATUSES.has(fact.status))) {
      fact.status = rec.status
    }
  }

  // ── 结构知识：generator / xlsx 子图 / 代集 ──
  const generators = new Set<string>()
  const xlsxSubgraphs = new Set<string>()
  const taskTypeOf = new Map<string, string>()
  for (const [key, rec] of records) {
    const nid = parseKey(key)[0]
    if (rec.taskType !== null) taskTypeOf.set(nid, rec.taskType)
    if (rec.taskType === 'generator') generators.add(nid)
    if (rec.displayType === 'subgraph') xlsxSubgraphs.add(nid)
  }
  for (const sub of subgraphs) {
    generators.add(sub.parent_node)
    if (!taskTypeOf.has(sub.parent_node)) taskTypeOf.set(sub.parent_node, 'generator')
  }

  const knownFrom = (nid: string): number => {
    if (!parentOf.has(nid)) return 0
    let min = Infinity
    for (const key of records.keys()) {
      const [id, g] = parseKey(key)
      if (id === nid) min = Math.min(min, g)
    }
    return Number.isFinite(min) ? min : 0
  }
  const gens = new Set<number>([0])
  for (const key of records.keys()) gens.add(parseKey(key)[1])
  for (const [key, m] of facts) {
    if (m.size > 0) gens.add(parseKey(key)[1])
  }
  for (const e of rollbackEdges) gens.add(Number(e.to_gen ?? 0))

  const allKnownNodes = new Set<string>()
  for (const key of records.keys()) allKnownNodes.add(parseKey(key)[0])
  for (const nid of parentOf.keys()) allKnownNodes.add(nid)
  for (const [key, m] of facts) {
    if (m.size > 0) allKnownNodes.add(parseKey(key)[0])
  }

  const attemptNumbers = (nid: string, gen: number): number[] =>
    [...(facts.get(`${nid}|${gen}`) ?? [])].map(([a]) => a).sort((x, y) => x - y)
  const instanceGens = (nid: string): number[] =>
    [...facts.entries()].filter(([key, m]) => parseKey(key)[0] === nid && m.size > 0)
      .map(([key]) => parseKey(key)[1]).sort((a, b) => a - b)

  const isBashNode = (nid: string): boolean => {
    const taskType = taskTypeOf.get(nid)
    if (taskType) {
      if (taskType === 'generator') return false // 投影不带 generator_type，bash 生成器降级按 agent
      return taskType === 'bash'
    }
    for (const gen of instanceGens(nid)) {
      for (const a of attemptNumbers(nid, gen)) {
        if (facts.get(`${nid}|${gen}`)?.get(a)?.session_id) return false
      }
    }
    return true
  }

  // ── 成员派生（memberIds 键：`nid|gen|attempt|role`）──
  const memberIds = new Map<string, string>()
  const dynamicWorkflowIds = new Map<string, string>()
  const topMembers: MemberOut[] = []
  const topRelations: RelationOut[] = []
  const childMembers = new Map<string, MemberOut[]>() // 容器成员 id → 子成员
  const childRelations = new Map<string, RelationOut[]>() // generator → 子作用域关系
  const childGenerations = new Map<string, number>() // 子成员 id → 其 generation

  const emitVacant = (nid: string, gen: number, into: MemberOut[]): void => {
    const earlier = instanceGens(nid).filter(g => g < gen)
    if (earlier.length > 0) {
      const sourceGen = earlier[earlier.length - 1]
      const node = facts.get(`${nid}|${sourceGen}`)
      const attempts = node ? [...node.keys()].sort((a, b) => a - b) : []
      const lastFact = node && attempts.length > 0 ? node.get(attempts[attempts.length - 1]) : undefined
      const status = lastFact?.status ?? records.get(`${nid}|${sourceGen}`)?.status
      // 代内无实例：最近实例已终态成 carried，否则未运行占位
      if (!TERMINAL_STATUSES.has(String(status))) return
      const kind = xlsxSubgraphs.has(nid) ? 'workflow' : 'process'
      const id = syntheticMemberId(runId, nid, gen, 0, 'execute')
      memberIds.set(`${nid}|${gen}|0|execute`, id)
      into.push({
        id, kind,
        name: `${nid}：第 ${gen} 代未执行（沿用第 ${sourceGen} 代结果）`,
        annotation: { role: 'execute' },
        nodeId: nid, generation: gen, attempt: 0,
        executionState: 'carried', resultFromGeneration: sourceGen,
      })
      return
    }
    const kind = xlsxSubgraphs.has(nid) ? 'workflow' : isBashNode(nid) ? 'process' : 'session'
    const id = syntheticMemberId(runId, nid, gen, 0, 'execute')
    memberIds.set(`${nid}|${gen}|0|execute`, id)
    into.push({
      id, kind,
      name: `${nid}：第 ${gen} 代待执行`,
      annotation: { role: 'execute' },
      nodeId: nid, generation: gen, attempt: 0,
      executionState: 'pending',
      ...(kind === 'session' ? { sessionId: null, location: null } : {}),
    })
  }

  const emitExecute = (nid: string, gen: number, attempt: number, into: MemberOut[]): string => {
    const fact = facts.get(`${nid}|${gen}`)!.get(attempt)!
    const status = fact.status ?? 'pending'
    const fields: Record<string, unknown> = {
      nodeId: nid, generation: gen, attempt,
      executionState: executionState(status),
      nodeStatus: status,
    }
    if (status === 'passed') fields.attemptResult = 'succeeded'
    else if (status === 'failed') fields.attemptResult = 'failed'
    const sid = fact.session_id
    let id: string
    let base: Record<string, unknown>
    if (xlsxSubgraphs.has(nid)) {
      id = syntheticMemberId(runId, nid, gen, attempt, 'execute')
      base = {
        id, kind: 'workflow',
        name: `${nid}：第 ${gen} 代第 ${attempt} 次执行`,
        startedAt: fact.started_at ?? null, finishedAt: fact.finished_at ?? null,
        annotation: { role: 'execute' },
      }
    } else if (isBashNode(nid)) {
      id = syntheticMemberId(runId, nid, gen, attempt, 'execute')
      base = {
        id, kind: 'process',
        name: `${nid}：第 ${gen} 代第 ${attempt} 次执行`,
        startedAt: fact.started_at ?? null, finishedAt: fact.finished_at ?? null,
        output: fact.output !== null && fact.output !== undefined ? { text: fact.output } : null,
        annotation: { role: 'execute' },
      }
    } else {
      id = sid ? `s_${sid}` : syntheticMemberId(runId, nid, gen, attempt, 'execute')
      base = {
        id, kind: 'session',
        name: `${nid}：第 ${gen} 代第 ${attempt} 次执行`,
        startedAt: fact.started_at ?? null, finishedAt: fact.finished_at ?? null,
        sessionId: sid ?? null,
        location: sid ? `session/${sid}` : null,
        annotation: { role: 'execute' },
      }
    }
    into.push({ ...base, ...fields } as MemberOut)
    memberIds.set(`${nid}|${gen}|${attempt}|execute`, id)
    return id
  }

  const emitVerify = (nid: string, gen: number, attempt: number, relations: RelationOut[], into: MemberOut[]): void => {
    const fact = facts.get(`${nid}|${gen}`)!.get(attempt)!
    const verify = fact.verify
    if (!verify || !(verify.verify_type || verify.verify_session_id)) return
    const status = fact.status ?? 'pending'
    const verdict = status === 'passed' || status === 'failed' || status === 'stopped' ? status : 'running'
    const verification: Record<string, unknown> = { type: verify.verify_type || 'agent', status: verdict }
    if ((status === 'passed' || status === 'failed') && verify.verify_reason) verification.reason = verify.verify_reason
    const fields: Record<string, unknown> = {
      nodeId: nid, generation: gen, attempt,
      executionState: executionState(status),
      verification,
    }
    const verifySid = verify.verify_session_id
    const execId = memberIds.get(`${nid}|${gen}|${attempt}|execute`)!
    let id: string
    let base: Record<string, unknown>
    if (verifySid) {
      id = `s_${verifySid}`
      base = {
        id, kind: 'session',
        name: `${nid}：第 ${gen} 代第 ${attempt} 次验收`,
        sessionId: verifySid, location: `session/${verifySid}`,
        annotation: { role: 'verify' },
      }
    } else {
      id = syntheticMemberId(runId, nid, gen, attempt, 'verify')
      base = { id, kind: 'process', name: `${nid}：第 ${gen} 代第 ${attempt} 次验收`, annotation: { role: 'verify' } }
    }
    into.push({ ...base, ...fields } as MemberOut)
    memberIds.set(`${nid}|${gen}|${attempt}|verify`, id)
    relations.push({ from: execId, to: id, type: 'depends_on' })
  }

  const emitSubgraphPlaceholder = (generator: string, gen: number): string => {
    // generator 该代无成员（最近实例非终态跳过生成）时补占位容器，子成员不随缺失静默消失
    const id = syntheticMemberId(runId, generator, gen, 0, 'execute')
    memberIds.set(`${generator}|${gen}|0|execute`, id)
    topMembers.push({
      id, kind: 'workflow', name: `${generator}：第 ${gen} 代待执行`,
      annotation: { role: 'execute' },
      nodeId: generator, generation: gen, attempt: 0, executionState: 'pending',
    })
    return id
  }

  const subgraphWorkflowId = (generator: string, gen: number): string => {
    const attempts = attemptNumbers(generator, gen)
    const successful = attempts.filter(a => facts.get(`${generator}|${gen}`)?.get(a)?.status === 'passed')
    const pool = successful.length > 0 ? successful : attempts.length > 0 ? attempts : [0]
    const selected = pool[pool.length - 1]
    if (xlsxSubgraphs.has(generator)) {
      const memberId = memberIds.get(`${generator}|${gen}|${selected}|execute`)
      if (memberId !== undefined) return memberId
      return emitSubgraphPlaceholder(generator, gen)
    }
    const key = `${generator}|${gen}`
    let wfId = dynamicWorkflowIds.get(key)
    if (wfId === undefined) {
      wfId = 'w' + syntheticMemberId(runId, generator, gen, selected, 'subgraph').slice(1)
      dynamicWorkflowIds.set(key, wfId)
    }
    return wfId
  }

  const buildNodeMembers = (nid: string, members: MemberOut[], relations: RelationOut[]): void => {
    const from = knownFrom(nid)
    for (const gen of [...gens].filter(g => g >= from).sort((a, b) => a - b)) {
      const attempts = attemptNumbers(nid, gen)
      if (attempts.length === 0) {
        emitVacant(nid, gen, members)
        continue
      }
      for (const attempt of attempts) {
        emitExecute(nid, gen, attempt, members)
        emitVerify(nid, gen, attempt, relations, members)
      }
    }
  }

  // 主图节点（非子节点）成员
  for (const nid of [...allKnownNodes].sort()) {
    if (parentOf.has(nid)) continue
    buildNodeMembers(nid, topMembers, topRelations)
  }
  // 子节点成员：按（generator, 子成员代）挂到容器下（嵌套经 manifest data 递归）
  for (const nid of [...allKnownNodes].sort()) {
    const generator = parentOf.get(nid)
    if (!generator) continue
    const members: MemberOut[] = []
    const relations: RelationOut[] = []
    buildNodeMembers(nid, members, relations)
    for (const member of members) {
      const gen = Number(member.generation)
      const wfId = subgraphWorkflowId(generator, gen)
      let list = childMembers.get(wfId)
      if (!list) { list = []; childMembers.set(wfId, list) }
      list.push(member)
      childGenerations.set(member.id, gen)
    }
    let rels = childRelations.get(generator)
    if (!rels) { rels = []; childRelations.set(generator, rels) }
    rels.push(...relations)
  }

  function upstreamId(nid: string, gen: number): string | null {
    // 依赖边 A 端：末次验收、动态子图容器、末次执行或占位
    const attempts = attemptNumbers(nid, gen)
    if (attempts.length === 0) return memberIds.get(`${nid}|${gen}|0|execute`) ?? null
    const verifyAttempts = attempts.filter(a => memberIds.has(`${nid}|${gen}|${a}|verify`))
    if (verifyAttempts.length > 0) return memberIds.get(`${nid}|${gen}|${verifyAttempts[verifyAttempts.length - 1]}|verify`)!
    const dynamic = dynamicWorkflowIds.get(`${nid}|${gen}`)
    if (dynamic) return dynamic
    return memberIds.get(`${nid}|${gen}|${attempts[attempts.length - 1]}|execute`) ?? null
  }
  function downstreamId(nid: string, gen: number): string | null {
    // 依赖边 B 端：执行成员（末次 attempt），无实例回退 carried/占位
    const attempts = attemptNumbers(nid, gen)
    const attempt = attempts.length > 0 ? attempts[attempts.length - 1] : 0
    return memberIds.get(`${nid}|${gen}|${attempt}|execute`) ?? null
  }
  function rollbackSourceId(nid: string, gen: number): string | null {
    // 回滚边起点：失败验收成员，无验收回退执行成员/占位
    const attempts = attemptNumbers(nid, gen)
    const verifyAttempts = attempts.filter(a => memberIds.has(`${nid}|${gen}|${a}|verify`))
    if (verifyAttempts.length > 0) return memberIds.get(`${nid}|${gen}|${verifyAttempts[verifyAttempts.length - 1]}|verify`)!
    if (attempts.length > 0) return memberIds.get(`${nid}|${gen}|${attempts[attempts.length - 1]}|execute`) ?? null
    return memberIds.get(`${nid}|${gen}|0|execute`) ?? null
  }

  // 动态容器（agent 生成器）：顶层 workflow 成员 + gen-sub-graph 关系
  for (const [key, wfId] of [...dynamicWorkflowIds.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [generator, genStr] = parseKey(key)
    topMembers.push({ id: wfId, kind: 'workflow', name: `${generator}：第 ${Number(genStr)} 代生成的子图` })
    const sourceId = downstreamId(generator, Number(genStr))
    if (sourceId) topRelations.push({ from: sourceId, to: wfId, type: 'gen-sub-graph' })
  }

  // 主图依赖边 × 各代（投影 edges 已 strip-to-parent；子目标边由子图视图表达，剔除）
  const fullSubIds = new Set(parentOf.keys())
  const mainEdges: Array<[string, string]> = []
  const seenEdges = new Set<string>()
  for (const e of edges) {
    if (!e || typeof e.from !== 'string' || typeof e.to !== 'string') continue
    if (fullSubIds.has(e.to)) continue
    const dedupe = `${e.from}->${e.to}`
    if (seenEdges.has(dedupe)) continue
    seenEdges.add(dedupe)
    mainEdges.push([e.from, e.to])
  }
  for (const gen of gens) {
    for (const [source, target] of mainEdges) {
      const fromId = upstreamId(source, gen)
      const toId = downstreamId(target, gen)
      if (!fromId || !toId) continue
      topRelations.push({ from: fromId, to: toId, type: 'depends_on' })
    }
  }

  // 子图内部边（实例代拓扑：投影 sub node 的 depends_on 按实例代携带）
  for (const sub of subgraphs) {
    const generator = sub.parent_node
    let rels = childRelations.get(generator)
    if (!rels) { rels = []; childRelations.set(generator, rels) }
    for (const raw of sub.nodes ?? []) {
      const gen = Number(raw.gen ?? 0)
      const nid = `${generator}:${raw.id}`
      for (const dep of raw.depends_on ?? []) {
        const depFull = `${generator}:${dep}`
        const fromId = upstreamId(depFull, gen)
        const toId = downstreamId(nid, gen)
        if (!fromId || !toId) continue
        rels.push({ from: fromId, to: toId, type: 'depends_on' })
      }
    }
  }

  // 回滚边（主图）
  for (const e of rollbackEdges) {
    const failed = typeof e.from === 'string' ? e.from : ''
    const target = typeof e.to === 'string' ? e.to : ''
    if (!failed || !target) continue
    const fromId = rollbackSourceId(failed, Number(e.from_gen ?? 0))
    const toId = downstreamId(target, Number(e.to_gen ?? 0))
    if (!fromId || !toId) continue
    topRelations.push({ from: fromId, to: toId, type: 'rollback', note: '回滚后重新执行' })
  }

  // 子作用域关系按成员代归入对应容器（跨代边跳过——容器按代隔离）
  const subRelations = new Map<string, RelationOut[]>()
  for (const [generator, rels] of childRelations) {
    for (const rel of rels) {
      const gen = childGenerations.get(rel.from)
      if (gen === undefined) continue
      const wfId = subgraphWorkflowId(generator, gen)
      let list = subRelations.get(wfId)
      if (!list) { list = []; subRelations.set(wfId, list) }
      list.push(rel)
    }
  }

  // ── manifest 装配（嵌套：容器成员的 data 携带子成员/关系）──
  for (const members of [topMembers, ...childMembers.values()]) {
    for (const member of members) {
      if (member.kind !== 'workflow') continue
      member.data = {
        members: childMembers.get(member.id) ?? [],
        relations: subRelations.get(member.id) ?? [],
      }
    }
  }

  return parseAndIndex({
    schema: BUNDLE_SCHEMA,
    version: BUNDLE_VERSION,
    id: runId,
    kind: 'workflow',
    name: workflow,
    data: {
      members: topMembers,
      relations: topRelations,
      exportDataComplete: true,
    },
  })
}

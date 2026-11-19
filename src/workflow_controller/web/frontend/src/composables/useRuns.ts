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

import { ref } from 'vue'
import type { RunRecord, RunSession, RunState, RunEventsPage, RunExportSummary } from '../types/runs'
import { useToast } from './useToast'

// 模块级单例：runs 列表与当前 run 详情全局共享
const runs = ref<RunRecord[]>([])
const runDetail = ref<{ run: RunRecord; sessions: RunSession[] } | null>(null)
// 详情写回序号：只让最新一次请求落单例，慢响应乱序不把旧 run 数据写回
let runDetailSeq = 0

// 详情刷新结果：区分 run 不在账（404）与后端不可达（网络/5xx）
export type RunDetailResult =
  | { ok: true; run: RunRecord; sessions: RunSession[] }
  | { ok: false; notFound: boolean }

// 统一请求出口：非 2xx / 网络故障提示并返回 null，调用方判空。
// silent：静默失败不 toast——事件流/详情等自愈型路径由调用方以错误态呈现，避免逐次弹窗刷屏
async function request<T>(url: string, opts?: RequestInit, silent = false): Promise<T | null> {
  const toast = useToast()
  try {
    const res = await fetch(url, opts)
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      if (!silent) {
        toast.error?.((body as { detail?: string } | null)?.detail || `HTTP ${res.status}: ${url}`)
      }
      return null
    }
    return (await res.json()) as T
  } catch (e) {
    if (!silent) toast.error?.(`网络错误：${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

// 受理型操作（组控/注入/删除等）：成功 true，失败 false（错误已提示）
async function postForAccepted(url: string, body?: unknown): Promise<boolean> {
  return (
    (await request<unknown>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })) !== null
  )
}

// 触发浏览器下载：Blob → 临时 <a download> 点击
function _triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 延迟撤销：Safari/WebKit 下同步 revoke 会抢在导航前释放 Blob，下载被中止
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function useRuns() {
  // 启动 workflow run（format 派发 + 冻结程序 + params 携带驱动参数）；
  // 成功返回 run_id（错误已由统一出口提示）
  async function startRun(body: {
    format?: string
    program_path: string
    work_dir: string
    label?: string
    params?: Record<string, unknown>
    max_parallel?: number
  }): Promise<string | null> {
    const data = await request<{ run_id: string }>('/api/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return data?.run_id ?? null
  }

  // 列表（默认过滤隐式 run）；silent 供信号驱动的周期重拉用——失败不逐次弹窗
  async function refreshRuns(opts?: {
    includeImplicit?: boolean; status?: string; silent?: boolean
  }): Promise<boolean> {
    const params = new URLSearchParams()
    if (opts?.includeImplicit) params.set('include_implicit', 'true')
    if (opts?.status) params.set('status', opts.status)
    const qs = params.toString()
    const data = await request<{ runs: RunRecord[] }>(
      `/api/v1/runs${qs ? `?${qs}` : ''}`, undefined, opts?.silent ?? false)
    if (data) runs.value = data.runs
    return data !== null
  }

  // 详情：账面行 + 成员表。失败统一静默返回（调用方以错误态呈现，不弹 toast——
  // 退避重试期间逐次弹窗只会刷屏）；404 =「run 不在账」，与网络/5xx 区分
  async function refreshRun(runId: string): Promise<RunDetailResult> {
    const seq = ++runDetailSeq
    let res: Response
    try {
      res = await fetch(`/api/v1/runs/${runId}`)
    } catch {
      return { ok: false, notFound: false }
    }
    if (res.status === 404) return { ok: false, notFound: true }
    if (!res.ok) return { ok: false, notFound: false }
    const data = (await res.json().catch(() => null)) as {
      run: RunRecord
      sessions: RunSession[]
    } | null
    if (!data) return { ok: false, notFound: false }
    if (seq === runDetailSeq) runDetail.value = data
    return { ok: true, ...data }
  }

  // 通用面 + 驱动投影（失败静默：调用方以错误态呈现）
  async function fetchState(runId: string): Promise<RunState | null> {
    return request<RunState>(`/api/v1/runs/${runId}/state`, undefined, true)
  }

  // 增量事件：cursor 回传上轮 next_cursor，未取尽前反复续拉；limit 显式传入，
  // 「页内不足 limit 行 = 已到水位」是排空终止的唯一判据。静默失败——
  // 排空路径自带有界重试，失败由 useRunEvents 统一呈现在错误态上
  async function fetchEvents(
    runId: string, cursor?: string, limit?: number,
  ): Promise<RunEventsPage | null> {
    const params = new URLSearchParams()
    if (cursor) params.set('cursor', cursor)
    if (limit) params.set('limit', String(limit))
    const qs = params.toString()
    return request<RunEventsPage>(
      `/api/v1/runs/${runId}/events${qs ? `?${qs}` : ''}`, undefined, true)
  }

  // run 级组控（受理即返回，状态变化经事件流/详情刷新确认）
  async function control(
    runId: string,
    action: 'pause' | 'resume' | 'stop' | 'restart',
    payload?: Record<string, unknown>,
  ): Promise<boolean> {
    const body = action === 'resume' && payload ? { payload } : undefined
    return postForAccepted(`/api/v1/runs/${runId}/${action}`, body)
  }

  // 驱动自定义操作（经通知通道在 run 任务内执行；模型切换等面板操作用）。
  // silent：自愈型读路径（reconcile 对账）用——失败不逐次 toast，与 /state、事件流同策略
  async function driverOp(
    runId: string, op: string, args?: Record<string, unknown>, silent = false,
  ): Promise<unknown> {
    return request<unknown>(`/api/v1/runs/${runId}/driver/op`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, args: args ?? {} }),
    }, silent)
  }

  // 成员级控制（run 平面唯一写者通道）
  async function controlSession(
    runId: string,
    sessionId: string,
    action: 'pause' | 'resume' | 'stop',
  ): Promise<boolean> {
    return postForAccepted(`/api/v1/runs/${runId}/sessions/${sessionId}/${action}`)
  }

  // 成员定向注入
  async function injectSession(runId: string, sessionId: string, prompt: string): Promise<boolean> {
    return postForAccepted(`/api/v1/runs/${runId}/sessions/${sessionId}/inject`, { prompt })
  }

  // 导出 run 为 workflow bundle（zip）：异步后台导出 + 进度轮询 + 下载。
  // onProgress(done, total, status) 供进度条更新；shouldCancel 由调用方取消。
  // 返回 { ok, error, cancelled, summary }。
  async function exportRun(
    runId: string,
    onProgress?: (done: number, total: number, status: string) => void,
    shouldCancel?: () => boolean,
  ): Promise<{ ok: boolean; error?: string; cancelled?: boolean; summary?: RunExportSummary }> {
    const toast = useToast()
    let taskId = ''
    const cancelExport = () => {
      void request(`/api/v1/runs/${runId}/export/${taskId}/cancel`, { method: 'POST' }, true)
    }
    try {
      // 1) 启动后台导出，拿 task_id（非 2xx 已由统一出口 toast 后端 detail）
      const startData = await request<{ task_id: string }>(
        `/api/v1/runs/${runId}/export`, { method: 'POST' },
      )
      if (!startData || !startData.task_id) {
        return { ok: false, error: '导出启动失败' }
      }
      taskId = startData.task_id

      // 2) 轮询进度（最长 ~10 分钟）；静默 + 少量有界重试，瞬时失败不断流，
      // 连续失败才中止——中止前先 cancel，避免后端导出成僵尸任务继续占锁
      let status = 'running'
      let done = 0
      let total = 0
      let pollError = ''
      for (let i = 0; i < 2000; i++) {
        if (shouldCancel?.()) {
          cancelExport()
          return { ok: false, error: '已取消', cancelled: true }
        }
        let pd: { status?: string; done?: number; total?: number; error?: string } | null = null
        for (let attempt = 0; attempt < 3 && pd === null; attempt++) {
          pd = await request<{ status?: string; done?: number; total?: number; error?: string }>(
            `/api/v1/runs/${runId}/export/${taskId}`, undefined, true,
          )
          if (pd === null && attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
        }
        if (!pd) {
          cancelExport()
          return { ok: false, error: '进度查询失败' }
        }
        status = pd.status || 'running'
        done = pd.done ?? 0
        total = pd.total ?? 0
        pollError = pd.error ?? ''
        onProgress?.(done, total, status)
        if (status === 'done' || status === 'error') break
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      if (status === 'error') {
        // 透传后端已格式化的错误（"{异常类型}: {信息}"），排障保留线索
        toast.error?.(pollError || '导出失败')
        return { ok: false, error: pollError || '导出失败' }
      }
      if (status !== 'done') {
        cancelExport()
        toast.error?.('导出超时')
        return { ok: false, error: '导出超时' }
      }

      // 3) 下载 zip（触发浏览器下载）
      const dl = await fetch(`/api/v1/runs/${runId}/export/${taskId}/download`)
      if (!dl.ok) {
        const detail = (await dl.json().catch(() => null)) as { detail?: string } | null
        const msg = detail?.detail || `下载失败 HTTP ${dl.status}`
        toast.error?.(msg)
        return { ok: false, error: msg }
      }
      const blob = await dl.blob()
      _triggerDownload(blob, `${runId}-bundle.zip`)
      const summary: RunExportSummary = {
        members: Number(dl.headers.get('X-Export-Members') ?? 0),
        relations: Number(dl.headers.get('X-Export-Relations') ?? 0),
        sessions: Number(dl.headers.get('X-Export-Sessions') ?? 0),
        complete: dl.headers.get('X-Export-Complete') === 'true',
      }
      return { ok: true, summary }
    } catch (e) {
      toast.error?.(`网络错误：${e instanceof Error ? e.message : String(e)}`)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  // 级联删除（幂等；删账面与 run 根，不碰 work_dir）
  async function remove(runId: string): Promise<boolean> {
    return (
      (await request<{ run_id: string; deleted: boolean }>(`/api/v1/runs/${runId}`, {
        method: 'DELETE',
      })) !== null
    )
  }

  return {
    runs,
    runDetail,
    startRun,
    refreshRuns,
    refreshRun,
    fetchState,
    fetchEvents,
    control,
    driverOp,
    controlSession,
    injectSession,
    exportRun,
    remove,
  }
}

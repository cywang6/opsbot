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

import { beforeEach, describe, expect, it, vi } from 'vitest'

// useRuns 的列表/详情状态是模块级单例，逐例重载模块避免串扰
beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

// 按调用次序返回预制应答，并记录请求 url 供断言
function stubFetchResponses(bodies: unknown[]) {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify(bodies.shift() ?? {}), { status: 200 })
    }),
  )
  return urls
}

describe('useRuns', () => {
  it('startRun POST /api/v1/runs 并返回 run_id', async () => {
    const { useRuns } = await import('../useRuns')
    const urls = stubFetchResponses([{ run_id: 'r9', status: 'running' }])

    const { startRun } = useRuns()
    const runId = await startRun({
      format: 'graph-yaml@1',
      program_path: '/proj/wf.yaml',
      work_dir: '/proj',
      label: 'wf',
      params: { variables: '{"OP":"relu"}' },
    })

    expect(runId).toBe('r9')
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('/api/v1/runs')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toMatchObject({
      format: 'graph-yaml@1', program_path: '/proj/wf.yaml', label: 'wf',
    })
    void urls
  })

  it('fetchEvents 首拉不带 cursor，续拉回传上轮 next_cursor，limit 显式传入', async () => {
    const { useRuns } = await import('../useRuns')
    const urls = stubFetchResponses([
      { events: [{ id: 1, source: 'run_events' }], next_cursor: 'CUR1' },
      { events: [], next_cursor: 'CUR2' },
      { events: [], next_cursor: '' },
    ])
    const { fetchEvents } = useRuns()

    const first = await fetchEvents('run1')
    expect(first?.next_cursor).toBe('CUR1')
    await fetchEvents('run1', first?.next_cursor)
    await fetchEvents('run1', 'CUR2', 200)

    expect(urls).toEqual([
      '/api/v1/runs/run1/events',
      '/api/v1/runs/run1/events?cursor=CUR1',
      '/api/v1/runs/run1/events?cursor=CUR2&limit=200',
    ])
  })

  it('refreshRuns 把列表写入共享状态', async () => {
    const { useRuns } = await import('../useRuns')
    const run = { run_id: 'r1', status: 'running', kind: 'workflow' }
    stubFetchResponses([{ runs: [run] }])

    const { runs, refreshRuns } = useRuns()
    const ok = await refreshRuns({ includeImplicit: true, status: 'running' })

    expect(ok).toBe(true)
    expect(runs.value).toHaveLength(1)
    expect(runs.value[0].run_id).toBe('r1')
  })

  it('refreshRun 慢响应乱序不覆写最新详情', async () => {
    const { useRuns } = await import('../useRuns')
    const { refreshRun, runDetail } = useRuns()

    let resolveA!: (r: Response) => void
    let resolveB!: (r: Response) => void
    const aResponse = new Promise<Response>((res) => { resolveA = res })
    const bResponse = new Promise<Response>((res) => { resolveB = res })

    vi.stubGlobal('fetch', vi.fn((url: unknown) => {
      const u = String(url)
      if (u === '/api/v1/runs/a') return aResponse
      if (u === '/api/v1/runs/b') return bResponse
      return Promise.resolve(new Response('{}', { status: 200 }))
    }))

    const pa = refreshRun('a')
    const pb = refreshRun('b')

    // 后发的 b 先返回并落单例
    resolveB(new Response(JSON.stringify({ run: { run_id: 'b' }, sessions: [] }), { status: 200 }))
    await pb
    expect(runDetail.value?.run.run_id).toBe('b')

    // 先发的 a 后返回（乱序过期）不得覆写
    resolveA(new Response(JSON.stringify({ run: { run_id: 'a' }, sessions: [] }), { status: 200 }))
    await pa
    expect(runDetail.value?.run.run_id).toBe('b')
  })

  it('refreshRun 2xx 非 JSON 响应解析失败按失败处理、不抛未捕获拒绝', async () => {
    const { useRuns } = await import('../useRuns')
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<html>bad gateway</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    ))

    const { refreshRun } = useRuns()
    await expect(refreshRun('r1')).resolves.toEqual({ ok: false, notFound: false })
  })
})

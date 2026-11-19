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

// 与 useRunEvents 的页长/列表上限一致：满页/不足一页是排空终止的唯一判据；
// 应答 limit 是服务端生效页长（请求值可被钳制），「页满」判定读它
const PAGE_SIZE = 200
const MAX_EVENTS = 2000

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

function fullPage(startId: number, cursor: string) {
  return {
    events: Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: startId + i })),
    next_cursor: cursor,
    limit: PAGE_SIZE,
  }
}

// 按序消费可变页队列（测试中途可续加页模拟服务端新增），空队列回空页
function stubFetchPages(pages: Array<{ events: Array<{ id: number }>; next_cursor: string; limit: number }>) {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url)
      const body = pages.shift() ?? { events: [], next_cursor: '', limit: PAGE_SIZE }
      return new Response(JSON.stringify(body), { status: 200 })
    }),
  )
  return urls
}

// 失败注入：succeed 置位前所有请求回 500，置位后按页队列
function stubFetchSwitchable(pages: Array<{ events: Array<{ id: number }>; next_cursor: string; limit: number }>) {
  let succeed = false
  const markOk = () => { succeed = true }
  const mock = vi.fn(async () => {
    if (!succeed) return new Response('boom', { status: 500 })
    const body = pages.shift() ?? { events: [], next_cursor: '', limit: PAGE_SIZE }
    return new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal('fetch', mock)
  return { mock, markOk }
}

describe('useRunEvents', () => {
  it('首拉排空：满页立即续拉、不足一页即追平，cursor 链回传', async () => {
    const { useRunEvents } = await import('../useRunEvents')
    const urls = stubFetchPages([
      fullPage(1, 'C1'),
      { events: [{ id: 999 }], next_cursor: 'C2', limit: PAGE_SIZE },
    ])
    const { events, pump } = useRunEvents('run1', () => true)

    await pump()

    expect(events.value).toHaveLength(PAGE_SIZE + 1)
    expect(urls).toEqual([
      '/api/v1/runs/run1/events?limit=200',
      '/api/v1/runs/run1/events?cursor=C1&limit=200',
    ])
  })

  it('服务端钳制页长：终止判据用应答 limit，页内不足请求值不提前追平', async () => {
    const { useRunEvents } = await import('../useRunEvents')
    const clampedPage = (startId: number, cursor: string) => ({
      events: Array.from({ length: 50 }, (_, i) => ({ id: startId + i })),
      next_cursor: cursor,
      limit: 50,
    })
    const urls = stubFetchPages([
      clampedPage(1, 'C1'),
      clampedPage(51, 'C2'),
      { events: [{ id: 999 }], next_cursor: 'C3', limit: 50 },
    ])
    const { events, pump } = useRunEvents('run1', () => true)

    await pump()

    // 每页 50 行 < 请求页长 200：按请求值判会在首页后误判追平而截断
    expect(events.value).toHaveLength(101)
    expect(urls).toHaveLength(3)
  })

  it('终态 run 追平后不排程：无兜底节拍，不再产生请求', async () => {
    vi.useFakeTimers()
    try {
      const { useRunEvents } = await import('../useRunEvents')
      const urls = stubFetchPages([{ events: [{ id: 1 }], next_cursor: 'C1', limit: PAGE_SIZE }])
      const { pump } = useRunEvents('run1', () => true)

      await pump()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(urls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('满页按段限速让出：有限存量不截断，追平后非终态按兜底节拍续拉', async () => {
    vi.useFakeTimers()
    try {
      const { useRunEvents } = await import('../useRunEvents')
      // 51 个满页 + 1 个不足页：第 50 页后让出一拍（100ms），其余全速
      const pages = [
        ...Array.from({ length: 51 }, (_, i) => fullPage(i * PAGE_SIZE + 1, `C${i + 1}`)),
        { events: [{ id: 999 }], next_cursor: 'Ctail', limit: PAGE_SIZE },
      ]
      const urls = stubFetchPages(pages)
      const { events, pump } = useRunEvents('run1')

      const p = pump()
      // 50 个满页全速拉完后停在让出拍上：不推进时钟，后续页不发出
      await vi.advanceTimersByTimeAsync(0)
      expect(urls).toHaveLength(50)
      await vi.advanceTimersByTimeAsync(100)
      await p
      // 有限存量（>10000 条）完整追平不受页数截断，环形上限兜住内存
      expect(urls).toHaveLength(52)
      expect(events.value).toHaveLength(MAX_EVENTS)

      // 追平后兜底节拍 3s：全程无 SSE 信号也能推进增量
      pages.push({ events: [{ id: 1000 }], next_cursor: 'Cnext', limit: PAGE_SIZE })
      await vi.advanceTimersByTimeAsync(3000)
      await vi.advanceTimersByTimeAsync(0)
      expect(urls).toHaveLength(53)
      expect(events.value).toHaveLength(MAX_EVENTS)
    } finally {
      vi.useRealTimers()
    }
  })

  it('断线重连回放：缺口事件经重拉补齐，不重不漏', async () => {
    const { useRunEvents } = await import('../useRunEvents')
    const pages = [{ events: [{ id: 1 }], next_cursor: 'C1', limit: PAGE_SIZE }]
    const urls = stubFetchPages(pages)
    const { events, pump } = useRunEvents('run1', () => true)

    await pump()
    expect(events.value.map((e) => e.id)).toEqual([1])

    // 断线期间服务端新增事件，重连信号触发补拉——从上轮水位续拉
    pages.push({ events: [{ id: 2 }], next_cursor: 'C2', limit: PAGE_SIZE })
    await pump()

    expect(events.value.map((e) => e.id)).toEqual([1, 2])
    // 补拉全程带 cursor（不从首拉重放）；增量页不足一页即追平，水位停在 C2
    expect(urls.slice(1).every((u) => u.includes('cursor='))).toBe(true)
    expect(urls[urls.length - 1]).toContain('cursor=C1')
  })

  it('单页瞬时失败：有界重试后继续排空，失败不当追平', async () => {
    vi.useFakeTimers()
    try {
      const { useRunEvents } = await import('../useRunEvents')
      // 前两次失败各等 300ms 重试，第三次成功：满页立即续拉到空页追平
      const pages = [fullPage(1, 'C1')]
      let calls = 0
      vi.stubGlobal('fetch', vi.fn(async () => {
        calls++
        if (calls <= 2) return new Response('boom', { status: 500 })
        const body = pages.shift() ?? { events: [], next_cursor: '', limit: PAGE_SIZE }
        return new Response(JSON.stringify(body), { status: 200 })
      }))
      const { events, pump } = useRunEvents('run1', () => true)

      const p = pump()
      await vi.advanceTimersByTimeAsync(1000)
      await p

      expect(calls).toBe(4)
      expect(events.value).toHaveLength(PAGE_SIZE)
    } finally {
      vi.useRealTimers()
    }
  })

  it('重试穷尽进入退避：failed 置位、冷却期忽略触发、退避到点自动恢复', async () => {
    vi.useFakeTimers()
    try {
      const { useRunEvents } = await import('../useRunEvents')
      const pages: Array<{ events: Array<{ id: number }>; next_cursor: string; limit: number }> = []
      const { mock, markOk } = stubFetchSwitchable(pages)
      const { events, failed, pump } = useRunEvents('run1', () => true)

      // 首轮：1 + 3 次重试全部失败 → 穷尽，进入 300ms 冷却
      const p = pump()
      await vi.advanceTimersByTimeAsync(1000)
      await p
      expect(failed.value).toBe(true)
      expect(mock.mock.calls.length).toBe(4)

      // 冷却期内触发（SSE 信号）被忽略：不放大重试
      void pump()
      expect(mock.mock.calls.length).toBe(4)

      // 退避到点自动重试（600ms 指数拉长）仍失败
      await vi.advanceTimersByTimeAsync(1100)
      expect(mock.mock.calls.length).toBe(8)

      // 服务端恢复：冷却到点自动拉到数据，failed 复位（静止 run 不依赖信号自愈）
      markOk()
      pages.push({ events: [{ id: 1 }], next_cursor: 'C1', limit: PAGE_SIZE })
      await vi.advanceTimersByTimeAsync(600)
      await vi.advanceTimersByTimeAsync(0)
      expect(mock.mock.calls.length).toBe(9)
      expect(failed.value).toBe(false)
      expect(events.value.map((e) => e.id)).toEqual([1])
    } finally {
      vi.useRealTimers()
    }
  })

  it('拉取中的触发合并：收尾后再拉一次', async () => {
    const { useRunEvents } = await import('../useRunEvents')
    let release!: (r: Response) => void
    const gate = new Promise<Response>((res) => { release = res })
    const pages = [{ events: [{ id: 999 }], next_cursor: 'C2', limit: PAGE_SIZE }]
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      if (calls === 1) return gate
      const body = pages.shift() ?? { events: [], next_cursor: '', limit: PAGE_SIZE }
      return new Response(JSON.stringify(body), { status: 200 })
    }))
    const { events, pump } = useRunEvents('run1', () => true)

    const p = pump()
    void pump() // 首页仍在途时触发 → 合并
    release(new Response(JSON.stringify(fullPage(1, 'C1')), { status: 200 }))
    await p
    // 合并触发的补拉在收尾后执行：等真实宏任务收尾
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(calls).toBe(3)
    expect(events.value).toHaveLength(PAGE_SIZE + 1)
  })
})

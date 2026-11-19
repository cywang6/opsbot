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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('useSSE', () => {
  it('runStateEventCount 只计状态/控制类事件：process_output 高频输出不计入详情刷新信号', async () => {
    const { useSSE } = await import('../useSSE')
    const listeners: Record<string, (e: MessageEvent) => void> = {}
    vi.stubGlobal('window', {})
    vi.stubGlobal('EventSource', class {
      addEventListener(type: string, fn: (e: MessageEvent) => void) { listeners[type] = fn }
      close() {}
    })

    const { connect, runEventCount, runStateEventCount } = useSSE()
    connect()

    const emit = (ev: Record<string, unknown>) =>
      listeners['claude_event']({ data: JSON.stringify(ev) } as MessageEvent)

    // run 键事件（session_id 为空）：process_output 高频输出只驱动事件流，不进状态计数
    emit({ run_id: 'r1', session_id: '', event_type: 'process_output', data: {} })
    emit({ run_id: 'r1', session_id: '', event_type: 'process_exit', data: {} })
    emit({ run_id: 'r1', session_id: '', event_type: 'process_output', data: {} })
    emit({ run_id: 'r1', session_id: '', event_type: 'run_steered', data: {} })

    expect(runEventCount.value.r1).toBe(4)
    expect(runStateEventCount.value.r1).toBe(2)
  })

  it('runStateEventCount 排除成员高频活动、只计成员生命周期/状态类事件', async () => {
    const { useSSE } = await import('../useSSE')
    const listeners: Record<string, (e: MessageEvent) => void> = {}
    vi.stubGlobal('window', {})
    vi.stubGlobal('EventSource', class {
      addEventListener(type: string, fn: (e: MessageEvent) => void) { listeners[type] = fn }
      close() {}
    })

    const { connect, runEventCount, runStateEventCount } = useSSE()
    connect()

    const emit = (ev: Record<string, unknown>) =>
      listeners['claude_event']({ data: JSON.stringify(ev) } as MessageEvent)

    // 成员事件经 _stamp_run 打 run_id 戳后与 run 键事件同样带 run_id：
    // 高频活动（tool_use / assistant_message）只驱动事件流，不进状态计数
    emit({ run_id: 'r1', session_id: 's1', event_type: 'tool_use', data: {} })
    emit({ run_id: 'r1', session_id: 's1', event_type: 'assistant_message', data: {} })
    // 生命周期/状态类（session_state_changed / session_outcome）计状态类
    emit({ run_id: 'r1', session_id: 's1', event_type: 'session_state_changed', data: {} })
    emit({ run_id: 'r1', session_id: 's1', event_type: 'session_outcome', data: {} })

    expect(runEventCount.value.r1).toBe(4)
    expect(runStateEventCount.value.r1).toBe(2)
  })

  it('waitingInputBySession：等待事件置位停等，人工回复事件清除', async () => {
    const { useSSE } = await import('../useSSE')
    const listeners: Record<string, (e: MessageEvent) => void> = {}
    vi.stubGlobal('window', {})
    vi.stubGlobal('EventSource', class {
      addEventListener(type: string, fn: (e: MessageEvent) => void) { listeners[type] = fn }
      close() {}
    })

    const { connect, waitingInputBySession } = useSSE()
    connect()

    const emit = (ev: Record<string, unknown>) =>
      listeners['claude_event']({ data: JSON.stringify(ev) } as MessageEvent)

    emit({ session_id: 's1', event_type: 'log_loop', iteration: 0, timestamp: '2026-10-16T10:00:01', data: { decision: 'waiting_for_input', reason: 'manual_mode' } })
    expect(waitingInputBySession.value.s1).toBe('manual')

    emit({ session_id: 's1', event_type: 'log_manual', iteration: 0, timestamp: '2026-10-16T10:00:02', data: { content: '回复' } })
    expect(waitingInputBySession.value.s1).toBeNull()
  })

  it('waitingInputBySession：重连（onopen）清空停等键，回放窗内事件重新播种', async () => {
    const { useSSE } = await import('../useSSE')
    const listeners: Record<string, (e: MessageEvent) => void> = {}
    let es: any
    vi.stubGlobal('window', {})
    vi.stubGlobal('EventSource', class {
      constructor() { es = this }
      addEventListener(type: string, fn: (e: MessageEvent) => void) { listeners[type] = fn }
      close() {}
    })

    const { connect, waitingInputBySession } = useSSE()
    connect()

    const emit = (ev: Record<string, unknown>) =>
      listeners['claude_event']({ data: JSON.stringify(ev) } as MessageEvent)

    es.onopen()
    emit({ session_id: 's1', event_type: 'log_loop', iteration: 0, timestamp: '2026-10-16T10:00:01', data: { decision: 'waiting_for_input', reason: 'manual_mode' } })
    expect(waitingInputBySession.value.s1).toBe('manual')

    // 重连：断线期间的人工回复若落在回放窗外会永久丢失，旧键必须先清零
    es.onopen()
    expect(waitingInputBySession.value.s1).toBeUndefined()

    // 回放窗内的等待事件到达后重新播种
    emit({ session_id: 's1', event_type: 'log_loop', iteration: 0, timestamp: '2026-10-16T10:00:03', data: { decision: 'waiting_for_input', reason: 'manual_mode' } })
    expect(waitingInputBySession.value.s1).toBe('manual')
  })
})

describe('useSSE 重连', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // 抖动归零，让退避间隔可精确断言
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // 记录每次构造的连接地址与事件监听，供断言重连行为
  function stubEventSource() {
    const instances: any[] = []
    vi.stubGlobal('EventSource', class {
      url: string
      listeners: Record<string, (e?: any) => void> = {}
      onopen: () => void = () => {}
      onerror: () => void = () => {}
      constructor(url: string) {
        this.url = url
        instances.push(this)
      }
      addEventListener(type: string, fn: (e?: any) => void) { this.listeners[type] = fn }
      close() {}
    })
    return instances
  }

  it('连接与 auth 后备请求均走正式前缀', async () => {
    const instances = stubEventSource()
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    vi.stubGlobal('window', { addEventListener: () => {} })
    vi.stubGlobal('fetch', fetchMock)

    const { useSSE } = await import('../useSSE')
    useSSE().connect()

    expect(instances[0].url).toBe('/api/v1/events/stream')
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/status')
  })

  it('断线后按退避重建连接，重开成功后退避计数重置', async () => {
    const instances = stubEventSource()
    vi.stubGlobal('window', { addEventListener: () => {} })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))

    const { useSSE } = await import('../useSSE')
    const { connect, connected } = useSSE()
    connect()

    instances[0].onerror()
    expect(connected.value).toBe(false)
    vi.advanceTimersByTime(600)
    expect(instances).toHaveLength(2)

    instances[1].onopen()
    instances[1].onerror()
    // 重开后退避从头计：600ms 内必重建；若计数未重置则要等 1000ms
    vi.advanceTimersByTime(600)
    expect(instances).toHaveLength(3)
    expect(instances.map(es => es.url)).toEqual([
      '/api/v1/events/stream', '/api/v1/events/stream', '/api/v1/events/stream',
    ])
  })

  it('收到 server_reload 立即按基础间隔重连', async () => {
    const instances = stubEventSource()
    vi.stubGlobal('window', { addEventListener: () => {} })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))

    const { useSSE } = await import('../useSSE')
    useSSE().connect()

    instances[0].onerror()
    vi.advanceTimersByTime(600)
    expect(instances).toHaveLength(2)

    // reload 把退避计数清零：600ms 内重建；若沿用失败计数则要等 1000ms
    instances[1].listeners.server_reload()
    vi.advanceTimersByTime(600)
    expect(instances).toHaveLength(3)
  })
})

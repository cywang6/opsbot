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

import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import VirtualLog from '../components/common/VirtualLog.vue'

function makeLine(overrides: Record<string, unknown> = {}) {
  return {
    text: '',
    cls: 'tool-block-line',
    expandId: 'tool:t1',
    block: {
      title: '[ts] Read',
      command: 'foo.py',
      result: 'file content',
      expanded: false,
      failed: false,
      ...(overrides.block || {}),
    },
    ...overrides,
  }
}

describe('VirtualLog', () => {
  it('展开块内点击 .tool-block-body 不触发 toggle（可选中复制）', async () => {
    const line = makeLine({ block: { title: '[ts] Read', command: 'foo.py', result: 'file content', expanded: true } })
    const wrapper = mount(VirtualLog, { props: { lines: [line] } })
    const body = wrapper.find('.tool-block-body')
    expect(body.exists()).toBe(true)
    await body.trigger('click')
    expect(wrapper.emitted('toggle')).toBeUndefined()
    // 标题区点击仍可 toggle
    await wrapper.find('.tool-block-title').trigger('click')
    expect(wrapper.emitted('toggle')).toEqual([['tool:t1']])
  })

  it('flow 行数护栏截断最旧行时顶部渲染省略提示行', async () => {
    // 混合普通行 + 至少一个 block 行，走 flow（非虚拟化）渲染路径
    const lines: any[] = [
      makeLine({ block: { title: '[ts] bash', command: 'ls', result: 'ok', expanded: false } }),
      ...Array.from({ length: 2004 }, (_, i) => `line-${i}`),
    ]
    const wrapper = mount(VirtualLog, { props: { lines } })
    const text = wrapper.find('.vlog-flow').text()
    expect(text).toContain('已省略前 5 行')
    // 渲染的就是截断后的窗口 + 提示行（2000 + 1）
    const rows = wrapper.findAll('.vlog-flow-line')
    expect(rows.length).toBe(2001)
  })

  it('工具结果超长时渲染「查看全文」入口并打开 modal', async () => {
    const line = makeLine({
      block: {
        title: '[ts] bash',
        command: 'ls',
        result: 'preview',
        fullText: 'very long full text',
        expanded: true,
      },
    })
    const wrapper = mount(VirtualLog, { props: { lines: [line] } })
    const full = wrapper.find('.tool-block-full')
    expect(full.exists()).toBe(true)
    await full.trigger('click')
    expect(wrapper.emitted('openModal')).toEqual([['very long full text']])
  })

  it('失败工具块折叠标题带 ✗ 且标红，结果为空也可见', () => {
    const line = makeLine({
      block: { title: '[ts] bash', command: 'ls', result: '', expanded: false, failed: true },
    })
    const wrapper = mount(VirtualLog, { props: { lines: [line] } })
    const title = wrapper.find('.tool-block-title')
    expect(title.text()).toContain('✗ [ts] bash')
    expect(title.classes()).toContain('failed')
    expect(wrapper.find('.tool-block-result').exists()).toBe(false)
  })

  it('成功工具块标题不带失败标识', () => {
    const line = makeLine({
      block: { title: '[ts] bash', command: 'ls', result: 'ok', expanded: false, failed: false },
    })
    const wrapper = mount(VirtualLog, { props: { lines: [line] } })
    const title = wrapper.find('.tool-block-title')
    expect(title.text()).not.toContain('✗')
    expect(title.classes()).not.toContain('failed')
  })
})

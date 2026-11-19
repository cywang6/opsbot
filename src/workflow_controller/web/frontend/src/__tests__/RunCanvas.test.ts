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

import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import RunCanvas from '../graph/components/RunCanvas.vue'
import type { RunView } from '../graph/lib/view-model'

// 相机的「打开即适配」：fitKey 已就位时（主图恒 'main'、子图弹窗首次打开
// view.id 随组件创建即就位），挂载后须按视口尺寸落下相机，而非停留在原点
// 100%。断言 SVG width/height（commitCamera 按内容尺寸 × 缩放重设）——
// happy-dom 视口尺寸为 0，fit 会回退 resetCamera（100%），故此处 mock 视口
// clientWidth/Height 以让 fitToView 真实算出缩放档位，区分「已适配/未适配」。
function stubViewport(w: number, h: number): void {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => w })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => h })
}

function makeView(over: Partial<RunView> = {}): RunView {
  return {
    id: 'main',
    title: '主图',
    parentKey: null,
    nodeKeys: [],
    ranks: {},
    edges: [],
    edgeChains: [],
    rollbackLinks: [],
    layout: { bands: [], positions: {}, width: 1000, height: 800 },
    ...over,
  }
}

// 视口 800×600，留白 24 后 avail = 776×576；内容 1000×800 → z = min(776/1000, 576/800) = 0.72
const FIT_W = '720'
const FIT_H = '576'

beforeEach(() => {
  stubViewport(800, 600)
})

describe('RunCanvas — 打开即适配（fitKey 就位 → 相机落定）', () => {
  it('fitKey 已就位时挂载即适配画布', () => {
    const wrapper = mount(RunCanvas, {
      props: { view: makeView(), nodesByKey: new Map(), selectedKey: null, fitKey: 'main' },
    })
    const svg = wrapper.find('svg.graph-dag')
    expect(svg.exists()).toBe(true)
    // 主图首次渲染即落定到适配档位（失配会停在 1000×800）
    expect(svg.attributes('width')).toBe(FIT_W)
    expect(svg.attributes('height')).toBe(FIT_H)
  })

  it('fitKey 未传时不自动适配（原点 100%）', () => {
    const wrapper = mount(RunCanvas, {
      props: { view: makeView(), nodesByKey: new Map(), selectedKey: null, fitKey: undefined },
    })
    const svg = wrapper.find('svg.graph-dag')
    expect(svg.attributes('width')).toBe('1000')
    expect(svg.attributes('height')).toBe('800')
  })

  it('fitKey 从不传变为就位时触发适配（子图弹窗打开/切换）', async () => {
    const wrapper = mount(RunCanvas, {
      props: { view: makeView(), nodesByKey: new Map(), selectedKey: null, fitKey: undefined },
    })
    expect(wrapper.find('svg.graph-dag').attributes('width')).toBe('1000')

    await wrapper.setProps({ fitKey: 'main' })
    const svg = wrapper.find('svg.graph-dag')
    expect(svg.attributes('width')).toBe(FIT_W)
    expect(svg.attributes('height')).toBe(FIT_H)
  })
})
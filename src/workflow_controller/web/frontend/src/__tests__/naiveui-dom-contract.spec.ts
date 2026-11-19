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
import { NCard, NDataTable } from 'naive-ui'

// Naive UI DOM 契约守卫：RunView 等视图用 :deep() 覆盖卡片内容高度以约束内部滚动
// （页面高度有界）。卡片内容类名是 n-card-content——无 BEM 双下划线；RunView 曾因
// :deep(.n-card__content) 死选择器使事件流/DAG 卡片高度无约束、整页向下无界延伸。
// naive-ui 升级若改动这些类名/样式落点，此处在构建期红掉而不是页面悄悄坏掉。
describe('Naive UI DOM 契约（:deep 选择器依赖）', () => {
  it('n-card 内容元素类名是 n-card-content', () => {
    const w = mount(NCard, { props: { title: 't' }, slots: { default: () => 'x' } })
    expect(w.element.querySelector('.n-card-content')).toBeTruthy()
    expect(w.element.querySelector('.n-card__content')).toBeNull()
  })

  it('n-data-table max-height 落到滚动体上（calc 字符串透传）', () => {
    const w = mount(NDataTable, {
      props: {
        columns: [{ title: 'a', key: 'a' }],
        data: [{ a: 1 }, { a: 2 }],
        maxHeight: 'calc(100vh - 380px)',
      },
    })
    const body = w.element.querySelector('.n-data-table-base-table-body') as HTMLElement
    expect(body).toBeTruthy()
    expect(body.style.maxHeight).toBe('calc(100vh - 380px)')
  })
})

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

import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { APPEARANCE_FONT_OPTIONS, APPEARANCE_THEMES, useAppearance } from '../composables/useAppearance'

describe('useAppearance', () => {
  it('exposes the requested theme families and fonts', () => {
    expect(APPEARANCE_THEMES.filter(theme => theme.mode === 'light').map(theme => theme.label)).toEqual([
      'GitHub Light', 'VS Code Light', 'One Light', 'Cappuccin Latte', 'Solarized Light',
    ])
    expect(APPEARANCE_THEMES.filter(theme => theme.mode === 'dark').map(theme => theme.label)).toEqual([
      'GitHub Dark', 'VS Code Dark', 'One Dark Pro', 'Dracula', 'Cappuccin Mocha', 'Solarized Dark',
    ])
    expect(APPEARANCE_FONT_OPTIONS.map(font => font.label)).toEqual([
      'System', 'Arial', '思源黑体', '苹方', '微软雅黑', 'JetBrains Mono',
    ])
  })

  it('applies selections to the document and persists them', async () => {
    const appearance = useAppearance()
    appearance.setTheme('solarized-light')
    appearance.setFont('Arial')
    appearance.setBackgroundImage('https://example.com/background.jpg')
    appearance.setBackgroundImageFit('cover')
    await nextTick()
    expect(document.documentElement.dataset.appearanceTheme).toBe('solarized-light')
    expect(document.documentElement.style.getPropertyValue('--workflow-controller-font-family')).toContain('Arial')
    expect(localStorage.getItem('workflow-controller-appearance-theme')).toBe('solarized-light')
    expect(localStorage.getItem('workflow-controller-appearance-font')).toBe('Arial')
    expect(localStorage.getItem('workflow-controller-appearance-background-image')).toBe('https://example.com/background.jpg')
    expect(localStorage.getItem('workflow-controller-appearance-background-fit')).toBe('cover')
    expect(document.documentElement.style.getPropertyValue('--workflow-controller-empty-background-size')).toBe('cover')
    expect(document.documentElement.style.getPropertyValue('--workflow-controller-empty-background-image')).toContain('example.com/background.jpg')
    appearance.clearBackgroundImage()
    await nextTick()
    expect(localStorage.getItem('workflow-controller-appearance-background-image')).toBe('')
  })

  it('从 data URL 切到普通 URL 或清空时 revoke 旧 blob URL，同源 data URL 复用缓存', async () => {
    // 1x1 透明 PNG 的 data URL
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const created: string[] = []
    const revoked: string[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((obj: Blob | MediaSource) => {
      const url = `blob:mock-${created.length}`
      created.push(obj instanceof Blob ? obj.type : 'unknown')
      return url
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => { revoked.push(url) })

    const appearance = useAppearance()
    appearance.setBackgroundImage(dataUrl)
    await nextTick()
    expect(created).toHaveLength(1)
    expect(document.documentElement.style.getPropertyValue('--workflow-controller-empty-background-image')).toContain('blob:mock-0')

    // 主题/字体变更复用同一 data URL：不再重复 atob + 建 blob
    appearance.setTheme('vscode-light')
    appearance.setFont('Arial')
    await nextTick()
    expect(created).toHaveLength(1)
    expect(revoked).toHaveLength(0)

    // 切到普通 URL：旧 blob URL 应被 revoke，不再泄漏
    appearance.setBackgroundImage('https://example.com/bg.jpg')
    await nextTick()
    expect(revoked).toEqual(['blob:mock-0'])
    expect(created).toHaveLength(1)

    // 清空：同样 revoke
    appearance.setBackgroundImage(dataUrl)
    await nextTick()
    expect(created).toHaveLength(2)
    appearance.clearBackgroundImage()
    await nextTick()
    expect(revoked).toEqual(['blob:mock-0', 'blob:mock-1'])
  })

  it('URL 编码的非 base64 data URL（如内联 SVG）直接作 CSS 背景，不静默丢弃', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:should-not-be-used')
    const svgUrl = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"
    const appearance = useAppearance()
    appearance.setBackgroundImage(svgUrl)
    await nextTick()
    expect(document.documentElement.style.getPropertyValue('--workflow-controller-empty-background-image')).toBe(`url("${svgUrl}")`)
    expect(appearance.backgroundImageError.value).toBe('')
    appearance.clearBackgroundImage()
    await nextTick()
  })

  it('含裸双引号/换行的 URL 转义后仍是单条合法 CSS url() 声明', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:should-not-be-used')
    const appearance = useAppearance()
    // 未 URL 编码的内联 SVG：载荷含双引号与换行
    appearance.setBackgroundImage('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg">\n</svg>')
    await nextTick()
    expect(document.documentElement.style.getPropertyValue('--workflow-controller-empty-background-image'))
      .toBe('url("data:image/svg+xml,<svg xmlns=\\"http://www.w3.org/2000/svg\\"> </svg>")')
    expect(appearance.backgroundImageError.value).toBe('')
    // 普通 URL 分支同样转义
    appearance.setBackgroundImage('https://example.com/a"b\nc.png')
    await nextTick()
    expect(document.documentElement.style.getPropertyValue('--workflow-controller-empty-background-image'))
      .toBe('url("https://example.com/a\\"b c.png")')
    appearance.clearBackgroundImage()
    await nextTick()
  })

  it('base64 data URL 解码失败时记录原因（供设置页提示），换成有效值后清除', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const appearance = useAppearance()
    appearance.setBackgroundImage('data:image/png;base64,###not-base64###')
    await nextTick()
    expect(document.documentElement.style.getPropertyValue('--workflow-controller-empty-background-image')).toBe('none')
    expect(appearance.backgroundImageError.value).toContain('base64')
    expect(warnSpy).toHaveBeenCalledTimes(1)

    appearance.setBackgroundImage('https://example.com/bg.jpg')
    await nextTick()
    expect(appearance.backgroundImageError.value).toBe('')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    appearance.clearBackgroundImage()
    await nextTick()
    warnSpy.mockRestore()
  })

  it('localStorage 写入失败（配额超限）时暴露持久化失败状态，当次会话仍生效，成功写入后清除', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const originalSetItem = localStorage.setItem.bind(localStorage)
    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (key === 'workflow-controller-appearance-background-image') throw new DOMException('quota exceeded', 'QuotaExceededError')
      originalSetItem(key, value)
    })
    const appearance = useAppearance()
    appearance.setBackgroundImage('https://example.com/big-bg.jpg')
    await nextTick()
    expect(appearance.backgroundImagePersistError.value).toContain('刷新后背景图将丢失')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    // 内存值保留：当次会话背景仍生效
    expect(document.documentElement.style.getPropertyValue('--workflow-controller-empty-background-image')).toContain('big-bg.jpg')

    setItemSpy.mockRestore()
    appearance.setBackgroundImage('https://example.com/another-bg.jpg')
    await nextTick()
    expect(appearance.backgroundImagePersistError.value).toBe('')
    expect(localStorage.getItem('workflow-controller-appearance-background-image')).toBe('https://example.com/another-bg.jpg')

    appearance.clearBackgroundImage()
    await nextTick()
    warnSpy.mockRestore()
  })
})

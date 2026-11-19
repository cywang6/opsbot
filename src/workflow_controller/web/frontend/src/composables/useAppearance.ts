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

import { computed, ref, watch } from 'vue'

export type AppearanceMode = 'light' | 'dark'
export type BackgroundImageFit = 'cover' | 'contain'

export interface AppearanceTheme {
  value: string
  label: string
  mode: AppearanceMode
  colors: {
    body: string
    surface: string
    card: string
    modal: string
    input: string
    text: string
    textMuted: string
    border: string
    divider: string
    primary: string
    primaryHover: string
    hover: string
    code: string
    codeText: string
  }
}

const themes: AppearanceTheme[] = [
  { value: 'github-light', label: 'GitHub Light', mode: 'light', colors: { body: '#f6f8fa', surface: '#ffffff', card: '#ffffff', modal: '#ffffff', input: '#ffffff', text: '#1f2328', textMuted: '#656d76', border: '#d0d7de', divider: '#d8dee4', primary: '#0969da', primaryHover: '#0550ae', hover: '#f3f4f6', code: '#f6f8fa', codeText: '#1f2328' } },
  { value: 'vscode-light', label: 'VS Code Light', mode: 'light', colors: { body: '#f3f3f3', surface: '#ffffff', card: '#ffffff', modal: '#ffffff', input: '#ffffff', text: '#333333', textMuted: '#616161', border: '#d6d6d6', divider: '#e5e5e5', primary: '#0066b8', primaryHover: '#005a9e', hover: '#e8e8e8', code: '#f3f3f3', codeText: '#333333' } },
  { value: 'one-light', label: 'One Light', mode: 'light', colors: { body: '#fafafa', surface: '#ffffff', card: '#ffffff', modal: '#ffffff', input: '#ffffff', text: '#383a42', textMuted: '#696c77', border: '#d9d9d9', divider: '#e5e5e6', primary: '#4078f2', primaryHover: '#2f66d0', hover: '#f0f0f0', code: '#f0f0f0', codeText: '#383a42' } },
  { value: 'cappuccin-latte', label: 'Cappuccin Latte', mode: 'light', colors: { body: '#eff1f5', surface: '#ffffff', card: '#ffffff', modal: '#ffffff', input: '#ffffff', text: '#4c4f69', textMuted: '#6c6f85', border: '#ccd0da', divider: '#dce0e8', primary: '#1e66f5', primaryHover: '#1555d0', hover: '#e6e9ef', code: '#e6e9ef', codeText: '#4c4f69' } },
  { value: 'solarized-light', label: 'Solarized Light', mode: 'light', colors: { body: '#fdf6e3', surface: '#eee8d5', card: '#fdf6e3', modal: '#eee8d5', input: '#fdf6e3', text: '#586e75', textMuted: '#839496', border: '#d6cdb5', divider: '#e1d8c2', primary: '#268bd2', primaryHover: '#1f6faa', hover: '#eee8d5', code: '#eee8d5', codeText: '#586e75' } },
  { value: 'github-dark', label: 'GitHub Dark', mode: 'dark', colors: { body: '#0d1117', surface: '#161b22', card: '#161b22', modal: '#21262d', input: '#21262d', text: '#f0f6fc', textMuted: '#8b949e', border: '#30363d', divider: '#21262d', primary: '#58a6ff', primaryHover: '#79c0ff', hover: '#21262d', code: '#161b22', codeText: '#c9d1d9' } },
  { value: 'vscode-dark', label: 'VS Code Dark', mode: 'dark', colors: { body: '#1e1e1e', surface: '#252526', card: '#252526', modal: '#2d2d30', input: '#3c3c3c', text: '#cccccc', textMuted: '#9d9d9d', border: '#454545', divider: '#333333', primary: '#3794ff', primaryHover: '#5dafff', hover: '#2a2d2e', code: '#1e1e1e', codeText: '#d4d4d4' } },
  { value: 'one-dark-pro', label: 'One Dark Pro', mode: 'dark', colors: { body: '#282c34', surface: '#21252b', card: '#21252b', modal: '#282c34', input: '#2c313c', text: '#abb2bf', textMuted: '#7f848e', border: '#3e4451', divider: '#323842', primary: '#61afef', primaryHover: '#82c5f4', hover: '#2c313c', code: '#1e2227', codeText: '#abb2bf' } },
  { value: 'dracula', label: 'Dracula', mode: 'dark', colors: { body: '#282a36', surface: '#21222c', card: '#21222c', modal: '#282a36', input: '#343746', text: '#f8f8f2', textMuted: '#a9abbd', border: '#44475a', divider: '#343746', primary: '#bd93f9', primaryHover: '#d0b0ff', hover: '#343746', code: '#191a21', codeText: '#f8f8f2' } },
  { value: 'cappuccin-mocha', label: 'Cappuccin Mocha', mode: 'dark', colors: { body: '#1e1e2e', surface: '#181825', card: '#181825', modal: '#1e1e2e', input: '#313244', text: '#cdd6f4', textMuted: '#a6adc8', border: '#45475a', divider: '#313244', primary: '#89b4fa', primaryHover: '#b4d0ff', hover: '#313244', code: '#11111b', codeText: '#cdd6f4' } },
  { value: 'solarized-dark', label: 'Solarized Dark', mode: 'dark', colors: { body: '#002b36', surface: '#073642', card: '#073642', modal: '#002b36', input: '#073642', text: '#839496', textMuted: '#657b83', border: '#1b4b55', divider: '#12424c', primary: '#2aa198', primaryHover: '#35c3b9', hover: '#0a4050', code: '#002b36', codeText: '#93a1a1' } },
]

export const APPEARANCE_THEMES = themes
export const APPEARANCE_THEME_OPTIONS = themes.map(({ value, label }) => ({ value, label }))
// 默认主题具名常量：避免以 themes[5] 之类的魔法下标做回退。
export const DEFAULT_THEME_VALUE = 'github-dark'
export const APPEARANCE_FONT_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'Arial', label: 'Arial' },
  { value: 'Source Han Sans SC', label: '思源黑体' },
  { value: 'PingFang SC', label: '苹方' },
  { value: 'Microsoft YaHei', label: '微软雅黑' },
  { value: 'JetBrains Mono', label: 'JetBrains Mono' },
]

const THEME_KEY = 'workflow-controller-appearance-theme'
const FONT_KEY = 'workflow-controller-appearance-font'
const BACKGROUND_IMAGE_KEY = 'workflow-controller-appearance-background-image'
const BACKGROUND_IMAGE_FIT_KEY = 'workflow-controller-appearance-background-fit'
const theme = ref(DEFAULT_THEME_VALUE)
const font = ref('system')
const backgroundImage = ref('')
const backgroundImageError = ref('')
const backgroundImagePersistError = ref('')
const backgroundImageFit = ref<BackgroundImageFit>('contain')
let backgroundObjectUrl = ''
let backgroundObjectSource = ''

function read(key: string, fallback: string) {
  try { return window.localStorage.getItem(key) || fallback } catch { return fallback }
}

function fontStack(value: string) {
  if (value === 'system') return '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  if (value === 'Source Han Sans SC') return '"Source Han Sans SC", "Noto Sans CJK SC", sans-serif'
  if (value === 'PingFang SC') return '"PingFang SC", sans-serif'
  if (value === 'Microsoft YaHei') return '"Microsoft YaHei", sans-serif'
  if (value === 'JetBrains Mono') return '"JetBrains Mono", monospace'
  return 'Arial, sans-serif'
}

// 只在数据源真正变化时重建 blob：主题/字体变更触发 applyAppearance 时会用同一
// data URL 反复调用 cssBackgroundImage，相同来源直接复用现有 object URL。
// 值从 data URL 切到普通 URL / 空值时，旧 blob URL 统一 revoke，避免一次性泄漏。
function releaseBackgroundObject() {
  if (backgroundObjectUrl) {
    URL.revokeObjectURL(backgroundObjectUrl)
    backgroundObjectUrl = ''
  }
  backgroundObjectSource = ''
}

// 记录背景图未生效的原因供设置页提示；只在状态变化时告警，避免主题/字体
// 变更触发的重复 applyAppearance 在控制台刷屏。
function noteBackgroundImageError(message: string) {
  if (backgroundImageError.value === message) return
  backgroundImageError.value = message
  if (message) console.warn(`[useAppearance] 背景图未生效：${message}`)
}

// CSS 双引号字符串里的裸 `\`、`"`、换行会提前终止或破坏字符串，导致整条
// background-image 声明被浏览器丢弃（背景静默不生效）；拼入 url() 前统一转义。
export function cssUrlString(value: string) {
  return `url("${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}")`
}

function cssBackgroundImage(value: string) {
  if (!value) {
    releaseBackgroundObject()
    noteBackgroundImageError('')
    return 'none'
  }
  if (!value.startsWith('data:')) {
    releaseBackgroundObject()
    noteBackgroundImageError('')
    return cssUrlString(value)
  }
  // URL 编码的非 base64 data URL（如内联 SVG）可直接作 CSS 背景；若一律走
  // base64 解码，atob 会因非 base64 载荷抛异常而静默丢掉背景。
  const comma = value.indexOf(',')
  const header = comma < 0 ? value : value.slice(0, comma)
  if (!header.toLowerCase().includes(';base64')) {
    releaseBackgroundObject()
    noteBackgroundImageError('')
    return cssUrlString(value)
  }
  if (backgroundObjectSource === value && backgroundObjectUrl) return `url("${backgroundObjectUrl}")`
  try {
    if (comma < 0) throw new Error('data URL 缺少载荷')
    const payload = value.slice(comma + 1)
    const binary = atob(payload)
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    releaseBackgroundObject()
    backgroundObjectSource = value
    backgroundObjectUrl = URL.createObjectURL(new Blob([bytes], { type: header.slice(5).split(';')[0] || 'application/octet-stream' }))
    noteBackgroundImageError('')
    return `url("${backgroundObjectUrl}")`
  } catch {
    releaseBackgroundObject()
    noteBackgroundImageError('data URL 的 base64 内容无法解析，背景图不会显示')
    return 'none'
  }
}

function applyAppearance() {
  if (typeof document === 'undefined') return
  const selected = themes.find(item => item.value === theme.value) || themes.find(item => item.value === DEFAULT_THEME_VALUE)!
  const root = document.documentElement
  root.dataset.appearanceTheme = selected.value
  // 主题明暗档落 data 属性：run 图等 CSS 双档令牌（--run-st-* 等）按此切换
  root.dataset.themeMode = selected.mode
  root.style.colorScheme = selected.mode
  root.style.setProperty('--workflow-controller-font-family', fontStack(font.value))
  root.style.setProperty('--workflow-controller-free-space', selected.mode === 'light' ? '#d0d7de' : '#282828')
  root.style.setProperty('--workflow-controller-tool-command-bg', selected.mode === 'light' ? '#f0f1f5' : '#211f3b')
  root.style.setProperty('--workflow-controller-tool-command-text', selected.mode === 'light' ? '#256c45' : '#a7e3b0')
  root.style.setProperty('--workflow-controller-tool-result-text', selected.mode === 'light' ? '#7d7d7b' : selected.colors.textMuted)
  root.style.setProperty('--workflow-controller-empty-background-image', cssBackgroundImage(backgroundImage.value))
  root.style.setProperty('--workflow-controller-empty-background-size', backgroundImageFit.value)
  Object.entries(selected.colors).forEach(([key, value]) => {
    const cssKey = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
    root.style.setProperty(`--workflow-controller-${cssKey}`, value)
  })
}

if (typeof window !== 'undefined') {
  const savedTheme = read(THEME_KEY, theme.value)
  const savedFont = read(FONT_KEY, font.value)
  const savedBackgroundImage = read(BACKGROUND_IMAGE_KEY, '')
  const savedBackgroundImageFit = read(BACKGROUND_IMAGE_FIT_KEY, 'contain')
  if (themes.some(item => item.value === savedTheme)) theme.value = savedTheme
  if (APPEARANCE_FONT_OPTIONS.some(item => item.value === savedFont)) font.value = savedFont
  backgroundImage.value = savedBackgroundImage
  if (savedBackgroundImageFit === 'cover' || savedBackgroundImageFit === 'contain') backgroundImageFit.value = savedBackgroundImageFit
  applyAppearance()
}

watch(theme, value => { try { localStorage.setItem(THEME_KEY, value) } catch {}; applyAppearance() })
watch(font, value => { try { localStorage.setItem(FONT_KEY, value) } catch {}; applyAppearance() })
// 背景图以 base64 data URL 存入 localStorage（会膨胀约 33%）。setItem 失败（配额
// 超限）时保持内存值（当次会话仍显示）并记录失败状态供设置页保存时告警，
// 避免「生效→刷新丢失」的静默回退。
// 入口处 SettingsModal 已把原始文件上限压到 3MB，正常选择不会走到这里。
watch(backgroundImage, value => {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(BACKGROUND_IMAGE_KEY, value)
    backgroundImagePersistError.value = ''
  } catch (err) {
    backgroundImagePersistError.value = '浏览器本地存储写入失败（配额超限），刷新后背景图将丢失'
    console.warn('[useAppearance] 背景图无法持久化（localStorage 配额超限）：', err)
  }
  applyAppearance()
})
watch(backgroundImageFit, value => {
  try { localStorage.setItem(BACKGROUND_IMAGE_FIT_KEY, value) } catch {}
  applyAppearance()
})

export function useAppearance() {
  const selectedTheme = computed(
    () => themes.find(item => item.value === theme.value)
      || themes.find(item => item.value === DEFAULT_THEME_VALUE)!,
  )
  return {
    theme,
    font,
    backgroundImage,
    backgroundImageError,
    backgroundImagePersistError,
    backgroundImageFit,
    selectedTheme,
    isDark: computed(() => selectedTheme.value.mode === 'dark'),
    setTheme: (value: string) => { theme.value = value },
    setFont: (value: string) => { font.value = value },
    setBackgroundImage: (value: string) => { backgroundImage.value = value.trim() },
    setBackgroundImageFit: (value: BackgroundImageFit) => { backgroundImageFit.value = value },
    clearBackgroundImage: () => { backgroundImage.value = '' },
  }
}

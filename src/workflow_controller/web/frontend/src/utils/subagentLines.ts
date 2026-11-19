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

// 子代理消息块 → VirtualLog 行的纯函数渲染。
// 从 SessionDetailView.vue 抽出，便于单测（无 Vue 响应式依赖）。
// 展开块同时给出顶部 + 底部两个 [点击折叠] 开关：底部开关让人读完
// 一长串 thinking/工具细节后无需回滚到顶部即可收起。

export interface TypedLine {
  text: string
  cls: string
  expandId?: string
  html?: string
  modal?: string
}

// 思考块折叠渲染：标题行带箭头开关，展开时正文过滤纯空行。
export function fmtThinkingBlock(text: string, expandId: string, expanded: Set<string>, prefix = ''): TypedLine[] {
  if (!expanded.has(expandId)) {
    return [{ text: `${prefix}Thinking ▸`, cls: 'cls-thinking', expandId }]
  }
  const lines: TypedLine[] = [{ text: `${prefix}Thinking ▾`, cls: 'cls-thinking cls-thinking-active', expandId }]
  const bodyPrefix = prefix.trimStart().startsWith('[') ? '  ' : prefix
  for (const l of text.split('\n')) {
    if (l.trim()) lines.push({ text: `${bodyPrefix}${l}`, cls: 'cls-thinking' })
  }
  return lines
}

// 单条子代理消息 → 缩进的文本/thinking/tool 行（不包含展开开关）。
export function fmtSubagentMessageLines(messages: any[], expanded = new Set<string>(), scope = ''): TypedLine[] {
  const lines: TypedLine[] = []
  for (const [index, m] of messages.entries()) {
    if (m.type === 'text') {
      const text = (m.text || '').trim()
      if (!text) continue
      for (const l of text.split('\n')) lines.push({ text: `    │ ${l}`, cls: 'cls-subagent' })
    } else if (m.type === 'thinking') {
      const text = (m.text || '').trim()
      if (!text) continue
      // scope（父级子代理展开 ID）参与 key：不同子代理相同下标 + 相同前缀不再联动。
      lines.push(...fmtThinkingBlock(text, `subagent-thinking:${scope}:${index}:${text.slice(0, 24)}`, expanded, '    '))
    } else if (m.type === 'tool_use') {
      const arg = m.input?.command || m.input?.file_path || m.input?.pattern || JSON.stringify(m.input || {}).slice(0, 80)
      lines.push({ text: `    Tool call · ${m.name || '?'}${arg ? `  ${arg}` : ''}`, cls: 'cls-tool' })
    } else if (m.type === 'tool_result') {
      const c = typeof m.content === 'string' ? m.content.trim() : ''
      const stateLabel = m.is_error === true ? '✗ error' : m.is_error === false ? '✓ result' : '? unknown'
      const label = `    ${stateLabel}`
      lines.push({ text: `${label} (${m.tool_use_id || '?'})`, cls: 'cls-result' })
      if (c) for (const l of c.split('\n').slice(0, 5)) lines.push({ text: `    │ ${l}`, cls: 'cls-result' })
    }
  }
  return lines
}

// 展开块：顶部开关 + 全量消息体 + 底部开关（两处均可点击折叠）。
export function fmtExpandedSubagentBlock(messages: any[], expandId: string, expanded = new Set<string>()): TypedLine[] {
  const lines: TypedLine[] = [{ text: `  └── [点击折叠] ──`, cls: 'cls-subagent', expandId }]
  for (const ln of fmtSubagentMessageLines(messages, expanded, expandId)) lines.push(ln)
  lines.push({ text: `  └── [点击折叠] ──`, cls: 'cls-subagent', expandId })
  return lines
}

// 折叠块：前 2 条 text/thinking 预览 + 「N 条消息 (点击展开)」开关。
export function fmtCollapsedSubagentBlock(messages: any[], expandId: string): TypedLine[] {
  const lines: TypedLine[] = []
  const previewMsgs = messages.filter((m: any) => m.type === 'text' || m.type === 'thinking').slice(0, 2)
  for (const m of previewMsgs) {
    const tag = m.type === 'thinking' ? 'Thinking' : '┃'
    const firstLine = (m.text || '').split('\n')[0]?.slice(0, 120) || ''
    const more = (m.text || '').length > 120
    lines.push({ text: `  ${tag} ${firstLine}${more ? '...' : ''}`, cls: 'cls-subagent' })
  }
  lines.push({ text: `  └─ ${messages.length} 条消息 (点击展开)`, cls: 'cls-subagent', expandId })
  return lines
}

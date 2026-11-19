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

/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 仍保留旧 /api 前缀的只有插件贡献路由（插件路由不参与前缀切换）
// 和 insight 反代的路径空间
const OLD_PATH_ALLOWLIST: RegExp[] = [
  /^\/api\/breather\//,
  /^\/api\/provenance\//,
  /^\/api\/sessions\/import-db(\/|$)/,
  /^\/api\/sessions\/\$\{[^}]*\}\/(checkpoints|traceback)(\/|$|\?)/,
  /^\/api\/observe\//,
]

// 递归收集目录下的源码文件
function collectSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectSourceFiles(full, files)
    else if (/\.(ts|vue)$/.test(entry.name)) files.push(full)
  }
  return files
}

// 提取字符串/模板字面量中以 /api/ 开头的请求路径；e2e 的 glob 形式（'**/api/...'）剥掉 ** 前缀一并纳入，
// 否则 page.route 的 glob mock 整体落在扫描范围外
function extractQuotedApiPaths(source: string): string[] {
  return [...source.matchAll(/["'`](?:\*\*)?(\/api\/[^"'`\s]*)["'`]/g)].map(m => m[1])
}

// 提取正则字面量中转义斜杠形式的路径（如 e2e 路由 mock 的 /\/api\/...）
function extractRegexApiPaths(source: string): string[] {
  return [...source.matchAll(/\\\/api\\\/[^"'`\s(]*/g)]
    .map(m => m[0].replace(/\\\//g, '/').replace(/\$$/, ''))
}

describe('API 前缀', () => {
  it('路径提取覆盖字符串、glob 与正则三种写法', () => {
    const source = [
      "request('/api/v1/config')",
      "page.route('**/api/v1/sessions/e2e', async (route) => {})",
      'page.route(/\\/api\\/v1\\/sessions\\/\\d+(?:\\?.*)?$/, async (route) => {})',
    ].join('\n')
    expect(extractQuotedApiPaths(source)).toEqual(['/api/v1/config', '/api/v1/sessions/e2e'])
    expect(extractRegexApiPaths(source)).toEqual(['/api/v1/sessions/\\d+'])
  })

  it('自有端点全部使用 /api/v1，残留旧路径仅限插件路由与反代路径', () => {
    const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
    const guardFile = fileURLToPath(import.meta.url)
    const offenders: string[] = []
    for (const dir of ['src', 'e2e']) {
      for (const file of collectSourceFiles(join(frontendRoot, dir))) {
        if (file === guardFile) continue
        const source = readFileSync(file, 'utf8')
        for (const path of [...extractQuotedApiPaths(source), ...extractRegexApiPaths(source)]) {
          if (path.startsWith('/api/v1/')) continue
          if (OLD_PATH_ALLOWLIST.some(re => re.test(path))) continue
          offenders.push(`${file}: ${path}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

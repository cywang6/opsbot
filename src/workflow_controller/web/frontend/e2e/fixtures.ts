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

import { mkdir, writeFile } from 'node:fs/promises'
import { expect as playwrightExpect, test as base, type Page } from '@playwright/test'

export type { Page }
export const expect = playwrightExpect

type Fixtures = {
  browserConsole: void
}

// Keep browser diagnostics beside Playwright's trace/screenshot/video when a test fails,
// and enforce the design doc's "页面无未处理异常" acceptance standard: the captured
// pageerror list doubles as a gate, so a page that throws while assertions are green
// fails the run instead of being silently ignored. Known-benign exceptions may be added
// to `ALLOWED_PAGEERROR_FRAGMENTS` to keep the gate noise-free.
const ALLOWED_PAGEERROR_FRAGMENTS: readonly string[] = []

export const test = base.extend<Fixtures>({
  browserConsole: [async ({ page }, use, testInfo) => {
    const entries: string[] = []
    const pageErrors: string[] = []
    page.on('console', (message) => {
      entries.push(`[console:${message.type()}] ${message.text()}`)
    })
    page.on('pageerror', (error) => {
      const text = error.stack || error.message
      pageErrors.push(text)
      entries.push(`[pageerror] ${text}`)
    })

    await use()

    // Gate the "no unhandled page exceptions" standard only on green runs: when the
    // assertions already failed, the pageerror is secondary diagnostic (persisted below),
    // and re-throwing here would mask the primary failure.
    if (testInfo.status === 'passed') {
      const unexpected = pageErrors.filter(
        (text) => !ALLOWED_PAGEERROR_FRAGMENTS.some((fragment) => text.includes(fragment)),
      )
      if (unexpected.length > 0) {
        throw new Error(`Page raised unhandled exception(s):\n${unexpected.join('\n---\n')}`)
      }
    }

    // Only persist the diagnostic log for tests that ran and ended in a failure state.
    // Skipped tests (runtime `testInfo.skip()`) previously wrote empty artifacts because
    // `status !== expectedStatus` is also true for them.
    if (testInfo.status === 'failed' || testInfo.status === 'timedOut') {
      const outputPath = testInfo.outputPath('browser-console.log')
      await mkdir(testInfo.outputDir, { recursive: true })
      const content = entries.length > 0 ? entries.join('\n') : '[no browser console entries]'
      await writeFile(outputPath, `${content}\n`, 'utf8')
    }
  }, { auto: true }],
})

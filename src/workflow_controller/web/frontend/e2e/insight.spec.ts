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

import { expect, test } from './fixtures'

test('Dashboard renders through the Workflow Controller Web process', async ({ page }) => {
  const response = await page.goto('/', { waitUntil: 'domcontentloaded' })

  expect(response?.status()).toBe(200)
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible()
})

test('Insight page, assets, API and RSC route use the Workflow Controller proxy', async ({ page, request, baseURL }) => {
  const failedInsightRequests: string[] = []
  page.on('response', (response) => {
    if (response.status() >= 400 && (
      response.url().includes('/_next/')
      || response.url().includes('/api/observe/')
      || response.url().includes('/insight/run/')
    )) {
      failedInsightRequests.push(`${response.status()} ${response.url()}`)
    }
  })

  const response = await page.goto('/insight/run/solo:demo', { waitUntil: 'domcontentloaded' })
  expect(response?.status()).toBe(200)
  await expect(page.getByText('Insight Stub')).toBeVisible()
  await expect(page.locator('body')).toHaveAttribute('data-fake-insight-asset', 'loaded')

  const apiResponse = await request.get('/api/observe/data?pageSize=1')
  expect(apiResponse.status()).toBe(200)
  expect(await apiResponse.json()).toMatchObject({ source: 'fake-insight' })

  const rscResponse = await request.get('/run/solo:demo', {
    headers: {
      Referer: `${baseURL}/insight/run/solo:demo`,
      RSC: '1',
      Accept: 'text/x-component',
    },
  })
  expect(rscResponse.status()).toBe(200)
  expect(await rscResponse.text()).toContain('RSC fake insight')

  expect(failedInsightRequests).toEqual([])
})

test('Insight HMR WebSocket is forwarded through the Workflow Controller proxy', async ({ page }) => {
  const websocket = page.waitForEvent('websocket')
  await page.goto('/insight/run/solo:demo', { waitUntil: 'domcontentloaded' })
  const socket = await websocket
  expect(socket.url()).toContain('/_next/webpack-hmr')
  // waitForEvent('websocket') only proves the upgrade reached the proxy; the proxy
  // accepts the browser side before it bridges the upstream, so assert the fake
  // insight's connected frame actually arrives end to end.
  const frame = await socket.waitForEvent('framereceived', { timeout: 10_000 })
  expect(frame.payload.toString()).toContain('connected')
})

test('direct Workflow Controller run and session routes serve the Vue SPA', async ({ request }) => {
  for (const path of ['/run/solo:demo', '/session/legacy-demo']) {
    const response = await request.get(path)
    expect(response.status()).toBe(200)
    expect(await response.text()).toContain('<div id="app"></div>')
  }
})

test('legacy Insight opens its session page when the solo run route is missing', async ({ request, baseURL }) => {
  const response = await request.get('/insight/run/solo%3Alegacy-demo?tab=turns')
  expect(response.status()).toBe(200)
  expect(response.url()).toBe(`${baseURL}/insight/session/legacy-demo?tab=turns`)
  expect(await response.text()).toContain('Insight Stub')

  const rsc = await request.get('/session/legacy-demo', {
    headers: { Referer: response.url(), RSC: '1' },
  })
  expect(rsc.status()).toBe(200)
  expect(await rsc.text()).toContain('RSC fake insight')
})

test('Insight favicon is proxied as SVG instead of the SPA fallback', async ({ request }) => {
  // IN-01（②长尾路径：/icon.svg 与 _next 资产一样必须进入 Insight 反代）
  const response = await request.get('/icon.svg')
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toContain('image/svg+xml')
  const body = await response.text()
  expect(body).toContain('<svg')
  expect(body).toContain('fake insight')
  expect(body).not.toContain('<!doctype html>')
})

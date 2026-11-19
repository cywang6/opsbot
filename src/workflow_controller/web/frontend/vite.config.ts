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

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: '/',
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.WORKFLOW_CONTROLLER_BACKEND_PORT || '18600'}`,
        changeOrigin: false,
      },
      '/insight': {
        target: `http://127.0.0.1:${process.env.WORKFLOW_CONTROLLER_BACKEND_PORT || '18600'}`,
        changeOrigin: false,
        ws: true,
      },
      // insight (Next.js) 的绝对路径请求：HTML 以 src="/_next/..." 引用静态资源，
      // HMR 用 ws://.../_next/webpack-hmr。dev 模式下用户访问 Vite（19601），
      // 不代理就会被 Vite SPA catch-all 截成 index.html，导致 React 不 hydrate。
      '/_next': {
        target: `http://127.0.0.1:${process.env.WORKFLOW_CONTROLLER_BACKEND_PORT || '18600'}`,
        changeOrigin: false,
        ws: true,
      },
      '/icon.svg': {
        target: `http://127.0.0.1:${process.env.WORKFLOW_CONTROLLER_BACKEND_PORT || '18600'}`,
        changeOrigin: false,
      },
      // Next.js RSC 使用无 /insight 前缀的路径，与 Vue 的 Run 和 Session 路由重叠。
      '^/(?:run|session)/': {
        target: `http://127.0.0.1:${process.env.WORKFLOW_CONTROLLER_BACKEND_PORT || '18600'}`,
        changeOrigin: false,
        // 按与 FastAPI 相同的 Referer 判据分流。返回路径字符串交给 Vite SPA fallback。
        bypass: (req) =>
          /^https?:\/\/[^/?#]+\/insight\/(?:run|session)\//.test(req.headers.referer ?? '')
            ? undefined
            : (req.url ?? '/'),
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
})

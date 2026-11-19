# Workflow Controller Web Frontend

Vue 3 + TypeScript + Naive UI SPA for the Workflow Controller Web UI.

## Development
npm run dev          # Start Vite dev server (HMR) — proxies /api to 127.0.0.1:18600
npx vite build       # Build for production
npm run build        # Type-check (vue-tsc -b) then build for production
npm run preview      # Preview production build
npm test              # Run Vitest component/composable tests
npx playwright install chromium  # Install the browser used by E2E
npm run e2e           # Build frontend, start Workflow Controller + fake Insight, run release E2E

## Architecture
- views/ — page-level components (Dashboard, Settings, PluginConfig)
- composables/ — reactive data layer (SSE, sessions, project paths, toast)
- components/common/ — reusable UI components (Toast, DirPicker)
- Plugin tabs are registered via /api/plugins and rendered via plugin-components.ts

## Proxy
Vite dev server proxies /api/* to http://127.0.0.1:18600 (the FastAPI backend).
Run `workflow-controller web` to start the backend.

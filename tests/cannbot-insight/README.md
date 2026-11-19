# cannbot-insight E2E fixture

Deterministic HTTP fake of the cannbot-insight service, used by the Workflow Controller Web E2E
suite (`npm run e2e`, see `src/workflow_controller/web/frontend/README.md`). It serves the
Insight HTML shell, `/_next/*` static assets, Insight data API, RSC requests and an
HMR WebSocket so the proxy chain can be exercised without a real cannbot-insight
installation or external network.

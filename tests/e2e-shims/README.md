# e2e CLI shims

特性矩阵 e2e（`npm run e2e:matrix`）的确定性 CLI 替身，模式与
`tests/cannbot-insight/`（fake Insight）一致：`boot-server.sh` 把本目录
前置到被测 `workflow-controller web` 进程的 `PATH`，所有 `claude` / `cpx` / `opencode`
/ `codex` 子进程都由这里的脚本应答。

角色哨兵、worker 场景表与回合状态（`<cwd>/.workflow-controller-e2e/`）提炼在
`shim_common.py` 共享；各 CLI shim 只各自维护「参数面 + 事件流组装」。
新场景在 `shim_common.py` 落一份，两边同时获得。

- `claude`：按 prompt 哨兵扮演 worker / feedback 评估器 / handoff
  agent / 接续 worker，输出与 `driver/claude_cli.py` 解析层对齐的
  stream-json 事件流（init / assistant / result 三行）。不访问网络、
  不校验模型与密钥。回合计数持久在会话 cwd 的 `.workflow-controller-e2e/` 下。

  worker 场景表（首轮 prompt 携带 `E2E-SCENARIO:<name>`，此后沿 cwd
  state.json 推进；见 `workflow-controller-e2e-testcase-development.md` §6/§8.5）：

  | 场景 | 行为 | 驱动用例 |
  |---|---|---|
  | `pass-first`（默认） | 一轮完成 | E1/L1 基线、MX-04 重放 worker |
  | `review-then-pass` | 首轮 INCOMPLETE、第 2 轮完成 | E2/L2 反馈回路、O2 |
  | `max-iter-never` | 永不完成 | X1/LX1 跑满迭代 |
  | `ask-human` | 首轮问句停等 | X2/LX2 等人分支、DA-03 |
  | `handoff-keep-running` | 每轮 1.5s 慢速 INCOMPLETE | E4/L4 强制交接、MX-11、DA-04 |
  | `handoff-auto` | 每轮上报 900K/1M 高用量读数 | MX-01 阈值自动交接 |
  | `usage-unknown` | 用量字段非法（无有效读数） | SD-08 用量未知分支 |
  | `tool-loop` | tool_use/tool_result 成功对 + 失败对 + 孤立结果 + 普通工具 task_started 的多行流 | MX-12 工具渲染链、普通工具子代理误识别回归、O3 |
  | `graph-write` | `[E2E:WRITE:路径:前缀]` 产物指令，一轮 DONE | E3/L3 回滚 |
  | `graph-slow-write` | 同上协议，前 10 轮每轮 2s 慢速后 DONE | SD-12/RV-02/MX-02/MX-03 长跑道 |
  | `verify-pass` | 独立验收 agent 输出独立行 `PASS` | MX-07 子图与 verifier 成员 |

- `opencode`：MX-08 的 `OpenCodeDriver`（`run --format json`）替身。
  与 `driver/opencode.py` 解析层对齐：每行一个 JSON 对象（`text` /
  `tool_use` / `step_finish` 均带顶层 `sessionID`）；`tool_use` 是
  call+result 合并事件（`state.status=error` 即失败对，无孤立结果
  形态）；`step_finish` 携带原生 tokens 形状
  `{input, output, cache:{write,read}}`（O1 锁 usage 归一链路）。
  另须应答 driver 的两个子命令：`run --help`（`_detect_run_flags` 按
  stdout 分词探测旗标面，须含 `--standalone`/`--auto`/`--session`/
  `--agent`）与 `db path`（DB 定位，应答不存在的 XDG 惯例路径即可）。
  场景表与 claude 共享（`shim_common.py`）；`tool-loop` 在 opencode
  形态下是成功对 + 失败对（小写工具名 bash/read）。handoff/接续哨兵
  后备应答防止误触悬挂，暂无 opencode 跑道用例（E4/MX-01 域）。worker
  回合还会把「本轮是否收到 `--session`」与所用原生会话 id 落进
  state.json 的 `resumed`/`session_id`，供 O2 回读断言 resume 链路真实
  跑过。

- `cpx`：cpx 命令前缀的透传包装，验证「cpx 前缀被拼进 driver 命令」。
- `codex`：C1 的 `CodexCLIDriver`（`codex exec --json`）替身。`debug
  models --bundled` 应答 `gpt-5.5` 内置模型 catalog；`exec` 输出
  `thread.started` / `item.completed(agent_message)` / `turn.completed`
  三段 JSONL，角色哨兵与场景表共享 `shim_common.py`。`exec` 遇
  `--cd <dir>` 时先切换进程 cwd，回合状态因此落在项目目录下，与真实
  Codex 工作目录语义一致。当前只覆盖 `pass-first` 基线，不访问网络、
  不校验模型与密钥。
- `anthropic_mock.py`：本地 Anthropic 兼容端点（POST /v1/messages），
  reviewer 原生 HTTP 路径的替身——PATH shim 拦不到非子进程调用，
  由 boot 脚本起在本机端口并种为假 provider 的 base_url。

shim 协议若与 `driver/claude_cli.py` / `driver/opencode.py` /
`driver/codex_cli.py` 的解析实现
漂移，矩阵用例会在首轮跑测时暴露；两边需同步修改。

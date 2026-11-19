# Copyright (c) 2026 Workflow Controller Contributors
#
# Licensed under the MIT License (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://opensource.org/licenses/MIT
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Web 子命令装配：uvicorn 服务、Vite dev server、Insight 子进程与信号收尾。"""

from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any

import click
import uvicorn
from uvicorn.main import STARTUP_FAILURE
from uvicorn.supervisors import ChangeReload

if TYPE_CHECKING:
    import socket
    from collections.abc import Callable

    from workflow_controller.config.settings import AppConfig


def _load_app_config(config_path: str) -> AppConfig:
    from workflow_controller.config.settings import AppConfig

    p = Path(config_path)
    if p.exists():
        return AppConfig.from_yaml(p)
    return AppConfig()


def _insight_command_cwd(command: str) -> Path | None:
    """返回 Insight 命令的执行目录。"""
    command_path = Path(command).expanduser()
    command_parent = command_path.parent
    if str(command_parent) == ".":
        return None
    if command_parent.name != ".bin":
        return command_parent.resolve()
    package_dir = command_parent.parent / command_path.name
    return package_dir.resolve() if package_dir.is_dir() else command_parent.parent.resolve()


def _find_free_port(start: int, host: str, tries: int = 10) -> int:
    """从 start 起尝试 tries 个端口的可绑探测（全部失败回落 start）。"""
    import socket

    for offset in range(tries):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind((host, start + offset))
                return start + offset
        except OSError:
            continue
    return start


def _port_holders(port: int, host: str) -> list[int]:
    """列出持有指定端口 listening socket 的进程 PID（lsof）。"""
    import shutil
    import subprocess

    lsof = shutil.which("lsof")
    if lsof is None:
        return []
    try:
        out = subprocess.run(
            [lsof, f"-tiTCP:{port}", "-sTCP:LISTEN", "-n", "-P"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return [int(x) for x in out.stdout.split() if x.strip().isdigit()]
    except Exception:
        return []


def _holder_process_lines(holders: list[int]) -> list[str]:
    """占用端口的进程 PID → 命令行描述（ps 失败时空命令）。"""
    import shutil
    import subprocess

    ps = shutil.which("ps")
    lines: list[str] = []
    for pid in holders:
        cmd = ""
        if ps is not None:
            with contextlib.suppress(Exception):
                cmd = subprocess.run(
                    [ps, "-p", str(pid), "-o", "command="],
                    capture_output=True,
                    text=True,
                    timeout=5,
                ).stdout.strip()
        lines.append(f"  PID {pid}  {cmd[:90]}")
    return lines


def _require_free_port(ctx: click.Context, port: int, host: str) -> None:
    """后端端口被占时 fail fast：静默换端口会让 vite proxy（固定指向原端口）
    打到残留的半死旧实例上——前端 SSE 全断、session 打不开，且极难排查。
    TIME_WAIT（旧实例刚死、内核未回收）不算占用：SO_REUSEADDR 可绑即放行。
    """
    import socket

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, port))
    except OSError:
        holders = _port_holders(port, host)
        if not holders:
            # lsof 无 LISTEN 持有者：TIME_WAIT——复用端口是安全的
            return
        click.echo(
            json.dumps(
                {
                    "event": "error",
                    "msg": f"Port {port} is already in use — refusing to start "
                    "(silently picking another port would strand the vite proxy).",
                    "holder_pids": holders,
                }
            )
        )
        if holders:
            click.echo("占用端口的进程：", err=True)
            click.echo("\n".join(_holder_process_lines(holders)), err=True)
            click.echo(
                f"清理后重试：kill -9 {' '.join(str(p) for p in holders)}",
                err=True,
            )
        else:
            click.echo(
                "lsof 未找到持有者（可能是 TIME_WAIT 或权限问题），"
                f"稍等几秒后重试，或手动检查：lsof -i:{port}",
                err=True,
            )
        ctx.exit(1)


def _open_browser_later(url: str, delay: float) -> None:
    """delay 秒后开浏览器（服务起来需要一点时间）。"""
    import threading
    import webbrowser

    threading.Timer(delay, lambda: webbrowser.open(url)).start()


def _start_vite_dev_server(frontend_dir: Path, backend_port: int, host: str, no_open: bool) -> Any:
    """dev 模式起 Vite dev server；npm/前端缺失时告警并返回 None。"""
    import shutil
    import subprocess

    if not (frontend_dir / "package.json").exists() or not shutil.which("npm"):
        click.echo(json.dumps({"event": "warn", "msg": "npm not found, skipping Vite dev server"}))
        return None
    vite_port = _find_free_port(backend_port + 1, host)

    if vite_port:
        click.echo(
            json.dumps({"event": "info", "msg": f"Starting Vite dev server on port {vite_port}"})
        )
        vite_env = {**os.environ, "WORKFLOW_CONTROLLER_BACKEND_PORT": str(backend_port)}
        vite_proc = subprocess.Popen(
            ["npm", "run", "dev", "--", "--port", str(vite_port), "--host", host],
            cwd=frontend_dir,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=vite_env,
            start_new_session=True,  # 自成组长：退出时 killpg 整棵 npm→node 树
        )
        if not no_open:
            _open_browser_later(f"http://{host}:{vite_port}", 2.0)
        return vite_proc
    return None


def _start_insight(insight: str, insight_port: int, no_open: bool) -> Any:
    """启动 Insight 子进程；失败记 JSON error 事件并返回 None。"""
    import subprocess

    click.echo(json.dumps({"event": "info", "msg": f"Starting Insight with {insight}"}))
    try:
        insight_executable = (
            str(Path(insight).expanduser().resolve()) if "/" in insight else insight
        )
        insight_cwd = _insight_command_cwd(insight)
        insight_env = {
            **os.environ,
            "PORT": str(insight_port),
            "BASE_PORT": str(insight_port),
            "CANNBOT_INSIGHT_PORT": str(insight_port),
            # Insight 更名 context-insight 后新版本读取该变量，旧变量仅存量版本使用
            "CONTEXT_INSIGHT_PORT": str(insight_port),
        }
        if no_open:
            insight_env["CANNBOT_NO_BROWSER"] = "1"
        if insight_cwd is not None and insight_cwd.parent.name == "node_modules":
            # npm 可能把依赖提升到共享 node_modules。
            insight_env["NODE_PATH"] = str(insight_cwd.parent)
        insight_proc = subprocess.Popen(
            [insight_executable],
            env=insight_env,
            cwd=insight_cwd,
            start_new_session=True,  # 自成组长：退出时清理整棵进程树
        )
        click.echo(
            json.dumps(
                {
                    "event": "info",
                    "msg": f"Insight started (PID: {insight_proc.pid}, port: {insight_port})",
                }
            )
        )
        os.environ["WORKFLOW_CONTROLLER_INSIGHT_PORT"] = str(insight_port)
        return insight_proc
    except Exception as e:
        click.echo(json.dumps({"event": "error", "msg": f"Failed to start Insight: {e}"}))
        return None


def _kill_children(*procs: Any) -> None:
    """杀掉本进程拉起的子进程树（vite npm→node、insight bash→next 等孙进程）。
    只 terminate() 顶层 Popen 杀不到孙进程（npm 下还有 node vite）。
    用 start_new_session 让每个子进程自成组长，退出时对各自的 pgid
    killpg 一锅端——不杀主进程自己的组（uvicorn worker 还要做 graceful）。
    任何退出路径（正常/信号/强制退出前）都必须调用，否则留孤儿。
    """
    import signal as _signal
    import time as _t

    pgids: set[int] = set()
    for proc in procs:
        if proc is not None and proc.poll() is None:
            with contextlib.suppress(ProcessLookupError, OSError):
                pgids.add(os.getpgid(proc.pid))
    for pgid in pgids:
        with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
            os.killpg(pgid, _signal.SIGTERM)
    if pgids:
        _t.sleep(1.0)
        for pgid in pgids:
            with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
                os.killpg(pgid, _signal.SIGKILL)


def _run_web_server(
    uv_config: uvicorn.Config,
    server: _WorkflowControllerServer,
    kill_children: Callable[[], None],
) -> None:
    """按配置跑 uvicorn（reload / 多 worker / 单进程），退出路径清子进程树。"""
    try:
        if uv_config.should_reload:
            # dev 模式：reloader 父进程装的是 _WorkflowControllerReloader（第二次
            # 信号杀子进程树后硬退，见该类 docstring）；worker 子进程的信号
            # 由 _WorkflowControllerServer.handle_exit 管（已在 server.run 里）。
            _WorkflowControllerReloader.install_forced_exit(kill_children)
            sock = uv_config.bind_socket()
            reloader = _WorkflowControllerReloader(uv_config, target=server.run, sockets=[sock])
            reloader.run()
            if reloader.process.exitcode == STARTUP_FAILURE:
                raise SystemExit(STARTUP_FAILURE)
        elif uv_config.workers > 1:
            sock = uv_config.bind_socket()
            from uvicorn.supervisors import Multiprocess as _Multiprocess

            _Multiprocess(uv_config, target=server.run, sockets=[sock]).run()
        else:
            server.run()
    except KeyboardInterrupt:
        pass
    finally:
        # 正常退出 / _ForcedExit 路径：killpg 覆盖 vite(npm→node) 与
        # insight(bash→next) 的整棵子进程树。SIGKILL 主进程无法走到这里
        # —— 那是唯一留孤儿的路径，启动时的端口 fail fast 报错已给出清理指引。
        kill_children()


def _serve(host: str, backend_port: int, dev: bool, kill_children: Callable[[], None]) -> None:
    """组装 uvicorn 配置并起服务（dev=reload 模式）。"""
    config_kwargs: dict[str, Any] = dict(
        host=host,
        port=backend_port,
        factory=True,
        timeout_graceful_shutdown=3,
    )
    if dev:
        config_kwargs["reload"] = True
        # reload 监听范围保持整包（本模块住 web/ 下，向上取包根）
        config_kwargs["reload_dirs"] = [str(Path(__file__).resolve().parent.parent)]
        config_kwargs["reload_excludes"] = [".workflow-controller/*", "*.pyc", "__pycache__/*"]

    uv_config = uvicorn.Config("workflow_controller.web.app:create_app", **config_kwargs)
    server = _WorkflowControllerServer(uv_config)
    _run_web_server(uv_config, server, kill_children)


class _WorkflowControllerServer(uvicorn.Server):
    """重写 handle_exit：第二次 SIGINT/SIGTERM 杀子进程树后 _ForcedExit 硬退。

    必须在模块顶层定义——dev 模式下 reloader 用 multiprocessing spawn 起
    worker 子进程，会把 ``server.run`` bound method pickle 过去；局部类
    （函数内定义）无法按限定名导入，pickling 失败，reload 子进程起不来。

    uvicorn.Server.capture_signals() 在 serve() 期间用 ``signal.signal`` 把
    ``self.handle_exit`` 装成 SIGINT/SIGTERM handler，覆盖启动前注册的任何
    handler。所以「第二次 Ctrl+C → _ForcedExit 硬退」必须落在 handle_exit 里，而不是
    靠提前 signal.signal() 安装。

    ``_kill_callback`` 是类级槽位：父进程（run_web_command）启动前经
    install_forced_exit 注入杀 vite/insight 子进程树的回调；spawn 出的 worker
    子进程 re-import 模块时是 None——子进程不拥有这些孙进程，无需也不应杀。
    """

    _sig_count = 0
    _kill_callback: Callable[[], None] | None = None

    @classmethod
    def install_forced_exit(cls, kill_children: Callable[[], None]) -> None:
        """注入强制退出回调并清零信号计数（起服务前调用）。"""
        cls._sig_count = 0
        cls._kill_callback = kill_children

    def handle_exit(self, sig: int, frame: Any) -> None:  # type: ignore[override]
        self._sig_count += 1
        if self._sig_count >= 2:
            # 第二次信号：清理子进程后立即退出，不等任何 graceful。
            # _ForcedExit 属 BaseException：清理路径上的 except Exception 吞不掉它
            kill = type(self)._kill_callback
            if kill is not None:
                kill()
            raise _ForcedExit(1)
        # 第一次：走 uvicorn 原生 should_exit（触发 graceful shutdown，
        # timeout_graceful_shutdown 到点后 finally 再 _kill_children）
        super().handle_exit(sig, frame)

    def run(self, sockets: list[socket.socket] | None = None) -> None:
        super().run(sockets=sockets)
        if not self.started and self.should_exit:
            raise SystemExit(STARTUP_FAILURE)


class _WorkflowControllerReloader(ChangeReload):
    """dev 模式 reloader：第二次 SIGINT/SIGTERM 杀子进程树后硬退。

    reloader 父进程装的是本类的 signal_handler（覆盖 ChangeReload 继承自
    BaseReload 的默认实现）。槽位机制与 _WorkflowControllerServer 相同：
    父进程起服务前经 install_forced_exit 注入清理回调并重置计数（kill
    回调来自 run_web_command 的闭包，模块级类无法靠闭包捕获）。
    """

    _sig_count = 0
    _kill_callback: Callable[[], None] | None = None

    @classmethod
    def install_forced_exit(cls, kill_children: Callable[[], None]) -> None:
        """注册强制退出回调并重置信号计数（每次起服务前调用）。"""
        cls._sig_count = 0
        cls._kill_callback = kill_children

    def should_restart(self) -> list[Path] | None:
        if self.process.exitcode == STARTUP_FAILURE:
            raise StopIteration
        changes = super().should_restart()
        if self.process.exitcode == STARTUP_FAILURE:
            raise StopIteration
        return changes

    def signal_handler(self, sig: int, frame: Any) -> None:
        self._sig_count += 1
        if self._sig_count >= 2:
            kill = type(self)._kill_callback
            if kill is not None:
                kill()
            raise _ForcedExit(1)
        super().signal_handler(sig, frame)


class _ForcedExit(BaseException):
    """不被 except Exception 吞掉的强制退出信号。"""


def run_web_command(
    ctx: click.Context,
    port: int,
    host: str,
    no_open: bool,
    dev: bool,
    insight: str | None,
    insight_port: int,
    settings_dir: str | None,
    log_level: str | None,
) -> None:
    """Web 子命令执行体：日志、子进程拉起与服务装配（由内核 CLI 懒装配调用）。

    ``insight`` 传入 ``"default"`` 表示未指定命令路径，回落默认命令名。
    """
    from workflow_controller.logging_config import configure_logging

    if log_level is None:
        log_level = _load_app_config("workflow-controller-config.yaml").log_level

    log_path = configure_logging(Path.cwd(), level=log_level)
    click.echo(json.dumps({"event": "info", "msg": f"Logging to {log_path}"}))

    # 通知 lifespan 使用 CLI 指定的日志级别（reload 子进程通过 env 继承）
    os.environ["WORKFLOW_CONTROLLER_LOG_LEVEL"] = log_level
    # settings 目录同样经 env 穿透到 lifespan 的 core_api.boot（--dev 的
    # reload 子进程重新 import 时模块状态不可靠）。
    if settings_dir:
        os.environ["WORKFLOW_CONTROLLER_SETTINGS_DIR"] = str(
            Path(settings_dir).expanduser().resolve()
        )

    backend_port = port
    if dev:
        _require_free_port(ctx, port, host)

    vite_proc = None
    if dev:
        frontend_dir = Path(__file__).resolve().parent / "frontend"
        vite_proc = _start_vite_dev_server(frontend_dir, backend_port, host, no_open)

    if not no_open and vite_proc is None:
        _open_browser_later(f"http://{host}:{backend_port}", 1.0)

    insight_proc = None
    if insight:
        insight_command = "cannbot-insight" if insight == "default" else insight
        insight_proc = _start_insight(insight_command, insight_port, no_open)

    def _kill_all() -> None:
        _kill_children(vite_proc, insight_proc)

    # 把强制退出逻辑注入 uvicorn 实际安装的信号 handler（见 _WorkflowControllerServer /
    # _WorkflowControllerReloader 的 docstring：不能靠提前 signal.signal()，会被 uvicorn
    # 的 capture_signals / BaseReload.startup 覆盖）。
    _WorkflowControllerServer.install_forced_exit(_kill_all)

    try:
        _serve(host, backend_port, dev, _kill_all)
    except _ForcedExit as exc:
        # 信号 handler 只在 serve 期间安装；此处换成普通退出码交给 CLI 进程
        raise SystemExit(int(exc.args[0]) if exc.args else 1) from None

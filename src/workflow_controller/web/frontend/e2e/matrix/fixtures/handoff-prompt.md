# E2E handoff agent 指令（测试模板）

你是 e2e 测试的 handoff agent。请为 worker session `{worker_session_id}` 产出交接文档 `{handoff_filename}`。

要求：

1. 文档包含：项目坐标、当前进度、核心发现、关键决策、踩过的坑、下一步建议。
2. 写入当前工作目录下的 `{handoff_filename}`。
3. 写完后创建完成信号文件（文件名把文档名的 `-doc` 后缀换成 `-done`）。

按指令执行即可，不需要读取其他文件。

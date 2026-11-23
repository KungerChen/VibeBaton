# VibeBaton 发布施工日志

前序施工记录及索引见 [历史施工日志](.baton/LOG.md)。本文件的条目见 [发布日志索引](LOG-INDEX.md)。

## L0001 2026-11-22 Stage 4.8 (v1.0.4) 发布集成

2026-11-23 PST。M3-T5 授权整合发布元数据、双语文案和案例导出契约验证。起始工作树干净，分支为 `baton/fc2591/m3-t5`，回退基准为 `2f56649`。已自测，待用户验收。

- 四处版本同步为 `1.0.4`。README 补充案例导出入口，CHANGELOG 补充 beta 过渡说明和 v1.0.4 发布内容。
- 英文传输文案的 ASCII 检查捕获了 `60×` 带来的冲突。示范标签归入播放器文案，回放按钮与切换器共用双语标签。导入提示指向实际入口。
- TypeScript 直接校验 Python Golden Case fixture。真实运行测试用 SQLite 只读备份导出最新运行并校验脱敏报告和图结构。当前工作树缺少本地数据库时，该测试给出明确跳过原因。
- 沙箱拒绝 Vite 向共享依赖目录写入缓存。在工作树内的临时副本使用现有依赖并逐文件核对输入后，指定全栈命令退出 0。Vitest 通过 43 个文件、533 项测试，含双语检查和跨语言 Golden Case 契约。`tsc --noEmit` 和生产构建通过，Vite 报告分块体积警告。
- Python unittest 运行 532 项，529 项通过。两项因缺少 Docker CLI 跳过，一项因 Windows 目录符号链接权限跳过。回环 HTTP 的 Studio 和案例导出集成测试通过。CLI 输出 `vibebaton 1.0.4`，`export-case --help` 退出 0。
- 从主工作树数据库的隔离快照导出最新运行。CLI 报告 `clean: yes`，Python 图校验和 TypeScript 导入均通过。实际导入组件显示脱敏校验通过，回放状态与播放器渲染核对了 20 个节点及全部 206 步。
- 内置浏览器需要审批，当前会话的审批策略为禁用。独立 Chrome 与 Edge 在 GPU 初始化时退出。浏览器验收时可将导出的 `.baton-case.json` 通过 **Import Recipe or Case** 加载，确认案例标题显示在 **Start** 按钮，单步推进会更新画布和事件文案。
- 验证输出位于 `%TEMP%` 下的 `vibebaton-m3-t5-8c7f00d8-frontend.log`、`vibebaton-m3-t5-8c7f00d8-backend.log` 和 `vibebaton-m3-t5-8c7f00d8-replay.log`。

## 20261123-041153-m3-case-copy-audit

2026-11-23 04:11:53 PST 开始处理 M3 复审的案例复制阻塞。分支为 `baton/fc2591/ms-m3-r1`，起始工作树干净，基准提交为 `4153034`。

- 修复前用 Golden Case 复现两种审计失败。服务端报告 `clean: false` 或客户端检出残留邮箱时，复制按钮仍可用，处理函数仍调用剪贴板写入。
- `ExportCaseModal` 将复制按钮和剪贴板写入绑定到下载、预览共用的 `cleanBundle`。回归测试覆盖两种审计失败和审计通过的导出。教程同步列出三项门禁。
- Vite 在当前沙箱向共享依赖目录写入配置缓存时得到 `EPERM`。用 SHA-256 核对隔离副本的 160 个输入文件后，指定前端命令退出 0。43 个测试文件、536 项测试、类型检查和生产构建均通过。Vite 报告分块体积警告。
- Python 全量门禁退出 0。532 项中通过 528 项，4 项因环境跳过。两项缺少 Docker CLI，一项缺少 Windows 目录符号链接权限，一项缺少本工作树的 `.baton/state.sqlite`。回环 HTTP 测试验证了本次构建的 Studio 资源与 API。
- CLI 返回 `vibebaton 1.0.4`，`export-case --help` 退出 0。案例导出 API、发布资料和版本一致性专项通过 16 项。
- 弹窗专项在基准实现上有两项预期失败，修复后 11 项均通过。内置浏览器连接因会话审批策略被拒，Chrome 和 Edge 无头模式在渲染前退出。浏览器人工验收待完成。
- 验证输出位于 `%TEMP%\vibebaton-m3-case-copy-6f26ac1d`，包含 `regression-before.log`、`regression-after.log`、`frontend.log`、`backend.log`、`cli.log` 和 `release.log`。
- 已清理本轮的隔离副本、临时构建资源与浏览器配置。状态为已自测，待用户验收。回退参考为 `4153034` 与本次差异。

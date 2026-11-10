# Windows Codex 开发接手说明

交接日期为 2026-11-11，用户决定由 Windows 端 Codex 接续。本机目标已由用户清除，自动化 ai-im-30 在应用中核对为不存在。后续开发由接收端根据用户指令开展。本文件描述源码快照，实际归档 revision 与文件摘要见 GitHub Release 附件。

## 开始阅读

依次阅读根目录 [AGENTS.md](../AGENTS.md)、[PRD](PRD.md)、[扩展基线](PHASE2-BASELINE.md)、[结构化规则](phase2-baseline.json)、[冻结包规则](handoff-v1/AGENTS.md)及[冻结三层定义入口](handoff-v1/AI-IM基线/README.md)。然后阅读 [实现进度](IMPLEMENTATION.md)、[Office](OFFICE.md)、[OCR](OCR.md)、[日历](CALENDAR.md)和[审批](APPROVALS.md)。

## Git 与当前阶段

公库为 https://github.com/MkaliezZ/hyper-workspace-next，接收分支为 main。本地原开发分支名为 codex/calendar-phase2，推送目标一直为 origin/main。此次交接会把原先仅在本机的 83574a8 一并推送，该提交包含 Office 来源版本核对和内网安装配置。代码基于首阶段 61082e0 派生，原始冻结内容在 docs/handoff-v1 中。

| 模块 | 当前实现 | 接手后核对 |
| --- | --- | --- |
| 日历 | 忙闲、候选预约、重复及例外、邀请/回复、私人项目/待办关联、双执行器 | CALENDAR.md 与 README 记录的会议系列和例外回复缺项，真实来源回归 |
| 审批 | 版本化流程与表单、条件、串行/并行会签、退回重提/撤回/转交/催办、审计和双执行器 | 完整回归、真实员工规则与企业验收 |
| OCR | 选页、原件核对、坐标/表格校对、确认/私人检索、撤权清理、CPU 服务与双执行器 | 更多真实版式、目标机容量、整体验收 |
| Office/复杂表格 | 有权限与版本约束的 DOCX/XLSX/PPTX 打开入口、来源版本变化检查、固定编辑器和安装配置 | 编辑器加载失败、真实多人编辑与保存、格式往返、复杂表格、双执行器 OfficeTools |

## 已知 CI 问题与证据

最近已完成的公共流水线对应 10e721ced54533bb35f88f63881247f0c7077bcc。[运行 42867835740](https://github.com/MkaliezZ/hyper-workspace-next/actions/runs/42867835740) 的 verify 和 deployment 两个 job 通过，nextcloud-identity 的最后一项“Verify the real Nextcloud Office editor”失败。失败前的真实来源用例已走完，Office 这一步仍不能列为通过。

失败在 tests/nextcloud/office.spec.ts 的文档加载断言。等待 html 上的 data-hyper-office-loaded 属性为 yes，60 秒超时。该属性由测试监听 Collabora 的 App_LoadingStatus / Document_Loaded 消息设置。需要核对页面是否实际加载、消息所在 frame、event.origin、回调地址、WOPI 授权及 WebSocket。现有证据还不能确定是编辑器问题还是测试观测问题。保留断言语义，先诊断再修复。

83574a8 比这次运行更新，包含本机通过的 Office 版本核对、签名连接器准备与隔离 TLS 代理检查，还没有该提交的完整 CI 通过证据。当前交接提交的最新 Actions 应以 GitHub 上对应 head SHA 的状态为准。

本机最后完成的相关检查包括类型检查/构建、Office 和 OCR 的 5 项数据库集成、桌面/手机入口及撤权浏览器流程、7 项临时 CA/TLS/代理检查、固定连接器摘要校验、首阶段冻结包校验。原始临时运行日志位于被忽略的 .runtime，公开交接保留此摘要和可重跑测试，其他历史证据在各模块说明中。

Windows 接收端后续已定位设置预设的绝对 URL 被公共地址覆盖，引起 Collabora `docunloading` 循环，并修复加载探针被无关 iframe 导航打断的竞态。三格式 WSL 真实加载已通过，新的完整 CI 与后续保存协作结果见 [Office 当前记录](OFFICE.md)。部署时须采用新增受限设置片段及显式 TLS 校验配置，原交接失败记录保留为历史证据。

## Windows 环境与获取源码

建议使用 WSL2 Ubuntu，在 Linux 文件系统中放置仓库，例如 ~/src/hyper-workspace-next。Docker Desktop 使用 Linux containers 并启用对应 WSL 集成。Linux 容器、shell 脚本及 Python 虚拟环境路径是目前主要验证路径。

在 WSL shell 执行：

```sh
mkdir -p ~/src
cd ~/src
git -c core.autocrlf=false clone https://github.com/MkaliezZ/hyper-workspace-next.git
cd hyper-workspace-next
git switch main
git pull --ff-only
git switch -c codex/windows-office
```

保持源码 LF 换行和冻结包字节校验，首次 clone 显式关闭自动 CRLF 转换。

Windows 接收端已加入 `.gitattributes`：普通源码统一 LF，冻结包保持 Git 原始字节。已有 clone 如受全局自动 CRLF 设置影响，先保留工作区修改，再恢复冻结包的原始字节并运行校验，不修改摘要清单来接受换行差异。本机 Windows 原生类型检查通过，但 POSIX 文件权限及可执行脚本用例不兼容；完整开发验证继续在 WSL 中运行。

要固定到交接版本，先从 Release 记录取得 tag，再执行 git checkout -b codex/windows-office TAG。GitHub 归档没有 .git 时，建议用 clone 接续提交。

准备 Node 24.14.1、npm、Git、Python 3.14.6、Docker Engine/Compose/Buildx。Hermes 要求 Python 3.14.6，文档解析器和连接器准备工具使用 Python 3.12+。具体固定依赖由 package-lock、runtime/hermes/lock.json、runtime/documents/requirements.lock、runtime/nextcloud/office.lock.json 等文件定义。

### 本地开发最小启动

下列数据库密码只用于本机回环开发。执行前检查同名容器、卷及 5432 端口，已有环境使用原有配置。

```sh
docker run -d --name hyper-dev-db \
  -e POSTGRES_USER=hyper -e POSTGRES_PASSWORD=hyper-local -e POSTGRES_DB=hyper \
  -p 127.0.0.1:5432:5432 -v hyper-dev-db-data:/var/lib/postgresql/data \
  pgvector/pgvector:pg17@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d
npm ci
cp .env.example .env
node --input-type=module -e 'import fs from "node:fs"; import crypto from "node:crypto"; const p=".env"; const s=fs.readFileSync(p,"utf8").replace(/^CREDENTIAL_MASTER_KEY=$/m,"CREDENTIAL_MASTER_KEY="+crypto.randomBytes(32).toString("hex")).replace(/^DEMO_MODE=false$/m,"DEMO_MODE=true"); fs.writeFileSync(p,s,{mode:0o600});'
npm run migrate
npm run seed
npm run dev
```

浏览器访问 http://127.0.0.1:5173。演示模式用于本机 UI，企业来源流程需要按 .env.example 配置独立 Nextcloud 和企业成员身份。API Key 在产品设置页配置。

需要原生执行器和文档解析时，在另一终端停止开发服务后准备依赖，再重启：

```sh
npm ci --prefix runtime/dsh
python3 runtime/hermes/install.py
python3 -m venv .runtime/documents
.runtime/documents/bin/python -m pip install --require-hashes -r runtime/documents/requirements.lock
npx playwright install --with-deps chromium
```

全部命令在 WSL 中运行。Python 3.14.6 的安装器与解释器版本先核对。OCR CPU 容器通过 deploy/compose.local-ocr.yaml 启用，Office 用 deploy/compose.office.yaml，具体组合及受限私有配置见模块文档。

### 验证入口

```sh
npm run verify
python3 docs/handoff-v1/verify_package.py
docker exec hyper-dev-db createdb -U hyper hyper_test
TEST_DATABASE_URL=postgres://hyper:hyper-local@127.0.0.1:5432/hyper_test npm run test:integration
```

完整原生执行器、浏览器、真实 Nextcloud 和容器回归按 .github/workflows/ci.yml 重跑。部分恢复测试需要本机 PostgreSQL 工具，按测试所需设置 TEST_PG_BIN_DIR。Linux CI 的通过记录不表示已在 Windows 原生环境运行全部命令。

## 下一步开发顺序

1. 拉取交接版本，确认工作区和当前 head，核对全部 Actions。先处理 Office 文档加载失败，验证三种格式在真实编辑器打开。
2. 完成同一编辑器的两名员工协作、撤权、评论/修订、保存后回读、冲突和恢复，验证 DOCX/XLSX/PPTX 往返。
3. 验证公式重算、跨表引用、筛选、验证、透视与图表。保留原文件特性，逐项列出兼容缺口。
4. 为人工和 DSH/Hermes 实现相同 OfficeTools，包含可检查提案、当前权限/版本校验、实际执行回执和可修改成果，再做真实模型业务验证。
5. 回看 PRD、日历与审批剩余缺项及 E01–E10，补齐跨功能验收。公司服务器就绪后再执行实际内网安装与签收。

## 凭据与本机专有内容

源码包包含代码、迁移、依赖锁、PRD、说明和合成测试素材。运行时依赖、模型权重、构建产物、数据库和会话需要在新端重新准备。源站数据、服务器登录信息、API Key、.env 和 .runtime 不进入公开包。公司目标机/IP 仍待准备，临时云端信息按用户现有受限交接包管理。

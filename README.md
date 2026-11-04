# Hyper Workspace


> **扩展阶段开发仓库：hyper-workspace-next。** 由首阶段 `61082e0` 派生，按日历排期 → 复杂审批 → 图片 OCR → 复杂表格与 Office 协作推进。日历现有来源读写、周视图、人工建改删除和持久回执，已接人工与双执行器操作，仍在补邀请/排期/重复编辑/项目关联；不声称日历或完整扩展已交付。规则见 [扩展基线 v2.0](docs/PHASE2-BASELINE.md)，实际状态及失败修复见 [日历进展](docs/CALENDAR.md)。旧仓库 CI 只证明对应历史版本。

## 日历开发进展

当前人工界面可选择获准日历、浏览 7 天、创建单次/全天日程、改标题/说明/地点、调整单次时间及删除整个系列；保留版本条件、停止请求、未知结果核对和本人历史。Nextcloud 连接完成后设置 `NEXTCLOUD_CALENDAR_ENABLED=true` 并重启 API；默认关闭。日历界面可选择人工 / DSH / Hermes 与个人或工作区 chat 连接；AI 使用同一业务服务，支持核对选定窗口和执行已确认的建改删计划，私人 Run 不进入项目讨论。原始重复规则/例外保留，新建重复、邀请、完整时区编辑、忙闲排期及自然语言排期草案仍在开发。

本批本地 267 项数据库/HTTP、87 单元、3 项日历 UI（桌面/手机、未知回执、双执行器入口）、类型及构建通过。原生 DSH/Hermes 各完成写入、读取与拒绝模型篡改目标，共6次协议模型请求；只有2次有效来源写入。协议模型不代表真实供应商质量验收。`3a36c16` 的 [CI 41727288615](https://github.com/MkaliezZ/hyper-workspace-next/actions/runs/41727288615) 常规/容器通过，真实来源18过/1日历UI选择器失败，正在实际来源复现；数字XML实体修复后的来源展开已通过，失败未覆盖为成功。当前新增代码须以自己的CI为准。

![日历桌面界面，合成协议资料](docs/images/calendar-desktop.png)

[手机界面截图](docs/images/calendar-mobile.png) · [AI 入口桌面](docs/images/calendar-ai-desktop.png) · [AI 入口手机](docs/images/calendar-ai-mobile.png) · [行为、API、迁移与尚未完成项](docs/CALENDAR.md)

[![CI](https://github.com/MkaliezZ/hyper-workspace-next/actions/workflows/ci.yml/badge.svg)](https://github.com/MkaliezZ/hyper-workspace-next/actions/workflows/ci.yml)

面向企业内部的 AI 协作 IM：讨论有沉淀，行动有回执，成果能修改，经验能复用。蓝、白、黑配色；拥有自己的业务核心与企业资产服务。

**首阶段可安装源码与部署指南已齐，公司局域网服务器待准备。** 当前已实现聊天/项目、任务/成果、来源文档、模型配置、向量检索、方法复用、权限与执行恢复。阿里杭州私有试用中，真实 Nextcloud + DeepSeek + 双原生执行器已完成22次成功Run，3次失败保留并核对；仅使用合成资料。公司服务器尚未安装，不据此声称生产上线。Calendar、复杂办公/媒体按冻结基线后续阶段补齐。

实现 `5b7d0bb8490b45d2c69939b35d8ac6173d3d599f` 的 [CI 41696471949](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41696471949) 三个任务全部成功，逐份完成日志核对453项：65单元、9 Python、8解析、255数据库、9原生、78 UI、18真实来源、7容器、4 IP TLS/代理；78 UI无重试，来源18项用时13.5分钟。真实来源新增本人历史元数据与来源撤权404，容器包括043迁移及配套产品恢复。协议模型与真实供应商结果仍分别记录。 [软件交付入口](docs/DELIVERY.md) · [交付核对](docs/DELIVERY-CHECKLIST.md#当前交付状态) · [云端联合记录](docs/CLOUD-TRIAL-ACCEPTANCE.md) · [公司内网安装](docs/DEPLOYMENT-INTRANET.md)。

跟进提醒新增工作区/项目/本人三层规则：全部变化、仅重要变化、静默和最短合并间隔；静默检查保留公共待通知变化，其他符合条件的同事仍可合并发布。人工、DSH/Hermes 共用版本与权限服务；个人配置不广播到项目。提醒模块 `1c67e314108247646c35ff0fd9ef3f5d12ce0000` 的 [CI 41301871596](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41301871596) 三项全部成功，共 372 项通过，含本人原任务找回、70 UI、14 真实来源及 4 容器场景。真实 DeepSeek 的 DSH 配置/Hermes 私有回读各一次成功，来源为合成服务、0 次来源写入；整体尚未交付。[功能、API、恢复与验证边界](docs/NOTIFICATION-POLICY.md)。 [桌面](docs/images/notification-policy-desktop.png) · [手机](docs/images/notification-policy-mobile.png)。

新增可运行的数据库备份、签名校验与随机新库恢复检查：保留产品资产/向量/密文/回执，隔离未完成 Run、暂停定时任务并清理旧登录。原库不覆盖，恢复库不自动投入生产。提交 `9c062efa` 的 [CI 41321121462](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41321121462) 三项全部成功，383 项通过，包含真实 Compose 备份/新库恢复验证。[命令、范围与验收边界](docs/BACKUP-RESTORE.md)。2026-11-02 又对现用 042 开发库实做新库恢复：归档校验及 58 条活动密文检查通过，原库未切换。

2026-11-01 真实 DeepSeek 双执行器业务小样例：14 次实际请求完成纪要、结构化日期、4 次明确员工 ID 指派、同成果往返续改，以及静默解除后仅一条合并提醒；来源为合成 HTTP 服务，0 来源写入。首轮日期字段丢失已修复，首轮失败和 1 条不完整用量保留，费用仍未定价。实现 `0a63287` 的 [CI 41323891692](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41323891692) 三项全部成功，共 386 项通过（含 8 原生、70 UI、14 真实来源和 5 容器）；未完成公司或人工量规验收。[可复查报告、输出原文与复用脚本](docs/REAL-BUSINESS-ACCEPTANCE.md)。

企业预算已接入当前开发批次：管理员企业计价与个人账目分开，工作区/项目额度跨连接统一准入，模型不能用个人零单价或私有声明绕过公司额度；向量、验证和原生任务共用闸门。实现 `a0a5c52` 的 [CI 41353513303](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41353513303) 三项全部成功，406 项通过（245 数据库、9 原生、72 UI、15 真实来源、6 容器及其余 59 项）；不代表真实账单或完整公司交付。[权限、金额、恢复和验证边界](docs/ORGANIZATION-BUDGETS.md)。[桌面](docs/images/organization-budget-desktop.png) · [手机](docs/images/organization-budget-mobile.png)。

真实方法质量反馈已收到：用户确认候选与复用草稿符合该项质量要求；相关修正和结算竞态的 [CI 41422563963](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41422563963) 三项全部成功。本机开源 embedding 已安装为登录服务，并保存、实际验证“本机中文向量”连接，无外部按次费用；文档按 400 字符容量完整分块。固定检索题 Top1 7/8、Recall@3 8/8，另通过 2574 字符长文末尾检索。容量/常驻实现 cbbf8b6 的 [CI 41426430075](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41426430075) 三项全部成功，共 418 检查；来源项首次拉镜像 502，重试后 15 个真实来源用例通过。不代表整体验收。[本机部署与限制](docs/LOCAL-EMBEDDING.md) · [方法输出](docs/REAL-METHODS-ACCEPTANCE.md) · [检索证据](docs/SEMANTIC-QUALITY.md)。

历史消息搜索新增：企业消息可直接查询来源历史并分页、回到原消息，也可交给 DSH/Hermes 以相同范围执行；编辑/删除/过期、来源变更和员工失权会过滤或拒绝旧内容。实现 527c985 的 [CI 41430371512](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41430371512) 三项全部成功，共 425 检查（含 252 DB、74 UI、9 原生、16 真实来源、6 容器）；使用合成账号/资料与协议模型，仍非公司正式验收。[搜索契约与范围](docs/MESSAGE-SEARCH.md)。

正式部署采用公司局域网 Linux 服务器和固定内网 IP，无需外部域名，通过内部 CA / IP SAN 提供 HTTPS。用户已确认目标机“待准备”；阿里杭州仅经私有 SSH 隧道做技术验收。配套[来源/产品备份与独立恢复](docs/SOURCE-BACKUP-RESTORE.md)已完成，实际公司安装、证书信任和切流仍须在目标机核验。

## 实际界面

执行详情提供实际回执和默认折叠过程记录；新增项目“执行记录”找回本人的历史 Run，刷新后仍能打开，读取前后重新鉴权。已补齐真实工具的操作名称和方法状态；慢来源刷新防止请求重叠。[功能、验证与人工评阅材料](docs/RUN-DETAILS.md) · [桌面截图](docs/images/run-details-desktop.png) · [手机展开截图](docs/images/run-details-mobile.png)。原详情入口完整 CI 449 项通过；用户确认清晰度、日志按需展开和失败说明三项材料。新增历史入口、043 索引和完整工具名称已通过本地 255 DB/3 UI/65 单元及类型/构建，历史入口与043索引的完整CI453项通过；私有云候选环境也通过真实重新登录后的历史回执/手机展开复验，0次新模型或业务写入。[真实截图](docs/images/cloud-run-history-desktop.png)。

下图为本地运行截图，使用明确标记的演示资料和真实 PostgreSQL 持久化。演示执行不调用真实模型。

![Hyper Workspace 桌面界面](docs/images/workspace-desktop.png)

[查看移动端截图](docs/images/workspace-mobile.png) · [设计参考与核对记录](docs/design/DESIGN.md)

导航、项目及标签切换采用约 180ms 淡入和轻微上移；不会因后台刷新反复播放，开启系统“减少动态效果”时关闭。 2026-11-04 浏览器只读核对实际观察到180ms淡入/6px位移动画，系统减少动效模式下主面板动画为0；未调用模型或写业务。

## 技术架构

[云端联合验收记录](docs/CLOUD-TRIAL-ACCEPTANCE.md)：两员工真实登录、四种办公文件解析、双引擎纪要/真实员工分配/往返修订/周报、静默与合并提醒、语义检索/私人解读、方法提炼/跨引擎复用/撤回均有实际回执。25 次 Run 中 22 成功、3 失败；28 条请求中 1 条用量未知，其余有报告，费用未定价。产品在途恢复与来源完整恢复分别保留证据，不代表公司采用。

正式交付采用[公司内网 IP + 内部 CA](docs/DEPLOYMENT-INTRANET.md)，无需购买域名或开放公网；阿里杭州仅作临时技术验收。提供 Nginx 与来源地址叠加模板，公司环境尚待实证。

新增[独立 Nextcloud 与 CPU 向量服务的私有试用部署](docs/DEPLOYMENT-PRIVATE-TRIAL.md)：来源与产品分库分角色，公开模型按摘要白名单构建，受限 Worker 并发为 1。实现 `9be68e5` 的 [完整 CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41562711322) 三项全部成功，共 438 项，包含新增来源隔离、重复初始化与拒绝改密。Linux 向量容器另实测 512 维及 8×400 字符批处理通过；观察峰值约 379 MiB，试用上限调为 512 MiB。阿里杭州的数据库、API、Worker、Nextcloud 和 CPU 向量服务均已启动并健康；冷登录并发修正 `2219311` 的 [CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41572928983) 三项成功，共 439 项；云端联合业务已续验通过，初次 WAN 冷加载性能与公司整机容量不能由这些业务样例推断；详见当前联合记录。

云端 Hermes 安装工具下载超时已保留诊断；新增固定来源及其 PM 工具归档的可验证构建缓存，9 项 Python 下载/缓存保护测试通过。仍由上游 PM 复核并安装，缓存路径已通过 Linux 容器 CI，云端最终镜像已构建并核对 VCS 标签，真实业务联合验收继续推进。[准备命令与边界](runtime/hermes/build-context/README.md)。

- React + TypeScript + Vite：聊天、项目上下文、任务、成果和设置。
- NestJS 模块化业务核心 + 独立执行 Worker。
- PostgreSQL + pgvector：业务状态、资产目录、关系和语义索引。
- pg-boss：后台分发；业务动作另做幂等、回执和对账。
- DSH 默认执行器、Hermes 兼容执行器，统一 EngineAdapter。
- Nextcloud 通过身份、通信、文件和日历 Provider 接入。

企业资料与产品状态独立于执行器；引擎切换保持业务接口稳定，不承诺私有检查点热迁移。

人工添加与 AI 生成待办共用产品业务服务；人工/AI 修改单条待办也共用带版本校验的服务，可改标题、负责人文字标记、日期和状态，保留历史并支持人工接管。创建时的负责人文字仍是标记；可从“修改待办 → 按真实员工身份分配”明确选择当前项目成员，人工或 AI 绑定员工 ID，改派与历史均保留。状态变更不代表实际工作验收。[待办修改与版本契约](docs/TASK-REVISIONS.md)。实现 `9376aa9` 的 [CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40974156265) 三个 job 成功，165 项首轮通过，包含双执行器、真实 Nextcloud 权限、界面和容器重启；使用合成测试资料与协议模型。

## 方法与模板

“知识库 → 方法与模板”支持从已保存成果整理 SOP、模板、案例、量规和术语。人工与 AI 共用服务：先保存候选，由员工确认验证依据后发布；支持版本修订、撤回，以及在纪要、周报和成果修改中复用确切版本。AI 不能自行验证、发布为公司规则或改变员工确认的操作。工作区级发布需要管理员；企业会话来源的方法仍限来源项目。

最终实现 `3015eaa` 的 [完整 CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41001696525) 三个 job 成功、178 项首轮通过，含 37 界面、双执行器、真实来源权限与受限容器重启/撤回；输入隔离和失权后的迟到响应清理也已覆盖；没有真实模型或公司验收结论。[方法资产、权限、回执与迁移](docs/METHODS.md) · [实际桌面界面](docs/images/methods-desktop.png) · [手机界面](docs/images/methods-mobile.png)。

## 执行规则

“设置 → 执行规则”支持工作区、项目和个人限制；发起任务时可以进一步收紧单次限制。允许执行器/工作类型取交集，支持上下文字节、输出 token、时间、业务动作和每日执行次数上限。人工保存与 AI 按已确认方案代保存共用服务，保留版本、回执和运行快照；模型不能自行改权限。

每日次数是获准执行的 Run 数，尚不是供应商调用数、token 用量或费用账单。[规则契约、额度口径与迁移](docs/EXECUTION-POLICY.md) · [桌面界面](docs/images/execution-policy-desktop.png) · [手机界面](docs/images/execution-policy-mobile.png)。执行规则实现 `8463fb1` 的 [CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41029145378) 三个 job 全部成功、188 项首轮通过（含 104 数据库、38 UI、双引擎、真实来源和容器）。

## 模型用量

“设置 → 模型用量”记录本人实际发起的模型 HTTP 请求和供应商返回的输入/输出 token，包含两套执行器、连接验证及向量请求。完整、部分、未知和无效统计分别展示；AI 可回读同一份个人记录，模型不能选择其他员工或虚构费用。执行器只取得短期网关凭据，真实供应商 Key 留在产品后端。

实际 DeepSeek Flash 的 DSH/Hermes 两次合成回读已成功，均记录到供应商用量；金额估算和员工声明与供应商账单分开。[用量口径、权限与迁移](docs/MODEL-USAGE.md) · [桌面界面](docs/images/model-usage-desktop.png) · [手机界面](docs/images/model-usage-mobile.png)。

“设置 → 价格与预算”支持人工价格版本、按连接的 UTC 每日预算、请求预留和明确金额核对，人工/AI 共用服务。预算不足、未知费用或超预留会阻止后续请求；已发请求仍可能超额，不承诺供应商账单硬封顶。组织/项目跨连接预算已实现并通过完整 CI，见 [企业预算](docs/ORGANIZATION-BUDGETS.md)；自动供应商账单对账不在本次已实现能力中。[契约与回退](docs/MODEL-SPENDING.md) · [桌面](docs/images/model-spending-desktop.png) · [手机](docs/images/model-spending-mobile.png)。

最终代码 `22757e44b30dd4ca480e4f458f74e8dfd44f1bec` 的 [CI 41040063081](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41040063081) 三个 job 全部成功，210 项首轮通过：25 单元/配置、3 下载器、8 解析、118 数据库、3 原生执行器、40 UI、9 真实来源、4 容器；另含类型、构建、两个 npm 审计与冻结包。模型、单价、金额声明和企业资料均为明确合成样例，不代表供应商账单或公司上线验收。

## 项目成员与员工分配

任务页可查看、筛选当前项目成员；来源 UID 与产品员工精确对应，同名不自动匹配，尚无当前工作区身份/权限的人不可分配，不自动建号或授权。人工与 AI 共用目录及分配服务；绑定员工后不能通过旧文字标记改选身份，同名人员之间的改派也能被跟进识别。

[范围、权限、迁移与实际证据](docs/PROJECT-DIRECTORY-ASSIGNMENTS.md) · [桌面](docs/images/task-assignment-desktop.png) · [手机](docs/images/task-assignment-mobile.png)。项目范围目录与分配保持来源交集；新增组织通讯录、部门和产品角色见下节，其他自然语言指代和真实理解质量仍需验收。

目录分配实现 `7de26bb353dc2c267644784e38f673bd13322ac0` 的 [CI 41075340989](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41075340989) 三个 job 全部成功，227 项首轮通过：25 单元/配置、3 下载器、8 解析、132 数据库、4 原生执行器、42 UI、9 真实来源、4 容器；另含类型、构建、两个 npm 审计与冻结包。CI 使用合成账号/资料和协议模型，不等于公司全量验收。 实际 DeepSeek Flash 的目录回读与明确员工 ID 分配两个合成小样例通过，[实际模型记录](docs/REAL-MODEL-SMOKE.md)。

## 企业消息附件

企业会话支持接收附件卡片、当前来源查看及 8 MiB 内受限下载。打开/下载时重新检查会话、确切消息/文件、版本与当前权限；隐藏下载、删除或撤权后拒绝读取，HTML 等按二进制附件下载。AI 上下文只取得明确标记的附件引用，不凭文件名宣称读取正文。

[协议、权限与验证边界](docs/MESSAGE-ATTACHMENTS.md) · [桌面](docs/images/message-attachments-desktop.png) · [手机](docs/images/message-attachments-mobile.png)。本地 139 数据库、25 单元、类型/构建、冻结包和完整 43 UI 重跑已通过。

修正实现 `0449f94a0ddd9ac0c8be146bf2bd6ff43ca074a4` 的 [CI 41083527775](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41083527775) 三个 job 全部成功，共 236 项首轮通过：25 单元/配置、3 下载器、8 解析、139 数据库、4 原生执行器、43 UI、10 真实来源、4 容器；另含类型、构建、两个 npm 审计与冻结包。真实 Nextcloud 合成账号验证附件接收、发送者/接收者二进制下载与安全响应头、浏览器下载、移除成员和原件删除后的拒绝读取；不等于真实公司资料验收。

从当前员工的 Files 选择已有文件，可直接发送或交给 DSH/Hermes 执行；房间、文件版本和说明由员工确认，按实际源消息回读记录结果，未知投递仅核对、不自动重发。修正实现 `a6f1b8422eed649c164e59a6569441ca22e21a1c` 的 [CI 41120571893](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41120571893) 三个 job 全部成功，共 246 项通过：25 单元/配置、3 下载器、8 解析、147 数据库、4 原生执行器、45 UI、10 真实来源、4 容器；另含类型、构建、两个 npm 审计与冻结包。真实 Nextcloud 合成账号已验证人工/幂等与重复分享、DSH/Hermes 投递、双方下载和撤权；模型为协议测试服务，不代表该工作流的真实供应商质量或公司验收。[发送与恢复契约](docs/ATTACHMENT-SENDING.md) · [桌面](docs/images/attachment-send-desktop.png) · [手机](docs/images/attachment-send-mobile.png)。

新增本机附件上传入口：先明确确认保存至当前员工 Files，核对原始字节后选中，再人工或交给 DSH/Hermes 分享；不自动把字节交给模型。持久上传意图、条件创建、未知核对和大小限制已接通，本地 155 数据库/HTTP、25 单元、完整 47 UI、类型/构建和冻结包通过，上传实现 `73fced090dc36a00996f701fcca0be76715b1ff9` 的 [CI 41124972265](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41124972265) 三个 job 全部成功，共 256 项首轮通过，包含真实 Nextcloud 合成账号上传/双引擎分享及容器验证；不代表真实供应商质量或公司验收。[上传与恢复契约](docs/ATTACHMENT-UPLOADS.md) · [桌面](docs/images/attachment-upload-desktop.png) · [手机](docs/images/attachment-upload-mobile.png)。整体尚未交付。

## 组织通讯录与部门

“通讯录”已接入当前企业成员组，支持按姓名/UID 查找、分页和部门筛选；区分来源联系人与已验证产品员工。部门建立/移动/归属及产品角色调整由当前管理员明确确认，人工与 DSH/Hermes 共用业务服务；部门不授予项目/文件权限，产品管理员不获得 Nextcloud 管理权限。

当前本地 32 单元/配置、192 数据库/HTTP、完整 59 UI、类型/构建/冻结包通过；扩展后的双原生联合场景以及 7 组织/3 来源协议场景通过。全量 UI 首轮因开发监听重启有 2 项失败，固定代码后完整重跑通过，无重试；手机导航优化后原 3 项再通过。修正提交 `0342719d41f89ac28e2e24be9abce4f2c301d59f` 的 [CI 41276609574](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41276609574) 三个 job 全部成功，共 315 项通过（32 单元、3 下载器、8 解析、192 数据库、5 原生、59 UI、12 真实来源、4 容器）。公司验收单独记录。[范围、审计、迁移与验证边界](docs/ORGANIZATION.md)。首轮组织 CI 的常规验证与容器通过；真实来源新增用例误用了已撤权账号，改为独立测试员工后完整重跑已通过，原鉴权与撤权断言保留。通知与通信管理的后续进展见下文；公司实际组织验收仍待完成。

![组织通讯录（合成验收资料）](docs/images/organization-desktop.png)

## 当前整批开发状态

独立项目决定、工作计划/自然语言消歧、长文分块/多资料私人问答、方法维护人移交已作为提交 `dde6c56d1c02656b97276712f0ee741410801424` 完成整批集成。已有人工/AI 业务入口、权限/版本/源变化测试与界面；[CI 41205371816](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41205371816) 三个 job 全部成功，真实供应商质量与公司验收仍未完成，不据此宣称整体交付。[决定](docs/DECISIONS.md) · [工作计划与澄清](docs/WORK-PLANS.md) · [多资料问答与索引](docs/KNOWLEDGE-CONTEXT.md) · [方法](docs/METHODS.md)。

本地整批回归已通过：29 单元/配置、182 数据库/HTTP、5 原生执行器、56 Chromium UI、8 文档解析、3 下载回归，以及类型/构建/冻结包。首次 UI 55 过/1 个 fixture 会话失败，修正后原场景及完整 56 项重跑通过，无重试。审计补充另复测 8 个工作计划数据库场景及原生联合场景；该提交的 CI 同时通过 11 项真实 Nextcloud 与 4 项受限容器场景，共 298 项通过；使用合成账号、资料和协议模型，不代表公司上线结论。

已修复当前页面的空响应 JSON 异常：失败保留草稿，写操作先核对原回执；Run 轮询恢复后自动清除临时错误。[恢复契约与本地证据](docs/API-RECOVERY.md)。

项目“工作计划”已接通：AI 整理步骤，服务端固定人员 ID 和目标版本；同名、旧版本与缺失信息由员工澄清，可人工接管或明确让 AI 据答案续改，最后确认才保存实际任务/成果。当前本地 8 个数据库、2 个桌面/手机场景通过，联合真实 DSH/Hermes 的整批用例通过；模型为本地协议服务。该提交已通过真实来源/容器 CI；真实供应商理解质量和公司验收仍待完成。

![工作计划与真实回执（合成验收资料）](docs/images/work-plan-desktop.png)

## 会话与通知管理

“企业消息 → 会话与通知管理”新增单聊/私群创建、按 UID 邀请/移除、群管理员调整、群名、个人通知等级与收藏、所选消息已读/未读、退出及删除普通私群；人工和 DSH/Hermes 共用来源服务。界面显示未读/提及，操作等待期间可以停止后续步骤；重试保留原请求，未知结果不重发。邀请会影响来源群及关联项目的访问范围，确认页明确展示。

本地已通过类型/构建、单元、数据库、双原生和桌面/手机回归；真实 DeepSeek Flash 的 DSH 查询/Hermes 收藏各完成一次供应商调用，来源仍为合成 HTTP fixture。修正提交 `9bdb509` 的 [CI 41297748241](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41297748241) 三个任务全部成功，共 348 项通过，包含 13 项真实 Nextcloud 与 4 项容器场景。首轮角标定位失败已保留并修正，未跳过旧用例。没有公司资料、真实手机通知或正式验收结论。[范围、回执、证据及迁移](docs/COMMUNICATION-MANAGEMENT.md)。

![会话与通知管理（合成验收资料）](docs/images/room-management-desktop.png)

## 任务说明与澄清

项目“任务说明”页可人工或通过 AI 整理目标、范围、约束和完成标准，提出必要问题。员工回答并确认当前版本后，可绑定版本发起纪要、周报或成果修改；说明被改动或重新打开时，旧引用不能继续产生业务动作。DSH/Hermes 共用说明、答案与回执，不依赖私有检查点。

[说明、权限、迁移与边界](docs/WORK-BRIEFS.md) · [桌面](docs/images/work-brief-desktop.png) · [手机](docs/images/work-brief-mobile.png)。当前为说明入口的明确澄清闭环，通用自然语言歧义路由和完整业务验收仍待完成。

说明实现 `5daf7e67ea44c16abb3c32344d2fde01c10e3a18` 的 [CI 41043632497](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41043632497) 三个 job 全部成功，218 项首轮通过：25 单元/配置、3 下载器、8 解析、124 数据库、4 原生执行器、41 UI、9 真实来源、4 容器；另含类型、构建、两个 npm 审计与冻结包。CI 使用合成资料和协议模型，不能代替公司验收。 实际 DeepSeek Flash 的 DSH 澄清 → 合成回答/确认 → Hermes 绑定成果小样例通过，[实际模型证据](docs/REAL-MODEL-SMOKE.md)。

## 本地开发

需要 Node.js 24 与可用的 PostgreSQL（安装 pgvector）。容器运行包见下方自部署章节。

```bash
npm ci
cp .env.example .env
```

在本地 .env 中配置 DATABASE_URL、APP_ORIGIN 与 CREDENTIAL_MASTER_KEY。加密主密钥通过下面的命令生成，不要提交到 Git：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm run migrate
```

本机体验演示需显式设置 DEMO_MODE=true，然后运行：

```bash
npm run seed
npm run dev
```

打开 http://127.0.0.1:5173 ，点击“进入演示工作区”。演示登录仅接受本机请求；演示数据与确定性 fixture 执行不代表真实企业数据或模型效果。DSH/Hermes 未配置时会明确报错。

使用 DSH 时另行运行 `npm ci --prefix runtime/dsh`；Hermes 需要 Python 3.14.6，再运行 `python3 runtime/hermes/install.py`。在设置页保存 chat 模型连接，重启 API/Worker 后发起任务。可显式选择个人/工作区连接；自动选择时优先个人连接。[DSH](runtime/dsh/README.md) · [Hermes 安装及验证边界](runtime/hermes/README.md)。

## Docker Compose 自部署

新增构建后的网页/API、独立 Worker、PostgreSQL/pgvector 与一次性初始化服务；镜像包含锁定的 DSH/Hermes。Nextcloud 作为独立来源接入。配置生成器以 0600 创建新密钥文件并拒绝覆盖，容器持久化卷独立，默认只向主机 loopback 开放应用端口。

API/Worker 的数据库运行账号与管理员分离，管理员凭据仅用于数据库与初始化；[旧配置与旧数据卷升级说明](docs/DEPLOYMENT-DATABASE.md)。受限账号的业务、队列、容器权限与双执行器恢复已通过 CI，原有数据和加密主密钥保留。

```bash
node scripts/deploy-init.mjs
# 编辑 .env.compose 中的组织来源与 APP_ORIGIN
HYPER_REVISION=$(git rev-parse HEAD) docker compose --env-file .env.compose up -d --build
```

[完整配置、备份、迁移与回退说明](docs/DEPLOYMENT.md)。Linux amd64 容器构建、启动、双执行器、停启持久化与中断恢复用例已在 CI 通过；真实公司环境与生产验收仍待完成。

## 企业账号登录

已实现 Nextcloud Login Flow v2、明确群组准入和产品角色映射。需要单独初始化企业工作区，浏览器在 Nextcloud 页面完成授权。应用密码由后端加密保存，后台执行前重新检查来源权限。[配置、数据范围、撤权和验证边界](docs/NEXTCLOUD-IDENTITY.md)。

## 企业消息

“企业消息”通过当前员工身份读取和回复 Nextcloud Talk 会话；发送具有幂等回执与未知结果核对。群成员和原始消息仍由来源管理。点击“项目空间”可创建受限项目：成果、任务、检索与 AI 上下文均继承来源权限；任务可读取当前获准的最近至多 60 条普通消息，成果保存在项目，暂不自动发布到 Talk。[通信配置与恢复](docs/NEXTCLOUD-TALK.md) · [项目权限、数据范围与回退](docs/PROJECT-SOURCE-SCOPE.md)。

下图使用明确的 UI 协议测试资料，非真实公司消息；真实 Talk 链路由独立 CI 检查。

![企业消息界面](docs/images/talk-desktop.png)

[移动端企业消息界面](docs/images/talk-mobile.png)

关联项目的权限提示如下，使用 UI 协议测试资料。原始消息留在来源，工作记录与成果保存在受限项目。

![来源关联项目](docs/images/source-project-desktop.png)

[移动端来源项目](docs/images/source-project-mobile.png)

新增“AI 起草回复”：选择模型生成个人草稿，检查、编辑后放入当前会话发送框，发送仍使用真实来源回执。草稿仅本人可见，不自动广播；已通过固定真实来源与双原生执行器的联合 CI。[完整契约与恢复边界](docs/AI-REPLY-DRAFTS.md)。

下图使用明确的 UI 协议测试资料，非公司消息或真实模型效果。

![AI 回复草稿](docs/images/reply-draft-desktop.png)

[移动端回复草稿](docs/images/reply-draft-mobile.png)

## 企业文件与个人资料

Nextcloud Files/WebDAV 支持浏览与显式导入，副本仅本人可见，可建立语义索引。读取、检索和索引重新检查来源；源更新、删除或撤权后停止使用旧正文和向量。文本/Markdown 与 PDF/DOCX/XLSX/PPTX 受控文本提取的真实来源/容器场景已通过 CI，成果保存界面竞态修复也已通过完整 CI。长文分块与多资料问答已通过整批 CI；来源文件共享发布、Calendar 和真实检索质量仍待完成。[文件契约](docs/NEXTCLOUD-FILES.md) · [文档提取、限额与部署](docs/DOCUMENT-INGESTION.md)。

下图使用明确 UI 协议测试资料，非真实公司文件。

![企业文件导入](docs/images/files-desktop.png)

[移动端文件预览](docs/images/files-mobile.png)

新增个人“AI 阅读此文件”：选择 DSH/Hermes 与 chat 模型，基于所选当前版本生成个人解读，可人工修改并保留版本；源变更/撤权清理相关解读。该流程保持个人范围，完整共享发布与多文件 RAG 仍待实现。[范围、运行清理与迁移](docs/FILE-AI-READING.md)。

可对已保存的解读填写“AI 修改要求”，继续使用 DSH 或切换 Hermes，追加到同一解读的版本历史。AI 只使用当前文件与选中的已保存版本；人工已修改时拒绝旧结果，完成后保留编辑框草稿，由员工主动读取新版本。真实 Nextcloud 下的双向续改、源更新/撤权清理及容器回归已通过 CI；模型使用明确的协议测试服务。

下图为 UI 协议测试资料，非真实公司资料或模型质量证据。

![个人 AI 文件阅读与修订](docs/images/file-reading-desktop.png)

![个人解读按反馈续改与版本来源（UI 协议测试资料）](docs/images/file-reading-ai-revision.png)

[移动端个人解读](docs/images/file-reading-mobile.png)

## 文本成果与验收

项目成果已支持纯文本/Markdown 编辑、AI 生成和反馈修订、历史版本。新增针对确切已保存版本的员工验收：接受、要求修改、重开，可直接记录或让 DSH/Hermes 代执行员工已确认的决定。新内容版本重新作为草稿，旧版意见保留；AI 不自行判断是否合格，也不自动把成果正文发送给模型。[验收契约、权限、迁移与证据](docs/ARTIFACT-REVIEWS.md)。

当前支持基础文本成果和个人文档提取阅读，尚无富文本、多人实时协作、批注评论或 Word/Excel/PPT 原件编辑。个人文件解读与项目成果分别保留权限范围。

“企业文件”新增 PDF/DOCX/XLSX/PPTX（最多 8 MiB、提取文本含位置最多 18000 字符），支持个人预览、AI 阅读/续改与索引。扫描件不执行 OCR；公式明确标记未计算，不承诺版式复现。解析器独立于 DSH/Hermes，安装方法、限制和证据见 [文档接入](docs/DOCUMENT-INGESTION.md)。修复 `1896d27` 的 [CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40968561013) 来源 9 项与容器 4 项通过；主验证 UI 有 1 项重试后通过，已定位并修复保存后刷新竞态，修复提交 `9678126` 的 [CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40971011531) 三个 job 成功、155 项首轮全部通过。首轮来源 401 及修复记录保留在文档中。独立组件 `5cdb970` 的 [CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40966081563) 曾三个 job 成功、145 项通过，不能替代后续业务接入验证。

![文档提取位置与限制说明（UI 协议测试资料）](docs/images/document-preview-desktop.png)

[移动端文档预览](docs/images/document-preview-mobile.png)

![员工对确切版本的验收（演示资料）](docs/images/artifact-review-desktop.png)

[移动端验收](docs/images/artifact-review-mobile.png)

## 待办跟进

“发起任务 → 检查待办进展”比较产品当前待办与项目共用基线。首次和无变化时只返回检查状态；变化合并为一条项目消息，保留前后字段、来源 Run 与实际消息回执。DSH/Hermes 及不同员工共用基线，模型不能自行决定通知或伪造完成。[单次检查、迁移、原子性、费用与证据](docs/FOLLOW-UP.md)。真实 Nextcloud 中的双引擎检查/撤权与容器回归已通过既有 CI，使用合成员工和确定性模型协议服务。

“任务 → 我的定时跟进”新增有限次数调度，可直接或经 AI 创建、暂停、恢复与取消。明确选择 15–1440 分钟间隔、1–96 次上限、执行器和固定模型，最晚 30 天停止；次数不是金额预算，每次检查仍可能产生模型费用。失败/失权暂停，重启不补跑错过的一串周期。[定时契约与证据](docs/FOLLOW-UP-SCHEDULES.md)。既有定时链路真实来源和容器完整 CI 已通过；新增三层提醒规则与重要条件见 [跟进提醒](docs/NOTIFICATION-POLICY.md)，其新 CI 仍待验证；真实人工质量评分及跨连接总金额预算仍待完成；连接级金额闸门见上方“价格与预算”。

![有限次数的定时跟进（演示资料）](docs/images/follow-up-schedules.png)

下图为明确的演示资料：上方显示本次检查静默，讨论区保留此前两项变化的一条消息。

![待办变化合并与再次静默](docs/images/follow-up-quiet.png)

## 检查与验证

```bash
npm run typecheck
npm test
npm run build
# 仅使用隔离测试数据库，数据库名称必须以 _test 结尾
TEST_DATABASE_URL=postgres://用户:密码@127.0.0.1:5432/hyper_test npm run test:integration
npx playwright install chromium
npm run test:e2e
```

本地已通过 19 项单元/Provider/部署配置、80 项数据库、29 项浏览器、8 项 Python 文档解析，以及类型/构建。保存界面最后修订后 4 项成果 UI 复测通过；3 项双执行器原生运行时已有本机及前述 CI 证据。模型与向量 HTTP 测试使用明确的本地协议测试服务；不代表真实供应商效果。

成果验收实现 `e13b775` 的 [完整 CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40964224588) 三个 job 全部成功，共 137 项测试：16 单元/Provider/配置、3 Python 下载回归、77 数据库、27 UI、3 原生执行器、8 真实来源、3 容器；另含类型、构建、两个 npm 审计和冻结包校验。验证双执行器记录员工确认的决定、真实来源权限、容器重启保留、历史版本状态及新版草稿。不代表真实模型质量、完整文档产品或 E01–E10/生产验收。

定时跟进与输入范围提示修正 `e73e025` 的 [完整 CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40957686291) 三个 job 全部成功，共 127 项测试：16 单元/Provider/配置、3 Python 下载回归、70 数据库、24 UI、3 原生执行器、8 真实来源、3 容器；另含类型、构建、两个 npm 审计和冻结包校验。覆盖 DSH/Hermes AI 配置与派发、来源设备绑定/撤权、容器重启后配置/计数保留、恢复检查与次数耗尽。初始实现 `c9f8c28` 的 [首轮 CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40956417646) 同样全部成功；不代表真实模型质量或完整 E01–E10/生产验收。

静默跟进提交 `0eccf7d` 的 [完整 CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40950231488) 三个 job 全部成功，共 117 项测试：16 单元/Provider/配置、3 Python 下载回归、63 数据库、21 UI、3 原生执行器、8 真实 Nextcloud/Talk/Files、3 容器部署与权限/恢复；另含类型、构建、两个 npm 审计和冻结包校验。来源场景验证 DSH→Hermes→DSH 的基线/人工变化/再次静默，以及成员撤权后不移动基线、不保存动作。模型质量、完整 E03/E01–E10 和生产验收仍未完成。

个人解读 AI 续改提交 `0d381f5` 的 [完整 CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40924328792) 三个 job 均成功，共 110 项测试：16 单元/Provider/部署配置、3 Python 下载回归、57 数据库、20 UI、3 原生执行器、8 真实 Nextcloud/Talk/Files、3 容器部署与权限/恢复。另含类型、构建、两个 npm 审计和冻结包校验。真实来源联合用例覆盖 DSH→Hermes 同对象续改、源更新清理、Hermes→人工→DSH 续改及分享撤回；未代表真实模型质量或原始 E01–E10 全部完成。

部署首轮 [CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40903087059) 在固定 Hermes 源码下载时遇到 HTTP 429，第二轮复用归档遇到构建 secret 大小限制。修复为有界重试、公开源码缓存/摘要复核与独立构建上下文后，提交 `5a0cb37` 的 [容器 job](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40906030218) 2 项用例通过；完整证据和首轮失败记录见部署文档。

数据库权限修复提交 `42facee` 的 [完整 CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40913709891) 三个 job 均成功，共 103 项测试：16 单元/Provider/部署配置、3 Python 下载回归、52 数据库、18 UI、3 原生执行器、8 真实 Nextcloud/Talk/Files、3 容器部署与权限/恢复。另含类型、构建、两个 npm 审计和冻结包校验。模型仍为协议测试服务；未代表真实模型质量或原始 E01–E10 全部完成。

此前容器基础提交 `5a0cb37` 的 [CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40906030218) 三个 job 成功，共 98 项测试；后续数据库权限变化和首轮清理失败的记录见上述部署权限文档。

个人文件阅读实现提交 `38de927` 的 [完整 CI](https://github.com/MkaliezZ/hyper-workspace/actions/runs/40869859532) 两个 job 成功，共 90 项测试（12 单元/Provider、49 数据库、18 浏览器、3 原生执行器、8 真实来源），另含类型、构建、两个 npm 依赖审计和冻结包校验。来源用例覆盖 DSH/Hermes 的私有文件解读、修订、源更新与撤权传播；模型仍为协议测试服务。后续提交以各自 Actions 为准。

## 开发依据与进展

- [Agent 开发规则](AGENTS.md)
- [当前实现与未验证项](docs/IMPLEMENTATION.md)
- [首版交付核对表与剩余门槛](docs/DELIVERY-CHECKLIST.md)
- [产品三层基线](docs/handoff-v1/AI-IM基线/README.md)
- [技术与跨引擎契约](docs/handoff-v1/AI-IM基线/技术选型与模块契约-v1.0.md)
- [产品命名决定](docs/NAMING.md)
- [模型连接、向量索引与权限边界](docs/MODELS-AND-KNOWLEDGE.md)
- [来源项目与 AI 上下文契约](docs/PROJECT-SOURCE-SCOPE.md)
- [AI 个人草稿与人工检查后发送](docs/AI-REPLY-DRAFTS.md)

每项变更关联 P/C/A/E 编号；保留原始交接快照，按实际结果更新进度。

## 许可证

自有代码采用 [MIT](LICENSE)。Nextcloud、DSH、Hermes 与其他依赖分别保留自身许可证；本仓库许可证不改变第三方组件的授权要求。

[锁定依赖与许可声明清单](docs/DEPENDENCIES.md)提供离线可复核记录，其他运行层按固定版本继续核对。

# Hyper Workspace 开发规则

## 当前扩展阶段（用户明确授权）

当前仓库为 `hyper-workspace-next`，由首阶段交付版本 `61082e0d2a872df25e94bb935d073afae9421729` 派生。依次完成：日历排期 → 复杂审批 → 图片 OCR（评估 SoMarkAI/OXR）→ 复杂表格与 Office 协作。不得把 Provider、原型或协议测试通过当作某阶段已交付，也不得将后续功能永久排除。新范围以 [扩展基线](docs/PHASE2-BASELINE.md) 及配套 JSON 为准；原 v1.0 快照保持不变。

新代码保存到用户指定的新公开仓库 `MkaliezZ/hyper-workspace-next`；原交付仓库、桌面交付包和公司待准备环境保持独立。日历、审批、OCR 与 Office 都须具备人工入口、DSH/Hermes 共用业务服务、当前权限与源版本检查、可修改成果及实际执行回执。蓝白黑 UI；持续更新 README，并核对本仓库当前提交的 Actions，失败及时修复。旧仓库的 CI 只证明其对应版本。

必须先读取 docs/handoff-v1/AGENTS.md、docs/handoff-v1/AI-IM基线/README.md、三层定义-v1.0.md、product-baseline.v1.json、技术选型与模块契约-v1.0.md。原交接包中的路径以 docs/handoff-v1/ 为根解析。原快照保持可校验，开发状态另存 docs/IMPLEMENTATION.md。

固定 React + TypeScript、NestJS、PostgreSQL + pgvector + pg-boss、独立 Worker、Docker Compose；DSH 默认执行器，Hermes 必须兼容；Nextcloud 通过 Provider 接入；企业资产、权限、Policy 和回执归产品核心拥有。

最新用户要求：开始实际开发，在 GitHub 新建公开仓库保存；持续更新 README，必要时插入图片；前端主体蓝白黑配色；检查 GitHub Actions 并修复失败。当前用户已授权建库和推送，不为这些已授权动作重复请求确认。

部署访问已由用户于 2026-11-03 明确：正式产品在公司内网通过固定 IP 访问，无需外部域名；使用内部 CA / IP SAN 的 HTTPS，阿里杭州仅作临时技术验收，保持私有隧道访问。不得再把购买域名、开放公网或公司已经上线当作既定条件。参见 docs/DEPLOYMENT-INTRANET.md；公司实际安装、临时云端检查和整体验收分别记录。

用户随后明确选择公司局域网 Linux 服务器，并回复服务器“待准备”。先完成可安装软件交付包；实际公司安装等待目标机和内网 IP 就绪，不自行替换成其他云主机或把试用机当正式环境。

遵守 P01–P08 / C00–C07 / A01–A10 / E01–E10，可追溯实现。Mock、真实引擎、真实模型、业务端到端和上线分别记录。基线变更必须有相应授权与记录，普通实现细节自主推进。

执行接口统一，核心业务不依赖执行器私有状态。安全检查在后端，不以生成文本宣称执行成功；敏感凭据不进入日志、向量或仓库。

不要提交 .env、运行数据、真实企业资料或私钥。README 与实际能力一致，代码/协议变化同步更新文档。

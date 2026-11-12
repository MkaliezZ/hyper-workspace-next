# 贡献指南 / Contributing

[中文](#中文) · [English](#english)

## 中文

问题报告请写明源码 revision、运行环境、可复现步骤、预期与实际行为，以及是否使用合成来源、真实服务、协议模型或真实供应商。日志只保留必要且脱敏的诊断；不要上传 `.env`、密钥、Cookie、WOPI 凭据、数据库或公司文档。

提交改进前阅读 [AGENTS.md](AGENTS.md)、[PRD](docs/PRD.md)、[扩展基线](docs/PHASE2-BASELINE.md)及目标模块契约。使用 `codex/` 或描述明确的功能分支；人工和执行器仍共用业务服务，权限/来源版本/实际回执由后端执行。

根据改动运行必要的类型、单元、数据库、来源、浏览器或容器检查，并说明准确的验证范围。真实供应商调用需明确授权；不得将协议测试通过写成真实模型或企业验收。修改公共行为时同步中英文 README 与对应模块文档。

`docs/handoff-v1` 是冻结交接快照，不修改文件或摘要来接受新行为。后续实现和证据记录在当前文档中。原件、旧数据、主密钥与已有安装配置须可保留和恢复。

项目自有代码采用 [MIT](LICENSE)。新增第三方代码、依赖、模型或资产须核对来源、适用许可、版权及分发通知，并更新[依赖记录](docs/DEPENDENCIES.md)。根许可证不覆盖其他权利人的材料。

## English

For issues, include the exact source revision, environment, reproducible steps, expected/actual behavior, and whether the evidence uses synthetic sources, real services, protocol models or a real provider. Supply only necessary, redacted diagnostics. Do not upload environment files, keys, cookies, WOPI credentials, databases or company documents.

Read [AGENTS.md](AGENTS.md), the [PRD](docs/PRD.md), the [phase-two baseline](docs/PHASE2-BASELINE.md) and the affected module contract. Use a descriptive feature branch (`codex/` is the project default). Human and executor entry points must retain shared business services, backend authorization/source-version checks and actual receipts.

Run checks appropriate to the change and describe their exact scope. Real-provider calls require explicit authorization. Protocol tests do not establish real-model or company acceptance. Update both READMEs and relevant module documentation when public behavior changes.

Preserve the byte-verifiable `docs/handoff-v1` snapshot and its hashes. Record new implementation/evidence separately. Existing originals, data, encryption keys and deployment configuration must remain recoverable.

Project-owned code is [MIT](LICENSE). Review provenance, applicable license, copyright and distribution notices for new third-party code, dependencies, models and assets, and update [dependency records](docs/DEPENDENCIES.md). The root license does not replace other rights holders' terms.

# Hyper Workspace 软件交付入口

软件沿用冻结三层定义与 DSH 默认/Hermes 必需的技术基线，扩展模块的安装增量见本页末尾。每个源码包的 `manifest.json` 记录完整 Git revision、源码归档 SHA-256、逐文件清单和该 revision 的 CI；`SHA256SUMS.txt` 用于核对归档与清单。当前包和版本说明从 [hyper-workspace-next Releases](https://github.com/MkaliezZ/hyper-workspace-next/releases) 获取。

软件、技术验收、公司安装与组织签收分别记录。公司已选择局域网 Linux 服务器，机器和内网 IP 仍“待准备”；云端合成试用不替代该机器。

## 安装顺序

1. 使用交付包清单中的完整源码 revision，在 Linux amd64 准备 Docker Engine、Buildx、Compose、Node 24 及 Python 3.12+（来源 Talk 准备工具需要）；先检查已有服务和端口。当前完整镜像构建与实际容器证据见 [部署说明](DEPLOYMENT.md)，依赖及各模块许可证见 [DEPENDENCIES.md](DEPENDENCIES.md)。源码包不含预构建镜像、Node/Python 依赖或模型权重，需要联网准备这些固定输入，不是离线安装包。
2. 源码包解压到新目录；若使用 Git，则 clone 公库并 checkout 清单中的完整 revision。运行 `node scripts/deploy-init.mjs` 生成全新的受限 `.env.compose`；已有安装保留原配置和主密钥，不覆盖。
3. 如公司已有兼容 Nextcloud，按 [基础部署](DEPLOYMENT.md)接入公开 API；如新建独立来源和免费本地 CPU embedding，按 [来源/向量部署](DEPLOYMENT-PRIVATE-TRIAL.md)准备服务、固定权重、独立账号/库与 Talk。模型本地推理没有外部按次费用，主机资源仍由公司承担。
4. 按 [公司内网 IP 安装](DEPLOYMENT-INTRANET.md)设置两个 HTTPS IP 入口、IP SAN 证书、员工设备 CA 信任及 Nginx；使用全部实际 Compose 叠加文件。仅开放公司网段的 HTTPS，不公开数据库或向量端口。
5. 首次启动后由明确 UID 的管理员完成企业授权；配置真实成员组/组织/项目。员工在“设置”保存本人或获准共享的 chat 连接并验证，API Key 不进入聊天、源码包或截图；另保存并验证 embedding 连接。云端合成员工、个人 Key、数据和主密钥不复制为公司默认配置。
6. 在该入口执行 [E01–E10 证据核对](DELIVERY-CHECKLIST.md#正式验收门槛)：真实员工身份、来源权限、文档读取、双引擎纪要/任务/修订、语义检索、日志/取消、通知和未知结果恢复。先用标记的合成资料复查，再按公司授权接入实际数据；不以健康检查替代业务验收。
7. 按 [产品备份](BACKUP-RESTORE.md)及[来源配套恢复](SOURCE-BACKUP-RESTORE.md)保管配置、来源库/原件、产品库与密钥，先独立恢复验证，再安排正式切流。保留旧镜像与原卷，停止使用 `stop` 或保留卷的 `down`，不用 `down --volumes`。

源码归档不带 `.git` 时，将清单中的 revision 写入部署私有环境的 `HYPER_REVISION`，不要执行依赖 `.git` 的 `git rev-parse` 示例。构建和启动命令其余路径均以源码根目录为准。

## 软件内容与证据

- 源码、SQL 迁移、Compose/代理模板、固定依赖/执行器锁、中文部署文档、回退与备份工具、开发规则及原始冻结包。
- [执行详情](RUN-DETAILS.md)、[同名项目与精确目标](PROJECT-IDENTITY.md)、[真实云端联合记录](CLOUD-TRIAL-ACCEPTANCE.md)、[真实模型方法质量](REAL-METHODS-ACCEPTANCE.md)、[中文检索质量](SEMANTIC-QUALITY.md)。成功、失败、协议模型和真实供应商分别标注。
- 桌面交付包使用 Git 跟踪文件归档，附源码 SHA-256 与文件清单；不含 `.env`、`.runtime`、服务器交接凭据、数据库、实际 Key 或公司资料。原桌面规则包独立保留。

## 尚待公司环境完成

目标机/固定 IP、内部证书分发、公司员工与实际权限、目标机容量、多员工冷加载及正式安装签收仍待公司环境。供应商费用按公司选择的价格/预算策略记录，现有真实试用 unpriced/unknown 保留原状态。自动供应商账单对账、执行器私有检查点热迁移及本轮之外的音视频/媒体编辑尚未实现；日历、审批、OCR 与 Office 按下面的扩展范围安装。

## 扩展仓库的安装增量

以上首阶段证据保留原范围。扩展代码从 `MkaliezZ/hyper-workspace-next` 获取，以其发布清单和对应提交 CI 为准；不要用旧仓库源码安装新增模块。当前整组日历补项、Office 协作与副本保存的开发验收状态见 [实现记录](IMPLEMENTATION.md)。

- 日历启用 `NEXTCLOUD_CALENDAR_ENABLED=true`，先完成来源 Calendar/CalDAV 和员工权限设置；审批使用产品数据库，管理员发布流程后才供员工提交。
- OCR 在原部署组合后加入 `deploy/compose.local-ocr.yaml`；服务权重固定并在构建时校验，安装与样例范围见 [OCR](OCR.md)。
- 在线办公按 [Office](OFFICE.md)准备受限连接器设置、私有网关秘密、来源伴随应用、HTTPS 入口与 `deploy/compose.office.yaml`。该叠加文件用于本仓库自管 Nextcloud 的组合；已有外部来源按其实际地址与直连网关 IP 配置。编辑器本体和网关控制端口均不公开。
- 生成可编辑副本另加入 `deploy/compose.office-tools.yaml`，按 [批处理安装](../runtime/office/README.md)构建同核服务。保留此前用于来源、OCR、内网代理及证书的所有叠加文件，不用新模块示例替换原安装命令。API/Worker 与相关内网服务一起验证，数据库迁移和受限角色由初始化服务处理。

新安装使用生成器创建的 `.env.compose`；已有安装沿用原配置文件、主密钥与数据卷。Office 提案/来源写入进入不明状态时先对账，回退应用不代表已生成的来源副本被撤销。复杂工作簿的支持范围及已知标题限制见 [同核兼容记录](../runtime/office/COMPATIBILITY.md)。

# 复杂表格与 Office 协作

企业文件中的 DOCX、XLSX 和 PPTX 使用同一 Nextcloud 办公入口。Hyper Workspace 先用当前员工的来源连接核对路径、文件 ID、ETag 与实际读取权限，再提供 Nextcloud 文件短链接。链接不包含凭据，浏览器通过自己的 Nextcloud 会话打开文件，编辑、分享和版本由来源系统授权。入口核对记录反映打开前看到的版本。编辑中的协作与最终保存要到来源系统另行核对。 [Nextcloud 文件短链接](https://github.com/nextcloud/office)

## 办公内核评估

首轮测试目标是 Collabora CODE 26.04.6.1.1 和 Nextcloud Office 10.3.3。官方发布的连接器清单支持当前部署的 Nextcloud 33。Collabora 官方说明支持桌面和移动设备编辑，也把 CODE 定位为测试和小团队版本。ONLYOFFICE Docs 10.0.0 和连接器 10.2.1 是另一组兼容候选。ONLYOFFICE 社区版可用于桌面网页编辑，官方将手机网页编辑和 Automation API 列在商业版本的能力中。两种编辑器共用 Nextcloud 文件入口，一个部署使用其管理员选定的默认编辑器。 [Collabora CODE](https://www.collaboraonline.com/code/) · [Nextcloud Office 10.3.3](https://github.com/nextcloud/richdocuments/releases/tag/v10.3.3) · [ONLYOFFICE 手机网页能力](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/mobile-integration) · [Automation API](https://api.onlyoffice.com/docs/docs-api/usage-api/automation-api)

已有经管理员配置的 Nextcloud 办公编辑器时，在私有 Compose 环境文件启用 `NEXTCLOUD_FILES_ENABLED=true` 和 `NEXTCLOUD_OFFICE_ENABLED=true`，然后按现有部署命令重新应用配置。登录企业账号后，从知识库的企业文件中选择“Office 协作”。这是按需启用的入口，编辑器部署与健康情况需要在 Nextcloud 核对。

## 当前验证

PostgreSQL 与合成 WebDAV 来源覆盖了功能开关、员工本人、同工作区管理员无文件权限、共享后打开、撤销读取后拒绝、文件 ID 或 ETag 变化，以及不支持的格式。Chromium 在桌面和手机尺寸下验证了入口、链接和撤权提示。编辑器连接、真实往返与并发保存、复杂工作簿及双执行器工具属于后续验收。 [合成表格的手机入口](images/office-source-link-mobile.png)

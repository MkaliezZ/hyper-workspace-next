# 复杂表格与 Office 协作

企业文件中的 DOCX、XLSX 和 PPTX 使用同一 Nextcloud 办公入口。Hyper Workspace 先用当前员工的来源连接核对路径、文件 ID、ETag 与实际读取权限，再提供 Nextcloud 文件短链接。链接不包含凭据，浏览器通过自己的 Nextcloud 会话打开文件，编辑、分享和版本由来源系统授权。入口核对记录反映打开前看到的版本。返回工作台后，可选择“核对来源版本”。产品使用当前员工权限重新读取同一文件并对比 ETag。发现换版时要求刷新目录后重新打开。版本变化仅证明来源发生变化，保存归属和具体修改以来源编辑历史为准。 [Nextcloud 文件短链接](https://github.com/nextcloud/office)

## 办公内核评估

首轮测试目标是 Collabora CODE 26.04.6.1.1 和 Nextcloud Office 10.3.3。官方发布的连接器清单支持当前部署的 Nextcloud 33。Collabora 官方说明支持桌面和移动设备编辑，也把 CODE 定位为测试和小团队版本。ONLYOFFICE Docs 10.0.0 和连接器 10.2.1 是另一组兼容候选。ONLYOFFICE 社区版可用于桌面网页编辑，官方将手机网页编辑和 Automation API 列在商业版本的能力中。两种编辑器共用 Nextcloud 文件入口，一个部署使用其管理员选定的默认编辑器。 [Collabora CODE](https://www.collaboraonline.com/code/) · [Nextcloud Office 10.3.3](https://github.com/nextcloud/richdocuments/releases/tag/v10.3.3) · [ONLYOFFICE 手机网页能力](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/mobile-integration) · [Automation API](https://api.onlyoffice.com/docs/docs-api/usage-api/automation-api)

已有经管理员配置的 Nextcloud 办公编辑器时，在私有 Compose 环境文件启用 `NEXTCLOUD_FILES_ENABLED=true` 和 `NEXTCLOUD_OFFICE_ENABLED=true`，然后按现有部署命令重新应用配置。登录企业账号后，从知识库的企业文件中选择“Office 协作”。这是按需启用的入口，编辑器部署与健康情况需要在 Nextcloud 核对。

## 当前验证

PostgreSQL 与合成 WebDAV 来源覆盖了功能开关、员工本人、同工作区管理员无文件权限、共享后打开、撤销读取后拒绝、文件 ID 或 ETag 变化，以及不支持的格式。Chromium 在桌面和手机尺寸下验证了入口、链接和撤权提示。编辑器连接、真实往返与并发保存、复杂工作簿及双执行器工具属于后续验收。 [合成表格的手机入口](images/office-source-link-mobile.png)

GitHub Actions 加入固定版本的真实编辑器检查。隔离运行器验证公开组件的镜像和安装包、Nextcloud 的 WOPI 连接，并等待 Collabora 报告三种合成文档加载完成。这个检查验证实际打开，协作保存和格式往返另行验收。

### Windows 接续诊断

交接版本 `bfbe060` 的上一轮 Office 失败只保留了顶层页面加载标记超时。连接器 discovery/capabilities 成功不足以证明文档已经打开。当前将 Office 拆为独立 CI job，使用独立产品库和真实 Nextcloud/Collabora，不占用日历与通信回归的时间预算。

浏览器探针被动监听当前来源页面及其子 frame，仅接受来自配置的编辑器 origin、且发送窗口确为该页面 Office iframe 的消息。成功仍要求 `App_LoadingStatus / Document_Loaded` 和对应 iframe 可见；探针不替来源发送握手。失败日志只记录白名单加载状态、来源类别、HTTP 状态和 WebSocket 状态，省略登录、WOPI token、URL 参数和正文。真实加载、保存与多人编辑的结果按修正提交的运行分别记录。

`70faedf` 的 [独立 Office 检查](https://github.com/MkaliezZ/hyper-workspace-next/actions/runs/42913643698) 仍失败。探针确认 Nextcloud 收到 `Initialized`、`Frame_Ready` 和成功加载响应，但没有 `Document_Loaded`，编辑器 WebSocket 反复建立和关闭。此结果排除了本次失败只是顶层标记观测遗漏的解释。下一轮补充关闭码、白名单协议原因及 CODE 服务端错误分类计数，不发布原始服务日志。断言语义保持不变，继续定位真实会话中断原因。

## 公司内网安装方案

在 [内网部署](DEPLOYMENT-INTRANET.md) 的固定 IP 与内部 CA 配置上叠加 `deploy/compose.office.yaml`。办公室编辑器使用独立的 HTTPS 8444 端口，Nextcloud 继续使用 8443。下面用示例内网 IP，实际配置以公司分配地址为准。容器镜像和连接器版本见 `runtime/nextcloud/office.lock.json`。真实编辑器 CI 使用隔离的明文回环环境。本机已用临时 CA 验证 Office 代理保留主机、升级 WebSocket、拒绝外部调用内部转换路由。实际公司 HTTPS 组合在目标网络另行复验。

在私有 Compose 环境文件追加：

```dotenv
NEXTCLOUD_FILES_ENABLED=true
NEXTCLOUD_OFFICE_ENABLED=true
HYPER_OFFICE_PUBLIC_HOST=192.168.10.50:8444
HYPER_OFFICE_PORT=8091
```

使用 Python 3.12 或更新版本准备签名连接器和容器。以下命令用于首次安装连接器，已有应用时使用 Nextcloud 的升级与备份流程。已有 OCR 等叠加文件应继续保留在命令中。

```sh
office_compose() {
  docker compose --env-file .env.compose -f compose.yaml \
    -f deploy/compose.source.yaml -f deploy/compose.intranet.yaml \
    -f deploy/compose.office.yaml "$@"
}
office_compose config --quiet
python3 runtime/nextcloud/install-office.py
office_compose up -d --wait nextcloud collabora
source_container="$(office_compose ps -q nextcloud)"
editor_container="$(office_compose ps -q collabora)"
office_occ() { docker exec --user www-data "$source_container" php occ "$@"; }
office_install_connector() {
  docker exec "$source_container" test ! -e /var/www/html/custom_apps/richdocuments &&
    docker cp .runtime/nextcloud/richdocuments "$source_container":/var/www/html/custom_apps/ &&
    docker exec --user root "$source_container" chown -R www-data:www-data /var/www/html/custom_apps/richdocuments &&
    office_occ app:enable richdocuments &&
    office_occ integrity:check-app richdocuments
}
office_install_connector
editor_ip="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$editor_container")"
test -n "$editor_ip"
office_occ config:app:set richdocuments wopi_allowlist --value="$editor_ip"
office_occ richdocuments:activate-config --wopi-url=http://collabora:9980 --callback-url=http://nextcloud
office_occ config:app:get richdocuments public_wopi_url
```

公开编辑器地址应为公司固定 IP 上的 `https://192.168.10.50:8444`。安装 [Office Nginx 模板](../deploy/nginx.office.intranet.conf.example)，替换监听 IP、证书路径和回环端口，执行 `nginx -t` 后再重载。通过受信任的公司根证书访问 `/hosting/discovery`，再从员工浏览器打开 DOCX、XLSX 和 PPTX。应用容器内的 Collabora 地址只供 Nextcloud 查询发现和功能，回调只走隔离容器网络。若重建 Collabora 后容器地址变化，重新设置 WOPI 白名单并复核连通性。确认来源连接器和编辑器都可用后，以同一 Compose 文件组合重建 API 和 Worker 让入口启用。

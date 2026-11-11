# 复杂表格与 Office 协作

企业文件中的 DOCX、XLSX 和 PPTX 使用同一 Nextcloud 办公入口。Hyper Workspace 先用当前员工的来源连接核对路径、文件 ID、ETag 与实际读取权限，再提供 Nextcloud 文件短链接。链接不包含凭据，浏览器通过自己的 Nextcloud 会话打开文件，编辑、分享和版本由来源系统授权。入口核对记录反映打开前看到的版本。返回工作台后，可选择“核对来源版本”。产品使用当前员工权限重新读取同一文件并对比 ETag。发现换版时要求刷新目录后重新打开。版本变化仅证明来源发生变化，保存归属和具体修改以来源编辑历史为准。 [Nextcloud 文件短链接](https://github.com/nextcloud/office)

## 办公内核评估

本版固定 Collabora CODE 26.04.6.1.1 和 Nextcloud Office 10.3.3，在线编辑与后台 OfficeTools 使用同一版本内核；连接器支持固定的 Nextcloud 33。CODE 面向测试和小团队，目标机并发容量需要实测。早期评估保留 ONLYOFFICE Docs 10.0.0／连接器 10.2.1 作为候选，手机网页编辑与 Automation API 的商业授权是当时的选型约束；它们未接入本版执行链。 [Collabora CODE](https://www.collaboraonline.com/code/) · [Nextcloud Office 10.3.3](https://github.com/nextcloud/richdocuments/releases/tag/v10.3.3) · [ONLYOFFICE 手机网页能力](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/mobile-integration) · [Automation API](https://api.onlyoffice.com/docs/docs-api/usage-api/automation-api)

按下方配置固定编辑器、网关和来源伴随应用后，在私有 Compose 环境文件启用 `NEXTCLOUD_FILES_ENABLED=true` 和 `NEXTCLOUD_OFFICE_ENABLED=true`，然后按现有部署命令重新应用配置。登录企业账号后，从知识库的企业文件中选择“Office 协作”。现有外部 Nextcloud 也按这组组件及来源当前权限接口接入，实际加载和撤权须在其配置上核对。

## 当前验证

`b3eaf5c` 的[四项 CI 已通过](https://github.com/MkaliezZ/hyper-workspace-next/actions/runs/42930241845)。真实 Collabora UI 修改并保存 DOCX/XLSX/PPTX，WebDAV 下载后核对内容和保留结构，再回工作台确认来源版本变化。双人修改与评论也已通过。覆盖 DOCX 段落/加粗/表格，XLSX 公式缓存/跨表结果/筛选/数据验证/图表，PPTX 幻灯片/表格；样例结果对应这些已列明的结构。

PostgreSQL 与合成 WebDAV 来源覆盖功能开关、员工本人、同工作区管理员无文件权限、共享后打开、撤销读取后拒绝、文件 ID 或 ETag 变化，以及不支持的格式。桌面和手机入口已验证。[OfficeTools](OFFICE-TOOLS.md) 使用同版内核生成可编辑副本，人工/DSH/Hermes 共用权限、方案和回执；真实供应商六份三格式副本的记录见[模型验收](REAL-OFFICE-ACCEPTANCE.md)。命名表与受控 SUM 透视的固定内核验证已通过，限制见[兼容记录](../runtime/office/COMPATIBILITY.md)。修订接受、活动会话撤权、保存冲突恢复和网关组合安装是发布前必须通过的专项检查；发布清单给出对应 revision 与完整 CI 结果。 [合成表格的手机入口](images/office-source-link-mobile.png)

GitHub Actions 的独立 Office job 使用固定镜像与连接器，检查三格式加载、真实编辑保存、双人协作、同核批处理及真实 Nextcloud 新副本。加载断言仍要求 Collabora 报告文档完成，保存断言要求来源文件回读，两个结果分别核对。

### Windows 接续诊断

交接版本 `bfbe060` 的上一轮 Office 失败只保留了顶层页面加载标记超时。连接器 discovery/capabilities 成功不足以证明文档已经打开。当前将 Office 拆为独立 CI job，使用独立产品库和真实 Nextcloud/Collabora，不占用日历与通信回归的时间预算。

浏览器探针被动监听当前来源页面及其子 frame，仅接受来自配置的编辑器 origin、且发送窗口确为该页面 Office iframe 的消息。成功仍要求 `App_LoadingStatus / Document_Loaded` 和对应 iframe 可见；探针不替来源发送握手。失败日志只记录白名单加载状态、来源类别、HTTP 状态和 WebSocket 状态，省略登录、WOPI token、URL 参数和正文。真实加载、保存与多人编辑的结果按修正提交的运行分别记录。

`70faedf` 的 [独立 Office 检查](https://github.com/MkaliezZ/hyper-workspace-next/actions/runs/42913643698) 仍失败。探针确认 Nextcloud 收到 `Initialized`、`Frame_Ready` 和成功加载响应，但没有 `Document_Loaded`，编辑器 WebSocket 反复建立和关闭。此结果排除了本次失败只是顶层标记观测遗漏的解释。下一轮补充关闭码、白名单协议原因及 CODE 服务端错误分类计数，不发布原始服务日志。断言语义保持不变，继续定位真实会话中断原因。

真实复现随后定位到 `docunloading`：连接器设置响应里的预设文件 URL 被 Nextcloud 公共地址覆盖。CI 的 `127.0.0.1:8090` 在 Collabora 容器内不可达；公司公共 HTTPS 也不能代替隔离网络里的服务器回调。新增配置生成器仅对**直接来自指定 Collabora IP、Host 为 nextcloud、精确匹配设置接口**的请求生成内部 HTTP URL。其余请求保持公开地址，签名连接器未修改。镜像默认出站 TLS 校验为关闭，Compose 现在显式启用；不通过关闭证书校验获取预设。

修复连接循环后，欢迎页的无关子 iframe 导航暴露了探针的竞态。现仅比较实际发送 frame 和接收 frame 的导航代际，保留来源、发送窗口和真实 `Document_Loaded` 条件。新增回归在旧探针上失败、修复后通过。WSL 真实 Nextcloud/Collabora 的 DOCX、XLSX、PPTX 加载循环已通过；受限配置的 31 项 PHP 边界检查、连接器完整性与开启 TLS 校验后的独立启动检查通过。当前提交的完整 CI、协作保存与格式往返继续分别验收。

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
node scripts/office-guard-init.mjs
python3 runtime/nextcloud/install-office.py
office_compose build office-gateway
office_compose up -d --wait nextcloud collabora office-gateway
source_container="$(office_compose ps -q nextcloud)"
editor_container="$(office_compose ps -q collabora)"
gateway_container="$(office_compose ps -q office-gateway)"
office_occ() { docker exec --user www-data "$source_container" php occ "$@"; }
office_occ config:system:set loglevel --type=integer --value=2
office_install_connector() {
  docker exec "$source_container" test ! -e /var/www/html/custom_apps/richdocuments &&
    docker cp .runtime/nextcloud/richdocuments "$source_container":/var/www/html/custom_apps/ &&
    docker exec --user root "$source_container" chown -R www-data:www-data /var/www/html/custom_apps/richdocuments &&
    office_occ app:enable richdocuments &&
    office_occ integrity:check-app richdocuments
}
office_install_connector
editor_ip="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$editor_container")"
gateway_ip="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$gateway_container")"
test -n "$editor_ip"
test -n "$gateway_ip"
office_occ config:app:set richdocuments wopi_allowlist --value="$editor_ip,$gateway_ip"
python3 runtime/nextcloud/office-settings.py "$editor_ip"
docker cp .runtime/nextcloud/zz-hyper-office-settings.config.php "$source_container":/var/www/html/config/
docker exec --user root "$source_container" chmod 644 /var/www/html/config/zz-hyper-office-settings.config.php
docker exec -i "$source_container" php /dev/stdin /var/www/html/config/zz-hyper-office-settings.config.php "$editor_ip" < tests/fixtures/office-settings.php
member_group="$(office_compose exec -T api printenv NEXTCLOUD_MEMBER_GROUP)"
test -n "$member_group"
python3 runtime/nextcloud/install-office-guard.py \
  --secret-file .runtime/office-guard/secret \
  --gateway-url http://office-gateway:9982 --gateway-ip "$gateway_ip" \
  --member-group "$member_group"
docker cp .runtime/nextcloud/hyper_office_guard "$source_container":/var/www/html/custom_apps/
docker cp .runtime/nextcloud/zz-hyper-office-guard.config.php "$source_container":/var/www/html/config/
docker exec --user root "$source_container" chown -R www-data:www-data /var/www/html/custom_apps/hyper_office_guard
docker exec --user root "$source_container" chown www-data:www-data /var/www/html/config/zz-hyper-office-guard.config.php
docker exec --user root "$source_container" chmod 640 /var/www/html/config/zz-hyper-office-guard.config.php
office_occ app:enable hyper_office_guard
office_occ richdocuments:activate-config --wopi-url=http://office-gateway:9981 --callback-url=http://nextcloud
office_occ config:app:get richdocuments public_wopi_url
```

公开编辑器地址应为公司固定 IP 上的 `https://192.168.10.50:8444`。安装 [Office Nginx 模板](../deploy/nginx.office.intranet.conf.example)，替换监听 IP、证书路径和回环端口，执行 `nginx -t` 后再重载。通过受信任的公司根证书访问 `/hosting/discovery`，再从员工浏览器打开 DOCX、XLSX 和 PPTX。公共端口只映射到网关，Collabora 不发布主机端口；文件回调和设置预设走隔离容器网络。此组合要求 Nextcloud 安装在来源地址根路径。已有外部来源必须同样安装伴随应用，并按实际内部地址、网关直连 IP 与 WOPI 来源配置专用网络。

`hyper_office_guard` 是本仓库维护的独立 Nextcloud 33 应用。它按当前文件读取/修改权限、账号状态和工作区成员组复核 WOPI 身份。普通共享删除和权限更新先暂停编辑流，再按变更后的权限恢复合法会话；其他权限变化以事件通知和短租约复核补充。复核超时会关闭会话。源变更与网关通知不是跨系统事务，不能承诺任意后台路径在零延迟内失效。网关初版限制编辑器导出、剪贴板文件及转换 HTTP 路由；原件和已保存副本通过 Nextcloud 当前授权下载。真实撤权与保存冲突的验收状态以对应提交的专项测试为准。

网关秘密仅存于 `.runtime/office-guard/secret` 与来源私有配置，备份时按凭据保护。初始化脚本保留现有值，父目录为 `0700`，文件以只读方式挂入非 root 网关。Nextcloud 配置由 `www-data` 持有且权限为 `0640`。Nextcloud 日志保持 warning（`loglevel=2`）或更严格，签名连接器的 debug 日志可能包含 WOPI 记录，不能对这些接口开启调试日志。重建 Collabora 或网关后若容器 IP 变化，重新设置两者的 WOPI 白名单、生成并复制对应配置，再核对实际文档加载和撤权。不要只移除网关恢复直连来回退；先停止 Office 入口及编辑会话，回到经过验证的整个组件组合。若另行接入 HTTPS 来源，需要配置可信 CA，保留 `ssl.ssl_verification=true`。确认来源连接器、网关和编辑器均可用后，以同一 Compose 文件组合重建 API 和 Worker 让入口启用。

网关校验连接初始 token 绑定的身份与当前权限。Collabora 协作保存会选择可写会话，且上游支持 token 更新；具体保存身份仍由编辑器与 Nextcloud 共同决定。该网关不提供逐次 PUT 的单作者归因，也不回撤撤权前已经进入共享内核的修改。

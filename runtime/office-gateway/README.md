# Office 活动会话网关

该服务把固定 Nextcloud 的当前权限检查放在固定 CODE 浏览器连接前。它不编辑文件、不运行办公内核、不修改签名 richdocuments。必须把 CODE 放在仅网关可访问的内部网络，且不发布 CODE 宿主端口；公开编辑器地址指向网关数据端口。容器编排和真实编辑器验收由仓库部署/Nextcloud 测试负责。

## 运行与依赖

无 npm 包、无安装脚本。仅使用 Node 标准库；镜像版本、摘要、来源和授权见 `runtime.lock.json`。Node 及镜像内第三方组件保留其上游许可；本服务不添加第二办公内核。公司 Linux 安装应使用仓库 Compose 入口、内部 CA/IP SAN HTTPS 和只读 secret 文件。

```sh
node --test runtime/office-gateway/gateway.test.mjs
docker build -f runtime/office-gateway/Dockerfile -t hyper-office-gateway .
```

环境变量统一前缀 `HYPER_OFFICE_GATEWAY_`：

| 后缀                     | 必填/默认       | 含义                                                                                      |
| ------------------------ | --------------- | ----------------------------------------------------------------------------------------- |
| `BACKEND`                | 必填            | 固定 CODE origin，如 `http://collabora:9980`；不可由请求指定                              |
| `PUBLIC_ORIGIN`          | 必填            | 浏览器可见网关 origin；用于 Host、Origin 和上游生成地址                                   |
| `INTERNAL_ORIGIN`        | 必填            | Nextcloud 获取 discovery/capabilities 的内网网关 origin                                   |
| `SOURCE_ORIGIN`          | 必填            | 浏览器可见 Nextcloud origin；允许 iframe 发起者，固定源请求 Host                          |
| `SOURCE_INTERNAL_ORIGIN` | 必填            | CFI 和当前权限检查的固定内网连接地址                                                      |
| `WOPI_ORIGIN`            | `SOURCE_ORIGIN` | richdocuments 实际生成的 WOPISrc origin；回调地址为 `http://nextcloud` 时显式设它         |
| `GUARD_SECRET_FILE`      | 必填            | 32–256 个 ASCII 字母/数字/下划线/短横线的专用随机 secret；与伴随 app 一致；不使用员工密码 |
| `BIND_HOST`              | `0.0.0.0`       | 容器监听地址                                                                              |
| `PORT` / `CONTROL_PORT`  | `9981` / `9982` | 数据/控制端口；控制端口禁止发布到宿主或浏览器网络                                         |
| `LEASE_MS`               | `1000`          | 100–5000 ms；检查通过至下一次暂停复验的最大租约                                           |
| `CHECK_TIMEOUT_MS`       | `1000`          | 100–5000 ms；一次 CFI+check 的总超时                                                      |
| `HOLD_MS`                | `10000`         | 1000–30000 ms；权限变更 hold 超时关闭全部活动会话，仍保持入口闭锁                         |
| `MAX_VIEWS`              | `64`            | 1–256；同时包含授权中的 upgrade                                                           |

HTTPS 使用 Node 默认验证和 `NODE_EXTRA_CA_CERTS` 提供的公司 CA，不接受关闭 TLS 验证的选项。origin 必须精确，不带路径、用户信息、query 或 fragment。服务启动只输出固定状态；请求 URL、WOPI token、身份、文档内容、上游错误均不写日志。

## 协议 v1

数据口 `GET /health` 返回 `{"ok":true,"protocol":"hyper-office-gateway.v1"}`，仅表示进程存活，不表示 Nextcloud/CODE 或权限验收通过。

数据口只代理 `GET /hosting/discovery`、`GET /hosting/capabilities`、非管理页面 `/browser/<version>/...` 静态资源和已授权 `POST /browser/<version>/cool.html`。启动页面的 `WOPISrc` 与 form `access_token` 在转发前验证。静态资源可无 Origin；携带 Origin 时只能是固定公开网关或源 origin。WebSocket 必须携带其中一个 Origin。

Nextcloud 33.0.10 的签名页面策略 `Referrer-Policy: no-referrer` 使 richdocuments 的跨源表单启动请求实际携带 `Origin: null`，且没有 Referer。仅上述精确 HTML 启动 POST 接受字面值 `null`；缺少 Origin、任意其他 origin、静态资源的 null 和 WebSocket 的 null 均拒绝。这个值不证明来源或身份，授权仍须同一 WOPISrc、bearer token、CFI 身份及当前 ACL 全部通过；不新增 cookie 或依赖不存在的 Referer/Fetch Metadata。该兼容分支根据真实浏览器请求核验，不能扩大为其他接口的通用例外。

WebSocket 接受固定 CODE 26.04 的 `/cool/ws?WOPISrc=...&access_token=...`，也接受旧 `/cool/<encoded-WOPI-with-token>/ws`。只允许固定 WOPI origin 和 `/index.php/apps/richdocuments/wopi/files/<numericId_instanceId>` 路径；所有身份参数只能出现一次，嵌套/外层冲突、非预期认证参数和 HTTP slow-proxy 传输被拒绝。向上游统一生成新 URL，丢弃旧 reconnect/route hints，每次 upgrade 重新授权。令牌只驻留会话内存，关闭时释放绑定；它不成为日志或持久状态。

授权顺序：

1. 使用该 token 向固定内部地址请求同一文件的 WOPI CheckFileInfo，要求有效 `UserId` 和布尔 `UserCanWrite`。
2. `POST /index.php/apps/hyper_office_guard/check`，头 `X-Hyper-Office-Guard-Secret`，body `{"fileId":"42_instance","token":"..."}`。
3. 伴随 app 返回严格 `{"fileId":"42_instance","userId":"...","canRead":true,"canWrite":true}`。身份与 CFI 必须精确相同；app 从当前节点权限、账号和配置成员组得出权限，不信旧 token 的 canwrite 快照。匿名/public-link 不在该工作区协议内。
4. 源不允许读、旧 CFI 可写而当前不可写、已有会话的身份变化/写权下降、响应格式错误、非 200、重定向或超时，都关闭该会话的两端。其他合法作者保持各自连接。

控制口仅接受固定 secret 头、`application/json`、无 Origin 的以下请求：

| 请求               | 请求体                 | 行为                                                                                   |
| ------------------ | ---------------------- | -------------------------------------------------------------------------------------- |
| `POST /pause`      | `{"id":"32位小写hex"}` | 同步暂停全部活动连接的双向读取，再返回 `{"ok":true,"held":true}`；同 id 重试不延长超时 |
| `POST /revalidate` | 同一 id                | 完成对应 hold，重新 CFI+check；其他 hold 未完成时仍暂停；全部完成且当前检查通过才恢复  |
| `POST /invalidate` | `{}`                   | 立即暂停全部连接，重新检查；供 post-event、CLI/组变更通知使用                          |

复验返回 `{"ok":true,"checked":N,"closed":N,"held":false}`；closed 包括拒绝或验证故障而关闭的会话。没有活动连接时正常返回 0。未知 hold 返回 409；已完成 id 的短期重试成功。并发最多 64 个 hold，历史 id 仅保留最近 256 个。超时关闭活动连接后 **保留 hold**，新 upgrade 被拒绝；必须收到对应受信任完成请求或由管理员确认源状态后重启恢复，不能自行超时放行。普通 OCS 分享修改必须由伴随 app 在变更前成功 pause，并在完成/异常路径 revalidate；pause 失败必须阻止该次变更。

权限通知与租约检测都先暂停，检查完成才恢复。租约补足丢失通知、CLI/组变更等入口：默认最多约 1 秒检测间隔，加上检查耗时，但检测开始后不继续转发。该机制不宣称跨系统原子撤权、零延迟或追回已经进入 CODE 共享文档的历史操作；关闭连接不会撤销关闭前已合并的修改。确认共享变更前暂停的 OCS 路径与仅租约覆盖的其他路径需分别验收。

## 有界转发与明确限制

- 原始 TCP 流保留 WebSocket 字节、掩码、分片、二进制和控制帧，不解码/伪造 COOL 消息。禁用压缩协商；每方向待发队列加 socket writable buffer 上限 256 KiB，遇 backpressure 暂停输入，drain 不得越过权限 hold。
- URL 上限 16 KiB；HTTP 启动 body 64 KiB、读取总超时 10 秒；源 JSON 64 KiB；静态响应 64 MiB；固定端点不跟随重定向。源复验通知使用最多 4 个并行 worker；每视图租约检查单飞，活动视图总数有界。
- CODE 仅内部可达是强制边界。所有非 WebSocket `/cool/**`，包括下载、导出、打印结果、剪贴板、上传、预览、转换及 slow-proxy，和 `/co/collab/**`、adminws/管理页面都被拒绝。无法绑定到已授权会话的独立 HTTP 通道不开放；原件与成果副本继续从 Nextcloud 当前权限下载。编辑器的相关功能会得到拒绝，不能声称这些功能完整可用。
- token 刷新不绕过初始身份绑定：初始 token 不再有效就关闭，由正常重新打开取得新 token。固定 CODE 的服务器 load 使用已绑定 DocumentBroker URL，不信任浏览器 load 的文档地址；此依赖需随 CODE 版本复核。
- 原始转发不解析 `resetaccesstoken` 等 COOL 命令。固定上游可使用该命令更换保存凭据；网关仍只授权初始 uid/file 的当前 ACL，不能将另一个 token 的权限作为放行依据。协作保存的最终归因由 CODE/Nextcloud 处理；本服务不声称每条上游保存请求都保留初始 token，也不提供透明 token 刷新保证。
- 单实例 hold/view 状态在内存中；重启关闭连接。多实例部署必须让每次权限变更先暂停所有实例并全部确认，当前 Compose 仅单网关。不要在网关后增加能直接访问 CODE 的备用路径。

## 证据边界

`gateway.test.mjs` 使用真实 HTTP/原始 TCP socket，覆盖绑定歧义、拒绝下载/管理旁路、CFI 与 ACL 身份不符、双作者隔离、多 hold、租约降权/超时、透明字节及 backpressure。它不证明真实 richdocuments/CODE 协作已通过。真实三格式编辑、双人修改/评论/修订和活动撤权由 Nextcloud 浏览器套件另外记录。

固定上游依据：[`ClientSession::loadDocument`](https://github.com/CollaboraOnline/online.mirror/blob/cp-26.04.6-1/wsd/ClientSession.cpp#L2904) 绑定 DocumentBroker URL；[`AdminSocketHandler`](https://github.com/CollaboraOnline/online.mirror/blob/cp-26.04.6-1/wsd/Admin.cpp#L183) 的 kill 是整文档进程 SIGKILL；[`DocumentBroker::revokeAccess`](https://github.com/CollaboraOnline/online.mirror/blob/cp-26.04.6-1/wsd/DocumentBroker.cpp#L8394) 不提供公开 host 入口。这里没有伪造 security label 或开启任意宏/脚本。

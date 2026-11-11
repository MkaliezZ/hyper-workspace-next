# 同核 Office 批处理 runtime

这个私有服务把 DOCX/XLSX/PPTX 原文件变为可继续编辑的新副本。人工操作、DSH 和 Hermes 由产品后端调用同一份[固定 HTTP 协议](PROTOCOL.md)。服务不持有 Nextcloud、用户、模型或数据库凭据，也不负责授权、提案确认、ETag、幂等上传与未知结果对账；这些仍由产品核心处理。

编辑器和批处理都使用 `collabora/code:26.04.6.1.1` 的同一个固定镜像内核。批处理容器直接启动该镜像的 `/opt/collaboraoffice/program/soffice.bin`，只添加官方同版 `collaboraofficebasis-pyuno_26.04.6-1_amd64.deb` 的 Python/UNO 桥。没有安装另一套 LibreOffice、Java UNO、python-docx 或 openpyxl 来改写业务文件。测试夹具中的文档库仅生成和核对合成文件。

## 固定依赖与许可

[runtime.lock.json](runtime.lock.json) 保存镜像摘要、官方包 URL/大小/SHA256、Python 版本和三个核心文件摘要。[下载器](fetch_pyuno.py) 校验大小和 SHA256 后只向运行目录添加允许的 pyuno/Python 文件，其他包内通知保留在 `/app/licenses/package`；不安装系统包，不提交 `.deb` 或镜像。构建后再次核对核心文件，配套官方 SPDX 3.0.1 SBOM 保留在 `/opt/collaboraoffice/collaboraofficebasis-pyuno-sbom.spdx.json`。包的 SHA256 来自官方 CODE Packages 索引并经下载字节复核；这不是对整个发行仓库签名链的审计。

官方 SBOM 将该包归为 MPL-2.0，并记录 Python 的 PSF-2.0，以及附带组件的 MIT、Apache-2.0、SQLite Blessing、bzip2-1.0.6 等声明。基础镜像及 Python 目录内的上游版权和许可保留；不能用仓库自身许可证覆盖。应在分发镜像时连同上游通知和对应源码获取方式一起提供，记录不是全产品许可审查结论。源码来源为 [Collabora Online](https://github.com/CollaboraOnline/online.mirror/tree/cp-26.04.6-1) 与 [Collabora Office 源码](https://git.libreoffice.org/core)。本实现不依赖付费转换 API，也不启用宏或实验 JS extension。固定 CODE 测试通过不代表商业支持、长期维护承诺或公司生产验收。

## 执行边界

- 一次只执行一个请求，不排队；忙时 503。最多 16 个 HTTP 连接，输入读取超时 10 秒。端口只存在容器内部。
- 文件、ZIP 展开、文本、工作表、单元格、形状、公式、输出和总执行时间均有固定上限；详见协议。未知结构、越界、expectedText/expectedValue 不符均明确拒绝。
- 每请求新建临时目录和 Office profile，默认关闭宏，载入时 `MacroExecutionMode=NEVER_EXECUTE`、`UpdateDocMode=NO_UPDATE`。不启用 `DisableActiveContent`，该选项会让已验证的 XLSX 图表在保存时丢失。
- HTTP 服务可收内网请求；worker 在加载文档前通过 Linux amd64 seccomp 禁止创建非 AF_UNIX socket，规则继承到 soffice。UNO 仅使用请求专属 named pipe，外部链接和公式无法建立 IP 连接。配置不可用时失败关闭。
- 60 秒超时杀掉整个请求进程组；成功和失败也清理残留进程、profile、原文件副本和结果。服务、引擎 stderr 与访问日志不记录正文、URL 或 token。日志仅由测试记录固定状态。
- 所有保存都生成新文件，以同核重开并核对操作结果。Calc 显式 `calculateAll`，核对保存前后的公式、显示值和错误码。已有公式错误按有界列表返回；新写公式报错则拒绝结果。受控本地透视表另调用固定 `refresh`，校验分组求和、总计、缓存记录及重开结果；不会把普通公式重算当成透视刷新。

## 公司 Linux 安装

在既有公司内网安装配置上添加 `deploy/compose.office-tools.yaml`，例如从仓库根目录执行：

```sh
docker compose --env-file .env.deploy -f compose.yaml -f deploy/compose.office-tools.yaml build office-batch
docker compose --env-file .env.deploy -f compose.yaml -f deploy/compose.office-tools.yaml up -d office-batch api worker
```

保留该安装原本使用的其他 Compose 覆盖文件；若基础文件名称不同，以原安装命令为准。服务只连接独立 `internal: true` 的 `office-tools` 网络，不发布宿主端口；仅 API/Worker 另接此网，通过 `HYPER_OFFICE_BATCH_URL=http://office-batch:3123` 使用。无需新增外部域名或公网入口。限制 768 MiB/1 CPU、禁用 swap、128 PID、只读根目录、256 MiB tmpfs、非 root、无 capabilities。公司服务器仍待准备，此说明不是已安装记录。

镜像仅验证 Linux amd64。扩容应由产品任务调度显式安排独立实例，不能关闭单并发或移除资源上限。升级镜像与 pyuno 必须同时更新锁并重新执行三格式回读、公式、超时清理和外网阻断测试；不得仅更换浮动 tag。

## 验证与能力边界

```sh
python3 tests/office/test_protocol.py -v
DOCUMENTS_PYTHON=.runtime/documents/bin/python bash scripts/ci/office-batch.sh
```

第二条以单个 512 MiB/1 CPU、`--network=none` 的容器测试真实 HTTP /inspect、固定操作、expected 冲突、非法公式、保存后同核回读与进程/profile 清理。测试文件来自 `tests/fixtures/office-roundtrip.py`。输出只写 `.runtime/office-batch-*`。首次运行前创建 `.runtime` 并准备现有 documents 测试 venv。

WSL/Linux 真实 HTTP 变换、同核重开和保留夹具已通过。DOCX 覆盖替换与追加、正文粗体和表格；XLSX 覆盖常量、跨表 SUM 新公式、读取原公式后改为 AVERAGE 的结果20、原公式缓存30/10/40、筛选、验证列表、图表与命名表对象；PPTX 覆盖明确文字形状、两页与表格。受控透视表覆盖一个本地范围、一项文本分组及SUM，源数量3改4后结果4、总计6，定义/源记录/缓存/重开和上述其他结构均核对。显式总计标题、透视输出和分组键修改均拒绝。超时测试验证整个进程组被杀及 profile 删除；网络测试覆盖 IPv4/IPv6、子进程继承及 io_uring 拒绝。协议模型或上述局部内核检查不替代产品业务链路验收；合并版本 CI 仍需独立执行。

此路径支持明确段落、简单文字形状、有界工作表单元格和协议列明的单个本地SUM透视表子集。被选中目标的纯文本替换可能合并其原有行内格式。显式透视总计标题在固定内核中确有丢失，因此明确422拒绝；默认标题可能由内核统一为 `Total Result`，详见[兼容性证据](COMPATIBILITY.md)。多透视表、外部/命名数据源、源内公式、多层/多聚合/计算字段等尚不支持；并非永久排除。其他复杂文档格式、修订、批注、宏、嵌入对象、所有 OOXML 扩展、字体分页及全格式保真没有获得验证。真实内核结果、业务权限/Nextcloud 上传回执、双执行器实际执行、多人在线协作与公司上线须分别验收。

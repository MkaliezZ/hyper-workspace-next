# 图片 OCR 与扫描件

## OXR 评估

用户指定评估的 OXR 为 SoMarkAI 的 Optical Everything Recognition。2026-11-10 核对代码 `b2ee4ac` 和 OXR-1.0 权重 `c708407`。官方文档支持图像和 PDF，提供 Markdown、JSON 版面块及坐标。自部署的官方配置为 Linux、支持 BF16 的 NVIDIA GPU、兼容 CUDA 13.0 的驱动。低并发测试从单卡 24 GB 显存起步，长文档或更高并发建议至少 48 GB。本地验证机是 Intel x86_64 Mac，使用核显。公司局域网 Linux 服务器硬件待准备。 [固定代码与部署说明](https://github.com/SoMarkAI/OXR/blob/b2ee4ac12ed220bf7fefa74951babf0d3b05e766/README.md) · [固定模型版本](https://huggingface.co/SoMarkAI/OXR-1.0/tree/c708407f9d2b4df658f2543d9132b62bb7221df4)

代码与模型权重各有基于 Apache 2.0 加附加条款的许可证，文本存在差别。两份文本均列出融资额或年收入超过 200 万美元时的商业授权要求。权重另有竞品托管 API 条款，代码另列第三方产品归属标示义务。公库产品保留独立 OCR 服务边界，OXR 作为可选候选，实际采用前按固定版本核对组织适用条款和部署硬件。 [代码许可证](https://github.com/SoMarkAI/OXR/blob/b2ee4ac12ed220bf7fefa74951babf0d3b05e766/LICENSE) · [权重许可证](https://huggingface.co/SoMarkAI/OXR-1.0/blob/c708407f9d2b4df658f2543d9132b62bb7221df4/LICENSE)

## 合成样本实测

在官方公开测试端点提交一页本地生成的图像 PDF。样本为中英混排的采购记录，包含表头和三条数据行。HTTP 200，结果有 1 页和 4 个带边框坐标的版面块。标题、单号、英文说明及 12 个表格单元格与生成稿一致。返回的表格格式为 HTML。坐标的右下边界与左上边界可映射到扫描页面；这次响应未提供逐块置信度。另用同一页生成低分辨率、旋转 2°、模糊并压缩的 JPEG。第二次也返回 HTTP 200，4 个版面块和 12 个单元格仍与生成稿一致，两次都没有逐块置信度。两份输入使用相同内容，覆盖两种输入格式和一次降质，内网自部署、复杂版面及可靠性另行验收。 [官方免费测试服务说明](https://github.com/SoMarkAI/OXR/blob/b2ee4ac12ed220bf7fefa74951babf0d3b05e766/README.md#0--free-api)

## 低成本选型

按用户确认，OXR 保留为有兼容 GPU 和对应授权时的备选。主线先验证 **RapidOCR + ONNX Runtime CPU + RapidTable（SLANet Plus）**。识别和表格推理可在普通 CPU 主机运行，运行时无需逐页购买 OCR API。准备以轻量中英文字检测与识别权重为起点，RapidLayout 负责全页版面定位，检测到表格后运行表格结构模型。 [RapidOCR 安装与 CPU 推理](https://github.com/RapidAI/RapidOCRDocs/blob/main/docs/install_usage/rapidocr/install.en.md) · [RapidTable 模型与用法](https://github.com/RapidAI/RapidTable)


对照候选 PaddleOCR PP-StructureV3 支持 CPU 推理，输出文本、位置和表格结构。其当前 PaddlePaddle 3.3.1 macOS 发布包为 arm64，本机 Intel 不能直接用该发布包验证。先为 Linux CPU 验证固定模型与依赖，再用同一套合成样本对比中文、英文、扫描和表格。 [PaddleOCR 官方说明](https://www.paddleocr.ai/latest/en/version3.x/algorithm/PP-StructureV3/PP-StructureV3.html) · [PaddlePaddle 3.3.1 发布文件](https://pypi.org/project/paddlepaddle/3.3.1/#files)

本机已核对 RapidOCR 3.10.0 包中的 PP-OCRv6 Small 检测与识别模型和方向分类权重，以及 RapidTable 3.0.2 所指向的 SLANet Plus 权重。四个 ONNX 文件合计约 39.5 MB；该值是模型文件体积。SLANet Plus 下载内容与发布包声明的 SHA-256 一致。 [PP-OCRv6 模型说明](https://www.paddleocr.ai/latest/en/version3.x/module_usage/text_recognition.html) · [SLANet Plus 说明](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/table_recognition_v2.html)

2026-11-11 在 Intel Mac 上使用 ONNX Runtime 1.20.1 的 CPU 执行，采用两个算子内线程和一个算子间线程。清晰 PNG 和降质 JPEG 的标题、编号、英文说明和表格文字均与生成稿一致。以已知表格范围裁剪后，SLANet Plus 两次均提取 12 个单元格，内容和行列一致。全图文字识别加裁剪表格处理分别耗时 16.6 秒与 6.6 秒。两页共用的进程最大驻留内存约 632 MiB。两份图片来自同一生成稿，表格范围由实验传入。后续整页定位与 HTTP 服务实测见下节。

在 Intel Mac 上用 Tesseract.js 7.0.0 和本地中英词库完成 CPU 对照。清晰 PNG 的中英标题、编号、说明均可读，模型总体置信度 93，表格未提取。降质 JPEG 的正文仍可读，表格区域有误识别，总体置信度 78。此路线可作为纯文字对照，结构化表格需要版面模型。 [Tesseract.js v7](https://github.com/naptha/tesseract.js/tree/v7.0.0) · [固定中英词库](https://github.com/tesseract-ocr/tessdata_fast/tree/65727574dfcd264acbb0c3e07860e4e9e9b22185)

## CPU 服务与部署

`rapidocr-cpu/v1` 使用 RapidOCR 3.10.0、RapidLayout 1.2.1 的 PicoDet CDLA 版面模型、RapidTable 3.0.2 的 SLANet Plus 和 ONNX Runtime 1.20.1。五个 ONNX 文件合计约 46.9 MB。构建时逐个校验 SHA-256，权重在镜像内，运行时不下载模型或调用外部识别 API。RapidAI 三个代码库采用 Apache-2.0。PP-OCRv6 与方向分类模型的来源和归属见 RapidOCR 官方声明，CDLA 与 SLANet Plus 来自 PaddleOCR 系列模型的 RapidAI ONNX 转换。权重不存入本仓库。 [模型来源与归属](https://rapidai.github.io/RapidOCRDocs/latest/en/model_licenses/) · [RapidOCR 许可证](https://github.com/RapidAI/RapidOCR/blob/v3.10.0/LICENSE) · [RapidLayout 许可证](https://github.com/RapidAI/RapidLayout/blob/v1.2.1/LICENSE) · [RapidTable 许可证](https://github.com/RapidAI/RapidTable/blob/v3.0.2/LICENSE)

本机实际 HTTP 请求的结果如下。三个输入由同一份合成采购记录生成，均自动定位表格、提取中英正文和 12 个正确单元格。降质 JPEG 的两行正文被标成标题，文字仍完整且可校对。单页 PDF 请求不存在的第 2 页返回 422。这里的耗时只含本机 OCR HTTP 请求，不含文件源、模型助手或人工校对。

| 输入 | 耗时 | 表格 |
| --- | ---: | --- |
| 清晰 PNG | 9.0 秒 | 自动定位，12/12 |
| 低分辨率、旋转与模糊 JPEG | 4.7 秒 | 自动定位，12/12 |
| 扫描 PDF 第 1 页 | 9.3 秒 | 自动定位，12/12 |

另一份独立合成两页 PDF 验证选页隔离和同页多表。第 1 页仅返回封面三行，耗时 6.1 秒。第 2 页读取库存文字并自动分出两张表，18 个单元格均与生成稿一致，耗时 12.9 秒。两页内容未混用。

Chromium 已分别走通真实 CPU 服务的人工入口和原生 DSH、Hermes 入口，验证选页、回执、表格校对、确认、知识检索及撤权清理。该轮聊天模型由测试协议响应，实际聊天模型和双执行器的单独验证见下文。图片展示本轮合成资料。[桌面校对](images/ocr-confirmed-desktop.png) · [手机校对](images/ocr-confirmed-mobile.png)

在现有 Linux Compose 文件组合后加入 `-f deploy/compose.local-ocr.yaml`，保留已有的来源和内网配置。以下为只展示基本文件组合的命令，按实际部署补齐其他叠加文件：

```sh
docker compose --env-file .env.compose -f compose.yaml -f deploy/compose.local-ocr.yaml config --quiet
docker compose --env-file .env.compose -f compose.yaml -f deploy/compose.local-ocr.yaml build ocr
docker compose --env-file .env.compose -f compose.yaml -f deploy/compose.local-ocr.yaml up -d --wait
```

服务独占一条内部网络，API 和 Worker 通过 `ocr:3122` 访问，宿主机不发布 OCR 端口。默认配额为 2 CPU、1.5 GiB 内存，每次处理一页，忙时可稍后重试。PDF 用 Poppler 渲染选定页，最长边为 2048 像素。一次尝试解析最多四个检测到的表格，其余保留文字行。表格使用 TSV，合并区域以空位保持列对齐，结构无法可靠转换时保留文字行。结构表格未提供置信度，界面提示核对。多版式的真实业务质量和公司服务器容量仍需在目标环境验收。

## 工作台与内网识别协议

迁移 051 保存 OCR 草稿、版本和最后一次确认。知识库 → 企业文件中选择 PNG、JPEG 或 PDF（8 MiB 内），PDF 指定页码后选择“识别这一页”。版面图按返回坐标排列文字与表格块，置信度缺失或偏低时提示校对。表格预览以制表符分隔列，可在校对框修改后确认保存。较早的确认版本可在新草稿旁查看。选择“读取原件核对”可在工作台查看图片，或在浏览器 PDF 阅读器中打开原件并定位到所选页。服务在读取原件前后复核权限和文件版本。

后端以当前 Nextcloud 登录、文件 ID、ETag、路径和页码核对来源。只在二进制读取后仍可核验权限和版本时调用配置的内网识别端点，写入前再次校验。来源丢失或版本替换时，已识别内容清理，审计元数据保留。识别失败保留当前草稿和上次确认；同一操作键重试可取回已经保存的回执。迁移 052 让确认版进入个人知识库文字检索，语义索引须由员工另行选择建立。新草稿不覆盖上次确认，确认新版后旧索引失效。检索、索引和资料问答在使用前复核 Nextcloud 权限与版本，撤权时删除派生文字、向量和受影响的私人回答。迁移 053 将 OCR 接入独立 Worker。员工可选择 DSH 或 Hermes 并确认本页识别，宿主固定来源、页码与版本，聊天模型只收到操作说明。文件只由内网 OCR 服务处理，校对和确认仍由员工完成。单次操作回执可从本页历史恢复，取消会停止后续保存。

部署者用 `HYPER_OCR_URL` 设置固定内网端点，用 `HYPER_OCR_ENGINE` 记录实际安装引擎版本。地址只接受回环、RFC 1918 IPv4 或 Compose 内部服务名，服务不能使用重定向。应用发送 POST，`Content-Type` 为文件类型，`X-OCR-Page` 为从 1 开始的选定页，请求体为原文件字节；内网服务只解析所选页。端点返回 JSON 对象 `{ width, height, blocks }`，每块包含 `kind`、`bounds`、`confidence`、`text`。坐标是页面像素 `[left, top, right, bottom]`，置信度为 0 到 1 或 `null`；表格用换行和制表符分隔行列。未配置识别端点时，已授权员工仍可打开已有结果。公司文件不发送到公共演示端点。

首批使用合成协议响应通过 PostgreSQL 和 Chromium 验证选页、同键回读、并发确认、表格编辑、文件版本变化、撤权清理及手机布局。原生 DSH 与 Hermes 各自通过合成 OCR 协议验证。助手只能处理选定页，改页参数被拒绝，取消期间保留原版本，重启后的回执来自数据库。识别引擎与 Linux 内网的质量和资源测试分别记录。

2026-11-10 用 DeepSeek Flash 与本机 Tesseract.js 7.0.0 做独立链路验证。DSH 与 Hermes 各触发一次合成 PNG 识别，聊天模型均返回 HTTP 200，输入和输出用量分别为 3,085 / 49 和 3,781 / 287 token。CPU OCR 各返回 3 个正文块，标题与样张相符，两个草稿均保持待校对。运行不写入项目对话，完成后清理临时目录。Tesseract 在这里用于证明真实 CPU 识别链路，结构化表格主选引擎另行测试。

容器部署使用专用的 `hyper_runtime` 数据库角色。[部署流水线 42860445370](https://github.com/MkaliezZ/hyper-workspace-next/actions/runs/42860445370) 发现该角色缺少 OCR 来源视图的读取权限，导致加载带资产的助手任务返回 500。初始化脚本现为这一个视图授予只读权限。本机以受限角色复验了来源视图读取、禁止写入和既有角色初始化，相关集成测试通过。修复提交的 [Linux 容器部署 job](https://github.com/MkaliezZ/hyper-workspace-next/actions/runs/42861753511) 已通过。

[CPU 服务首轮 Linux 容器检查 42863084490](https://github.com/MkaliezZ/hyper-workspace-next/actions/runs/42863084490) 通过既有产品容器用例后发现，RapidTable 首次导入会创建包内目录，导致只读 OCR 容器启动失败。现已在镜像构建时完成首次导入，运行时保持只读。

[只读启动复验 42864784410](https://github.com/MkaliezZ/hyper-workspace-next/actions/runs/42864784410) 中 OCR、API 和 Worker 容器均达到健康状态。其后的识别探针漏加载产品运行时使用的 `tsx`，已补齐加载参数。

修正后的 [Linux 部署任务 42866355777](https://github.com/MkaliezZ/hyper-workspace-next/actions/runs/42866355777) 已通过。只读 CPU OCR 容器通过健康检查，API 容器使用正式 `OcrProvider` 读取合成 PNG，返回标题、自动定位表格和全部 12 个预期单元格。

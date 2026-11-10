# 图片 OCR 与扫描件

## OXR 评估

用户指定评估的 OXR 为 SoMarkAI 的 Optical Everything Recognition。2026-11-10 核对代码 `b2ee4ac` 和 OXR-1.0 权重 `c708407`。官方文档支持图像和 PDF，提供 Markdown、JSON 版面块及坐标。自部署的官方配置为 Linux、支持 BF16 的 NVIDIA GPU、兼容 CUDA 13.0 的驱动。低并发测试从单卡 24 GB 显存起步，长文档或更高并发建议至少 48 GB。本地验证机是 Intel x86_64 Mac，使用核显。公司局域网 Linux 服务器硬件待准备。 [固定代码与部署说明](https://github.com/SoMarkAI/OXR/blob/b2ee4ac12ed220bf7fefa74951babf0d3b05e766/README.md) · [固定模型版本](https://huggingface.co/SoMarkAI/OXR-1.0/tree/c708407f9d2b4df658f2543d9132b62bb7221df4)

代码与模型权重各有基于 Apache 2.0 加附加条款的许可证，文本存在差别。两份文本均列出融资额或年收入超过 200 万美元时的商业授权要求。权重另有竞品托管 API 条款，代码另列第三方产品归属标示义务。公库产品保留独立 OCR 服务边界，OXR 作为可选候选，实际采用前按固定版本核对组织适用条款和部署硬件。 [代码许可证](https://github.com/SoMarkAI/OXR/blob/b2ee4ac12ed220bf7fefa74951babf0d3b05e766/LICENSE) · [权重许可证](https://huggingface.co/SoMarkAI/OXR-1.0/blob/c708407f9d2b4df658f2543d9132b62bb7221df4/LICENSE)

## 合成样本实测

在官方公开测试端点提交一页本地生成的图像 PDF。样本为中英混排的采购记录，包含表头和三条数据行。HTTP 200，结果有 1 页和 4 个带边框坐标的版面块。标题、单号、英文说明及 12 个表格单元格与生成稿一致。返回的表格格式为 HTML。坐标的右下边界与左上边界可映射到扫描页面；这次响应未提供逐块置信度。另用同一页生成低分辨率、旋转 2°、模糊并压缩的 JPEG。第二次也返回 HTTP 200，4 个版面块和 12 个单元格仍与生成稿一致，两次都没有逐块置信度。两份输入使用相同内容，覆盖两种输入格式和一次降质，内网自部署、复杂版面及可靠性另行验收。 [官方免费测试服务说明](https://github.com/SoMarkAI/OXR/blob/b2ee4ac12ed220bf7fefa74951babf0d3b05e766/README.md#0--free-api)

## 低成本选型

按用户确认，OXR 保留为有兼容 GPU 和对应授权时的备选。主线先验证 **RapidOCR + ONNX Runtime CPU + RapidTable（SLANet Plus）**。识别和表格推理可在普通 CPU 主机运行，运行时无需逐页购买 OCR API。准备以轻量中英文字检测与识别权重为起点，检测到表格时才运行表格结构模型。全页表格检测还需用同一批样张验证。部署前锁定模型和代码版本，逐项核对权重来源与条款，并测实际页耗时、峰值内存、低清晰度误读和表格单元格准确性。 [RapidOCR 安装与 CPU 推理](https://github.com/RapidAI/RapidOCRDocs/blob/main/docs/install_usage/rapidocr/install.en.md) · [RapidTable 模型与用法](https://github.com/RapidAI/RapidTable)


对照候选 PaddleOCR PP-StructureV3 支持 CPU 推理，输出文本、位置和表格结构。其当前 PaddlePaddle 3.3.1 macOS 发布包为 arm64，本机 Intel 不能直接用该发布包验证。先为 Linux CPU 验证固定模型与依赖，再用同一套合成样本对比中文、英文、扫描和表格。 [PaddleOCR 官方说明](https://www.paddleocr.ai/latest/en/version3.x/algorithm/PP-StructureV3/PP-StructureV3.html) · [PaddlePaddle 3.3.1 发布文件](https://pypi.org/project/paddlepaddle/3.3.1/#files)

在 Intel Mac 上用 Tesseract.js 7.0.0 和本地中英词库完成 CPU 对照。清晰 PNG 的中英标题、编号、说明均可读，模型总体置信度 93，表格未提取。降质 JPEG 的正文仍可读，表格区域有误识别，总体置信度 78。此路线可作为纯文字对照，结构化表格需要版面模型。 [Tesseract.js v7](https://github.com/naptha/tesseract.js/tree/v7.0.0) · [固定中英词库](https://github.com/tesseract-ocr/tessdata_fast/tree/65727574dfcd264acbb0c3e07860e4e9e9b22185)

## 工作台与内网识别协议

迁移 051 保存 OCR 草稿、版本和最后一次确认。知识库 → 企业文件中选择 PNG、JPEG 或 PDF（8 MiB 内），PDF 指定页码后选择“识别这一页”。版面图按返回坐标排列文字与表格块，置信度缺失或偏低时提示校对。表格预览以制表符分隔列，可在校对框修改后确认保存。较早的确认版本可在新草稿旁查看。

后端以当前 Nextcloud 登录、文件 ID、ETag、路径和页码核对来源。只在二进制读取后仍可核验权限和版本时调用配置的内网识别端点，写入前再次校验。来源丢失或版本替换时，已识别内容清理，审计元数据保留。识别失败保留当前草稿和上次确认；同一操作键重试可取回已经保存的回执。语义索引与 DSH/Hermes 操作入口继续开发。

部署者用 `HYPER_OCR_URL` 设置固定内网端点，用 `HYPER_OCR_ENGINE` 记录实际安装引擎版本。地址只接受回环、RFC 1918 IPv4 或 Compose 内部服务名，服务不能使用重定向。应用发送 POST，`Content-Type` 为文件类型，`X-OCR-Page` 为从 1 开始的选定页，请求体为原文件字节；内网服务只解析所选页。端点返回 JSON 对象 `{ width, height, blocks }`，每块包含 `kind`、`bounds`、`confidence`、`text`。坐标是页面像素 `[left, top, right, bottom]`，置信度为 0 到 1 或 `null`；表格用换行和制表符分隔行列。未配置识别端点时，已授权员工仍可打开已有结果。公司文件不发送到公共演示端点。

首批使用合成协议响应通过 PostgreSQL 和 Chromium 验证选页、同键回读、并发确认、表格编辑、文件版本变化、撤权清理及手机布局。识别引擎与 Linux 内网的质量和资源测试分别记录。

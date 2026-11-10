# 图片 OCR 与扫描件

## OXR 评估

用户指定评估的 OXR 为 SoMarkAI 的 Optical Everything Recognition。2026-11-10 核对代码 `b2ee4ac` 和 OXR-1.0 权重 `c708407`。官方文档支持图像和 PDF，提供 Markdown、JSON 版面块及坐标。自部署的官方配置为 Linux、支持 BF16 的 NVIDIA GPU、兼容 CUDA 13.0 的驱动。低并发测试从单卡 24 GB 显存起步，长文档或更高并发建议至少 48 GB。本地验证机是 Intel x86_64 Mac，使用核显。公司局域网 Linux 服务器硬件待准备。 [固定代码与部署说明](https://github.com/SoMarkAI/OXR/blob/b2ee4ac12ed220bf7fefa74951babf0d3b05e766/README.md) · [固定模型版本](https://huggingface.co/SoMarkAI/OXR-1.0/tree/c708407f9d2b4df658f2543d9132b62bb7221df4)

代码与模型权重各有基于 Apache 2.0 加附加条款的许可证，文本存在差别。两份文本均列出融资额或年收入超过 200 万美元时的商业授权要求。权重另有竞品托管 API 条款，代码另列第三方产品归属标示义务。公库产品保留独立 OCR 服务边界，OXR 作为可选候选，实际采用前按固定版本核对组织适用条款和部署硬件。 [代码许可证](https://github.com/SoMarkAI/OXR/blob/b2ee4ac12ed220bf7fefa74951babf0d3b05e766/LICENSE) · [权重许可证](https://huggingface.co/SoMarkAI/OXR-1.0/blob/c708407f9d2b4df658f2543d9132b62bb7221df4/LICENSE)

## 合成样本实测

在官方公开测试端点提交一页本地生成的图像 PDF。样本为中英混排的采购记录，包含表头和三条数据行。HTTP 200，结果有 1 页和 4 个带边框坐标的版面块。标题、单号、英文说明及 12 个表格单元格与生成稿一致。返回的表格格式为 HTML。坐标的右下边界与左上边界可映射到扫描页面；这次响应未提供逐块置信度。另用同一页生成低分辨率、旋转 2°、模糊并压缩的 JPEG。第二次也返回 HTTP 200，4 个版面块和 12 个单元格仍与生成稿一致，两次都没有逐块置信度。两份输入使用相同内容，覆盖两种输入格式和一次降质，内网自部署、复杂版面及可靠性另行验收。 [官方免费测试服务说明](https://github.com/SoMarkAI/OXR/blob/b2ee4ac12ed220bf7fefa74951babf0d3b05e766/README.md#0--free-api)

## 内网实现路线

对照候选 PaddleOCR PP-StructureV3 支持 CPU 推理，输出文本、位置和表格结构。其当前 PaddlePaddle 3.3.1 macOS 发布包为 arm64，本机 Intel 不能直接用该发布包验证。先为 Linux CPU 验证固定模型与依赖，再用同一套合成样本对比中文、英文、扫描和表格。 [PaddleOCR 官方说明](https://www.paddleocr.ai/latest/en/version3.x/algorithm/PP-StructureV3/PP-StructureV3.html) · [PaddlePaddle 3.3.1 发布文件](https://pypi.org/project/paddlepaddle/3.3.1/#files)

在 Intel Mac 上用 Tesseract.js 7.0.0 和本地中英词库完成 CPU 对照。清晰 PNG 的中英标题、编号、说明均可读，模型总体置信度 93，表格未提取。降质 JPEG 的正文仍可读，表格区域有误识别，总体置信度 78。此路线可作为纯文字对照，结构化表格需要版面模型。 [Tesseract.js v7](https://github.com/naptha/tesseract.js/tree/v7.0.0) · [固定中英词库](https://github.com/tesseract-ocr/tessdata_fast/tree/65727574dfcd264acbb0c3e07860e4e9e9b22185)

产品会保留原件的 Nextcloud 版本和当前权限。在员工选定的页上识别，以坐标和可修改文本记录模型输出，人工确认后才作为经核对资料。低清晰度、缺块和未给置信度要可见。识别错误或超时保留上次已确认版本，来源撤权时清理内容和检索索引。人工与 DSH/Hermes 经过同一服务；公司文件使用部署者控制的内网识别服务。

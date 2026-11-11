# 固定内核的表格兼容性证据

以下为 `runtime.lock.json` 中 Collabora CODE 26.04.6.1.1 与同版 pyuno 的合成文件实测，不代表所有 Excel/OOXML 文件保真，也不代替公司环境验收。文件由测试库生成和独立读取，业务改写始终由同一个 Collabora 内核完成。

## 命名表与既有结构

`tests/fixtures/office-roundtrip.py` 创建 `Inputs!A1:D3` 的 `SyntheticItems` 命名表。保存后的断言检查对象名称、范围、四个列名、表内 autoFilter、`TableStyleMedium2` 和条纹行。原有跨表公式、缓存30/10/40、筛选、验证列表与图表断言继续执行；不能只证明可见单元格存在便宣称命名表保留。

## 发现的真实透视差异

初始透视样本使用 `Inputs!A1:C3`、Item 行字段、Quantity 的 SUM 和两个缓存记录。固定内核保留了透视对象、源范围、字段、SUM 及缓存记录，但把缓存中的默认 `Grand Total` 标签重建为 `Total Result`。随后为原定义显式加入 `grandTotalCaption="Grand Total"`，仍然丢失该属性并改变显示。严格原始断言未放宽。

直接 UNO 诊断也显示：加载后 `GrandTotalName` 为 null；手动设为 `Grand Total` 能修改当次显示，但保存仍不导出 `grandTotalCaption`。因此不能借内存中的正确显示声称文件保留。服务在载入前对显式总计标题返回 `unsupported_pivot_caption`，不生成新副本。

另一项诊断把源数量3改4。`calculateAll()` 后透视仍是3、总计5；固定 `DataPilotTable.refresh()` 后才成为4、总计6。这是加入显式透视刷新和独立聚合回读的原因。公开接口依据：[DataPilotDescriptor.GrandTotalName](https://api.libreoffice.org/docs/idl/ref/servicecom_1_1sun_1_1star_1_1sheet_1_1DataPilotDescriptor.html)、[DataPilotTable.refresh](https://api.libreoffice.org/docs/idl/ref/servicecom_1_1sun_1_1star_1_1sheet_1_1DataPilotTable-members.html)；实际固定版本行为以上述实测为准。

失败日志保留于本地 `.runtime/office-pivot-local.log`、`.runtime/office-pivot-caption.log`，固定属性/刷新的诊断为 `.runtime/office-pivot-uno.log`。这些仅含合成数据，不提交运行产物。`--pivot` 继续生成带显式标题的失败样本，`verify ... --pivot` 继续要求标题、定义、缓存及显示完整保留；正常 HTTP 回归要求明确422，而不是忽略失败断言。

## 当前通过的受控子集

另一个明确没有自定义标题的样本用 `--pivot-default` 生成，默认总计标签为内核的 `Total Result`。服务限定一个透视表、本地有界矩形源、不同输出工作表、一个文本分组字段和一个数值SUM字段。源内公式、外部/命名源、复杂布局和显式标题均拒绝。默认呈现可能由内核重建；不会将显式原文也按默认处理。

批处理禁止改透视输出、源表头和分组键。对数值源的修改会刷新透视、再次重算公式，并检查每个分组和总计相对源数据的结果（浮点比较相对/绝对容差均为1e-12）。保存后核对定义、全部缓存记录和同核重开值；任一不符则拒绝输出。所有 ZIP 检查只读取元数据，业务输出没有 XML patch。

显式行/列标题、字段/小计标题、自动排序/筛选、额外小计和自定义数字格式也不在此子集内。固定内核会归一化部分默认展示/交互选项（例如 outline、itemPrintTitles、showAll）；当前保证的是列明的源范围、字段、SUM、对象、单元格数值与缓存，不能据此声称所有透视布局/显示选项或字体样式完全保留。

真实 HTTP 回归已验证：无关标记编辑保持透视，源数量3→4生成行值4/2及总计6；独立夹具还验证命名表、图表、验证列表、跨表公式及相应缓存40/10/50。回归在512MiB/1CPU、无网络容器中串行执行并检查失败/成功后的临时目录与进程清理。实际日志 `.runtime/office-pivot-supported.log`，首个通过输出 `.runtime/office-batch-PBfako/output`。本地使用已校验同核镜像并只读挂载当前runtime，官方下载构建曾因下载停滞终止；正式干净镜像构建继续由CI独立验证。

独立审查补充了改名连接/透视部件与其他显式caption的拒绝回归。最终Linux协议12项及真实透视HTTP回归通过，日志 `.runtime/office-pivot-final.log`、输出 `.runtime/office-batch-Uj1fza/output`。数字格式按实际 `formatCode=General` 核对；内核导出的General使用自定义编号164，不能只认内置编号0，也不能因此允许任意自定义格式。

扩展透视兼容性时，应新增未支持结构的原始断言和真实固定内核证据，再扩大允许范围。不能删除明确标题断言、把缓存不更新当成公式重算成功，或引入另一个办公内核来绕过此限制。

`b3eaf5c` 的 [CI 42930241845](https://github.com/MkaliezZ/hyper-workspace-next/actions/runs/42930241845) 已完成干净镜像构建、12 项 Linux 协议检查、三格式真实 HTTP 往返及两个透视输出验证，另有应用容器调用私有批处理服务的检查通过。这补足上述本地下载停滞之后的正式构建证据。

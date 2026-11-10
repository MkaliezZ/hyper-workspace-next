# 锁定依赖与许可记录

本项目自身采用根目录 [LICENSE](../LICENSE)。第三方代码的许可证、版权和通知分别保留，不能由项目许可证覆盖。依赖版本、源码提交和镜像摘要以 [runtime-lock.json](runtime-lock.json) 和各 lockfile 为准。

## npm 声明清单

[机器可读清单](dependencies/npm-licenses.tsv) 从主仓库、DSH 运行时和本机向量运行时的三个 `package-lock.json` 离线生成：共 1,002 条安装记录，包含开发/可选包和不同目录中重复安装的版本；这个数量不是唯一组件数。文件头保存输入 lock 的 SHA-256，每行保存路径、版本、许可声明来源和开发/可选标记。

两个包的 lock 与安装包元数据均没有 `license` 字段：`busboy@1.6.0` 和 `streamsearch@1.1.0`。清单保留 `UNKNOWN`，不编造 SPDX 元数据；同时按原字节保留其实际 [busboy 许可文本](dependencies/license-texts/busboy-1.6.0-LICENSE.txt) 和 [streamsearch 许可文本](dependencies/license-texts/streamsearch-1.1.0-LICENSE.txt)，清单包含文本摘要。缺少元数据字段不能解释为没有许可文本。

从固定 lock 安装依赖后运行：

```sh
node scripts/dependency-inventory.mjs --write
node scripts/dependency-inventory.mjs --check
```

命令不联网；缺失声明只读取版本一致的安装包元数据和原许可文本，检查会比较生成清单及许可原文。重新生成前应审查版本/声明变更，不能把新结果覆盖当作兼容性或许可义务已确认。

## 其他层

原生 DSH 和 Hermes 的实际上游许可文本分别保留在 [DSH](../runtime/dsh/THIRD_PARTY_DSH_LICENSE.txt) 与 [Hermes](../runtime/hermes/THIRD_PARTY_HERMES_LICENSE.txt)。这份 npm 清单没有覆盖 Hermes/Python 全部依赖、系统包、Nextcloud/Talk、基础镜像或模型权重；这些层仍须与其固定版本的原许可和完整运行镜像清单逐一核对。运行镜像已有系统包版本记录 `runtime/image-packages.txt`，它是版本记录而非许可证审查结论。

当前证据为离线生成与一致性检查通过；不据此宣称整个产品的第三方许可审查或分发通知已完成。

## Office 同核批处理

批处理内核与在线编辑器共用固定 Collabora CODE 镜像，不安装另一套办公引擎。[Office runtime 锁](../runtime/office/runtime.lock.json) 保存镜像摘要、同版官方 pyuno 包 URL/大小/SHA256、Python 版本与原核心文件摘要；构建时验证包字节与核心文件不变，二进制依赖不进仓库。官方包内 SPDX SBOM 与上游许可随镜像保留，MPL-2.0/PSF-2.0 及附带库的声明和分发边界见 [runtime 说明](../runtime/office/README.md#固定依赖与许可)。本项不将 CODE 测试结果解释为商业支持或全产品许可审查完成。

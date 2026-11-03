# 日历排期：开发中

当前只有后端 CalDAV Provider 基础，不是已交付日历功能。扩展范围见 [v2.0 基线](PHASE2-BASELINE.md)；完整验收仍包括邀请、重复事件编辑、忙闲排期、项目/任务关联、产品回执、人工界面与 DSH/Hermes。

## 来源边界

`apps/api/src/providers/calendar.ts` 定义 CalendarProvider；`nextcloud-calendar.ts` 使用员工来源凭据和后端解析的 remote UID。日历路径限制在本人 CalDAV calendar-home，支持来源挂载到本人根下的共享日历；实际共享路径兼容性待真实 Nextcloud 验证。不使用模型指定身份、服务器或任意 URL。

PROPFIND 按 XML namespace 识别日历及当前读取/新增/修改/删除权限。REPORT 查询采用半开 UTC 时间窗口，单次最多 93 天、500 对象、2 MiB；单对象最多 256 KiB。不静默截断结果。返回完整 VCALENDAR，保留 VTIMEZONE、重复主事件/例外/EXDATE；REPORT 的 XML 换行规范化回 CRLF，GET 保留来源文本。原始查询不展开重复实例。新增 occurrences 查询将相同有界窗口交给来源 CalDAV expand，返回标记为 expanded 的只读表示；编辑前必须重新读取原始主事件。calendar-projection 将已展开事件转成日期/UTC 实例，缺失时区或浮动时间保持明确状态，不能偷偷采用服务器本地时区；来源未展开、反向时间、重复实例或超过1000实例则整体失败。忙闲计算仍未接入。

GET 要求 ETag。创建使用 If-None-Match:*，替换/删除要求确切强 ETag；412 不覆盖他人更新。所有请求禁止重定向，来源 href 限定当前员工根与所选日历；XML DTD、重复关键属性、外部 URL、路径穿越及部分响应拒绝返回。

此 Provider 不自动重试写入。网络中断、重定向/5xx、非预期成功状态标记 CalendarDeliveryUnknown；调用方必须先持久化意图并按 UID/源版本/操作标记回读和对账，再形成业务回执。PUT 201/204 只代表来源接受，不能宣称完整动作成功。当前还未接产品服务，因此没有面向用户或 AI 开放写接口。

普通对象 PUT 暂拒绝 METHOD/ATTENDEE/ORGANIZER，避免绕过明确授权隐式发邀请；后续必须实现专用排期服务和真实邀请/取消/状态验收，这项保护不构成邀请功能已完成或永久取消。

## 验证与未完成项

协议用例 `tests/calendar-provider.test.ts` 覆盖权限、UID 与登录名不同、命名空间、多 propstat、限定时间范围、完整重复/时区内容、路径/DTD/大响应、条件写入、撤权/版本冲突、不明结果与不自动重放。首次用例发现 XML 换行规范化与 iCalendar CRLF 的差异，已在 REPORT 读取时恢复规范换行，保持主事件和例外内容；实际命令结果随提交更新。

尚未完成：产品持久意图与回执、业务 API、项目/任务关系、时区/全天/重复实例与冲突计算、邀请及回复/取消、人工蓝白黑 UI、双执行器业务工具、真实来源/真实模型验收。没有新增数据库迁移或对现有实例写入；Provider 回退为移除新增文件/依赖，外部既有动作若产生须先核对来源。

技术依据：[RFC4791 CalDAV](https://www.rfc-editor.org/rfc/rfc4791.html)、[ICAL.js](https://github.com/kewisch/ical.js)。依赖锁定 ical.js 2.2.1，MPL-2.0，许可证清单随 lock 更新。

本地验证（2026-11-04）：全库 75 单元（含新增 10 日历协议用例）、全工作区类型检查、构建、npm audit（0 漏洞）、依赖许可证清单校验、v1.0 冻结包校验通过。新增真实 CalDAV 用例已纳入 Nextcloud job，当前尚未运行通过，不据协议测试声称真实兼容。构建沿用既有 bundle 大小提示，未改前端。

追加本地验证：新增实例投影 6 项及来源展开请求协议 1 项，全库 82 单元与全工作区类型检查通过。真实来源用例补入三次重复事件展开及来源版本一致性断言，等待新仓库 CI 实测。当前未变更前端，不以构建代替渲染验收。

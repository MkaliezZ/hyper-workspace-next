# 日历排期：开发中

当前已接后端 Provider、产品意图/回执及人工蓝白黑界面；完整日历阶段仍在开发。扩展范围见 [v2.0 基线](PHASE2-BASELINE.md)；完整验收仍包括邀请、重复事件编辑、忙闲排期、项目/任务关联、产品回执、人工界面与 DSH/Hermes。

## 来源边界

`apps/api/src/providers/calendar.ts` 定义 CalendarProvider；`nextcloud-calendar.ts` 使用员工来源凭据和后端解析的 remote UID。日历路径限制在本人 CalDAV calendar-home，支持来源挂载到本人根下的共享日历；实际共享路径兼容性待真实 Nextcloud 验证。不使用模型指定身份、服务器或任意 URL。

PROPFIND 按 XML namespace 识别日历及当前读取/新增/修改/删除权限。REPORT 查询采用半开 UTC 时间窗口，单次最多 93 天、500 对象、2 MiB；单对象最多 256 KiB。不静默截断结果。返回完整 VCALENDAR，保留 VTIMEZONE、重复主事件/例外/EXDATE；REPORT 的 XML 换行规范化回 CRLF，GET 保留来源文本。原始查询不展开重复实例。新增 occurrences 查询将相同有界窗口交给来源 CalDAV expand，返回标记为 expanded 的只读表示；编辑前必须重新读取原始主事件。calendar-projection 将已展开事件转成日期/UTC 实例，缺失时区或浮动时间保持明确状态，不能偷偷采用服务器本地时区；来源未展开、反向时间、重复实例或超过1000实例则整体失败。忙闲计算仍未接入。

GET 要求 ETag。创建使用 If-None-Match:*，替换/删除要求确切强 ETag；412 不覆盖他人更新。所有请求禁止重定向，来源 href 限定当前员工根与所选日历；XML DTD、重复关键属性、外部 URL、路径穿越及部分响应拒绝返回。

此 Provider 不自动重试写入。网络中断、重定向/5xx、非预期成功状态标记 CalendarDeliveryUnknown；调用方必须先持久化意图并按 UID/源版本/操作标记回读和对账，再形成业务回执。PUT 201/204 只代表来源接受，不能宣称完整动作成功。CalendarService 已接持久意图与回读；人工写接口已开放，AI 业务入口尚未接通。

普通对象 PUT 暂拒绝 METHOD/ATTENDEE/ORGANIZER，避免绕过明确授权隐式发邀请；后续必须实现专用排期服务和真实邀请/取消/状态验收，这项保护不构成邀请功能已完成或永久取消。

## 验证与未完成项

协议用例 `tests/calendar-provider.test.ts` 覆盖权限、UID 与登录名不同、命名空间、多 propstat、限定时间范围、完整重复/时区内容、路径/DTD/大响应、条件写入、撤权/版本冲突、不明结果与不自动重放。首次用例发现 XML 换行规范化与 iCalendar CRLF 的差异，已在 REPORT 读取时恢复规范换行，保持主事件和例外内容；实际命令结果随提交更新。

尚未完成：项目/任务关系、完整时区及重复规则/单次例外编辑、忙闲/候选排期、邀请与回复/取消、双执行器日历工具和真实模型验收。新增 044 迁移只应用于独立测试数据库；原交付/公司环境未升级。

技术依据：[RFC4791 CalDAV](https://www.rfc-editor.org/rfc/rfc4791.html)、[ICAL.js](https://github.com/kewisch/ical.js)。依赖锁定 ical.js 2.2.1，MPL-2.0，许可证清单随 lock 更新。

本地验证（2026-11-04）：全库 75 单元（含新增 10 日历协议用例）、全工作区类型检查、构建、npm audit（0 漏洞）、依赖许可证清单校验、v1.0 冻结包校验通过。新增真实 CalDAV 用例已纳入 Nextcloud job，当前尚未运行通过，不据协议测试声称真实兼容。构建沿用既有 bundle 大小提示，未改前端。

追加本地验证：新增实例投影 6 项及来源展开请求协议 1 项，全库 82 单元与全工作区类型检查通过。真实来源用例补入三次重复事件展开及来源版本一致性断言，等待新仓库 CI 实测。当前未变更前端，不以构建代替渲染验收。

## 产品业务与人工界面

- `CalendarService` 与 `calendar-codec`：创建 UTC 单次/全天事件；修改系列文字时保留所有 VTIMEZONE、RRULE/EXDATE 与实例例外；单次时间可改，重复时间调整留待专用规则编辑。参会事件暂拒绝普通修改/删除路径，专用邀请服务仍必须补齐。
- 044 保存私人主体、来源连接/UID、精确日历/对象/版本、请求键、结构化计划、期望内容/摘要、尝试状态与观察回执。准备不写来源；并发 apply 只有一个可领取，创建 If-None-Match、更新/删除 If-Match；主体/成员/来源权限在业务及事务边界重新检查。
- 只有源 UID、产品操作标记、完整语义摘要均一致才记录 matched；删除记录 absent，表示已核对不存在，不捏造删除动作归因。未知结果只核对，不重发；HTTP 明确拒绝记录失败。取消前未发出则 cancelled；已发生效果仍据实保存，同时显示停止请求。
- 桌面7列/手机单列周视图、新建/修改/删除、刷新、只读控制、时区标记、当前员工最近30条操作；未知回执刷新后仍可核对，已准备计划可再次查看后执行。所有标题/正文作为文本渲染。来源失权清理旧内容。
- 普通手动 API：GET `/api/calendar/calendars`、POST `/api/calendar/query`、GET/POST `/api/calendar/commands`、GET `/api/calendar/commands/:id`、POST `/:id/apply`（confirmed=true）、`/:id/reconcile`、`/:id/cancel`。身份来自登录，输入拒绝 actor/服务器/任意URL；AI以后共用该业务服务，不能绕过授权调用 Provider。
- 配置：Nextcloud 企业登录与成员组就绪后，`NEXTCLOUD_CALENDAR_ENABLED=true`；Compose API/Worker 共用开关。开发可用进程环境 `WEB_PORT`/`API_PORT` 启动隔离端口，Playwright 可指定 `HYPER_TEST_ORIGIN`；默认仍为5173/3100。

## 本批验证与故障记录

本地独立PG：全库262项（原255+7日历），覆盖并发、幂等、私有主体、旧版本、写后篡改、发送前/后断线、撤权与取消、真实Nest HTTP认证及确认语义。新增4项codec单元验证文本转义、日期、保留遗漏字段/重复例外与语义摘要。界面2项：桌面1504×1045、手机390×844，人工建改、刷新后核对、禁止未知重发、失权清理；Browser plugin not available，因此使用现有Playwright。页面身份/非空/无框架覆盖层/控制响应/无页面异常/无横向溢出均通过；截图见README，资料为协议fixture，不冒充真实来源或模型。

首次本地HTTP测试启动失败因工作目录未使用API tsconfig，修正后7项通过。首次整库回归缺少解析运行环境且未传DEMO_MODE，补齐锁定Python依赖并按CI环境重跑；同时修复新增备份fixture参数类型冲突，完整262通过。失败日志保留在本机/tmp，不将准备问题归为已验证通过。

首轮公库CI `dc5488f`：verify/deployment成功，来源18过/1新增日历展开失败。[失败运行](https://github.com/MkaliezZ/hyper-workspace-next/actions/runs/41721739129)。在阿里杭州临时私有Nextcloud仅创建一个合成日历与事件，取回expanded XML并清理；实际Sabre将CR序列化为数字实体`&#13;`，fast-xml-parser5.11.2默认未解码数字引用，导致ICS envelope解析失败。现显式支持数字实体及五个XML预定义实体，单次解码避免把字面`&amp;#13;`再次转义；DTD仍拒绝，响应/展开大小有界。真实合成响应本地重放得3个正确实例，新增回归保护十六进制Unicode及字面实体。仍需修正提交的完整来源CI，不把重放当作完整实测。

## 迁移、恢复与回退

044新增表不改已有业务表。产品备份恢复将prepared/applying日历操作隔离为recovery_required，不允许恢复旧快照后再发外部动作；新增备份fixture同时覆盖两态。尚未把此版本部署到旧交付试用实例。

回退前关闭日历开关并停止写入，核对所有applying/recovery_required；保留回执/计划供人工对账，不能直接删除仍待核对的表。若全为已核对的合成数据且确认不再需要，可备份后移除044表及相应迁移记录，再回到旧代码；生产数据回退须保留归档，不把删表当作撤销来源事件。

追加证据：87单元、262数据库/HTTP、全工作区类型/构建、npm审计（0漏洞）、许可证清单与冻结包通过。完整本地UI首轮因旧断言固定5173而不适用于独立5174端口，已统一测试Origin及页面身份断言，未放宽服务端Origin检查。修正后80项中79过，唯一失败是新克隆未安装DSH而被明确拒绝；当前按锁定版本补齐原生运行环境，不能把该轮记成80通过。日历2项本身通过。已准备计划可查看明确目标后续做，长字段节选只读，更新仅提交改动字段，保留来源全文。

另一次阿里杭州私有源合成验证：直接写入本产品codec生成的单次事件，GET回读后的完整语义摘要相同，操作标记保留；该合成日历已删除。此结果仅证明来源往返，不替代产品登录/UI/完整CI或真实模型。

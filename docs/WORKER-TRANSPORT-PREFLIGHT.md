# 可选 Worker 连接预检

[中文](#可选-worker-连接预检) · [English](#english)

本机试用观察到进程首次 HTTPS 请求出现 `ECONNRESET` 或建连超时，后续请求成功。尚未将其归因于某个供应商或 Node 缺陷。此选项用于在 Worker 开始接收任务前，先建立一次无凭据的模型列表连接；默认安装不启用。

## 启用

在私有部署配置中设置明确的无凭据模型列表 URL，例如本次实际使用的公开端点：

```dotenv
HYPER_WORKER_PREFLIGHT_URL=https://api.deepseek.com/models
```

在**完整现有 Compose 组合后**追加 `-f deploy/compose.worker-preflight.yaml`，再以原来的配置、项目名和数据卷启动 Worker。示例只展示追加方式：

```bash
# 原来只有基础 Compose 的安装示例；已有来源/OCR/Office/代理组合须保留全部 -f。
docker compose --env-file .env.compose \
  -f compose.yaml -f deploy/compose.worker-preflight.yaml \
  up -d --no-build --wait worker
```

该叠加文件只读挂载仓库脚本，在原 Worker 命令前预加载；保留 `tsx`、运行身份、数据库配置、运行卷与标准健康检查。健康检查不会重新加载预检脚本，也没有定时网络探测。仓库源码中的脚本必须与所选发布版本一起保留。

## 行为与边界

- 仅向指定 HTTP(S) `/models` 端点发出 GET，无 Authorization、Cookie、提示词或请求正文；URL 不得含用户信息、查询或片段。
- 最多 3 次，每次最多 15 秒；禁止重定向，不记录响应正文或完整错误。小响应读取完毕，大响应在 64 KiB 后取消读取。
- 收到任意 HTTP 响应只表示已到达传输端点，包括本次收到的 401。日志始终记录 `modelVerified:false`；连接配置和真实模型业务仍须另行验证。
- 网络失败耗尽后 Worker 继续启动。预检不改变模型网关，不重试模型生成，不重放业务动作，不绕过当前权限、版本、限额或未知结果核对。
- 仅延长 Worker 启动健康宽限期至 60 秒；后续健康判断仍来自数据库心跳。移除该叠加文件即可恢复原命令，不改变数据或密钥。

## 验证

`tests/worker-transport-preflight.test.ts` 通过实际子进程与本机 HTTP 服务验证可选启动、冷连接恢复、重试上限、拒绝重定向和敏感 URL 拒绝。初次 Windows 路径需转换为文件 URL的问题已修正，最终 Windows 与 Linux Node 24 均 5/5 通过。

实际 Compose 合并配置核对了只读身份、脚本挂载、原健康命令与无 `NODE_OPTIONS` 覆盖；使用本机现有软件镜像、已加密模型连接和真实来源，重启 Worker 后第一项 DSH 审批状态回读成功。此读取没有新增审批票或来源写入。完整源码 CI 以发布清单对应提交为准。

## English

This opt-in preflight addresses observed first-request HTTPS connection resets/timeouts in the local pilot. The root cause has not been attributed to a particular provider or Node defect. Default deployments remain unchanged.

Set `HYPER_WORKER_PREFLIGHT_URL` to an explicit unauthenticated HTTP(S) model-list endpoint, such as `https://api.deepseek.com/models`, and append `deploy/compose.worker-preflight.yaml` to the **entire existing Compose file combination**. Retain source, OCR, Office and proxy overlays. The example above only illustrates adding the overlay to a base deployment.

The worker preloads a read-only repository script before its usual command. It sends GET without API keys, cookies, prompts or generation bodies. URLs with credentials, query strings or fragments are rejected, and redirects are never followed. There are at most three attempts, each bounded to 15 seconds. Small response bodies are drained; large ones are cancelled after the 64 KiB threshold. Response bodies and free-form errors are not logged.

Any HTTP response indicates transport reachability only; even a 401 is logged with `modelVerified:false`. Exhausted failures do not prevent worker startup. No model transport is replaced, no generation or business action is replayed, and authorization/version/budget checks remain intact. The 60-second startup health grace period leaves normal database-heartbeat checks unchanged. Health-check processes do not rerun this preflight.

Five subprocess/loopback-network regression scenarios pass on Windows and Linux Node 24. The merged Compose configuration and an actual container restart were checked; the first subsequent native DSH request read an existing approval through the real model and business service. Full-source CI remains tied to the exact release manifest revision.

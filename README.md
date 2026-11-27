# dsh-loopback-direct

给 DSH 的**本机模型**（WorkBuddy 等）在开启手动代理后仍然直连。

## 问题

WorkBuddy 适配器把模型服务绑在 `127.0.0.1` 上，端口每次启动随机分配。DSH 的桌面适配器会把模型请求改写成：

```
http://127.0.0.1:<转发器端口>/bili/http://127.0.0.1:<shim 端口>/v1/chat/completions
```

转发器（billion-context）解析出原始 URL 后**重新选择出站代理**。它的 `resolveProxyDecision()` 里有 provider 专属规则、有全局手动代理，**唯独没有「目标 host 是回环地址就直连」这一条**。于是开启手动代理后，发往本机 shim 的请求也会被塞进代理，表现为：

- `502 proxy-reset UND_ERR_SOCKET 127.0.0.1:51023`
- 客户端重试 3 次后 503
- 远端模型正常（它本来就该走代理）

## 修法

在转发器 `resolveProxyDecision()` 里、provider 专属规则之后、全局代理分支之前插入一行：

```js
if(target&&/^(?:localhost\.?|127\.…|\[::1\]|\[::ffff:127\..*\])$/i.test(target.hostname))return{source:"loopback-direct"};
```

三点说明：

1. **位置正确**：provider 显式规则仍然最优先；只有未显式配置代理的请求才继续判回环；其余继续走宿主原策略（手动代理、系统代理、直连）。
2. **端口无关**：判定的是 hostname，不是完整 URL，所以 shim 换端口自动生效。
3. **不用转发器自带的 `hostIsLoopback()`**：它用 `startsWith("127.")`，会把 `127.0.0.1.example.org` 这类公网域名也判成回环。这里用严格正则。

## 用法

```bash
# 看状态（转发器安装位置、版本、补丁状态、最近一次出站决策）
node cli.js status

# 打补丁（自动备份到 dist/index.js.dsh-loopback-direct.<hash>.bak）
node cli.js patch

# 重启 DSH，然后验证
node cli.js verify

# 回滚
node cli.js revert
```

打补丁后**必须重启 DSH**：转发器是独立进程，改磁盘不会热更新。

## 为什么不做成纯插件

`billion-context` 没有暴露「第二跳 dispatcher 选择」的扩展点：

- `egressTransforms` 只改写 body/headers，**不改变出站 dispatcher**；
- 桌面插件面（`dist/agent/dsh-native.js`）里没有 proxy 配置 API，那套 `resolveProxyDecision` 只在转发器进程里活着；
- 转发器入口由 `process.argv[1]` 决定，并对入口做 sha256 指纹，**换入口文件会被拒绝 attach**。

所以只能改转发器源码。本插件负责把「改源码」变成可维护的流程：自动定位、版本校验、锚点唯一性校验、备份、回滚、真实验证。

## 验证口径

「分流已启用」不能只看设置页。`verify` 做的是：

1. 读转发器 `/__bili/upstream` 拿到真实 `connectionUrl`（含 shim 当前端口）与当前 `mode`；
2. 把这个回环 URL 交给转发器真实的 `/bili/` 入口，走完整两跳；
3. 判定 `reached`（到达上游，任何 HTTP 状态码都算）还是 `proxy-failure`（502 + proxy-reset）；
4. 要求磁盘上确实处于「已打补丁」状态（避免运行中残留旧补丁版造成误判）。

**判定依据是行为，不是日志行。** 未打补丁且转发器挂了代理时，回环请求必被塞进代理并从代理拿回
`proxy-reset / UND_ERR_SOCKET`（实测 7.1s、502）；打补丁后同一请求直接到达上游（实测 401、4~7ms）。
所以「挂了代理仍到达」本身就是分流的直接证据。`bili.log` 的 `[upstream-proxy]` 只用于展示——
转发器按 `host|proxy|source` 去重，同一端口同一来源只打一行，日志会滚出读取窗口，不能当唯一判据。

direct 模式下转发器不挂代理，回环本来就直连，因此配 `confirmed` 表示「补丁在位 + 请求到达」。

## 应急方案（不改代码）

如果不想改转发器源码，可以给转发器配置加 provider 路由（`proxy:""` 表示直连）：

```bash
curl -X PUT http://127.0.0.1:18787/__bili/config \
  -H 'content-type: application/json' \
  -d '{"providers":{"http://127.0.0.1:51023":{"proxy":""}}}'
```

实测有效（日志 `source=provider-direct`），但 **key 是含端口的具体 URL，shim 换端口后失效**，不满足「端口变化自动生效」。

## 适用版本

- billion-context **0.1.216**（已实测，`dist/index.js` sha256 `0282b953…`）
- DSH Desktop 2.0.24-next

其它版本：`status` 会显示 `patchable` 与锚点数量。锚点不唯一或缺失时插件拒绝打补丁，不会盲改。

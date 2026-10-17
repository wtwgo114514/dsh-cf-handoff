# dsh-cf-handoff — Cloudflare 人机验证的人工交接层

**中文** ｜ [English](README.md)

给 [DSH](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）的 `web_fetch` 工具加一层
「撞到 Cloudflare 验证就交给真人」的补丁。

---

## 这个插件干什么

`web_fetch` 抓一个被 Cloudflare 保护的页面时，拿回来的不是网页内容，而是一小段
`Just a moment...`（HTTP 403）。模型看到的是一段「正文」，它不会知道自己其实什么都没读到 ——
于是要么编内容，要么把那段 JS 壳子当真。

这个插件在两者之间插一层：

```
模型调用 web_fetch
      ↓
抓取 → 判定这是不是 Cloudflare 拦截
      ↓ 是
把「被拦了 + 网址 + 下一步该做什么」变成一个**带错误码的结果**返回给模型
（可选：顺手用你的默认浏览器打开一个引导页）
      ↓
模型用 ask_user_question 问你：「验证过了吗？」
      ↓
你说「过了」→ 再抓一次   ｜   你粘贴正文 → 直接当结果   ｜   你说「算了吧」→ 明确报页面拿不到
```

**核心原则：任何分支都不会卡死，也不会拿空内容骗模型。** 每一条没恢复的路径都是一个
**带网址的错误码**，而不是一段空白。

## 它不干什么（非目标）

- ❌ **不自动过验证**。没有 solver，不接打码平台，不逆向 Turnstile。
- ❌ **不偷 cookie**。`dsh-web-fetch-http` 本身没有 cookie jar，插件也不去翻你的浏览器档案。
- ❌ **不控制浏览器**。DSH 根本没有浏览器层（详见下面「为什么用你自己的浏览器」）。

它的价值在于：**承认有些页面只有人能过，然后把这一步干净地交出去。**

## 为什么用你自己的浏览器

原设计假设 DSH 有 `ctx.browser` 服务（`navigate` / `isHeadless` / `setHeadless` …）。
**核实源码后确认：这个服务不存在。** 没有 playwright、没有 CDP、没有 `browser_*` 工具，
全仓搜不到任何浏览器控制能力。

所以「让人去点验证」只能这样落地：

1. 插件写一个**本地引导页**到系统临时目录；
2. 用系统默认方式打开它（Windows 走 `Invoke-Item`，macOS 走 `open`，Linux 走 `xdg-open`）—— 于是它落到你的默认浏览器里；
3. 引导页自动跳转到被拦的网址，你正常过验证；
4. 过完，你回到 DSH 的会话里点一下/粘贴一下。

顺带记一个坑：**直接把 `https://…` 交给「打开路径」的接口是打不开的**（Windows 上会报
`Cannot find drive. A drive with the name 'https' does not exist.`）。必须落盘成真实文件再打开。
这就是那个引导页存在的唯一原因。

## 安装

```bash
git clone https://github.com/wtwgo114514/dsh-cf-handoff
dsh plugin add ./dsh-cf-handoff --profile web
```

`dsh plugin add` 会自动认领包里的 `cordis.patch.yml`（清单声明了 `dsh.bundle.patch`），
所以你不用手写任何配置行。确认一下：

```bash
dsh plugin list --profile web     # bundles 里应该出现 dsh-cf-handoff
```

**改完 `lib/*.js` 必须重启 DSH。** `patchReload: live` 只重载 patch 层，不会重新 import
已经加载的模块 —— 这个插件第一版就是被这一点坑过。

## 怎么用

装好、重启，然后让模型抓一个被 Cloudflare 保护的页面即可，不需要额外指令。
默认行为是「报告 + 告诉模型下一步」，你会在会话里看到类似：

```
Error: Cloudflare challenge on https://example.com/ — the page content was NOT retrieved.
Cloudflare challenge ("Just a moment..."): HTTP 403, score 41 [...signals...].

Await the human with ask_user_question, then follow their answer — ...
Put the URL in the question's `detail` field as a markdown link ...
[web_cloudflare_challenge]
```

模型应该接着问你，你选一个即可。

## 两种模式：谁在等

**这是理解本插件最重要的一节。**

`web_fetch` 有 **30 秒硬超时**（`fetchTimeoutMs` 默认 `30000`），而这个超时不只是失败：
它会**用自己的话替换掉结果**，把插件想说的网址和错误码一起吞掉。所以「在工具调用里等人过验证」
在默认配置下注定失败 —— 等 90 秒只会得到一句 `tool call timed out after 30000ms`，
比不做交接信息更少。

| 模式 | 谁在等 | 什么时候用 |
|---|---|---|
| `notify`（默认） | 抓取本身不等；由没有超时的 `ask_user_question` 等 | 任何保持 30 秒默认预算的部署 |
| `inline` | 抓取本身等，收到答复后重试一次 | 仅当调用方的工具预算已调高到 `minHumanBudgetMs` 以上 |

`notify` 模式下抓取仍然做了所有能做的事：写引导页、开浏览器、抛出带网址和错误码的提示 ——
它只是**拒绝亲自当那个等待**。

`inline` 模式会被**预先拦截**：发起等待前先读实际预算，不够就拒绝，并说清原因：

```
the tool call is budgeted at 30000ms but a human round trip needs at least 120000ms,
so an in-call wait would be killed by the timeout policy and its generic message
would replace this one (raise tool-web's fetchTimeoutMs to allow it)
```

## 配置

```yaml
# 你的 profile 里（例如 ~/.dsh/profiles/web/cordis.patch.yml）
- id: cf-handoff
  config:
    mode: notify
    minScore: 12
    openBrowser: true
```

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `minScore` | `12` | 检测阈值。调高到 `16` 以上＝更少打扰；调到 `~6`＝最大召回 |
| `mode` | `notify` | `notify`＝报告后返回；`inline`＝在抓取内等待（需先调高工具预算，见上节） |
| `minHumanBudgetMs` | `120000` | `inline` 等待允许的最小工具预算 |
| `maxAttempts` | `1` | 每次抓取允许几次交接；`0`＝只报告不等待 |
| `openBrowser` | `true` | 是否用默认浏览器打开引导页 |
| `autoNavigate` | `true` | 引导页是否自动跳转（关掉＝等你点链接） |
| `reopenAfterMs` | `300000` | 同一网址在该毫秒内复用已开的标签页，避免刷一串标签 |
| `tmpRoot` | 系统临时目录 | 引导页写在哪 |

⚠️ **按 id 覆盖配置是整体替换，不是逐键合并。** 只写 `minScore` 会让其他键回落到插件自己的
默认值，而不是 bundle 层的值。**你在意的键都要重新写一遍。**

`pentest` 预设里 `web_fetch` 是关着的（`fetch: false`），此时插件空转，什么都不做。

## 错误码

| 码 | 含义 | 能做点什么 |
|---|---|---|
| `web_cloudflare_challenge` | 检出拦截，但没恢复（默认 `notify` 的主路径） | 按提示让用户过验证或粘贴正文 |
| `web_cloudflare_handoff_refused` | 用户明确拒绝 | 换一条路，别再试这个网址 |
| `web_cloudflare_handoff_unavailable` | 找不到能提问的人（如 headless 部署） | 部署问题；错误里带网址 |
| `web_blocked_by_cloudflare` | Cloudflare 硬封（1020 / 防火墙规则） | **不会问人** —— 没人能过，直接放弃 |

## 检测是怎么做的

规则表在 `lib/cf-detect.js` 里，**加新特征只要往常量数组里加一条**，不用改逻辑：

- **强信号**（权重 8）：`/cdn-cgi/challenge-platform`、`cf_chl_opt`
- **中信号**（6–8）：`cf_chl_`、turnstile、`challenge-running`、`Just a moment...`、`checking your browser`
- **弱信号**（4–5）：`Attention Required!`、`enable javascript and cookies to continue`
- **硬封**（不走交接）：`Sorry, you have been blocked`、`Error 1020`

默认阈值 `minScore = 12`；被拦截的状态码（403/429/503）在有正文信号时额外加分。
标题类规则**只在该状态码下计分**，防止「文档里提到这句话」被误判。

实测过的四个样本（真实响应，2026-10-17）：

| 站点 | 结果 | 判定 |
|---|---|---|
| `community.cloudflare.com` | HTTP 403，正文只有 `Just a moment...` | challenge（score 41） |
| `g2.com` | HTTP 403，正文极短 | challenge |
| `developers.cloudflare.com/fundamentals/reference/error-codes/` | HTTP 404，超长文档 | **none（防误报的关键负样本）** |
| `discord.com/api/v10/gateway` | 传输失败 | 与 Cloudflare 无关 |

**Cloudflare 的特征会变。** 这个桌面里唯一需要定期更新的是规则表和
`README.md` 顶部的「最近核对」日期。

## 为什么重试经常救不回来（重要）

`dsh-web-fetch-http` **无 cookie jar、无会话**（源码注释原文：*Requests carry no browser cookies
or ambient credentials*）。你在浏览器里过验证拿到的 `cf_clearance` 和指纹都留在浏览器档案里，
插件的重试是一次**全新的无状态请求**，很可能再次被挑战。

- 只挡首次加载的页面 → 重试有时能过；
- `Just a moment...` 这种冷请求必挑战的页面 → 重试过不了，**粘贴正文才是正解**。

这不是「没做好」，是架构边界。所以插件把 `paste` 当一等公民：你粘贴的内容会直接作为结果注入，
不会再打一次网络。

## 测试

```bash
npm test              # 114 项单测
npm run test:smoke    # 接线冒烟（需要已安装的 DSH profile）
npm run acceptance:headless   # 真机验收：真实站点、真实 dsh 进程
npm run acceptance:browser    # 真机验收：真的会开一个浏览器窗口
```

CI 在 GitHub Actions 上跑 `npm test`，Linux + Windows × Node 22/24。
**Node 20 已剔除**：它把 `node --test "test/*.test.mjs"` 当字面路径，glob 支持是 Node 21 才有的。

## 模块表

| 文件 | 职责 |
|---|---|
| `lib/index.js` | Cordis 插件：配置、接线、生命周期 |
| `lib/cf-detect.js` | 纯检测逻辑：规则、评分、判定（可单测） |
| `lib/agent-correlation.js` | 记住每次抓取是哪个 agent 发起的（先按 signal，再按无歧义的网址） |
| `lib/agent-scope.js` | 作用域探测，作为找回 agent 的兜底 |
| `lib/browser-open.js` | 引导页生成 + 去重（同一网址复用标签页） |
| `lib/native-open.js` | 打开器本身：各平台「用默认程序打开」|
| `lib/handoff.js` | 暂停：构造问题、解析回答、重试预算 |
| `lib/provider.js` | `ctx.web.fetch` 装饰器、错误表面、dispose |

## 已知边界

- 卡片按钮目前是英文 `verified` / `paste` / `skip`（改中文要改 `lib/handoff.js`，会动到回答解析，
  欢迎 PR，见下节）。
- 无法在 `inline` 模式下等超过工具预算的时间 —— 这是 DSH 的超时策略决定的，不是插件能绕的。
- 插件**不搬运**人工挣来的放行状态（上面「为什么重试经常救不回来」）。

## 想要中文界面？

按钮文案汉化落在 `lib/handoff.js`：`HANDOFF_ANSWERS` 常量与 `parseAnswer()` 是配对的，
**两边必须一起改**，否则用户选了中文按钮会解析不出答案。欢迎在
[Issues](https://github.com/wtwgo114514/dsh-cf-handoff/issues) 认领。

英文版 [`README.md`](README.md) 是**权威文档**：里面逐条记录了原始规格的 6 条 API 假设中
哪 4 条是错的、真实源码的行号引用、以及每个设计决定的理由。本文件是中文入口，取舍了篇幅。

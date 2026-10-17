# dsh-cf-handoff

[![ci](https://github.com/wtwgo114514/dsh-cf-handoff/actions/workflows/ci.yml/badge.svg)](https://github.com/wtwgo114514/dsh-cf-handoff/actions/workflows/ci.yml)

A Cloudflare human-handoff layer for DeepSeek Harness `web_fetch`.

When a fetch hits a Cloudflare interstitial, the agent cannot get through by
retrying — a human has to open the URL once in a real browser. This plugin
detects the interstitial, opens the URL in the user's own default browser,
pauses the agent on a question in the DSH Web GUI, and resumes the same fetch
call from the human's answer.

**Non-goal, stated up front:** this plugin never tries to *solve* a challenge. It
contains no solver, no CAPTCHA service, no browser automation, and no cookie
theft. It detects, it hands off, it resumes. The human is the mechanism.

**最近核对：2026-10-17**（DSH `0.1.5-rc.2`）。检测特征来自对真实站点的实测
响应，不是从文档推测的；见下文 "Verified against real responses"。
Cloudflare 的特征会变，所以这一行是这份文档里最需要定期更新的一行。

---

## 1. What the original spec assumed, and what the source actually says

The design brief for this plugin was written from **推测的 API** and marked six
assumptions `待核实`. All six were checked against the installed source. **Four
were wrong, and two of those four were wrong in a way that invalidated the
intended design** — the plugin could not have been built as written.

| # | Assumption in the brief | Verdict | What the source actually provides |
|---|---|---|---|
| 1 | `agent/pre-step` exists and can intercept tool results | ⚠️ exists, wrong role | It is a **step-admission** waterfall, not a tool-result node. See below. |
| 2 | Signature `(session, step, next)`, `step` carries `toolCalls`/`toolResults` | ❌ wrong | `(payload: { agent, messages, turn, step, signal }, next)`. **No tool results anywhere in it.** |
| 3 | `next()` supports `{ kind: 'skip' \| 'reject' \| 'replace' }` | ❌ wrong | `PreStepDecision` is `{ kind: 'reject' } \| { kind: 'enter', messages }`. Input rewriting is deliberately excluded. |
| 4 | `ctx.userQuestions.ask(session, {...})` | ✅ exists, different call shape | `ask(request)` — a **single object**. The signature was wrong, the seam is real and is the correct one. |
| 5 | `ctx.browser` exposes `navigate`/`read`/`isHeadless`/`setHeadless`/`currentUrl` | ❌ **does not exist** | There is no browser capability in DSH at all. `ctx.web` is request/response HTTP only. |
| 6 | browser tools are named `browser_*` | ❌ **does not exist** | The only web tools are `web_search` and `web_fetch`. |

### 1.1 Assumption 5 and 6 are the load-bearing failures

DSH ships **no browser control layer**: no Playwright, no Puppeteer, no CDP, no
WebDriver dependency, and no `browser_*` tool registration. The brief's
"if headless, switch to a visible window and re-navigate" step is therefore
**physically unimplementable** — there is no window to switch, and
`dsh-web-fetch-http` keeps no cookie jar or session, so a challenge cleared in
some other browser would not be reused by the provider anyway.

`ctx.web` is the whole network capability:

```ts
// @deepseek-ai/dsh-web/lib/types/index.d.ts
fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>;
search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
```

`WebFetchResult` is `{ url, statusCode, body, truncated }`. **There is no
`headers` field**, so `cf-mitigated`, `server: cloudflare`, and `cf-ray` — the
canonical header signals — are *not observable at this layer*. That single fact
dictates the whole detection design: detection must work from the status code
and the decoded body alone.

### 1.2 Assumption 1–3: the right seam is not `agent/pre-step`

`agent/pre-step` is dispatched with `Scoped<Agent>` and a payload of
`{ agent, messages, turn, step, signal }`, and its decision type is:

```ts
// @deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts
export type PreStepDecision = { kind: 'reject' } | {
  kind: 'enter';
  messages: UserMessage[];
  startsRequestSeries?: true;
};
```

It decides **which messages enter a step**. It never sees a tool result. The
brief's assumption 3 (`skip`/`reject`/`replace` over tool results) does not exist
in any form there.

The real tool-result seam is in `dsh-tools`:

```ts
'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;
'tools/post-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>;
```

with

```ts
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string };

export type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: JsonValue; content?: never; additionalContexts?: UserMessage[] }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: UserMessage[] };
```

The `PreToolDecision` doc comment explains why rewriting is missing:
*"Input rewriting is excluded because arguments are already logged and presented."*

### 1.3 Why this plugin wraps `ctx.web.fetch` instead of using `tools/post-execute`

`tools/post-execute` can replace a *finished* result — including the one
projection the model sees — but it **cannot make the tool run again**. The
brief's recovery requirement is "resume from the breakpoint, don't re-run the
probe", and for a blocked page the only way to obtain content is to fetch again
after the human acted. A post-execute listener would have to re-issue the fetch
itself and could only ever *fake* resumption.

Wrapping `ctx.web.fetch` puts the pause-and-retry **inside the original call**:
`web_fetch` awaits `ctx.web.fetch(...)`, that await is suspended while the human
answers, and the same call returns the real post-verification content. No second
tool invocation, no fabricated result. That is what makes this a resumption
rather than a retry loop.

### 1.4 It is deliberately not a second fetch provider

The obvious-looking approach — register a `WebFetchProvider` — is a trap.
`dsh-web`'s resolver (`dsh-web/lib/index.js`) fails with
`WEB_PROVIDER_AMBIGUOUS` when `fetchProvider` is unconfigured and more than one
provider is available, and `registerProvider` throws
`WEB_DUPLICATE_PROVIDER` for a repeated id. Adding a provider would therefore
change provider selection for **every unrelated fetch in the process**, and the
change would outlive the plugin's usefulness. Decorating the service method is
disposable and leaves the registry untouched.

---

## 2. The one thing that makes the handoff actually work

`ctx.userQuestions.ask()` is a scope-filtered waterfall. From
`dsh-user-questions/lib/index.js`:

```js
return await (agent === void 0
  ? this.ctx.waterfall("user-questions/request", request, noAnswerer)
  : this.ctx.waterfall(scopeTarget(agent, agent), "user-questions/request", { ...request, agent }, noAnswerer));
```

The Web GUI answerer is composed on the **Agent-scoped** waterfall, and
`user-questions/request` is a `mode: waterfall` remote event in
`dsh-api-remotes`. So **a question asked without an agent never reaches the
browser** — it falls through to `noAnswerer` and rejects with `NO_PROVIDER`.

But `WebRuntime.fetch(request, signal)` receives only `{ url }` and a signal.
The agent is nowhere in that call, and `WebRuntime` is a root-level service, so
context probing cannot recover it either.

The agent loop publishes it exactly one layer up. `ToolExecution.agent` is
documented as *"The agent on whose behalf the call runs (set by the agent
loop)"*, and `tools/pre-execute` is dispatched with
`scopeTarget(this, exec.agent)`. So `lib/agent-correlation.js` observes that
event and remembers which agent owns each in-flight call.

**The signal is not a reliable key, and this is the one place where the
obvious design is wrong.** `dsh-tool-web` does hand `exec.signal` straight
through:

```js
const result = await ctx.web.fetch({ url: input.url }, exec.signal);
```

but by the time the tool body runs, `exec.signal` is no longer the signal
`tools/pre-execute` saw. `ToolRegistry.dispatchToolBody` fuses the caller's
signal with whatever an around-wrapper installed and **overwrites the field**:

```js
const wrapperSignal = exec.signal;
const fused = fuseToolSignals(state.callerSignal, wrapperSignal);
exec.signal = fused.signal;              // ← a brand-new AbortController signal
const returned = await tool.execute(exec.arguments, exec);
// finally: exec.signal = wrapperSignal
```

`fuseToolSignals` returns the caller's signal unchanged only when
`caller === wrapper`. With any around-wrapper in play — and the real Web
deployment has one — the tool body receives a fresh signal that nothing outside
that call ever saw. Measured on a real run:

```
agent associated; matched by URL only (1 record(s), signal present);
scoped ask: NO_PROVIDER; unscoped ask: NO_PROVIDER
```

Identity missed while the call was plainly in flight. So correlation is two
tiered, and the **URL tier is the one that works**:

1. **signal identity** — exact, and the only key that is provably about this
   call. Cheap to keep, and it is what a deployment without around-wrappers
   gets.
2. **URL, only when unambiguous** — one URL names exactly one agent. Two agents
   fetching the same URL resolve to nothing rather than to the wrong session: a
   question about one page must never pop up in another agent's conversation.

A miss returns nothing, and the controller then reports the fetch as
unavailable (coded `web_cloudflare_handoff_unavailable`) rather than pretending
to have asked a question nobody saw. The coded message carries the
correlation diagnostic, so "the observer never fired" and "the observer fired
but no tier matched" are distinguishable without another restart — those two
faults used to look identical from the fetch side.

Two consequences worth knowing:

- If the agent cannot be recovered, the question would be asked into a void. The
  controller does **not** silently proceed: it returns a coded error naming the
  URL so the agent can surface it to the user through `ask_user_question`
  instead.
- A fetch made by an **owned child agent** throws `DELEGATED_CALLER`. Falling
  back to an unscoped question there would pop a question about a subagent's URL
  into the parent's session, so that case is reported as unavailable rather than
  quietly redirected.

---

## 3. Using the user's own browser

DSH has no browser, but the user is *already* running one — they are reading the
DSH Web GUI in it. The handoff uses two real host capabilities, and neither is a
browser control layer:

1. **The platform's "open with the default application" verb**, invoked by
   `lib/native-open.js`. On Windows that is
   `powershell.exe -NoProfile -Command "Invoke-Item -LiteralPath <path>"`, which
   hands the file to the `.html` association → the default browser.
2. **The question card in the Web GUI**, which renders markdown.

### 3.1 Why a staged bootstrap page, and not just "open the URL"

The opener takes a **path**. On Windows it runs
`powershell.exe -NoProfile -Command "Invoke-Item -LiteralPath <path>"`, and
`Invoke-Item` resolves its argument as a *provider path*. Measured on the target
machine:

| Argument | Result |
|---|---|
| a real `.html` file | exit 0, silent, opens via the `.html` file association → default browser |
| `file:///C:/Users/.../x.html` | `Cannot find drive. A drive with the name 'file' does not exist.` — exit 1 |
| `https://example.com` | `Cannot find drive. A drive with the name 'https' does not exist.` — exit 1 |

A URL cannot be opened. So `lib/browser-open.js` writes a small local HTML page
that links the real URL (and, when `autoNavigate` is on, navigates to it
immediately), then opens *that file*. The staged page is created under the OS
temp directory with a `dsh-cf-handoff-` prefix and is removed by the plugin's
disposer.

### 3.1.1 Why the opener is not `openNativePath`

The first version imported `@deepseek-ai/dsh-native-command` and called its
`openNativePath`. In the real deployment — a plugin installed with `link:` — that
throws on every handoff:

```
Error: Cloudflare challenge on https://community.cloudflare.com/ — the page content was NOT retrieved.
...
The browser could not be opened automatically (Cannot find package
'@deepseek-ai/dsh-native-command' imported from D:\桌面\工作区\dsh-cf-handoff\lib\index.js).
```

Bare-specifier resolution walks up from the *importing* file. A `link:`-installed
plugin sits outside the profile's `node_modules`, so the harness package is not
reachable from it; declaring it a dependency would only produce a second copy and
still not the profile's instance. The behaviour is therefore reproduced in
`lib/native-open.js` — twenty lines, no runtime dependency, same commands — and
`test/acceptance-browser.mjs` is what checks the replacement against this machine.
`test/native-open.test.mjs` pins the exact argument vectors so the table above
keeps applying to the shipped code.

Writing the replacement turned up a second measurement worth keeping. `spawn`
options change what "the launch failed" even means:

| spawn options | exit code for a URL argument |
|---|---|
| `stdio: 'pipe'` | 1 (stderr carries `Cannot find drive`) |
| `stdio: 'ignore'` | 1 |
| `stdio: 'ignore', detached: true` | **0** |

`detached: true` looks like the harmless choice — "let the opener outlive the
caller" — and it silently turns a failed launch into an apparent success, so the
control assertion in `test/acceptance-browser.mjs` passed while no window opened.
The shipped opener does not detach, and a test pins `options.detached` to
`undefined` with that reason attached. It does not need to detach: it awaits the
launcher's exit, and the browser is started by the shell association, not by this
process.

### 3.2 The browser is an accelerator, never a dependency

Every failure path keeps the handoff alive, because the question itself always
carries the URL:

- opener unavailable or throws → the notice says so, and the URL is still handed
  over in the question;
- `openBrowser: false` → no browser attempt at all;
- headless deployment → set `openBrowser: false`; the user opens the URL from
  the question card in whatever browser they have.

A second handoff for the **same URL within five minutes** reuses the tab that is
already on screen instead of spawning another. That window exists because of what
the first real acceptance run looked like: the user cleared the check, chose
*verified*, the retry was challenged again (see §5.3 — that is expected), and the
next fetch opened a *third* tab for a page the user was already looking at. One
tab per page, not one tab per attempt. A different URL, or the same URL after the
window, stages its own page; `reopenAfterMs: 0` disables the reuse.

Staged pages live in `%TEMP%/dsh-cf-handoff-*` (`os.tmpdir()` on POSIX) and are
removed when the plugin is disposed. A hard kill leaves the directory behind — it
is one ~2 KB HTML file, and the OS temp sweeper will eventually take it. If you
restart DSH a lot, sweep them yourself; the plugin deliberately does not delete
directories at startup, because a second running instance may have a live page in
there.

---

## 4. Detection

`lib/cf-detect.js` is pure, dependency-free, and I/O-free, so it is unit-testable
against recorded responses.

```js
detectCfInterstitial({ statusCode, body }, { minScore }) // → { kind, score, signals, summary }
isCloudflareChallenge(html, url)
isCloudflareChallengeUrl(url)
couldBeCloudflareInterstitial(url, body)
```

Verdict kinds, ordered from "worth a human" to "not Cloudflare's doing":

| kind | meaning | handoff? |
|---|---|---|
| `challenge` | an interactive interstitial a human can clear | **yes** |
| `block` | Cloudflare refused outright (1020 / firewall rule) | no — no human clears it |
| `page-error` | an edge error page that merely mentions Cloudflare | no |
| `none` | no signal | no |

Scoring: each matching rule adds a weight; `DEFAULT_MIN_SCORE = 12`, and an
interstitial status code (`403`/`429`/`503`) adds a bonus **only when the body
already carries a signal**. Strong markers (`_cf_chl_opt`,
`/cdn-cgi/challenge-platform`) are worth 8–10; the phrasal evidence
(`Just a moment...`, `checking your browser`, Turnstile embeds) 6–8; weak hints
(`Attention Required!`) 4–5.

### 4.1 Verified against real responses

The tuning is not guesswork. Four real fetches, recorded while building this:

| URL | Response | Required verdict |
|---|---|---|
| `https://community.cloudflare.com/` | HTTP 403, body is the bare `Just a moment...` shell — **no JavaScript runs, so only the title remains** | `challenge` (scores 14) |
| `https://www.g2.com/` | HTTP 403, `Please enable JS and disable any ad blocker` | `challenge` |
| `https://developers.cloudflare.com/fundamentals/reference/error-codes/` | HTTP 404, a large real document that says "Cloudflare" hundreds of times | **`none` — this is the false-positive test** |
| `https://discord.com/api/v10/gateway` | transport failure | not a Cloudflare matter |

### 4.2 Avoiding false positives

The dangerous failure is stalling a turn on a page that never needed a human, so
the rules are written to require *structural* evidence:

- Title-derived rules require a blocked status code by default. A blog post
  titled "Just a moment..." or prose explaining *"checking your browser"* must
  not trip detection — a case that is explicitly unit-tested.
- The mere presence of the word "Cloudflare" scores nothing.
- A **truncated** body is never inspected: a truncated interstitial shell can be
  missing the very marker that identifies it, so classifying it would be a
  guess. The plugin warns and passes the response through.
- `isCloudflareChallenge(html, url)` returns true **only** for a `challenge`
  verdict. The recall-oriented `couldBeCloudflareInterstitial` is a separate
  function, so a URL-only hit can never be mistaken for a confirmed challenge.

### 4.3 Extending the markers

Feature lists age: Cloudflare changes its interstitial markup. Rules live in one
exported table at the top of `lib/cf-detect.js`; add an entry with a `weight` and
a `kind`, and cover it in `test/detect.test.mjs`. Prefer a **structural**
selector (an element id, a script path) over a sentence — sentences get
translated and reworded.

---

## 5. Where the waiting happens, and why nothing hangs forever

### 5.1 The 30-second ceiling that decides the whole architecture

An in-call wait is the obvious design, and on `web_fetch` it does not work. The
first version of this plugin did exactly that, and a real GUI session produced
this instead of a question card:

```
Error: tool call timed out after 30000ms
```

The cause is a host row, `@deepseek-ai/dsh-tool-call-timeout-policy`:

```js
// @deepseek-ai/dsh-tool-call-timeout-policy/lib/index.js:123-130
const timeoutMs = ctx.tools.get(exec.name, exec.agent)?.timeoutMs;
if (timeoutMs === void 0) return next();
const d = /* ... */ deadline(exec.signal, timeoutMs, TOOL_TIMEOUT) /* ... */;
if (timeoutOf(d.signal, 'TOOL_TIMEOUT') !== void 0) return toolTimeoutResult(timeoutMs);
```

`toolTimeoutResult` (`:93-94`) renders `tool call timed out after ${timeoutMs}ms`.
`web_fetch` takes its budget from `fetchTimeoutMs`, default
`DEFAULT_WEB_TOOL_TIMEOUT_MS = 30000` (`@deepseek-ai/dsh-tool-web/lib/index.js:850`,
attached as `ToolDefinition.timeoutMs` at `:801`).

So 30 seconds is a hard ceiling, and exceeding it does not merely fail: the policy
**aborts the call and substitutes its own message**, discarding whatever the plugin
wanted to say — including the URL the user needs. A handoff that waits ~90 s for a
person therefore produces strictly less information than no handoff at all.

`ask_user_question` is not subject to this, because `@deepseek-ai/dsh-tool-ask-user`
declares no `timeoutMs` and the policy returns `next()` for an undefined budget.
That asymmetry *is* the design:

| `mode` | who waits for the human | when to use it |
|---|---|---|
| `notify` (default) | nobody inside the fetch — the agent then awaits the human with `ask_user_question`, which has no budget | anywhere `web_fetch` keeps its default 30 s budget |
| `inline` | the fetch itself, then retries once after the answer | only when the calling tool's budget is raised above `minHumanBudgetMs` |

In `notify` mode the fetch still does everything it can: it stages the bootstrap
page, opens the browser, and throws a coded notice carrying the URL and telling the
agent to await the human. It just refuses to *be* the wait.

`inline` mode is guarded rather than trusted. Before asking, it reads the budget the
policy will enforce and refuses to start a wait it cannot finish:

```
the tool call is budgeted at 30000ms but a human round trip needs at least 120000ms,
so an in-call wait would be killed by the timeout policy and its generic message
would replace this one (raise tool-web's fetchTimeoutMs to allow it)
```

Refusing early is strictly better than being killed mid-question, because an early
refusal still carries the URL.

The table below lists `inline` mode's outcomes. In `notify` mode the fetch never
asks: it reaches the top of the table's *report* path and hands the human to the
agent.

| Situation | Behaviour |
|---|---|
| User says the check is clear | the **same** fetch call retries once; if the content now arrives, that content is returned |
| Still challenged after the retry | fails with code `web_cloudflare_challenge` and the URL, telling the agent the page *is* the verification step |
| User pastes the page content | returned immediately as a synthesized result — the network is not re-queried |
| User declines | fails with code `web_cloudflare_handoff_refused` and their reason |
| No answerer reachable | fails with code `web_cloudflare_handoff_unavailable` plus the URL |
| Cloudflare hard-blocks | fails with code `web_blocked_by_cloudflare`; **the user is never asked**, because no human action clears a firewall rule |
| Turn cancelled | `ASK_ABORTED` propagates untouched; staged files are cleaned up |

**The retry budget is per fetch call** (`maxAttempts`, default 1), so a page that
re-challenges cannot be reset into a loop by re-triggering the interstitial. A
budget of `0` is legal and produces a report-only plugin.

The distinction that matters: `skip` never yields empty content that the model
might misread as "the page was blank". Every non-recovery path is a **coded
error carrying the URL**.

### 5.2 A code the agent cannot read is not a code

Those codes are only useful if the agent actually sees them, and the first
end-to-end run proved it did not. A thrown tool error reaches the model as the
literal text:

```js
// @deepseek-ai/dsh-tools/lib/index.js:3496
text: `Error: ${message}`
```

The `code` survives only as a structured field (`result.error.info.code`,
`:3496`–`:3501`); it is **never interpolated into that text**. Handed a real
challenge, the agent quoted this plugin's message and reported the *inner*
`NO_PROVIDER` as the failure code, because that was the only code-shaped string
it could see — `web_cloudflare_handoff_unavailable` was invisible to it.

So `fail()` in `lib/provider.js` appends the code to the message text as well as
setting it on the error:

```js
const text = message.includes(code) ? message : `${message} [${code}]`;
```

Every documented code therefore appears twice: machine-readable on the error
object, and readable in the text the model gets. The table above describes what
the agent can actually read, which is the only version of that promise worth
making.

The two headless runs, verbatim, are the whole argument — the only difference
between them is that one line of `fail()`:

```text
# before — asked for "its exact error code", the agent answered:
| `NO_PROVIDER` | … the harness-level code for the failed handoff |

# after — the same task, same site, same challenge:
Error: Cloudflare handoff could not reach the user: … [web_cloudflare_handoff_unavailable]
Notes for interpretation: … the bracketed tag `[web_cloudflare_handoff_unavailable]`
is the failure code.
```

Same detection, same fallback, same URL. The code became *actionable* only when
it moved into the text. `test/acceptance-headless.mjs` now asserts it stays there.

### 5.3 Why "verified, retry" is not always enough — and why pasting is the primary path

This layer does **not** transfer the clearance the human earned. It cannot:
`dsh-web-fetch-http` builds an Undici request with no cookie jar and no session
(*"Requests carry no browser cookies or ambient credentials"*), and the
challenge clearance lives in a `cf_clearance` cookie plus a browser fingerprint,
in the user's browser profile — not in DSH. So the retry is a fresh, stateless
request that may itself be challenged again.

The README is explicit about this rather than hiding it, because it decides which
answer the user should give:

- **A page that only gates the first load** (a one-time interstitial, a redirect
  that stamps a query parameter) clears on the retry. That is the happy path.
- **A page that challenges every cold request** — which is most `Just a moment...`
  interstitials — will keep being challenged no matter how many times the human
  clears it in their own browser.

For the second case the paste path is not a fallback, it is the answer: the human
is already looking at the real page in the real browser, so the content they can
copy is content this layer can never fetch. The question is worded to make that
the obvious move (*"paste the page content as your answer"*), and
`classifyPastedBody` sends markup back down the same rendering path the network
result would have taken.

This is also why the plugin refuses to "solve" Cloudflare: a solver would have to
forge exactly the fingerprint and cookie it is honest about not having.

---

## 6. Install

The package ships its own `cordis.patch.yml` and declares `dsh.bundle.patch`, so
it mounts as a **profile layer** rather than needing a hand-written row:

```bash
dsh plugin add <path-or-tarball> --profile web
```

From a clone, that is just `dsh plugin add ./dsh-cf-handoff --profile web`; the
profile records the spec verbatim, so a `link:`-style development checkout keeps
picking up edits without reinstalling.

`dsh plugin add` reconciles `dsh.profile.bundles` against the installed state and
appends this package automatically, because the resolved manifest declares
`dsh.bundle`. Verify with:

```bash
dsh plugin list --profile web     # dsh-cf-handoff must appear under bundles
```

If you would rather mount it by hand, the row is:

```yaml
# profile cordis.patch.yml
- insert:
    - id: cf-handoff
      name: dsh-cf-handoff
```

The row needs no particular position: DSH activates rows by service
availability, and the plugin declares `inject: ['web', 'userQuestions', 'tools']`.

**An id-targeted override replaces the row's config; it does not merge key by
key.** Overriding only `minScore` in your profile layer therefore drops the other
keys back to the plugin's own schema defaults, not to the values in the bundle
layer. Restate every key you care about:

```yaml
# profile cordis.patch.yml — headless deployment, all three keys restated
- id: cf-handoff
  config:
    minScore: 12
    maxAttempts: 1
    openBrowser: false
```

Every file in the layer is read live from the installed directory, so a `link:`
install needs no reinstall after an edit. A `lib/*.js` edit still needs a **process
restart**: `patchReload: live` reloads the patch layer, not the ESM module graph,
and Node caches imported modules for the life of the process. This one was learned
by measuring it — a diagnostic string added to `handoff.js` did not show up in the
next fetch until the process bounced, which is exactly the kind of "it must have
hot-reloaded" assumption this document exists to avoid.

### Configuration

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `minScore` | `12` | detection threshold; raise to `16`+ for fewer handoffs, lower to `~6` for maximum recall |
| `mode` | `notify` | `notify` = report and return, agent awaits the human; `inline` = wait inside the fetch (needs a raised tool budget — see §5.1) |
| `minHumanBudgetMs` | `120000` | smallest tool-call budget an `inline` wait may start inside |
| `maxAttempts` | `1` | handoffs allowed per fetch call; `0` = report only (`inline` mode) |
| `openBrowser` | `true` | open a staged bootstrap page in the default browser |
| `autoNavigate` | `true` | the staged page navigates to the URL on load instead of waiting for a click |
| `reopenAfterMs` | `300000` | reuse the tab already open for this URL instead of staging another page (§3.2); `0` disables the reuse |
| `tmpRoot` | OS temp | where staged pages are written |

Both modes stage and open the browser; the difference is only who waits.

### Per-preset note

`tool-web` composes `web_fetch` per agent preset, and the `pentest` preset ships
`fetch: false`. The plugin is preset-independent: with `web_fetch` off, nothing
reaches the seam and it stays idle.

---

## 7. Module map

| file | responsibility |
|---|---|
| `lib/index.js` | Cordis plugin: config, wiring, lifecycle |
| `lib/cf-detect.js` | pure detection — rules, scoring, verdicts |
| `lib/agent-correlation.js` | remembers the agent behind each in-flight fetch, by signal then by unambiguous URL |
| `lib/agent-scope.js` | scope probing, used as a fallback for agent recovery |
| `lib/browser-open.js` | staged bootstrap page + opener call |
| `lib/native-open.js` | the opener itself: platform "open with the default application" verbs |
| `lib/handoff.js` | the pause: question construction, answer parsing, retry budget |
| `lib/provider.js` | `ctx.web.fetch` decorator, error surface, disposer |

The split is deliberate: `cf-detect.js` is pure so detection can be tested from
recorded fixtures without a runtime, while `handoff.js`/`provider.js` own
everything that needs one. `native-open.js` is separate from `browser-open.js`
because only the former touches the host.

## 8. Tests

```bash
npm test                        # node --test "test/*.test.mjs" — 114 tests, no network, no runtime
npm run test:smoke              # live wiring against the installed Cordis / WebRuntime / UserQuestionService
npm run acceptance:headless     # a real headless DSH run against a real Cloudflare site
npm run acceptance:browser      # the real opener on this machine — OPENS ONE BROWSER WINDOW
```

`detect.test.mjs` covers the four recorded real responses above, the
false-positive regression, URL markers, truncation, and rule weighting.
`handoff.test.mjs` covers answer parsing, pasted-body classification, question
construction, and the `DELEGATED_CALLER` / `NO_PROVIDER` branches.
`provider.test.mjs` covers the intercept end to end over a fake runtime: retry
budget, pasted short-circuit, coded failures, idempotent install, and disposal.
`agent-correlation.test.mjs` covers both correlation tiers, parallel fetches, the
ambiguity refusal, the aborted-call eviction, and the observer's disposer.
`native-open.test.mjs` pins the opener to the exact platform command vectors and
to the spawn options (`stdio: 'ignore'`, no `detached`), so the §3.1 and §3.1.1
tables stay true of the shipped code — not just of the harness package it was
copied from. `browser-open.test.mjs` covers the bootstrap page (escaping, the
optional self-navigation, a hostile detection reason) and the tab-reuse rule of
§3.2, over an injected opener and a fake clock.

`test/live-smoke.mjs` is the one that matters for the claims this design rests
on, because the unit tests fake both sides of every seam. It loads the real
`@deepseek-ai/cordis`, `dsh-web`, `dsh-user-questions` and `dsh-scope` from the
installed profile and asserts:

- `ctx.web.fetch` really is a replaceable own method on the live `WebRuntime`,
  and the wrapper still runs `dsh-web`'s own provider resolution.
- `scopeTarget(agent, agent)` really does admit an answerer registered on that
  agent's scope, and `carrierKeyOf` on that carrier returns the agent — which is
  what `lib/agent-scope.js`'s fallback depends on.
- `tools/pre-execute` observed from a plain context really does reach the
  correlation table, keyed by the signal the tool hands to `web.fetch`. If that
  admission rule went the other way the observer would record nothing and every
  handoff would degrade to "no answerer" — a failure that looks like the network,
  not like a bug.
- The question the handoff builds survives to the answerer with its id, header,
  both option labels and the clickable URL link intact.

Two facts it pinned down that a fake cannot show, both of which changed the code:

- **A question asked without an agent does not reach the browser.** The GUI
  answerer is composed on the Agent-scoped waterfall, so `ask({ questions })`
  with no `agent` falls through to `noAnswerer`. This is why
  `lib/agent-correlation.js` exists at all.
- **`exec.signal` at `tools/pre-execute` is not the signal the tool body
  receives.** `dispatchToolBody` overwrites the field with a fused signal. This
  is not visible from any seam above the tool body, which is why the code
  shipped first with a signal-only key and then failed on a real page while
  every fake-based test passed. Correlation now falls back to the URL, and the
  coded failure reports which tier matched.
- **`request.questions` arrives as the live service's own array proxy.** Indexing
  it works; reading named fields off the elements later does not. Anything that
  wants to inspect a question must read it while the request is in hand.

Neither the smoke test nor the unit tests reach the network or open a window;
`openBrowser: false` exercises exactly the headless path that must work with no
opener available.

CI (`.github/workflows/ci.yml`) runs `npm test` on Node 22 and 24, on both Linux
and Windows. Node 20 is deliberately out of the matrix: `npm test` hands a glob
to `node --test`, which Node 20 reads as a literal path
(`Could not find '.../test/*.test.mjs'`) because glob expansion in the test
runner only arrived in Node 21 — and 20 is past end of life anyway.

The other three commands stay local by design: they need an installed DSH
profile, a real `dsh` binary, and — for the last one — a desktop session.

### 8.1 The two acceptance scenarios

These are the only tests that use the real world. Both are opt-in because one
spends model calls and the other opens a window.

**`test/acceptance-headless.mjs`** runs `dsh --profile headless` twice against
live sites — a guarded one that serves a genuine interstitial, and a plain one —
and asserts on what the agent could actually read. It needs the plugin installed
into that profile first (`dsh plugin add <dir> --profile headless`). A headless
run has **no GUI answerer**, so it exercises the branch that must report rather
than hang, and that is the only branch reachable without a human at the keyboard.
It is also the regression guard for §5.2 — remove the code from the message and
this script fails while every unit test still passes.

**`test/acceptance-browser.mjs`** calls the plugin's own shipped opener
(`lib/native-open.js`, the exact function `lib/index.js` wires) and opens one
browser window. It exists because every other test injects a fake opener, so none
of them show that "the user's default browser opens the blocked URL" is true of
the code that actually runs. It also asserts the control: handing a URL straight
to the opener fails, which is what pins the staged-file design to execution rather
than to reading. §3.1.1 explains why this file stopped importing
`@deepseek-ai/dsh-native-command`: the import is what failed in the real install.

### 8.2 What is still unverified

**One live round trip has now been done**, by hand, in the Web GUI. It went: a
real `web_fetch` of a guarded site → challenge detected → a browser tab opened
from the staged page → the notice returned with the code and the URL → the agent
asked, with the URL as a clickable `detail` link → the human chose *verified* →
the retry ran → **the retry was challenged again**, which is exactly what §5.3
predicts for a stateless fetch. So the mechanical loop closes; what it cannot do
is carry a clearance it never had.

What that leaves unverified:

- **The paste path.** It has never been exercised end to end by a human. Everything
  up to and including `classifyPastedBody` is covered by unit tests, but no live
  run has pasted a real page into the answer box.
- **The model following the instruction is still model behaviour.** The notice is
  asserted word-for-word (`test/provider.test.mjs`) and `ask_user_question` with an
  agent is proven to reach the Web GUI answerer (`test/live-smoke.mjs`); whether a
  given model actually asks is not something a test here can force.
- **A page that stops challenging.** No fixture can promise it, so the "verified →
  content" branch is verified only against a fixture provider in
  `test/live-smoke.mjs`, never against a live site.

`inline` mode's human round trip is likewise only partly observable from a script:
the plugin side is covered (ask → answer → retry), but a real *clear* requires a
page that stops challenging.

---

## 9. Files

| path | role |
|---|---|
| `lib/` | the plugin (see §7) |
| `test/` | unit, smoke and acceptance suites (§8) |
| `cordis.patch.yml` | the profile-layer row (§6) |
| `tsconfig.json` | editor/opt-in JSDoc checking only — **there is no build step**, and TypeScript is not a dependency |
| `package.json` | the `dsh.bundle.patch` declaration is what makes §6's one-liner mount the layer |
| `LICENSE` | MIT |

## 10. Localization

All human-facing text is hard-coded English in 0.1.0. That is the obvious
contribution if this is going to fit a non-English deployment, so here is the map.

| where | what | constraint |
|---|---|---|
| `lib/handoff.js` `buildHandoffQuestions()` | the question's `header`, `question`, and the three option labels `verified` / `paste` / `skip` | the labels **are** the answer protocol — the GUI returns the selected label |
| `lib/handoff.js` `parseAnswer()` | accepts those labels and tolerant synonyms (`done`, `passed`, `ok`, `verified`, `skip`, `refused`, …) | add translated labels here, keep the English ones. It already recognizes a few Chinese *done* words (`完成` `好了` `过了` `通过` `重试`) but **no Chinese refusal words** — that is the first gap to close |
| `lib/handoff.js` `classifyPastedBody()` | decides whether a pasted body is a real page or a challenge again | it reads page structure, not language; no translation needed |
| `lib/handoff.js` `buildChallengeNotice()` | the instruction the **agent** reads before it asks | model-facing, not human-facing — translate only if your models do better that way |
| `lib/provider.js` | coded failure messages | the bracketed code must survive translation (§5.2) |

Two rules for a localization patch:

1. **Never translate the bracketed codes.** `web_cloudflare_challenge`,
   `web_cloudflare_handoff_refused`, `web_blocked_by_cloudflare` and friends are
   contract: the model reads them and `test/provider.test.mjs` matches them.
2. **Translate a label and its parser in the same commit.** An option whose label
   no parser recognizes does not fail loudly — it degrades every handoff to "the
   channel returned an empty answer", which reads like a transport bug.

`detail` carries the blocked URL as a markdown link, and the DSH Web GUI renders
markdown, so the click-through needs no translation at all.



/**
 * The fetch intercept that pauses for a human when Cloudflare gets in the way.
 *
 * WHERE THIS HOOKS IN - AND WHY NOT SOMEWHERE ELSE
 * `@deepseek-ai/dsh-web@0.1.5-rc.2` keeps a provider *registry*: providers
 * implement `{ id, available(), fetch(request, signal) }` and are keyed by id,
 * and `configured id -> provider` resolution
 * (`resolveProvider` inside `dsh-web/lib/index.js:119`) prefers the configured
 * id and otherwise requires exactly one usable provider, throwing
 * `WEB_PROVIDER_AMBIGUOUS` for two. That leaves three candidate seams, and two
 * of them are wrong:
 *
 * - Registering a second fetch provider is the idiomatic Cordis move, but it
 *   permanently widens that one-usable-provider invariant: every other caller of
 *   `ctx.web.fetch()` would have to name a provider explicitly or start failing.
 *   A plugin must not change a global service's selection semantics.
 * - `tools/post-execute` can only rewrite a tool's finished return value; it
 *   cannot make the tool run again, so "pause and resume from the breakpoint" is
 *   impossible there.
 * - `WebRuntime.prototype.fetch` is where selection happens and where the
 *   returned value is *still mutable*, so an owned replacement can delegate to
 *   the original selection logic and then decide what the caller sees. The
 *   replacement is disposed with its fiber and is never installed twice.
 *
 * @module dsh-cf-handoff/provider
 */

import { detectCfInterstitial, isCloudflareChallengeUrl } from './cf-detect.js';
import { buildChallengeNotice } from './handoff.js';

/**
 * The harness error class, when the host provides it.
 *
 * Resolved lazily and optionally on purpose: a missing `@deepseek-ai/dsh-llm`
 * must not stop the plugin from loading. The only thing lost is the harness's
 * error identity; the stable `code`, which is what surfaces in tool output and
 * what callers route on, is preserved either way.
 *
 * @type {Promise<Function | undefined>}
 */
const harnessWebError = import('@deepseek-ai/dsh-llm')
	.then((module) => (typeof module?.WebError === 'function' ? module.WebError : undefined))
	.catch(() => undefined);

/**
 * Throw a coded fetch failure.
 *
 * Asynchronous so the harness error class is awaited only on the failure path,
 * which keeps plugin load independent of an optional dependency.
 *
 * THE CODE IS ALSO SPELLED OUT IN THE MESSAGE, DELIBERATELY.
 *
 * A thrown tool error reaches the model as the literal text `Error: <message>`
 * (`@deepseek-ai/dsh-tools/lib/index.js:3496`). The error's `code` survives only
 * as a structured field on `result.error.info.code`; it is never interpolated
 * into that text. So a code that lives only on the object is invisible to the
 * agent, which is exactly the reader that has to route on it - and a real
 * headless run proved it: handed a challenge, the agent quoted the inner
 * `NO_PROVIDER` from this message and never saw `web_cloudflare_handoff_unavailable`
 * at all.
 *
 * Appending the code here keeps each call site free of duplication while making
 * every documented code actually reach the agent.
 *
 * @param {string} message - human-readable message
 * @param {string} code - stable machine-routable code, echoed into the message
 * @returns {Promise<never>} always rejects
 */
async function fail(message, code) {
	const WebError = await harnessWebError;
	const text = message.includes(code) ? message : `${message} [${code}]`;
	if (WebError !== undefined) throw new WebError(text, code);
	throw Object.assign(new Error(text), { code });
}

/** Non-enumerable marker key carried on annotated results. */
export const HANDOFF_MARKER = Symbol.for('dsh-cf-handoff.marker');

/** Install marker placed on an owned replacement, so re-installing is a no-op. */
export const HANDOFF_INSTALLED = Symbol.for('dsh-cf-handoff.installed');

/** Default configuration; every field is optional at runtime. */
export const DEFAULT_HANDOFF_CONFIG = Object.freeze({
	enabled: true,
	minScore: 12,
	maxAttempts: 1,
	openBrowser: true,
	browserHandoff: true,
	mode: 'notify'
});

/**
 * Resolve effective configuration, tolerating absent fields.
 *
 * @param {Partial<typeof DEFAULT_HANDOFF_CONFIG> | undefined} config - raw plugin config
 * @returns {typeof DEFAULT_HANDOFF_CONFIG} the effective configuration
 */
export function resolveHandoffConfig(config) {
	const merged = { ...DEFAULT_HANDOFF_CONFIG, ...(config ?? {}) };
	return {
		enabled: merged.enabled !== false,
		minScore: Number.isFinite(merged.minScore) ? Number(merged.minScore) : DEFAULT_HANDOFF_CONFIG.minScore,
		maxAttempts: Number.isFinite(merged.maxAttempts) ? Math.max(0, Number(merged.maxAttempts)) : DEFAULT_HANDOFF_CONFIG.maxAttempts,
		openBrowser: merged.openBrowser !== false,
		browserHandoff: merged.browserHandoff !== false,
		mode: merged.mode === 'inline' ? 'inline' : 'notify'
	};
}

/**
 * Validate the shape a web runtime must have to be intercepted.
 *
 * @param {unknown} runtime - candidate runtime (the `ctx.web` service)
 * @returns {{ fetch: (request: unknown, signal?: unknown, context?: unknown) => Promise<any> }} the validated runtime
 */
export function assertWebRuntime(runtime) {
	if (runtime === null || typeof runtime !== 'object') {
		throw new TypeError('ctx.web is not an object; nothing to intercept');
	}
	if (typeof (/** @type {any} */ (runtime).fetch) !== 'function') {
		throw new TypeError('ctx.web does not expose fetch(request, signal)');
	}
	return /** @type {any} */ (runtime);
}

/**
 * Strip a handoff annotation back off, yielding the plain fetch result.
 *
 * @param {unknown} result - a possibly annotated result
 * @returns {unknown} the underlying result
 */
export function unwrapHandoffResult(result) {
	const marker = /** @type {any} */ (result)?.[HANDOFF_MARKER];
	return marker === undefined ? result : marker.underlying;
}

/**
 * Read the handoff annotation off a result, when present.
 *
 * @param {unknown} result - a possibly annotated result
 * @returns {object | undefined} the annotation payload
 */
export function readHandoffMarker(result) {
	return /** @type {any} */ (result)?.[HANDOFF_MARKER];
}

/**
 * Run one fetch through the handoff loop.
 *
 * @param {object} deps - injected dependencies
 * @param {object} deps.runtime - the live web runtime (identity and validation only)
 * @param {(request: { url: string }, signal?: AbortSignal) => Promise<any>} deps.delegate - the original fetch to delegate to
 * @param {() => unknown} deps.createController - builds a per-fetch handoff controller
 * @param {Partial<typeof DEFAULT_HANDOFF_CONFIG>} [deps.config] - effective configuration
 * @param {(message: string) => void} [deps.onWarn] - diagnostics sink
 * @returns {(request: { url: string }, signal?: AbortSignal) => Promise<any>} the fetch implementation
 */
export function createFetchHandoff(deps) {
	const runtime = assertWebRuntime(deps.runtime);
	// Delegation must go through the method captured before installation. Reading
	// `runtime.fetch` here would resolve to this very replacement once it is
	// installed, and the retry loop would call itself until the stack ran out.
	const delegate =
		typeof deps.delegate === 'function' ? deps.delegate : /** @type {any} */ (runtime).fetch.bind(runtime);
	const createController = deps.createController;
	const config = resolveHandoffConfig(deps.config);
	const onWarn = typeof deps.onWarn === 'function' ? deps.onWarn : () => {};
	if (typeof createController !== 'function') {
		throw new TypeError('createFetchHandoff requires a createController() function');
	}

	/**
	 * Run one attempt and classify its outcome.
	 *
	 * @param {{ url: string }} request - the fetch request
	 * @param {AbortSignal | undefined} signal - caller lifetime
	 * @returns {Promise<{ result: any, verdict: ReturnType<typeof detectCfInterstitial> }>} the attempt
	 */
	async function attempt(request, signal) {
		const result = await delegate(request, signal);
		if (result === null || typeof result !== 'object' || typeof result.body?.content !== 'string') {
			await fail('web provider returned a result without a text body', 'web_invalid_response');
		}
		if (result.truncated === true) {
			// Detection needs the complete document. A truncated interstitial shell can
			// be missing the very marker that identifies it, and a retry after handoff
			// would hit the same cap, so inspecting it would only produce a guess.
			onWarn(`response for ${String(request?.url ?? result.url)} was truncated; Cloudflare detection skipped`);
			return {
				result,
				verdict: {
					kind: /** @type {const} */ ('none'),
					score: 0,
					statusCode: Number(result.statusCode) || 0,
					signals: [],
					summary: 'not inspected (truncated response)'
				}
			};
		}
		return { result, verdict: detectCfInterstitial({ statusCode: result.statusCode, body: result.body }, { minScore: config.minScore }) };
	}

	return async function handoffFetch(request, signal) {
		if (config.enabled !== true) return delegate(request, signal);
		const url = String(request?.url ?? '');
		const controller = createController();

		for (;;) {
			const { result, verdict } = await attempt(request, signal);

			if (verdict.kind === 'none') {
				if (result.truncated !== true) annotate(result, { kind: 'none', verdict });
				return result;
			}

			if (verdict.kind !== 'challenge') {
				// A refusal or an edge error is not something a human can clear, so
				// handoff would only waste the user's time. Fail with the evidence.
				const code = verdict.kind === 'block' ? 'web_blocked_by_cloudflare' : 'web_cloudflare_edge_error';
				await fail(verdict.summary, code);
			}

			const blockedUrl = url.length > 0 ? url : String(result.url);

			// Non-blocking by default, and the reason is a platform fact rather than a
			// preference: `@deepseek-ai/dsh-tool-call-timeout-policy` enforces
			// `ToolDefinition.timeoutMs` around the whole call, `web_fetch` declares
			// 30 s, and when that fires it *replaces* the result with a bare
			// `tool call timed out after Nms`. Waiting for a person here therefore
			// cannot work — it does not merely fail, it deletes the explanation. So the
			// fetch reports and returns; `ask_user_question`, which declares no budget
			// and is skipped by that policy, is where a human can be waited for.
			const inline = config.mode === 'inline' ? controller.inlineViability() : { viable: false };
			if (!inline.viable) {
				const opened = await controller.openPage({
					url: blockedUrl,
					verdict,
					signal,
					openBrowser: config.openBrowser === true && config.browserHandoff === true
				});
				await fail(
					buildChallengeNotice({
						url: blockedUrl,
						verdict,
						browserPath: opened.browserPath,
						openError: opened.openError,
						reason: inline.reason
					}),
					'web_cloudflare_challenge'
				);
			}

			if (!controller.canRetry) {
				await fail(
					`${verdict.summary}; no handoff retries left for this fetch (attempts ${controller.attempts}). The page IS the verification step - surface this URL to the user instead of retrying blindly.`,
					'web_cloudflare_challenge'
				);
			}

			const outcome = await controller.request({
				url: url.length > 0 ? url : String(result.url),
				verdict,
				signal,
				openBrowser: config.openBrowser === true && config.browserHandoff === true
			});

			if (outcome.action === 'refused') {
				await fail(`Cloudflare handoff refused: ${outcome.reason ?? 'user declined'}. ${verdict.summary}`, 'web_cloudflare_handoff_refused');
			}

			if (outcome.action === 'unavailable') {
				await fail(
					`Cloudflare handoff could not reach the user: ${outcome.reason ?? 'no answerer'}. ${verdict.summary}. Open this URL in a browser to clear the check: ${url.length > 0 ? url : String(result.url)}`,
					'web_cloudflare_handoff_unavailable'
				);
			}

			if (outcome.action === 'pasted') {
				const synthesized = {
					url: String(request?.url ?? result.url),
					statusCode: 200,
					body: outcome.body ?? { kind: /** @type {const} */ ('text'), content: '' },
					truncated: false
				};
				annotate(synthesized, {
					kind: 'pasted',
					verdict,
					note: 'body supplied by the user from their own browser; the network response was the Cloudflare interstitial'
				});
				return synthesized;
			}

			// `verified`: the loop retries once. The per-fetch budget guarantees this
			// cannot spin even when the interstitial is still in place.
			onWarn(`retrying ${url.length > 0 ? url : String(result.url)} after user verification`);
		}
	};
}

/**
 * Install the intercept on one live runtime.
 *
 * The replacement owns nothing global: it delegates every call to the original
 * method, carries its own config, and is removed by the returned disposer. It is
 * marked so a second install over the same runtime is a no-op rather than an
 * ever-growing call chain.
 *
 * @param {object} deps - injected dependencies
 * @param {unknown} deps.runtime - the `ctx.web` service instance
 * @param {() => unknown} deps.createController - builds a per-fetch handoff controller
 * @param {Partial<typeof DEFAULT_HANDOFF_CONFIG>} [deps.config] - effective configuration
 * @param {(message: string) => void} [deps.onWarn] - diagnostics sink
 * @returns {{ dispose(): void, installed: boolean }} the install result
 */
export function installFetchHandoff(deps) {
	const runtime = assertWebRuntime(deps.runtime);
	const existing = /** @type {any} */ (runtime.fetch);
	if (existing[HANDOFF_INSTALLED] === true) {
		return { dispose: () => {}, installed: false };
	}
	// Capture the original before overwriting it, and hand it to the replacement
	// explicitly: the replacement must never look the method up again.
	const delegate = existing.bind(runtime);
	const replacement = createFetchHandoff({ ...deps, runtime, delegate });
	Object.defineProperty(replacement, HANDOFF_INSTALLED, { value: true, enumerable: false });
	runtime.fetch = replacement;
	return {
		installed: true,
		dispose() {
			if (/** @type {any} */ (runtime.fetch) === replacement) {
				delete runtime.fetch;
			}
		}
	};
}

/**
 * Attach the handoff marker as a non-enumerable property, so the annotation
 * never leaks into serialized tool output or value comparisons.
 *
 * @param {any} result - a `WebFetchResult`
 * @param {{ kind: 'none' | 'pasted', verdict?: unknown, note?: string }} marker - annotation payload
 * @returns {any} the same result
 */
function annotate(result, marker) {
	Object.defineProperty(result, HANDOFF_MARKER, {
		value: { ...marker, underlying: result },
		enumerable: false,
		configurable: true,
		writable: true
	});
	return result;
}

export default installFetchHandoff;

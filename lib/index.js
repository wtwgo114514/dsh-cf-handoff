/**
 * dsh-cf-handoff — a Cloudflare human-handoff layer for DSH's `web_fetch`.
 *
 * WHAT PROBLEM THIS SOLVES
 * Cloudflare's bot management answers a plain HTTP fetch with an interstitial
 * instead of the page: a challenge ("Just a moment..."), a Turnstile widget, or
 * the minimal JavaScript shell Cloudflare serves when no JavaScript runs. No
 * amount of retrying from the agent side clears it — a human has to open the URL
 * once in a real browser. Without this plugin the agent either reports a useless
 * 403 or burns turns retrying.
 *
 * WHAT IT DOES
 * It intercepts `ctx.web.fetch` (the seam `web_fetch` resolves through),
 * classifies the response, and on a challenge:
 *   1. opens the URL in the user's default browser through a staged bootstrap
 *      page (`openNativePath` is a *path* opener — see `browser-open.js`),
 *   2. pauses the agent on a real question in the DSH Web GUI
 *      (`ctx.userQuestions.ask`, the only in-turn pause primitive),
 *   3. retries within the same call when the user says it is clear, or uses the
 *      content the user pasted from their own browser.
 * The retry budget is per fetch call, so a page that keeps re-challenging cannot
 * loop forever.
 *
 * It deliberately does NOT hand off for a Cloudflare *block* or edge error:
 * those are firewall outcomes that no human interaction clears.
 *
 * @module dsh-cf-handoff
 */

import z from '@deepseek-ai/schemastery';
import { createAgentCorrelation } from './agent-correlation.js';
import { createAgentResolver } from './agent-scope.js';
import { createBrowserHandoff } from './browser-open.js';
import { HandoffController } from './handoff.js';
import { openPathNatively } from './native-open.js';
import { installFetchHandoff, resolveHandoffConfig } from './provider.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'cf-handoff';

/**
 * The services this plugin decorates and observes.
 *
 * `tools` is injected for `tools/pre-execute` alone: that event is the only
 * place the executing agent is visible, and an agent must be supplied to
 * `userQuestions.ask` for the question to reach the browser. See
 * `agent-correlation.js` for the full reasoning.
 */
export const inject = ['web', 'userQuestions', 'tools'];

/** Plugin configuration schema. */
export const Config = z.object({
	enabled: z.boolean().default(true),
	minScore: z.number().default(12),
	maxAttempts: z.number().default(1),
	openBrowser: z.boolean().default(true),
	autoNavigate: z.boolean().default(true),
	mode: z.string().default('notify'),
	minHumanBudgetMs: z.number().default(120000),
	reopenAfterMs: z.number().default(300000),
	tmpRoot: z.string()
});

/**
 * Open one path with the platform's default application.
 *
 * Deliberately self-contained rather than an import of
 * `@deepseek-ai/dsh-native-command`: a `link:`-installed plugin resolves bare
 * specifiers from its own directory, outside the profile's `node_modules`, so
 * that import fails at runtime with `Cannot find package
 * '@deepseek-ai/dsh-native-command'`. See `lib/native-open.js` for the full
 * reasoning and for the platform commands that reproduce it.
 *
 * @param {string} path - absolute path to open
 * @param {AbortSignal} signal - caller lifetime
 * @returns {Promise<void>} resolves once the opener was started
 */
async function defaultOpenPath(path, signal) {
	await openPathNatively(path, signal);
}

/**
 * Register the handoff on the live web service.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context
 * @param {z.infer<typeof Config>} [config] - resolved plugin configuration
 * @returns {void}
 */
export function apply(ctx, config = {}) {
	const resolved = {
		enabled: config.enabled !== false,
		minScore: Number.isFinite(config.minScore) ? Number(config.minScore) : 12,
		maxAttempts: Number.isFinite(config.maxAttempts) ? Math.max(0, Number(config.maxAttempts)) : 1,
		openBrowser: config.openBrowser !== false,
		autoNavigate: config.autoNavigate !== false,
		mode: config.mode === 'inline' ? 'inline' : 'notify',
		minHumanBudgetMs: Number.isFinite(config.minHumanBudgetMs) ? Math.max(0, Number(config.minHumanBudgetMs)) : 120000,
		reopenAfterMs: Number.isFinite(config.reopenAfterMs) ? Math.max(0, Number(config.reopenAfterMs)) : 300000,
		...(config.tmpRoot === undefined ? {} : { tmpRoot: String(config.tmpRoot) })
	};
	const effective = resolveHandoffConfig(resolved);

	if (resolved.enabled !== true) {
		ctx.logger.info('cf-handoff: disabled by configuration');
		return;
	}

	const browser = resolved.openBrowser === true
		? createBrowserHandoff({
				openPath: (path, signal) => defaultOpenPath(path, signal),
				autoNavigate: resolved.autoNavigate === true,
				reopenAfterMs: resolved.reopenAfterMs,
				...(resolved.tmpRoot === undefined ? {} : { tmpRoot: resolved.tmpRoot })
			})
		: undefined;

	const resolveAgent = createAgentResolver(ctx);
	const correlation = createAgentCorrelation();
	const disposition = correlation.observe(ctx);
	const warn = (message) => ctx.logger.warn(`cf-handoff: ${message}`);

	/**
	 * Why the last correlation attempt ended the way it did.
	 *
	 * Kept so the coded failure can say which tier missed instead of repeating
	 * "no answerer" for every cause. See `agent-correlation.js`.
	 *
	 * @type {string}
	 */
	let lastCorrelation = 'no fetch attempted yet';
	/** @type {number | undefined} */
	let lastBudgetMs;

	/**
	 * Recover the agent behind one fetch call.
	 *
	 * The signal-keyed lookup is the reliable path: `tools/pre-execute` gave us
	 * the agent for that exact `exec.signal`, and `web_fetch` hands the same
	 * object to `ctx.web.fetch`. The URL tier covers a caller that derives a new
	 * signal before fetching. The scope probe is kept as a last resort for a
	 * caller that reaches the service from an agent-scoped context directly.
	 *
	 * @param {unknown} signal - the signal the fetch was called with
	 * @param {{ url?: string } | undefined} meta - what the fetch was about
	 * @returns {Promise<unknown | undefined>} the owning agent, when known
	 */
	const resolveFetchingAgent = async (signal, meta) => {
		const found = correlation.lookup(signal, meta?.url);
		lastCorrelation = found.detail;
		lastBudgetMs = found.budgetMs;
		if (found.agent !== undefined) return found.agent;
		return resolveAgent();
	};

	let install;
	try {
		install = installFetchHandoff({
			runtime: ctx.web,
			// One controller per fetch is what keeps the retry budget local to a call.
			createController: () => new HandoffController({
				userQuestions: ctx.userQuestions,
				browser,
				resolveAgent: resolveFetchingAgent,
				// The timeout policy caps the whole call, so the handoff has to know the
				// ceiling before it decides whether a human round trip can fit inside it.
				budget: () => lastBudgetMs,
				minHumanBudgetMs: resolved.minHumanBudgetMs,
				maxAttempts: effective.maxAttempts,
				describe: () => `${lastCorrelation}; ${correlation.size()} invocation(s) recorded`,
				onWarn: warn
			}),
			config: effective,
			onWarn: warn
		});
	} catch (error) {
		ctx.logger.warn(`cf-handoff: could not install the fetch handoff: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	if (install.installed !== true) {
		ctx.logger.info('cf-handoff: fetch handoff already installed on this web service');
		return;
	}

	ctx.effect(() => () => {
		install.dispose();
		disposition();
		if (browser !== undefined) void browser.dispose();
	}, 'cf-handoff: fetch handoff, agent correlation, and staged pages');

	ctx.logger.info(
		`cf-handoff: watching web_fetch for Cloudflare challenges (minScore ${effective.minScore}, mode ${effective.mode}, maxAttempts ${effective.maxAttempts}, browser ${resolved.openBrowser === true ? 'on' : 'off'})`
	);
}

export { createAgentCorrelation, isCorrelatedTool } from './agent-correlation.js';
export { createAgentResolver, looksLikeAgent } from './agent-scope.js';
export { createBrowserHandoff, renderBootstrapHtml } from './browser-open.js';
export { CF_KINDS, DEFAULT_MIN_SCORE, detectCfInterstitial } from './cf-detect.js';
export { HANDOFF_ANSWERS, HandoffController, classifyPastedBody, parseAnswer, readAnswerValue } from './handoff.js';
export { HANDOFF_MARKER, installFetchHandoff, readHandoffMarker, resolveHandoffConfig, unwrapHandoffResult } from './provider.js';

export default { name, inject, Config, apply };

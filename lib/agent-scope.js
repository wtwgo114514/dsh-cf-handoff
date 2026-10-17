/**
 * Recover the calling agent from a Cordis context.
 *
 * WHY THIS IS NEEDED AT ALL
 * `ctx.userQuestions.ask()` accepts an optional `agent`. Supplying it is what
 * makes DSH enforce its two human-interaction invariants — the agent must be
 * the registry's exact live instance (`CALLER_NOT_LIVE`) and must not be owned
 * by another agent (`DELEGATED_CALLER`) — and it is what routes the question to
 * the right browser session. Omitting it asks on the unscoped waterfall, which
 * only works because the shipped answerer (`dsh-client-ui-user-questions`) is
 * registered on the root remote bus.
 *
 * `@deepseek-ai/dsh-scope` mints a scope as `scopeTarget(subject, subject)`, and
 * for an agent both arguments are the agent itself — so an agent-scoped context
 * carries a scope tag that {@link carrierKeyOf} hands straight back. This module
 * probes for that tag defensively because the probe crosses a package boundary
 * the plugin does not own: an unrecognized scope simply yields `undefined`, and
 * the caller falls back to an unscoped question.
 *
 * The `@deepseek-ai/dsh-scope` import is lazy and optional: when it cannot be
 * resolved the resolver degrades to `undefined` instead of failing plugin load.
 *
 * @module dsh-cf-handoff/agent-scope
 */

/**
 * Structural test for an agent subject: something with a string `id` and its
 * own Cordis context. Deliberately duck-typed — importing `@deepseek-ai/dsh-agent`
 * just for a nominal check would add a second hard dependency for one predicate.
 *
 * @param {unknown} value - candidate
 * @returns {boolean} whether the value looks like an agent
 */
export function looksLikeAgent(value) {
	if (value === null || typeof value !== 'object') return false;
	const record = /** @type {Record<string, unknown>} */ (value);
	return typeof record.id === 'string' && record.id.length > 0 && record.ctx !== null && typeof record.ctx === 'object';
}

/**
 * Create an agent resolver over one Cordis context.
 *
 * @param {object} context - the context that performed the work (usually `this` inside a service method)
 * @param {(moduleName: string) => Promise<unknown>} [loadModule] - import seam, for tests
 * @returns {() => Promise<unknown | undefined>} an async resolver returning the live agent or `undefined`
 */
export function createAgentResolver(context, loadModule = defaultLoadModule) {
	let scopeModulePromise;

	return async function resolveAgent() {
		// The read is guarded because a Cordis context is a proxy that rejects any
		// property the reader did not `inject`: asking for `.agent` here throws
		// `cannot get property "agent" without inject` rather than yielding
		// `undefined`. This resolver is a fallback, so an unavailable property must
		// degrade to "no probe result", never to an exception that hides the real
		// reason the handoff could not find a human.
		/** @type {unknown} */
		let candidate;
		try {
			if (looksLikeAgent(context?.agent)) candidate = context?.agent;
		} catch {
			candidate = undefined;
		}
		if (looksLikeAgent(candidate)) return candidate;
		if (context === null || typeof context !== 'object') return undefined;

		scopeModulePromise ??= loadModule('@deepseek-ai/dsh-scope').catch(() => undefined);
		const scopeModule = /** @type {{ scopeOf?: (ctx: unknown) => unknown, carrierKeyOf?: (value: unknown) => unknown } | undefined} */ (
			await scopeModulePromise
		);
		if (scopeModule === undefined) return undefined;

		// `scopeOf(ctx)` reads the tag a scoped context inherits. `carrierKeyOf`
		// is the fallback for a value that IS a scope carrier rather than a
		// context; both are probed because the shape depends on where the fetch was
		// called from, and a miss only costs the agent-scoped path.
		let key;
		try {
			key = typeof scopeModule.scopeOf === 'function' ? scopeModule.scopeOf(context) : undefined;
			if (key === undefined && typeof scopeModule.carrierKeyOf === 'function') key = scopeModule.carrierKeyOf(context);
		} catch {
			return undefined;
		}
		if (!looksLikeAgent(key)) return undefined;

		// A scope key can outlive its agent (a disposed session). Asking on behalf
		// of a dead agent would fail `CALLER_NOT_LIVE`, so the registry is the
		// authority on liveness whenever it is reachable, and its absence is not
		// treated as proof either way.
		const agents = readAgentsService(context);
		if (agents === undefined) return key;
		try {
			if (agents.get(key.id) !== key) return undefined;
		} catch {
			return undefined;
		}
		return key;
	};
}

/**
 * Reach the `agents` registry through the context, tolerating an absent service.
 *
 * @param {object} context - any Cordis context
 * @returns {{ get(id: string): unknown } | undefined} the registry, when reachable
 */
function readAgentsService(context) {
	try {
		const get = /** @type {{ get?: (name: string) => unknown }} */ (context).get;
		if (typeof get !== 'function') return undefined;
		const service = /** @type {any} */ (get.call(context, 'agents'));
		if (service === null || typeof service !== 'object') return undefined;
		return typeof service.get === 'function' ? service : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Default module loader.
 *
 * @param {string} specifier - module specifier
 * @returns {Promise<unknown>} the imported module namespace
 */
function defaultLoadModule(specifier) {
	return import(specifier);
}

export default createAgentResolver;

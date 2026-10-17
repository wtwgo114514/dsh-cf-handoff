/**
 * Correlate a `web.fetch` call with the agent that caused it.
 *
 * WHY THIS MODULE EXISTS — the single most important runtime fact
 *
 * `ctx.userQuestions.ask()` is a scope-filtered waterfall. `UserQuestionService.ask`
 * dispatches it as:
 *
 *     agent === undefined
 *       ? this.ctx.waterfall('user-questions/request', request, noAnswerer)
 *       : this.ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', { ...request, agent }, noAnswerer)
 *
 * (`@deepseek-ai/dsh-user-questions/lib/index.js`.) The Web GUI answerer is
 * composed on the **Agent-scoped** waterfall — `dsh-client-ui-user-questions`
 * registers a client half, and the `user-questions/request` row in
 * `dsh-api-remotes` is a `mode: waterfall` remote event. So a question asked
 * WITHOUT an agent never reaches the browser: it falls through to `noAnswerer`
 * and rejects with `NO_PROVIDER`. Supplying the agent is not an optimization
 * here, it is the difference between a working handoff and a dead one.
 *
 * `WebRuntime.fetch(request, signal)` — the seam this plugin wraps — receives
 * only `{ url }` and a signal. The calling agent is nowhere in that call, and
 * `WebRuntime` is a root-level service, so scope probing alone cannot recover
 * it. The agent loop does publish it one layer up: `ToolExecution.agent` is
 * documented as "The agent on whose behalf the call runs (set by the agent
 * loop)", and `tools/pre-execute` is dispatched with
 * `scopeTarget(this, exec.agent)`.
 *
 * So this module observes `tools/pre-execute` and remembers, per invocation,
 * which agent owns the `exec.signal` that the tool body is about to hand to
 * `ctx.web.fetch`. `dsh-tool-web` passes that very signal through
 * (`dsh-tool-web/lib/index.js`: `ctx.web.fetch({ url: input.url }, exec.signal)`),
 * which makes the signal a reliable correlation key for the duration of one
 * call — and a WeakMap means correlation never outlives the call it describes.
 *
 * TWO TIERS, ON PURPOSE. Exact signal identity is the correct key, and it is
 * the only key that is provably about *this* call. But a signal can stop being
 * the same object before it reaches the fetch: any layer that derives one
 * (`AbortSignal.any([signal, timeout])`) silently breaks the identity, and that
 * failure is invisible from the fetch side — it looks exactly like "no human is
 * listening". So a miss falls back to the recorded URL, and only accepts it
 * when every in-flight record for that URL names the same agent. An ambiguous
 * miss returns nothing rather than risking a question about one page popping up
 * in another session.
 *
 * The tool name is deliberately NOT matched: `web_fetch` is the only shipped
 * consumer today, but a deployment that registers its own fetch-backed tool
 * would be correlated too, and recording an agent costs one WeakMap insert.
 *
 * @module dsh-cf-handoff/agent-correlation
 */

/**
 * The tool names this module bothers to correlate.
 *
 * `web_fetch` is the shipped one. The list stays a constant rather than a hard
 * filter because correlation is cheap and a miss only costs the agent-scoped
 * question path.
 */
export const CORRELATED_TOOLS = Object.freeze(['web_fetch']);

/** How many recent records stay available for the non-identity fallback. */
const PENDING_LIMIT = 16;

/**
 * Whether a tool name is one whose fetch calls we want to correlate.
 *
 * @param {unknown} toolName - the executing tool's name
 * @returns {boolean} whether to record the agent for this invocation
 */
export function isCorrelatedTool(toolName) {
	if (typeof toolName !== 'string') return false;
	return CORRELATED_TOOLS.includes(toolName);
}

/**
 * Read the URL a tool invocation is about, when it has one.
 *
 * @param {object} exec - a `ToolExecution`
 * @returns {string | undefined} the requested URL, when the arguments carry one
 */
export function urlOfExecution(exec) {
	try {
		const args = /** @type {any} */ (exec)?.arguments;
		const url = args?.url;
		return typeof url === 'string' && url.length > 0 ? url : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Track which agent owns which in-flight tool call.
 *
 * Create one per plugin instance and close over it from the handoff controller.
 *
 * @returns {{
 *   record(exec: object): void,
 *   lookup(signal: unknown, url?: string): { agent: unknown, detail: string },
 *   agentFor(signal: unknown, url?: string): unknown,
 *   observe(ctx: object): () => void,
 *   size(): number
 * }} the correlation registry
 */
export function createAgentCorrelation() {
	/** @type {WeakMap<object, unknown>} */
	const bySignal = new WeakMap();

	/**
	 * Records kept for the URL fallback, newest last.
	 *
	 * A WeakMap cannot be enumerated, so the same inserts are mirrored here.
	 * Entries are dropped once their signal is aborted and the list is capped, so
	 * this never grows with the number of calls.
	 *
	 * @type {{ signal: unknown, agent: unknown, url: string | undefined }[]}
	 */
	const pending = [];

	/**
	 * How many invocations were recorded.
	 *
	 * A WeakMap has no size, so this counts inserts instead. It exists for
	 * diagnostics: "the observer never fired" and "the observer fired but the
	 * signal did not match" are different faults that look identical from the
	 * fetch side, and one restart shouldn't be spent telling them apart.
	 *
	 * @type {number}
	 */
	let records = 0;

	/**
	 * Drop records whose call can no longer be in flight.
	 *
	 * @returns {void}
	 */
	function prune() {
		for (let index = pending.length - 1; index >= 0; index -= 1) {
			if (/** @type {any} */ (pending[index].signal)?.aborted === true) pending.splice(index, 1);
		}
		while (pending.length > PENDING_LIMIT) pending.shift();
	}

	/**
	 * Remember the agent that owns this invocation.
	 *
	 * @param {object} exec - a `ToolExecution`
	 * @returns {void}
	 */
	function record(exec, budgetMs) {
		const signal = /** @type {any} */ (exec)?.signal;
		const agent = /** @type {any} */ (exec)?.agent;
		if (signal === null || typeof signal !== 'object') return;
		if (agent === null || typeof agent !== 'object') return;
		const budget = typeof budgetMs === 'number' && Number.isFinite(budgetMs) ? budgetMs : undefined;
		bySignal.set(signal, { agent, budgetMs: budget });
		pending.push({ signal, agent, url: urlOfExecution(exec), budgetMs: budget });
		records += 1;
		prune();
	}

	/**
	 * Resolve the agent for one fetch, explaining which tier matched.
	 *
	 * The `detail` is not decoration: it is the only way to tell a wiring fault
	 * from an environment without an answerer, and it is surfaced in the coded
	 * failure the agent reads.
	 *
	 * @param {unknown} signal - the signal the fetch was called with
	 * @param {string} [url] - the URL being fetched, used by the fallback tier
	 * @returns {{ agent: unknown, detail: string }} the owning agent and a diagnostic
	 */
	function lookup(signal, url) {
		const signalIsObject = signal !== null && typeof signal === 'object';

		if (signalIsObject) {
			const exact = bySignal.get(/** @type {object} */ (signal));
			if (exact !== undefined) {
				return { agent: exact.agent, budgetMs: exact.budgetMs, detail: `matched by signal identity (${records} recorded)` };
			}
		}

		prune();
		const diagnostic = `no signal match (${records} recorded, ${pending.length} in flight, signal ${signalIsObject ? 'present' : 'absent'})`;
		if (url === undefined) return { agent: undefined, budgetMs: undefined, detail: diagnostic };

		const sameUrl = pending.filter((entry) => entry.url === url);
		if (sameUrl.length === 0) {
			return { agent: undefined, budgetMs: undefined, detail: `${diagnostic}, no record for this URL` };
		}

		const distinct = new Set(sameUrl.map((entry) => entry.agent));
		if (distinct.size !== 1) {
			return {
				agent: undefined,
				budgetMs: undefined,
				detail: `${diagnostic}, ${sameUrl.length} records for this URL name different agents`
			};
		}

		// One URL, one agent: the identity tier missed but there is still exactly one
		// plausible owner. This is the documented degradation, not a guess.
		return {
			agent: sameUrl[0].agent,
			budgetMs: sameUrl[0].budgetMs,
			detail: `matched by URL only (${sameUrl.length} record(s), signal ${signalIsObject ? 'present' : 'absent'})`
		};
	}

	/**
	 * Resolve the agent for a fetch call, if it came from a correlated tool.
	 *
	 * @param {unknown} signal - the signal the fetch was called with
	 * @param {string} [url] - the URL being fetched
	 * @returns {unknown} the owning agent, or `undefined`
	 */
	function agentFor(signal, url) {
		return lookup(signal, url).agent;
	}

	/**
	 * Install the `tools/pre-execute` observer.
	 *
	 * A plain-context listener is deliberate: `tools/pre-execute` is dispatched
	 * with `scopeTarget(this, exec.agent)`, and an unscoped listener receives
	 * every agent's calls — including subagent calls, which is exactly the case
	 * where the handoff must later refuse to ask (`DELEGATED_CALLER`).
	 *
	 * @param {object} ctx - the plugin context
	 * @returns {() => void} the disposer
	 */
	/**
	 * Read the tool-call budget the timeout policy will enforce for this call.
	 *
	 * `@deepseek-ai/dsh-tool-call-timeout-policy` wraps every call in
	 * `AbortSignal.timeout(definition.timeoutMs)`, so the definition's budget is
	 * the ceiling any in-call wait has to fit inside. Resolution can throw for an
	 * agent-scoped tool or an unavailable agent, so an unreadable budget reports
	 * `undefined` (unknown) instead of a guess.
	 *
	 * @param {any} ctx - the plugin context
	 * @param {object} exec - the intercepted execution
	 * @returns {number | undefined} the enforced budget in milliseconds
	 */
	function budgetOf(ctx, exec) {
		const name = /** @type {any} */ (exec)?.name;
		if (typeof name !== 'string') return undefined;
		try {
			const tools = ctx?.tools;
			if (tools === null || typeof tools !== 'object' || typeof tools.get !== 'function') return undefined;
			const agent = /** @type {any} */ (exec)?.agent;
			const definition = agent === undefined ? tools.get(name) : tools.get(name, agent);
			const budget = /** @type {any} */ (definition)?.timeoutMs;
			return typeof budget === 'number' && Number.isFinite(budget) ? budget : undefined;
		} catch {
			return undefined;
		}
	}

	function observe(ctx) {
		const disposer = ctx.on('tools/pre-execute', (exec, next) => {
			if (isCorrelatedTool(/** @type {any} */ (exec)?.name)) {
				record(/** @type {any} */ (exec), budgetOf(ctx, exec));
			}
			return next();
		});
		return typeof disposer === 'function' ? disposer : () => {};
	}

	return { record, lookup, agentFor, observe, size: () => records };
}

export default createAgentCorrelation;

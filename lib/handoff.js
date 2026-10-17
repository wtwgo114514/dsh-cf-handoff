/**
 * The human side of the handoff: ask, wait, and interpret the answer.
 *
 * WHY `ctx.userQuestions.ask` IS THE PAUSE PRIMITIVE
 * DSH's `tools/post-execute` waterfall can only rewrite a tool's return value —
 * it cannot make the tool run again. So "pause the agent and resume from the
 * breakpoint" cannot be built on a post-execute hook. It has to happen *inside*
 * the fetch itself: the fetch sees the interstitial, asks the user, and then
 * retries within the same call. `ask()` is documented to wait for the human and
 * is aborted by the caller's signal, which is exactly the suspension semantics
 * needed — and it renders as a real question in the DSH Web GUI, where the user
 * already is.
 *
 * ASK SHAPE (verified against `@deepseek-ai/dsh-user-questions`)
 * `ask(request)` takes `{ questions, agent?, signal? }` where each question is
 * `{ id, question, header?, options?, multiSelect? }`, and resolves to
 * `{ answers: [{ id, selected: string[], custom?: string }] }`. TypeScript-style
 * camelCase `multiSelect` is accepted here and mapped onto the documented
 * `multi_select` wire spelling, because the shipped answerer reads the
 * snake_case key.
 *
 * This module holds no I/O of its own; the controller takes the question
 * service, the browser handoff, and an agent resolver as parameters so it can be
 * tested without a GUI or a desktop.
 *
 * @module dsh-cf-handoff/handoff
 */

/**
 * Stable option values. These strings are what {@link parseAnswer} matches, so
 * they are part of the module's observable contract.
 */
export const HANDOFF_ANSWERS = Object.freeze({
	done: 'verified',
	paste: 'paste',
	refused: 'refused'
});

/**
 * @typedef {object} HandoffOutcome
 * @property {'verified' | 'pasted' | 'refused' | 'unavailable'} action - what came back
 * @property {string} [reason] - free-text explanation, for `refused` / `unavailable`
 * @property {{ kind: 'html' | 'text', content: string }} [body] - synthesized body, for `pasted`
 * @property {number} attempts - how many handoffs this call consumed
 * @property {string} [browserPath] - the staged bootstrap page that was opened
 * @property {string} [openError] - opener failure message, when the browser could not be launched
 */

/**
 * Decide the `WebBody` kind for pasted content.
 *
 * A pasted fragment that contains markup is returned as `html` so the normal
 * downstream rendering path sees the same shape it would have seen from the
 * network; anything else is returned as `text`.
 *
 * @param {string} content - the pasted text
 * @returns {'html' | 'text'} the body kind
 */
export function classifyPastedBody(content) {
	const text = String(content);
	const looksLikeHtml = /<\/?[a-z][a-z0-9-]*(\s|>|\/)/i.test(text) || /&(?:[a-z]+|#\d+);/i.test(text);
	return looksLikeHtml ? 'html' : 'text';
}

/**
 * Interpret one user answer.
 *
 * Matching is prefix-based and case-insensitive because the value arrives as a
 * prefix-tagged custom answer (`verified: <free text>`), and option labels are
 * matched as a fallback in case a client echoes the label instead of the value.
 * Unrecognized text that is not clearly a refusal is treated as pasted content:
 * the user went to the trouble of typing something, so using it beats asking
 * again.
 *
 * @param {string} answer - the raw answer string
 * @returns {{ action: 'verified' | 'pasted' | 'refused', reason?: string, content?: string }} the interpretation
 */
export function parseAnswer(answer) {
	const raw = String(answer ?? '');
	const trimmed = raw.trim();
	if (trimmed.length === 0) return { action: 'refused', reason: 'empty answer' };

	const folded = trimmed.toLowerCase();

	// Refusal is checked first: it is the only interpretation that abandons the
	// fetch, so a false negative here (treating a refusal as content) costs more
	// than a false positive.
	if (/^(?:refus|declin|skip\b|stop\b|cancel|abort|no\b)/.test(folded)) {
		const reason = trimmed.replace(/^[^:]*:\s*/, '').trim();
		return { action: 'refused', reason: reason.length > 0 ? reason : 'user declined the handoff' };
	}
	if (
		/(?:^|\b)(?:verified|done|ok|okay|cleared|passed|retry|go ahead)\b/.test(folded) ||
		/(?:完成|好了|过了|通过|已过|重试)/.test(trimmed)
	) {
		return { action: 'verified' };
	}

	const pasteMatch = /^paste\s*:\s*([\s\S]*)$/.exec(trimmed);
	if (pasteMatch !== null) return { action: 'pasted', content: pasteMatch[1] };
	if (folded === HANDOFF_ANSWERS.paste) return { action: 'pasted', content: '' };

	return { action: 'pasted', content: trimmed };
}

/**
 * Build the question the human answers in the DSH Web GUI.
 *
 * @param {object} input - question input
 * @param {string} input.url - the blocked URL
 * @param {{ summary?: string }} input.verdict - detection verdict
 * @param {boolean} [input.reused] - whether the browser was already opened for this URL
 * @returns {object[]} an `AgentQuestion[]`
 */
export function buildHandoffQuestions(input) {
	const target = String(input.url);
	const verdictLine = typeof input?.verdict?.summary === 'string' ? input.verdict.summary : 'Cloudflare interstitial detected';
	const intro = input.reused
		? 'Still blocked after you verified. If the page is open in your browser, paste the content instead; otherwise retry.'
		: "A Cloudflare check is in the way, so this fetch can't finish without you.";
	return [
		{
			id: 'cf_handoff',
			header: 'Cloudflare handoff',
			question: `${intro}\n\nI opened it in your default browser. Clear the check there, then answer below. If you would rather not, paste the page content as your answer.`,
			// The blocked URL belongs in `detail`, not in `question`: `detail` is
			// "rendered with the question but kept out of option labels", and the
			// Web GUI renders markdown, so a link here is clickable. `question` is
			// the plain line shown above the options.
			detail: `${verdictLine}\n\n[Open ${target}](${target})`,
			options: [
				{ label: 'Verified — retry the fetch now' },
				{ label: 'Refuse — stop this fetch' }
			]
		}
	];
}

/**
 * Normalize the return value of `UserQuestionsService.ask`.
 *
 * The documented shape is `{ answers: [{ id, selected, custom }] }`, but a
 * single-question client may also resolve to a bare string or a map. All three
 * are accepted so a transport change does not break the handoff, and a chosen
 * option value wins over free text.
 *
 * @param {unknown} result - the `ask()` resolution
 * @param {string} questionId - the id whose answer is wanted
 * @returns {string} the answer text (empty when absent)
 */
export function readAnswerValue(result, questionId) {
	if (typeof result === 'string') return result;
	if (result === null || typeof result !== 'object') return '';
	const record = /** @type {Record<string, unknown>} */ (result);

	const answers = record.answers;
	if (Array.isArray(answers)) {
		/** @type {string} */
		let unmatched = '';
		for (const entry of answers) {
			if (entry === null || typeof entry !== 'object') continue;
			const answer = /** @type {Record<string, unknown>} */ (entry);
			const custom = typeof answer.custom === 'string' && answer.custom.trim().length > 0 ? answer.custom : undefined;
			const selected =
				Array.isArray(answer.selected) && typeof answer.selected[0] === 'string' ? answer.selected[0] : undefined;
			const value = custom ?? selected;
			if (value === undefined) continue;
			// An id the caller recognizes wins, but an answer carrying a different id
			// is still that user's answer. Silently dropping it would be reported as
			// "the channel returned nothing" — a wrong diagnosis that points at the
			// transport instead of at an id mismatch, and one that loses the answer
			// the user actually gave. `ask()` echoes the ids it was sent, so this is
			// a defect path, not a routine one.
			if (typeof answer.id !== 'string' || answer.id === questionId) return value;
			unmatched ||= value;
		}
		if (unmatched.length > 0) return unmatched;
	}

	const direct = record[questionId];
	if (typeof direct === 'string') return direct;
	if (direct !== null && typeof direct === 'object' && typeof (/** @type {any} */ (direct).value) === 'string') {
		return /** @type {any} */ (direct).value;
	}
	return '';
}

/**
 * Build the model-facing notice for a challenge that cannot be waited out here.
 *
 * WHY THIS EXISTS — the second structural constraint this platform imposes
 *
 * `@deepseek-ai/dsh-tool-call-timeout-policy` wraps every `tools/execute` with
 * `deadline(exec.signal, ctx.tools.get(exec.name, exec.agent)?.timeoutMs)`, and
 * `web_fetch` declares `ToolDefinition.timeoutMs = fetchTimeoutMs`
 * (`DEFAULT_WEB_TOOL_TIMEOUT_MS = 3e4`). So **one `web_fetch` call can never
 * block for 30 seconds**, let alone for a human to open a browser and clear a
 * Cloudflare challenge. Worse than failing, the wrapper *replaces* the result
 * with a generic `tool call timed out after 30000ms`, so an in-call handoff
 * destroys its own diagnosis: the user sees a bare timeout instead of an
 * explanation and a URL.
 *
 * `ask_user_question`, by contrast, declares no `timeoutMs` at all, which makes
 * the policy wrapper skip it entirely (`if (timeoutMs === void 0) return next()`).
 * It is the only seam in the product that can wait for a person indefinitely.
 *
 * So the default handoff is: detect, report precisely, open the page, and hand
 * the *waiting* to that tool. The fetch never blocks, nothing can hang, and the
 * human gets a card that stays up for as long as they need.
 *
 * @param {object} input - what to report
 * @param {string} input.url - the blocked URL
 * @param {{ summary?: string }} [input.verdict] - detection verdict
 * @param {string} [input.browserPath] - the staged page that was opened
 * @param {string} [input.openError] - why the browser could not be opened
 * @param {string} [input.reason] - why this was not handled in-call
 * @returns {string} the message to fail with
 */
export function buildChallengeNotice(input) {
	const url = input.url;
	const lines = [
		`Cloudflare challenge on ${url} — the page content was NOT retrieved.`,
		`${input.verdict?.summary ?? 'Cloudflare interstitial detected'}.`
	];
	if (input.browserPath !== undefined) lines.push(`A tab linking to it was opened in the user's default browser (staged page: ${input.browserPath}).`);
	if (input.openError !== undefined) lines.push(`The browser could not be opened automatically (${input.openError}).`);
	if (input.reason !== undefined) lines.push(`This was not waited out inside the fetch: ${input.reason}.`);
	lines.push(
		'',
		'Await the human with ask_user_question, then follow their answer — the challenge is the verification step, so re-running this fetch blindly only produces the same interstitial:',
		'- "verified": call web_fetch again on the same URL, once. If the challenge is still there, the page is unreachable — say so.',
		'- "paste": the answer text IS the page. Do not fetch again.',
		'- "skip": the page is unreachable. Say so; never present it as read.',
		'',
		`Put the URL in the question's \`detail\` field as a markdown link so the user can click it: [Open ${url}](${url}).`
	);
	return lines.join('\n');
}

/**
 * Run handoffs for one fetch and remember their outcome.
 *
 * One controller belongs to one fetch call, so its `attempts` counter is a
 * per-call retry budget that a hostile page cannot reset by re-triggering the
 * interstitial.
 */
export class HandoffController {
	/**
	 * @param {object} deps - injected dependencies
	 * @param {{ ask(request: unknown): Promise<unknown> }} deps.userQuestions - the question service
	 * @param {{ open(url: string, reason: string, signal: AbortSignal): Promise<string> }} [deps.browser] - browser handoff
	 * @param {(signal: unknown, context: unknown) => Promise<unknown | undefined>} [deps.resolveAgent] - recovers the calling agent
	 * @param {() => number | undefined} [deps.budget] - the enforced tool-call budget in ms, when known
	 * @param {number} [deps.minHumanBudgetMs] - budget below which an in-call wait cannot work
	 * @param {number} [deps.maxAttempts] - per-fetch retry budget (default 1)
	 * @param {(message: string) => void} [deps.onWarn] - non-fatal diagnostics sink
	 * @param {() => string} [deps.describe] - extra diagnostics for an unreachable user
	 */
	constructor(deps) {
		if (deps?.userQuestions === undefined || deps.userQuestions === null) {
			throw new TypeError('HandoffController requires a userQuestions service');
		}
		if (typeof deps.userQuestions.ask !== 'function') {
			throw new TypeError('userQuestions service does not expose ask(request)');
		}
		this.userQuestions = deps.userQuestions;
		this.browser = deps.browser;
		this.resolveAgent = typeof deps.resolveAgent === 'function' ? deps.resolveAgent : async () => undefined;
		this.maxAttempts = Number.isFinite(deps.maxAttempts) ? Math.max(0, Number(deps.maxAttempts)) : 1;
		this.onWarn = typeof deps.onWarn === 'function' ? deps.onWarn : () => {};
		this.describe = typeof deps.describe === 'function' ? deps.describe : () => '';
		this.budget = typeof deps.budget === 'function' ? deps.budget : () => undefined;
		this.minHumanBudgetMs = Number.isFinite(deps.minHumanBudgetMs) ? Number(deps.minHumanBudgetMs) : 120000;
		/** @type {number} how many handoffs this fetch has consumed */
		this.attempts = 0;
		/** @type {string[]} bootstrap pages staged during this fetch */
		this.stagedPaths = [];
	}

	/** @returns {boolean} whether another handoff is allowed */
	get canRetry() {
		return this.attempts < this.maxAttempts;
	}

	/**
	 * Whether this deployment can afford to wait for a person inside the call.
	 *
	 * `@deepseek-ai/dsh-tool-call-timeout-policy` enforces
	 * `ToolDefinition.timeoutMs` around the whole tool call, and `web_fetch`
	 * declares 30 s. An in-call wait longer than that budget does not merely fail:
	 * the wrapper aborts the call and substitutes `tool call timed out after
	 * Nms`, which discards whatever this plugin wanted to say. So the plugin
	 * refuses to start a wait it cannot finish.
	 *
	 * `undefined` means the budget could not be read, and the wait is allowed —
	 * an unreadable budget is not evidence of a short one, and the caller may have
	 * raised `fetchTimeoutMs` in a way this probe did not observe.
	 *
	 * @returns {{ viable: boolean, reason?: string }} the verdict
	 */
	inlineViability() {
		const budgetMs = this.budget();
		if (typeof budgetMs !== 'number' || !Number.isFinite(budgetMs)) return { viable: true };
		if (budgetMs >= this.minHumanBudgetMs) return { viable: true };
		return {
			viable: false,
			reason:
				`the tool call is budgeted at ${budgetMs}ms but a human round trip needs at least ` +
				`${this.minHumanBudgetMs}ms, so an in-call wait would be killed by the timeout policy ` +
				`and its generic message would replace this one (raise tool-web's fetchTimeoutMs to allow it)`
		};
	}

	/**
	 * Stage a page and hand it to the system browser, if one is available.
	 *
	 * Kept separate from {@link request} so the non-blocking mode can still save
	 * the user a step: opening the page is useful whether or not the plugin is
	 * the one that waits.
	 *
	 * @param {object} input - handoff input
	 * @param {string} input.url - the blocked URL
	 * @param {{ summary?: string }} [input.verdict] - detection verdict
	 * @param {AbortSignal} [input.signal] - caller lifetime
	 * @param {boolean} [input.openBrowser] - whether to open the browser
	 * @returns {Promise<{ browserPath?: string, openError?: string }>} what happened
	 */
	async openPage(input) {
		/** @type {{ browserPath?: string, openError?: string }} */
		const opened = {};
		if (input.openBrowser === false || this.browser === undefined || this.browser === null) return opened;
		try {
			opened.browserPath = await this.browser.open(
				input.url,
				input.verdict?.summary ?? 'Cloudflare interstitial detected',
				input.signal
			);
			this.stagedPaths.push(opened.browserPath);
		} catch (error) {
			// A failed browser launch must not lose the handoff: the question still
			// carries the URL, so the user can open it by hand.
			if (input.signal?.aborted === true) throw error;
			opened.openError = error instanceof Error ? error.message : String(error);
			this.onWarn(`could not open the system browser: ${opened.openError}`);
		}
		return opened;
	}

	/**
	 * Ask the human to clear one interstitial, optionally opening a browser.
	 *
	 * @param {object} input - handoff input
	 * @param {string} input.url - the blocked URL
	 * @param {{ summary?: string }} input.verdict - detection verdict
	 * @param {AbortSignal} [input.signal] - caller lifetime
	 * @param {object} [input.context] - the context that performed the fetch
	 * @param {boolean} [input.openBrowser] - whether to open the browser (default true when available)
	 * @returns {Promise<HandoffOutcome>} the human's decision
	 */
	async request(input) {
		if (!this.canRetry) {
			throw new Error('handoff retry budget exhausted');
		}
		this.attempts += 1;
		const reused = this.stagedPaths.length > 0;
		const { browserPath, openError } = await this.openPage(input);

		const questions = buildHandoffQuestions({ url: input.url, verdict: input.verdict ?? {}, reused });
		const answerResult = await this.askWithFallback(questions, input.signal, { url: input.url });
		if (answerResult.unavailable !== undefined) {
			const outcome = { action: /** @type {const} */ ('unavailable'), reason: answerResult.unavailable, attempts: this.attempts };
			if (browserPath !== undefined) outcome.browserPath = browserPath;
			if (openError !== undefined) outcome.openError = openError;
			return outcome;
		}

		const parsed = parseAnswer(readAnswerValue(answerResult.value, questions[0].id));
		/** @type {HandoffOutcome} */
		const outcome = { action: parsed.action, attempts: this.attempts };
		if (browserPath !== undefined) outcome.browserPath = browserPath;
		if (openError !== undefined) outcome.openError = openError;
		if (parsed.action === 'refused') {
			const reason = parsed.reason ?? 'user declined the handoff';
			if (reason === 'empty answer') {
				outcome.action = 'unavailable';
				outcome.reason = 'the question channel returned an empty answer';
				return outcome;
			}
			outcome.reason = reason;
			return outcome;
		}
		if (parsed.action === 'pasted') {
			const content = parsed.content ?? '';
			if (content.trim().length === 0) {
				outcome.action = 'unavailable';
				outcome.reason = 'no content arrived with the paste answer';
				return outcome;
			}
			outcome.body = { kind: classifyPastedBody(content), content };
		}
		return outcome;
	}

	/**
	 * Ask with the calling agent when it can be recovered, then without it.
	 *
	 * Supplying the agent is the difference between a working handoff and a dead
	 * one: `UserQuestionService.ask` routes an agent-bearing request through
	 * `scopeTarget(agent, agent)` on the scope-filtered `user-questions/request`
	 * waterfall, and the Web GUI answerer is composed there. Without an agent the
	 * question is asked on the root waterfall, which the browser never sees.
	 *
	 * The scoped ask can still fail before anything is displayed:
	 * - `NO_PROVIDER` — no answerer on the agent-scoped path either. The unscoped
	 *   waterfall is then tried once, because an answerer registered on the root
	 *   remote bus would still see it.
	 * - `CALLER_NOT_LIVE` — the recovered agent is no longer the registry's live
	 *   instance, so it is discarded and the unscoped path is tried.
	 * - `DELEGATED_CALLER` — a real human owner exists but it is the *parent*
	 *   agent's, so this fetch came from an owned child. Falling back unscoped
	 *   here would pop a question about a subagent's URL into the parent's
	 *   session. That is reported as unavailable instead, and the caller turns it
	 *   into a coded error naming the URL.
	 *
	 * Anything else is a real answer (including `ASK_ABORTED`, which means the
	 * turn was cancelled) and is rethrown untouched.
	 *
	 * @param {object[]} questions - the questions to ask
	 * @param {AbortSignal | undefined} signal - caller lifetime
	 * @param {{ url?: string } | undefined} context - what the fetch was about, for correlation
	 * @returns {Promise<{ value?: unknown, unavailable?: string }>} the answer or a reason
	 */
	async askWithFallback(questions, signal, context) {
		const wireQuestions = questions.map((question) => ({
			...question,
			...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect })
		}));

		// Why the trail exists: "no answerer" is the same message for three different
		// faults - no agent was associated with the fetch, the agent was associated
		// but the scoped ask was refused, or the agent was fine and only the unscoped
		// retry failed. Without the distinction the operator cannot tell a wiring bug
		// from a deployment without an answerer, so the reason names each step.
		const trail = [];

		let agent;
		try {
			agent = await this.resolveAgent(signal, context);
		} catch (error) {
			trail.push(`agent lookup threw: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (agent === undefined) trail.push('no agent associated with this fetch');
		else trail.push('agent associated');

		const detail = this.describe();
		if (detail.length > 0) trail.push(detail);

		if (agent !== undefined) {
			try {
				return { value: await this.userQuestions.ask({ questions: wireQuestions, agent, signal }) };
			} catch (error) {
				const code = errorCode(error);
				if (code === 'DELEGATED_CALLER') {
					return {
						unavailable:
							'this fetch was made by an agent owned by another agent, which has no human answerer of its own'
					};
				}
				if (!isUnansweredChannelError(error)) throw error;
				trail.push(`scoped ask: ${code ?? 'unknown'}`);
				this.onWarn(`scoped question failed (${code ?? 'unknown'}); retrying unscoped`);
			}
		}

		try {
			return { value: await this.userQuestions.ask({ questions: wireQuestions, signal }) };
		} catch (error) {
			if (!isUnansweredChannelError(error)) throw error;
			trail.push(`unscoped ask: ${errorCode(error) ?? 'NO_PROVIDER'}`);
			return {
				unavailable: `no user-questions answerer accepted the request (${trail.join('; ')})`
			};
		}
	}
}

/**
 * Read a stable error code off a thrown value.
 *
 * @param {unknown} error - a thrown value
 * @returns {string | undefined} the code, when present
 */
export function errorCode(error) {
	return error !== null && typeof error === 'object' && typeof (/** @type {any} */ (error).code) === 'string'
		? /** @type {any} */ (error).code
		: undefined;
}

/**
 * Whether an error means "nobody was there to answer", as opposed to a real
 * answer, a cancellation, or an unrelated failure.
 *
 * @param {unknown} error - a thrown value
 * @returns {boolean} whether the channel was unavailable
 */
export function isUnansweredChannelError(error) {
	const code = errorCode(error);
	if (code === undefined) return false;
	// `ASK_ABORTED` and `EMPTY_QUESTIONS` / `BAD_INTENT` are caller-side problems
	// that a retry cannot fix, so they are deliberately absent here.
	return code === 'NO_PROVIDER' || code === 'CALLER_NOT_LIVE' || code === 'DELEGATED_CALLER';
}

export default HandoffController;

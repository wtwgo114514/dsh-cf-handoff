/**
 * Live wiring smoke test: real Cordis, real `WebRuntime`, real `UserQuestionService`.
 *
 * WHAT THIS PROVES THAT THE UNIT TESTS CANNOT
 *
 * `test/provider.test.mjs` drives the intercept with fakes on both sides, so it
 * cannot show that the runtime claims the design rests on are true of the
 * shipped packages:
 *
 *   1. `ctx.web.fetch` is a replaceable own method on the live `WebRuntime`, and
 *      the wrapper still goes through `dsh-web`'s own provider resolution.
 *   2. `WebRuntime` accepts a registered fetch provider, so a fixture can stand
 *      in for the network.
 *   3. `scopeTarget(agent, agent)` admits an answerer registered on that agent's
 *      real scope, and `carrierKeyOf` on that carrier returns the agent — which
 *      is what `lib/agent-scope.js`'s fallback depends on.
 *   4. `tools/pre-execute` observed from a plain context really does reach the
 *      correlation table keyed by the signal the tool hands to `web.fetch`.
 *
 * Claim 4 is the one worth the whole file. `@deepseek-ai/dsh-scope`'s
 * `scopeTarget` admits a listener whose context carries NO scope tag
 * unconditionally, and the agent loop dispatches with `scopeTarget(this, exec.agent)`.
 * If that admission rule were the other way round, the observer would silently
 * record nothing and every handoff would degrade to "no answerer" — a failure
 * that looks like the network, not like a bug.
 *
 * Hermetic: no network, no filesystem, no browser. The browser half is excluded
 * on purpose so CI cannot open windows; `openBrowser: false` exercises exactly
 * the headless path that must work without an opener.
 *
 * Run: node test/live-smoke.mjs   (or npm run test:smoke)
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const PROFILE_ROOT = 'C:/Users/j1583/.dsh/profiles';

/** Resolve the harness packages the way the running profile does. */
const requireFromProfile = createRequire(`${PROFILE_ROOT}/package.json`);
function loadHarnessModule(specifier) {
	return import(pathToFileURL(requireFromProfile.resolve(specifier)).href);
}

const { Context, Service } = await loadHarnessModule('@deepseek-ai/cordis');
const { WebRuntime } = await loadHarnessModule('@deepseek-ai/dsh-web');
const { UserQuestionService, UserQuestionError } = await loadHarnessModule('@deepseek-ai/dsh-user-questions');
const { createScope, scopeTarget, carrierKeyOf, scopeOf } = await loadHarnessModule('@deepseek-ai/dsh-scope');

const plugin = await import('../lib/index.js');

let failures = 0;

/** The URL the fixture provider serves, and the one the handoff must name. */
const blocked = 'https://example.test/protected';
function check(label, condition, detail) {
	if (condition) console.log(`  ok   ${label}`);
	else {
		failures += 1;
		console.log(`  FAIL ${label}${detail === undefined ? '' : `  (${detail})`}`);
	}
}

/**
 * Fixture fetch provider: a challenge on the first call, real content after.
 *
 * Registered under its own id so `WebRuntime`'s resolver sees exactly one
 * available fetch provider and picks it with no configuration — which also
 * exercises the "exactly one available provider" branch.
 */
function createFixtureProvider() {	const script = [
		{ statusCode: 403, body: { kind: 'html', content: '<html><head><title>Just a moment...</title></head><body></body></html>' } },
		{ statusCode: 200, body: { kind: 'html', content: '<html><body><h1>Recovered</h1><p>content after the human acted</p></body></html>' } },
	];
	let index = 0;
	return {
		id: 'cf-handoff-smoke-fixture',
		available: () => true,
		async fetch(request) {
			const step = script[Math.min(index, script.length - 1)];
			index += 1;
			return { url: request.url, statusCode: step.statusCode, body: step.body, truncated: false };
		},
		calls: () => index,
	};
}

async function main() {
	console.log('dsh-cf-handoff live wiring smoke\n');

	// -------------------------------------------------------------- real services
	const ctx = new Context();
	const web = new WebRuntime(ctx, {});
	const users = new UserQuestionService(ctx);
	const fixture = createFixtureProvider();
	web.registerFetchProvider(fixture);

	check('the live context resolves the real web service', ctx.web !== undefined && ctx.web.fetch !== undefined);
	check('the live context resolves the real user-questions service', ctx.userQuestions !== undefined);
	check('WebRuntime exposes a replaceable own fetch method', Object.hasOwn(WebRuntime.prototype, 'fetch'));

	// Quiet the harness logger; the plugin's own reports are collected instead.
	const reports = [];
	ctx.logger.info = (...args) => reports.push(['info', args.join(' ')]);
	ctx.logger.warn = (...args) => reports.push(['warn', args.join(' ')]);

	// A real scope key: an agent-shaped subject is all `scopeTarget` and the
	// plugin's `carrierKeyOf` fallback touch.
	const agent = { id: 'agent-smoke-1' };
	const scope = createScope(ctx, agent);
	agent.ctx = scope.ctx;

	// `UserQuestionService.ask` validates a supplied agent against the registry,
	// so the live agent must be reachable there. A real `Service` is required:
	// `ctx.set` refuses to introduce an unknown service.
	class AgentsStub extends Service {
		constructor(serviceCtx) {
			super(serviceCtx, 'agents');
		}
		get(id) {
			return id === agent.id ? agent : undefined;
		}
		roots() {
			return [agent];
		}
	}
	new AgentsStub(ctx);

	// A stand-in for the Web GUI: an answerer on the agent's own scope.
	//
	// The captured questions are read eagerly. `request.questions` is the live
	// service's own array proxy — indexing it works, reading named fields off the
	// elements later does not — so waiting to read them after the ask returns
	// sees nothing.
	const questions = [];
	let answering = true;
	let answer = { answers: [{ id: 'cf_handoff', selected: ['verified'] }] };
	scope.ctx.on('user-questions/request', (request, next) => {
		// Declining the request with `next()` is what an absent or disinterested
		// human looks like: the waterfall falls through to the service's own
		// built-in decision.
		if (!answering) return next();
		const source = request?.questions;
		const items = [];
		for (let index = 0; index < (source?.length ?? 0); index += 1) items.push(source[index]);
		questions.push(items);
		return answer;
	});

	// ------------------------------------------------------------------- the plugin
	const askCalls = [];
	const realAsk = ctx.userQuestions.ask.bind(ctx.userQuestions);
	ctx.userQuestions.ask = async (request) => {
		try {
			const value = await realAsk(request);
			askCalls.push({ agent: request?.agent?.id, ok: true, value });
			return value;
		} catch (error) {
			askCalls.push({ agent: request?.agent?.id, ok: false, code: error?.code, message: error?.message });
			throw error;
		}
	};
	plugin.apply(ctx, { enabled: true, openBrowser: false, autoNavigate: false, maxAttempts: 1, mode: 'inline' });

	check('the plugin replaced the fetch method on the live service', ctx.web.fetch !== web.__proto__?.fetch);
	check('the plugin installed without warning', !reports.some(([level]) => level === 'warn'), JSON.stringify(reports));

	// ------------------------------------------------- claim 3: agent-scope routing
	{
		check('carrierKeyOf(scopeTarget(agent, agent)) returns the agent', carrierKeyOf(scopeTarget(agent, agent)) === agent);
		check('scopeOf(agent.ctx) returns the agent', scopeOf(agent.ctx) === agent);

		const result = await ctx.userQuestions.ask({
			questions: [{ id: 'cf-handoff', question: 'open it?', options: [{ label: 'verified' }] }],
			agent,
		});
		check(
			'a question asked with the agent reaches the agent-scoped answerer',
			questions.length === 1 && result.answers[0].selected[0] === 'verified',
			`asked=${questions.length}`
		);
	}

	// ------------------------------- claim 4 + the whole intercept, one real fetch
	{
		const signal = new AbortController().signal;
		const exec = { name: 'web_fetch', signal, agent };

		// Exactly what the agent loop does immediately before dispatching a tool.
		const seen = [];
		const probe = ctx.on('tools/pre-execute', (e, next) => {
			seen.push(e?.name);
			return next();
		});
		const decision = await ctx.waterfall(scopeTarget(exec, exec.agent), 'tools/pre-execute', exec, async () => ({ kind: 'allow' }));
		probe();
		check('a plain-context listener receives an agent-scoped pre-execute', seen.length === 1, `seen=${JSON.stringify(seen)}`);
		check('the pre-execute waterfall reaches its built-in decision', decision?.kind === 'allow', JSON.stringify(decision));

		// The correlation itself, isolated from the fetch: if this passes and the
		// fetch still cannot find the agent, the defect is in the plugin's wiring
		// rather than in Cordis's dispatch.
		const { createAgentCorrelation } = await import('../lib/agent-correlation.js');
		const solo = createAgentCorrelation();
		const stopSolo = solo.observe(ctx);
		await ctx.waterfall(scopeTarget(exec, exec.agent), 'tools/pre-execute', exec, async () => ({ kind: 'allow' }));
		stopSolo();
		check('the correlation records the agent for the pre-execute signal', solo.agentFor(signal) === agent, `agentFor=${solo.agentFor(signal)?.id}`);

		// The signal the tool body receives is NOT the signal `tools/pre-execute`
		// saw: `ToolRegistry.dispatchToolBody` overwrites `exec.signal` with a
		// fused one (`fuseToolSignals(state.callerSignal, wrapperSignal)`), so any
		// around-wrapper makes `caller !== wrapper` and the body gets a brand-new
		// signal. This shipped once with a signal-only key and then reported
		// NO_PROVIDER on a real page while every fake-based test passed. Fetching
		// with a signal nobody recorded is what makes the rest of this block a
		// regression test for that: nothing below can pass unless the URL tier
		// recovered the agent and the question was actually asked with it.
		const fused = new AbortController().signal;
		check('the signal handed to the tool body differs from the recorded one', fused !== signal);

		const result = await ctx.web.fetch({ url: blocked }, fused);
		check('the intercept did not throw', true);

		check('the fixture was called twice (challenge, then retry)', fixture.calls() === 2, `calls=${fixture.calls()}`);
		check(
			'the retry returned the post-verification content',
			result.statusCode === 200 && result.body.content.includes('Recovered'),
			`status=${result.statusCode}`
		);

		// Everything the handoff asked for must survive to the answerer intact:
		// exactly one question, carrying the blocked URL as a clickable link.
		check(
			'the handoff named the blocked URL as a clickable link',
			questions.length === 2 && String(questions[1]?.[0]?.detail ?? '').includes(`](${blocked})`),
			`asked=${questions.length} detail=${String(questions[1]?.[0]?.detail ?? '<none>').slice(0, 80)}`
		);
		check(
			'the handoff question kept its id, header and both options',
			String(questions[1]?.[0]?.id) === 'cf_handoff' &&
				String(questions[1]?.[0]?.header) === 'Cloudflare handoff' &&
				(questions[1]?.[0]?.options?.length ?? 0) === 2,
			`id=${String(questions[1]?.[0]?.id)} header=${String(questions[1]?.[0]?.header)} options=${questions[1]?.[0]?.options?.length}`
		);
	}

	// ------- the other direction: with no answerer, an ask must fail, not hang
	{
		answering = false;
		let code;
		let detail;
		try {
			await ctx.userQuestions.ask({ questions: [{ id: 'x', question: 'unreachable?' }] });
		} catch (error) {
			code = error instanceof UserQuestionError ? error.code : error?.code;
			detail = `${error?.constructor?.name}: ${error?.message}`;
		}
		answering = true;
		check('an unanswered ask fails fast instead of hanging', typeof code === 'string', `code=${code} ${detail}`);
	}

	// ------------------------------------------------------------ reinstall safety
	{
		// The service's own runtime is what must not be re-wrapped. Identity of
		// `ctx.web.fetch` cannot be compared: the context is a Cordis proxy that
		// re-derives a contextually bound getter on every read, so two reads of the
		// same member are never `===`. The install guard reports instead.
		reports.length = 0;
		let thrown;
		try {
			plugin.apply(ctx, { enabled: true, openBrowser: false, maxAttempts: 1 });
		} catch (error) {
			thrown = error;
		}
		check('a second install does not throw', thrown === undefined, `${thrown?.constructor?.name}: ${thrown?.message}`);
		check(
			'a second install declines to stack another wrapper',
			reports.some(([level, message]) => level === 'info' && message.includes('already installed')),
			`reports=${JSON.stringify(reports).slice(0, 160)}`
		);
	}

	await scope.dispose();

	console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — live wiring smoke`);
	process.exitCode = failures === 0 ? 0 : 1;
}

await main();
assert.ok(true);

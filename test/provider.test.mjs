/**
 * Provider tests: the fetch intercept, its retry budget, and its error surface.
 *
 * These drive the real `installFetchHandoff` over a fake web runtime, so they
 * cover the wiring that the handoff tests cannot: how many times the delegate is
 * asked, what the caller finally sees, and which failures are coded.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	HANDOFF_MARKER,
	installFetchHandoff,
	readHandoffMarker,
	resolveHandoffConfig,
	unwrapHandoffResult
} from '../lib/provider.js';
import { HandoffController } from '../lib/handoff.js';
import { detectCfInterstitial } from '../lib/cf-detect.js';

const CHALLENGE_HTML = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>';
const REAL_HTML = '<!DOCTYPE html><html><head><title>Docs</title></head><body><h1>Real page</h1></body></html>';

/** A fetch result shaped like a provider's. */
function result(content, statusCode = 200, url = 'https://example.test/') {
	return { url, statusCode, body: { kind: 'html', content }, truncated: false };
}

/**
 * A fake web runtime counting delegate calls.
 *
 * @param {Array<object | (() => object)>} scripted - one entry per delegate call
 * @param {string} [url] - the request URL the runtime reports
 */
function runtime(scripted, url = 'https://example.test/') {
	let index = 0;
	const calls = [];
	return {
		calls,
		fetchCalls: () => index,
		async fetch(request, signal) {
			calls.push({ request, signal });
			const entry = index < scripted.length ? scripted[index] : scripted[scripted.length - 1];
			index += 1;
			return typeof entry === 'function' ? entry() : entry;
		}
	};
}

/** An `ask` stub answering with one of the handoff option values. */
function askStub(value) {
	const calls = [];
	return {
		calls,
		async ask(request) {
			calls.push(request);
			return { answers: [{ id: 'cf_handoff', selected: [value] }] };
		}
	};
}

/**
 * Install the intercept with sensible test defaults.
 *
 * @param {object} options - overrides
 */
function install(options) {
	const { runtime: target, maxAttempts: topLevelAttempts, ...rest } = options;
	// The budget lives in the plugin config; accept it either place so a test can
	// set it without restating the whole config object.
	const maxAttempts = topLevelAttempts ?? rest.config?.maxAttempts;
	// Interception semantics (challenge -> ask -> retry) exist only in `inline`
	// mode; `notify` reports and returns by design. The suite states the mode
	// explicitly so no test silently depends on the shipped default.
	const config = { mode: 'inline', ...rest.config, ...(maxAttempts === undefined ? {} : { maxAttempts }) };
	return installFetchHandoff({
		runtime: target,
		createController: () =>
			new HandoffController({
				userQuestions: rest.userQuestions ?? askStub('verified'),
				browser: rest.browser,
				// Mirrors the plugin wiring: the controller's budget comes from the
				// same resolved config the intercept reads.
				maxAttempts
			}),
		config,
		onWarn: rest.onWarn
	});
}

test('a clean response passes through untouched', async () => {
	const target = runtime([result(REAL_HTML)]);
	install({ runtime: target, userQuestions: askStub('verified') });
	const fetched = await target.fetch({ url: 'https://example.test/' });
	assert.equal(fetched.body.content, REAL_HTML);
	assert.equal(fetched.statusCode, 200);
	assert.equal(target.fetchCalls(), 1);
});

test('a challenge is handed off and retried once the user verifies', async () => {
	const target = runtime([result(CHALLENGE_HTML, 403), result(REAL_HTML, 200)]);
	const userQuestions = askStub('verified');
	const browser = { opened: [], async open(url) { this.opened.push(url); return 'C:/tmp/x/handoff.html'; } };
	install({ runtime: target, userQuestions, browser });
	const fetched = await target.fetch({ url: 'https://example.test/secret' });
	assert.equal(fetched.body.content, REAL_HTML);
	assert.equal(fetched.statusCode, 200);
	assert.equal(target.fetchCalls(), 2, 'the retry happens inside the same fetch call');
	assert.equal(userQuestions.calls.length, 1);
	assert.deepEqual(browser.opened, ['https://example.test/secret']);
	assert.equal(readHandoffMarker(fetched).kind, 'none', 'a clean retry is marked "no handoff", never as a challenge');
});

test('a challenge that persists exhausts the budget and fails with the URL', async () => {
	const target = runtime([result(CHALLENGE_HTML, 403)]);
	install({ runtime: target, userQuestions: askStub('verified') });
	await assert.rejects(
		() => target.fetch({ url: 'https://example.test/secret' }),
		(error) => {
			assert.equal(error.code, 'web_cloudflare_challenge');
			assert.match(error.message, /no handoff retries left/);
			assert.match(error.message, /Just a moment/);
			return true;
		}
	);
	assert.equal(target.fetchCalls(), 2, 'one initial attempt plus exactly one retry');
});

test('a pasted answer short-circuits the network retry', async () => {
	const pasted = '<html><body>Content the user copied</body></html>';
	const target = runtime([result(CHALLENGE_HTML, 403), result(REAL_HTML)]);
	install({ runtime: target, userQuestions: askStub(`paste: ${pasted}`) });
	const fetched = await target.fetch({ url: 'https://example.test/secret' });
	assert.equal(fetched.body.content, pasted);
	assert.equal(fetched.statusCode, 200);
	assert.equal(fetched.truncated, false);
	assert.equal(target.fetchCalls(), 1, 'the network is not asked again');
	const marker = readHandoffMarker(fetched);
	assert.equal(marker.kind, 'pasted');
	assert.match(marker.note, /user/);
	assert.equal(unwrapHandoffResult(fetched), fetched);
});

test('the pasted annotation is non-enumerable so it cannot leak into output', async () => {
	const target = runtime([result(CHALLENGE_HTML, 403)]);
	install({ runtime: target, userQuestions: askStub('paste: <p>x</p>') });
	const fetched = await target.fetch({ url: 'https://example.test/' });
	assert.ok(!Object.keys(fetched).includes(String(HANDOFF_MARKER)));
	assert.deepEqual(Object.keys(fetched).sort(), ['body', 'statusCode', 'truncated', 'url']);
	assert.equal(JSON.stringify(fetched).includes('pasted'), false);
});

test('a refusal fails with the user reason instead of retrying', async () => {
	const target = runtime([result(CHALLENGE_HTML, 403)]);
	install({ runtime: target, userQuestions: askStub('refused: not worth it') });
	await assert.rejects(
		() => target.fetch({ url: 'https://example.test/' }),
		(error) => {
			assert.equal(error.code, 'web_cloudflare_handoff_refused');
			assert.match(error.message, /not worth it/);
			return true;
		}
	);
	assert.equal(target.fetchCalls(), 1);
});

test('an unreachable answerer fails with the URL the user can open', async () => {
	const target = runtime([result(CHALLENGE_HTML, 403)]);
	install({
		runtime: target,
		userQuestions: {
			async ask() {
				throw Object.assign(new Error('no provider'), { code: 'NO_PROVIDER' });
			}
		}
	});
	await assert.rejects(
		() => target.fetch({ url: 'https://example.test/secret' }),
		(error) => {
			assert.equal(error.code, 'web_cloudflare_handoff_unavailable');
			assert.match(error.message, /https:\/\/example\.test\/secret/);
			return true;
		}
	);
});

test('a firewall block never asks the user', async () => {
	const blocked = '<html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked. Error code: 1020</body></html>';
	const target = runtime([result(blocked, 403)]);
	const userQuestions = askStub('verified');
	install({ runtime: target, userQuestions });
	await assert.rejects(
		() => target.fetch({ url: 'https://example.test/' }),
		(error) => {
			assert.equal(error.code, 'web_blocked_by_cloudflare');
			return true;
		}
	);
	assert.equal(userQuestions.calls.length, 0, 'a block is not a human-clearable obstacle');
	assert.equal(target.fetchCalls(), 1);
});

/**
 * The code has to be readable, not merely attached.
 *
 * A thrown tool error reaches the model as the literal text `Error: <message>`
 * (`@deepseek-ai/dsh-tools/lib/index.js:3496`); `code` survives only as a
 * structured field the text never carries. A real headless acceptance run showed
 * the consequence: the agent quoted this message and never saw the plugin's own
 * code. These cases pin the code into the message for every documented failure,
 * so the README's code table describes what the agent can actually read.
 */
test('every coded failure spells its code out in the message text', async () => {
	const cases = [
		{
			label: 'a refused handoff',
			html: CHALLENGE_HTML,
			status: 403,
			answer: 'refused',
			config: { maxAttempts: 1 },
			expected: 'web_cloudflare_handoff_refused'
		},
		{
			label: 'an unreachable answerer',
			html: CHALLENGE_HTML,
			status: 403,
			answer: undefined,
			config: { maxAttempts: 1 },
			expected: 'web_cloudflare_handoff_unavailable'
		},
		{
			label: 'a firewall block',
			html: '<html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked. Error code: 1020</body></html>',
			status: 403,
			answer: 'verified',
			config: { maxAttempts: 1 },
			expected: 'web_blocked_by_cloudflare'
		},
		{
			// The budget is spent before the handoff is ever offered, so the URL has to
			// come from this branch instead of the question card.
			label: 'an exhausted retry budget',
			html: CHALLENGE_HTML,
			status: 403,
			answer: 'verified',
			config: { maxAttempts: 0 },
			expected: 'web_cloudflare_challenge'
		}
	];

	for (const item of cases) {
		const target = runtime([result(item.html, item.status), result(item.html, item.status)]);
		install({
			runtime: target,
			config: item.config,
			userQuestions:
				item.answer === undefined
					? {
							async ask() {
								throw Object.assign(new Error('no provider'), { code: 'NO_PROVIDER' });
							}
						}
					: askStub(item.answer)
		});
		await assert.rejects(
			() => target.fetch({ url: 'https://example.test/guarded' }),
			(error) => {
				assert.equal(error.code, item.expected, item.label);
				assert.ok(
					error.message.includes(item.expected),
					`${item.label}: the message the model reads must name ${item.expected}, got: ${error.message}`
				);
				return true;
			}
		);
	}
});

test('a truncated challenge body is not inspected and not retried', async () => {
	const target = runtime([() => ({ ...result(CHALLENGE_HTML, 403), truncated: true }), result(REAL_HTML)]);
	const userQuestions = askStub('verified');
	const warnings = [];
	install({ runtime: target, userQuestions, onWarn: (m) => warnings.push(m) });
	const fetched = await target.fetch({ url: 'https://example.test/' });
	assert.equal(fetched.truncated, true);
	assert.equal(target.fetchCalls(), 1, 'a truncated body cannot be classified, so it is passed through');
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /truncated/);
});

test('a result with no text body is a coded failure', async () => {
	const target = runtime([() => ({ url: 'https://example.test/', statusCode: 200, body: undefined, truncated: false })]);
	install({ runtime: target, userQuestions: askStub('verified') });
	await assert.rejects(
		() => target.fetch({ url: 'https://example.test/' }),
		(error) => {
			assert.equal(error.code, 'web_invalid_response');
			return true;
		}
	);
});

test('enabled:false restores a plain pass-through', async () => {
	const target = runtime([result(CHALLENGE_HTML, 403)]);
	install({ runtime: target, userQuestions: askStub('verified'), config: { enabled: false } });
	const fetched = await target.fetch({ url: 'https://example.test/' });
	assert.equal(fetched.body.content, CHALLENGE_HTML);
	assert.equal(target.fetchCalls(), 1);
});

test('the disposer restores the original method', async () => {
	// A class instance, so the original lives on the prototype exactly as it does
	// on the real WebRuntime service.
	class FakeRuntime {
		constructor() {
			this.scripted = [result(REAL_HTML)];
			this.index = 0;
		}
		async fetch(request, signal) {
			const entry = this.scripted[this.index] ?? this.scripted[this.scripted.length - 1];
			this.index += 1;
			return typeof entry === 'function' ? entry() : entry;
		}
	}
	const target = new FakeRuntime();
	const original = target.fetch;
	const installResult = install({ runtime: target, userQuestions: askStub('verified') });
	assert.notEqual(target.fetch, original, 'the intercept is an own property shadowing the prototype method');
	installResult.dispose();
	assert.equal(target.fetch, original, 'removing the own property restores the prototype method');
});

test('installing twice does not stack call chains', async () => {
	const target = runtime([result(REAL_HTML)]);
	const first = install({ runtime: target, userQuestions: askStub('verified') });
	const second = install({ runtime: target, userQuestions: askStub('verified') });
	assert.equal(first.installed, true);
	assert.equal(second.installed, false);
	const fetched = await target.fetch({ url: 'https://example.test/' });
	assert.equal(fetched.body.content, REAL_HTML);
	second.dispose();
	assert.notEqual(target.fetch, undefined, 'the no-op disposer must not remove the live install');
	first.dispose();
});

test('a custom minScore is honored end to end', async () => {
	// A title-only shell at HTTP 403 scores 14, so a budget of 0 exhausts at a
	// threshold below that and passes clean at a threshold above it.
	const below = runtime([result(CHALLENGE_HTML, 403)]);
	install({ runtime: below, userQuestions: askStub('verified'), config: { minScore: 14, maxAttempts: 0 } });
	await assert.rejects(() => below.fetch({ url: 'https://example.test/' }), (error) => error.code === 'web_cloudflare_challenge');

	const above = runtime([result(CHALLENGE_HTML, 403)]);
	install({ runtime: above, userQuestions: askStub('verified'), config: { minScore: 15, maxAttempts: 0 } });
	const fetched = await above.fetch({ url: 'https://example.test/' });
	assert.equal(fetched.statusCode, 403, 'a threshold above the score makes the intercept a pass-through');
	assert.equal(above.fetchCalls(), 1);
});

test('a lenient minScore makes a bare title-only shell count as a challenge', async () => {
	const shell = '<html><head><title>Just a moment...</title></head><body></body></html>';
	const target = runtime([result(shell, 403), result(REAL_HTML)]);
	const userQuestions = askStub('verified');
	// The default budget is 1, so the retry reaches the clean second response.
	install({ runtime: target, userQuestions, config: { minScore: 6 } });
	const fetched = await target.fetch({ url: 'https://example.test/' });
	assert.equal(fetched.body.content, REAL_HTML);
	assert.equal(userQuestions.calls.length, 1);
});

test('resolveHandoffConfig fills defaults and normalizes bad input', () => {
	const defaults = resolveHandoffConfig(undefined);
	assert.equal(defaults.enabled, true);
	assert.equal(defaults.minScore, 12);
	assert.equal(defaults.maxAttempts, 1);
	assert.equal(defaults.openBrowser, true);
	assert.equal(defaults.browserHandoff, true);

	const overridden = resolveHandoffConfig({ minScore: 30, maxAttempts: -5, enabled: false, openBrowser: false, browserHandoff: false });
	assert.equal(overridden.minScore, 30);
	assert.equal(overridden.maxAttempts, 0, 'a negative budget is clamped, never unbounded');
	assert.equal(overridden.enabled, false);
	assert.equal(overridden.openBrowser, false);
	assert.equal(overridden.browserHandoff, false);

	const junk = resolveHandoffConfig({ minScore: Number.NaN, maxAttempts: 'many' });
	assert.equal(junk.minScore, 12);
	assert.equal(junk.maxAttempts, 1);
});

test('the intercept reads its config at install time, not at call time', async () => {
	const config = { minScore: 12 };
	const target = runtime([result(CHALLENGE_HTML, 403), result(REAL_HTML)]);
	install({ runtime: target, userQuestions: askStub('verified'), config });
	config.minScore = 999;
	// The challenge is still detected, proving the install captured its config.
	await target.fetch({ url: 'https://example.test/' });
	assert.equal(target.fetchCalls(), 2);
});

test('an ordinary 200 response is never handed off, and its marker is inert', async () => {
	const prose = '<html><body><p>Just a moment... is what the crawler saw. Checking your browser is a whole industry.</p></body></html>';
	const target = runtime([result(prose, 200)]);
	const userQuestions = askStub('verified');
	install({ runtime: target, userQuestions });
	const fetched = await target.fetch({ url: 'https://example.test/blog' });
	assert.equal(readHandoffMarker(fetched).kind, 'none', 'clean results are marked as "no handoff", not as a challenge');
	assert.equal(fetched.body.content, prose, 'the body is untouched');
	assert.equal(userQuestions.calls.length, 0);
	assert.equal(target.fetchCalls(), 1);
	assert.equal(JSON.stringify(fetched).includes('verdict'), false, 'the marker stays out of serialized output');
	assert.equal(detectCfInterstitial({ statusCode: 200, body: { kind: 'html', content: prose } }).kind, 'none');
});

test('the shipped default reports and returns instead of waiting for a person', async () => {
	const target = runtime([result(CHALLENGE_HTML, 403)]);
	const userQuestions = askStub('verified');
	const opened = [];
	// No `mode` override: this pins the default. `web_fetch` declares a 30 s tool
	// budget and the timeout policy replaces whatever the call produced with
	// `tool call timed out after Nms`, so an in-call wait cannot work there.
	installFetchHandoff({
		runtime: target,
		createController: () => new HandoffController({ userQuestions, browser: { open: async () => { opened.push('open'); return '/tmp/x.html'; } } }),
		config: { openBrowser: true }
	});

	await assert.rejects(target.fetch({ url: 'https://example.test/' }), (error) => {
		assert.equal(error.code, 'web_cloudflare_challenge');
		assert.match(error.message, /NOT retrieved/);
		assert.match(error.message, /ask_user_question/, 'the message names the seam that CAN wait');
		assert.match(error.message, /https:\/\/example\.test\//, 'the URL reaches the user even with no question asked');
		assert.doesNotMatch(error.message, /did not answer within/, 'a notify-mode notice is not a timeout');
		return true;
	});
	assert.equal(userQuestions.calls.length, 0, 'the fetch never asks: the 30 s budget cannot hold a human round trip');
	assert.equal(target.fetchCalls(), 1, 'and it never retries inside the call either');
});

test('notify mode still stages a page so the user has a one-click path', async () => {
	const target = runtime([result(CHALLENGE_HTML, 403)]);
	const staged = [];
	installFetchHandoff({
		runtime: target,
		createController: () => new HandoffController({
			userQuestions: askStub('verified'),
			browser: { open: async (url) => { staged.push(url); return '/tmp/handoff.html'; } }
		}),
		config: { openBrowser: true }
	});

	await assert.rejects(target.fetch({ url: 'https://example.test/x' }));
	assert.deepEqual(staged, ['https://example.test/x']);
});

test('openBrowser:false skips staging but still reports', async () => {
	const target = runtime([result(CHALLENGE_HTML, 403)]);
	const staged = [];
	installFetchHandoff({
		runtime: target,
		createController: () => new HandoffController({
			userQuestions: askStub('verified'),
			browser: { open: async (url) => { staged.push(url); return '/tmp/handoff.html'; } }
		}),
		config: { openBrowser: false }
	});

	await assert.rejects(target.fetch({ url: 'https://example.test/x' }), /Cloudflare challenge/);
	assert.deepEqual(staged, [], 'a disabled opener is not called');
});

test('inline mode refuses to wait when the tool budget cannot hold a human', async () => {
	const target = runtime([result(CHALLENGE_HTML, 403)]);
	const userQuestions = askStub('verified');
	installFetchHandoff({
		runtime: target,
		createController: () => new HandoffController({
			userQuestions,
			budget: () => 30000,
			minHumanBudgetMs: 120000
		}),
		config: { mode: 'inline' }
	});

	await assert.rejects(target.fetch({ url: 'https://example.test/' }), (error) => {
		assert.equal(error.code, 'web_cloudflare_challenge');
		assert.match(error.message, /budgeted at 30000ms/);
		assert.match(error.message, /fetchTimeoutMs/, 'the message names the knob that would allow it');
		return true;
	});
	assert.equal(userQuestions.calls.length, 0, 'asking would have been killed by the timeout');
});

test('inline mode waits when the budget leaves room, and an unknown budget is not treated as short', async () => {
	const open = (value) => {
		const target = runtime([result(CHALLENGE_HTML, 403), result('<html><body>ok</body></html>', 200)]);
		const userQuestions = askStub(value);
		installFetchHandoff({
			runtime: target,
			createController: () => new HandoffController({ userQuestions, budget: () => undefined, minHumanBudgetMs: 120000 }),
			config: { mode: 'inline' }
		});
		return { target, userQuestions };
	};

	const roomy = open('verified');
	await roomy.target.fetch({ url: 'https://example.test/' });
	assert.equal(roomy.userQuestions.calls.length, 1, 'an unknown budget must not block the wait');
});
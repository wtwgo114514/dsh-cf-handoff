/**
 * Handoff tests: answer interpretation, question shape, and the ask/wait budget.
 *
 * The controller is the piece that decides what a human's answer MEANS, so the
 * tests here are mostly about not misreading that answer: a refusal must never
 * be mistaken for pasted content, and pasted content must never be discarded.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	HANDOFF_ANSWERS,
	HandoffController,
	buildHandoffQuestions,
	classifyPastedBody,
	isUnansweredChannelError,
	parseAnswer,
	readAnswerValue
} from '../lib/handoff.js';

/** Build an `ask()` stub that records requests and answers with `value`. */
function askStub(value) {
	const calls = [];
	const service = {
		calls,
		async ask(request) {
			calls.push(request);
			if (value instanceof Error) throw value;
			return typeof value === 'function' ? value(request) : value;
		}
	};
	return service;
}

/** Answer shaped the way `UserQuestionsService.ask` documents it. */
function answer(value) {
	return { answers: [{ id: 'cf_handoff', selected: [value] }] };
}

/** A browser handoff stub. */
function browserStub() {
	const opened = [];
	return {
		opened,
		async open(url, reason, signal) {
			opened.push({ url, reason, signal });
			return `C:/tmp/staged/handoff-${opened.length}.html`;
		}
	};
}

test('parseAnswer reads the verified family of answers', () => {
	for (const value of ['verified', 'verified: done', 'Verified', 'done', 'ok', 'cleared', 'retry', 'passed', '好了']) {
		assert.deepEqual(parseAnswer(value), { action: 'verified' }, `failed for ${JSON.stringify(value)}`);
	}
});

test('parseAnswer treats refusals as refusals, including free-text reasons', () => {
	assert.equal(parseAnswer('refused').action, 'refused');
	assert.deepEqual(parseAnswer('skip: not worth it'), { action: 'refused', reason: 'not worth it' });
	assert.equal(parseAnswer('declined').action, 'refused');
	assert.equal(parseAnswer('no thanks').action, 'refused');
	assert.equal(parseAnswer('cancel').action, 'refused');
});

test('an empty answer is a refusal, never silently empty content', () => {
	const parsed = parseAnswer('');
	assert.equal(parsed.action, 'refused');
	assert.equal(parsed.reason, 'empty answer');
});

test('parseAnswer treats anything else as pasted content', () => {
	const body = '<html><body><h1>Real page</h1></body></html>';
	assert.deepEqual(parseAnswer(`paste: ${body}`), { action: 'pasted', content: body });
	assert.deepEqual(parseAnswer(body), { action: 'pasted', content: body });
	assert.deepEqual(parseAnswer('  some plain text  '), { action: 'pasted', content: 'some plain text' });
});

test('refusal wins over a matching substring', () => {
	// "no" must not be read as content just because the text is not HTML, and
	// "done" inside a refusal sentence must not turn it into a retry.
	assert.equal(parseAnswer('stop: the site says done').action, 'refused');
});

test('classifyPastedBody picks the kind the renderer expects', () => {
	assert.equal(classifyPastedBody('<p>hi</p>'), 'html');
	assert.equal(classifyPastedBody('&amp; entity'), 'html');
	assert.equal(classifyPastedBody('just words'), 'text');
	assert.equal(classifyPastedBody(''), 'text');
});

test('readAnswerValue accepts documented and degraded answer shapes', () => {
	assert.equal(readAnswerValue(answer('verified'), 'cf_handoff'), 'verified');
	assert.equal(readAnswerValue({ answers: [{ id: 'cf_handoff', selected: [], custom: 'typed' }] }, 'cf_handoff'), 'typed');
	assert.equal(readAnswerValue({ answers: [{ id: 'cf_handoff', selected: ['yes'] }] }, 'cf_handoff'), 'yes');
	assert.equal(readAnswerValue({ cf_handoff: 'direct' }, 'cf_handoff'), 'direct');
	assert.equal(readAnswerValue({ cf_handoff: { value: 'nested' } }, 'cf_handoff'), 'nested');
	assert.equal(readAnswerValue('bare string', 'cf_handoff'), 'bare string');
	assert.equal(readAnswerValue(null, 'cf_handoff'), '');
	assert.equal(readAnswerValue(undefined, 'cf_handoff'), '');
	assert.equal(readAnswerValue({ answers: [] }, 'cf_handoff'), '');
	assert.equal(readAnswerValue({}, 'cf_handoff'), '');
});

test('an answer with an unexpected id is still that human answer', () => {
	// `ask()` echoes the ids it was sent, so an id mismatch means something in the
	// chain rewrote or dropped the id. Treating that as "no answer" would both lose
	// what the user actually said and misreport it as an unreachable channel —
	// pointing the diagnosis at the transport instead of at the id.
	assert.equal(readAnswerValue({ answers: [{ id: 'other', selected: ['x'] }] }, 'cf_handoff'), 'x');
	assert.equal(readAnswerValue({ answers: [{ id: 'other', selected: [], custom: 'typed' }] }, 'cf_handoff'), 'typed');
	// A matching id still wins over an unmatched one, whatever the order.
	assert.equal(
		readAnswerValue({ answers: [{ id: 'other', selected: ['first'] }, { id: 'cf_handoff', selected: ['second'] }] }, 'cf_handoff'),
		'second'
	);
	// An entry carrying no usable value at all contributes nothing.
	assert.equal(readAnswerValue({ answers: [{ id: 'other', selected: [] }] }, 'cf_handoff'), '');
});

test('buildHandoffQuestions carries the target URL and the reason', () => {
	const questions = buildHandoffQuestions({
		url: 'https://example.test/secret',
		verdict: { summary: 'Cloudflare challenge ("Just a moment..."): HTTP 403, score 22 [x]' }
	});
	assert.equal(questions.length, 1);
	const [question] = questions;
	assert.equal(question.id, 'cf_handoff');
	assert.equal(question.header, 'Cloudflare handoff');
	// The URL goes in `detail`, not `question`: detail is the field the Web GUI
	// renders as markdown outside the option labels, so a link there is clickable.
	assert.match(question.detail, /\[Open https:\/\/example\.test\/secret\]\(https:\/\/example\.test\/secret\)/);
	assert.doesNotMatch(question.question, /https:\/\//);
	assert.match(question.detail, /Cloudflare challenge/);
	assert.equal(question.options.length, 2);
	// `AskUserQuestionOption` is `{ label, description? }` — there is no `value`,
	// and the answer comes back as the selected label, so the labels must stay
	// parseable by `parseAnswer`.
	for (const option of question.options) {
		assert.equal(typeof option.label, 'string');
		assert.equal(option.value, undefined);
	}
	assert.equal(parseAnswer(question.options[1].label).action, 'refused');
	assert.equal(parseAnswer(question.options[0].label).action, 'verified');
});

test('buildHandoffQuestions switches to the retry wording on a second pass', () => {
	const first = buildHandoffQuestions({ url: 'https://x.test/', verdict: {} })[0];
	const second = buildHandoffQuestions({ url: 'https://x.test/', verdict: {}, reused: true })[0];
	assert.notEqual(first.question, second.question);
	assert.match(second.question, /Still blocked/);
});

test('a verified answer opens the browser once and asks exactly once', async () => {
	const userQuestions = askStub(answer('verified'));
	const browser = browserStub();
	const controller = new HandoffController({ userQuestions, browser });
	const outcome = await controller.request({ url: 'https://example.test/', verdict: { summary: 's' } });
	assert.equal(outcome.action, 'verified');
	assert.equal(outcome.attempts, 1);
	assert.equal(browser.opened.length, 1);
	assert.equal(browser.opened[0].url, 'https://example.test/');
	assert.equal(userQuestions.calls.length, 1);
	assert.equal(userQuestions.calls[0].questions[0].id, 'cf_handoff');
	assert.ok(!controller.canRetry, 'the default budget is one attempt');
});

test('a pasted answer becomes a synthesized body', async () => {
	const controller = new HandoffController({ userQuestions: askStub(answer('<html><body>Real</body></html>')) });
	const outcome = await controller.request({ url: 'https://example.test/', verdict: {}, openBrowser: false });
	assert.equal(outcome.action, 'pasted');
	assert.equal(outcome.body.kind, 'html');
	assert.equal(outcome.body.content, '<html><body>Real</body></html>');
});

test('a paste-shaped answer with no content is unavailable, not empty content', async () => {
	const controller = new HandoffController({ userQuestions: askStub(answer('paste')) });
	const outcome = await controller.request({ url: 'https://example.test/', verdict: {}, openBrowser: false });
	assert.equal(outcome.action, 'unavailable');
	assert.match(outcome.reason, /no content/);
});

test('a refused answer reports the user reason', async () => {
	const controller = new HandoffController({ userQuestions: askStub(answer('refused: do not bother')) });
	const outcome = await controller.request({ url: 'https://example.test/', verdict: {}, openBrowser: false });
	assert.equal(outcome.action, 'refused');
	assert.equal(outcome.reason, 'do not bother');
});

test('an empty answer from the channel is unavailable, not a refusal masquerading as content', async () => {
	const controller = new HandoffController({ userQuestions: askStub({ answers: [] }) });
	const outcome = await controller.request({ url: 'https://example.test/', verdict: {}, openBrowser: false });
	assert.equal(outcome.action, 'unavailable');
	assert.match(outcome.reason, /empty answer/);
});

test('a failing browser opener does not lose the handoff', async () => {
	const userQuestions = askStub(answer('verified'));
	const warnings = [];
	const browser = {
		async open() {
			throw new Error('no default browser');
		}
	};
	const controller = new HandoffController({ userQuestions, browser, onWarn: (m) => warnings.push(m) });
	const outcome = await controller.request({ url: 'https://example.test/', verdict: {} });
	assert.equal(outcome.action, 'verified');
	assert.equal(outcome.openError, 'no default browser');
	assert.equal(warnings.length, 1);
	assert.equal(userQuestions.calls.length, 1, 'the question still has to be asked');
});

test('an aborted browser opener propagates instead of degrading', async () => {
	const controller = new HandoffController({
		userQuestions: askStub(answer('verified')),
		browser: {
			async open() {
				throw Object.assign(new Error('aborted'), { name: 'AbortError' });
			}
		}
	});
	const signal = { aborted: true };
	await assert.rejects(() => controller.request({ url: 'https://example.test/', verdict: {}, signal }), /aborted/);
});

test('the retry budget is enforced per controller', async () => {
	const controller = new HandoffController({ userQuestions: askStub(answer('verified')), maxAttempts: 2 });
	assert.equal(controller.canRetry, true);
	assert.equal((await controller.request({ url: 'https://x.test/', verdict: {}, openBrowser: false })).action, 'verified');
	assert.equal(controller.canRetry, true);
	assert.equal((await controller.request({ url: 'https://x.test/', verdict: {}, openBrowser: false })).action, 'verified');
	assert.equal(controller.canRetry, false);
	await assert.rejects(() => controller.request({ url: 'https://x.test/', verdict: {}, openBrowser: false }), /budget exhausted/);
});

test('the question is asked with the calling agent when one can be recovered', async () => {
	const agent = { id: 'agent-1', ctx: {} };
	const userQuestions = askStub(answer('verified'));
	const controller = new HandoffController({ userQuestions, resolveAgent: async () => agent });
	await controller.request({ url: 'https://x.test/', verdict: {}, openBrowser: false });
	assert.equal(userQuestions.calls[0].agent, agent);
});

test('a scoped ask that cannot reach a live caller falls back to an unscoped ask', async () => {
	const userQuestions = {
		requests: [],
		async ask(request) {
			this.requests.push(request);
			if (request.agent !== undefined) throw Object.assign(new Error('not live'), { code: 'CALLER_NOT_LIVE' });
			return answer('verified');
		}
	};
	const warnings = [];
	const controller = new HandoffController({
		userQuestions,
		resolveAgent: async () => ({ id: 'agent-1', ctx: {} }),
		onWarn: (m) => warnings.push(m)
	});
	const outcome = await controller.request({ url: 'https://x.test/', verdict: {}, openBrowser: false });
	assert.equal(outcome.action, 'verified');
	assert.equal(userQuestions.requests.length, 2);
	assert.equal(userQuestions.requests[0].agent.id, 'agent-1');
	assert.equal(userQuestions.requests[1].agent, undefined);
	assert.equal(warnings.length, 1);
});

test('no reachable answerer becomes unavailable rather than hanging', async () => {
	const controller = new HandoffController({
		userQuestions: askStub(Object.assign(new Error('no provider'), { code: 'NO_PROVIDER' }))
	});
	const outcome = await controller.request({ url: 'https://x.test/', verdict: {}, openBrowser: false });
	assert.equal(outcome.action, 'unavailable');
	assert.match(outcome.reason, /NO_PROVIDER/);
});

test('a real cancellation is never converted into unavailable', async () => {
	const controller = new HandoffController({
		userQuestions: askStub(Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' }))
	});
	await assert.rejects(() => controller.request({ url: 'https://x.test/', verdict: {}, openBrowser: false }), /aborted/);
});

test('isUnansweredChannelError distinguishes an unreachable caller from a real failure', () => {
	assert.equal(isUnansweredChannelError({ code: 'NO_PROVIDER' }), true);
	assert.equal(isUnansweredChannelError({ code: 'CALLER_NOT_LIVE' }), true);
	assert.equal(isUnansweredChannelError({ code: 'DELEGATED_CALLER' }), true);
	assert.equal(isUnansweredChannelError({ code: 'ASK_ABORTED' }), false);
	assert.equal(isUnansweredChannelError(new Error('boom')), false);
	assert.equal(isUnansweredChannelError(undefined), false);
});

test('the constructor rejects a missing or malformed question service', () => {
	assert.throws(() => new HandoffController({}), /requires a userQuestions service/);
	assert.throws(() => new HandoffController({ userQuestions: {} }), /does not expose ask/);
});

test('inlineViability refuses a wait the tool budget would kill', () => {
	const controller = new HandoffController({
		userQuestions: askStub(answer('verified')),
		budget: () => 30000,
		minHumanBudgetMs: 120000
	});
	const verdict = controller.inlineViability();
	assert.equal(verdict.viable, false);
	assert.match(verdict.reason, /budgeted at 30000ms/);
	assert.match(verdict.reason, /fetchTimeoutMs/);
});

test('inlineViability allows the wait when the budget is big enough or unknown', () => {
	const roomy = new HandoffController({ userQuestions: askStub(answer('verified')), budget: () => 300000, minHumanBudgetMs: 120000 });
	assert.equal(roomy.inlineViability().viable, true);

	const unknown = new HandoffController({ userQuestions: askStub(answer('verified')), budget: () => undefined, minHumanBudgetMs: 120000 });
	assert.equal(unknown.inlineViability().viable, true, 'an unreadable budget is not evidence of a short one');
});

test('openPage stages the page and records the path for disposal', async () => {
	const browser = browserStub();
	const controller = new HandoffController({ userQuestions: askStub(answer('verified')), browser });
	const opened = await controller.openPage({ url: 'https://example.test/', verdict: { summary: 'challenge (score 12)' } });
	assert.equal(opened.browserPath, 'C:/tmp/staged/handoff-1.html');
	assert.equal(browser.opened[0].url, 'https://example.test/');
	assert.equal(browser.opened[0].reason, 'challenge (score 12)');
	assert.deepEqual(controller.stagedPaths, ['C:/tmp/staged/handoff-1.html']);
});

test('openPage is skipped when the opener is disabled', async () => {
	const browser = browserStub();
	const controller = new HandoffController({ userQuestions: askStub(answer('verified')), browser });
	assert.deepEqual(await controller.openPage({ url: 'https://example.test/', openBrowser: false }), {});
	assert.equal(browser.opened.length, 0);
});

test('a failed browser launch degrades to a warning, never to a lost handoff', async () => {
	const warnings = [];
	const controller = new HandoffController({
		userQuestions: askStub(answer('verified')),
		browser: { async open() { throw new Error('no default application'); } },
		onWarn: (message) => warnings.push(message)
	});
	const opened = await controller.openPage({ url: 'https://example.test/' });
	assert.equal(opened.browserPath, undefined);
	assert.match(opened.openError, /no default application/);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /system browser/);
});
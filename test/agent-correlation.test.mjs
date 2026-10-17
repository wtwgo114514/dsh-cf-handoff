/**
 * Agent-correlation tests.
 *
 * These cover the one runtime fact the whole handoff depends on: that the agent
 * causing a `web.fetch` can be recovered, because `userQuestions.ask` only
 * reaches the browser when it is given an agent.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CORRELATED_TOOLS, createAgentCorrelation, isCorrelatedTool } from '../lib/agent-correlation.js';
import { createAgentResolver, looksLikeAgent } from '../lib/agent-scope.js';

/** A minimal agent-shaped object. */
function fakeAgent(id) {
	return { id, ctx: {} };
}

/** A minimal Cordis-like context capturing listeners. */
function fakeContext() {
	const listeners = new Map();
	return {
		listeners,
		on(event, handler) {
			listeners.set(event, handler);
			return () => listeners.delete(event);
		}
	};
}

/** Drive a captured `tools/pre-execute` listener as the registry would. */
async function firePreExecute(ctx, exec) {
	const handler = ctx.listeners.get('tools/pre-execute');
	assert.equal(typeof handler, 'function', 'the observer must register on tools/pre-execute');
	let proceeded = false;
	const decision = await handler(exec, () => {
		proceeded = true;
		return Promise.resolve({ kind: 'allow' });
	});
	return { decision, proceeded };
}

test('the correlated tool list names the shipped fetch tool', () => {
	assert.ok(CORRELATED_TOOLS.includes('web_fetch'));
	assert.equal(isCorrelatedTool('web_fetch'), true);
	assert.equal(isCorrelatedTool('web_search'), false);
	assert.equal(isCorrelatedTool(undefined), false);
	assert.equal(isCorrelatedTool(42), false);
});

test('the observer always proceeds — it is not a gate', async () => {
	const correlation = createAgentCorrelation();
	const ctx = fakeContext();
	correlation.observe(ctx);
	const { decision, proceeded } = await firePreExecute(ctx, {
		name: 'web_fetch',
		signal: new AbortController().signal,
		agent: fakeAgent('a1')
	});
	assert.equal(proceeded, true);
	assert.deepEqual(decision, { kind: 'allow' });
});

test('a web_fetch signal resolves to the agent that owns it', async () => {
	const correlation = createAgentCorrelation();
	const ctx = fakeContext();
	correlation.observe(ctx);
	const signal = new AbortController().signal;
	const agent = fakeAgent('a1');
	await firePreExecute(ctx, { name: 'web_fetch', signal, agent });
	assert.equal(correlation.agentFor(signal), agent);
});

test('an unrelated tool call records nothing', async () => {
	const correlation = createAgentCorrelation();
	const ctx = fakeContext();
	correlation.observe(ctx);
	const signal = new AbortController().signal;
	await firePreExecute(ctx, { name: 'bash', signal, agent: fakeAgent('a1') });
	assert.equal(correlation.agentFor(signal), undefined);
});

test('a different signal never resolves to another call\u2019s agent', async () => {
	const correlation = createAgentCorrelation();
	const ctx = fakeContext();
	correlation.observe(ctx);
	const first = new AbortController().signal;
	const second = new AbortController().signal;
	await firePreExecute(ctx, { name: 'web_fetch', signal: first, agent: fakeAgent('a1') });
	assert.equal(correlation.agentFor(second), undefined, 'correlation is per invocation, not per plugin');
});

test('an exec without an agent records nothing', async () => {
	const correlation = createAgentCorrelation();
	const ctx = fakeContext();
	correlation.observe(ctx);
	const signal = new AbortController().signal;
	// A subagent-less or unscoped dispatch: the field is optional by contract.
	await firePreExecute(ctx, { name: 'web_fetch', signal });
	assert.equal(correlation.agentFor(signal), undefined);
});

test('a missing or non-object signal is tolerated', async () => {
	const correlation = createAgentCorrelation();
	const ctx = fakeContext();
	correlation.observe(ctx);
	await firePreExecute(ctx, { name: 'web_fetch', agent: fakeAgent('a1') });
	assert.equal(correlation.agentFor(undefined), undefined);
	assert.equal(correlation.agentFor('not a signal'), undefined);
	assert.equal(correlation.agentFor(null), undefined);
});

test('the observer is removable', async () => {
	const correlation = createAgentCorrelation();
	const ctx = fakeContext();
	const dispose = correlation.observe(ctx);
	assert.equal(ctx.listeners.size, 1);
	dispose();
	assert.equal(ctx.listeners.size, 0);
});

test('two agents fetching in parallel stay separate', async () => {
	const correlation = createAgentCorrelation();
	const ctx = fakeContext();
	correlation.observe(ctx);
	const signalA = new AbortController().signal;
	const signalB = new AbortController().signal;
	const agentA = fakeAgent('a1');
	const agentB = fakeAgent('a2');
	await Promise.all([
		firePreExecute(ctx, { name: 'web_fetch', signal: signalA, agent: agentA }),
		firePreExecute(ctx, { name: 'web_fetch', signal: signalB, agent: agentB })
	]);
	assert.equal(correlation.agentFor(signalA), agentA);
	assert.equal(correlation.agentFor(signalB), agentB);
});

test('looksLikeAgent accepts an agent shape and rejects near misses', () => {
	assert.equal(looksLikeAgent(fakeAgent('a1')), true);
	assert.equal(looksLikeAgent({ id: 'a1' }), false, 'an agent always carries its own ctx');
	assert.equal(looksLikeAgent({ id: '', ctx: {} }), false);
	assert.equal(looksLikeAgent({ ctx: {} }), false);
	assert.equal(looksLikeAgent(null), false);
	assert.equal(looksLikeAgent('agent'), false);
});

test('createAgentResolver reads ctx.agent directly when present', async () => {
	const agent = fakeAgent('a1');
	const resolve = createAgentResolver({ agent });
	assert.equal(await resolve(), agent);
});

test('createAgentResolver degrades to undefined when nothing is recoverable', async () => {
	const resolve = createAgentResolver({}, async () => {
		throw new Error('not installed');
	});
	assert.equal(await resolve(), undefined);
});

/*
 * The URL fallback tier.
 *
 * Signal identity is the correct key, but a layer that derives a new signal
 * (`AbortSignal.any([signal, timeout])`) silently breaks it, and the failure is
 * indistinguishable from "nobody is listening". These tests pin the degradation:
 * recover the agent when exactly one record names the URL, and refuse to guess
 * when the URL is ambiguous.
 */

/** Record one call whose arguments carry a URL. */
function recordCall(correlation, ctx, url, agent, signal = new AbortController().signal) {
	return firePreExecute(ctx, { name: 'web_fetch', arguments: { url }, signal, agent });
}

test('a derived signal still resolves the agent by URL', async () => {
	const correlation = createAgentCorrelation();
	const ctx = fakeContext();
	correlation.observe(ctx);
	const agent = fakeAgent('a1');
	await recordCall(correlation, ctx, 'https://example.com/x', agent);

	// The same URL, a signal the observer never saw: the identity tier misses.
	const derived = new AbortController().signal;
	assert.equal(correlation.agentFor(derived, 'https://example.com/x'), agent);
});

test('the URL tier does not fire when the signal tier already matched', async () => {
	const correlation = createAgentCorrelation();
	const ctx = fakeContext();
	correlation.observe(ctx);
	const signal = new AbortController().signal;
	const agent = fakeAgent('a1');
	await recordCall(correlation, ctx, 'https://example.com/x', agent, signal);

	const found = correlation.lookup(signal, 'https://example.com/x');
	assert.equal(found.agent, agent);
	assert.match(found.detail, /signal identity/);
});

test('an ambiguous URL resolves to nothing rather than the wrong agent', async () => {
	const correlation = createAgentCorrelation();
	const ctx = fakeContext();
	correlation.observe(ctx);
	await recordCall(correlation, ctx, 'https://example.com/x', fakeAgent('a1'));
	await recordCall(correlation, ctx, 'https://example.com/x', fakeAgent('a2'));

	const found = correlation.lookup(new AbortController().signal, 'https://example.com/x');
	assert.equal(found.agent, undefined, 'two agents fetching one URL is not a correlation');
	assert.match(found.detail, /different agents/);
});

test('two records of the same URL by one agent still resolve', async () => {
	const correlation = createAgentCorrelation();
	const ctx = fakeContext();
	correlation.observe(ctx);
	const agent = fakeAgent('a1');
	await recordCall(correlation, ctx, 'https://example.com/x', agent);
	await recordCall(correlation, ctx, 'https://example.com/x', agent);

	assert.equal(correlation.agentFor(new AbortController().signal, 'https://example.com/x'), agent);
});

test('the URL tier will not cross URLs', async () => {
	const correlation = createAgentCorrelation();
	const ctx = fakeContext();
	correlation.observe(ctx);
	await recordCall(correlation, ctx, 'https://example.com/a', fakeAgent('a1'));

	assert.equal(correlation.agentFor(new AbortController().signal, 'https://example.com/b'), undefined);
});

test('an aborted call stops participating in the URL tier', async () => {
	const correlation = createAgentCorrelation();
	const ctx = fakeContext();
	correlation.observe(ctx);
	const controller = new AbortController();
	await recordCall(correlation, ctx, 'https://example.com/x', fakeAgent('a1'), controller.signal);

	controller.abort();
	assert.equal(
		correlation.agentFor(new AbortController().signal, 'https://example.com/x'),
		undefined,
		'a finished call must not answer for a live one'
	);
});

test('a call with no URL argument is still matched by signal', async () => {
	const correlation = createAgentCorrelation();
	const ctx = fakeContext();
	correlation.observe(ctx);
	const signal = new AbortController().signal;
	const agent = fakeAgent('a1');
	await firePreExecute(ctx, { name: 'web_fetch', arguments: {}, signal, agent });

	assert.equal(correlation.agentFor(signal), agent, 'the identity tier needs no URL');
	assert.equal(correlation.agentFor(new AbortController().signal), undefined);
});

test('the diagnostic distinguishes a miss from a never-recorded call', async () => {
	const correlation = createAgentCorrelation();
	const ctx = fakeContext();
	correlation.observe(ctx);

	const cold = correlation.lookup(new AbortController().signal, 'https://example.com/x');
	assert.match(cold.detail, /0 recorded/);

	await recordCall(correlation, ctx, 'https://example.com/x', fakeAgent('a1'));
	const warm = correlation.lookup(new AbortController().signal, 'https://example.com/y');
	assert.match(warm.detail, /1 recorded/);
	assert.match(warm.detail, /no record for this URL/);
});

test('the observer counts every correlated call, not every recorded one', async () => {
	const correlation = createAgentCorrelation();
	const ctx = fakeContext();
	correlation.observe(ctx);
	await recordCall(correlation, ctx, 'https://example.com/x', fakeAgent('a1'));
	await firePreExecute(ctx, { name: 'web_search', arguments: {}, signal: new AbortController().signal, agent: fakeAgent('a2') });

	assert.equal(correlation.size(), 1, 'an uncorrelated tool does not inflate the count');
});

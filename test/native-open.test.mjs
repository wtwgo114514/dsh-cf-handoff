/**
 * Native opener tests.
 *
 * The opener is the one piece that touches the host, and the shipped version had
 * to stop importing the harness package (it is unreachable from a `link:` install).
 * These tests pin the replacement to the exact commands the harness itself used,
 * so the measured behaviour in README §3.1 keeps applying.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canOpenNatively, openPathNatively, powershellLiteral, runCommand } from '../lib/native-open.js';

test('powershellLiteral doubles single quotes and keeps the rest literal', () => {
	assert.equal(powershellLiteral('C:\\tmp\\a.html'), "'C:\\tmp\\a.html'");
	assert.equal(powershellLiteral("C:\\it's here\\a.html"), "'C:\\it''s here\\a.html'");
	// PowerShell expands `$` and backtick inside double quotes; single quotes do not.
	assert.equal(powershellLiteral('C:\\$env:TEMP\\a.html'), "'C:\\$env:TEMP\\a.html'");
});

test('windows uses the same Invoke-Item invocation the harness measured', async () => {
	const calls = [];
	const run = async (command, args) => {
		calls.push({ command, args });
	};
	await openPathNatively('C:\\tmp\\page.html', undefined, { platform: 'win32', run });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].command, 'powershell.exe');
	assert.deepEqual(calls[0].args, ['-NoProfile', '-Command', "Invoke-Item -LiteralPath 'C:\\tmp\\page.html'"]);
});

test('macOS and linux use their own open verbs', async () => {
	const darwin = [];
	await openPathNatively('/tmp/page.html', undefined, { platform: 'darwin', run: async (c, a) => darwin.push([c, a]) });
	assert.deepEqual(darwin, [['open', ['/tmp/page.html']]]);

	const linux = [];
	await openPathNatively('/tmp/page.html', undefined, { platform: 'linux', run: async (c, a) => linux.push([c, a]) });
	assert.deepEqual(linux, [['xdg-open', ['/tmp/page.html']]]);
});

test('an unknown platform refuses instead of guessing a command', async () => {
	await assert.rejects(openPathNatively('/tmp/x.html', undefined, { platform: 'aix', run: async () => {} }), /default application/);
	assert.equal(canOpenNatively('aix'), false);
	assert.equal(canOpenNatively('win32'), true);
});

test('runCommand resolves on exit 0 and rejects on a non-zero exit', async () => {
	const fakeSpawn = (code) => (command, args, options) => {
		assert.equal(options.stdio, 'ignore', 'a GUI child must not inherit the harness pipes');
		// `detached: true` silently turns a PowerShell failure into exit 0, which
		// would make the URL control in test/acceptance-browser.mjs pass when it
		// must fail. It must stay off.
		assert.equal(options.detached, undefined, 'detached would hide launch failures');
		const handlers = {};
		const child = {
			once(event, handler) {
				handlers[event] = handler;
				return child;
			},
			kill() {},
			unref() {}
		};
		setImmediate(() => handlers.exit?.(code));
		return child;
	};

	await runCommand('open', ['x'], undefined, fakeSpawn(0));
	await assert.rejects(runCommand('open', ['x'], undefined, fakeSpawn(3)), /exited with code 3/);
});

test('runCommand rejects an already-aborted signal without spawning', async () => {
	const controller = new AbortController();
	controller.abort(new Error('cancelled by caller'));
	let spawned = false;
	const spawn = () => {
		spawned = true;
		return { once() {}, kill() {}, unref() {} };
	};
	await assert.rejects(runCommand('open', ['x'], controller.signal, spawn), /cancelled by caller/);
	assert.equal(spawned, false, 'an aborted handoff must not open a window');
});

test('runCommand does not unref the launcher before it exits', async () => {
	// Un-ref'ing while awaiting makes the promise unsettleable: nothing else keeps
	// the loop alive, so Node drains it and the `exit` event never arrives. The
	// first run of test/acceptance-browser.mjs hung on exactly that.
	const order = [];
	const handlers = {};
	const spawn = () => {
		const child = {
			once(event, handler) {
				handlers[event] = handler;
				return child;
			},
			kill() {},
			unref() {
				order.push('unref');
			}
		};
		return child;
	};
	const pending = runCommand('open', ['x'], undefined, spawn);
	assert.deepEqual(order, [], 'the child must still be referenced while awaited');
	setImmediate(() => handlers.exit?.(0));
	await pending;
	order.push('settled');
	assert.deepEqual(order, ['unref', 'settled'], 'unref happens on the way out, not on the way in');
});

test('runCommand kills the launcher when the caller aborts mid-flight', async () => {
	const controller = new AbortController();
	let killed = false;
	const handlers = {};
	const spawn = () => {
		const child = {
			once(event, handler) {
				handlers[event] = handler;
				return child;
			},
			kill() {
				killed = true;
			},
			unref() {}
		};
		return child;
	};
	const pending = runCommand('open', ['x'], controller.signal, spawn);
	controller.abort(new Error('turn cancelled'));
	await assert.rejects(pending, /turn cancelled/);
	assert.equal(killed, true);
	assert.ok(handlers.exit, 'the exit handler is still subscribed so the child cannot leak');
});

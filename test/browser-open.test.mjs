/**
 * Bootstrap page tests.
 *
 * `lib/browser-open.js` had no unit tests until now: the only thing exercising it
 * was the opt-in browser acceptance, which opens a real window. Everything here
 * runs with an injected opener, a fake staging root and a fake clock, so the
 * behaviour (including the "do not open a second tab for the same page" rule)
 * is pinned without touching a desktop.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import {
	createBrowserHandoff,
	escapeHtml,
	jsStringLiteral,
	renderBootstrapHtml,
	STAGING_PREFIX
} from '../lib/browser-open.js';

// The library resolves the staging root, so a fake relative one such as
// `C:/fake-tmp` becomes `<cwd>/C:/fake-tmp` on POSIX and the prefix assertion
// below fails there — CI caught exactly that on all three Node versions. Pinning
// the fake root under the real temp directory keeps this file platform-neutral.
const TMP_ROOT = join(tmpdir(), 'dsh-cf-handoff-test-root');

/**
 * Build a handoff over in-memory fakes.
 *
 * @param {object} [overrides] - seam overrides
 * @returns {{ handoff: any, opened: string[], written: Map<string, string>, removed: string[], stagedDirs: string[] }}
 */
function makeHandoff(overrides = {}) {
	const opened = [];
	const written = new Map();
	const removed = [];
	const stagedDirs = [];
	let counter = 0;
	let clock = 1000;
	const handoff = createBrowserHandoff({
		openPath: async (path) => {
			opened.push(path);
		},
		tmpRoot: TMP_ROOT,
		mkdtempImpl: async (prefix) => {
			assert.ok(prefix.startsWith(join(TMP_ROOT, STAGING_PREFIX)), `mkdtemp prefix was ${prefix}`);
			counter += 1;
			const dir = `${prefix}${counter}`;
			stagedDirs.push(dir);
			return dir;
		},
		writeFileImpl: async (path, content) => {
			written.set(path, String(content));
		},
		rmImpl: async (path) => {
			removed.push(path);
		},
		now: () => clock,
		...overrides
	});
	return {
		handoff,
		opened,
		written,
		removed,
		stagedDirs,
		advance(ms) {
			clock += ms;
		}
	};
}

test('escapeHtml covers every character that could break out of markup', () => {
	assert.equal(escapeHtml(`<script>&"'`), '&lt;script&gt;&amp;&quot;&#39;');
});

test('jsStringLiteral cannot terminate the script element', () => {
	const literal = jsStringLiteral('</script><img src=x>');
	assert.ok(!literal.includes('</script>'), literal);
	assert.ok(literal.includes('\\u003c'), literal);
	assert.equal(jsStringLiteral('a\u2028b'), '"a\\u2028b"');
	assert.equal(jsStringLiteral('back\\slash'), '"back\\\\slash"');
});

test('the bootstrap page links the target and navigates itself by default', () => {
	const html = renderBootstrapHtml({ url: 'https://example.com/a?b=1&c=2', reason: 'HTTP 403 challenge' });
	assert.ok(html.includes('href="https://example.com/a?b=1&amp;c=2"'), 'the link must be attribute-escaped');
	assert.ok(html.includes('window.location.replace("https://example.com/a?b=1&c=2")'));
	assert.ok(html.includes('HTTP 403 challenge'));
	assert.ok(html.includes('example.com'));
});

test('autoNavigate:false renders the linked page without navigating', () => {
	const html = renderBootstrapHtml({ url: 'https://example.com/', reason: 'r', autoNavigate: false });
	assert.ok(!html.includes('window.location.replace'), 'no self-navigation was requested');
	assert.ok(html.includes('href="https://example.com/"'), 'the manual link must still be there');
});

test('a hostile reason cannot inject markup into the page', () => {
	const html = renderBootstrapHtml({ url: 'https://example.com/', reason: '<img src=x onerror=alert(1)>' });
	assert.ok(!html.includes('<img src=x'), 'the reason must be escaped');
	assert.ok(html.includes('&lt;img src=x'));
});

test('open stages a page and hands that exact file to the opener', async () => {
	const { handoff, opened, written } = makeHandoff();
	const path = await handoff.open('https://example.com/', 'reason');

	assert.equal(opened.length, 1);
	assert.equal(opened[0], path);
	assert.equal(written.size, 1);
	assert.ok(path.startsWith(join(TMP_ROOT, STAGING_PREFIX)), path);
	assert.ok(path.endsWith('handoff.html'));
	assert.equal(handoff.stagedPaths.length, 1);
});

test('the same URL re-opened inside the window reuses the tab already on screen', async () => {
	const { handoff, opened, advance } = makeHandoff();
	const first = await handoff.open('https://example.com/', 'reason');
	advance(1000);
	const second = await handoff.open('https://example.com/', 'other reason');

	assert.equal(second, first, 'the second call must return the staged page already open');
	assert.equal(opened.length, 1, 'no second browser tab');
});

test('a different URL still gets its own page', async () => {
	const { handoff, opened } = makeHandoff();
	await handoff.open('https://example.com/', 'reason');
	await handoff.open('https://other.example/', 'reason');

	assert.equal(opened.length, 2);
});

test('the same URL is staged again once the reuse window has passed', async () => {
	const { handoff, opened, advance } = makeHandoff({ reopenAfterMs: 60000 });
	await handoff.open('https://example.com/', 'reason');
	advance(60001);
	await handoff.open('https://example.com/', 'reason');

	assert.equal(opened.length, 2, 'a stale tab is not reused forever');
});

test('reopenAfterMs:0 disables the reuse entirely', async () => {
	const { handoff, opened } = makeHandoff({ reopenAfterMs: 0 });
	await handoff.open('https://example.com/', 'reason');
	await handoff.open('https://example.com/', 'reason');

	assert.equal(opened.length, 2);
});

test('a reused page is not re-staged after the disposer removed it', async () => {
	const { handoff, opened, removed } = makeHandoff();
	await handoff.open('https://example.com/', 'reason');
	const count = await handoff.dispose();
	assert.equal(count, 1);
	assert.equal(removed.length, 1);

	// The staged file is gone, so returning its path would point at nothing.
	await handoff.open('https://example.com/', 'reason');
	assert.equal(opened.length, 2);
});

test('an opener failure propagates so the caller can report it', async () => {
	const handoff = createBrowserHandoff({
		openPath: async () => {
			throw new Error('no default browser');
		},
		tmpRoot: TMP_ROOT,
		mkdtempImpl: async (prefix) => `${prefix}1`,
		writeFileImpl: async () => {},
		rmImpl: async () => {}
	});
	await assert.rejects(handoff.open('https://example.com/', 'reason'), /no default browser/);
});

test('the disposer only removes directories it created under its own root', async () => {
	const { handoff, removed, stagedDirs } = makeHandoff();
	await handoff.open('https://example.com/', 'reason');
	await handoff.open('https://other.example/', 'reason');
	const count = await handoff.dispose();

	assert.equal(count, 2);
	assert.equal(removed.length, 2);
	for (const dir of removed) {
		assert.ok(dir.startsWith(TMP_ROOT + sep), `refusing anything outside the root: ${dir}`);
		assert.ok(dir.slice(TMP_ROOT.length + 1).startsWith(STAGING_PREFIX), dir);
	}
	assert.deepEqual(stagedDirs.length, 2);
	assert.equal(handoff.stagedPaths.length, 0, 'dispose clears the bookkeeping');
});

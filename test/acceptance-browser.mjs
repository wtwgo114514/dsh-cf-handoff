/**
 * Acceptance test for the browser half: the real opener, on this machine.
 *
 * WHAT THIS PROVES THAT NOTHING ELSE DOES
 *
 * Every other test injects a fake opener, so none of them show that the claim
 * "the user's default browser opens the blocked URL" is true of the *shipped*
 * opener. This file calls the plugin's own `openPathNatively` with a real staged
 * file, exactly as `lib/index.js` wires it.
 *
 * IT OPENS A BROWSER WINDOW. That is the point, and it is why this is a separate
 * opt-in script rather than part of `npm test`. The window is left alone; close
 * it whenever. Only one window is opened, and the URL it navigates to is a
 * harmless public page.
 *
 * WHY A STAGED FILE IS THE ONLY WAY
 *
 * The opener is a *path* opener. On Windows it runs
 * `powershell.exe -NoProfile -Command "Invoke-Item -LiteralPath <arg>"`, and
 * `Invoke-Item` resolves its argument as a provider path. Handed a URL it fails
 * with "Cannot find drive. A drive with the name 'https' does not exist."
 * (exit 1). This script asserts the staged-file route works and, as a control,
 * that the URL route really does fail — so the design reason is pinned down by
 * execution and not just by reading.
 *
 * WHY IT NO LONGER IMPORTS `@deepseek-ai/dsh-native-command`
 *
 * It used to. In a `link:` install that import throws `Cannot find package
 * '@deepseek-ai/dsh-native-command'`, because a linked plugin resolves bare
 * specifiers from its own directory, outside the profile's `node_modules`. The
 * plugin now ships `lib/native-open.js`, which issues the same platform commands;
 * this script is what checks that the replacement behaves identically.
 *
 * @module dsh-cf-handoff/test/acceptance-browser
 */

import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createBrowserHandoff } from '../lib/browser-open.js';
import { canOpenNatively, openPathNatively } from '../lib/native-open.js';

let failures = 0;
function check(label, condition, detail) {
	if (condition) console.log(`  ok   ${label}`);
	else {
		failures += 1;
		console.log(`  FAIL ${label}${detail === undefined ? '' : `  (${detail})`}`);
	}
}

/** A harmless public page: opening it perturbs nothing. */
const target = 'https://example.com/';
const reason = 'Cloudflare challenge ("Just a moment..."): HTTP 403, score 41 [challenge-platform-script]';

console.log('dsh-cf-handoff browser acceptance — opens one browser window\n');

check('the opener reports itself usable on this host', canOpenNatively() === true);

// ---------------------------------------------------------------- the control
{
	const controller = new AbortController();
	let failed = false;
	let message = '';
	try {
		// The exact mistake the design exists to avoid: handing the opener a URL.
		await openPathNatively(target, controller.signal);
	} catch (error) {
		failed = true;
		message = String(error?.message ?? error);
	}
	check(
		'a URL cannot be handed to the path opener (so a staged file is required)',
		failed,
		failed ? message.split('\n')[0].slice(0, 140) : 'the opener accepted a URL; the staged-file design is no longer forced'
	);
}

// ------------------------------------------------- the real staged-file route
let stagedPath;
{
	const handoff = createBrowserHandoff({
		// The shipped wiring: `defaultOpenPath` calls exactly this.
		openPath: (path, signal) => openPathNatively(path, signal),
		autoNavigate: true
	});
	const controller = new AbortController();

	stagedPath = await handoff.open(target, reason, controller.signal);
	check('the opener accepted a staged file without throwing', typeof stagedPath === 'string', stagedPath);

	const info = await stat(stagedPath);
	check('the staged file exists and is non-empty', info.isFile() && info.size > 0, `${info.size} bytes`);

	const html = await readFile(stagedPath, 'utf8');
	check('the staged page carries the blocked URL as a link', html.includes(`href="${target}"`));
	check('the staged page auto-navigates to the blocked URL', html.includes(`window.location.replace("${target}")`));
	check('the staged page carries the detection reason', html.includes('Cloudflare challenge'));
	check(
		'the staged file sits under a dsh-cf-handoff- staging directory',
		stagedPath.startsWith(tmpdir()) && stagedPath.includes('dsh-cf-handoff-'),
		stagedPath
	);

	// Let the browser actually start before the directory disappears underneath it.
	await new Promise((resolve) => setTimeout(resolve, 1500));

	const removed = await handoff.dispose();
	check('the disposer removes the staged directory', removed === 1, `removed=${removed}`);
	let gone = false;
	try {
		await stat(stagedPath);
	} catch {
		gone = true;
	}
	check('the staged file is gone after disposal', gone);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — browser acceptance`);
if (failures === 0) {
	console.log('A browser window was opened for the staged page. That is the handoff working.');
}
process.exitCode = failures === 0 ? 0 : 1;

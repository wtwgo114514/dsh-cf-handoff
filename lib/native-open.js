/**
 * The default "open this file" implementation.
 *
 * WHY THIS EXISTS INSTEAD OF `openNativePath`
 * `@deepseek-ai/dsh-native-command` exports `openNativePath(path, signal)` and the
 * harness README advertises it as preferring the named default browser for HTML.
 * Calling it from a plugin is what the first version did, and in a linked install
 * it fails at runtime:
 *
 *   Cannot find package '@deepseek-ai/dsh-native-command' imported from
 *   D:\...\dsh-cf-handoff\lib\index.js
 *
 * Bare-specifier resolution walks up from the *importing* file, and a plugin
 * installed with `link:` (which is how a profile picks up a working copy) sits
 * outside the profile's `node_modules`, so the harness package is simply not
 * reachable from here. Declaring it a dependency would force a second copy and
 * still would not guarantee the profile's instance.
 *
 * So the behaviour is reproduced where it is 20 lines instead of a runtime
 * dependency: hand the path to the platform's "open with the associated
 * application" command. On Windows that is exactly what `openNativePath` does —
 * `Invoke-Item -LiteralPath <path>` through `powershell.exe`, which is why the
 * measured results in README §3.1 (a real `.html` file opens; a `file:///` or
 * `https://` argument fails) apply to this code unchanged.
 *
 * The opener is still an accelerator, never a dependency: `browser-open.js`
 * catches every failure here and the handoff notice always carries the URL.
 */

import { spawn } from 'node:child_process';

/**
 * Quote one path for a PowerShell `-Command` argument list.
 *
 * Single quotes are PowerShell's literal-string syntax: the only metacharacter
 * inside them is `'` itself, doubled. This is why the argument is passed as one
 * `-Command` string rather than through `-File`.
 *
 * @param {string} value - the path to quote
 * @returns {string} a PowerShell single-quoted literal
 */
export function powershellLiteral(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Run one command to completion.
 *
 * `stdio: 'ignore'` on purpose: nothing the launcher prints is useful here, and
 * a GUI child must not inherit pipes that would stay open until the user closes
 * a window.
 *
 * NOT `detached: true`. It looks harmless — "let the opener outlive us" — and it
 * silently destroys error reporting: spawning `powershell.exe -Command
 * "Invoke-Item -LiteralPath 'https://example.com'"` with `detached: true` exits
 * **0**, while the identical argv without it exits **1** with `Cannot find drive`
 * on stderr. Measured on the target machine, all three variants side by side.
 * With `detached`, a failed launch looks like a success and the caller never
 * learns the browser did not open. Nothing needs the detachment anyway: this
 * function awaits the launcher's exit, and the browser process is started by the
 * shell association, not by us.
 *
 * The child is unref'ed only *after* it settles. Un-ref'ing while awaiting it
 * makes the promise unsettleable: with no other handle keeping the loop alive,
 * Node drains the loop and reports "Detected unsettled top-level await" instead
 * of ever delivering `exit`. That is not theoretical — it hung the first run of
 * `test/acceptance-browser.mjs`.
 *
 * @param {string} command - executable name or path
 * @param {string[]} args - arguments
 * @param {AbortSignal | undefined} signal - caller lifetime
 * @param {typeof spawn} [spawnImpl] - injected for tests
 * @returns {Promise<void>} resolves once the command exited successfully
 */
export function runCommand(command, args, signal, spawnImpl = spawn) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(signal.reason ?? new Error(`${command} was cancelled`));
			return;
		}
		const child = spawnImpl(command, args, { stdio: 'ignore', windowsHide: true });
		let settled = false;
		/** @param {() => void} settle */
		const finish = (settle) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener?.('abort', abortListener);
			child.unref?.();
			settle();
		};
		const abortListener = () => {
			child.kill();
			finish(() => reject(signal?.reason instanceof Error ? signal.reason : new Error(`${command} was cancelled`)));
		};
		signal?.addEventListener?.('abort', abortListener, { once: true });
		child.once('error', (error) => finish(() => reject(error)));
		child.once('exit', (code) => {
			if (code === 0) finish(resolve);
			else finish(() => reject(new Error(`${command} exited with code ${code}`)));
		});
	});
}

/**
 * Whether this platform has a known "open with the default application" verb.
 *
 * @param {NodeJS.Platform} [platform] - platform to test
 * @returns {boolean} whether {@link openPathNatively} can run here
 */
export function canOpenNatively(platform = process.platform) {
	return platform === 'win32' || platform === 'darwin' || platform === 'linux';
}

/**
 * Hand one path to the platform's default application.
 *
 * @param {string} path - absolute path to open
 * @param {AbortSignal | undefined} signal - caller lifetime
 * @param {{ platform?: NodeJS.Platform, run?: typeof runCommand }} [deps] - injected for tests
 * @returns {Promise<void>} resolves once the launcher was started
 */
export async function openPathNatively(path, signal, deps = {}) {
	const platform = deps.platform ?? process.platform;
	const run = deps.run ?? runCommand;
	if (platform === 'darwin') {
		await run('open', [path], signal);
		return;
	}
	if (platform === 'win32') {
		await run('powershell.exe', ['-NoProfile', '-Command', `Invoke-Item -LiteralPath ${powershellLiteral(path)}`], signal);
		return;
	}
	if (platform === 'linux') {
		await run('xdg-open', [path], signal);
		return;
	}
	throw new Error(`no known "open with the default application" command on ${platform}`);
}

export default openPathNatively;

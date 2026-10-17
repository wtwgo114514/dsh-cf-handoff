/**
 * Open one blocked URL in the user's own browser.
 *
 * WHY A LOCAL BOOTSTRAP FILE AND NOT THE URL ITSELF
 * The platform opener (`lib/native-open.js`) is a *path* opener, not a URL
 * opener. On Windows it runs
 * `powershell.exe -NoProfile -Command "Invoke-Item -LiteralPath <arg>"`, and
 * `Invoke-Item` resolves its argument as a provider path — handed
 * `https://example.com` or `file:///C:/x.html` it fails with
 * "Cannot find drive. A drive with the name 'https' does not exist." (exit 1).
 * A real filesystem path to a `.html` file works: it is dispatched through the
 * shell's file association, which is the default browser.
 *
 * So this module writes a tiny bootstrap page next to the system temp
 * directory and opens THAT. The bootstrap carries the target URL, replaces
 * itself with the target, and always renders a visible fallback link so a
 * blocked automatic navigation is still one click away.
 *
 * The module takes its opener as a parameter, so it is unit-testable without
 * touching a desktop.
 *
 * @module dsh-cf-handoff/browser-open
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** Directory-name prefix for every directory this module creates. */
export const STAGING_PREFIX = 'dsh-cf-handoff-';

/**
 * Escape text for safe interpolation into an HTML text node or attribute.
 *
 * @param {string} value - raw text
 * @returns {string} escaped text
 */
export function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Escape a string so it can be embedded in a `<script>` as a JS string literal.
 *
 * `JSON.stringify` supplies the quoting and backslash escaping; U+2028/U+2029
 * are legal in JSON but terminate a line in older JS parsers, so they are
 * escaped explicitly. `</script>` cannot appear because `<` is escaped.
 *
 * @param {string} value - raw text
 * @returns {string} a quoted, escaped JS string literal
 */
export function jsStringLiteral(value) {
	return JSON.stringify(String(value)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029').replace(/</g, '\\u003c');
}

/**
 * Render the bootstrap page for one target.
 *
 * @param {object} input - render input
 * @param {string} input.url - the blocked URL to hand over
 * @param {string} input.reason - short human-readable reason shown on the page
 * @param {string} [input.host] - display host (defaults to the URL's hostname)
 * @param {boolean} [input.autoNavigate] - whether the page redirects itself
 * @returns {string} a complete HTML document
 */
export function renderBootstrapHtml(input) {
	const url = String(input.url);
	const reason = String(input.reason ?? '');
	const host = String(input.host ?? safeHostname(url) ?? url);
	const autoNavigate = input.autoNavigate !== false;
	const autoScript = autoNavigate
		? `      <script>window.location.replace(${jsStringLiteral(url)});</script>\n`
		: '';
	const doc = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>DSH handoff — ${escapeHtml(host)}</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        background: Canvas;
        color: CanvasText;
      }
      main { max-width: 42rem; padding: 2rem; }
      h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
      p { margin: 0 0 1rem; }
      .host { font-weight: 600; }
      .reason { opacity: .75; }
      ol { margin: 0 0 1.25rem; padding-left: 1.25rem; }
      li { margin: .25rem 0; }
      a.go {
        display: inline-block;
        padding: .6rem 1.1rem;
        border-radius: .5rem;
        background: #2f6fed;
        color: #fff;
        text-decoration: none;
        font-weight: 600;
      }
      code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; word-break: break-all; }
    </style>
${autoScript}  </head>
  <body>
    <main>
      <h1>DSH needs you to clear a Cloudflare check</h1>
      <p class="reason">${escapeHtml(reason)}</p>
      <ol>
        <li>Let <span class="host">${escapeHtml(host)}</span> finish its verification on this tab.</li>
        <li>Once the real page appears, copy the content DSH should read.</li>
        <li>Return to the DSH tab and paste it into the pending question.</li>
      </ol>
      <p><a class="go" href="${escapeHtml(url)}" rel="noreferrer">Open ${escapeHtml(host)}</a></p>
      <p class="reason"><code>${escapeHtml(url)}</code></p>
    </main>
  </body>
</html>
`;
	return doc;
}

/**
 * Best-effort hostname for display.
 *
 * @param {string} url - any URL string
 * @returns {string | undefined} the hostname, or undefined when unparseable
 */
function safeHostname(url) {
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

/**
 * Build a browser handoff bound to one opener and one staging root.
 *
 * @param {object} deps - injected dependencies
 * @param {(path: string, signal: AbortSignal) => Promise<void>} deps.openPath - native path opener
 * @param {string} [deps.tmpRoot] - staging root (defaults to the OS temp directory)
 * @param {typeof writeFile} [deps.writeFileImpl] - test seam
 * @param {typeof mkdtemp} [deps.mkdtempImpl] - test seam
 * @param {typeof rm} [deps.rmImpl] - test seam
 * @param {number} [deps.reopenAfterMs] - re-open the same URL only after this long (default 5 min)
 * @param {() => number} [deps.now] - clock seam
 * @returns {{ open(url: string, reason: string, signal: AbortSignal): Promise<string>, dispose(): Promise<void>, stagedPaths: string[] }} the handoff
 */
export function createBrowserHandoff(deps) {
	if (typeof deps?.openPath !== 'function') {
		throw new TypeError('createBrowserHandoff requires an openPath(path, signal) function');
	}
	const openPath = deps.openPath;
	const autoNavigate = deps.autoNavigate !== false;
	const tmpRoot = resolve(deps.tmpRoot ?? tmpdir());
	const writeFileImpl = deps.writeFileImpl ?? writeFile;
	const mkdtempImpl = deps.mkdtempImpl ?? mkdtemp;
	const rmImpl = deps.rmImpl ?? rm;
	const reopenAfterMs = typeof deps.reopenAfterMs === 'number' ? deps.reopenAfterMs : 300000;
	const now = deps.now ?? Date.now;

	/** @type {string[]} */
	const staged = [];
	/** @type {{ url: string, at: number, path: string } | undefined} */
	let lastOpened;

	return {
		stagedPaths: staged,

		/**
		 * Stage a bootstrap page for one URL and hand it to the default browser.
		 *
		 * Re-opening the same URL inside {@link reopenAfterMs} returns the page
		 * that is already on screen instead of spawning another tab. A user who
		 * clears one interstitial and then sees the same site fetched again should
		 * not collect one browser tab per attempt; the tab they already have is
		 * the tab the notice is talking about.
		 *
		 * @param {string} url - the URL the human must open
		 * @param {string} reason - short reason rendered on the page
		 * @param {AbortSignal} signal - caller lifetime; abort stops the opener
		 * @returns {Promise<string>} the staged bootstrap file path
		 */
		async open(url, reason, signal) {
			const at = now();
			if (
				lastOpened !== undefined &&
				lastOpened.url === url &&
				staged.includes(lastOpened.path) &&
				at - lastOpened.at < reopenAfterMs
			) {
				return lastOpened.path;
			}
			const dir = await mkdtempImpl(join(tmpRoot, STAGING_PREFIX));
			const stagedPath = join(dir, 'handoff.html');
			const html = renderBootstrapHtml({ url, reason, autoNavigate });
			await writeFileImpl(stagedPath, html, 'utf8');
			staged.push(stagedPath);
			signal?.throwIfAborted?.();
			await openPath(stagedPath, signal);
			lastOpened = { url, at, path: stagedPath };
			return stagedPath;
		},

		/**
		 * Remove every staged directory this instance created.
		 *
		 * Only paths under the staging root and matching {@link STAGING_PREFIX}
		 * are touched, so a misconfigured root cannot delete anything else.
		 *
		 * @returns {Promise<number>} how many directories were removed
		 */
		async dispose() {
			let removed = 0;
			for (const stagedPath of staged.splice(0, staged.length)) {
				const dir = resolve(stagedPath, '..');
				if (!dir.startsWith(tmpRoot + sep)) continue;
				if (!dir.slice(tmpRoot.length + 1).startsWith(STAGING_PREFIX)) continue;
				try {
					await rmImpl(dir, { recursive: true, force: true });
					removed += 1;
				} catch {
					// Staging cleanup is best-effort: a locked file must not fail a turn.
				}
			}
			return removed;
		}
	};
}

export default createBrowserHandoff;

/**
 * Acceptance: a real headless DSH run against a real Cloudflare site.
 *
 * WHY THIS EXISTS
 *
 * The unit tests fake both sides of every seam, and `live-smoke.mjs` proves the
 * wiring but fetches a fixture. Neither can show that the shipped detection
 * agrees with a real Cloudflare response, or — more importantly — that the
 * failure code is *readable by the agent* once the harness renders it.
 *
 * That second point is not hypothetical. The first run of exactly this scenario
 * showed the agent quoting the plugin's message and reporting the inner
 * `NO_PROVIDER` as the failure code, because `web_cloudflare_handoff_unavailable`
 * existed only as a structured field the rendered text never carried. This script
 * is the regression guard for that, and it is the only test that can be.
 *
 * It costs two model calls, which is why it is opt-in and not part of `npm test`.
 *
 * PREREQUISITE
 *
 * A `headless` profile with this plugin installed:
 *
 *   dsh plugin add <this-directory> --profile headless
 *
 * The run has no GUI answerer, so it exercises the unreachable-answerer path —
 * the one that must report rather than hang. That is deliberate: it is the
 * fallback the spec cares most about, and the only branch reachable without a
 * human at the keyboard.
 *
 * @module dsh-cf-handoff/test/acceptance-headless
 */

import { spawnSync } from 'node:child_process';

const PROFILE = process.env.DSH_CF_HANDOFF_ACCEPTANCE_PROFILE ?? 'headless';
/** A real site that serves a genuine Cloudflare interstitial to this client. */
const GUARDED = 'https://community.cloudflare.com/';
/** A plain page: the false-positive regression, checked in the real runtime. */
const PLAIN = 'https://example.com/';

let failures = 0;
function check(label, condition, detail) {
	if (condition) console.log(`  ok   ${label}`);
	else {
		failures += 1;
		console.log(`  FAIL ${label}${detail === undefined ? '' : `  (${detail})`}`);
	}
}

/**
 * Run one task headlessly and return its combined output.
 *
 * The command is passed as a single string with `shell: true`, which is
 * deliberate on two counts. `dsh` installs as a Windows `.cmd`/`.ps1` shim, and
 * since CVE-2024-27980 Node refuses to spawn those without a shell. And passing
 * an *args array* alongside `shell: true` is deprecated (`DEP0190`) because the
 * arguments are concatenated rather than escaped — which also means the task text
 * must be quoted here. It contains no double quotes, and the guard below keeps
 * that true rather than assuming it.
 */
function ask(task) {
	if (task.includes('"')) throw new Error(`acceptance task must not contain a double quote: ${task}`);
	const proc = spawnSync(`dsh --profile ${PROFILE} "${task}"`, {
		encoding: 'utf8',
		shell: true,
		maxBuffer: 32 * 1024 * 1024
	});
	return {
		status: proc.status,
		text: `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`
	};
}

console.log(`dsh-cf-handoff headless acceptance (profile: ${PROFILE}) — two model calls\n`);

// ------------------------------------------- 1. a real interstitial is handed off
{
	console.log(`fetching a guarded page: ${GUARDED}`);
	const { status, text } = ask(
		`Use web_fetch exactly once on ${GUARDED} . Then report the exact tool result verbatim, ` +
			'including any bracketed code such as [web_...] that appears in it. Do not retry.'
	);

	check('the run finished on its own instead of hanging', status === 0, `exit ${status}`);
	check('a real Cloudflare challenge was detected', /Cloudflare challenge/.test(text));
	check('the upstream status was reported', /HTTP 403/.test(text));
	check(
		'the detection carries a score and its signals',
		/score \d+/.test(text) && /challenge-platform-script|cf-chl-opt/.test(text),
		'no scoring evidence in the output'
	);
	check(
		'the agent can READ the failure code, not just have it attached',
		// Notify mode reports `web_cloudflare_challenge`; inline mode can instead
		// fail with `web_cloudflare_handoff_unavailable` when no answerer exists.
		// Either way the property under test is the same one: a documented code
		// reaches the rendered text, which is what the agent routes on.
		/web_cloudflare_challenge|web_cloudflare_handoff_unavailable/.test(text),
		'the code never reached the rendered message'
	);
	check('the blocked URL is surfaced for the human', text.includes('community.cloudflare.com'));
	check(
		'the interstitial markup is not handed back as page content',
		!/<!DOCTYPE html/i.test(text) && !/<\/script>/i.test(text),
		'raw challenge markup leaked into the model-visible result'
	);
}

// ------------------------------------- 2. an ordinary page is never a false positive
{
	console.log(`\nfetching a plain page: ${PLAIN}`);
	const { status, text } = ask(
		`Use web_fetch exactly once on ${PLAIN} . Then report the exact tool result verbatim. Do not retry.`
	);

	check('the run finished on its own instead of hanging', status === 0, `exit ${status}`);
	check('the page content actually came back', /Example Domain/i.test(text));
	check(
		'an ordinary page triggers no Cloudflare handoff at all',
		!/web_cloudflare|web_blocked_by_cloudflare|Cloudflare challenge/i.test(text),
		'false positive on a page that has no interstitial'
	);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — headless acceptance`);
process.exitCode = failures === 0 ? 0 : 1;

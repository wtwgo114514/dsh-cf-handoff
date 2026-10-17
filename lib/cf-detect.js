/**
 * Pure Cloudflare-interstitial detector for DSH web fetch results.
 *
 * WHY THIS IS BODY-BASED
 * `WebFetchResult` (see `@deepseek-ai/dsh-web/types`) carries only
 * `{ url, statusCode, body, truncated }` - a provider never sees response
 * headers. So the canonical header signals (`cf-mitigated: challenge`,
 * `server: cloudflare`, `cf-ray`) are NOT observable at this layer, and
 * detection has to work from the status code plus the decoded body alone.
 * That constraint is why this module matches on body structure and is tuned
 * conservatively: a false positive would stall an agent turn on a page that
 * never needed a human.
 *
 * KINDS
 * - `challenge`: an interactive interstitial a human can actually clear
 *   ("Just a moment...", Turnstile, managed challenge). Handoff applies.
 * - `block`: Cloudflare refused the request outright (1020 / firewall rule /
 *   "Sorry, you have been blocked"). No human interaction clears it, so
 *   handing off would just waste the user's time.
 * - `page-error`: a Cloudflare edge error (5xx "Error 1020"-style page) whose
 *   body merely mentions Cloudflare. Informational only.
 * - `none`: no signal.
 *
 * This module is dependency-free and has no I/O so it can be unit tested from
 * recorded real-world fixtures.
 *
 * @module dsh-cf-handoff/cf-detect
 */

/** Verdict kinds, ordered from "worth a human" to "not Cloudflare's doing". */
export const CF_KINDS = Object.freeze(['challenge', 'block', 'page-error', 'none']);

/** Status codes Cloudflare uses for interstitials and refusals. */
export const CF_STATUS_CODES = Object.freeze([403, 429, 503]);

/**
 * URL fragments Cloudflare puts on interstitial navigations.
 *
 * These appear in the address a challenge redirects to (`__cf_chl_rt_tk`,
 * `__cf_chl_tk`, `__cf_chl_f_tk`) and on the challenge endpoints themselves.
 * They are checked against **both** the requested URL and the fetched result's
 * final URL, because `WebFetchResult.url` is documented as "the final URL after
 * allowed redirects" while the request keeps the original.
 */
export const CF_URL_MARKERS = Object.freeze(['__cf_chl', '/cdn-cgi/challenge', 'challenges.cloudflare.com/turnstile']);

/**
 * Whether a URL is itself a Cloudflare challenge navigation or endpoint.
 *
 * This is the cheap pre-flight half of detection: it needs no response at all,
 * so it can answer "is this fetch already doomed to an interstitial?" before the
 * request is sent -which is what lets the handoff open the browser early
 * instead of after a wasted round trip. A URL-only hit is a strong signal
 * (`__cf_chl` and the challenge-platform endpoints are never part of an ordinary
 * page address), so it is checked without a score threshold.
 *
 * @param {string} url - any URL string
 * @returns {boolean} whether the URL carries a Cloudflare challenge marker
 */
export function isCloudflareChallengeUrl(url) {
	const text = String(url ?? '').toLowerCase();
	if (text.length === 0) return false;
	return CF_URL_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Whether a response could be a Cloudflare interstitial at all.
 *
 * This is the recall-oriented companion to {@link detectCfInterstitial}: it asks
 * "should anything ever hand this to a human?" rather than "is this a
 * challenge?". A Cloudflare-authored body, or a challenge URL, is enough - which
 * is why the interstitial's own title is deliberately matched here WITHOUT the
 * blocked-status gate that the scoring rules apply.
 *
 * That difference is load-bearing: Cloudflare serves the bare
 * `<title>Just a moment...</title>` shell, and it can arrive with HTTP 200 when
 * an edge rule rewrites the status. The scorer is built to avoid conviction on
 * such thin evidence, but the *handoff* still wants the chance to look.
 *
 * @param {string} url - the request or final URL
 * @param {string} [body] - decoded response body
 * @returns {boolean} whether this might need a human
 */
export function couldBeCloudflareInterstitial(url, body) {
	if (isCloudflareChallengeUrl(url)) return true;
	const text = String(body ?? '');
	if (text.length === 0) return false;
	return /just a moment\.\.\.|checking your browser|attention required!|enable javascript and cookies to continue|verify you are human|you have been blocked|cf_chl_opt|cf-turnstile|challenge-platform/i.test(
		text
	);
}

/**
 * The pure predicate the design notes ask for: is this response an interactive
 * Cloudflare challenge?
 *
 * `html` is the decoded body, `url` is the final (post-redirect) URL, and
 * `statusCode` is optional but improves accuracy -the interstitial's title is
 * only accepted as evidence alongside a refusal status, because the phrase also
 * occurs in ordinary prose.
 *
 * Only `challenge` counts as true. A `block` or an edge error is a Cloudflare
 * outcome no human can clear, so treating those as "hand off to a person" would
 * stall a turn for nothing; use {@link detectCfInterstitial} when the
 * distinction matters.
 *
 * @param {string} html - decoded response body
 * @param {string} url - the URL the response came from
 * @param {{ minScore?: number, statusCode?: number }} [options] - overrides
 * @returns {boolean} whether a human could clear this response
 */
export function isCloudflareChallenge(html, url, options = {}) {
	const body = typeof html === 'string' ? html : String(html ?? '');
	const verdict = detectCfInterstitial(
		{ statusCode: Number.isFinite(options.statusCode) ? Number(options.statusCode) : 0, body: { kind: 'html', content: body } },
		options
	);
	return verdict.kind === 'challenge';
}

/**
 * Default score a verdict must reach before it counts as confirmed.
 * Rule weights are chosen so that a single strong challenge marker (8) plus
 * the blocked status code (6) always clears this, while a lone weak marker
 * (2) never does.
 */
export const DEFAULT_MIN_SCORE = 12;

/**
 * One detection rule. `re` is matched against a normalized haystack so
 * minified markup (`<meta charset="utf-8"><title>Just a moment...`) still
 * matches without pretending to be an HTML parser.
 *
 * @typedef {object} Rule
 * @property {string} id - stable rule id, reported as evidence
 * @property {RegExp} re - pattern over the normalized haystack
 * @property {number} weight - contribution to the score
 * @property {'challenge'|'block'|'page-error'} kind - verdict this rule votes for
 * @property {boolean} [statusGated] - only counts when the status code is blocked
 */

/**
 * Normalize a haystack for structural matching.
 *
 * Lowercases, collapses runs of whitespace, and strips the quotes that surround
 * HTML attribute values so one pattern covers `content="3;url=/x"` and
 * `content='3;url=/x'` alike.
 *
 * @param {string} text - raw body text
 * @returns {string} normalized haystack
 */
export function normalizeHaystack(text) {
	return String(text).toLowerCase().replace(/\s+/g, ' ').replace(/["']/g, '');
}

/** @type {readonly Rule[]} */
export const RULES = Object.freeze([
	// ==== strong challenge structure ====
	// Cloudflare's challenge runtime script, present on every managed
	// challenge and interstitial form, absent from its error pages.
	{
		id: 'challenge-platform-script',
		re: /\/cdn-cgi\/challenge-platform/,
		weight: 8,
		kind: 'challenge'
	},
	// The challenge form's own bootstrap object, as cf_chl_opt or the
	// minified window._cf_chl_opt (\b cannot be used: _ is a word character).
	{ id: 'cf-chl-opt', re: /(^|[^a-z0-9])_?cf_chl_opt/, weight: 8, kind: 'challenge' },
	// Challenge endpoint / hidden input family.
	{ id: 'cf-chl-endpoint', re: /\/cdn-cgi\/challenge|\bcf_chl_/, weight: 6, kind: 'challenge' },
	// Turnstile widget markup (standalone Turnstile and the newer interstitials).
	{ id: 'turnstile', re: /\bchallenges\.cloudflare\.com\/turnstile|\bcf-turnstile\b/, weight: 6, kind: 'challenge' },
	// The interstitial's own container ids.
	{ id: 'challenge-running', re: /id=challenge-running|id=challenge-stage|id=challenge-body/, weight: 6, kind: 'challenge' },

	// ==== interstitial titles ====
	// A blocked status plus this title is Cloudflare's minimal JS shell -the
	// whole body can be nothing but the title text, which is exactly what a
	// provider receives when it does not run JavaScript.
	{ id: 'title-just-a-moment', re: /just a moment\.\.\./, weight: 8, kind: 'challenge' },
	{ id: 'title-checking-browser', re: /checking your browser(?: before accessing)?/, weight: 8, kind: 'challenge' },
	{ id: 'title-attention-required', re: /attention required!/, weight: 4, kind: 'challenge' },
	{ id: 'challenge-copy', re: /enable javascript and cookies to continue|verify you are human|needs to review the security of your connection/, weight: 5, kind: 'challenge' },

	// ==== refusals: no human interaction clears these ====
	{ id: 'blocked-by-cloudflare', re: /sorry, you have been blocked|you are unable to access/, weight: 10, kind: 'block' },
	{ id: 'firewall-1020', re: /error code:? 1020|error 1020/, weight: 10, kind: 'block' },
	{ id: 'blocked-ray-id', re: /cloudflare ray id:|performance & security by cloudflare|cf-error-details/, weight: 6, kind: 'block' },

	// ==== edge errors ====
	{ id: 'edge-error-code', re: /error code:? 10\d\d|error 5\d\d/, weight: 6, kind: 'page-error' }
]);

/**
 * Cheap pre-filter: could this body possibly be a Cloudflare artifact?
 *
 * Useful for logging and for skipping the full rule sweep on ordinary pages.
 *
 * @param {string} text - raw body text
 * @returns {boolean} true when the text mentions Cloudflare at all
 */
export function mentionsCloudflare(text) {
	return /cloudflare|\/cdn-cgi\/|\bcf_chl|cf-turnstile/i.test(String(text));
}

/**
 * Extract the `<title>` text, if one is present.
 *
 * @param {string} text - raw body text
 * @returns {string | undefined} the trimmed title, or undefined
 */
export function extractTitle(text) {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(text));
	if (match === null) return undefined;
	const title = match[1].replace(/\s+/g, ' ').trim();
	return title.length > 0 ? title : undefined;
}

/**
 * Detect and classify a Cloudflare interstitial in one fetch outcome.
 *
 * @param {object} input - detection input
 * @param {number} input.statusCode - the fetch's HTTP status code
 * @param {{ kind: 'html' | 'text', content: string } | undefined} input.body - decoded body
 * @param {number} [options.minScore] - override {@link DEFAULT_MIN_SCORE}
 * @returns {{
 *   kind: 'challenge' | 'block' | 'page-error' | 'none',
 *   score: number,
 *   statusCode: number,
 *   signals: string[],
 *   title?: string,
 *   summary: string,
 * }} the verdict, its evidence, and a one-line human-readable summary
 */
export function detectCfInterstitial(input, options = {}) {
	const minScore = Number.isFinite(options.minScore) ? Number(options.minScore) : DEFAULT_MIN_SCORE;
	const statusCode = Number.isFinite(input?.statusCode) ? Number(input.statusCode) : 0;
	const body = input?.body;
	const content = typeof body?.content === 'string' ? body.content : '';
	const haystack = normalizeHaystack(content);
	const statusBlocked = CF_STATUS_CODES.includes(statusCode);

	/** @type {Map<'challenge'|'block'|'page-error', number>} */
	const kindScores = new Map([
		['challenge', 0],
		['block', 0],
		['page-error', 0]
	]);
	/** @type {string[]} */
	const signals = [];

	for (const rule of RULES) {
		if (!rule.re.test(haystack)) continue;
		// A bare title match is not enough on its own to call something an
		// interstitial: the phrase can appear in prose. Require the response to
		// actually have been refused before the title votes.
		if (rule.id.startsWith('title-') && rule.id !== 'title-attention-required' && !statusBlocked) continue;
		signals.push(rule.id);
		kindScores.set(rule.kind, (kindScores.get(rule.kind) ?? 0) + rule.weight);
	}

	// The blocked status is itself evidence, but it only reinforces a body
	// signal. On its own a 403 is far more often an ordinary authorization
	// failure than a Cloudflare interstitial.
	if (statusBlocked && signals.length > 0) {
		for (const kind of kindScores.keys()) {
			if ((kindScores.get(kind) ?? 0) > 0) kindScores.set(kind, (kindScores.get(kind) ?? 0) + 6);
		}
	}

	let bestKind = 'none';
	let bestScore = 0;
	for (const [kind, score] of kindScores) {
		if (score <= bestScore) continue;
		bestKind = kind;
		bestScore = score;
	}
	if (bestScore < minScore) bestKind = 'none';

	const title = extractTitle(content);
	const summary = summarize(bestKind, bestScore, statusCode, title, signals);
	return {
		kind: bestKind,
		score: bestScore,
		statusCode,
		signals,
		...(title === undefined ? {} : { title }),
		summary
	};
}

/**
 * Build the one-line summary carried into errors and logs.
 *
 * @param {string} kind - verdict kind
 * @param {number} score - winning score
 * @param {number} statusCode - response status
 * @param {string | undefined} title - extracted title
 * @param {string[]} signals - matched rule ids
 * @returns {string} a short human-readable verdict line
 */
function summarize(kind, score, statusCode, title, signals) {
	if (kind === 'none') {
		return statusCode > 0
			? `HTTP ${statusCode}, no Cloudflare interstitial detected`
			: 'no Cloudflare interstitial detected';
	}
	const label = kind === 'challenge' ? 'Cloudflare challenge' : kind === 'block' ? 'Cloudflare block' : 'Cloudflare edge error';
	const where = title === undefined ? '' : ` ("${title}")`;
	return `${label}${where}: HTTP ${statusCode}, score ${score} [${signals.join(', ')}]`;
}

export default detectCfInterstitial;

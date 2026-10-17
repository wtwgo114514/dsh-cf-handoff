/**
 * Detection tests.
 *
 * The fixtures are recorded shapes of what Cloudflare actually serves to a
 * non-JavaScript HTTP client. The regression case at the bottom is the one that
 * matters most: a false positive here stalls an agent turn on a page that never
 * needed a human.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	CF_KINDS,
	CF_STATUS_CODES,
	CF_URL_MARKERS,
	DEFAULT_MIN_SCORE,
	couldBeCloudflareInterstitial,
	extractTitle,
	isCloudflareChallenge,
	isCloudflareChallengeUrl,
	mentionsCloudflare,
	normalizeHaystack,
	detectCfInterstitial
} from '../lib/cf-detect.js';

/** Classic "Just a moment..." interstitial: HTML shell plus challenge runtime. */
const CLASSIC_INTERSTITIAL = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Just a moment...</title>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <meta http-equiv="X-UA-Compatible" content="IE=Edge">
  <meta name="robots" content="noindex,nofollow">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>*{box-sizing:border-box;margin:0;padding:0}body{background:#fff}</style>
</head>
<body>
  <div id="challenge-running" class="cf-challenge">
    <div id="challenge-stage">
      <div id="challenge-body">
        <noscript>Enable JavaScript and cookies to continue</noscript>
      </div>
    </div>
  </div>
  <script>(function(){window._cf_chl_opt={cvId:"3",cType:"managed",cRay:"a1b2c3d4e5f6a7b8",cZone:"example.com",cITimeS:"1700000000"};})();</script>
  <script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=a1b2c3d4e5f6a7b8"></script>
</body>
</html>`;

/** What a client with no JavaScript actually receives: the title and nothing else. */
const BARE_JS_SHELL = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>`;

/** A page embedding a Turnstile widget in its own markup. */
const TURNSTILE_PAGE = `<!DOCTYPE html>
<html>
<head><title>Sign in</title></head>
<body>
  <h1>Checking your browser before accessing example.test</h1>
  <form action="/login" method="post">
    <input type="text" name="user">
    <div class="cf-turnstile" data-sitekey="0x4AAAAAAABkMYinukE8nzY" data-callback="onTurnstileOk"></div>
  </form>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</body>
</html>`;

/** A `__cf_chl` interstitial that answers with a meta refresh instead of a body. */
const CF_CHL_REDIRECT_PAGE = `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="refresh" content="0;url=/cdn-cgi/challenge-platform/h/b/flow/ov1/1234567890/1700000000/abcdef">
  <title>Just a moment...</title>
</head>
<body>
  <script>window.location.replace("/cdn-cgi/challenge-platform/h/b/flow/ov1/1234567890/1700000000/abcdef");</script>
  <noscript><a href="/cdn-cgi/challenge-platform/h/b/flow/ov1/1234567890/1700000000/abcdef">Continue</a></noscript>
</body>
</html>`;

/** Cloudflare's refusal page: a firewall rule, not a solvable challenge. */
const BLOCK_PAGE = `<!DOCTYPE html>
<html>
<head><title>Attention Required! | Cloudflare</title></head>
<body>
  <h1>Sorry, you have been blocked</h1>
  <p>You are unable to access example.test</p>
  <p>Error code: 1020</p>
  <p>Cloudflare Ray ID: 8f2c1d4e5a6b7c8d</p>
  <p>Performance &amp; security by Cloudflare</p>
</body>
</html>`;

/** A perfectly ordinary page that happens to discuss Cloudflare. */
const ORDINARY_ARTICLE = `<!DOCTYPE html>
<html>
<head>
  <title>How our CDN handles cache invalidation</title>
  <meta name="description" content="A write-up about edge caching.">
</head>
<body>
  <article>
    <h1>How our CDN handles cache invalidation</h1>
    <p>We put Cloudflare in front of the origin last year. Turnstile replaced our
       old CAPTCHA. Just a moment&rsquo;s downtime during the migration was the only
       real cost, and the firewall rules now stop most scraping.</p>
    <blockquote>&ldquo;Just a moment...&rdquo; is the page our crawler kept seeing, so we
       added a retry queue. Checking your browser is apparently a whole industry.</blockquote>
    <p>Nothing on this page needs human interaction.</p>
  </article>
</body>
</html>`;

/** Ordinary page returned by a server that returned 403 for authorization reasons. */
const ORDINARY_403 = `<!DOCTYPE html>
<html><head><title>403 Forbidden</title></head>
<body><h1>Forbidden</h1><p>You do not have permission to view this directory.</p></body></html>`;

/** @param {string} content - body text */
function html(content, statusCode = 403) {
	return { statusCode, body: { kind: 'html', content } };
}

test('exposes stable marker constants', () => {
	assert.deepEqual([...CF_KINDS], ['challenge', 'block', 'page-error', 'none']);
	assert.deepEqual([...CF_STATUS_CODES], [403, 429, 503]);
	assert.equal(DEFAULT_MIN_SCORE, 12);
	assert.ok(CF_URL_MARKERS.includes('__cf_chl'));
});

test('classic 5-second shield is detected as a challenge', () => {
	const verdict = detectCfInterstitial(html(CLASSIC_INTERSTITIAL, 403));
	assert.equal(verdict.kind, 'challenge');
	assert.ok(verdict.score >= DEFAULT_MIN_SCORE, `score ${verdict.score} must clear the threshold`);
	assert.equal(verdict.statusCode, 403);
	assert.equal(verdict.title, 'Just a moment...');
	assert.ok(verdict.signals.includes('challenge-platform-script'));
	assert.ok(verdict.signals.includes('cf-chl-opt'));
	assert.match(verdict.summary, /Cloudflare challenge/);
	assert.match(verdict.summary, /score \d+/);
});

test('the bare JavaScript shell is detected from its title plus the refusal status', () => {
	const verdict = detectCfInterstitial(html(BARE_JS_SHELL, 403));
	assert.equal(verdict.kind, 'challenge');
	assert.ok(verdict.score >= DEFAULT_MIN_SCORE);
	assert.deepEqual(verdict.signals, ['title-just-a-moment']);
});

test('the interstitial title alone does not convict a 200 response', () => {
	const verdict = detectCfInterstitial(html(BARE_JS_SHELL, 200));
	assert.equal(verdict.kind, 'none');
	assert.deepEqual(verdict.signals, []);
});

test('an embedded Turnstile widget is detected as a challenge', () => {
	const verdict = detectCfInterstitial(html(TURNSTILE_PAGE, 403));
	assert.equal(verdict.kind, 'challenge');
	assert.equal(verdict.statusCode, 403);
	assert.equal(verdict.title, 'Sign in');
	assert.ok(verdict.signals.includes('turnstile'));
	assert.ok(verdict.signals.includes('title-checking-browser'));
});

test('a lone Turnstile widget on a 200 page is not convicted on one weak marker', () => {
	// Two weak markers are required, and a 200 response forfeits the title rule,
	// so the widget alone stays inconclusive — the scorer refuses to stall a
	// turn on a single weak signal. `couldBeCloudflareInterstitial` is the
	// recall-oriented companion that still flags it for investigation.
	const verdict = detectCfInterstitial(html(TURNSTILE_PAGE, 200));
	assert.equal(verdict.kind, 'none');
	assert.deepEqual(verdict.signals, ['turnstile']);
	assert.equal(couldBeCloudflareInterstitial('https://example.test/login', TURNSTILE_PAGE), true);
});

test('two weak markers together clear the threshold', () => {
	const verdict = detectCfInterstitial(html(TURNSTILE_PAGE, 403));
	assert.equal(verdict.kind, 'challenge');
	assert.ok(verdict.score >= DEFAULT_MIN_SCORE);
});

test('a __cf_chl redirect page is detected as a challenge', () => {
	const verdict = detectCfInterstitial(html(CF_CHL_REDIRECT_PAGE, 403));
	assert.equal(verdict.kind, 'challenge');
	assert.equal(verdict.title, 'Just a moment...');
	assert.ok(verdict.signals.includes('cf-chl-endpoint'));
	assert.ok(verdict.signals.includes('challenge-platform-script'));
});

test('a firewall block is classified as block, not challenge', () => {
	const verdict = detectCfInterstitial(html(BLOCK_PAGE, 403));
	assert.equal(verdict.kind, 'block');
	assert.ok(verdict.score >= DEFAULT_MIN_SCORE);
	assert.ok(verdict.signals.includes('blocked-by-cloudflare'));
	assert.ok(verdict.signals.includes('firewall-1020'));
	assert.match(verdict.summary, /Cloudflare block/);
});

test('an ordinary article that discusses Cloudflare is not a challenge', () => {
	const verdict = detectCfInterstitial(html(ORDINARY_ARTICLE, 200));
	assert.equal(verdict.kind, 'none', `unexpected signals: ${verdict.signals.join(', ')}`);
	assert.deepEqual(verdict.signals, []);
});

test('an ordinary 403 is not a Cloudflare artifact', () => {
	const verdict = detectCfInterstitial(html(ORDINARY_403, 403));
	assert.equal(verdict.kind, 'none');
	assert.deepEqual(verdict.signals, []);
});

test('a plain-text body and a missing body are both tolerated', () => {
	assert.equal(detectCfInterstitial({ statusCode: 200, body: { kind: 'text', content: 'hello' } }).kind, 'none');
	assert.equal(detectCfInterstitial({ statusCode: 403, body: undefined }).kind, 'none');
	assert.equal(detectCfInterstitial(undefined).kind, 'none');
	assert.equal(detectCfInterstitial(undefined).statusCode, 0);
});

test('minScore is honored as an override in both directions', () => {
	const body = html(TURNSTILE_PAGE, 200);
	assert.equal(detectCfInterstitial(body, { minScore: 999 }).kind, 'none');
	assert.equal(detectCfInterstitial(html(BARE_JS_SHELL, 403), { minScore: 1 }).kind, 'challenge');
});

test('every rule reports a stable id when it fires', () => {
	const verdict = detectCfInterstitial(html(CLASSIC_INTERSTITIAL, 503));
	for (const signal of verdict.signals) assert.equal(typeof signal, 'string');
	assert.equal(new Set(verdict.signals).size, verdict.signals.length, 'signals must be unique');
});

test('isCloudflareChallenge is a pure boolean predicate over body and url', () => {
	assert.equal(isCloudflareChallenge(CLASSIC_INTERSTITIAL, 'https://example.test/', { statusCode: 403 }), true);
	assert.equal(isCloudflareChallenge(ORDINARY_ARTICLE, 'https://example.test/blog', { statusCode: 200 }), false);
	assert.equal(isCloudflareChallenge(BLOCK_PAGE, 'https://example.test/', { statusCode: 403 }), false, 'a block is not a solvable challenge');
	assert.equal(isCloudflareChallenge(BARE_JS_SHELL, 'https://example.test/', { statusCode: 403 }), true);
});

test('a __cf_chl url is a strong pre-flight signal on its own', () => {
	assert.equal(isCloudflareChallengeUrl('https://x.test/cdn-cgi/challenge-platform/h/b/flow/ov1/abc'), true);
	assert.equal(isCloudflareChallengeUrl('https://x.test/?__cf_chl_tk=abc'), true);
	assert.equal(isCloudflareChallengeUrl('https://example.test/blog'), false);
	assert.equal(couldBeCloudflareInterstitial('https://example.test/?__cf_chl_tk=abc'), true);
});

test('couldBeCloudflareInterstitial is recall-oriented but still not blind', () => {
	assert.equal(couldBeCloudflareInterstitial('https://example.test/', BARE_JS_SHELL), true, 'the bare shell title counts here without a refusal status');
	assert.equal(couldBeCloudflareInterstitial('https://example.test/', ORDINARY_ARTICLE), true, 'the phrase in prose still warrants a look');
	assert.equal(couldBeCloudflareInterstitial('https://example.test/blog', ORDINARY_403), false);
	assert.equal(couldBeCloudflareInterstitial('https://example.test/blog'), false);
});

test('repeated detection of the same input is stable', () => {
	const first = detectCfInterstitial(html(CLASSIC_INTERSTITIAL, 403));
	const second = detectCfInterstitial(html(CLASSIC_INTERSTITIAL, 403));
	assert.deepEqual(first, second);
});

test('helpers behave as documented', () => {
	assert.equal(normalizeHaystack('  A\n\tB  '), ' a b ');
	assert.equal(normalizeHaystack('content="3;url=/x"'), 'content=3;url=/x');
	assert.equal(extractTitle('<title>  Just a moment...  </title>'), 'Just a moment...');
	assert.equal(extractTitle('<html></html>'), undefined);
	assert.equal(mentionsCloudflare('served by Cloudflare'), true);
	assert.equal(mentionsCloudflare('/cdn-cgi/challenge-platform'), true);
	assert.equal(mentionsCloudflare('nothing here'), false);
	assert.equal(isCloudflareChallengeUrl('https://x.test/?__cf_chl_rt_tk=1'), true);
	assert.equal(isCloudflareChallengeUrl(''), false);
	assert.equal(isCloudflareChallengeUrl(undefined), false);
});

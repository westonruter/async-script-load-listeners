# Listening for Loaded Async Script

This repo contains the research for I was doing for WordPress core to enable inline `after` scripts to delay their execution until after the related script is loaded. This is for the following Trac ticket:

* [#12009](https://core.trac.wordpress.org/ticket/12009): Add support for HTML 5 "async" and "defer" attributes in WordPress core.

Specifically, the research I was doing in order to make the approach compatible with CSP. Ultimately, "[Script Loading Strategies](https://make.wordpress.org/core/2023/07/14/registering-scripts-with-async-and-defer-attributes-in-wordpress-6-3/)" landed without support for allowing `async`/`defer` scripts to have inline `after` scripts. When such inline scripts are present, the `async`/`defer` falls back to blocking. Trac ticket [#58632](https://core.trac.wordpress.org/ticket/58632) (Add support for 'async' and 'defer' loading to script that use inline scripts) was opened to continue considering this, but it was closed as `maybelater` given there [not being enough inline `after` scripts](https://core.trac.wordpress.org/ticket/58632#comment:3) for `async`/`defer` scripts to warrany the additional complexity for now.

This repo contains that original research as well as citing some of my key relevant comments which are otherwise buried among hundreds of others.

## [Pull Request Comment](https://github.com/WordPress/wordpress-develop/pull/4391#issuecomment-1536869109)

I've been doing a bunch of research this week on [`wpLoadAfterScripts()`](https://github.com/WordPress/wordpress-develop/blob/425a905a46406b93d061fccdd3ac8b0b890e9eae/src/wp-includes/script-loader.php#L1859-L1869), specifically how it relates to `Content-Security-Policy` (CSP). Here are my findings and recommendations.

### Vulnerability with Strict CSP and Deferred Inline Script Nonces

Previously, this function relied on `eval()` which I was concerned about in relation to CSP because it requires the [`'unsafe-eval'`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/script-src#unsafe_eval_expressions) source expression. So that was [replaced](https://github.com/WordPress/wordpress-develop/commit/0e120b745b17d094244c004d9a11156379ce1971) with the current approach of cloning the `script`, setting the `type` to `text/javascript`, and replacing the original. See [prior discussion](https://github.com/10up/wordpress-develop/pull/54#pullrequestreview-1403010042). While this successfully eliminates `eval()` and the need for `'unsafe-eval'` it actually introduces a separate CSP security problem which is quite subtle.

Google has published a recommended "[Strict CSP](https://csp.withgoogle.com/docs/strict-csp.html)" configuration which includes a `nonce` requirement for scripts as well as the [`'strict-dynamic'`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/script-src#strict-dynamic) source expression ([available](https://caniuse.com/mdn-http_headers_content-security-policy_strict-dynamic) in all current browsers):

<blockquote cite="https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/script-src#strict-dynamic">The <code>'strict-dynamic'</code> source expression specifies that the trust explicitly given to a script present in the markup, by accompanying it with a nonce or a hash, shall be propagated to all the scripts loaded by that root script. At the same time, any allowlist or source expressions such as <code>'self'</code> or <code>'unsafe-inline'</code> will be ignored.</blockquote>

Let's say you have served a page with the following CSP (where the hash is for `wpLoadAfterScripts('myasync')`):

```http
Content-Security-Policy: script-src 'nonce-r4nd0m' 'unsafe-inline' 'strict-dynamic' 'unsafe-hashes' 'sha256-etusux0wzH3DpYQntoMjmI5AaInUBIQZ02VvSOUZqRM=' https: http:;
```

And your page contains the following HTML, in addition to the `wpLoadAfterScripts()` function:

```html
<script
  id="myasync-js"
  src="/async-script.js"
  nonce="r4nd0m"
  async
  onload="wpLoadAfterScripts('myasync')"
></script>

<script
  type="text/template"
  data-wp-executes-after="myasync"
  nonce="r4nd0m"
>
  goodCode(); // ✅
</script>

<script
  type="text/template"
  data-wp-executes-after="myasync"
  nonce="bad"
>
  badCode(); // ❌
</script>
```

Notice how the first two scripts have the required `nonce` set to `r4nd0m` whereas the last one has the incorrect value of `bad`. Imagine the last one was injected by a bad plugin due to an XSS vulnerability. Surprisingly, when loading the page all three scripts are executed, including the bad one! The reason for this is that due to `'strict-dynamic'`, the script containing `wpLoadAfterScripts()` is trusted, and anything that it causes to be executed is then also marked as trusted. Because it is responsible for transforming the `script` containing `badCode()`, then it inherits the trust, resulting in a vulnerability.

How to resolve this? We'll need to manually make sure that the `nonce` value on any `script[data-wp-executes-after]` matches any `nonce` on the `script` that defines `wpLoadAfterScripts()`. If it doesn't match, then the transformation must be aborted with an error. (Caveat, in https://github.com/w3c/webappsec-csp/issues/458 it's proposed that the `nonce` property not be accessible to scripts.)

(In order for the `nonce` attributes to be inserted, this PR would need to incorporate the core helper functions for generating scripts, à la https://github.com/10up/wordpress-develop/pull/58.)

I made a playground where this issue can be experimented with: https://wp-scripts-csp-test.glitch.me/

### Strict CSP Blocked by `unsafe-hashes` Requirement

In Core-32067/Core-39941, the goal was to eliminate all event handler attributes so that CSP could be enabled without the [`'unsafe-hashes'`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/script-src#unsafe_hashes) source expression, again which Google has recommended in [Strict CSP](https://csp.withgoogle.com/docs/strict-csp.html). Nevertheless, the current implementation relies on `onload` event handler attributes on `async` and `defer` scripts in order to determine when they have been evaluated. If you have three deferred scripts on your page with handles `foo`, `bar`, `baz`, you'd need to send the following hashes with each response along with the `'unsafe-hashes'` source expression:

`onload` Attribute | Hash
---------|------
`wpLoadAfterScripts('foo')` | `'sha256-Ee1+yJYa6yp69Bpyc8WzdW/BwXqYX6sN9QdghtWpji0='`
`wpLoadAfterScripts('bar')` | `'sha256-0MPDmtlmqtrR1Si9bhk41jPvVisj3Ny04NPa9vJMp94='`
`wpLoadAfterScripts('baz')` | `'sha256-2dMqbYMnQ/sqpnKP0R3wd5J8Ch7XLbuqL8MThCprFUI='`

This adds to the response payload and it is cumbersome to account for when constructing the CSP. Not only this, but it also can be infeasible to actually send these hashes with the response in the first place since at the time that a `script` is enqueued/printed, the `Content-Security-Policy` header may have already been sent (or `meta` tag printed).

These issues can be mitigated by eliminating the script handle from being passed into `wpLoadAfterScripts()`. Instead, `this` can be passed and the handle can be obtained from the `id` of the script. In that way, `wpLoadAfterScripts()` could be changed as follows:

```diff
- function wpLoadAfterScripts( handle ) {
+ function wpLoadAfterScripts( script ) {
+     var handle = script.id.replace(/-js$/, '');
```

Then every deferred script on the page could include this one `onload` attribute `wpLoadAfterScripts(this)`, and the only hash needing to be sent would be its `'sha256-Onzuq/5md033r0rQOHZyuLqaijp0YWPfo9J1i5b/iio='`.

Nevertheless, ideally we'd eliminate the need for `'unsafe-hashes'` entirely, which would mean getting rid of the `onload` event handler attribute. This turns out to not be so simple. Instead of:

```html
<script id="foo-js" async src="/foo.js" onload="wpLoadAfterScripts(this)"></script>
```

Consider the following code:

```html
<script id="foo-js" async src="/foo.js"></script>
<script>
document.getElementById("foo-js").addEventListener("load", function () {
  wpLoadAfterScripts(this);
});
</script>
```

If you try this, it does seem to work. However, it is not entirely reliable. If there is a network delay when loading the HTML, and the parser pauses after the first `script` is printed, it may load and evaluate `foo.js` before the second script is parsed and evaluated. This would mean that the `load` event would have already fired, and the `addEventListener` call would be too late. I made a demo that shows how this can be consistently reproduced: https://async-script-load-event-listener-test.glitch.me/

I experimented with several ways of listening for the `load` event on deferred scripts: https://async-script-load-listeners.glitch.me/

What I think turns out to be the most robust is to leverage `MutationObserver`. For example, instead of the above code, the following can be employed:

```html
<script>
new MutationObserver((records, observer) => {
  const script = document.getElementById("foo-js");
  if (script) {
    observer.disconnect();
    script.addEventListener("load", function () {
      wpLoadAfterScripts(this);
    });
  }
}).observe(document.currentScript.parentNode, { childList: true });
</script>
<script id="foo-js" async src="/foo.js"></script>
```

Since `MutationObserver` callbacks are run in microtasks when the parser encounters new DOM nodes, we can be assured that our observer will be invoked before the event loop advances to loading the `script[async]`. Indeed, I also found this [works for blocking scripts](https://async-script-load-listeners.glitch.me/blocking-script-mutationobserver-load-listener.html). The observer disconnects as soon as it encounters the <code>script</code>, which prevents the observer from negatively impacting the rest of the page's loading.

This would then allow for the Strict CSP to be applied without adding `'unsafe-hashes'`.

# PR: [Use `addEventListener` to catch script load events instead of `onload` event handler attribute](https://github.com/10up/wordpress-develop/pull/62)

Extends https://github.com/WordPress/wordpress-develop/pull/4391

This fixes the need to use the `'unsafe-hashes'` CSP source expression as [explained in the other PR](https://github.com/WordPress/wordpress-develop/pull/4391#issuecomment-1536869109:~:text=Strict%20CSP%20Blocked%20by%20unsafe%2Dhashes%20Requirement). 

Instead of attaching a `load` event listener to every `script` on the page, it instead adds a single _capturing_ `load` event listener on the `document`. The benefit here is it will reliably catch the loading of `async` scripts, versus other alternatives seen in: https://westonruter.github.io/async-script-load-listeners/

Another benefit of this is we no longer pollute the global namespace with `wpLoadAfterScripts`.

# [Trac Comment](https://core.trac.wordpress.org/ticket/12009#comment:100)

Replying to [azaozz](https://core.trac.wordpress.org/ticket/12009#comment:97):
> I still don't see why (and how) async scripts can be handled through script-loader. As I said earlier, they cannot be used as a dependency and cannot be dependent on other scripts because of the unknown execution order.

In this case, the scripts themselves handle the proper execution order. This is elaborated on in [my PR comment](https://github.com/WordPress/wordpress-develop/pull/4391/files#r1179857620) and you can see an example for how an async library can handle the proper loading order in this glitch: https://async-library-script-loading-demo.glitch.me/

In short, for async scripts, the dependencies are not so much about the execution order but more about a bundling mechanism. If you have an `async` script C that depends on B, and `async` script B depends on `async` script A, then doing `wp_enqueue_script('C')` should automatically also print the scripts for `A` and `B`.


> > In order to maintain execution order for inline scripts attached to `defer` and `async` scripts, we've attempted to control the loading order of those inline scripts by printing them with the type `text/template` so they're not initially executed, and then executing them after the script they're attached to has loaded. @westonruter added [a great explanation](https://github.com/WordPress/wordpress-develop/pull/4391#issuecomment-1536869109) about how this can lead to subtle CSP issues that we need to address.
> 
> Yea, printing inline scripts with `text/template` type seems pretty "hacky" imho. Lets avoid that even if it means that `defer` scripts will not support "after" scripts (`async` scripts shouldn't be in the script-loader at all imho, see above).

I don't think we can avoid `after` scripts entirely, as then an author can't reliably execute some code when the script loads (without resorting to a [somewhat hacky `MutationObserver` solution](https://westonruter.github.io/async-script-load-listeners/)). I'm referring to `defer` scripts specifically, since the order of inline scripts for `async` should not be significant. To me it boils down to two options, to whether for `defer` scripts:

1. We handle the deferred execution of `after` inline scripts using the current approach of `wpLoadAfterScripts()` with its `text/template` transformation.
2. We let the inline scripts handle the deferred execution by attaching their own `load` event listener. For example:

```php
<?php
wp_enqueue_script( 'foo', '/foo.js',array(), array( 'strategy' => 'defer' ) );
wp_add_inline_script( 
  'foo',
  'document.getElementById("foo-js").addEventListener("load", () => { /* ... */ })',
  'after' 
);
```

Which would output:

```html
<script id="foo-js" src="/foo.js" defer></script>
<script>
document.getElementById("foo-js").addEventListener("load", () => { /* ... */ })
</script>
```

The nice thing about the first option is that the deferred execution is automatic. The bad thing is that it forces ''all'' `after` inline script logic to run once the `defer` script is loaded. Perhaps you want some logic to run after but other logic to run before? (Then again, they could just use a `before` inline script for that.)

Nevertheless, note that there is a somewhat brittle connection here between the `after` inline script and the `defer` script: whether there is a `script` element in the page with the expected `id`. If there is an optimization plugin that tries concatenating `defer` scripts together, then any such `load` event handler will fail because the original `script` will be gone. (As such, the use of an `onload` attribute is also brittle.)

In this case, it seems perhaps the safest thing to do is to not wait for the `load` event on the `script[defer]` at all, but rather to just attach a `DOMContentLoaded` event handler to the `document` which runs after all `defer` scripts have been evaluated. (The only gotcha here is the `defer` script may have failed to load.)

> > I'd appreciate feedback on these three options:
> > 
> > 1. WP should not support inline scripts printed after a script that is `async` or `defer`.
> > 2. WP should load non-blocking scripts with a blocking strategy if an inline script is registered with the `after` position.
> > 3. WP should allow inline scripts after non-blocking scripts, but should ensure the inline script is not executed until after the script it is attached to has loaded (i.e., the current approach) and address CSP concerns.
> 
> Thinking 1 makes most sense. Keep in mind that "after" scripts are relatively rarely used. So disallowing them for `defer` scripts would probably not be a problem for the great majority of plugins and themes. 
> 
> Another possibility is to implement the "after" script in the `defer` or `async` script itself. I.e. when the script is being executed it can look for "external" object or function or data and use it when appropriate. That would be the "proper way" imho.

If we require `defer` scripts to rely on the `DOMContentLoaded` event, then options 1 & 2 are essentially the same, as authors should instead use `before` inline scripts. As I mentioned just above, I think option 3 may end up being unreliable due to other plugins munging `script` tags and losing the `id`. If the current approach is reworked to rely on `DOMContentLoaded` instead, then this would be mitigated for option 3.

# Browser fixture site

Static pages for ZLI browser and IPC checks. They are not a product UI.

## Serve

```powershell
node docs/testing/fixtures/browser-site/serve.mjs
```

Default base URL: `http://127.0.0.1:4177/`

Optional port: `node docs/testing/fixtures/browser-site/serve.mjs 8765`

`SLOW_MS` controls the delay for `/assets/slow.js` (default 3000).

A plain static server also works for every page except the delayed slow script.

## URLs

| Path | Purpose |
|---|---|
| `/` or `/index.html` | Index of all pages |
| `/redirect.html` | Immediate redirect to `/redirect-target.html` |
| `/redirect-target.html` | Final URL after redirect (`#redirect-done`) |
| `/form.html` | Text, textarea, radio, checkbox, submit |
| `/form-result.html` | Shows submitted query string |
| `/focus.html` | Tab order targets; shows active element id |
| `/console.html` | Emits `console.log`, `warn`, and `error` on load |
| `/large.html` | Loads `assets/large.png` (~1.5 MB stub) |
| `/assets/large.bin` | 2 MB opaque stub |
| `/slow.html` | Loads delayed `assets/slow.js` when using `serve.mjs` |

## Manual checks against ZLI

1. Start `serve.mjs`, then run `npm run tauri dev`.
2. Open the built-in browser to `http://127.0.0.1:4177/redirect.html` and confirm the surface settles on `redirect-target.html`.
3. Open `/form.html`, fill fields, submit, confirm `/form-result.html` shows the query.
4. Open `/focus.html`, Tab through controls, confirm focus rings and the active id update.
5. Open `/console.html` and confirm console noise appears in the WebView2 or agent tooling you are testing.
6. Open `/large.html` and take a screenshot or snapshot within the documented size budget.
7. Open `/slow.html` with `serve.mjs` and confirm the page waits for the delayed script.

Packaged and live multi-provider runs of these steps are recorded only when executed. See `docs/testing/zli-wp8-evidence.md`.

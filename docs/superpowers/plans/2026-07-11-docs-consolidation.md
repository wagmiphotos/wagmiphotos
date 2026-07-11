# Docs Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the `#/openai` drop-in page into `#/docs` as one short, quickstart-style docs page; retire the `#/openai` view.

**Architecture:** Single-file SPA — everything lives in `projects/worker/public/index.html` (CSS in one `<style>`, views as `.spa-view` divs, hash router in one `<script>`). The merged page keeps the old anchor ids so every cross-page link keeps resolving via `navigateTo()`'s anchor-to-view lookup. New tab component follows the site's pill/chip idiom.

**Tech Stack:** Vanilla HTML/CSS/JS, no build step. Verification via `python3 -m http.server` + Playwright MCP browser tools.

**Spec:** `docs/superpowers/specs/2026-07-11-docs-consolidation-design.md`

## Global Constraints

- One file: `projects/worker/public/index.html`. No new dependencies, no build step.
- Preserve these anchor ids in the merged view: `docs-auth`, `docs-generations`, `docs-matching`, `docs-backfill`, `docs-errors`, `docs-collection-generations`, `docs-health`.
- The merged view keeps `id="view-docs"` (the Copy-button auto-injector targets `#view-docs .docs-pre`).
- Reuse existing CSS vars/classes: `--red`, `--red-tint`, `--red-deep`, `--line`, `--muted`, `--ink`, `--font-display`, `--font-mono`, `.docs-content`, `.docs-pre`, `.docs-table`, `.docs-endpoint`, `.docs-note`, `.compare-grid`, `.dev-cols`.
- API facts must not drift: no `cache_tolerance` / `generate_on_miss` params; `n` must be 1; misses queue demand-ranked backfill; BYOK collection generations always spend; failed generations auto-refund; foreign/unknown ids → 404; key minting & generations rate-limited 10/min.
- Line numbers below are from the current file and drift as you edit — anchor every edit on the quoted markers, not the numbers.

---

### Task 1: Merged docs page (content + tab component)

**Files:**
- Modify: `projects/worker/public/index.html` — (a) CSS after the `.legal-content code, .docs-content code { … }` rule (~line 1943), (b) the entire inner content of `<div id="view-docs" class="spa-view">` (~lines 3055–3301), (c) JS next to the Copy-button injector (before `function copyCode(btn)`, ~line 4102).

**Interfaces:**
- Produces: `.docs-tabs` / `.docs-tabbar` / `.docs-tab` / `.docs-tab-panel` markup + delegated click handler; merged `view-docs` containing all seven preserved anchor ids. Task 2 relies on `view-docs` being self-sufficient (no content references back to `view-openai`).

- [ ] **Step 1: Add tab CSS**

After the closing brace of the `.legal-content code, .docs-content code { … }` rule, insert:

```css

    /* Language tabs on the docs quickstart */
    .docs-tabs { margin: 16px 0 4px; }
    .docs-tabbar { display: flex; gap: 6px; margin-bottom: 10px; }
    .docs-tab {
      border: 1px solid var(--line); background: transparent; color: var(--muted);
      font-family: var(--font-display); font-weight: 700; font-size: 0.75rem;
      padding: 6px 13px; border-radius: 999px; cursor: pointer;
      transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
    }
    .docs-tab:hover { color: var(--ink); }
    .docs-tab.active { color: var(--red-deep); border-color: rgba(237, 20, 30, 0.35); background: var(--red-tint); }
```

- [ ] **Step 2: Add tab JS**

Immediately after the Copy-button injector's closing `});` (the block that starts `document.querySelectorAll('#view-docs .docs-pre').forEach((pre) => {`), insert:

```js

    // Language tabs on the docs quickstart
    document.querySelectorAll('.docs-tabbar').forEach((bar) => {
      bar.addEventListener('click', (e) => {
        const tab = e.target.closest('.docs-tab');
        if (!tab) return;
        bar.querySelectorAll('.docs-tab').forEach((t) => {
          t.classList.toggle('active', t === tab);
          t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
        });
        tab.closest('.docs-tabs').querySelectorAll('.docs-tab-panel').forEach((p) => {
          p.hidden = p.id !== tab.dataset.panel;
        });
      });
    });
```

- [ ] **Step 3: Replace the view-docs content**

Replace everything between `<!-- VIEW: DOCS -->` and the line before `<!-- VIEW: OPENAI DROP-IN -->` with the block below. (The old view-docs div is fully replaced; view-openai is deleted in Task 2, not here.)

```html
    <!-- VIEW: DOCS (quickstart + reference; absorbed the old /openai drop-in page) -->
    <div id="view-docs" class="spa-view">
      <div class="view-pad">
        <div class="page-head">
          <div class="eyebrow"><span class="tick tick-red"></span><span class="tick tick-ink"></span>Developers</div>
          <h1 class="section-title">A drop-in for the OpenAI Images API</h1>
          <p class="section-sub">Keep the official OpenAI SDK. Change one line — the base URL — and every request is answered cache-first, with a <code style="font-family: var(--font-mono); font-size: 0.9em;">shared_cache</code> block riding along in the response.</p>
        </div>

        <div class="glass-card">
          <div class="docs-content">

            <h2>The only change</h2>
            <div class="compare-grid">
              <div class="compare-card was">
                <div class="compare-tag">Before — OpenAI</div>
                <code>base_url = "https://api.openai.com/v1"</code>
              </div>
              <div class="compare-card now">
                <div class="compare-tag">After — wagmi.photos</div>
                <code>base_url = "https://api.wagmi.photos/v1"</code>
              </div>
            </div>
            <p>Swap your key for a wagmi.photos key (<code>sc-…</code>). Method names, the prompt field, and the way you read <code>data[0].url</code> stay exactly the same.</p>

            <h2 id="docs-generations">Call it</h2>
            <div class="docs-endpoint"><span class="method">POST</span> /v1/images/generations</div>
            <div class="docs-tabs">
              <div class="docs-tabbar" role="tablist" aria-label="Language">
                <button class="docs-tab active" role="tab" aria-selected="true" data-panel="docs-tab-python" type="button">Python</button>
                <button class="docs-tab" role="tab" aria-selected="false" data-panel="docs-tab-js" type="button">JavaScript</button>
                <button class="docs-tab" role="tab" aria-selected="false" data-panel="docs-tab-curl" type="button">cURL</button>
              </div>
              <div class="docs-tab-panel" id="docs-tab-python" role="tabpanel">
                <pre class="docs-pre"><span class="tk-flag">from</span> openai <span class="tk-flag">import</span> OpenAI

client = OpenAI(
    base_url=<span class="tk-str">"https://api.wagmi.photos/v1"</span>,
    api_key=<span class="tk-str">"sc-your-key"</span>,
)

img = client.images.generate(
    prompt=<span class="tk-str">"a lighthouse in a storm"</span>,
)

<span class="tk-cmd">print</span>(img.data[<span class="tk-num">0</span>].url)
<span class="tk-flag"># shared_cache always carries the closest match + a similarity score.</span>
<span class="tk-flag"># Scope to a collection with extra_body={"collection": "col_..."}.</span></pre>
              </div>
              <div class="docs-tab-panel" id="docs-tab-js" role="tabpanel" hidden>
                <pre class="docs-pre"><span class="tk-flag">import</span> OpenAI <span class="tk-flag">from</span> <span class="tk-str">"openai"</span>;

<span class="tk-flag">const</span> client = <span class="tk-flag">new</span> OpenAI({
  baseURL: <span class="tk-str">"https://api.wagmi.photos/v1"</span>,
  apiKey: <span class="tk-str">"sc-your-key"</span>,
});

<span class="tk-flag">const</span> img = <span class="tk-flag">await</span> client.images.generate({
  prompt: <span class="tk-str">"a lighthouse in a storm"</span>,
});

console.<span class="tk-cmd">log</span>(img.data[<span class="tk-num">0</span>].url);</pre>
              </div>
              <div class="docs-tab-panel" id="docs-tab-curl" role="tabpanel" hidden>
                <pre class="docs-pre"><span class="tk-cmd">curl</span> <span class="tk-flag">-X POST</span> https://api.wagmi.photos/v1/images/generations <span class="tk-flag">\</span>
  <span class="tk-flag">-H</span> <span class="tk-str">"Authorization: Bearer $WAGMI_KEY"</span> <span class="tk-flag">\</span>
  <span class="tk-flag">-H</span> <span class="tk-str">"Content-Type: application/json"</span> <span class="tk-flag">\</span>
  <span class="tk-flag">-d</span> <span class="tk-str">'{ "prompt": "a lighthouse in a storm" }'</span></pre>
              </div>
            </div>

            <h2>What you get back</h2>
            <pre class="docs-pre">{
  <span class="tk-key">"created"</span>: <span class="tk-num">1783468800</span>,
  <span class="tk-key">"data"</span>: [{ <span class="tk-key">"url"</span>: <span class="tk-str">"https://cdn.wagmi.photos/assets/pd12m-8f31…/image.webp"</span> }],
  <span class="tk-key">"shared_cache"</span>: {
    <span class="tk-key">"result"</span>: <span class="tk-hit">"hit"</span>,
    <span class="tk-key">"similarity"</span>: <span class="tk-num">0.93</span>,
    <span class="tk-key">"cost_saved_usd"</span>: <span class="tk-num">0.055</span>,
    <span class="tk-key">"model_used"</span>: <span class="tk-str">"flux-schnell"</span>,
    <span class="tk-key">"source"</span>: <span class="tk-str">"pd12m"</span>,
    <span class="tk-key">"sizes"</span>: { <span class="tk-key">"thumb"</span>: <span class="tk-str">"…"</span>, <span class="tk-key">"medium"</span>: <span class="tk-str">"…"</span>, <span class="tk-key">"large"</span>: <span class="tk-str">"…"</span> },
    <span class="tk-key">"original_url"</span>: <span class="tk-str">"https://pd12m.s3.us-west-2.amazonaws.com/…"</span>
  }
}</pre>
            <p><code>original_url</code> is the external source image when one exists, and <code>null</code> for generated images. <code>result</code> is one of three values:</p>
            <div class="docs-table-wrap">
              <table class="docs-table">
                <thead>
                  <tr><th>result</th><th>Status</th><th>Meaning</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td>hit</td><td>200</td>
                    <td>At or above the match floor. Served; nothing is queued.</td>
                  </tr>
                  <tr>
                    <td>approximate</td><td>200</td>
                    <td>The best image is below the floor. Served anyway so you have something to show; the prompt is queued and <code>cost_saved_usd</code> is <code>0</code>.</td>
                  </tr>
                  <tr>
                    <td>pending</td><td>202</td>
                    <td><code>data</code> is empty — nothing close exists yet. The prompt is queued; retry the same prompt later and it is a hit for everyone.</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p id="docs-matching" style="font-size:0.875rem;color:var(--muted);">Matching is prompt-to-prompt: BGE cosine similarity against a fixed server-side floor (≈0.85). There is no <code>cache_tolerance</code> or <code>generate_on_miss</code> — threshold on <code>similarity</code> client-side. See <a href="#/matching" style="color: var(--red);">how semantic matching works</a>.</p>
            <p id="docs-backfill" style="font-size:0.875rem;color:var(--muted);">Every miss records demand: the most-requested prompts are built by the shared backfill and become hits for everyone. <code>shared_cache.generation_queued</code> tells you whether yours is in that queue.</p>

            <h2>What stays the same, what you gain</h2>
            <div class="dev-cols">
              <div class="dev-list">
                <h4>Unchanged</h4>
                <ul>
                  <li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>The official OpenAI SDKs and method names</li>
                  <li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>The <code>prompt</code> field and request flow</li>
                  <li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Reading the image from <code>data[0].url</code></li>
                </ul>
              </div>
              <div class="dev-list">
                <h4>Added by wagmi.photos</h4>
                <ul>
                  <li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>A <code>shared_cache</code> block: result, similarity, cost saved</li>
                  <li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>~0.1&nbsp;s cache hits at $0 per image</li>
                  <li><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>Always the closest match, with a <code>similarity</code> score to threshold client-side</li>
                </ul>
              </div>
            </div>

            <h2>Request fields</h2>
            <div class="docs-table-wrap">
              <table class="docs-table">
                <thead>
                  <tr><th>Field</th><th>Type</th><th>Default</th><th>Description</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td>prompt</td><td>string</td><td>required</td>
                    <td>What you want. Prompts are normalized (trimmed, lowercased, whitespace collapsed) before matching and queueing.</td>
                  </tr>
                  <tr>
                    <td>collection</td><td>string</td><td>—</td>
                    <td>Scope matching to one collection by ID (<code>col_…</code>) — official SDKs pass it via <code>extra_body</code>. The collection's theme prompt is appended before matching, and scoped requests never queue background generation; to generate with your own key, see <a href="#docs-collection-generations" style="color: var(--red);">below</a>.</td>
                  </tr>
                  <tr>
                    <td>n</td><td>integer</td><td>1</td>
                    <td>Only <code>1</code> is supported; anything else returns <code>422</code>.</td>
                  </tr>
                  <tr>
                    <td>size</td><td>string</td><td>—</td>
                    <td>Accepted for OpenAI compatibility; every response already includes <code>thumb</code>, <code>medium</code> and <code>large</code> URLs.</td>
                  </tr>
                  <tr>
                    <td>model</td><td>string</td><td>—</td>
                    <td>Accepted for OpenAI compatibility; <code>shared_cache.model_used</code> reports the model that created the served image.</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h2 id="docs-collection-generations">Create images in your collections</h2>
            <p>
              The one path that always spends: generate your exact prompt now, with your own
              provider key, straight into a collection you own (set up on the
              <a href="#/library" style="color: var(--red);">Collections tab</a>). It starts a
              background job and hands back a ticket.
            </p>
            <div class="docs-endpoint"><span class="method">POST</span> /v1/collections/:id/generations</div>
            <div class="docs-endpoint"><span class="method">GET</span> /v1/generations/:id</div>
            <pre class="docs-pre"><span class="tk-flag"># Start a generation (requires your own provider key + a collection you own)</span>
<span class="tk-cmd">curl</span> <span class="tk-flag">-X POST</span> https://api.wagmi.photos/v1/collections/col_abc123/generations <span class="tk-flag">\</span>
  <span class="tk-flag">-H</span> <span class="tk-str">"Authorization: Bearer sc-..."</span> <span class="tk-flag">-H</span> <span class="tk-str">"Content-Type: application/json"</span> <span class="tk-flag">\</span>
  <span class="tk-flag">-d</span> <span class="tk-str">'{"prompt": "a watercolor fox in morning fog"}'</span>
<span class="tk-flag"># -&gt; 202 {"generation": {"id": "gen_...", "status": "generating", ...}, "byok": {"used": 3, "cap": 50, ...}}</span>

<span class="tk-flag"># Poll the ticket until it leaves queued/generating</span>
<span class="tk-cmd">curl</span> https://api.wagmi.photos/v1/generations/gen_... <span class="tk-flag">-H</span> <span class="tk-str">"Authorization: Bearer sc-..."</span>
<span class="tk-flag"># -&gt; {"generation": {"status": "succeeded", "image": {"url": "...", "thumb_url": "..."}}}</span></pre>
            <ul>
              <li>A ticket moves <code>queued</code> → <code>generating</code> → <code>succeeded</code> or <code>failed</code>; poll while it is in the first two.</li>
              <li><code>failed</code> is auto-refunded — it never counts toward your monthly cap.</li>
              <li>A collection you don't own, or an unknown generation id, returns <code>404</code>.</li>
            </ul>

            <h2 id="docs-auth">Auth &amp; keys</h2>
            <p>
              <a href="#/login" style="color: var(--red);">Log in</a> with a magic link (no
              password), create a key on the
              <a href="#/account" style="color: var(--red);">Account</a> page, and send it as
              <code>Authorization: Bearer sc-your-key</code>. Keys are hashed before storage and
              shown once — store them yourself. Minting is rate-limited (10 per minute per IP).
            </p>
            <p>Prefer the API? <code>POST /v1/keys/generate</code> also works with a logged-in session cookie — unauthenticated calls return <code>401</code>.</p>

            <h2 id="docs-errors">Errors</h2>
            <div class="docs-table-wrap">
              <table class="docs-table">
                <thead>
                  <tr><th>Status</th><th>When</th></tr>
                </thead>
                <tbody>
                  <tr><td>400</td><td>Body is not valid JSON, or not a JSON object.</td></tr>
                  <tr><td>401</td><td>Missing or invalid API key.</td></tr>
                  <tr><td>422</td><td><code>n</code> is anything but 1, <code>prompt</code> is missing/empty/too long, or <code>collection</code> is not a non-empty string.</td></tr>
                  <tr><td>429</td><td>Rate limit exceeded — generations (per account) and key minting (per IP) are each 10 per minute.</td></tr>
                  <tr><td>502</td><td>An upstream dependency failed; the body includes a <code>detail</code> string.</td></tr>
                </tbody>
              </table>
            </div>

            <h2 id="docs-health">Health</h2>
            <div class="docs-endpoint"><span class="method">GET</span> /healthz</div>
            <p>Returns <code>{"status":"ok"}</code>. No authentication.</p>

          </div>
        </div>
      </div>
    </div>

```

- [ ] **Step 4: Verify in browser**

```bash
cd projects/worker/public && python3 -m http.server 8777 &
```

With Playwright MCP (bust cache with a fresh `?v=` each reload):
1. Navigate `http://localhost:8777/index.html?v=t1#/docs` — page shows "A drop-in for the OpenAI Images API", compare cards, tabbar.
2. Click "JavaScript" tab → JS snippet visible, Python hidden. Click "cURL" → curl visible.
3. Every `.docs-pre` has a Copy button (auto-injector) — click one, expect "Copied".
4. `browser_evaluate`: `['docs-auth','docs-generations','docs-matching','docs-backfill','docs-errors','docs-collection-generations','docs-health'].every(id => !!document.getElementById(id))` → `true`.
5. No new console errors (the two pre-existing offline `/v1/*` fetch errors are expected).

- [ ] **Step 5: Commit**

```bash
git add projects/worker/public/index.html
git commit -m "feat(docs): merge OpenAI drop-in quickstart into #/docs — tabbed examples, cut-hard reference"
```

---

### Task 2: Retire #/openai (nav, footer, router, delete view)

**Files:**
- Modify: `projects/worker/public/index.html` — nav Developers column (~line 2277), footer Developers column (~line 3714), `ROUTES` map (~line 3869), `PATH_TO_HASH` map (~line 3883), delete the `view-openai` div (between `<!-- VIEW: OPENAI DROP-IN -->` and `<!-- VIEW: SEMANTIC MATCHING -->`).

**Interfaces:**
- Consumes: merged `view-docs` from Task 1 (self-sufficient).
- Produces: `#/openai` and `/openai` resolve to the docs view; no `view-openai` / `nav-openai` references remain anywhere in the file.

- [ ] **Step 1: Nav — one Docs entry**

Replace the two anchors `<a href="#/docs" id="nav-docs" …>…</a>` and `<a href="#/openai" id="nav-openai" …>…</a>` (keeping the first one's code-brackets icon) with:

```html
                <a href="#/docs" id="nav-docs" class="nav-drop-item">
                  <span class="nav-drop-ic"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg></span>
                  <span><span class="nav-drop-title">Docs</span><span class="nav-drop-sub">Swap the base URL — that's the API.</span></span>
                </a>
```

- [ ] **Step 2: Footer — one Docs link**

Replace:

```html
            <li><a href="#/docs">API reference</a></li>
            <li><a href="#/openai">OpenAI drop-in</a></li>
```

with:

```html
            <li><a href="#/docs">Docs</a></li>
```

- [ ] **Step 3: Router**

In `ROUTES`, replace

```js
      '#/openai':     { view: 'view-openai', link: 'nav-openai' },
```

with

```js
      '#/openai':     { view: 'view-docs', link: 'nav-docs' },
```

In `PATH_TO_HASH`, change `'/openai': '#/openai'` to `'/openai': '#/docs'`.

- [ ] **Step 4: Delete the view-openai div**

Delete everything from `<!-- VIEW: OPENAI DROP-IN -->` up to (not including) `<!-- VIEW: SEMANTIC MATCHING -->`.

- [ ] **Step 5: Leftover sweep**

```bash
grep -n "view-openai\|nav-openai\|OpenAI drop-in" projects/worker/public/index.html
```

Expected: no matches. Also `grep -rn "'/openai'\|#/openai" projects/worker/public/` should only show the `ROUTES`/`PATH_TO_HASH` alias lines.

- [ ] **Step 6: Verify in browser**

1. `http://localhost:8777/index.html?v=t2#/openai` → merged docs page renders (title "A drop-in for the OpenAI Images API").
2. Explore dropdown → Developers column shows exactly: Docs, Semantic matching, Agents.
3. Footer Developers column shows Docs / Semantic matching / Agents.
4. From `#/matching`, click the "matching details" link (`#docs-matching`) → lands on docs view scrolled to the matching one-liner.
5. From `#/agents`, the "API docs" link (`#/docs`) works.

- [ ] **Step 7: Commit**

```bash
git add projects/worker/public/index.html
git commit -m "feat(docs): retire #/openai — one Docs nav entry, route + path alias to #/docs"
```

---

### Task 3: Responsive + regression sweep

**Files:**
- Modify (only if fixes needed): `projects/worker/public/index.html`

**Interfaces:**
- Consumes: finished page from Tasks 1–2.

- [ ] **Step 1: Viewport sweep**

At 360×800, 520×900, 1280×900 on `#/docs`: no horizontal overflow (`document.documentElement.scrollWidth <= clientWidth`), tables scroll inside `.docs-table-wrap`, tabbar wraps or fits, compare cards stack at narrow widths.

- [ ] **Step 2: Behavior sweep**

- Tabs still switch after navigating away (`#/`) and back (`#/docs`).
- Copy button on the visible tab copies that tab's code (check clipboard text starts with `from openai` / `import OpenAI` / `curl`).
- Console: no errors beyond the two pre-existing offline `/v1/*` fetches.

- [ ] **Step 3: Fix anything found, re-verify, commit**

```bash
git add projects/worker/public/index.html
git commit -m "fix(docs): responsive/regression fixes from merge sweep"
```

(Skip the commit if nothing needed fixing.)

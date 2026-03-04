
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// 開発時のみ SSL 検証無効（本番では絶対消す）
if (process.env.NODE_ENV !== 'production') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

app.use(express.static(join(__dirname, 'public')));
// JSON / text body handling for API proxy passthrough (必要に応じて拡張)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

/* ヘルパー: static と判定するか（サーバ側判定） */
function isStaticPathname(pathname) {
  if (!pathname) return false;
  const lower = pathname.toLowerCase();
  if (/\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|woff2?|ttf|eot|otf|mp4|webm|ogg|mp3|wav|pdf|json|map)$/i.test(lower)) return true;
  if (lower.includes('videoplayback')) return true;
  if (lower.includes('youtubei') || lower.includes('/player') || lower.includes('/api/stats') || lower.includes('/manifest')) return true;
  return false;
}

/* ---------- STATIC proxy: /static/<encoded-url> ---------- */
/* 画像・JS・CSS等はここに流す。createProxyMiddleware を per-request で呼ぶ方式にする */
app.use('/static/*', (req, res, next) => {
  try {
    // req.path から /static/ を外してデコード
    const encoded = req.path.replace(/^\/static\//, '');
    const decoded = decodeURIComponent(encoded || '');

    if (!decoded) return res.status(400).send('Bad static URL');

    const targetUrl = new URL(decoded);
    // 動的にミドルウェアを生成して即実行
    return createProxyMiddleware({
      target: targetUrl.origin,
      changeOrigin: true,
      selfHandleResponse: false,
      ws: true,
      logLevel: 'warn',
      pathRewrite: () => (targetUrl.pathname || '/') + (targetUrl.search || ''),
      onProxyReq(proxyReq) {
        // 必要なヘッダを付与
        proxyReq.setHeader('User-Agent', req.headers['user-agent'] || 'Mozilla/5.0');
        proxyReq.setHeader('Referer', targetUrl.origin);
        proxyReq.setHeader('Origin', targetUrl.origin);
        // 既存クッキーを送る（注意：プライバシー）
        if (req.headers.cookie) proxyReq.setHeader('Cookie', req.headers.cookie);
      },
      onProxyRes(proxyRes) {
        // セキュリティ系ヘッダを緩めてクライアントで動くようにする
        proxyRes.headers['access-control-allow-origin'] = '*';
        delete proxyRes.headers['content-security-policy'];
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['cross-origin-opener-policy'];
        delete proxyRes.headers['cross-origin-embedder-policy'];
        delete proxyRes.headers['cross-origin-resource-policy'];
        delete proxyRes.headers['origin-agent-cluster'];
      },
      onError(err, req, res) {
        console.error('static proxy error:', err && err.message);
        res.status(502).send('Static proxy failed');
      }
    })(req, res, next);
  } catch (e) {
    console.error('static proxy ex:', e);
    res.status(500).send('Static proxy error');
  }
});

/* ---------- API proxy: /api/<encoded-url> ---------- */
/* fetch/XHR のリクエストをそのままターゲットへ中継する（ヘッダ/メソッド/ボディを保つ） */
app.use('/api/*', async (req, res) => {
  try {
    const encoded = req.path.replace(/^\/api\//, '');
    const target = decodeURIComponent(encoded || '');
    if (!target) return res.status(400).send('Bad api url');

    const urlObj = new URL(target);

    // ヘッダをクリーンにコピー（Hostは上書き）
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (['host', 'content-length'].includes(lk)) continue;
      headers[k] = v;
    }
    headers['Referer'] = urlObj.origin;
    headers['Origin'] = urlObj.origin;

    const agent = new https.Agent({ rejectUnauthorized: process.env.NODE_ENV === 'production' });

    // node-fetch は req のストリームを body に渡せる
    const fetchRes = await fetch(target, {
      method: req.method,
      headers,
      redirect: 'manual',
      agent,
      // GET/HEAD は body を送らない
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
    });

    // ステータスとヘッダをそのまま返す（不要なヘッダは削る）
    fetchRes.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (['content-encoding', 'transfer-encoding'].includes(lower)) return;
      // 緩和
      if (lower === 'content-security-policy' || lower === 'x-frame-options' ||
          lower.startsWith('cross-origin') || lower === 'origin-agent-cluster') {
        // skip - remove to avoid breaking proxied apps
        return;
      }
      res.setHeader(key, value);
    });
    res.setHeader('access-control-allow-origin', '*');

    res.status(fetchRes.status);
    // stream back
    const body = fetchRes.body;
    if (body && typeof body.pipe === 'function') {
      body.pipe(res);
    } else {
      const buf = await fetchRes.buffer();
      res.send(buf);
    }
  } catch (err) {
    console.error('API proxy error:', err && err.message);
    res.status(502).send('API proxy failed');
  }
});

/* ---------- HTML proxy: /proxy/<encoded-url> ---------- */
/* HTML を取得して書き換える。静的リソースは /static/ に、リンク/フォームは /proxy/ に書き換える */
app.use('/proxy/*', async (req, res) => {
  try {
    const encoded = req.path.replace(/^\/proxy\//, '');
    const targetBaseRaw = decodeURIComponent(encoded || '');
    if (!targetBaseRaw) return res.status(400).send('Bad proxy url');

    let targetBase = targetBaseRaw;
    if (!targetBase.startsWith('http')) targetBase = 'https://' + targetBase;

    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const fullTarget = targetBase + query;

    const agent = new https.Agent({ rejectUnauthorized: process.env.NODE_ENV === 'production' });

    // fetch target HTML
    const response = await fetch(fullTarget, {
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': req.headers['accept-language'] || 'ja,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': targetBase,
        'Origin': targetBase,
        'Cookie': req.headers.cookie || ''
      },
      redirect: 'manual',
      agent,
    });

    // リダイレクトをプロキシ経由に変換して返す
    const location = response.headers.get('location');
    if (location) {
      let resolvedLoc = location;
      if (!resolvedLoc.startsWith('http')) {
        resolvedLoc = new URL(location, targetBase).href;
      }
      return res.redirect(302, `/proxy/${encodeURIComponent(resolvedLoc)}`);
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    // HTML 以外は /static 経由で返す（安全弁）
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      // 直接バイナリ返却（例: pdf等） - もしくはクライアントは /static 経由を使うべき
      response.headers.forEach((val, key) => {
        if (!['content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
          res.setHeader(key, val);
        }
      });
      res.setHeader('access-control-allow-origin', '*');
      res.status(response.status);
      const b = await response.buffer();
      return res.send(b);
    }

    // HTML を取得して cheerio で書き換える
    const body = await response.text();
    const $ = cheerio.load(body, { decodeEntities: false, xmlMode: false });

    // 属性リスト: 静的は /static/ に向ける、リンク系は /proxy/
    const staticAttrs = [
      { selector: 'img, source, video, audio, iframe, embed', attr: 'src' },
      { selector: 'img, source', attr: 'srcset' },
      { selector: 'img', attr: 'data-src' },
      { selector: 'img', attr: 'data-lazy-src' },
      { selector: 'img', attr: 'data-original' },
      { selector: '[data-bg], [data-background-image]', attr: 'data-bg' },
      { selector: '[data-background]', attr: 'data-background' },
      { selector: 'link[rel="stylesheet"], link[rel="icon"], link[rel="apple-touch-icon"]', attr: 'href' },
      { selector: 'script', attr: 'src' },
      { selector: '[poster]', attr: 'poster' },
      { selector: '[background]', attr: 'background' },
    ];

    const linkAttrs = [
      { selector: 'a, area', attr: 'href' },
      { selector: 'form', attr: 'action' },
    ];

    // 静的属性の書き換え（絶対化→/static/encode）
    staticAttrs.forEach(({ selector, attr }) => {
      $(selector).each((i, el) => {
        let value = $(el).attr(attr);
        if (!value) return;
        value = String(value).trim();
        if (!value) return;
        if (value.startsWith('#')) return;
        if (/^(data:|blob:|javascript:|about:)/i.test(value)) return;

        try {
          const resolved = new URL(value, fullTarget).href;
          // 静的ファイルは /static/ に流す
          const proxied = `/static/${encodeURIComponent(resolved)}`;
          $(el).attr(attr, proxied);
          // console.log(`[STATIC] ${attr} ${value} -> ${proxied}`);
        } catch (e) {
          // ignore
        }
      });
    });

    // srcset 個別処理（各 URL を /static/ に）
    $('[srcset]').each((i, el) => {
      let srcset = $(el).attr('srcset') || '';
      const parts = srcset.split(',').map(part => {
        const trimmed = part.trim();
        const [urlPart, ...desc] = trimmed.split(/\s+/);
        try {
          const abs = new URL(urlPart, fullTarget).href;
          return `/static/${encodeURIComponent(abs)}${desc.length ? ' ' + desc.join(' ') : ''}`;
        } catch {
          return trimmed;
        }
      });
      $(el).attr('srcset', parts.join(', '));
    });

    // CSS 内の url() を /static/ に差し替え
    const rewriteCssUrls = (css) => {
      return css.replace(/url\((?!['"]?data:)(['"]?)([^'")]+)\1\)/gi, (match, quote, urlPart) => {
        const trimmed = urlPart.trim();
        try {
          const abs = new URL(trimmed, fullTarget).href;
          return `url(/static/${encodeURIComponent(abs)})`;
        } catch {
          return match;
        }
      });
    };

    $('[style]').each((i, el) => {
      let style = $(el).attr('style') || '';
      $(el).attr('style', rewriteCssUrls(style));
    });
    $('style').each((i, el) => {
      let css = $(el).html() || '';
      $(el).html(rewriteCssUrls(css));
    });

    // リンク系（a, area, form）は /proxy/ に書き換える
    linkAttrs.forEach(({ selector, attr }) => {
      $(selector).each((i, el) => {
        let value = $(el).attr(attr);
        if (!value) return;
        value = String(value).trim();
        if (!value) return;
        if (value.startsWith('#')) return;
        if (/^(data:|blob:|javascript:|about:)/i.test(value)) return;

        try {
          const resolved = new URL(value, fullTarget).href;
          const proxied = `/proxy/${encodeURIComponent(resolved)}`;
          $(el).attr(attr, proxied);
          if (selector === 'a, area') {
            $(el).removeAttr('target'); // target=_blank を削除しておく
          }
        } catch (e) {
          // ignore
        }
      });
    });

    // base タグは削除しておく（混乱防止）
    $('base').remove();

    // クライアント側の hook を注入（fetch/XHR/window.open を /api/ と /static/ に振り分ける）
    $('head').prepend(`
<script>
(function(){
  // URL を絶対化して種類に応じて /static/ or /api/ or /proxy/ にする
  function classifyAndProxy(url) {
    if (!url) return url;
    if (url.startsWith('#')) return url;
    if (/^(javascript:|data:|blob:|about:)/i.test(url)) return url;
    try {
      var abs = new URL(url, location.href).href;
      // 静的リソース判定（拡張子 or YouTube/動画系）
      if (/\\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|woff2?|ttf|eot|otf|mp4|webm|ogg|mp3|wav|pdf|json|map)(\\?.*)?$/i.test(abs)
          || abs.includes('youtubei') || abs.includes('/player') || abs.includes('/api/stats') || abs.includes('videoplayback') || abs.includes('manifest')) {
        return '/static/' + encodeURIComponent(abs);
      }
      // fetch/XHR は /api/ 経由にする（client-side hook が使われると有利）
      // ただし <a> や form の遷移は /proxy/
      return '/proxy/' + encodeURIComponent(abs);
    } catch (e) {
      return url;
    }
  }

  // リンク・フォームを修正（HTML遷移）
  function fixLinksAndForms(root) {
    (root || document).querySelectorAll('a[href], area[href]').forEach(function(el){
      var href = el.getAttribute('href') || '';
      if (!href) return;
      if (href.startsWith('/static/') || href.startsWith('/proxy/') || href.startsWith('#')) return;
      try {
        var prox = classifyAndProxy(href);
        if (prox) el.setAttribute('href', prox);
        el.removeAttribute('target');
      } catch(e){}
    });
    (root || document).querySelectorAll('form[action]').forEach(function(f){
      var action = f.getAttribute('action') || '';
      try {
        var prox = classifyAndProxy(action || location.href);
        if (prox) f.setAttribute('action', prox);
      } catch(e){}
    });
  }

  // fetch を横取りして /api/ 経由にする（URL が外部なら）
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      var url = (typeof input === 'string') ? input : (input && input.url);
      if (url && !url.startsWith(location.origin)) {
        // classify: 静的は /static/、API系は /api/ に振る
        var abs = new URL(url, location.href).href;
        var prox;
        if (/\\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|woff2?|ttf|eot|otf|mp4|webm|ogg|mp3|wav|pdf|json|map)(\\?.*)?$/i.test(abs)
            || abs.includes('youtubei') || abs.includes('/player') || abs.includes('/api/stats') || abs.includes('videoplayback') || abs.includes('manifest')) {
          prox = '/static/' + encodeURIComponent(abs);
        } else {
          prox = '/api/' + encodeURIComponent(abs);
        }
        if (typeof input === 'string') input = prox;
        else if (input instanceof Request) input = new Request(prox, input);
        else if (typeof input === 'object' && input.url) input = Object.assign({}, input, { url: prox });
      }
    } catch (e) {}
    return origFetch.call(this, input, init);
  };

  // XHR の open を横取りして /api/ に向ける
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    try {
      if (typeof url === 'string' && !url.startsWith(location.origin)) {
        var abs = new URL(url, location.href).href;
        var prox = '/api/' + encodeURIComponent(abs);
        return origOpen.apply(this, [method, prox, ...Array.prototype.slice.call(arguments, 2)]);
      }
    } catch (e){}
    return origOpen.apply(this, arguments);
  };

  // window.open を /proxy/ に変換（ポップアップ遷移）
  var origWindowOpen = window.open;
  window.open = function(url, ...args) {
    try {
      if (typeof url === 'string' && !url.startsWith(location.origin)) {
        var prox = '/proxy/' + encodeURIComponent(new URL(url, location.href).href);
        return origWindowOpen.call(window, prox, ...args);
      }
    } catch (e){}
    return origWindowOpen.call(window, url, ...args);
  };

  // DOM 変化監視して動的に追加された要素も修正
  var mo = new MutationObserver(function(muts){
    muts.forEach(function(m){
      m.addedNodes && m.addedNodes.forEach(function(n){
        if (n.nodeType === 1) fixLinksAndForms(n);
      });
    });
  });
  mo.observe(document, { childList:true, subtree:true });
  try{ fixLinksAndForms(document);} catch(e){}
})();
</script>
    `);

    const outHtml = $.html();

    // レスポンスヘッダは最小限で返す
    const headersOut = {};
    response.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(lowerKey)) {
        // 削除したい CSP / COOP 等は省く
        if (['content-security-policy', 'x-frame-options', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'origin-agent-cluster'].includes(lowerKey)) {
          return;
        }
        headersOut[key] = value;
      }
    });
    headersOut['access-control-allow-origin'] = '*';

    res.set(headersOut);
    res.status(response.status).send(outHtml);

  } catch (err) {
    console.error('HTML proxy error:', err && err.message);
    res.status(500).send('<h1>プロキシエラー</h1><pre>' + (err && err.message) + '</pre><p><a href="/">トップに戻る</a></p>');
  }
});

/* ブラウザがプロキシ経由でないパスに直接来た場合、Referer が /proxy/ なら元に戻す */
app.use((req, res, next) => {
  if (!req.originalUrl.startsWith('/proxy/') && req.originalUrl !== '/') {
    const referer = req.headers.referer;
    if (referer && referer.includes('/proxy/')) {
      const baseMatch = referer.match(/\/proxy\/([^/]+)/);
      if (baseMatch) {
        const base = decodeURIComponent(baseMatch[1]);
        try {
          const newUrl = new URL(req.originalUrl, base).href;
          return res.redirect(`/proxy/${encodeURIComponent(newUrl)}`);
        } catch (e) {
          // ignore
        }
      }
    }
  }
  next();
});

/* 404 ハンドラ */
app.use((req, res) => {
  res.status(404).send(`
    <h1>404 - パスが見つかりません</h1>
    <p>アクセスされたパス: <strong>${req.originalUrl}</strong></p>
    <p>書き換え漏れの可能性が高い。Render/ログで "Rewrote" を確認して。</p>
    <a href="/">トップページに戻る</a>
  `);
});

app.listen(PORT, () => {
  console.log('Proxy server running on port', PORT);
});

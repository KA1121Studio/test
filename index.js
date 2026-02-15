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

// Render環境でのSSL証明書検証エラー回避（テスト・デバッグ用。本番では慎重に）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

app.use(express.static(join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// プロキシのメインエンドポイント: /proxy/<encoded-url>/*
app.use('/proxy/:targetUrl*', async (req, res, next) => {
  try {
    let targetBase = decodeURIComponent(req.params.targetUrl);
    if (!targetBase.startsWith('http')) {
      targetBase = 'https://' + targetBase;
    }

    const subPath = req.params[0] || '';
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const fullTarget = targetBase + (subPath.startsWith('/') ? '' : '/') + subPath + query;

    // 静的リソース判定
    const isStatic = /\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|woff2?|ttf|eot|otf|mp4|webm|ogg|mp3|wav|pdf|json|map)$/i.test(subPath)
      || req.headers.accept?.includes('image/')
      || req.headers.accept?.includes('font/')
      || req.headers.accept?.includes('application/javascript')
      || req.headers.accept?.includes('text/css');

    if (isStatic) {
      const rewriteFrom = new RegExp(`^/proxy/${encodeURIComponent(targetBase)}/?`);
      return createProxyMiddleware({
        target: targetBase,
        changeOrigin: true,
        pathRewrite: (path) => path.replace(rewriteFrom, ''),
        selfHandleResponse: false,
        onProxyReq(proxyReq) {
          proxyReq.setHeader('User-Agent', req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
          proxyReq.setHeader('Referer', targetBase);
          proxyReq.setHeader('Origin', targetBase);
          proxyReq.setHeader('Accept', req.headers['accept'] || '*/*');
        },
        onProxyRes(proxyRes) {
          proxyRes.headers['access-control-allow-origin'] = '*';
          proxyRes.headers['access-control-allow-methods'] = 'GET, HEAD, OPTIONS';
          delete proxyRes.headers['content-security-policy'];
          delete proxyRes.headers['x-frame-options'];
          delete proxyRes.headers['x-content-type-options'];
        },
        onError(err, req, res) {
          console.error('Static proxy error:', err.message);
          res.status(502).send(`Failed to load static resource: ${err.message}`);
        }
      })(req, res, next);
    }

    // HTML系はfetch + 書き換え
    const agent = new https.Agent({ rejectUnauthorized: false });
    const response = await fetch(fullTarget, {
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': req.headers['accept-language'] || 'ja,en;q=0.9',
        'Referer': targetBase,
      },
      redirect: 'manual',
      agent,
    });

    // リダイレクト対応
    if (response.redirected && response.headers.get('location')) {
      let location = response.headers.get('location');
      if (!location.startsWith('http')) {
        location = new URL(location, targetBase).href;
      }
      return res.redirect(302, `/proxy/${encodeURIComponent(location)}`);
    }

    let body = await response.text();
    const contentType = response.headers.get('content-type')?.toLowerCase() || '';

    // HTML系のみ書き換え処理
if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
  const $ = cheerio.load(body, { 
    decodeEntities: false,
    xmlMode: false
  });

  // 静的リソース属性（img, link[rel=stylesheet]など） → 今まで通り
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

  // ナビゲーション・フォーム系（a, form, area） → 特に強く書き換え
  const linkAttrs = [
    { selector: 'a, area', attr: 'href' },
    { selector: 'form', attr: 'action' },
  ];

  // 静的属性の書き換え（変更なし）
  staticAttrs.forEach(({ selector, attr }) => {
    $(selector).each((i, el) => {
      let value = $(el).attr(attr)?.trim();
      if (!value) return;
      if (/^(data:|blob:|javascript:|#|about:)/i.test(value)) return;
      if (value.startsWith('#')) return;


      try {
        const resolved = new URL(value, fullTarget).href;

        const proxiedUrl = `/proxy/${encodeURIComponent(resolved)}`;
        $(el).attr(attr, proxiedUrl);
        console.log(`[STATIC] Rewrote <${selector}> ${attr}: "${value}" → "${proxiedUrl}"`);
      } catch (e) {
        console.warn(`[STATIC] Failed: "${value}"`);
      }
    });
  });

linkAttrs.forEach(({ selector, attr }) => {
  $(selector).each((i, el) => {
    let value = $(el).attr(attr)?.trim();
    if (!value) return;

    if (value.startsWith('#')) return;
    if (/^(data:|blob:|javascript:|about:)/i.test(value)) return;

    try {
      // ★ ここ重要
      const resolved = new URL(value, fullTarget).href;

      // ★ 絶対に常に /proxy/ 付きにする
      const proxiedUrl = `/proxy/${encodeURIComponent(resolved)}`;

      $(el).attr(attr, proxiedUrl);

    } catch (e) {
      console.warn("Rewrite failed:", value);
    }
  });
});


  // srcset, style, base削除 は変更なし（そのままコピーしてOK）

  // ... (srcset処理, rewriteCssUrls, $('base').remove(); などは元のまま)



      // srcset 処理（変更なし）
      $('[srcset]').each((i, el) => {
        let srcset = $(el).attr('srcset') || '';
        const parts = srcset.split(',').map(part => {
          const trimmed = part.trim();
          const [urlPart, ...desc] = trimmed.split(/\s+/);
          try {
            const abs = new URL(urlPart, targetBase).href;
            return `/proxy/${encodeURIComponent(abs)}${desc.length ? ' ' + desc.join(' ') : ''}`;
          } catch {
            return trimmed;
          }
        });
        $(el).attr('srcset', parts.join(', '));
      });

      // CSS url() 処理（変更なし）
      const rewriteCssUrls = (css) => {
        return css.replace(/url\(['"]?([^'")]+)['"]?\)/gi, (match, urlPart) => {
          const trimmedUrl = urlPart.trim();
          if (/^(data:|#|\/)/i.test(trimmedUrl)) return match;
          try {
            const abs = new URL(trimmedUrl, targetBase).href;
            return `url(/proxy/${encodeURIComponent(abs)})`;
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

$('base').remove();

// ★ ここに追加
$('head').prepend(`
<script>
(function() {

  function toProxy(url) {
    if (!url) return url;
    if (url.startsWith('/proxy/')) return url;
    if (url.startsWith('#')) return url;
    if (/^(data:|blob:|javascript:|about:)/i.test(url)) return url;
    try {
      const resolved = new URL(url, location.href).href;
      return '/proxy/' + encodeURIComponent(resolved);
    } catch(e) {
      return url;
    }
  }

  // 🔥 すべてのリンククリックを横取り
  document.addEventListener('click', function(e) {
    const a = e.target.closest('a');
    if (!a) return;

    const href = a.getAttribute('href');
    if (!href) return;

    const proxied = toProxy(href);

    if (proxied !== href) {
      e.preventDefault();
      window.location.href = proxied;
    }
  }, true);

  // 🔥 window.open 完全フック
  const originalOpen = window.open;
  window.open = function(url, ...args) {
    return originalOpen.call(this, toProxy(url), ...args);
  };

  // 🔥 location 書き換え完全対応
  const originalAssign = window.location.assign;
  window.location.assign = function(url) {
    return originalAssign.call(this, toProxy(url));
  };

  const originalReplace = window.location.replace;
  window.location.replace = function(url) {
    return originalReplace.call(this, toProxy(url));
  };

})();
</script>
`);

body = $.html();

    }

    const headers = {};
    response.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (!['content-length', 'content-encoding', 'transfer-encoding'].includes(lowerKey)) {
        headers[key] = value;
      }
    });
    headers['access-control-allow-origin'] = '*';

    res.set(headers);
    res.status(response.status).send(body);

  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).send(`
      <h1>プロキシエラー</h1>
      <pre>${err.message}</pre>
      <p><a href="/">トップに戻る</a></p>
    `);
  }
});

app.use((req, res, next) => {
  if (!req.originalUrl.startsWith('/proxy/') && req.originalUrl !== '/') {
    const referer = req.headers.referer;
    if (referer && referer.includes('/proxy/')) {
      const baseMatch = referer.match(/\/proxy\/([^/]+)/);
      if (baseMatch) {
        const base = decodeURIComponent(baseMatch[1]);
        const newUrl = new URL(req.originalUrl, base).href;
        return res.redirect(`/proxy/${encodeURIComponent(newUrl)}`);
      }
    }
  }
  next();
});


// 404ハンドラ（デバッグ用：トップに戻さず詳細表示）
app.use((req, res) => {
  res.status(404).send(`
    <h1>404 - パスが見つかりません（書き換え漏れの可能性大）</h1>
    <p>アクセスされたパス: <strong>${req.originalUrl}</strong></p>
    <p>これは相対リンク（例: /forecast/...）がプロキシURLに書き換わっていない可能性があります。</p>
    <p>Renderログで "Rewrote" や "Rewrite failed" を確認してください。</p>
    <a href="/">トップページに戻る</a>
  `);
});

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});

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

// テスト環境のみ（本番は必ず削除すること）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

app.use(express.static(join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// メインプロキシ: /proxy/<encoded-url>/*
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
          // セキュリティヘッダを緩める（テスト用）
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

    // HTML系は fetch + 書き換え
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

    // レスポンスをテキストで取得
    const contentType = response.headers.get('content-type')?.toLowerCase() || '';
    let body = await response.text();

    if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
      const $ = cheerio.load(body, {
        decodeEntities: false,
        xmlMode: false
      });

      // 静的リソース属性
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

      // ナビゲーション・フォーム系
      const linkAttrs = [
        { selector: 'a, area', attr: 'href' },
        { selector: 'form', attr: 'action' },
      ];

      // 静的属性の書き換え（fullTarget 基準）
      staticAttrs.forEach(({ selector, attr }) => {
        $(selector).each((i, el) => {
          let value = $(el).attr(attr)?.trim();
          if (!value) return;
          // ページ内リンクは保護（先頭が # のみ）
          if (value.startsWith('#')) return;
          // 無視するスキーム
          if (/^(data:|blob:|javascript:|about:)/i.test(value)) return;

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

      // リンク系（a, area, form）
      linkAttrs.forEach(({ selector, attr }) => {
        $(selector).each((i, el) => {
          let value = $(el).attr(attr)?.trim();
          if (!value) return;
          if (value.startsWith('#')) return;
          if (/^(data:|blob:|javascript:|about:)/i.test(value)) return;

          try {
            const resolved = new URL(value, fullTarget).href;
            const proxiedUrl = `/proxy/${encodeURIComponent(resolved)}`;
            $(el).attr(attr, proxiedUrl);
            console.log(`[LINK] Rewrote <${selector}> ${attr}: "${value}" → "${proxiedUrl}"`);
          } catch (e) {
            console.warn("Rewrite failed:", value);
          }
        });
      });

      // srcset 処理（fullTarget 基準）
      $('[srcset]').each((i, el) => {
        let srcset = $(el).attr('srcset') || '';
        const parts = srcset.split(',').map(part => {
          const trimmed = part.trim();
          const [urlPart, ...desc] = trimmed.split(/\s+/);
          try {
            const abs = new URL(urlPart, fullTarget).href;
            return `/proxy/${encodeURIComponent(abs)}${desc.length ? ' ' + desc.join(' ') : ''}`;
          } catch {
            return trimmed;
          }
        });
        $(el).attr('srcset', parts.join(', '));
      });

      // CSS url() 処理（fullTarget 基準）
      const rewriteCssUrls = (css) => {
        return css.replace(/url\(['"]?([^'")]+)['"]?\)/gi, (match, urlPart) => {
          const trimmedUrl = urlPart.trim();
          // data: とページ内アンカーだけはそのまま
          if (/^(data:|#)/i.test(trimmedUrl)) return match;
          try {
            const abs = new URL(trimmedUrl, fullTarget).href;
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

      // base 削除（プロキシで扱うため）
      $('base').remove();

      // server-side: target="_blank" を削除（確実に）
      $('a[target="_blank"]').removeAttr('target');

      // クライアント側での完全制御スクリプトを注入
      $('head').prepend(`
<script>
(function() {
  // URL をプロキシに変換する関数
  function toProxyUrl(url) {
    if (!url) return url;
    // ページ内アンカー・javascript・data はそのまま
    if (url.startsWith('#')) return url;
    if (/^(javascript:|data:|blob:|about:)/i.test(url)) return url;

    try {
      // 相対パスを絶対化
      const abs = new URL(url, location.href).href;
      // 既にプロキシ済みならそのまま
      if (abs.startsWith(location.origin + '/proxy/')) return url;
      return '/proxy/' + encodeURIComponent(abs);
    } catch (e) {
      return url;
    }
  }

  // リンク・area・form の修正
  function fixLinksAndForms(root) {
    (root || document).querySelectorAll('a[href], area[href], form[action]').forEach(el => {
      if (el.tagName === 'FORM') {
        const action = el.getAttribute('action') || '';
        const prox = toProxyUrl(action || location.href);
        el.setAttribute('action', prox);
      } else {
        el.removeAttribute('target');
        const href = el.getAttribute('href') || '';
        const prox = toProxyUrl(href);
        if (prox !== href) el.setAttribute('href', prox);
      }
    });
  }

  // フォーム submit を横取り（追加の保険）
  document.addEventListener('submit', function(e) {
    const f = e.target;
    if (f && f.tagName === 'FORM') {
      const action = f.getAttribute('action') || location.href;
      const prox = toProxyUrl(action);
      f.setAttribute('action', prox);
    }
  }, true);

  // クリック横取り（万が一のため、captureで早めに処理）
  document.addEventListener('click', function(e) {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    const prox = toProxyUrl(href);
    if (prox !== href) {
      e.preventDefault();
      // 同じウィンドウで遷移（安全のため）
      location.href = prox;
    }
  }, true);

  // fetch を横取り
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      let url = (typeof input === 'string') ? input : (input && input.url);
      if (url) {
        const prox = toProxyUrl(url);
        if (typeof input === 'string') {
          input = prox;
        } else if (input instanceof Request) {
          input = new Request(prox, input);
        } else if (typeof input === 'object' && input.url) {
          input = Object.assign({}, input, { url: prox });
        }
      }
    } catch (e) {}
    return originalFetch.call(this, input, init);
  };

  // XHR を横取り
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    try {
      const prox = toProxyUrl(url);
      return originalOpen.apply(this, [method, prox, ...Array.prototype.slice.call(arguments, 2)]);
    } catch (e) {
      return originalOpen.apply(this, arguments);
    }
  };

  // window.open を横取り
  const originalOpenWin = window.open;
  window.open = function(url, ...args) {
    try {
      const prox = toProxyUrl(url);
      return originalOpenWin.call(this, prox, ...args);
    } catch (e) {
      return originalOpenWin.call(this, url, ...args);
    }
  };

  // location.assign / replace を横取り
  const originalAssign = window.location.assign;
  if (originalAssign) {
    window.location.assign = function(url) {
      try {
        const prox = toProxyUrl(url);
        return originalAssign.call(this, prox);
      } catch (e) {
        return originalAssign.call(this, url);
      }
    };
  }
  const originalReplace = window.location.replace;
  if (originalReplace) {
    window.location.replace = function(url) {
      try {
        const prox = toProxyUrl(url);
        return originalReplace.call(this, prox);
      } catch (e) {
        return originalReplace.call(this, url);
      }
    };
  }

  // DOM変化を監視して動的に追加された要素も修正
  const mo = new MutationObserver(muts => {
    muts.forEach(m => {
      m.addedNodes && m.addedNodes.forEach(n => {
        if (n.nodeType === 1) fixLinksAndForms(n);
      });
    });
  });
  mo.observe(document, { childList: true, subtree: true });

  // 最初に一度実行
  try { fixLinksAndForms(document); } catch(e){}

})();
</script>
      `);

      body = $.html();
    }

    // レスポンスヘッダをそのまま流す（必要最小限に加工）
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

// ブラウザがプロキシ経由でないパスに直接来た場合、Refererがプロキシ元なら強制リダイレクトしてプロキシ付きURLへ戻す
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

// 404ハンドラ（詳細表示）
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

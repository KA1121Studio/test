const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cheerio = require('cheerio');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

const PROXY_PREFIX = '/proxy/';

// トップページ
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>test</title>
      <style>
        body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; background: #f8f9fa; }
        .container { max-width: 800px; margin: 0 auto; text-align: center; }
        h1 { color: #333; }
        form { display: flex; flex-direction: column; align-items: center; gap: 1rem; margin: 2rem 0; }
        input[type="url"] { width: 100%; max-width: 600px; padding: 0.8rem; font-size: 1.1rem; border: 1px solid #ccc; border-radius: 6px; }
        button { padding: 0.8rem 2rem; font-size: 1.1rem; background: #007bff; color: white; border: none; border-radius: 6px; cursor: pointer; }
        button:hover { background: #0056b3; }
        .note { color: #666; font-size: 0.9rem; margin-top: 2rem; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>なんでも開けるプロキシ（実験版）</h1>
        <form action="${PROXY_PREFIX}" method="get">
          <input type="url" name="url" placeholder="https://www.youtube.com または https://example.com" required autofocus>
          <button type="submit">開く</button>
        </form>
        <p class="note">
          ※ YouTube・X・ニュースサイトなどは一部表示可能ですが、<br>
          複雑なJavaScript（SPA）は崩れやすいです。テスト用としてご利用ください。
        </p>
      </div>
    </body>
    </html>
  `);
});

// プロキシ処理（ここが核心）
app.use(PROXY_PREFIX, (req, res, next) => {
  let targetUrlStr;

  if (req.query.url) {
    targetUrlStr = req.query.url.trim();
  } else {
    // パス形式の場合
    let pathPart = req.path;
    if (pathPart === '/' || pathPart === '') {
      return res.redirect('/');
    }
    targetUrlStr = pathPart.startsWith('/') ? pathPart.slice(1) : pathPart;
    if (!targetUrlStr.match(/^https?:\/\//i)) {
      targetUrlStr = 'https://' + targetUrlStr;
    }
  }

  let target;
  try {
    target = new URL(targetUrlStr);
  } catch (err) {
    console.error('Invalid target URL:', targetUrlStr, err);
    return res.status(400).send(`無効なURL: ${targetUrlStr}<br><a href="/">戻る</a>`);
  }

  const targetOrigin = target.origin;
  console.log('[DEBUG] Target origin set to:', targetOrigin);

  const proxy = createProxyMiddleware({
    target: targetOrigin,
    changeOrigin: true,
    logLevel: 'debug',

    pathRewrite: (path, req) => {
      let rewritten = path;

      // プレフィックス除去
      if (rewritten.startsWith(PROXY_PREFIX)) {
        rewritten = rewritten.substring(PROXY_PREFIX.length);
      }

      // フォーム経由の場合 → 相対パスだけ返す（/ や /search など）
      if (req.query.url) {
        // フォームの場合、req.path は通常 / なのでそのまま
        const relative = req.path || '/';
        console.log('[DEBUG] Form rewrite → relative:', relative);
        return relative;
      }

      // パス形式の場合 → ホスト部分を削る
      const hostMatch = rewritten.match(/^https?:\/\/[^/]+(\/.*)?$/i);
      if (hostMatch) {
        rewritten = hostMatch[1] || '/';
      }

      console.log('[DEBUG] Final rewrite:', rewritten);
      return rewritten;
    },

    selfHandleResponse: true,

    onProxyRes: (proxyRes, req, res) => {
      const contentType = proxyRes.headers['content-type'] || '';

      if (contentType.includes('text/html')) {
        let body = [];
        proxyRes.on('data', chunk => body.push(chunk));
        proxyRes.on('end', () => {
          let html = Buffer.concat(body).toString('utf8');
          const $ = cheerio.load(html, { decodeEntities: false });

          const rules = [
            { sel: 'a, link[href], script[src], img[src], source[src], iframe[src], form[action]', attr: ['href', 'src', 'action'] }
          ];

          rules.forEach(({ sel, attr }) => {
            $(sel).each(function () {
              attr.forEach(a => {
                const val = $(this).attr(a);
                if (!val || val.startsWith('data:') || val.startsWith('#') || val.startsWith('javascript:')) return;

                try {
                  const abs = new URL(val, target.href).href;
                  const proxied = PROXY_PREFIX + abs.replace(/^https?:\/\//i, '');
                  $(this).attr(a, proxied);
                } catch {}
              });
            });
          });

          // meta refresh
          $('meta[http-equiv="refresh"]').each(function () {
            let content = $(this).attr('content') || '';
            const match = content.match(/url\s*=\s*(.+)/i);
            if (match) {
              try {
                const abs = new URL(match[1].trim(), target.href).href;
                const newUrl = PROXY_PREFIX + abs.replace(/^https?:\/\//i, '');
                $(this).attr('content', content.replace(match[1], newUrl));
              } catch {}
            }
          });

          delete proxyRes.headers['content-security-policy'];
          delete proxyRes.headers['x-frame-options'];
          proxyRes.headers['access-control-allow-origin'] = '*';

          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          res.end($.html());
        });
      } else {
        Object.keys(proxyRes.headers).forEach(k => res.setHeader(k, proxyRes.headers[k]));
        res.status(proxyRes.statusCode);
        proxyRes.pipe(res);
      }
    },

    onError: (err, req, res) => {
      console.error('Proxy connection error:', err.message);
      res.status(502).send(`プロキシ接続エラー: ${err.message || 'ターゲットに接続できません'}<br><a href="/">トップに戻る</a>`);
    }
  });

  proxy(req, res, next);
});

app.use((req, res) => {
  res.status(404).send('見つかりません。<br><a href="/">トップへ</a>');
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});

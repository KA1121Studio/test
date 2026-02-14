const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cheerio = require('cheerio');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

const PROXY_PREFIX = '/proxy/';

// トップページ（入力フォーム）
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

// プロキシのメイン処理
app.use(PROXY_PREFIX, (req, res, next) => {
  let targetUrl = req.query.url;

  if (!targetUrl) {
    // パス形式の場合: /proxy/https://example.com/xxx → https://example.com/xxx
    let pathPart = req.path;
    if (pathPart === '/' || pathPart === '') {
      return res.redirect('/');
    }
    targetUrl = pathPart.startsWith('/') ? pathPart.slice(1) : pathPart;
    if (!targetUrl.match(/^https?:\/\//i)) {
      targetUrl = 'https://' + targetUrl;
    }
  }

  try {
    const target = new URL(targetUrl);
    const targetOrigin = target.origin;

    const proxy = createProxyMiddleware({
      target: targetOrigin,
      changeOrigin: true,
      logLevel: 'debug',  // Renderログで詳細が見えるように

// index.js の pathRewrite 部分だけを以下に置き換えてください（全体コードの最後の方）

pathRewrite: (incomingPath, req) => {
  // incomingPath はマウントパス込みのフルパス例: /proxy/https://www.google.com/search?q=test
  // または /proxy/?url=https://www.google.com/search?q=test の場合も考慮

  let pathToRewrite = incomingPath;

  // 1. PROXY_PREFIX (/proxy/) を確実に除去
  if (pathToRewrite.startsWith(PROXY_PREFIX)) {
    pathToRewrite = pathToRewrite.substring(PROXY_PREFIX.length);
  }

  // 2. クエリ形式 (?url=...) が混ざっている場合を優先処理
  if (req.query.url) {
    // フォーム経由の場合 → targetUrl は既に new URL でパース済み
    // → ここでは pathRewrite は req.path に基づく相対パスを返すだけでOK
    //    実際の target は createProxyMiddleware の target で決まる
    const relativePath = req.path || '/';
    console.log('[DEBUG] Form mode - relative path:', relativePath);
    return relativePath;
  }

  // 3. パス形式 (/proxy/https://example.com/abc?def=1) の場合
  //    → https://example.com/ の部分を削る
  try {
    // 先頭が http/https から始まる部分を探して除去
    const protocolMatch = pathToRewrite.match(/^((https?:\/)?\/[^/?#]+)/i);
    if (protocolMatch && protocolMatch[0]) {
      const hostPartLength = protocolMatch[0].length;
      pathToRewrite = pathToRewrite.substring(hostPartLength) || '/';
    }
  } catch (e) {
    console.log('[DEBUG] Host strip failed:', e);
  }

  // 4. 空になったらルートに
  if (!pathToRewrite || pathToRewrite === '') {
    pathToRewrite = '/';
  }

  console.log('[DEBUG] Final rewritten path:', pathToRewrite);
  return pathToRewrite;
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

            // URL書き換え対象
            const rules = [
              { sel: 'a', attr: 'href' },
              { sel: 'img', attr: 'src' },
              { sel: 'source', attr: 'src' },
              { sel: 'script[src]', attr: 'src' },
              { sel: 'link[href]', attr: 'href' },
              { sel: 'form', attr: 'action' },
              { sel: 'iframe', attr: 'src' }
            ];

            rules.forEach(({ sel, attr }) => {
              $(sel).each(function () {
                const val = $(this).attr(attr);
                if (!val || val.startsWith('data:') || val.startsWith('#') || val.startsWith('javascript:')) return;

                try {
                  const abs = new URL(val, target.href).href;
                  const newPath = PROXY_PREFIX + abs.replace(/^https?:\/\//i, '');
                  $(this).attr(attr, newPath);
                } catch (e) {}
              });
            });

            // meta refresh 対応
            $('meta[http-equiv="refresh"]').each(function () {
              let content = $(this).attr('content') || '';
              const m = content.match(/url=(.+)/i);
              if (m && m[1]) {
                try {
                  const abs = new URL(m[1].trim(), target.href).href;
                  const newUrl = PROXY_PREFIX + abs.replace(/^https?:\/\//i, '');
                  $(this).attr('content', content.replace(m[1], newUrl));
                } catch {}
              }
            });

            // 問題になりやすいヘッダー削除/変更
            delete proxyRes.headers['content-security-policy'];
            delete proxyRes.headers['content-security-policy-report-only'];
            delete proxyRes.headers['x-frame-options'];
            proxyRes.headers['access-control-allow-origin'] = '*';

            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            res.end($.html());
          });
        } else {
          // 非HTMLはそのままpipe
          Object.keys(proxyRes.headers).forEach(k => res.setHeader(k, proxyRes.headers[k]));
          res.status(proxyRes.statusCode);
          proxyRes.pipe(res);
        }
      },

      onError: (err, req, res) => {
        console.error('Proxy error:', err.message, 'URL:', targetUrl);
        res.status(502).send(`プロキシエラー: ${err.message || '不明'}<br><a href="/">トップに戻る</a>`);
      }
    });

    proxy(req, res, next);
  } catch (err) {
    console.error('URL parse error:', err.message, targetUrl);
    res.status(400).send(`無効なURL形式です: ${targetUrl}<br><a href="/">戻る</a>`);
  }
});

// 404ハンドラ
app.use((req, res) => {
  res.status(404).send('ページが見つかりません。<br><a href="/">トップページへ</a>');
});

app.listen(PORT, () => {
  console.log(`Proxy server started on port ${PORT}`);
  console.log(`URL example: http://localhost:${PORT}/`);
  console.log(`または直接: http://localhost:${PORT}/proxy/https://example.com`);
});

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cheerio = require('cheerio');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// プロキシのプレフィックス（これで始まるURLはプロキシ扱い）
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
        .container { max-width: 800px; margin: 0 auto; }
        h1 { text-align: center; color: #333; }
        form { display: flex; flex-direction: column; align-items: center; gap: 1rem; }
        input[type="url"] { width: 100%; max-width: 600px; padding: 0.8rem; font-size: 1.1rem; border: 1px solid #ccc; border-radius: 6px; }
        button { padding: 0.8rem 2rem; font-size: 1.1rem; background: #007bff; color: white; border: none; border-radius: 6px; cursor: pointer; }
        button:hover { background: #0056b3; }
        .note { margin-top: 2rem; color: #666; text-align: center; font-size: 0.9rem; }
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
          ※ YouTube・Twitter・ニュースサイトなどは一部動く可能性がありますが、<br>
          JavaScriptが複雑なSPAは崩れやすいです。実験用としてお使いください。
        </p>
      </div>
    </body>
    </html>
  `);
});

// プロキシ処理
app.use(PROXY_PREFIX, (req, res, next) => {
  let targetUrl;

  // フォームから来た場合 (?url=...)
  if (req.query.url) {
    targetUrl = req.query.url;
  } 
  // パス形式の場合 (/proxy/https://example.com/...)
  else {
    let path = req.path;
    if (path === '/' || path === '') {
      return res.redirect('/');
    }
    // 先頭のスラッシュを除去
    targetUrl = path.startsWith('/') ? path.slice(1) : path;
    if (!targetUrl.match(/^https?:\/\//i)) {
      targetUrl = 'https://' + targetUrl;
    }
  }

  try {
    const target = new URL(targetUrl);
    const targetOrigin = target.origin;
    const targetPath = target.pathname + target.search;

    const proxy = createProxyMiddleware({
      target: targetOrigin,
      changeOrigin: true,
      pathRewrite: (pathReq) => {
        // プレフィックス以降を本来のパスに
        return pathReq.replace(PROXY_PREFIX + (target.href.replace(/^https?:\/\//, '')), '');
      },
      selfHandleResponse: true, // 自分でレスポンスを処理
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': targetOrigin,
        'Accept': req.headers['accept'] || '*/*',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8'
      },

      onProxyRes: (proxyRes, req, res) => {
        const contentType = proxyRes.headers['content-type'] || '';

        // HTMLだけ書き換え対象
        if (contentType.includes('text/html')) {
          let bodyChunks = [];
          proxyRes.on('data', chunk => bodyChunks.push(chunk));
          proxyRes.on('end', () => {
            let html = Buffer.concat(bodyChunks).toString('utf8');
            const $ = cheerio.load(html, { decodeEntities: false });

            // URL書き換え対象の属性
            const rewritable = [
              { selector: 'a', attr: 'href' },
              { selector: 'img', attr: 'src' },
              { selector: 'source', attr: 'src' },
              { selector: 'script', attr: 'src' },
              { selector: 'link[rel="stylesheet"]', attr: 'href' },
              { selector: 'link[rel="icon"]', attr: 'href' },
              { selector: 'form', attr: 'action' },
              { selector: 'iframe', attr: 'src' }
            ];

            rewritable.forEach(({ selector, attr }) => {
              $(selector).each(function () {
                let val = $(this).attr(attr);
                if (!val || val.startsWith('data:') || val.startsWith('#') || val.startsWith('javascript:')) return;

                try {
                  const absolute = new URL(val, target.href).href;
                  const proxied = PROXY_PREFIX + absolute.replace(/^https?:\/\//, '');
                  $(this).attr(attr, proxied);
                } catch {}
              });
            });

            // meta refresh の書き換え
            $('meta[http-equiv="refresh"]').each(function () {
              let content = $(this).attr('content') || '';
              const match = content.match(/url=(.+)$/i);
              if (match && match[1]) {
                try {
                  const abs = new URL(match[1], target.href).href;
                  const newUrl = PROXY_PREFIX + abs.replace(/^https?:\/\//, '');
                  $(this).attr('content', content.replace(match[1], newUrl));
                } catch {}
              }
            });

            // CSP系ヘッダーを無効化（多くのサイトで邪魔）
            delete proxyRes.headers['content-security-policy'];
            delete proxyRes.headers['content-security-policy-report-only'];
            delete proxyRes.headers['x-frame-options'];
            proxyRes.headers['access-control-allow-origin'] = '*';

            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            res.end($.html());
          });
        } 
        // HTML以外はそのまま通過
        else {
          // バイナリ系はバッファせずpipe
          Object.keys(proxyRes.headers).forEach(key => {
            res.setHeader(key, proxyRes.headers[key]);
          });
          res.status(proxyRes.statusCode);
          proxyRes.pipe(res);
        }
      },

      onError: (err, req, res) => {
        console.error('Proxy error:', err);
        res.status(502).send('プロキシエラー: ' + (err.message || '不明'));
      }
    });

    proxy(req, res, next);
  } catch (err) {
    console.error(err);
    res.status(400).send('無効なURLです。<br><a href="/">戻る</a>');
  }
});

// 404フォールバック
app.use((req, res) => {
  res.status(404).send('ページが見つかりません。<br><a href="/">トップに戻る</a>');
});

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
  console.log(`→ http://localhost:${PORT}/`);
});

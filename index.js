process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import fetch from 'node-fetch';
import cheerio from 'cheerio';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// 静的ファイル（index.htmlなど）
app.use(express.static(join(__dirname, 'public')));

// ルートでトップページ表示
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// プロキシのメインエンドポイント
// /proxy/https%3A%2F%2Fexample.com/ の形式
app.use('/proxy/:targetUrl*', async (req, res, next) => {
  try {
    let targetUrl = decodeURIComponent(req.params.targetUrl);
    if (!targetUrl.startsWith('http')) {
      targetUrl = 'https://' + targetUrl;
    }

    const fullPath = req.params[0] || '';
    const target = targetUrl + fullPath + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');

    // 画像・動画・css・js・woffなどは直プロキシ（高速）
    if (/\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|woff2?|ttf|eot|mp4|webm|ogg|mp3|wav)$/i.test(fullPath)) {
      return createProxyMiddleware({
        target: targetUrl,
        changeOrigin: true,
        pathRewrite: { [`^/proxy/${req.params.targetUrl}`]: '' },
        selfHandleResponse: false,
        onProxyReq(proxyReq) {
          proxyReq.setHeader('User-Agent', req.headers['user-agent'] || 'Mozilla/5.0');
          proxyReq.setHeader('Referer', targetUrl);
        }
      })(req, res, next);
    }

    // HTMLの場合は書き換えが必要
    const response = await fetch(target, {
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
        'Accept': req.headers['accept'] || '*/*',
        'Accept-Language': req.headers['accept-language'] || 'ja,en;q=0.9',
        'Referer': targetUrl,
      },
      redirect: 'manual',
    });

    if (response.redirected) {
      const location = response.headers.get('location');
      if (location) {
        const newLocation = `/proxy/${encodeURIComponent(location)}`;
        return res.redirect(302, newLocation);
      }
    }

    let body = await response.text();

    // HTMLならURLを書き換える
    if (response.headers.get('content-type')?.includes('text/html')) {
      const $ = cheerio.load(body, { decodeEntities: false });

      // よくある属性を書き換え
      const attrs = [
        ['a', 'href'],
        ['link', 'href'],
        ['script', 'src'],
        ['img', 'src'],
        ['source', 'src'],
        ['video', 'src'],
        ['audio', 'src'],
        ['iframe', 'src'],
        ['form', 'action'],
        ['meta[property="og:url"]', 'content'],
        ['meta[property="og:image"]', 'content'],
      ];

      for (const [selector, attr] of attrs) {
        $(selector).each((i, el) => {
          let val = $(el).attr(attr);
          if (!val) return;

          // すでにプロキシ経由ならスキップ
          if (val.includes('/proxy/')) return;

          // 相対パス → 絶対パス化
          try {
            val = new URL(val, target).href;
          } catch {}

          // プロキシ経由に書き換え
          if (val.startsWith('http')) {
            $(el).attr(attr, `/proxy/${encodeURIComponent(val)}`);
          }
        });
      }

      // baseタグがあれば削除（邪魔になることが多い）
      $('base').remove();

      // インラインJSのURLも簡単に対応（完璧ではない）
      $('script').each((i, el) => {
        let code = $(el).html();
        if (code) {
          code = code.replace(/(https?:\/\/[^'"\s]+)/g, (m) => {
            return `/proxy/${encodeURIComponent(m)}`;
          });
          $(el).html(code);
        }
      });

      body = $.html();
    }

    // ヘッダーをなるべく透過
    const headers = {};
    for (const [k, v] of response.headers) {
      if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(k)) {
        headers[k] = v;
      }
    }

    res.set(headers);
    res.status(response.status).send(body);

  } catch (err) {
    console.error(err);
    res.status(500).send(`
      <h1>プロキシエラー</h1>
      <pre>${err.message}</pre>
      <p><a href="/">トップに戻る</a></p>
    `);
  }
});

// 404はトップにリダイレクト
app.use((req, res) => {
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`Proxy server running on http://localhost:${PORT}`);
});

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

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

app.use(express.static(join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.use('/proxy/:targetUrl*', async (req, res, next) => {
  try {
    let targetBase = decodeURIComponent(req.params.targetUrl);
    if (!targetBase.startsWith('http')) targetBase += 'https://';

    // subPathを正しく扱う（先頭スラッシュを考慮）
    let subPath = req.params[0] || '';
    if (subPath && !subPath.startsWith('/')) subPath = '/' + subPath;

    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const fullTarget = targetBase + subPath + query;

    // 静的リソース判定（拡張子 + Acceptヘッダー）
    const isStatic = /\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|woff2?|ttf|eot|otf|mp4|webm|ogg|mp3|wav|pdf|json|map|avif)$/i.test(subPath)
      || req.headers.accept?.includes('image/')
      || req.headers.accept?.includes('font/')
      || req.headers.accept?.includes('javascript')
      || req.headers.accept?.includes('css');

    if (isStatic) {
      // pathRewriteをシンプルに： /proxy/<encoded-base> + subPath → subPathだけ
      return createProxyMiddleware({
        target: targetBase,
        changeOrigin: true,
        pathRewrite: (path, req) => {
          // /proxy/https%3A%2F%2Fdashmetry.com/cache/... → /cache/...
          const prefix = `/proxy/${encodeURIComponent(targetBase)}`;
          return path.startsWith(prefix) ? path.slice(prefix.length) || '/' : path;
        },
        selfHandleResponse: false,
        onProxyReq(proxyReq) {
          proxyReq.setHeader('User-Agent', req.headers['user-agent'] || 'Mozilla/5.0');
          proxyReq.setHeader('Referer', targetBase);
          proxyReq.setHeader('Origin', targetBase);
        },
        onProxyRes(proxyRes) {
          proxyRes.headers['access-control-allow-origin'] = '*';
          delete proxyRes.headers['content-security-policy'];
          delete proxyRes.headers['x-frame-options'];
        },
        onError(err, req, res) {
          res.status(502).send('Static load failed: ' + err.message);
        }
      })(req, res, next);
    }

    // HTMLなどのテキストコンテンツ
    const agent = new https.Agent({ rejectUnauthorized: false });
    const response = await fetch(fullTarget, {
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
        'Accept': req.headers['accept'] || '*/*',
        'Referer': targetBase,
      },
      redirect: 'manual',
      agent,
    });

    if (response.redirected && response.headers.get('location')) {
      let loc = response.headers.get('location');
      if (!loc.startsWith('http')) loc = new URL(loc, targetBase).href;
      return res.redirect(302, `/proxy/${encodeURIComponent(loc)}`);
    }

    let body = await response.text();
    const contentType = response.headers.get('content-type')?.toLowerCase() || '';

    if (contentType.includes('text/html') || contentType.includes('xhtml')) {
      const $ = cheerio.load(body, { decodeEntities: false });

      // 属性書き換え（さらにlazy系追加）
      const attrsToRewrite = [
        'src', 'srcset', 'data-src', 'data-lazy-src', 'data-original-src',
        'href', 'action', 'poster', 'background', 'data-bg', 'data-background'
      ];

      $('*').each((i, el) => {
        attrsToRewrite.forEach(attr => {
          let val = $(el).attr(attr);
          if (!val || /^(data:|blob:|javascript:|#)/i.test(val)) return;

          try {
            const absolute = new URL(val, targetBase).href;
            if (absolute.startsWith(targetBase)) {
              $(el).attr(attr, `/proxy/${encodeURIComponent(absolute)}`);
            }
          } catch {}
        });
      });

      // srcset専用処理
      $('[srcset]').each((i, el) => {
        let srcset = $(el).attr('srcset') || '';
        srcset = srcset.replace(/(https?:\/\/[^,\s]+)/g, url => {
          try {
            const abs = new URL(url, targetBase).href;
            return `/proxy/${encodeURIComponent(abs)}`;
          } catch { return url; }
        });
        $(el).attr('srcset', srcset);
      });

      // CSS内のurl()
      const cssRewrite = (text) => text.replace(/url\(['"]?([^'")]+)['"]?\)/gi, (m, p1) => {
        try {
          const abs = new URL(p1.trim(), targetBase).href;
          return `url(/proxy/${encodeURIComponent(abs)})`;
        } catch { return m; }
      });

      $('[style]').each((_, el) => $(el).attr('style', cssRewrite($(el).attr('style') || '')));
      $('style').each((_, el) => $(el).html(cssRewrite($(el).html() || '')));

      $('base').remove();

      body = $.html();
    }

    const headers = Object.fromEntries(
      [...response.headers.entries()].filter(([k]) => !['content-length', 'content-encoding', 'transfer-encoding'].includes(k.toLowerCase()))
    );
    headers['access-control-allow-origin'] = '*';

    res.set(headers);
    res.status(response.status).send(body);

  } catch (err) {
    console.error(err);
    res.status(500).send(`<h1>エラー</h1><pre>${err.message}</pre><a href="/">戻る</a>`);
  }
});

app.use((req, res) => res.redirect('/'));

app.listen(PORT, () => console.log(`Running on port ${PORT}`));

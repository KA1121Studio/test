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

app.use('/proxy/:targetUrl*', (req, res, next) => {
  let targetBase = decodeURIComponent(req.params.targetUrl);
  if (!targetBase.startsWith('http')) targetBase = 'https://' + targetBase;

  let subPath = req.params[0] || '';
  if (!subPath.startsWith('/')) subPath = '/' + subPath;

  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const fullTarget = targetBase + subPath + query;

  // 静的ファイル判定
  const isStatic = /\.(webp|png|jpg|jpeg|gif|svg|ico|css|js|woff2?|ttf|eot|otf|mp4|webm|ogg|mp3|wav|pdf|avif)$/i.test(subPath) ||
    req.headers.accept?.includes('image/') || req.headers.accept?.includes('font/') ||
    req.headers.accept?.includes('javascript') || req.headers.accept?.includes('css');

  if (isStatic) {
    const proxy = createProxyMiddleware({
      target: targetBase,
      changeOrigin: true,
      pathRewrite: (path) => {
        const prefix = `/proxy/${encodeURIComponent(targetBase)}`;
        if (path.startsWith(prefix)) {
          return path.substring(prefix.length) || '/';
        }
        return path;
      },
      selfHandleResponse: false,
      onProxyReq(proxyReq) {
        proxyReq.setHeader('User-Agent', req.headers['user-agent'] || 'Mozilla/5.0');
        proxyReq.setHeader('Referer', targetBase + '/');
        proxyReq.setHeader('Origin', targetBase);
      },
      onProxyRes(proxyRes) {
        proxyRes.headers['access-control-allow-origin'] = '*';
        delete proxyRes.headers['content-security-policy'];
        delete proxyRes.headers['x-frame-options'];
      },
      onError(err, req, res) {
        res.status(502).send('Resource load failed: ' + err.message);
      }
    });

    return proxy(req, res, next);
  }

  // HTML処理（前回とほぼ同じ、lazy属性追加）
  const agent = new https.Agent({ rejectUnauthorized: false });
  fetch(fullTarget, {
    headers: {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
      'Accept': '*/*',
      'Referer': targetBase + '/',
    },
    redirect: 'manual',
    agent,
  })
  .then(response => {
    if (response.redirected && response.headers.get('location')) {
      let loc = response.headers.get('location');
      if (!loc.startsWith('http')) loc = new URL(loc, targetBase).href;
      return res.redirect(302, `/proxy/${encodeURIComponent(loc)}`);
    }

    return response.text().then(body => ({ response, body }));
  })
  .then(({ response, body }) => {
    const contentType = response.headers.get('content-type')?.toLowerCase() || '';

    if (contentType.includes('text/html') || contentType.includes('xhtml')) {
      const $ = cheerio.load(body, { decodeEntities: false });

      const attrs = ['src', 'srcset', 'data-src', 'data-lazy-src', 'data-original', 'data-bg', 'href', 'action', 'poster', 'background'];

      $('*').each((i, el) => {
        attrs.forEach(attr => {
          let val = $(el).attr(attr);
          if (val && !/^(data:|blob:|javascript:|#)/i.test(val)) {
            try {
              const abs = new URL(val, targetBase).href;
              if (abs.startsWith(targetBase)) {
                $(el).attr(attr, `/proxy/${encodeURIComponent(abs)}`);
              }
            } catch {}
          }
        });
      });

      // srcset
      $('[srcset]').each((_, el) => {
        let srcset = $(el).attr('srcset') || '';
        srcset = srcset.replace(/([^\s,]+)(?:\s+[^,]+)?/g, (match, urlPart) => {
          try {
            const abs = new URL(urlPart, targetBase).href;
            return match.replace(urlPart, `/proxy/${encodeURIComponent(abs)}`);
          } catch { return match; }
        });
        $(el).attr('srcset', srcset);
      });

      // CSS url()
      const rewriteCss = text => text.replace(/url\(["']?([^"')]+)["']?\)/gi, (m, p) => {
        try {
          const abs = new URL(p.trim(), targetBase).href;
          return `url(/proxy/${encodeURIComponent(abs)})`;
        } catch { return m; }
      });

      $('[style]').each((_, el) => $(el).attr('style', rewriteCss($(el).attr('style') || '')));
      $('style').each((_, el) => $(el).html(rewriteCss($(el).html() || '')));

      $('base').remove();

      body = $.html();
    }

    const headers = {};
    response.headers.forEach((v, k) => {
      if (!['content-length', 'content-encoding', 'transfer-encoding'].includes(k.toLowerCase())) headers[k] = v;
    });
    headers['access-control-allow-origin'] = '*';

    res.set(headers);
    res.status(response.status).send(body);
  })
  .catch(err => {
    console.error(err);
    res.status(500).send(`<h1>エラー</h1><pre>${err.message}</pre><a href="/">トップ</a>`);
  });
});

app.use((req, res) => res.redirect('/'));

app.listen(PORT, () => console.log(`Proxy on port ${PORT}`));

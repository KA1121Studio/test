import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';  // ← 最新cheerio対応（* as）
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import https from 'https';  // ← 証明書エラー回避用

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// 証明書エラー回避（Render環境で必須な場合が多い）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";  // テスト用。本番では削除推奨

app.use(express.static(join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// メインのプロキシエンドポイント
app.use('/proxy/:targetUrl*', async (req, res, next) => {
  try {
    let targetUrl = decodeURIComponent(req.params.targetUrl);
    if (!targetUrl.startsWith('http')) {
      targetUrl = 'https://' + targetUrl;
    }

    const fullPath = req.params[0] || '';
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const target = targetUrl + fullPath + query;

    // 静的ファイル（画像・CSS・JSなど）は直プロキシ（高速・Content-Type正しく通す）
    const staticExtRegex = /\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|woff2?|ttf|eot|otf|mp4|webm|ogg|mp3|wav|pdf)$/i;
    if (staticExtRegex.test(fullPath) || req.headers.accept?.includes('image/') || req.headers.accept?.includes('font/')) {
      return createProxyMiddleware({
        target: targetUrl,
        changeOrigin: true,
        pathRewrite: { [`^/proxy/${encodeURIComponent(targetUrl)}`]: '' },
        selfHandleResponse: false,
        onProxyReq(proxyReq) {
          proxyReq.setHeader('User-Agent', req.headers['user-agent'] || 'Mozilla/5.0');
          proxyReq.setHeader('Referer', targetUrl);
          proxyReq.setHeader('Origin', targetUrl);
          proxyReq.setHeader('Accept', req.headers['accept'] || '*/*');
        },
        onProxyRes(proxyRes) {
          // CORSヘッダーを強制的に付与（画像がブロックされないように）
          proxyRes.headers['access-control-allow-origin'] = '*';
          proxyRes.headers['access-control-allow-methods'] = 'GET, HEAD';
        },
        onError(err, req, res) {
          console.error('Static proxy error:', err);
          res.status(502).send('Failed to load resource');
        }
      })(req, res, next);
    }

    // HTML / その他テキスト系はfetch + 書き換え
    const agent = new https.Agent({ rejectUnauthorized: false });
    const response = await fetch(target, {
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': req.headers['accept-language'] || 'ja,en;q=0.9',
        'Referer': targetUrl,
      },
      redirect: 'manual',
      agent,
    });

    if (response.redirected && response.headers.get('location')) {
      let location = response.headers.get('location');
      if (!location.startsWith('http')) {
        location = new URL(location, targetUrl).href;
      }
      return res.redirect(302, `/proxy/${encodeURIComponent(location)}`);
    }

    let body = await response.text();

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
      const $ = cheerio.load(body, { decodeEntities: false, xmlMode: false });

      // すべてのURL属性を処理（img, source, video, link, script, a, formなど）
      const urlAttrs = [
        { sel: 'img, source, video, audio, iframe', attr: 'src' },
        { sel: 'img', attr: 'srcset' },  // srcset対応
        { sel: 'link, script', attr: 'href' },
        { sel: 'link, script', attr: 'src' },
        { sel: 'a, area', attr: 'href' },
        { sel: 'form', attr: 'action' },
        { sel: '[background]', attr: 'background' },
        { sel: '[poster]', attr: 'poster' },
      ];

      urlAttrs.forEach(({ sel, attr }) => {
        $(sel).each((i, el) => {
          let val = $(el).attr(attr);
          if (!val) return;

          // data: や javascript: はスキップ
          if (/^(data:|javascript:|#|about:)/i.test(val)) return;

          // すでにプロキシ経由ならスキップ
          if (val.includes('/proxy/')) return;

          // 相対 → 絶対に変換
          try {
            const absolute = new URL(val, target).href;
            const proxied = `/proxy/${encodeURIComponent(absolute)}`;
            $(el).attr(attr, proxied);
          } catch (e) {
            console.warn('Invalid URL:', val);
          }
        });
      });

      // srcset の特殊対応（カンマ区切り）
      $('img[srcset]').each((i, el) => {
        let srcset = $(el).attr('srcset');
        if (!srcset) return;
        const parts = srcset.split(',').map(part => {
          const [urlPart, desc] = part.trim().split(/\s+/);
          try {
            const abs = new URL(urlPart, target).href;
            return `/proxy/${encodeURIComponent(abs)}${desc ? ' ' + desc : ''}`;
          } catch {
            return part;
          }
        });
        $(el).attr('srcset', parts.join(', '));
      });

      // <style> タグ内の url(...) を書き換え
      $('style').each((i, el) => {
        let css = $(el).html() || '';
        css = css.replace(/url\(['"]?([^'")]+)['"]?\)/gi, (match, urlPart) => {
          if (/^(data:|#|\/)/i.test(urlPart)) return match; // data URI やアンカーはそのまま
          try {
            const abs = new URL(urlPart, target).href;
            return `url(/proxy/${encodeURIComponent(abs)})`;
          } catch {
            return match;
          }
        });
        $(el).html(css);
      });

      // インライン style 属性内の url(...)
      $('[style]').each((i, el) => {
        let style = $(el).attr('style') || '';
        style = style.replace(/url\(['"]?([^'")]+)['"]?\)/gi, (match, urlPart) => {
          try {
            const abs = new URL(urlPart, target).href;
            return `url(/proxy/${encodeURIComponent(abs)})`;
          } catch {
            return match;
          }
        });
        $(el).attr('style', style);
      });

      // base タグ削除
      $('base').remove();

      body = $.html();
    }

    // ヘッダー透過（Content-Typeなど重要）
    const headers = {};
    for (const [k, v] of response.headers.entries()) {
      if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(k.toLowerCase())) {
        headers[k] = v;
      }
    }
    // CORS回避用ヘッダー追加
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

app.use((req, res) => res.redirect('/'));

app.listen(PORT, () => {
  console.log(`Proxy running on http://localhost:${PORT}`);
});

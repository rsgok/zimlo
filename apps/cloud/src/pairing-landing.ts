const pairingLandingHTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="robots" content="noindex, nofollow">
  <title>Zimlo 手机配对</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100svh; display: grid; place-items: center; padding: 28px; background: #f3f1e8; color: #171713; }
    main { width: min(100%, 420px); padding: 30px 26px; border: 1px solid #d8d4c6; border-radius: 24px; background: #fffdf5; box-shadow: 0 18px 50px rgb(38 36 27 / 10%); }
    .mark { display: grid; place-items: center; width: 54px; height: 54px; margin-bottom: 24px; border-radius: 18px; background: #d7ff45; font-size: 27px; font-weight: 900; }
    h1 { margin: 0 0 12px; font-size: 27px; line-height: 1.15; letter-spacing: -0.03em; }
    p { margin: 0; color: #666254; font-size: 16px; line-height: 1.6; }
    ol { margin: 22px 0; padding-left: 24px; font-size: 16px; line-height: 1.8; }
    button { width: 100%; min-height: 50px; border: 0; border-radius: 14px; background: #171713; color: white; font: inherit; font-weight: 750; }
    button[hidden] { display: none; }
    #status { min-height: 24px; margin-top: 12px; font-size: 14px; font-weight: 650; text-align: center; }
    .note { margin-top: 20px; padding-top: 18px; border-top: 1px solid #e4e0d4; font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">Z</div>
    <h1>请在 Zimlo App 内完成连接</h1>
    <p>系统相机只会把配对码当成网页打开，无法直接完成加密配对。</p>
    <ol>
      <li>打开 iPhone 上的 Zimlo</li>
      <li>点“扫描配对二维码”并重新扫描</li>
    </ol>
    <button id="copy" type="button" hidden>复制连接码</button>
    <p id="status" role="status" aria-live="polite"></p>
    <p class="note">也可以复制连接码，回到 Zimlo 的连接页粘贴。二维码会在 2 分钟后自动失效。</p>
  </main>
  <script nonce="__NONCE__">
    const fields = new URLSearchParams(location.hash.slice(1));
    const valid = ["pairingId", "secret", "bridgeKey"].every((key) => fields.get(key));
    const copy = document.querySelector("#copy");
    const status = document.querySelector("#status");
    if (valid) copy.hidden = false;
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        status.textContent = "已复制。现在回到 Zimlo 粘贴连接码。";
      } catch {
        status.textContent = "复制失败，请回到 Zimlo 使用 App 内扫码。";
      }
    });
  </script>
</body>
</html>`;

export function pairingLandingPage(headOnly = false): Response {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const headers = {
    "cache-control": "private, no-store",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
  return new Response(headOnly ? null : pairingLandingHTML.replace("__NONCE__", nonce), { headers });
}

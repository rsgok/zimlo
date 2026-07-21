export function PairingRequired({ error }: { error: string | null }) {
  return (
    <main className="pair-required">
      <span className="brand-mark">Z</span>
      <p className="eyebrow">Zimlo mobile</p>
      <h1>这台浏览器尚未配对</h1>
      <p>在 Mac 上运行 <code>zimlo start --lan</code>，打开本机 Zimlo 的 Profile，生成二维码并用手机 Safari 扫描。</p>
      {error && <div className="error-banner">{error}</div>}
    </main>
  );
}

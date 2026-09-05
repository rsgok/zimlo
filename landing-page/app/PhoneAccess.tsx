import { headers } from "next/headers";

export async function PhoneAccess() {
  const configured = (await headers()).get("x-zimlo-testflight-url") ?? "";
  const url = /^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]+$/u.test(configured) ? configured : null;
  return <div className="phone-access" aria-labelledby="phone-access-title">
    <h3 id="phone-access-title">1. Get the iPhone app</h3>
    {url ? <a className="ios-button ios-button--acid" href={url} rel="noreferrer">Open TestFlight ↗</a> : <p>iPhone access is by invitation. A public TestFlight link is not available yet. Installing the Mac companion alone does not grant iPhone access.</p>}
    <h3>2. Connect a Mac or Linux device</h3>
    <p>On Mac, install the companion below. Connect either Codex or Claude Code, open a project, then scan the pairing code inside Zimlo on iPhone.</p>
    <details><summary>Using a Linux server?</summary><p>Linux works without a desktop. Use the Linux archive supplied with your Beta invitation, extract it, then run:</p><pre><code>{"./install.sh\nzimlo integrations install --target cli\nzimlo pair"}</code></pre><p>Scan the code inside Zimlo. Keep the service running on the server; no inbound public port is required.</p></details>
    <h3>3. Confirm your first operation</h3>
    <p>Send a short task or reply from iPhone. Wait for the source device to confirm it received the operation before leaving setup.</p>
  </div>;
}

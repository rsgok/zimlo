export function proxyURLFor(input: URL, environment: NodeJS.ProcessEnv = process.env): string | null {
  const proxy = input.protocol === "https:" || input.protocol === "wss:"
    ? environment.HTTPS_PROXY ?? environment.https_proxy ?? environment.HTTP_PROXY ?? environment.http_proxy
    : environment.HTTP_PROXY ?? environment.http_proxy;
  if (!proxy || bypassesProxy(input, environment.NO_PROXY ?? environment.no_proxy ?? "")) return null;
  try {
    const parsed = new URL(proxy);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function bypassesProxy(input: URL, noProxy: string): boolean {
  const hostname = input.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const port = input.port || defaultPort(input.protocol);
  return noProxy.split(",").some((rawRule) => {
    const rule = rawRule.trim().toLowerCase();
    if (!rule) return false;
    if (rule === "*") return true;
    const [ruleHost = "", rulePort] = splitHostAndPort(rule);
    if (rulePort && rulePort !== port) return false;
    const normalized = ruleHost.replace(/^\*?\./u, "");
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
}

function splitHostAndPort(value: string): [string, string?] {
  if (value.startsWith("[")) {
    const closing = value.indexOf("]");
    if (closing >= 0) {
      const host = value.slice(1, closing);
      return value[closing + 1] === ":" ? [host, value.slice(closing + 2)] : [host];
    }
  }
  const colon = value.lastIndexOf(":");
  if (colon > 0 && value.indexOf(":") === colon) return [value.slice(0, colon), value.slice(colon + 1)];
  return [value];
}

function defaultPort(protocol: string): string {
  return protocol === "https:" || protocol === "wss:" ? "443" : "80";
}

export type PairingTransport = "cloud" | "lan";

export interface PairingEndpoint {
  baseURL: string;
  transport: PairingTransport;
}

export function selectPairingEndpoint(input: {
  cloudReady: boolean;
  cloudURL: string | null;
  lanEnabled: boolean;
  lanHost: string | null;
  port: number;
}): PairingEndpoint | null {
  if (input.cloudReady && input.cloudURL) {
    return { baseURL: input.cloudURL, transport: "cloud" };
  }
  if (input.lanEnabled && input.lanHost) {
    return { baseURL: `http://${input.lanHost}:${input.port}`, transport: "lan" };
  }
  return null;
}

export function pairingURLForBase(pairURL: string, baseURL: string): string | null {
  try {
    const source = new URL(pairURL);
    if (!source.hash) return null;
    const target = new URL(baseURL);
    target.pathname = "/";
    target.search = "";
    target.hash = source.hash;
    return target.toString();
  } catch {
    return null;
  }
}

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

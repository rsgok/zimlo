// Bound network buffers and decryptions across Feed, Task and history viewers.
let active = 0;
const waiting: Array<() => void> = [];
export async function withMaterialTransferSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 3) await new Promise<void>((resolve) => waiting.push(resolve));
  else active += 1;
  try { return await work(); }
  finally {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }
}

// Generates the Wang regolith bank off the main thread (~2 s for 512 px tiles).

import { generateWangBank } from "./wangBank";

self.onmessage = () => {
  const bank = generateWangBank();
  // Transfer the pixel buffers instead of copying them.
  (self as unknown as Worker).postMessage(bank, [bank.albedoRough.buffer, bank.normal.buffer]);
};

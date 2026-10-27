import fs from "node:fs/promises";
import crypto from "node:crypto";
import { constants } from "node:fs";

// Hash the complete file, so migration never relies on matching names or samples.
export async function fileHash(
  file: string,
  cancelled = () => false,
): Promise<string> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Expected a regular media file");
    const hash = crypto.createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      if (cancelled()) throw new Error("Operation cancelled");
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error(
        "File changed while being indexed; scan again after copying finishes",
      );
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

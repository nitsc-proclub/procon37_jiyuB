import { promises as fs } from "node:fs";
import { getRecordDirectory, getRecordFilePath } from "./demoRecordFiles";

// Retain only summaries, never the much larger drawing metadata. All paths are
// validated on every scan, including cache hits and externally replaced files.
export function createDemoRecordLister<M extends { files?: { audio?: string } }, S>(
  read: (directory: string) => Promise<M>,
  summarize: (id: string, directory: string, metadata: M) => Promise<S | null>,
) {
  const cache = new Map<string, { metadataStamp: string; audioName?: string; audioStamp: string; summary: S | null }>();
  const stamp = async (directory: string, name: string) => {
    try {
      const file = await getRecordFilePath(directory, name);
      const info = await fs.stat(file, { bigint: true });
      return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  };
  let inFlight: Promise<S[]> | undefined;
  return (root: string): Promise<S[]> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const entries = (await fs.readdir(root, { withFileTypes: true }).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      })).filter(entry => entry.isDirectory());
      const present = new Set(entries.map(entry => entry.name));
      for (const id of cache.keys()) if (!present.has(id)) cache.delete(id);
      const results: (S | null)[] = new Array(entries.length).fill(null);
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(8, entries.length) }, async () => {
        for (let index = cursor++; index < entries.length; index = cursor++) {
          const id = entries[index].name;
          try {
            const directory = await getRecordDirectory(root, id);
            const metadataStamp = await stamp(directory, "metadata.json");
            const previous = cache.get(id);
            if (previous && previous.metadataStamp === metadataStamp &&
              previous.audioStamp === (previous.audioName ? await stamp(directory, previous.audioName) : "none")) {
              results[index] = previous.summary;
              continue;
            }
            const metadata = await read(directory);
            const audioName = metadata.files?.audio;
            const audioStamp = audioName ? await stamp(directory, audioName) : "none";
            const summary = await summarize(id, directory, metadata);
            // Do not cache a snapshot that changed while it was being read.
            if (metadataStamp === await stamp(directory, "metadata.json") &&
              audioStamp === (audioName ? await stamp(directory, audioName) : "none")) {
              cache.set(id, { metadataStamp, audioName, audioStamp, summary });
            } else cache.delete(id);
            results[index] = summary;
          } catch {
            cache.delete(id);
          }
        }
      }));
      return results.filter((value): value is S => value !== null);
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}

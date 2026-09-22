import path from "node:path";
import { promises as fs } from "node:fs";

export class DemoRecordRequestError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

export const demoRecordErrorStatus = (error: unknown) => {
  if (error instanceof DemoRecordRequestError) return error.statusCode;
  if (error instanceof SyntaxError || error instanceof URIError) return 400;
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return 404;
  return 500;
};

/** IDs and filenames are single portable names, never relative paths. */
export const validateDemoRecordName = (name: string) => {
  // Control characters are intentionally rejected as invalid filesystem names.
  // eslint-disable-next-line no-control-regex
  if (!name || name === "." || name === ".." || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new DemoRecordRequestError("Invalid demo record path");
  }
};

const isStrictlyInside = (parent: string, target: string) => {
  const relative = path.relative(parent, target);
  return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export const getRecordDirectory = async (recordsRoot: string, recordId: string, allowMissing = false) => {
  validateDemoRecordName(recordId);
  const directory = path.resolve(recordsRoot, recordId);
  if (!isStrictlyInside(path.resolve(recordsRoot), directory)) throw new DemoRecordRequestError("Invalid demo record path");
  let info;
  try {
    info = await fs.lstat(directory);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return directory;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new DemoRecordRequestError("Invalid demo record directory");
  const [realRoot, realDirectory] = await Promise.all([fs.realpath(recordsRoot), fs.realpath(directory)]);
  if (!isStrictlyInside(realRoot, realDirectory)) throw new DemoRecordRequestError("Invalid demo record directory");
  return directory;
};

export const getRecordFilePath = async (directory: string, filename: string) => {
  validateDemoRecordName(filename);
  const filePath = path.resolve(directory, filename);
  if (!isStrictlyInside(directory, filePath)) throw new DemoRecordRequestError("Invalid demo record file path");
  const info = await fs.lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) throw new DemoRecordRequestError("Invalid demo record file");
  const [realDirectory, realFile] = await Promise.all([fs.realpath(directory), fs.realpath(filePath)]);
  if (!isStrictlyInside(realDirectory, realFile)) throw new DemoRecordRequestError("Invalid demo record file path");
  return filePath;
};

// Only match the exact small PCM format used by createSilentPlaybackAudio.
// Existing genuine recordings, including other WAV encodings, remain playable.
const isAnimationClockHeader = (header: Buffer, fileSize: number) => header.length === 44 && fileSize > 44
  && header.toString("ascii", 0, 4) === "RIFF" && header.readUInt32LE(4) === fileSize - 8
  && header.toString("ascii", 8, 16) === "WAVEfmt " && header.readUInt32LE(16) === 16
  && header.readUInt16LE(20) === 1 && header.readUInt16LE(22) === 1
  && header.readUInt32LE(24) === 8_000 && header.readUInt32LE(28) === 16_000
  && header.readUInt16LE(32) === 2 && header.readUInt16LE(34) === 16
  && header.toString("ascii", 36, 40) === "data" && header.readUInt32LE(40) === fileSize - 44;

export const isAnimationClockAudio = (audio: Buffer) => isAnimationClockHeader(audio.subarray(0, 44), audio.length)
  && audio.subarray(44).every((byte) => byte === 0);

export const isAnimationClockFile = async (filePath: string) => {
  const file = await fs.open(filePath, "r");
  try {
    const size = (await file.stat()).size;
    const header = Buffer.alloc(44);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== 44 || !isAnimationClockHeader(header, size)) return false;
    const chunk = Buffer.alloc(64 * 1024);
    for (let offset = 44; offset < size;) {
      const { bytesRead: count } = await file.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (!count || !chunk.subarray(0, count).every((byte) => byte === 0)) return false;
      offset += count;
    }
    return true;
  } finally {
    await file.close();
  }
};

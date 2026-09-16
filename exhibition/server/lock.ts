import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';

export async function acquireServerLock(dataDir: string): Promise<() => Promise<void>> {
  const lockPath = path.join(dataDir, 'server.lock');
  if (process.platform === 'win32') {
    // Windows releases named pipes even after Stop-Process or a crash. A PID
    // file alone can mistake a reused PID for a still-running server.
    const directory = (await fs.realpath(dataDir)).toLowerCase();
    const key = createHash('sha256').update(directory).digest('hex');
    const guard = createServer(socket => socket.end());
    await new Promise<void>((resolve, reject) => {
      guard.once('error', reject);
      guard.listen(`\\\\.\\pipe\\ekaki-exhibition-${key}`, () => {
        guard.removeListener('error', reject);
        resolve();
      });
    }).catch(error => {
      if (['EADDRINUSE', 'EACCES'].includes(error.code)) throw new Error('展示サーバーは起動済み、または保存先のロックを取得できません。');
      throw error;
    });
    try { await fs.writeFile(lockPath, String(process.pid)); }
    catch (error) { guard.close(); throw error; }
    return async () => {
      await fs.unlink(lockPath).catch(() => {});
      await new Promise<void>((resolve, reject) => guard.close(error => error ? reject(error) : resolve()));
    };
  }
  try {
    const pid = Number(await fs.readFile(lockPath, 'utf8'));
    try { process.kill(pid, 0); throw new Error(`展示サーバーは起動済みです (PID ${pid})`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    await fs.unlink(lockPath);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await fs.writeFile(lockPath, String(process.pid), { flag: 'wx' });
  return async () => { await fs.unlink(lockPath).catch(() => {}); };
}

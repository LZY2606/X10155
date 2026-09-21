import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { Store } from '../core/store.js';
import { buildSeedRuns } from './seed.js';

/**
 * JSON 文件持久化。首次启动（文件不存在）时导入确定性演示数据。
 * 保存采用临时文件 + rename 的原子方式，避免半截文件破坏仓库状态。
 */
export function loadOrSeedStore(file: string): Store {
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8');
    return Store.fromJSON(JSON.parse(raw));
  }
  const store = new Store();
  const seeded = buildSeedRuns();
  store.importRuns(
    seeded.runs.map((run, index) => ({
      ...run,
      fingerprint: seeded.fingerprints[index],
    })),
  );
  saveStore(file, store);
  return store;
}

export function saveStore(file: string, store: Store): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(store.toJSON(), null, 2), 'utf8');
  renameSync(tmp, file);
}

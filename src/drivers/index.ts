import type { ConnectionConfig } from '../types.js';
import type { DbDriver } from './driver.js';
import { PostgresDriver } from './postgres.js';
import { MysqlDriver } from './mysql.js';
import { SqliteDriver } from './sqlite.js';

export function createDriver(config: ConnectionConfig, password: string | undefined): DbDriver {
  switch (config.kind) {
    case 'postgres':
      return new PostgresDriver(config, password);
    case 'mysql':
      return new MysqlDriver(config, password);
    case 'sqlite':
      return new SqliteDriver(config);
    default: {
      const exhaustiveCheck: never = config.kind;
      throw new Error(`未対応の DB 種別です: ${String(exhaustiveCheck)}`);
    }
  }
}

export type { DbDriver } from './driver.js';

import * as vscode from 'vscode';
import type { ConnectionConfig } from '../types.js';

const CONFIG_SECTION = 'dbRover';
const CONFIG_KEY = 'connections';

function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'connection';
}

function ensureUniqueId(base: string, existingIds: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (existingIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** 設定に保存されている接続定義を読み込む。id が無いものには name から自動生成した id を補う。 */
export function getConnections(): ConnectionConfig[] {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const raw = config.get<ConnectionConfig[]>(CONFIG_KEY, []);
  const ids = new Set<string>();
  return raw.map((entry) => {
    let id = entry.id;
    if (!id || ids.has(id)) {
      id = ensureUniqueId(slugify(entry.name), ids);
    }
    ids.add(id);
    return { ...entry, id };
  });
}

export function getConnectionById(id: string): ConnectionConfig | undefined {
  return getConnections().find((connection) => connection.id === id);
}

function configurationTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

export async function saveConnections(connections: ConnectionConfig[]): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update(CONFIG_KEY, connections, configurationTarget());
}

export async function addConnection(newConnection: Omit<ConnectionConfig, 'id'> & { id?: string }): Promise<ConnectionConfig> {
  const connections = getConnections();
  const ids = new Set(connections.map((connection) => connection.id));
  const id =
    newConnection.id && !ids.has(newConnection.id)
      ? newConnection.id
      : ensureUniqueId(slugify(newConnection.name), ids);
  const withId: ConnectionConfig = { ...newConnection, id };
  await saveConnections([...connections, withId]);
  return withId;
}

/** 既存の接続定義を差し替える。id は変更しない。 */
export async function updateConnection(id: string, updated: Omit<ConnectionConfig, 'id'>): Promise<ConnectionConfig> {
  const connections = getConnections();
  const index = connections.findIndex((connection) => connection.id === id);
  if (index < 0) {
    throw new Error('編集対象の接続が見つかりません。設定が削除された可能性があります。');
  }
  const withId: ConnectionConfig = { ...updated, id };
  const next = [...connections];
  next[index] = withId;
  await saveConnections(next);
  return withId;
}

export async function removeConnectionConfig(id: string): Promise<void> {
  const connections = getConnections().filter((connection) => connection.id !== id);
  await saveConnections(connections);
}

function passwordKey(id: string): string {
  return `dbRover.password:${id}`;
}

export function getPassword(secrets: vscode.SecretStorage, id: string): Thenable<string | undefined> {
  return secrets.get(passwordKey(id));
}

export function setPassword(secrets: vscode.SecretStorage, id: string, password: string): Thenable<void> {
  return secrets.store(passwordKey(id), password);
}

export function deletePassword(secrets: vscode.SecretStorage, id: string): Thenable<void> {
  return secrets.delete(passwordKey(id));
}

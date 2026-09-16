import * as vscode from 'vscode';
import type { AiServerStatus } from '../types.js';

/** package.json の contributes.mcpServerDefinitionProviders[0].id と一致させること。 */
export const MCP_PROVIDER_ID = 'dbRover.mcp';

export interface McpProviderSource {
  getState: () => AiServerStatus;
  /** VS Code の `McpHttpServerDefinition.headers` 経路で使うトークン（実値）。 */
  getToken: () => string | undefined;
  /** サーバの起動・停止・トークン回転のたびに発火させること。 */
  onDidChangeState: vscode.Event<unknown>;
}

/**
 * `vscode.lm.registerMcpServerDefinitionProvider` の薄いラッパ。
 *
 * VS Code 自身（Copilot）向けの経路は `Authorization: Bearer` ヘッダを使う
 * （Claude Code など外部 CLI 向けのパス埋め込みトークンとは別経路）。
 * サーバが停止中、またはトークンが無いときは空配列を返す。
 *
 * `vscode.lm.registerMcpServerDefinitionProvider` が無い（フォークで未実装）環境では
 * 実行時ガードし、activate を落とさず undefined を返す。
 */
export function registerMcpProvider(source: McpProviderSource, version: string): vscode.Disposable | undefined {
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== 'function') {
    return undefined;
  }

  const onDidChangeMcpServerDefinitionsEmitter = new vscode.EventEmitter<void>();
  const stateListener = source.onDidChangeState(() => onDidChangeMcpServerDefinitionsEmitter.fire());

  const providerDisposable = vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
    onDidChangeMcpServerDefinitions: onDidChangeMcpServerDefinitionsEmitter.event,
    provideMcpServerDefinitions: () => {
      const state = source.getState();
      const token = source.getToken();
      if (!state.running || state.port === undefined || !token) {
        return [];
      }
      const uri = vscode.Uri.parse(`http://127.0.0.1:${state.port}/mcp`);
      return [
        new vscode.McpHttpServerDefinition('DB Rover', uri, { Authorization: `Bearer ${token}` }, `${version}-${state.port}`),
      ];
    },
  });

  return vscode.Disposable.from(providerDisposable, stateListener, onDidChangeMcpServerDefinitionsEmitter);
}

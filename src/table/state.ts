import * as vscode from 'vscode';
import type { GridLayoutState } from '../types.js';

function layoutKey(connectionId: string, schema: string, table: string): string {
  return `dbRover.grid:${connectionId}:${schema}.${table}`;
}

export function getGridLayout(
  workspaceState: vscode.Memento,
  connectionId: string,
  schema: string,
  table: string,
): GridLayoutState | undefined {
  return workspaceState.get<GridLayoutState>(layoutKey(connectionId, schema, table));
}

export async function saveGridLayout(
  workspaceState: vscode.Memento,
  connectionId: string,
  schema: string,
  table: string,
  layout: GridLayoutState,
): Promise<void> {
  await workspaceState.update(layoutKey(connectionId, schema, table), layout);
}

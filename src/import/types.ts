import type { Item } from '../types';

/** A parsed item before it is assigned to a Keyvault vault. */
export type ImportedItem = Omit<Item, 'id' | 'vaultId'> & { vaultName: string };

export interface ImportResult {
  format: '1pux' | 'csv';
  items: ImportedItem[];
  /** Things we saw but could not bring over (documents, file attachments, unreadable rows). */
  skipped: { title: string; reason: string }[];
}

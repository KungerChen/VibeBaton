import type { WorkflowGraph } from '../types/graph';
import { validateGraph } from './localSimulator';

export const RECIPE_HASH_PREFIX = '#recipe=';
export const MAX_RECIPE_HASH_CHARS = 65536;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(encoded: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('Malformed recipe encoding');
  }
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (base64.length % 4)) % 4;
  const binary = atob(`${base64}${'='.repeat(padding)}`);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function encodeRecipeHash(graph: WorkflowGraph): string {
  const bytes = new TextEncoder().encode(JSON.stringify(graph));
  const hash = `${RECIPE_HASH_PREFIX}${bytesToBase64Url(bytes)}`;
  if (hash.length > MAX_RECIPE_HASH_CHARS) {
    throw new Error(
      `Workflow graph is too large for a URL hash (${hash.length} > ${MAX_RECIPE_HASH_CHARS} chars)`,
    );
  }
  return hash;
}

export function decodeRecipeHash(
  hash: string,
): { graph: WorkflowGraph } | { error: string } | null {
  if (!hash.startsWith(RECIPE_HASH_PREFIX)) return null;
  if (hash.length > MAX_RECIPE_HASH_CHARS) {
    return { error: `Shared recipe exceeds maximum hash length (${MAX_RECIPE_HASH_CHARS})` };
  }
  const payload = hash.slice(RECIPE_HASH_PREFIX.length);
  if (!payload) return { error: 'Empty recipe payload' };

  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToBytes(payload));
    const parsed = JSON.parse(json) as WorkflowGraph;
    const validation = validateGraph(parsed);
    if (!validation.valid) {
      return { error: validation.errors[0] ?? 'Invalid workflow graph' };
    }
    const badRoleIndex = parsed.nodes.findIndex(
      ({ role }) => role !== undefined && typeof role !== 'string',
    );
    if (badRoleIndex !== -1) {
      return { error: `nodes[${badRoleIndex}].role must be a string` };
    }
    return { graph: parsed };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function buildShareUrl(graph: WorkflowGraph, currentHref: string): string {
  const baseHref = currentHref.split('#')[0];
  return `${baseHref}${encodeRecipeHash(graph)}`;
}

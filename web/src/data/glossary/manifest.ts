import type { GlossaryCategory } from './types';

/**
 * The FINAL curated term ids, in display order. Each category module must export entries whose
 * ids equal this list exactly (same order). The first two ids of every category are the golden
 * entries written in M2-T1; the rest are filled in by M2-T2..T7.
 */
export const GLOSSARY_TERM_IDS = {
  vibebaton: [
    'rfc', 'plan-dag', 'milestone', 'gate', 'critical-task', 'routine-task', 'battle-report',
    'waiting-human', 'golden-example', 'allowed-paths', 'baton-backup', 'guided-mode', 'pro-mode',
    'studio', 'canvas', 'preset', 'recipe', 'lineup', 'role', 'provider', 'cli-driver',
    'budget-profile', 'specialist-panel', 'synthesizer', 'mechanical-gate', 'ai-review',
    'final-gate', 'sign-off', 'rollback', 'circuit-breaker', 'quota-cooldown', 'fallback-chain',
    'daemon', 'overnight-run', 'dev-branch', 'blueprint-card', 'brainstorm', 'case-bundle',
  ],
  git: [
    'repository', 'commit', 'branch', 'merge', 'rebase', 'worktree', 'tag', 'stash', 'diff',
    'conflict', 'clone', 'remote', 'push', 'pull', 'fetch', 'origin', 'main-branch', 'head',
    'detached-head', 'staging-area', 'working-tree', 'gitignore', 'commit-message', 'commit-hash',
    'log', 'checkout', 'switch', 'reset', 'revert', 'cherry-pick', 'squash', 'fast-forward',
    'upstream', 'pull-request', 'fork', 'blame', 'submodule', 'hook',
  ],
  ai: [
    'llm', 'token', 'context-window', 'prompt', 'system-prompt', 'temperature', 'hallucination',
    'agent', 'tool-call', 'mcp', 'model', 'reasoning-effort', 'inference', 'fine-tuning',
    'embedding', 'rag', 'multi-agent', 'orchestration', 'coding-agent', 'subscription-plan',
    'api-key', 'prompt-caching', 'input-tokens', 'output-tokens', 'streaming', 'structured-output',
    'json-mode', 'few-shot', 'chain-of-thought', 'guardrails', 'model-routing', 'evals',
    'benchmark', 'knowledge-cutoff', 'multimodal', 'vibe-coding', 'human-in-the-loop',
    'headless-mode',
  ],
  engineering: [
    'unit-test', 'integration-test', 'ci', 'lint', 'type-check', 'refactor', 'tech-debt', 'dag',
    'idempotent', 'atomic-write', 'end-to-end-test', 'regression', 'test-coverage', 'mock',
    'fixture', 'assertion', 'build', 'dependency', 'package-manager', 'lockfile', 'semver',
    'monorepo', 'module', 'interface', 'contract', 'schema', 'acceptance-criteria', 'spec',
    'code-review', 'deployment', 'environment-variable', 'config-file', 'logging',
    'race-condition', 'concurrency', 'cli', 'sandbox', 'backup',
  ],
  web_http: [
    'http', 'rest', 'json', 'status-code', 'sse', 'websocket', 'cors', 'localhost', 'port',
    'endpoint', 'api', 'url', 'query-string', 'request', 'response', 'header', 'body',
    'get-request', 'post-request', 'put-request', 'frontend', 'backend', 'server', 'client',
    'browser', 'dom', 'html', 'css', 'javascript', 'typescript', 'react', 'vite', 'cookie',
    'local-storage', 'https', 'dns', 'proxy', 'latency',
  ],
  errors: [
    '404', '500', 'timeout', 'enoent', 'eaddrinuse', 'merge-conflict', 'type-error',
    'import-error', 'rate-limit', 'auth-error', '400', '401', '403', '409', '429', '502', '503',
    'syntax-error', 'null-reference', 'stack-trace', 'exit-code', 'command-not-found',
    'permission-denied', 'eacces', 'econnrefused', 'out-of-memory', 'dependency-conflict',
    'version-mismatch', 'encoding-error', 'path-too-long', 'file-locked', 'dirty-working-tree',
    'detached-head-error', 'test-failure', 'flaky-test', 'infinite-loop', 'deadlock',
    'quota-exceeded',
  ],
} as const satisfies Record<GlossaryCategory, readonly string[]>;

export const ALL_GLOSSARY_TERM_IDS: readonly string[] = Object.values(GLOSSARY_TERM_IDS).flat();

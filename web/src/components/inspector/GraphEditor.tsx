import { useState, type FormEvent } from 'react';
import type { WorkflowEdge, WorkflowNode } from '../../types/graph';
import type { RightInspectorProps } from '../types';

type EditableFieldProps = {
  name: string;
  placeholder?: string;
  list?: string;
} & (
  | { type?: 'text'; value: string | undefined; onCommit(value: string): void }
  | { type: 'number'; value: number | undefined; onCommit(value: number | undefined): void }
);

function EditableField(props: EditableFieldProps) {
  const { name, type = 'text', placeholder, list } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const savedValue = props.value?.toString() ?? '';

  return (
    <label className="right-inspector__field">
      <span>{name}</span>
      <input
        className="input"
        name={name}
        type={type}
        value={draft ?? savedValue}
        placeholder={placeholder}
        list={list}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={({ currentTarget: input }) => {
          setDraft(null);
          if (!input.validity.valid || input.value === savedValue) return;
          if (props.type === 'number') {
            props.onCommit(input.value === '' ? undefined : input.valueAsNumber);
          } else {
            props.onCommit(input.value);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

type NodeEditorProps = Pick<RightInspectorProps, 'mode' | 'client' | 'onUpdateNode' | 'onToast'> & {
  node: WorkflowNode;
  providerListId: string;
};

export function NodeEditor({ node, mode, client, providerListId, onUpdateNode, onToast }: NodeEditorProps) {
  const [saving, setSaving] = useState(false);
  const { id, type, label, role, config } = node;
  const { provider, model, max_loops: maxLoops } = config ?? {};
  const hasLoopField = type === 'gate_node' || type === 'reviewer_node' || maxLoops !== undefined;

  async function saveRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode !== 'local' || !role || saving) return;
    const fields = new FormData(event.currentTarget);
    const roleName = String(fields.get('role') ?? '');
    const providerName = String(fields.get('provider') ?? '') || undefined;
    const modelName = String(fields.get('model') ?? '');
    if (!roleName) return;

    setSaving(true);
    try {
      await client.updateRole(roleName, { provider: providerName, model: modelName });
      onToast(`Saved ${roleName} → ${modelName} (hot-reloaded)`, 'ok');
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error), 'err');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="right-inspector__section" onSubmit={(event) => void saveRole(event)}>
      <h2 className="panel__title">Node <code>{id}</code></h2>
      <EditableField name="label" value={label} onCommit={(value) => onUpdateNode(id, { label: value })} />
      <EditableField name="role" value={role} onCommit={(value) => onUpdateNode(id, { role: value })} />
      <EditableField
        name="provider"
        value={typeof provider === 'string' ? provider : undefined}
        list={mode === 'local' ? providerListId : undefined}
        onCommit={(value) => onUpdateNode(id, { provider: value })}
      />
      <EditableField
        name="model"
        value={typeof model === 'string' ? model : undefined}
        placeholder="deepseek-v4.1-flash@max"
        onCommit={(value) => onUpdateNode(id, { model: value })}
      />
      {hasLoopField && (
        <EditableField
          name="max_loops"
          type="number"
          value={typeof maxLoops === 'number' ? maxLoops : undefined}
          onCommit={(value) => onUpdateNode(id, { max_loops: value })}
        />
      )}
      {mode === 'local' && role && (
        <button className="btn btn--primary" type="submit" disabled={saving}>
          Save to baton.toml (Hot-Reload)
        </button>
      )}
      {mode === 'demo' && (
        <p className="right-inspector__muted">Run <code>baton ui</code> locally to hot-swap models</p>
      )}
    </form>
  );
}

export function EdgeEditor({ edge, onUpdateEdge }: Pick<RightInspectorProps, 'onUpdateEdge'> & { edge: WorkflowEdge }) {
  const { id, sourceHandle, targetHandle, max_loops: maxLoops } = edge;
  return (
    <div className="right-inspector__section">
      <h2 className="panel__title">Edge <code>{id}</code></h2>
      <EditableField
        name="sourceHandle"
        value={sourceHandle}
        onCommit={(value) => onUpdateEdge(id, { sourceHandle: value || undefined })}
      />
      <EditableField
        name="targetHandle"
        value={targetHandle}
        onCommit={(value) => onUpdateEdge(id, { targetHandle: value || undefined })}
      />
      <EditableField
        name="max_loops"
        type="number"
        value={maxLoops}
        onCommit={(value) => onUpdateEdge(id, { max_loops: value })}
      />
    </div>
  );
}

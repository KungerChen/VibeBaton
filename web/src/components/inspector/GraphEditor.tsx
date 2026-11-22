import { useState, type FormEvent } from 'react';
import { useI18n } from '../../i18n';
import type { WorkflowEdge, WorkflowNode } from '../../types/graph';
import type { RightInspectorProps } from '../types';

type EditableFieldProps = {
  name: string;
  label: string;
  placeholder?: string;
  list?: string;
} & (
  | { type?: 'text'; value: string | undefined; onCommit(value: string): void }
  | { type: 'number'; value: number | undefined; onCommit(value: number | undefined): void }
);

function EditableField(props: EditableFieldProps) {
  const { name, label, type = 'text', placeholder, list } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const savedValue = props.value?.toString() ?? '';

  return (
    <label className="right-inspector__field">
      <span>{label}</span>
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
  const { messages } = useI18n();
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
      onToast(messages.toasts.savedRole(roleName, modelName), 'ok');
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error), 'err');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="right-inspector__section" onSubmit={(event) => void saveRole(event)}>
      <h2 className="panel__title">{messages.inspector.nodeHeadingPrefix} <code>{id}</code></h2>
      <EditableField
        name="label"
        label={messages.inspector.fields.label}
        value={label}
        onCommit={(value) => onUpdateNode(id, { label: value })}
      />
      <EditableField
        name="role"
        label={messages.inspector.fields.role}
        value={role}
        onCommit={(value) => onUpdateNode(id, { role: value })}
      />
      <EditableField
        name="provider"
        label={messages.inspector.fields.provider}
        value={typeof provider === 'string' ? provider : undefined}
        list={mode === 'local' ? providerListId : undefined}
        onCommit={(value) => onUpdateNode(id, { provider: value })}
      />
      <EditableField
        name="model"
        label={messages.inspector.fields.model}
        value={typeof model === 'string' ? model : undefined}
        placeholder="deepseek-v4.1-flash@max"
        onCommit={(value) => onUpdateNode(id, { model: value })}
      />
      {hasLoopField && (
        <EditableField
          name="max_loops"
          label={messages.inspector.fields.maxLoops}
          type="number"
          value={typeof maxLoops === 'number' ? maxLoops : undefined}
          onCommit={(value) => onUpdateNode(id, { max_loops: value })}
        />
      )}
      {mode === 'local' && role && (
        <button className="btn btn--primary" type="submit" disabled={saving}>
          {messages.inspector.saveHotReload}
        </button>
      )}
      {mode === 'demo' && (
        <p className="right-inspector__muted">
          {messages.inspector.demoHotSwapHintPrefix}
          <code>baton ui</code>
          {messages.inspector.demoHotSwapHintSuffix}
        </p>
      )}
    </form>
  );
}

export function EdgeEditor({ edge, onUpdateEdge }: Pick<RightInspectorProps, 'onUpdateEdge'> & { edge: WorkflowEdge }) {
  const { messages } = useI18n();
  const { id, sourceHandle, targetHandle, max_loops: maxLoops } = edge;
  return (
    <div className="right-inspector__section">
      <h2 className="panel__title">{messages.inspector.edgeHeadingPrefix} <code>{id}</code></h2>
      <EditableField
        name="sourceHandle"
        label={messages.inspector.fields.sourceHandle}
        value={sourceHandle}
        onCommit={(value) => onUpdateEdge(id, { sourceHandle: value || undefined })}
      />
      <EditableField
        name="targetHandle"
        label={messages.inspector.fields.targetHandle}
        value={targetHandle}
        onCommit={(value) => onUpdateEdge(id, { targetHandle: value || undefined })}
      />
      <EditableField
        name="max_loops"
        label={messages.inspector.fields.maxLoops}
        type="number"
        value={maxLoops}
        onCommit={(value) => onUpdateEdge(id, { max_loops: value })}
      />
    </div>
  );
}

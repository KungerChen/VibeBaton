import { LoaderCircle } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { BatonApiClient } from '../../api/client';
import { useI18n } from '../../i18n';
import { MESSAGES } from '../../i18n/messages';
import type { DoctorRoleRequest, DoctorRoleResult, WorkflowEdge, WorkflowNode } from '../../types/graph';
import { resolveDoctorTarget, serializeModelPin } from '../nodes/readiness';
import type { NodeDoctorProps, RightInspectorProps } from '../types';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Input, Label } from '../ui/input';
import { Switch } from '../ui/switch';

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
      <Label className="pointer-events-none">{label}</Label>
      <Input
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

const DOCTOR_DEADLINE_MS = 5000;
let doctorSequence = 0;

export async function probeDoctorRole(
  client: Pick<BatonApiClient, 'doctorRole'>,
  request: DoctorRoleRequest,
): Promise<DoctorRoleResult | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = client.doctorRole(request);
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), DOCTOR_DEADLINE_MS);
    });
    return await Promise.race([probe, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

type DoctorFeedback =
  | { state: 'pending' }
  | { state: 'timeout' }
  | { state: 'error'; detail: string }
  | { state: 'result'; result: DoctorRoleResult };

function formatDoctorInstallHint(result: DoctorRoleResult, dshHint: string): string {
  if (result.provider === 'dsh_opencode' && (
    /opencode/i.test(result.install_hint)
    || result.install_hint === MESSAGES.en.nodeReadiness.dshInstallHint
    || result.install_hint === MESSAGES.zh.nodeReadiness.dshInstallHint
  )) {
    return dshHint;
  }
  return result.install_hint;
}

function DoctorControl({ client, request, onDoctorResult }: Pick<NodeDoctorProps, 'onDoctorResult'> & {
  client: BatonApiClient;
  request: DoctorRoleRequest;
}) {
  const { messages: { nodeReadiness } } = useI18n();
  const [feedback, setFeedback] = useState<DoctorFeedback | null>(null);
  const pending = feedback?.state === 'pending';
  const result = feedback?.state === 'result' ? feedback.result : null;
  const visibleInstallHint = result ? formatDoctorInstallHint(result, nodeReadiness.dshInstallHint) : '';

  useEffect(() => {
    setFeedback(null);
  }, [client, request.provider, request.role, request.model]);

  async function runDoctor() {
    const sequence = ++doctorSequence;
    setFeedback({ state: 'pending' });
    try {
      const result = await probeDoctorRole(client, request);
      if (!result) {
        setFeedback({ state: 'timeout' });
        return;
      }
      const provider = result.provider || request.provider;
      const usesRoleProvider = !request.provider && !request.model?.includes(':');
      if (provider) onDoctorResult({ ...result, provider }, sequence, usesRoleProvider ? request.role : undefined);
      setFeedback({ state: 'result', result });
    } catch (error) {
      setFeedback({ state: 'error', detail: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <div className="grid gap-1.5">
      <Button
        type="button"
        className="justify-self-start"
        disabled={pending || (!request.provider && !request.role)}
        aria-busy={pending}
        onClick={() => void runDoctor()}
      >
        {pending && <LoaderCircle size={14} className="motion-safe:animate-spin" aria-hidden="true" />}
        {nodeReadiness.doctorButton}
      </Button>
      <div role="status" className="grid gap-1 break-words text-xs text-muted-foreground empty:hidden">
        {result && (
          <>
            {(result.ok || !visibleInstallHint) && (
              <strong className="text-foreground">{nodeReadiness.latency(result.latency_ms)}</strong>
            )}
            {result.detail && <span>{result.detail}</span>}
            {!result.ok && visibleInstallHint && (
              <span><strong className="text-foreground">{nodeReadiness.installHint}</strong> · {visibleInstallHint}</span>
            )}
          </>
        )}
        {feedback?.state === 'timeout' && nodeReadiness.doctorTimeout}
        {feedback?.state === 'error' && feedback.detail}
      </div>
    </div>
  );
}

type NodeEditorProps = Pick<RightInspectorProps, 'mode' | 'client' | 'onUpdateNode' | 'onToast'> & NodeDoctorProps & {
  node: WorkflowNode;
  providerListId: string;
};

export function NodeEditor({
  node, mode, client, providerListId, onUpdateNode, onToast, doctorTargets, onDoctorResult,
}: NodeEditorProps) {
  const { messages } = useI18n();
  const [saving, setSaving] = useState(false);
  const pinId = useId();
  const { id, type, label, role, config } = node;
  const { provider, model, max_loops: maxLoops, pinned, assigned_model } = config ?? {};
  const modelFields = {
    role,
    provider: typeof provider === 'string' ? provider : undefined,
    model: typeof model === 'string' ? model : undefined,
  };
  const isPinned = pinned === true;
  const assignedModel = typeof assigned_model === 'string' ? assigned_model.trim() || undefined : undefined;
  const target = resolveDoctorTarget({ ...modelFields, pinned: isPinned, assigned_model: assignedModel }, doctorTargets);
  const { request } = target;
  const hasLoopField = type === 'gate_node' || type === 'reviewer_node' || maxLoops !== undefined;

  function updateModel(patch: Pick<DoctorRoleRequest, 'provider' | 'model'>) {
    const next = resolveDoctorTarget({
      ...modelFields,
      model: isPinned ? request.model : modelFields.model,
      ...patch,
    }, doctorTargets);
    const pin = isPinned ? serializeModelPin(true, { provider: next.provider, model: next.request.model }) : {};
    onUpdateNode(id, { ...patch, ...pin });
  }

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
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5 flex-wrap">
          <span>{messages.inspector.nodeHeadingPrefix}</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-primary">{id}</code>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form className="right-inspector__section" onSubmit={(event) => void saveRole(event)}>
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
            value={modelFields.provider}
            list={mode === 'local' ? providerListId : undefined}
            onCommit={(value) => updateModel({ provider: value })}
          />
          <EditableField
            name="model"
            label={messages.inspector.fields.model}
            value={modelFields.model}
            placeholder="deepseek-v4.1-flash@max"
            onCommit={(value) => updateModel({ model: value })}
          />
          <div className="flex items-center justify-between gap-2">
            <div className="grid min-w-0 gap-0.5">
              <Label htmlFor={pinId}>{messages.nodeReadiness.pinModelOverride}</Label>
              {isPinned && assignedModel && (
                <code className="truncate text-[11px] text-muted-foreground" title={assignedModel}>
                  {assignedModel}
                </code>
              )}
            </div>
            <Switch
              id={pinId}
              checked={isPinned}
              disabled={!isPinned && !request.model}
              className="motion-reduce:transition-none motion-reduce:[&>span]:transition-none"
              onCheckedChange={(checked) => onUpdateNode(id, serializeModelPin(checked, {
                provider: target.provider,
                model: request.model,
              }))}
            />
          </div>
          <DoctorControl
            client={client}
            request={request}
            onDoctorResult={onDoctorResult}
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
          <p className="m-0 text-[11px] leading-snug text-muted-foreground">
            {messages.inspector.canvasImmediateNote}
          </p>
          {mode === 'local' && role && (
            <Button variant="default" size="default" type="submit" disabled={saving} aria-busy={saving} className="mt-1">
              {saving && <LoaderCircle size={14} className="motion-safe:animate-spin" aria-hidden="true" />}
              {messages.inspector.saveHotReload}
            </Button>
          )}
          {mode === 'demo' && (
            <p className="m-0 rounded-lg border border-border bg-muted/50 p-2.5 text-xs text-muted-foreground">
              {messages.inspector.demoHotSwapHintPrefix}
              <code className="font-mono text-text-strong">baton ui</code>
              {messages.inspector.demoHotSwapHintSuffix}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

export function EdgeEditor({ edge, onUpdateEdge }: Pick<RightInspectorProps, 'onUpdateEdge'> & { edge: WorkflowEdge }) {
  const { messages } = useI18n();
  const { id, sourceHandle, targetHandle, max_loops: maxLoops } = edge;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5 flex-wrap">
          <span>{messages.inspector.edgeHeadingPrefix}</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-primary">{id}</code>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="right-inspector__section">
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
      </CardContent>
    </Card>
  );
}

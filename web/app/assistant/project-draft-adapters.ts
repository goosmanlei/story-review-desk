'use client';

import { useInstanceProfile } from '../instance-context';
import { useLayoutEffect, useRef, useState } from 'react';
import { useAssistantDraftTargets } from './context-provider';
import type { AssistantDraftTarget } from './types';

/** Project identity belongs to this adapter, never to the assistant core. */


type TextField = {
  fieldId: string;
  label: string;
  value: string;
};
type TextDraftConfig = {
  identity: string;
  subjectId: string;
  versionId?: string;
  fields: TextField[];
  defaultFieldId?: string;
  canAdopt: boolean;
  disabledReason?: string;
  applyField: (fieldId: string, nextValue: string) => void;
};

/** Adapt existing local text state. No verdict, rights, event or source writer is exposed. */
export function useProjectAssistantDraftTargets(config: TextDraftConfig) {
  const instance = useInstanceProfile();
  const latest = useRef<TextDraftConfig | null>(config);
  const [focusedFieldId, setFocusedFieldId] = useState('');
  useLayoutEffect(() => {
    latest.current = config;
    return () => { latest.current = null; };
  });

  const targets: AssistantDraftTarget[] = config.fields.map((field) => ({
    id: `${instance.projectId}:${config.identity}:${field.fieldId}`,
    label: field.label,
    fieldId: field.fieldId,
    subjectId: config.subjectId,
    versionId: config.versionId,
    value: field.value,
    canAdopt: config.canAdopt,
    disabledReason: config.disabledReason,
    apply: (nextValue, expectedValue) => {
      const current = latest.current;
      const currentField = current?.fields.find((item) => item.fieldId === field.fieldId);
      if (!current || current.identity !== config.identity || !current.canAdopt || !currentField
        || currentField.value !== expectedValue || nextValue.length > 20_000) return false;
      current.applyField(field.fieldId, nextValue);
      // Synchronous CAS head also protects a second adoption before React commits.
      latest.current = { ...current, fields: current.fields.map((item) => (
        item.fieldId === field.fieldId ? { ...item, value: nextValue } : item
      )) };
      return true;
    },
  }));
  const { activateDraft, askAboutDraft } = useAssistantDraftTargets(targets);
  const selected = targets.find((target) => target.fieldId === focusedFieldId)
    || targets.find((target) => target.fieldId === config.defaultFieldId)
    || targets[0];
  return {
    hasTargets: targets.length > 0,
    activateField: (fieldId: string) => {
      const target = targets.find((item) => item.fieldId === fieldId);
      if (!target) return;
      setFocusedFieldId(fieldId);
      activateDraft(target.id);
    },
    askAboutActiveDraft: () => { if (selected) askAboutDraft(selected.id); },
    askAboutField: (fieldId: string) => { const target=targets.find(item=>item.fieldId===fieldId); if(target) askAboutDraft(target.id); },
  };
}

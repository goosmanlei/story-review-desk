'use client';

import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { canonicalJson, type AssistantDraftTarget, type WorkFocus } from './types';

type Snapshot = { focus: WorkFocus | null; activeDraft: AssistantDraftTarget | null; openRequest: number };
const EMPTY: Snapshot = { focus: null, activeDraft: null, openRequest: 0 };
function createRegistry() {
  const focuses = new Map<string, { focus: WorkFocus; priority: number; order: number }>();
  const drafts = new Map<string, AssistantDraftTarget[]>();
  const listeners = new Set<() => void>();
  let order = 0, activeDraftId = '', openRequest = 0;
  let snapshot = EMPTY;
  const findDraft = (id: string) => [...drafts.values()].flat().find((target) => target.id === id);
  const publish = () => {
    const focus = [...focuses.values()].sort((a, b) => b.priority - a.priority || b.order - a.order)[0]?.focus || null;
    const candidate = findDraft(activeDraftId);
    snapshot = { focus, activeDraft: candidate && candidate.subjectId === focus?.subjectId ? candidate : null, openRequest };
    listeners.forEach((listener) => listener());
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY,
    registerFocus(id: string, focus: WorkFocus | null, priority: number) {
      if (focus) focuses.set(id, { focus, priority, order: ++order }); else focuses.delete(id);
      publish(); return () => { focuses.delete(id); publish(); };
    },
    registerDrafts(id: string, targets: AssistantDraftTarget[]) {
      drafts.set(id, targets); publish(); return () => { drafts.delete(id); publish(); };
    },
    activateDraft(id: string) { activeDraftId = id; publish(); },
    askAboutDraft(id: string) { activeDraftId = id; openRequest += 1; publish(); },
    findDraft,
  };
}
type Registry = ReturnType<typeof createRegistry>;
const Context = createContext<(Registry & Snapshot) | null>(null);
export function AssistantContextProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(createRegistry);
  const snapshot = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getServerSnapshot);
  return <Context.Provider value={{ ...registry, ...snapshot }}>{children}</Context.Provider>;
}
export function useAssistant() {
  const value = useContext(Context);
  if (!value) throw new Error('AssistantContextProvider is required');
  return value;
}
export function useAssistantFocus(focus: WorkFocus | null, priority = 0) {
  const context = useContext(Context);
  const id = useId();
  const signature = canonicalJson(focus);
  const register = context?.registerFocus;
  useEffect(() => register?.(id, JSON.parse(signature) as WorkFocus | null, priority), [id, signature, priority, register]);
}
export function useAssistantDraftTargets(targets: AssistantDraftTarget[]) {
  const context = useContext(Context);
  const id = useId();
  const latest = useRef(targets);
  useLayoutEffect(() => { latest.current = targets; }, [targets]);
  const signature = canonicalJson(targets.map((target) => ({ id: target.id, label: target.label, fieldId: target.fieldId, subjectId: target.subjectId, versionId: target.versionId, value: target.value, canAdopt: target.canAdopt, disabledReason: target.disabledReason })));
  const register = context?.registerDrafts;
  useEffect(() => {
    const snapshot = JSON.parse(signature) as Omit<AssistantDraftTarget, 'apply'>[];
    return register?.(id, snapshot.map((target) => ({ ...target,
      apply: (nextValue, expectedValue) => {
        const current = latest.current.find((item) => item.id === target.id);
        return Boolean(current?.canAdopt && current.value === expectedValue && current.apply(nextValue, expectedValue));
      },
    })));
  }, [id, signature, register]);
  return { activateDraft: context?.activateDraft || (() => {}), askAboutDraft: context?.askAboutDraft || (() => {}) };
}

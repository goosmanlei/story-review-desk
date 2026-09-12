// Personal canvas layout never changes project objects or relationship facts.
let scope = "";
export function configureLayoutStorage(instanceId: string) {
  scope = instanceId;
}
export const instanceLocalStorage = {
  getItem(key: string) {
    return scope
      ? localStorage.getItem("review-layout:" + scope + ":" + key)
      : null;
  },
  setItem(key: string, value: string) {
    if (scope)
      localStorage.setItem("review-layout:" + scope + ":" + key, value);
  },
};

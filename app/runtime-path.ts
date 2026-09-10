/** Presentation only. Never rewrite a stored URL, frozen input or JSON payload. */
export function runtimePath<T extends string | null | undefined>(value:T):T {
  const base=process.env.NEXT_PUBLIC_REVIEW_BASE_PATH||'';
  if(typeof value!=='string'||!base||!value.startsWith('/')||value.startsWith('//')||value===base||value.startsWith(base+'/')||value.startsWith(base+'?')||value.startsWith(base+'#'))return value;
  return (base+value) as T;
}

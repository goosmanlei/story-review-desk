export function normalizeBasePath(value?: string): string;
export function configuredBasePath(): string;
export function deploymentMode(): 'LOCAL' | 'VPS' | 'SITES_READ_ONLY';
export function publicHttpPath<T>(value: T): T;
export function trustedRequestIdentity(request: Request): {mode:string;origin:string;authenticatedUser:string|null};
export function sameDeploymentOrigin(request: Request, allowedOrigins: Set<string>): boolean;
export function assertBrowserRuntimeBinding(request: Request, runtimeEpoch: string): void;
export function deploymentPublicFacts(runtimeEpoch?: string|null): {mode:string;deploymentId:string;runtimeEpoch:string|null;basePath:string};

import { trialProxy } from '../_proxy';
export function GET(request: Request) { return trialProxy(request, '/api/trial/snapshot'); }

import { trialProxy } from '../_proxy';
export function POST(request: Request) { return trialProxy(request, '/api/trial/reviews'); }

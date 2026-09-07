import { trialProxy } from '../../_proxy';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return trialProxy(request, `/api/trial/media/${encodeURIComponent(id)}`);
}

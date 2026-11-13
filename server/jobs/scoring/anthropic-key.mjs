import Anthropic from '@anthropic-ai/sdk';

// A key made for one workspace runs there. A personal or service account key
// that works in every workspace must name, on each request, the workspace
// the request runs in; without the header the API answers 400.
export const WORKSPACE_HEADER = 'anthropic-workspace-id';
export const WORKSPACE_ID = /^wrkspc_[A-Za-z0-9]{6,80}$/;

export const BAD_KEY = 'The Anthropic API key was rejected.';
export const NEEDS_WORKSPACE = 'This Anthropic API key works in every workspace, so it needs a workspace ID. Press Check beside the key under API key in Settings.';
export const BAD_WORKSPACE = 'The workspace ID saved with the Anthropic API key was not accepted. Check it under API key in Settings.';
const SENTENCES = { 'bad-key': BAD_KEY, 'needs-workspace': NEEDS_WORKSPACE, 'bad-workspace': BAD_WORKSPACE };

// The key in use and its workspace, when it has one. A key from the environment has none.
export function keyInUse(ai) {
  return ai.apiKey ? { apiKey: ai.apiKey, workspace: ai.workspace || '' } : { apiKey: process.env.ANTHROPIC_API_KEY || '', workspace: '' };
}
export const clientOptions = ({ apiKey, workspace }, rest = {}) => ({ apiKey, ...(workspace ? { defaultHeaders: { [WORKSPACE_HEADER]: workspace } } : {}), ...rest });

// The API's own sentence, without the status and the JSON the SDK puts around it.
export function apiDetail(error) {
  const said = error?.error?.error?.message ?? error?.error?.message;
  return typeof said === 'string' && said ? said : String(error?.message || '').replace(/^\d{3} /, '');
}

// What stands between a key and its use, when that is what the API is saying; null for any other error.
export function keyProblem(error) {
  if (!(error instanceof Anthropic.APIError)) return null;
  const said = apiDetail(error);
  if (error.status === 401) return 'bad-key';
  if (error.status === 400 && /not scoped to a workspace/i.test(said)) return 'needs-workspace';
  if ((error.status === 400 && /anthropic-workspace-id/i.test(said)) || (error.status === 404 && /^Workspace\b[^]*not found/i.test(said))) return 'bad-workspace';
  return null;
}
export const keyProblemText = problem => SENTENCES[problem] || '';

// The workspaces a key that works in all of them can name. A key made for one workspace may not ask, and gets none.
async function listWorkspaces(client) {
  const found = [];
  try {
    for await (const workspace of client.beta.organization.workspaces.list({ include_default: true, limit: 100 })) {
      if (!workspace.archived_at) found.push({ id: workspace.id, name: String(workspace.name || '') });
      if (found.length >= 100) break;
    }
  } catch { return []; }
  return found;
}

// Asks the API whether a key can be used as it is. Nothing here is billed:
// listing the models costs no tokens. state is one of
//   ok               the key works (with its workspace, when it has one)
//   bad-key          wrong, disabled, deleted or expired
//   needs-workspace  works in every workspace and has not been told which
//   bad-workspace    the workspace saved with it is not one it can use
//   offline | error  the question got no clear answer (detail says why)
// For the two workspace states, workspaces lists the ones to choose from, when the key may list them.
export async function checkKey({ apiKey, workspace = '' }, { createClient = options => new Anthropic(options) } = {}) {
  const limits = { maxRetries: 1, timeout: 20000 };
  try {
    await createClient(clientOptions({ apiKey, workspace }, limits)).models.list({ limit: 1 });
    return { state: 'ok' };
  } catch (error) {
    const state = keyProblem(error);
    if (state === 'bad-key') return { state };
    if (state) return { state, workspaces: await listWorkspaces(createClient(clientOptions({ apiKey }, limits))) };
    if (error instanceof Anthropic.APIConnectionError) return { state: 'offline' };
    return { state: 'error', detail: apiDetail(error).slice(0, 300) };
  }
}

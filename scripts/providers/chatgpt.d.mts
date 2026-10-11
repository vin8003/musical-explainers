export type ChatGPTModel = { id: string; name: string; reasoningEfforts: string[] | null };
export function listChatGPTModels(fetcher?: typeof fetch): Promise<ChatGPTModel[]>;
export function chatGPTResponse(prompt: string, options: { effort?: string; allowedTools?: string[]; imagePaths?: string[]; timeoutMs?: number }, model: string, fetcher?: typeof fetch): Promise<{ text: string; usage: unknown; model: string }>;
export function chatGPTResponseWithToken(prompt: string, options: { effort?: string; allowedTools?: string[]; imagePaths?: string[]; timeoutMs?: number }, model: string, token: string, fetcher?: typeof fetch): Promise<{ text: string; usage: unknown; model: string }>;

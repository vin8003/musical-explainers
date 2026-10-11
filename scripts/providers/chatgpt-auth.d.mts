export function connectionStatus(): Promise<{ status: string; sharing: boolean; account?: string | null }>;
export function connectChatGPT(): Promise<{ status: string; sharing: boolean; account?: string | null }>;
export function disconnectChatGPT(): Promise<{ status: string; sharing: boolean; account?: string | null; remoteRevocation: string }>;
export function markChatGPTReauthenticationRequired(): Promise<void>;
export function getChatGPTAccessToken(): Promise<string>;

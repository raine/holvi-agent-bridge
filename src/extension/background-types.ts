export interface StaticBridgeConfig {
  accountOrigin: string;
  apiOrigin: string;
  groupPathPrefix: string;
  nativeHostName: string;
  maxFileBytes: number;
  maxTransactionPages: number;
  maxTransactionResults: number;
}

export interface RuntimeBridgeConfig {
  groupPathSegment: string;
  poolHandle: string;
  paymentAccountUuid: string;
  capabilities: string[];
  maxFileBytes: number;
}

export interface Auth {
  token: string;
  csrfToken: string;
}

export interface NativeMessage {
  type?: string;
  id?: string;
  action?: string;
  params?: Record<string, unknown>;
  config?: unknown;
  debtUuid?: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  sha256?: string;
  chunkCount?: number;
  index?: number;
  data?: string;
}

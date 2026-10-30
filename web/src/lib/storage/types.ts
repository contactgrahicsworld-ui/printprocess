export interface SignedUpload {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
}

export interface StorageDriver {
  /** One-time URL the browser PUTs the raw file body to (with progress via XHR). */
  createSignedUploadUrl(path: string, contentType: string): Promise<SignedUpload>;
  getObject(path: string): Promise<Uint8Array | null>;
  putObject(path: string, data: Uint8Array, contentType: string): Promise<void>;
  remove(paths: string[]): Promise<void>;
  /** Short-lived signed GET URL. */
  createSignedDownloadUrl(path: string, expiresInSeconds: number, downloadName?: string): Promise<string>;
}

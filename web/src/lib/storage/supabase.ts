import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { SignedUpload, StorageDriver } from "./types";

export function createSupabaseStorage(url: string, serviceRoleKey: string, bucket: string): StorageDriver {
  const client: SupabaseClient = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const b = () => client.storage.from(bucket);
  return {
    async createSignedUploadUrl(path, contentType): Promise<SignedUpload> {
      const { data, error } = await b().createSignedUploadUrl(path, { upsert: false });
      if (error || !data) throw new Error(`storage: cannot create upload URL: ${error?.message}`);
      return { url: data.signedUrl, method: "PUT", headers: { "content-type": contentType, "x-upsert": "false" } };
    },
    async getObject(path) {
      const { data, error } = await b().download(path);
      if (error || !data) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
    async putObject(path, data, contentType) {
      const { error } = await b().upload(path, data, { contentType, upsert: true });
      if (error) throw new Error(`storage: upload failed: ${error.message}`);
    },
    async remove(paths) {
      if (paths.length === 0) return;
      const { error } = await b().remove(paths);
      if (error) throw new Error(`storage: remove failed: ${error.message}`);
    },
    async createSignedDownloadUrl(path, expiresInSeconds, downloadName) {
      const { data, error } = await b().createSignedUrl(path, expiresInSeconds, downloadName ? { download: downloadName } : undefined);
      if (error || !data) throw new Error(`storage: cannot sign URL: ${error?.message}`);
      return data.signedUrl;
    },
  };
}

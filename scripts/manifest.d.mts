export declare const EXTENSION_KEY: string;
export declare function extensionManifest(options: {
  target: "extension" | "baseline" | "store";
  version: string;
  icons: Record<string, string>;
}): {
  manifest_version: 3;
  key?: string;
  name: string;
  version: string;
  permissions: string[];
  host_permissions: string[];
  optional_host_permissions: string[];
  content_security_policy: { extension_pages: string };
  [key: string]: unknown;
};

import path from "node:path";

// Applied after .env loading, before any path or service configuration is read.
// Public demos must never inherit the operator's library, database or services.
export function applyDemoEnvironment(env: NodeJS.ProcessEnv, cwd: string): void {
  const network = { PORT: env.PORT, AMW_HOST: env.AMW_HOST, AMW_LAN_MODE: env.AMW_LAN_MODE };
  for (const key of Object.keys(env)) {
    if (/^(?:AMW_|MEDIA_|METADATA_|METATUBE_|SUBTITLE_|THUMBNAIL_|COVER_|DERIVATIVE_|INGESTION_)/.test(key)) delete env[key];
  }
  const root = path.resolve(cwd, ".local/public-demo");
  Object.assign(env, {
    AMW_DEMO_MODE: "true", PORT: network.PORT || "4312",
    AMW_HOST: network.AMW_HOST || "127.0.0.1", AMW_LAN_MODE: network.AMW_LAN_MODE || "false", AMW_LAN_AUTH: "false",
    DATA_DIR: path.join(root, "data"), AMW_DATABASE_PATH: path.join(root, "data/media-wall.sqlite"),
    MEDIA_SOURCES: `LOCAL:Demo=${path.join(root, "movies")}`,
    SCAN_ON_START: "true", SCAN_START_DELAY_MS: "0", AMW_STORAGE_RECOVERY_ENABLED: "false",
    AMW_AGENT_ENABLED: "false", AMW_CONTENT_PREVIEW_ENABLED: "false",
    METADATA_AUTO_ENRICH: "false", SUBTITLE_AUTO_TRANSLATE_FAVORITES: "false",
    AMW_ENTITY_PROFILE_IMAGE_POLICY: "strict", MEDIA_WORKER_MODE: "embedded"
  });
}

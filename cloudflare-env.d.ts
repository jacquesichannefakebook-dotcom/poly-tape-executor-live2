declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    POLY_TAPE_CREDENTIALS_MASTER_KEY?: string;
    POLY_TAPE_OWNER_EMAIL?: string;
    POLY_TAPE_CRON_SECRET?: string;
    POLY_TAPE_SITES_BYPASS_TOKEN?: string;
    POLY_TAPE_CLOUDFLARE_ACCOUNT_ID?: string;
    POLY_TAPE_LIVE_ENABLED?: string;
  }
}

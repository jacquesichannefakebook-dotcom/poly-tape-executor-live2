"use client";

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";

type Decision = {
  id: number; created_at: number; mode: string; status: string; category: string; title: string; outcome: string;
  market_slug: string | null; event_slug: string | null; score: number; wallets: number; buy_pressure: number; edge_points: number;
  stake: number; fill_price: number | null; reject_reason: string | null; pnl: number | null;
  entry_strategy: string; exit_target_price: number | null; exit_status: string | null; exit_filled_shares: number;
};

type RiskValues = {
  capitalCap: number; targetSignalsMin: number; targetSignalsMax: number; maxOrdersPerDay: number;
  baseStake: number; maxStake: number; maxExposure: number; maxPositions: number;
  dailyStop: number; weeklyStop: number; hardDrawdown: number;
  makerImprovementTicks: number; makerTimeoutSeconds: number; takeProfitPercent: number; minimumProfitTicks: number;
};

type CredentialValues = {
  signerPrivateKey: string;
  walletAddress: string;
  relayerApiKey: string;
  relayerApiKeyAddress: string;
  clobApiKey: string;
  clobApiSecret: string;
  clobApiPassphrase: string;
};

type Dashboard = {
  state: {
    mode: "PAPER" | "LIVE" | "PAUSED"; armed: number; last_cycle_at: number | null; last_scheduled_cycle_at: number | null;
    last_cycle_status: string | null; last_error: string | null; last_geo_blocked: number | null; last_geo_country: string | null;
  };
  credentials: {
    walletReady: boolean; clobCredentialsReady: boolean; relayerReady: boolean; vaultReady: boolean; vaultError: boolean;
    vaultUpdatedAt: number | null; schedulerSecretReady: boolean; cloudflareAccountReady: boolean; serverLiveSwitch: boolean;
    accountVerified: boolean; accountVerifiedAt: number | null; approvalsPrepared: boolean; approvalsPreparedAt: number | null;
    walletType: string | null; openOrdersSeen: number | null; lastAuthError: string | null;
  };
  schedulerHealthy: boolean;
  network: { ready: boolean; executionRegion: string | null; installedAt: number | null; lastVerifiedAt: number | null };
  liveReady: boolean;
  pilot: RiskValues & {
    id: string; version: string; riskConfigured: boolean; maxSpread: number; minimumDepthMultiple: number;
    minimumEdgePoints: number; minimumScore: number; minimumWallets: number; minimumBuyPressure: number; maximumSignalAgeSeconds: number;
  };
  stats: {
    currentBankroll: number; realizedPnl: number; todayPnl: number; weekPnl: number; openExposure: number; available: number;
    submittedToday: number; rejectedToday: number; wins: number; losses: number; resolved: number; hitRate: number | null;
    makerEntries: number; takeProfits: number;
    modelBrier: number | null; marketBrier: number | null; brierImprovement: number | null;
  };
  decisions: Decision[];
};

type RiskDraft = Record<keyof RiskValues, string>;
type CredentialDraft = Record<keyof CredentialValues, string>;
type CloudflareDraft = { accountId: string; apiToken: string };

const riskKeys: (keyof RiskValues)[] = [
  "capitalCap", "targetSignalsMin", "targetSignalsMax", "maxOrdersPerDay", "baseStake", "maxStake",
  "maxExposure", "maxPositions", "dailyStop", "weeklyStop", "hardDrawdown",
  "makerImprovementTicks", "makerTimeoutSeconds", "takeProfitPercent", "minimumProfitTicks",
];

const blankDraft = (): RiskDraft => Object.fromEntries(riskKeys.map(key => [key, ""])) as RiskDraft;
const blankCredentialDraft = (): CredentialDraft => ({
  signerPrivateKey: "", walletAddress: "", relayerApiKey: "", relayerApiKeyAddress: "",
  clobApiKey: "", clobApiSecret: "", clobApiPassphrase: "",
});
const draftFrom = (data: Dashboard): RiskDraft => data.pilot.riskConfigured
  ? Object.fromEntries(riskKeys.map(key => [key, String(data.pilot[key])])) as RiskDraft
  : blankDraft();

const money = (value: number) => `${value.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} pUSD`;
const ago = (timestamp: number | null) => {
  if (!timestamp) return "jamais";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 60) return `il y a ${seconds} s`;
  if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)} min`;
  return `il y a ${Math.floor(seconds / 3600)} h`;
};

const rejectLabels: Record<string, string> = {
  MINIMUM_TOO_LARGE: "minimum du marché trop risqué", DAILY_LIMIT: "limite quotidienne atteinte",
  DAILY_STOP: "stop journalier actif", WEEKLY_STOP: "stop hebdomadaire actif", HARD_DRAWDOWN: "drawdown maximal atteint",
  EXPOSURE_LIMIT: "exposition maximale atteinte", POSITION_LIMIT: "positions maximales atteintes",
  SPREAD_TOO_WIDE: "spread trop large", DEPTH_TOO_LOW: "profondeur insuffisante", EDGE_TOO_LOW: "avantage insuffisant",
  GEO_BLOCKED: "zone non autorisée", LIVE_LOCKED: "mode réel verrouillé", AUTONOMY_INACTIVE: "cadence autonome inactive",
  RISK_NOT_CONFIGURED: "limites personnelles non configurées", BOOK_UNAVAILABLE: "carnet indisponible",
  BOOK_CONTRADICTS_FLOW: "carnet opposé au flux", PRICE_RANGE: "prix hors zone du moteur",
  MARKET_CLOSED: "marché fermé", DUPLICATE_MARKET: "marché déjà engagé aujourd’hui",
  EXECUTION_AMBIGUOUS: "exécution ambiguë : moteur arrêté",
  MAKER_NOT_FILLED: "ordre maker non rempli",
};

const statusLabels: Record<string, string> = {
  ENTRY_PENDING: "ACHAT MAKER", SUBMITTED: "ENVOYÉ", PARTIAL: "PARTIEL", OPEN: "POSITION",
  EXIT_PENDING: "TAKE PROFIT", SOLD: "VENDU", WON: "GAGNÉ", LOST: "PERDU", UNFILLED: "NON REMPLI", REJECTED: "REFUSÉ",
};

const apiErrors: Record<string, string> = {
  CAPITAL_RANGE: "Le capital doit être supérieur à zéro.", TARGET_RANGE: "La cible de débit est incohérente.",
  ORDERS_DAY_RANGE: "La limite d’ordres doit être au moins égale à la cible haute.",
  BASE_STAKE_RANGE: "La mise de base doit être positive et inférieure à la mise maximale.",
  MAX_STAKE_RANGE: "La mise maximale ne peut pas dépasser le capital alloué.",
  MAX_EXPOSURE_RANGE: "L’exposition doit couvrir au moins une mise maximale sans dépasser le capital.",
  MAX_POSITIONS_RANGE: "Le nombre de positions simultanées est invalide.",
  STOP_RANGE: "Les stops doivent progresser : jour ≤ semaine ≤ drawdown ≤ capital.",
  MAKER_TICKS_RANGE: "L’amélioration maker doit être comprise entre 0 et 10 ticks.",
  MAKER_TIMEOUT_RANGE: "Le délai maker doit être compris entre 30 et 600 secondes.",
  TAKE_PROFIT_RANGE: "Le take-profit doit être compris entre 1 et 100 %.",
  PROFIT_TICKS_RANGE: "Le gain minimal doit être compris entre 1 et 20 ticks.",
  LIVE_CONFIGURATION_INCOMPLETE: "Le réel n’est pas encore prêt : consulte les contrôles ci-dessous.",
  SIGNER_KEY_INVALID: "La clé du signataire n’a pas un format valide.",
  ACCOUNT_WALLET_INVALID: "L’adresse du compte Polymarket n’a pas un format valide.",
  RELAYER_ADDRESS_INVALID: "L’adresse du signataire Relayer n’a pas un format valide.",
  RELAYER_KEY_INVALID: "La Relayer API Key est absente ou invalide.",
  CLOB_CREDENTIALS_INCOMPLETE: "Les trois identifiants CLOB doivent être remplis ensemble, ou laissés vides.",
  CREDENTIAL_VAULT_UNAVAILABLE: "Le coffre chiffré du serveur n’est pas encore disponible.",
  CREDENTIAL_SAVE_FAILED: "Les clés n’ont pas pu être enregistrées.",
  OWNER_REQUIRED: "Cette action est réservée au propriétaire de l’exécuteur.",
  ACCOUNT_WALLET_MISMATCH: "Le signataire ne contrôle pas le compte Polymarket configuré.",
  RELAYER_SIGNER_MISMATCH: "La clé Relayer ne correspond pas au signataire configuré.",
  ACCOUNT_VERIFICATION_REQUIRED: "Teste d’abord la connexion au compte.",
  CONFIRMATION_REQUIRED: "La confirmation explicite est requise.",
  LIVE_AUTHENTICATION_FAILED: "Polymarket a refusé la vérification du compte ou des autorisations de trading.",
  CLOUDFLARE_ACCOUNT_INVALID: "L’identifiant du compte Cloudflare doit contenir 32 caractères hexadécimaux.",
  CLOUDFLARE_TOKEN_INVALID: "Le jeton API Cloudflare est absent ou invalide.",
  CLOUDFLARE_TOKEN_REFUSED: "Cloudflare a refusé le jeton. Vérifie la permission Account · Workers Scripts · Edit et le compte autorisé.",
  CLOUDFLARE_INSTALL_FAILED: "Cloudflare n’a pas pu installer le transport régional.",
  CLOUDFLARE_PROXY_INSTALL_FAILED: "Cloudflare n’a pas pu installer le relais régional d’exécution.",
  CLOUDFLARE_RESPONSE_TOO_LARGE: "La réponse Cloudflare était anormale. Réessaie dans quelques instants.",
  CLOUDFLARE_SUBDOMAIN_UNAVAILABLE: "Le sous-domaine workers.dev du compte Cloudflare n’est pas disponible.",
  CLOUDFLARE_PROXY_PUBLISH_FAILED: "Cloudflare n’a pas pu publier le relais régional.",
  CLOUDFLARE_PROXY_VERIFY_FAILED: "Le relais régional n’a pas pu être vérifié. Réessaie dans un instant.",
  CLOUDFLARE_PROXY_REGION_BLOCKED: "La région choisie pour le relais est refusée par Polymarket.",
  SCHEDULER_INSTALLER_NOT_READY: "L’installateur privé n’est pas encore prêt côté serveur.",
};

export default function Home() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [draft, setDraft] = useState<RiskDraft | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"ALL" | "OPEN" | "RESOLVED" | "REJECTED">("ALL");
  const [credentialDraft, setCredentialDraft] = useState<CredentialDraft>(blankCredentialDraft);
  const [cloudflareDraft, setCloudflareDraft] = useState<CloudflareDraft>({ accountId: "", apiToken: "" });
  const [showSecrets, setShowSecrets] = useState(false);

  const acceptDashboard = useCallback((payload: Dashboard, resetDraft = false) => {
    setData(payload);
    setDraft(current => resetDraft || current == null ? draftFrom(payload) : current);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      if (!response.ok) throw new Error("Console momentanément indisponible");
      acceptDashboard(await response.json() as Dashboard);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Connexion impossible"); }
  }, [acceptDashboard]);

  useEffect(() => {
    const initial = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 10000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);

  const control = async (action: string, confirm?: string) => {
    setBusy(true);
    try {
      const response = await fetch("/api/control", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, confirm }),
      });
      const payload = await response.json() as Dashboard & { error?: string };
      if (!response.ok) throw new Error(apiErrors[payload.error || ""] || payload.error || "Action refusée");
      acceptDashboard(payload);
      const notices: Record<string, string> = {
        "arm-live": "Exécution réelle armée.",
        pause: "Moteur arrêté immédiatement.",
        paper: "Exécution réelle désactivée.",
        "verify-account": "Connexion Polymarket vérifiée en lecture seule. Aucun ordre envoyé.",
        "prepare-approvals": "Autorisations Polymarket préparées. Aucun ordre envoyé.",
      };
      setNotice(notices[action] || "Action terminée.");
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Action impossible"); }
    finally { setBusy(false); }
  };

  const armLive = async () => {
    if (!window.confirm("Armer l’exécution réelle avec les limites affichées ?")) return;
    await control("arm-live", "ARMER");
  };

  const prepareApprovals = async () => {
    if (!window.confirm("Préparer uniquement les permissions nécessaires au trading ? Cette action n’envoie aucun ordre.")) return;
    await control("prepare-approvals", "AUTORISER");
  };

  const saveRisk = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    try {
      const body = {
        ...Object.fromEntries(riskKeys.map(key => [key, Number(draft[key])])),
        makerEntryEnabled: true, takerFallbackEnabled: true, takeProfitEnabled: true,
      };
      const response = await fetch("/api/config", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const payload = await response.json() as Dashboard & { error?: string };
      if (!response.ok) throw new Error(apiErrors[payload.error || ""] || payload.error || "Configuration refusée");
      acceptDashboard(payload, true);
      setNotice("Limites et stratégie enregistrées. Toute modification désarme le réel.");
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Enregistrement impossible"); }
    finally { setBusy(false); }
  };

  const saveCredentials = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch("/api/credentials", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(credentialDraft),
      });
      const payload = await response.json() as Dashboard & { error?: string };
      if (!response.ok) throw new Error(apiErrors[payload.error || ""] || payload.error || "Enregistrement refusé");
      acceptDashboard(payload);
      setCredentialDraft(blankCredentialDraft());
      setShowSecrets(false);
      setNotice("Clés chiffrées et enregistrées. Les champs ont été vidés.");
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Enregistrement impossible"); }
    finally { setBusy(false); }
  };

  const deleteCredentials = async () => {
    if (!window.confirm("Effacer définitivement les clés Polymarket du coffre ? Le réel sera désarmé.")) return;
    setBusy(true);
    try {
      const response = await fetch("/api/credentials", {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "EFFACER" }),
      });
      const payload = await response.json() as Dashboard & { error?: string };
      if (!response.ok) throw new Error(apiErrors[payload.error || ""] || payload.error || "Suppression refusée");
      acceptDashboard(payload);
      setCredentialDraft(blankCredentialDraft());
      setNotice("Clés effacées et moteur désarmé.");
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Suppression impossible"); }
    finally { setBusy(false); }
  };

  const runCycle = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/cycle", { method: "POST" });
      const payload = await response.json() as { dashboard?: Dashboard; error?: string };
      if (!response.ok || !payload.dashboard) throw new Error(payload.error || "Cycle indisponible");
      acceptDashboard(payload.dashboard);
      setNotice("Cycle manuel terminé.");
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Cycle impossible"); }
    finally { setBusy(false); }
  };

  const installScheduler = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch("/api/cloudflare-install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...cloudflareDraft, confirm: "INSTALLER" }),
      });
      const payload = await response.json() as { error?: string; service?: string };
      if (!response.ok) throw new Error(apiErrors[payload.error || ""] || payload.error || "Installation refusée");
      setCloudflareDraft(current => ({ accountId: current.accountId, apiToken: "" }));
      setNotice("Transport Polymarket régional vérifié. La cadence native est déjà active ; le moteur peut être réarmé.");
      setError("");
      window.setTimeout(refresh, 5000);
    } catch (cause) {
      setCloudflareDraft(current => ({ ...current, apiToken: "" }));
      setError(cause instanceof Error ? cause.message : "Installation impossible");
    } finally { setBusy(false); }
  };

  if (!data || !draft) return <main className="boot"><span className="pulse" /><b>POLY TAPE EXECUTOR</b><p>{error || "Initialisation du coffre privé…"}</p></main>;

  const modeTone = data.state.mode === "LIVE" ? "live" : data.state.mode === "PAUSED" ? "paused" : "paper";
  const schedulerRegionBlocked = data.state.last_geo_blocked === 1;
  const decisions = data.decisions.filter(item => filter === "ALL" || (filter === "RESOLVED" ? ["WON", "LOST", "SOLD"].includes(item.status) : filter === "OPEN" ? ["ENTRY_PENDING", "OPEN", "SUBMITTED", "PARTIAL", "EXIT_PENDING"].includes(item.status) : item.status === "REJECTED"));
  const gates = [
    ["Limites personnelles", data.pilot.riskConfigured, data.pilot.riskConfigured ? `${money(data.pilot.capitalCap)} alloués` : "À enregistrer avant le réel"],
    ["Compte Polymarket", data.credentials.accountVerified, data.credentials.accountVerified ? `Connexion vérifiée ${ago(data.credentials.accountVerifiedAt)}` : "Test authentifié en lecture seule requis"],
    ["Permissions de trading", data.credentials.approvalsPrepared, data.credentials.approvalsPrepared ? `Préparées ${ago(data.credentials.approvalsPreparedAt)}` : "À préparer après la vérification du compte"],
    ["Cadence autonome", data.schedulerHealthy, data.schedulerHealthy ? `Dernier cycle ${ago(data.state.last_scheduled_cycle_at)}` : "Aucun déclenchement permanent détecté"],
    ["Transport Polymarket", data.network.ready, data.network.ready ? `Relais régional ${data.network.executionRegion}` : "Mise à niveau régionale à finaliser"],
    ["Zone autorisée", data.state.last_geo_blocked === 0, data.state.last_geo_country ? `Dernier contrôle : ${data.state.last_geo_country}` : "Contrôle avant chaque ordre"],
    ["Autorisation serveur", data.credentials.serverLiveSwitch, "Interrupteur privé de production"],
  ] as const;
  const exposureFill = data.pilot.maxExposure > 0 ? Math.min(100, data.stats.openExposure / data.pilot.maxExposure * 100) : 0;
  const schedulerInstalled = data.schedulerHealthy && data.network.ready && !schedulerRegionBlocked;

  const field = (key: keyof RiskValues, label: string, placeholder: string, step = "0.01") => <label>
    <span>{label}</span>
    <input value={draft[key]} inputMode="decimal" type="number" min="0" step={step} placeholder={placeholder} disabled={busy}
      onChange={event => setDraft(current => current ? { ...current, [key]: event.target.value } : current)} />
  </label>;

  const credentialField = (key: keyof CredentialValues, label: string, placeholder: string, secret = false, required = true) => <label>
    <span>{label}{required ? " *" : ""}</span>
    <input value={credentialDraft[key]} type={secret && !showSecrets ? "password" : "text"} placeholder={placeholder}
      required={required} disabled={busy} autoComplete="new-password" spellCheck={false} inputMode="text"
      onChange={event => setCredentialDraft(current => ({ ...current, [key]: event.target.value }))} />
  </label>;

  return <main>
    <header className="topbar">
      <div className="brand"><span className="brandMark">PT</span><div><b>POLY TAPE</b><small>PRIVATE EXECUTOR</small></div></div>
      <div className={`mode ${modeTone}`}><span />{data.state.mode === "LIVE" ? "RÉEL ARMÉ" : data.state.mode === "PAUSED" ? "MOTEUR EN PAUSE" : "RÉEL INACTIF"}</div>
      <div className="heartbeat"><small>DERNIER CYCLE</small><b>{ago(data.state.last_cycle_at)}</b></div>
    </header>

    <section className="hero">
      <div><p className="eyebrow">{data.pilot.id} · {data.pilot.version}</p><h1>Tes limites.<br /><em>Le moteur exécute.</em></h1><p>Objectif de débit : <b>{data.pilot.riskConfigured ? `${data.pilot.targetSignalsMin} à ${data.pilot.targetSignalsMax}` : "à définir"} signaux qualifiés par jour</b>. Aucun plafond de capital n’est imposé par Poly Tape et aucun essai papier n’est requis pour armer le réel.</p></div>
      <div className={`capitalDial ${data.pilot.riskConfigured ? "" : "unset"}`}><small>CAPITAL ALLOUÉ PAR TOI</small><strong>{data.pilot.riskConfigured ? data.pilot.capitalCap.toLocaleString("fr-FR", { maximumFractionDigits: 2 }) : "À DÉFINIR"}</strong><span>{data.pilot.riskConfigured ? "pUSD" : ""}</span><i style={{ "--fill": `${exposureFill}%` } as CSSProperties} /><p>{data.pilot.riskConfigured ? `${money(data.stats.openExposure)} exposés sur ${money(data.pilot.maxExposure)}` : "Enregistre tes propres limites ci-dessous"}</p></div>
    </section>

    <section className="metricGrid">
      <article><small>BANKROLL ALLOUÉE</small><b>{data.pilot.riskConfigured ? money(data.stats.currentBankroll) : "—"}</b><em className={data.stats.realizedPnl >= 0 ? "positive" : "negative"}>{data.stats.realizedPnl >= 0 ? "+" : ""}{money(data.stats.realizedPnl)} réalisé</em></article>
      <article><small>ORDRES RÉELS AUJOURD’HUI</small><b>{data.stats.submittedToday}<span>/{data.pilot.riskConfigured ? data.pilot.maxOrdersPerDay : "—"}</span></b><em>{data.stats.rejectedToday} décisions réelles refusées</em></article>
      <article><small>EXPOSITION OUVERTE</small><b>{money(data.stats.openExposure)}</b><em>{data.pilot.riskConfigured ? `${data.pilot.maxPositions} positions simultanées max.` : "limite à définir"}</em></article>
      <article><small>TAUX DE RÉUSSITE</small><b>{data.stats.hitRate == null ? "—" : `${data.stats.hitRate.toFixed(1)}%`}</b><em>{data.stats.wins} gagnés · {data.stats.losses} perdus</em></article>
      <article><small>PNL JOUR / SEMAINE</small><b className={data.stats.todayPnl >= 0 ? "positive" : "negative"}>{data.stats.todayPnl >= 0 ? "+" : ""}{money(data.stats.todayPnl)}</b><em>{data.stats.weekPnl >= 0 ? "+" : ""}{money(data.stats.weekPnl)} sur 7 jours</em></article>
      <article><small>EXÉCUTION OPTIMISÉE</small><b>{data.stats.makerEntries}<span> maker</span></b><em>{data.stats.takeProfits} take-profit encaissé{data.stats.takeProfits === 1 ? "" : "s"}</em></article>
    </section>

    <section className="credentialCard wideCard">
      <div className="sectionTitle"><div><span className="shield">⌁</span><div><small>COFFRE CHIFFRÉ CÔTÉ SERVEUR</small><h2>Connexion à ton compte Polymarket</h2></div></div><span>{data.credentials.walletReady ? "ENREGISTRÉ" : data.credentials.vaultError ? "À REMPLACER" : data.credentials.vaultReady ? "PRÊT À REMPLIR" : "VERROUILLÉ"}</span></div>
      <div className="credentialIntro">
        <p>Colle les valeurs ici, directement depuis ton iPad. Elles sont chiffrées avant stockage et ne seront jamais renvoyées à l’écran. Les enregistrer ne déclenche aucun ordre.</p>
        {data.credentials.vaultUpdatedAt && <small>Dernière mise à jour : {new Date(data.credentials.vaultUpdatedAt * 1000).toLocaleString("fr-FR")}</small>}
      </div>
      <form className="credentialForm" autoComplete="off" onSubmit={saveCredentials}>
        {credentialField("signerPrivateKey", "1. Clé privée Magic / signataire", "0x…", true)}
        {credentialField("walletAddress", "2. Adresse du compte Polymarket", "0x…")}
        {credentialField("relayerApiKey", "3. Relayer API Key", "Clé créée dans Settings → API Keys", true)}
        {credentialField("relayerApiKeyAddress", "4. Relayer Signer Address", "0x…")}
        <details>
          <summary>Identifiants CLOB facultatifs</summary>
          <p>Tu peux les laisser vides : l’exécuteur les dérivera depuis le signataire. Si tu les ajoutes, remplis les trois.</p>
          <div>
            {credentialField("clobApiKey", "CLOB API Key", "Facultatif", true, false)}
            {credentialField("clobApiSecret", "CLOB Secret", "Facultatif", true, false)}
            {credentialField("clobApiPassphrase", "CLOB Passphrase", "Facultatif", true, false)}
          </div>
        </details>
        <div className="credentialActions">
          <button className="saveButton" disabled={busy || !data.credentials.vaultReady} type="submit">CHIFFRER ET ENREGISTRER</button>
          <button className="ghostButton" disabled={busy} type="button" onClick={() => setShowSecrets(value => !value)}>{showSecrets ? "MASQUER" : "AFFICHER"}</button>
          {data.credentials.walletReady && <button className="dangerButton" disabled={busy} type="button" onClick={deleteCredentials}>EFFACER LES CLÉS</button>}
        </div>
      </form>
      {data.credentials.walletReady && <div className="connectionSteps">
        <article className={data.credentials.accountVerified ? "done" : "pending"}>
          <span>1</span><div><b>Vérifier la connexion</b><small>{data.credentials.accountVerified ? `Compte authentifié · ${data.credentials.openOrdersSeen ?? 0} ordre(s) ouvert(s) lu(s) · wallet ${data.credentials.walletType || "détecté"}` : "Lecture authentifiée des ordres ouverts, sans transaction ni ordre."}</small></div>
          <button className="ghostButton" disabled={busy} type="button" onClick={() => control("verify-account")}>{data.credentials.accountVerified ? "RETESTER" : "TESTER LA CONNEXION"}</button>
        </article>
        <article className={data.credentials.approvalsPrepared ? "done" : "pending"}>
          <span>2</span><div><b>Préparer les permissions</b><small>{data.credentials.approvalsPrepared ? `Permissions préparées ${ago(data.credentials.approvalsPreparedAt)}.` : "Polymarket vérifie les permissions existantes et ne prépare que celles qui manquent. Aucun pari n’est envoyé."}</small></div>
          <button className="ghostButton" disabled={busy || !data.credentials.accountVerified} type="button" onClick={prepareApprovals}>{data.credentials.approvalsPrepared ? "REVÉRIFIER" : "PRÉPARER LES AUTORISATIONS"}</button>
        </article>
      </div>}
      <p className="credentialNote">Ne fais aucune capture d’écran avec les champs visibles. Après enregistrement, conserve ta copie de secours hors ligne : Poly Tape ne peut pas te restituer les valeurs en clair.</p>
    </section>

    <section className={`schedulerCard wideCard ${schedulerInstalled ? "installed" : ""}`}>
      <div className="sectionTitle"><div><span className="shield">↻</span><div><small>CADENCE NATIVE ET TRANSPORT RÉGIONAL 24 H / 24</small><h2>Automatisation Poly Tape</h2></div></div><span>{schedulerInstalled ? "ACTIF" : data.credentials.schedulerSecretReady ? "À FINALISER" : "PRÉPARATION"}</span></div>
      {schedulerInstalled ? <div className="schedulerSuccess">
        <span>✓</span><div><b>Cycle automatique et Polymarket régional</b><p>Dernier battement {ago(data.state.last_scheduled_cycle_at)} · transport {data.network.executionRegion}. Aucun jeton Cloudflare n’est conservé par Poly Tape.</p></div>
      </div> : <div className="schedulerSetup">
        <div className="schedulerGuide">
          <p>La cadence de l’exécuteur tourne déjà chaque minute sur Cloudflare. Cette étape ajoute uniquement le relais européen par lequel passent les appels Polymarket. Elle n’arme aucun ordre et ne modifie aucune limite.</p>
          <p><b>Une seule validation :</b> indique ton Account ID et colle un jeton avec la permission Account · Workers Scripts · Edit. Poly Tape installe le relais, vérifie la région puis oublie le jeton.</p>
        </div>
        <form className="schedulerForm" autoComplete="off" onSubmit={installScheduler}>
          <label><span>Cloudflare Account ID</span><input value={cloudflareDraft.accountId} required type="text" inputMode="text" autoComplete="off" spellCheck={false} pattern="[0-9a-fA-F]{32}" placeholder="32 caractères" disabled={busy || !data.credentials.schedulerSecretReady} onChange={event => setCloudflareDraft(current => ({ ...current, accountId: event.target.value.trim() }))} /></label>
          <label><span>Jeton API Cloudflare</span><input value={cloudflareDraft.apiToken} required type="password" autoComplete="new-password" spellCheck={false} placeholder="Workers Scripts · Edit" disabled={busy || !data.credentials.schedulerSecretReady} onChange={event => setCloudflareDraft(current => ({ ...current, apiToken: event.target.value }))} /></label>
          <button className="saveButton" disabled={busy || !data.credentials.schedulerSecretReady} type="submit">ACTIVER LE TRANSPORT RÉGIONAL</button>
          <small>Le jeton transite une seule fois en mémoire pour créer le relais. Il n’est écrit ni dans la base, ni dans les variables du serveur, ni dans les journaux.</small>
        </form>
      </div>}
    </section>

    <section className="setupGrid">
      <article className="configCard">
        <div className="sectionTitle"><div><span className="shield">↕</span><div><small>CONFIGURATION PERSISTANTE</small><h2>Tes limites d’exécution</h2></div></div><span>{data.pilot.riskConfigured ? "CONFIGURÉ" : "À DÉFINIR"}</span></div>
        <form onSubmit={saveRisk} className="riskForm">
          {field("capitalCap", "Capital alloué", "ex. 250")}
          {field("baseStake", "Mise de base", "ex. 3")}
          {field("maxStake", "Mise maximale", "ex. 7.5")}
          {field("maxExposure", "Exposition totale max.", "ex. 30")}
          {field("maxPositions", "Positions simultanées", "ex. 4", "1")}
          {field("maxOrdersPerDay", "Ordres maximum / jour", "ex. 8", "1")}
          {field("targetSignalsMin", "Cible basse / jour", "ex. 4", "1")}
          {field("targetSignalsMax", "Cible haute / jour", "ex. 8", "1")}
          {field("dailyStop", "Stop de perte journalier", "ex. 10")}
          {field("weeklyStop", "Stop de perte hebdomadaire", "ex. 25")}
          {field("hardDrawdown", "Drawdown absolu", "ex. 40")}
          {field("makerImprovementTicks", "Amélioration du prix maker (ticks)", "ex. 1", "1")}
          {field("makerTimeoutSeconds", "Attente maker avant secours (secondes)", "ex. 90", "1")}
          {field("takeProfitPercent", "Take-profit automatique (%)", "ex. 8", "0.5")}
          {field("minimumProfitTicks", "Gain minimal du take-profit (ticks)", "ex. 2", "1")}
          <button className="saveButton" disabled={busy} type="submit">ENREGISTRER MES LIMITES</button>
        </form>
        <p className="formNote">Le moteur tente d’abord un ordre maker post-only, l’annule après le délai choisi, puis n’utilise le secours immédiat que si l’avantage et la profondeur sont toujours valides. Modifier un réglage désarme le réel.</p>
      </article>

      <article className="safetyCard">
        <div className="sectionTitle"><div><span className="shield">◆</span><div><small>PRÉREQUIS OPÉRATIONNELS</small><h2>Autorisation du réel</h2></div></div><b>{gates.filter(([, ok]) => ok).length}/{gates.length}</b></div>
        <div className="gateList">{gates.map(([label, ok, detail]) => <div key={label} className={ok ? "ok" : "locked"}><span>{ok ? "✓" : "×"}</span><div><b>{label}</b><small>{detail}</small></div></div>)}</div>
        <p className="safetyNote">Ce ne sont pas des limites d’essai : ce sont les conditions minimales pour éviter une signature sans capital défini, depuis une zone bloquée ou sans moteur permanent.</p>
        <div className="controls"><button disabled={busy || !data.liveReady || data.state.mode === "LIVE"} onClick={armLive}>ARMER LE RÉEL</button><button disabled={busy} onClick={runCycle}>CYCLE MANUEL</button><button disabled={busy || data.state.mode === "PAPER"} onClick={() => control("paper")}>DÉSACTIVER LE RÉEL</button><button disabled={busy || data.state.mode === "PAUSED"} onClick={() => control("pause")}>ARRÊT IMMÉDIAT</button></div>
      </article>
    </section>

    <section className="rulesCard wideCard">
      <div className="sectionTitle"><div><div><small>PROTOCOLE D’ENTRÉE ET DE SORTIE</small><h2>Optimisation de chaque position</h2></div></div><span>AUTOMATIQUE</span></div>
      <div className="ruleGrid"><span><small>ENTRÉE</small><b>Maker post-only</b></span><span><small>ATTENTE MAKER</small><b>{data.pilot.makerTimeoutSeconds} s</b></span><span><small>TAKE-PROFIT</small><b>+{data.pilot.takeProfitPercent}% min.</b></span><span><small>GAIN PLANCHER</small><b>{data.pilot.minimumProfitTicks} ticks</b></span><span><small>MISE MAX.</small><b>{data.pilot.riskConfigured ? money(data.pilot.maxStake) : "à définir"}</b></span><span><small>SPREAD MAX.</small><b>{(data.pilot.maxSpread * 100).toFixed(1)} pt</b></span><span><small>PROFONDEUR</small><b>≥ {data.pilot.minimumDepthMultiple}× mise</b></span><span><small>AVANTAGE</small><b>≥ {data.pilot.minimumEdgePoints} pts</b></span><span><small>CONVERGENCE</small><b>≥ {data.pilot.minimumWallets} wallets</b></span><span><small>PRESSION ACHAT</small><b>≥ {data.pilot.minimumBuyPressure}%</b></span><span><small>FRAÎCHEUR</small><b>≤ {data.pilot.maximumSignalAgeSeconds} s</b></span><span><small>EXPOSITION</small><b>{data.pilot.riskConfigured ? `≤ ${money(data.pilot.maxExposure)}` : "à définir"}</b></span></div>
    </section>

    <section className="journal">
      <div className="journalHead"><div><small>EXÉCUTION POLYMARKET UNIQUEMENT</small><h2>Journal du réel</h2></div><div className="filters">{(["ALL", "OPEN", "RESOLVED", "REJECTED"] as const).map(value => <button className={filter === value ? "active" : ""} onClick={() => setFilter(value)} key={value}>{value === "ALL" ? "TOUT" : value === "OPEN" ? "EN COURS" : value === "RESOLVED" ? "RÉSOLUS" : "REFUSÉS"}</button>)}</div></div>
      {decisions.length ? <div className="decisionList">{decisions.map(item => <article key={item.id}><div className={`decisionState ${item.status.toLowerCase()}`}><b>{statusLabels[item.status] || item.status}</b><small>{ago(item.created_at)}</small></div><div className="decisionMarket"><h3>{item.title}</h3><p>{item.outcome}</p><small>{item.category} · score {item.score} · {item.wallets} wallets · pression {item.buy_pressure.toFixed(0)}%</small></div><div><small>EDGE / ENTRÉE</small><b>{item.edge_points >= 0 ? "+" : ""}{item.edge_points.toFixed(1)} pts</b><em>{item.fill_price == null ? `${item.entry_strategy} en attente` : `${(item.fill_price * 100).toFixed(1)}¢ · ${item.entry_strategy}`}</em></div><div><small>MISE / SORTIE</small><b>{item.status === "REJECTED" ? (rejectLabels[item.reject_reason || ""] || item.reject_reason || "refusé") : money(item.stake)}</b><em className={(item.pnl || 0) >= 0 ? "positive" : "negative"}>{item.pnl != null ? money(item.pnl) : item.exit_target_price != null ? `TP ${(item.exit_target_price * 100).toFixed(1)}¢` : "résolution"}</em></div>{(item.event_slug || item.market_slug) && <a href={item.event_slug ? `https://polymarket.com/event/${item.event_slug}` : `https://polymarket.com/market/${item.market_slug}`} target="_blank" rel="noreferrer" aria-label="Ouvrir le marché exact">↗</a>}</article>)}</div> : <div className="empty"><span>◎</span><h3>Aucun ordre réel enregistré</h3><p>Seules les exécutions réellement envoyées à Polymarket et leurs refus de sécurité apparaîtront ici.</p></div>}
    </section>

    {(error || notice) && <div className={`toast ${error ? "error" : "notice"}`}>{error || notice}<button onClick={() => { setError(""); setNotice(""); }}>×</button></div>}
    <footer><span>POLY TAPE EXECUTOR · ACCÈS PRIVÉ</span><p>Aucun rendement n’est garanti. Le moteur n’augmente jamais la fréquence en abaissant ses seuils.</p></footer>
  </main>;
}

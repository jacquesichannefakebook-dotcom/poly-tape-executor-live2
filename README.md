# Poly Tape Executor

Exécuteur Polymarket privé et autonome sur Cloudflare Workers.

## Déploiement Cloudflare

Le projet contient tout ce qu'il faut pour un déploiement Workers natif :

- interface privée protégée par `POLY_TAPE_ADMIN_SECRET` ;
- base D1 provisionnée automatiquement ;
- cadence native chaque minute ;
- moteur maker post-only, annulation contrôlée et secours FOK conditionnel ;
- take-profit automatique ;
- coffre chiffré pour les identifiants Polymarket ;
- relais européen séparé installé depuis l'interface avec un jeton Cloudflare à usage unique.

Le déploiement demande un seul secret : `POLY_TAPE_ADMIN_SECRET`, d'au moins 16 caractères. Il sert de code d'accès à la console et permet de dériver les secrets internes sans les placer dans le dépôt.

```sh
npm ci
npm run deploy
```

Wrangler provisionne la base `poly-tape-executor-live`, publie l'application et active le déclencheur `* * * * *`. Au premier accès :

1. saisir le code administrateur ;
2. enregistrer les identifiants Polymarket ;
3. vérifier la connexion et préparer les autorisations ;
4. installer le relais régional avec l'Account ID et un jeton limité à `Account · Workers Scripts · Edit` ;
5. enregistrer les limites personnelles puis armer le réel.

Le jeton Cloudflare utilisé à l'étape 4 n'est pas conservé.

## Validation

```sh
npm run lint
npx tsc --noEmit
npm test
npx wrangler deploy --dry-run --config wrangler.jsonc
```

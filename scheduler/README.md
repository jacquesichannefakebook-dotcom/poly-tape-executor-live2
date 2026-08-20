# Poly Tape Scheduler

Ce Worker appelle l'endpoint privé de Poly Tape Executor chaque minute. Il ne
contient aucune clé Polymarket et ne peut ni signer ni envoyer un ordre.

Secrets Cloudflare requis :

- `CRON_SECRET` : doit être identique à `POLY_TAPE_CRON_SECRET` dans Sites ;
- `SITES_BYPASS_TOKEN` : jeton privé permettant au Worker d'atteindre le Site
  réservé à son propriétaire.

Le moteur Polymarket, ses limites et son journal restent dans le Site privé.

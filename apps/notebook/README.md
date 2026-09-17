# `@libre-ai/notebook` — host de sauvegarde Gate B

Ce paquet est le premier host produit Notebook Core v2. Il reste **désactivé par défaut** et n'utilise que la fixture publique `libre-ai.notebook-product-host-fixture.v1`. Il ne doit recevoir aucune note ou sauvegarde utilisateur avant la décision Gate B.

## Frontières

- un Dedicated Worker neuf par opération `seal` ou `open` ;
- transfert d'ownership des `ArrayBuffer` et terminaison du worker sur succès, refus, erreur, message hostile ou timeout ;
- CSPRNG Web Crypto pour l'identifiant, le recovery de 16 octets, le salt et le nonce ;
- composant Notebook Core v2 sans import, compilé avec SIMD128 et servi sous une CSP ciblée `wasm-unsafe-eval` sans autoriser `unsafe-eval` JavaScript ;
- erreurs statiques uniquement ; aucun diagnostic du worker, plaintext ou secret n'est journalisé ;
- préflight obligatoire du contexte sécurisé, du Worker, du transfert `ArrayBuffer`, de Web Crypto, d’IndexedDB et de 512 Mio de quota disponible ;
- recovery affiché seulement après réussite de la persistance chiffrée et du déclenchement du téléchargement, mais jamais confié à IndexedDB, au téléchargement, au nom de fichier ou au serveur ;
- téléchargement neutre `notebook-backup.lai` ;
- aucune requête externe runtime.

## IndexedDB et reprise

La base `libre-ai-notebook`, store `backup-runtime`, ne contient que :

- la dernière enveloppe chiffrée ;
- une enveloppe chiffrée temporaire pendant une restauration ;
- un reçu final limité à l'identifiant et au digest publics de l'enveloppe.

Le plaintext ouvert reste dans le callback de consommation puis est écrasé best-effort. Une restauration interrompue peut laisser uniquement son enveloppe chiffrée temporaire ; le prochain chargement la supprime avant toute nouvelle opération. Le commit du reçu et la suppression du staging partagent une transaction IndexedDB stricte.

La destruction logique des références et workers ne prouve pas l'effacement physique des copies navigateur, RAM, swap ou OS.

## Feature gate

Build normal, fermé et sans artefact Notebook Core :

```sh
bun run --cwd apps/notebook build
```

Build Gate B avec le Node épinglé dans `toolchains/notebook-qualification.json` :

```sh
export NOTEBOOK_QUALIFICATION_NODE=/path/to/node-v26.5.0/bin/node
bun run --cwd apps/notebook build:gate-b
```

Le build Gate B réutilise le builder audité, puis ne copie dans `dist` que le core normal, ses bindings et le worker produit. Les composants `qualification-faults`, trap et workers de qualification sont refusés par la frontière de shipping. `dist/notebook-build-manifest.json` lie le commit, les hashes des fichiers livrables et le manifeste de provenance du core.

Le serveur doit recevoir le même gate que le build :

```sh
NOTEBOOK_BACKUP_FEATURE_ENABLED=1 bun run --cwd apps/notebook start
```

Toute valeur autre que `1` laisse l'interface et les routes WASM désactivées. `app.js` est servi avec `Cache-Control: no-store`, et aucun Service Worker n'est enregistré ou livré pendant Gate B : un cache applicatif antérieur ne doit jamais pouvoir rejouer un build activé après fermeture du gate. Le mode hors ligne complet sera ajouté seulement avec son propre test de rollback de cache.

## Vérifications

```sh
bun test apps/notebook
bun run typecheck

export NOTEBOOK_QUALIFICATION_NODE=/path/to/node-v26.5.0/bin/node
bun run --cwd apps/notebook test:e2e
bun run qualify:notebook-product-host:faults
bun run qualify:notebook-product-host:storage
```

Le parcours Playwright exécute Chromium, Firefox et WebKit : chiffrement réel, nom de téléchargement, absence du recovery dans l'enveloppe et IndexedDB, restauration, mauvais recovery, staging interrompu et reprise sur une nouvelle page. La campagne de fautes produit force ensuite un `SIGKILL` pendant le seal et un crash `SIGABRT` pendant la restauration sur le groupe de processus de chaque moteur, relance le même profil persistant et vérifie l'absence de téléchargement/reçu partiel, le nettoyage du staging et la création de nouveaux workers. Elle teste aussi le refus préflight d'un quota sous le plancher et un abort transactionnel IndexedDB injecté ; ce dernier n'est pas une preuve d'épuisement physique du disque.

La campagne storage, macOS arm64 uniquement, place le profil de chaque moteur sur une image APFS sparse jetable de 6 Gio. Elle conserve un marqueur OS `ENOSPC`, vérifie le refus du staging transactionnel d'une enveloppe publique déterministe de 16 Mio avant tout worker, relance le même profil sans état partiel, puis restaure et sauvegarde après libération de l'espace. Elle échoue si la machine ne peut pas conserver 8 Gio libres hors image. Cette preuve qualifie le comportement produit sous `ENOSPC`, pas une classe matérielle ni l'exactitude de l'estimation de quota du navigateur.

## Limites ouvertes

Ce host qualifie la mécanique sauvegarde/restauration sur fixture publique ; il n'implémente pas encore le modèle complet blocs/révisions ni son import atomique chiffré. Gate B est approuvée sur le candidat immuable `9ee3f8d` après les passes spécialisées, la classe physique 32+ Gio et la matrice trois moteurs. Restent hors preuve ou facultatifs : OOM réel du processus navigateur, matériel physique 8/16–24 Gio et effacement physique. La preuve APFS locale ne qualifie aucune classe matérielle. L'activation, les données utilisateur, la production et la release demeurent **NON AUTORISÉES**.

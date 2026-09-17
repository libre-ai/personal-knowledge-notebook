# Notebook — plancher de ressources candidat

## Décision

Conformément à l'ADR-0006, le **minimum produit candidat actuellement qualifié** est :

- macOS arm64 sur une machine de **32 Gio de mémoire physique minimum** et de **12 CPU logiques minimum** ;
- navigateur capable d'exécuter WebAssembly SIMD128, Dedicated Worker, transfert d'`ArrayBuffer`, Web Crypto et IndexedDB ;
- quota de stockage navigateur disponible de **512 Mio minimum** ;
- budgets inchangés : profil producteur `p95 ≤ 5 s` et RSS additionnel `≤ 256 Mio`, profil maximal `p95 ≤ 10 s` et RSS additionnel `≤ 512 Mio`.

Ce plancher décrit seulement la matrice prouvée. Il ne transforme pas macOS arm64 en nécessité du format et n'autorise ni activation ni release à lui seul. Windows, Linux, x86 et les machines de moins de 32 Gio restent non qualifiés tant que leurs propres preuves ne sont pas archivées.

## Classes matérielles

L'autorité exécutable est `toolchains/notebook-resource-classes.json`.

| Classe | Mémoire physique | CPU logiques | Rôle actuel | État |
|---|---:|---:|---|---|
| `desktop-arm64-constrained-8gib` | 8 Gio à moins de 12 Gio | 8 ou plus | observation communautaire facultative | preuve demandée |
| `desktop-arm64-mainstream-16gib` | 16 à 24 Gio | 8 ou plus | observation communautaire facultative | preuve demandée |
| `desktop-arm64-high-memory-reference` | 32 Gio ou plus | 12 ou plus | minimum produit candidat | qualifiée sur le candidat `96934a8` |

Les classes restent disjointes afin qu'une machine 32+ Gio ne puisse jamais produire une fausse preuve 8 ou 16 Gio. Les campagnes #98 et #99 sont utiles pour élargir ultérieurement le support, mais leur absence ne bloque plus Gate B. Aucune annonce de support 8/16–24 Gio n'est permise sans leurs mesures physiques et une revue.

## Pourquoi le plancher déclaré est 32+ Gio

Notebook Core borne le plaintext one-shot à 16 Mio, mais le chemin réel cumule entrée ABI, matrice Argon2id de 64 ou 128 Mio, AES-GCM, Base64/JCS, mémoire WASM et host navigateur. La campagne physique exacte mesure deux warm-ups puis 20 seal/open par profil dans les trois moteurs et respecte les budgets sans modifier la cryptographie.

La classe 32+ Gio est la seule classe dont la preuve physique est disponible. La choisir comme plancher est une réduction explicite de portée, pas une extrapolation vers les machines modestes. Une future preuve 8 ou 16–24 Gio pourra abaisser le plancher ou étendre la matrice sans changer les budgets ; un échec conduira à optimiser le moteur ou à conserver le minimum, jamais à affaiblir Argon2id.

Le quota candidat de 512 Mio ne prouve pas la capacité totale du notebook. Il couvre une marge conservatrice pour stockage local, enveloppe maximale et copies temporaires. Le vrai comportement `ENOSPC` du host produit est qualifié séparément sur APFS jetable.

## Qualification de la classe requise

```sh
export NOTEBOOK_QUALIFICATION_DEVICE_CLASS=desktop-arm64-high-memory-reference
export NOTEBOOK_QUALIFICATION_NODE=/path/to/node-26.5.0/bin/node
export NOTEBOOK_QUALIFICATION_ARCHIVE_DIR=/path/to/verified-archives
export NOTEBOOK_QUALIFICATION_EVIDENCE_MODE=physical-evidence
bun run qualify:notebook-core-v2:performance
```

Le harness :

1. lit mémoire, CPU, architecture et OS du host ;
2. refuse toute machine hors de la classe sélectionnée ;
3. vérifie contexte sécurisé, Worker, transfert d'`ArrayBuffer`, Web Crypto, IndexedDB et 512 Mio de quota ;
4. exécute deux warm-ups puis 20 seal/open par profil sur Chromium, Firefox et WebKit ;
5. lie chaque rapport au commit, aux bornes de classe et au SHA-256 du manifeste ;
6. rejette la matrice si les rapports divergent ou dépassent un budget.

Une simulation, une VM, `ulimit`, un throttling ou une extrapolation reste diagnostic-only.

## Contributions facultatives 8 et 16–24 Gio

Les propriétaires de machines physiques modestes peuvent exécuter le même protocole avec :

```sh
export NOTEBOOK_QUALIFICATION_DEVICE_CLASS=desktop-arm64-constrained-8gib
# ou desktop-arm64-mainstream-16gib
```

Ces résultats sont importants pour découvrir des régressions et étendre le support, mais ils ne conditionnent plus le verdict Gate B courant. Une classe devient supportée seulement après archivage des rapports bruts sur commit immuable, contrôle des hashes et passe `review-only`.

Le protocole public et les règles de confidentialité sont détaillés dans [`../../tools/qualification/notebook-core-v2/CONTRIBUTING-DEVICE-QUALIFICATION.md`](../../tools/qualification/notebook-core-v2/CONTRIBUTING-DEVICE-QUALIFICATION.md). Fixtures publiques uniquement : aucun notebook, compte iCloud, numéro de série ou identifiant matériel unique.

## Diagnostic en machine virtuelle

Une VM macOS arm64 avec 8 ou 16 Gio assignés peut révéler tôt un dépassement, mais ne reproduit ni mémoire unifiée, ni pression physique, ni swap, ni thermique. Son résumé reste `vm-diagnostic`, `promotableEvidence: false` et ne qualifie aucune classe.

## Conditions hors matrice matérielle

La qualification 32+ Gio ne ferme pas le modèle produit complet, l'import atomique, la suppression, l'offline ou la release, qui conservent leurs gates propres. L'ADR-0007 classe l'OOM réel du processus navigateur comme diagnostic facultatif et interdit toute saturation globale de RAM ou swap ; la reprise bornée après terminaison/crash demeure la preuve Gate B obligatoire. L'effacement logique/best-effort ne prouve jamais l'effacement physique RAM ou swap.

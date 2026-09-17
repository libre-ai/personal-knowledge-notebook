<!-- SPDX-FileCopyrightText: 2026 Libre AI contributors -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Développement local

Le code récupéré est intégré dans `apps/notebook, crates/notebook-core`. Les sous-paquets conservent leurs noms et versions propres ; ce dépôt n’est pas un paquet monolithique. La provenance par fichier et les notices historiques sont dans `code-recovery-provenance.json` et `source-licensing/`.

## Installer et vérifier

Cette branche utilise une composition locale de dépôts voisins : `project-governance`, `schemas-and-contracts`, `application-development-toolkit`, `organization-data-lifecycle` et, selon le consommateur, `ai-model-policy`. Les dépendances `file:` et leurs overrides racine sont relatifs ; aucun chemin personnel n’est requis. Construire d’abord le paquet UI dans le toolkit afin que ses exports navigateur soient présents. Les workspaces partagent leurs versions de React ; ne pas lancer une installation indépendante à l’intérieur d’une application.

Depuis la racine du dépôt, avec Bun 1.4.0-canary.1 (révision57f349f63) :

```sh
bun install --ignore-scripts
bun install --frozen-lockfile --ignore-scripts
bun run check
```

L’installation est une étape explicite ; `check` ne télécharge plus de dépendances. Les contrôles Bun, toolchain, secrets, données personnelles et les suites applicables restent bloquants. Les tests d’intégration utilisant PGlite n’ouvrent pas de base de données de production. Les scripts de déploiement hérités ne sont pas nécessaires à ces vérifications et ne doivent pas être exécutés pour un test local.

## État et limites

Les résultats observés sont dans [verification-status.json](verification-status.json). Les suites navigateur utilisant le même port doivent être exécutées séquentiellement. Un build local ne constitue ni publication de paquet, ni déploiement, ni validation de toutes les intégrations futures. Les README d’applications et les documents historiques décrivent aussi des étapes non réalisées ; leur ancien statut n’est pas une preuve actuelle.

Rust1.97.0 et wasm32-unknown-unknown sont utilisés par les moteurs. Vérification native : `cargo test --locked --offline`. Les tests WASM doivent être distingués des tests natifs.

Le build courant sans sauvegarde utilise `bun run --cwd apps/notebook build`. La sauvegarde exige `NOTEBOOK_QUALIFICATION_NODE` pointant sur Node26.5.0 correspondant exactement au SHA du manifeste `toolchains/notebook-qualification.json`, puis `bun run --cwd apps/notebook build:gate-b`. La fonctionnalité chiffrée ne doit pas être annoncée à partir du seul build sans sauvegarde.

Le test courant est `NOTEBOOK_QUALIFICATION_NODE=/chemin/vers/node bun run --cwd apps/notebook test:e2e --workers=1`. Le chemin est fourni par l’utilisateur ; il doit correspondre au binaire épinglé. Voir [les limites de la preuve du build](notebook-build-migration.md).

## Navigateurs et sauvegardes

La sauvegarde exige l’API native d’estimation du stockage, avec au moins 512 Mio disponibles. Si cette capacité manque, l’application désactive la création et la restauration avant de créer un worker ; aucun quota de remplacement n’est inventé.

La CI Linux vérifie les parcours complets sous Chromium et Firefox, ainsi que le refus explicite du WebKit Linux testé, qui ne fournit pas cette API. Une CI macOS distincte vérifie les parcours complets WebKit. Les deux workflows doivent réussir sur le même commit ; un refus Linux réussi ne prouve pas le fonctionnement de la sauvegarde sur ce navigateur.

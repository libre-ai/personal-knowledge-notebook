# Appel à contribution — qualification des machines Notebook modestes

Notebook Core v2 est qualifié sur la classe physique 32+ Gio. Pour découvrir les limites et étendre ultérieurement le support aux machines Apple Silicon modestes, nous cherchons facultativement des personnes ou organisations disposant de l'une des configurations suivantes. L'absence de ces contributions ne bloque plus Gate B conformément à l'ADR-0006 :

| Besoin | Classe à sélectionner | Machine recherchée |
|---|---|---|
| observation contrainte | `desktop-arm64-constrained-8gib` | Mac physique arm64, 8 Gio à moins de 12 Gio, au moins 8 CPU logiques |
| observation courante | `desktop-arm64-mainstream-16gib` | Mac physique arm64, 16 à 24 Gio, au moins 8 CPU logiques |
| diagnostic précoce | l'une des deux classes | VM macOS arm64 avec 8 ou 16 Gio assignés |

Un MacBook Air M1/M2 8 Gio est particulièrement intéressant car il représente une cible fanless contrainte. Il n'est pas nécessaire de prêter la machine : la campagne peut être exécutée par son propriétaire.

## Sécurité et confidentialité

La campagne n'ouvre aucun notebook et n'utilise que les fixtures publiques déterministes du dépôt. Ne fournissez jamais de note, sauvegarde, secret, identifiant Apple, numéro de série ou UUID matériel. Utilisez de préférence un compte macOS local temporaire sans iCloud, synchronisation, extension de navigateur ni donnée personnelle.

Le runtime de mesure bloque les requêtes externes. Le réseau n'est requis qu'avant la campagne pour récupérer le dépôt et les archives publiques épinglées. Les rapports contiennent le modèle matériel générique, la mémoire, le nombre de CPU, la version du système, les versions navigateur, les durées et les pics RSS ; ils ne doivent contenir aucun identifiant matériel unique.

Certaines URL de provenance Playwright passent actuellement par des CDN non européens. Elles ne reçoivent aucune donnée d'exécution, mais ne satisfont pas à elles seules une exigence de bootstrap souverain. La voie préférée est donc un paquet d'archives remis hors ligne par le mainteneur puis vérifié contre les SHA-256 du manifeste. Toute récupération directe doit être déclarée comme une dépendance de bootstrap, jamais comme une dépendance runtime.

## Deux niveaux de résultat

### Preuve physique candidate

Une machine physique utilise :

```sh
export NOTEBOOK_QUALIFICATION_EVIDENCE_MODE=physical-evidence
```

Le harness refuse les signaux de virtualisation connus. Un résultat vert produit `qualification-budgets-pass`, mais ne suffit pas à déclarer la classe supportée : le commit et les fichiers bruts font ensuite l'objet d'une passe `review-only` et d'une décision explicite.

### Diagnostic VM

Une VM utilise exclusivement :

```sh
export NOTEBOOK_QUALIFICATION_EVIDENCE_MODE=vm-diagnostic
```

Son résumé porte toujours `promotableEvidence: false`. Un succès est nommé `diagnostic-budgets-pass`, jamais `qualification-budgets-pass`. Une VM permet de trouver tôt une régression de temps, de quota ou de mémoire ; elle ne reproduit pas la pression mémoire physique, la mémoire unifiée, le swap ni les contraintes thermiques d'un appareil 8 Gio.

## 1. S'inscrire avant l'exécution

Ouvrez une issue intitulée `Notebook qualification volunteer — <classe> — <modèle générique>` avec uniquement :

```text
Mode : physical-evidence | vm-diagnostic
Classe : desktop-arm64-constrained-8gib | desktop-arm64-mainstream-16gib
Modèle générique : par exemple MacBook Air M1
Mémoire : 8 | 16 | 24 Gio
CPU logiques : nombre
Version macOS : version publique, sans numéro de série
Disponibilité approximative : date ou période
```

Un mainteneur répond avec le commit candidat immuable, son tree hash et les SHA-256 attendus. N'exécutez pas arbitrairement la branche `main` : une preuve n'est attribuable qu'au candidat déclaré dans l'issue.

## 2. Préparer la machine

Prévoir une session de une à deux heures, la machine branchée au secteur et la veille désactivée pour la durée du test.

Prérequis :

- macOS arm64 et outils de ligne de commande Xcode ;
- Git et `rustup`, le dépôt imposant Rust `1.97.0` et `wasm32-unknown-unknown` ;
- le binaire Bun exact déclaré dans `toolchains/bun.json` ;
- Node et les trois navigateurs dont versions, URL et SHA-256 sont déclarés dans `toolchains/notebook-qualification.json` ;
- plusieurs dizaines de Gio libres pour le dépôt, Rust, Node, Playwright et les résultats.

Le mainteneur doit fournir le binaire Bun archivé correspondant au SHA-256 du manifeste. Une version « proche » n'est pas recevable.

```sh
git clone https://github.com/libre-ai/libre-ai.git
cd libre-ai
git checkout --detach <commit-candidat-fourni>
test -z "$(git status --porcelain)"

# Le PATH doit désigner le Bun exact fourni pour la campagne.
bun --revision
bun run check:toolchain
bun install --frozen-lockfile
bun x playwright install chromium firefox webkit
```

Créez ensuite un répertoire hors Git contenant les quatre archives nommées exactement comme dans `toolchains/notebook-qualification.json` : Node, Chromium, Firefox et WebKit. Utilisez de préférence le paquet hors ligne remis par le mainteneur. À défaut, récupérez chaque `archiveUrl` du manifeste sans substituer de version et consignez cette dépendance de bootstrap. Le harness vérifiera chaque SHA-256 avant de mesurer.

Extrayez l'archive Node épinglée et repérez son exécutable `bin/node` :

```sh
mkdir -p "$HOME/notebook-qualification/archives" "$HOME/notebook-qualification/node"
tar -xJf "$HOME/notebook-qualification/archives/node-v26.5.0-darwin-arm64.tar.xz" \
  -C "$HOME/notebook-qualification/node"
```

Les noms et versions montrés ici décrivent le manifeste actuel ; le manifeste du commit candidat reste l'autorité.

## 3. Vérifier le host sans divulguer d'identifiant

Cette commande produit un relevé public minimal. Elle ne collecte ni numéro de série ni UUID :

```sh
{
  sw_vers
  printf 'architecture='; uname -m
  printf 'model='; sysctl -n hw.model
  printf 'memoryBytes='; sysctl -n hw.memsize
  printf 'logicalCpu='; sysctl -n hw.logicalcpu
  printf 'processor='; sysctl -n machdep.cpu.brand_string
  printf 'hypervisorPresent='; sysctl -n kern.hv_vmm_present
} > "$HOME/notebook-qualification/host-public.txt"
```

Pour une preuve physique, attestez dans l'issue que la machine n'est pas une VM, qu'aucune limite de ressources n'a été simulée et qu'aucune autre charge importante n'a été volontairement lancée pendant la campagne.

## 4. Exécuter la matrice physique

Exemple 8 Gio :

```sh
export NOTEBOOK_QUALIFICATION_DEVICE_CLASS=desktop-arm64-constrained-8gib
export NOTEBOOK_QUALIFICATION_EVIDENCE_MODE=physical-evidence
export NOTEBOOK_QUALIFICATION_NODE="$HOME/notebook-qualification/node/node-v26.5.0-darwin-arm64/bin/node"
export NOTEBOOK_QUALIFICATION_ARCHIVE_DIR="$HOME/notebook-qualification/archives"

set -o pipefail
bun run qualify:notebook-core-v2:performance 2>&1 \
  | tee "$HOME/notebook-qualification/performance.log"
```

Pour 16 ou 24 Gio, remplacez uniquement la classe par `desktop-arm64-mainstream-16gib`. Ne modifiez ni les itérations, ni les warm-ups, ni les budgets, ni les paramètres KDF.

## 5. Commencer dans une VM avec UTM

[UTM](https://github.com/utmapp/UTM) est open source sous Apache-2.0 et utilise `Virtualization.framework` pour les invités macOS sur Apple Silicon. D'après sa [documentation macOS officielle](https://docs.getutm.app/guest-support/macos/), un host Apple Silicon sous macOS 12 ou ultérieur peut créer une VM via **Virtualization → macOS 12+** ; le backend Apple est le seul backend UTM capable de virtualiser macOS sur Apple Silicon.

1. installez UTM depuis sa source officielle ;
2. créez un invité **Virtualization → macOS 12+**, backend Apple ;
3. assignez 8 CPU et exactement 8 Gio pour tester la classe contrainte, ou 16 Gio pour la classe courante ;
4. prévoyez au moins 80 Gio de disque virtuel et installez macOS ;
5. dans l'invité, reprenez les étapes 2 et 3 ci-dessus ;
6. remplacez l'exécution physique par :

```sh
export NOTEBOOK_QUALIFICATION_DEVICE_CLASS=desktop-arm64-constrained-8gib
export NOTEBOOK_QUALIFICATION_NODE="$HOME/notebook-qualification/node/node-v26.5.0-darwin-arm64/bin/node"
export NOTEBOOK_QUALIFICATION_ARCHIVE_DIR="$HOME/notebook-qualification/archives"

set -o pipefail
bun run diagnose:notebook-core-v2:performance:vm 2>&1 \
  | tee "$HOME/notebook-qualification/performance-vm.log"
```

Mentionnez dans l'issue le modèle et la mémoire du host, la RAM/CPU assignée, la version UTM, le backend Apple et la version macOS invitée. Ces informations qualifient le diagnostic, pas une classe physique.

## 6. Remettre les résultats

Après un passage complet, les fichiers attendus sont :

```text
target/notebook-core-v2-qualification/manifest.json
target/notebook-core-v2-qualification/performance-chromium.json
target/notebook-core-v2-qualification/performance-firefox.json
target/notebook-core-v2-qualification/performance-webkit.json
target/notebook-core-v2-qualification/performance-summary.json
```

Créez une archive sans ajouter le cache navigateur, les toolchains ou le reste de `target` :

```sh
tar -czf "$HOME/notebook-qualification/notebook-results.tgz" \
  target/notebook-core-v2-qualification/manifest.json \
  target/notebook-core-v2-qualification/performance-chromium.json \
  target/notebook-core-v2-qualification/performance-firefox.json \
  target/notebook-core-v2-qualification/performance-webkit.json \
  target/notebook-core-v2-qualification/performance-summary.json

shasum -a 256 \
  "$HOME/notebook-qualification/host-public.txt" \
  "$HOME/notebook-qualification/performance"*.log \
  "$HOME/notebook-qualification/notebook-results.tgz"
```

Inspectez le relevé, le journal et les JSON avant envoi. Ne modifiez jamais un JSON brut ; si le journal révèle un nom de compte ou un chemin personnel, signalez-le au mainteneur et transmettez les JSON séparément. Le mainteneur vérifie les hashes, le commit, le composant, la classe, les trois navigateurs et le mode avant d'archiver quoi que ce soit dans Git.

## Critères d'acceptation d'une preuve physique

- commit et tree hash identiques à l'appel ;
- arbre Git propre avant l'exécution ;
- Bun, Node, Playwright, navigateurs et archives conformes aux SHA-256 ;
- machine dans les bornes de la classe et absence de virtualisation déclarée/détectée ;
- deux warm-ups puis vingt itérations par profil dans les trois navigateurs ;
- rapports cohérents avec `physical-evidence` et `promotableEvidence: true` ;
- aucune donnée personnelle, requête externe, console ou erreur de page ;
- fichiers bruts revus sur commit immuable par une passe distincte.

Un résultat échoué est utile et doit être conservé tel quel. Il conduit à corriger le moteur ou à conserver la classe hors support ; jamais à relâcher silencieusement les budgets cryptographiques.

## Autres manières d'aider sans prêter ni louer une machine

- exécuter soi-même la campagne sur son Mac et soumettre uniquement les preuves publiques ;
- proposer un runner GitLab auto-hébergé et éphémère sur un Mac physique d'association, d'école, de fablab ou d'entreprise européenne ;
- faire exécuter la campagne, sous observation, par un laboratoire ou atelier disposant déjà du modèle ;
- fournir des diagnostics VM 8/16 Gio afin de détecter les régressions avant la campagne physique ;
- contribuer à un futur paquet de qualification autonome signé, afin que les volontaires n'aient plus à préparer manuellement Rust, Node et Playwright.

Les runners macOS hébergés génériques, fermes de navigateurs, conteneurs, limitations `ulimit`, throttling et VMs restent utiles au diagnostic mais ne prouvent pas le comportement d'une machine physique 8 Gio. Un prestataire distant ne peut compter comme preuve physique que s'il garantit un Mac bare metal dédié, identifiable par sa classe sans publier de numéro de série ; un opérateur et une localisation UE sont préférés. Aucun hyperscaler US ni aucune donnée utilisateur ne sont nécessaires.

# npm-dependency-manager

[English](README.md)

npm-dependency-manager は、VS Code の中で npm dependencies を確認するための拡張機能です。ワークスペース内の `package.json` を見つけ、選択した `package.json` のパッケージ一覧をサイドバーに表示し、エディタ側のダッシュボードで更新候補、package-lock 情報、README、ダウンロード数、セキュリティ関連の情報を確認できます。

![npm-dependency-manager demo](https://raw.githubusercontent.com/noritaka1166/vscode-npm-dependency-manager/main/media/demo.gif)

## 機能

- ワークスペース内の `package.json` を検出し、デフォルトではワークスペース直下の `package.json` を優先します。
- `packageManager` フィールドを優先し、なければ `package-lock.json`、`pnpm-lock.yaml`、`yarn.lock`、`bun.lock` / `bun.lockb` から npm / pnpm / Yarn / Bun を自動判定します。
- 更新アクションとパッケージ詳細のインストールコマンドは、検出したパッケージマネージャーに合わせて切り替わります。
- 選択中の `package.json` に含まれるパッケージだけをサイドバーに表示します。
- サイドバーでパッケージを展開し、npm registry metadata から transitive dependencies を確認できます。
- パッケージ名や説明文を、metadata の再取得なしで検索できます。
- `dependencies`、`devDependencies`、脆弱性あり、deprecated、audit 未確認、問題なし、更新候補でフィルタできます。
- 検索語とフィルタ条件をワークスペースごとに保存します。
- dependency list に license を表示し、検出された license でフィルタできます。
- package.json の指定バージョン、package-lock の resolved version、最新バージョン、公開日を比較できます。
- dependency table のカラム表示/非表示とカラム幅を調整でき、設定は保持されます。
- major / minor / patch の更新候補を見やすく表示します。
- 一覧または詳細画面から、確認ダイアログ付きで更新アクションを実行できます。
- `package-lock.json` から resolved version、lock path、dependency tree context を読み取ります。
- resolved version がある場合、npm audit bulk advisories を使って直接・推移的な脆弱性シグナルを確認します。
- OSV vulnerability results と、CVE に紐づく EPSS / CISA KEV signal も表示します。
- npm registry metadata から deprecated package message を表示します。
- パッケージ詳細画面で npm metadata、weekly downloads、リンク、セキュリティ情報、lockfile context、dependencies、レンダリング済み README を確認できます。
- npm registry に有用な README が公開されていない場合、GitHub repository の一般的な HTTPS / SSH / ホスト名省略形式の URL にも対応して README への fallback を試みます。
- README 内の外部リンクは VS Code 経由で開きます。
- registry、audit、README、dependency、download data のキャッシュと明示的な refresh action を備えています。

## 必要条件

この拡張機能は、以下の公開 npm API から package metadata を取得します。

- `https://registry.npmjs.org`
- `https://api.npmjs.org`
- `https://api.osv.dev`
- `https://api.first.org`
- `https://www.cisa.gov`

npm registry が README filename や placeholder text しか公開していない場合、`https://raw.githubusercontent.com` などの repository URL から README fallback を読み込むことがあります。

脆弱性や dependency tree の結果は、選択中の `package.json` の隣に `package-lock.json` がある場合により正確になります。

## 使い方

1. VS Code で Node.js workspace を開きます。
2. activity bar から `npm Packages` view を選択します。
3. ワークスペースに複数の `package.json` がある場合は、ダッシュボードの dropdown から対象を選択します。
4. 固定表示される検索欄とフィルタで package list を絞り込みます。
5. パッケージを選択すると詳細画面が開きます。
6. 必要に応じて表示カラムやカラム幅を調整します。
7. サイドバーでパッケージを展開すると transitive dependencies を確認できます。

## コマンド

- `npm Packages: Show Dashboard`
- `npm Packages: Refresh`
- `npm Packages: Open Package`

## 既知の制限

- npm audit / OSV checks には resolved package version が必要です。`Vulnerabilities not checked` と表示される場合は、`package-lock.json` を追加または更新してください。
- lockfile の個別パッケージ解析、resolved version、dependency tree context は現在 `package-lock.json` に対応しています。pnpm / Yarn / Bun の lockfile は検出と更新コマンドの切り替えに対応しています。
- transitive vulnerability の関連付けは、`package-lock.json` に記録されている dependency graph に依存します。
- EPSS / KEV signals は、advisory に CVE identifier が含まれている場合のみ表示されます。
- README rendering は一般的な npm / GitHub Markdown を想定していますが、特殊な HTML や repository asset layout は npmjs.com と完全に同じ表示にならない場合があります。

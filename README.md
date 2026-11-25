# BBプラグインの開発方針

BBプラグインはBB本体から独立したこのGitリポジトリで管理する。
`plugins/`の下にプラグインごとのディレクトリを作り、それぞれに`package.json`を置く。

## ローカル開発

普段使っているBBにプラグインをローカルパスでインストールして動作を確かめる。
初回はリポジトリのルートで`mkdir -p plugins`を実行する。

1. `cd plugins`でプラグインをまとめるディレクトリに移動する。
2. `bb plugin new notes`で`notes`のひな形を作る。
3. `cd bb-plugin-notes`で生成されたディレクトリに移動する。
4. `bb plugin install .`でこのディレクトリからインストールする。
5. `bb plugin dev`でファイルの監視を開始する。変更を保存するとBBがプラグインをリロードする。

UIが不要なプラグインでは、`package.json`の`bb.app`とひな形のUI用ファイルを外せる。

## BB本体のfork

作りたい機能に必要な拡張点がPlugin SDKにあるか確認する。
BB本体に拡張点を追加する必要があるときは、本体のforkを別のディレクトリにチェックアウトして試す。その場合もプラグインのコードはこのリポジトリで管理する。 [BB Plugin Guide](https://getbb.app/plugin-guide)

## Git経由の配布

複数のプラグインをGit経由で配布するときは、リポジトリのルートに`.bb/plugins.json`を追加する。
利用者は`--plugin notes`のように名前を指定してインストールできる。

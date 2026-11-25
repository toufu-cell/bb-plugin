# Archive Section

A BB plugin that adds an Archive row just above the sidebar toolbar.
Click the row to list archived threads above it, and click a title to open the thread.
The list shows only parent threads each time you open Archive. Use `Show child threads` to include child threads or `Hide child threads` to hide them again.
The active thread list, the toolbar, and thread archive states stay unchanged.

## Compatibility

The plugin targets BB 0.50.1 and Plugin SDK 0.6.157 only.
It places its row with a DOM anchor that was verified against that release.
If a later BB changes the sidebar, the row stays hidden instead of appearing in the wrong place.
Update the anchor and the `engines` pins together after checking a new release.

## Local development

```sh
npm install --include=dev
bb plugin types
npx tsc -p .
bb plugin build
bb plugin install .
```

`dist/` and `node_modules/` are generated and ignored.
